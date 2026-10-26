// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — BMC / React Health / 3B Medical SD cards → plain therapy sessions.
 *
 * Copyright (C) 2019-2026 The OSCAR Team
 * Copyright (C) 2011-2018 Mark Watkins
 * Copyright (C) 2026 Nocta
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License, version 3, as published
 * by the Free Software Foundation. It is distributed in the hope that it will
 * be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See LICENSE.
 *
 * Adapted from OSCAR's BMC loaders (oscar/SleepLib/loader_plugins/
 * bmcg3x_loader.cpp/.h, bmcG3xDataParsing.cpp/.h, bmc_loader.cpp/.h,
 * bmcDataParsing.cpp/.h; commit 4438aecb259e63b53219a861062b7878bfe77cfc).
 * Changes: plain JavaScript on ArrayBuffers; one plain session result; the
 * places where OSCAR fills a gap with an assumption are skipped (listed below).
 * Nothing on these cards is encrypted or scrambled.
 *
 * Two card layouts, both a set of files sharing one base name (the serial):
 *
 * G3 / G3X / Luna G3 / React Health Luna G3 / E5 ("G3X" in OSCAR):
 *   <base>.idx   starts "BMC G/E/P INDEX". Serial at 0x30, part code at 0x48,
 *                product name at 0x100 ("G3 A20"), build string at 0x345;
 *                then one 0x800-byte record per day from 0x800: date, byte
 *                ranges into the waveform ring and the event log, and the
 *                night's therapy settings ("TS" block at +0x280).
 *   <base>.evt   32-byte records (AE AA): respiratory events with their
 *                durations, flow limitation, periodic breathing, pressure
 *                every 30 s, session start / stop marks.
 *   <base>.000…  the waveform ring (63 × 64 MiB, overwritten oldest first):
 *                one 2048-byte packet (AD AA) per second. Some firmware
 *                writes none; those nights come from the .evt alone.
 *   <base>.log   only for the user-facing firmware version.
 * Legacy RESmart G2 / GII / Luna / Luna II ("BMC" in OSCAR):
 *   <base>.USR   serial at 0x2D, model at 0x2296; one record per day from
 *                0x102340 (date, minutes used, apneas / hypopneas to the
 *                minute), today's record at 0x431.
 *   <base>.idx   512-byte records from 0x800: that day's settings at 0x140.
 *   <base>.000…  the waveform ring: one 256-byte packet per second.
 *
 * Output (SESSIONS.md):
 *   clock         'device-local': every time on the card is the machine's own
 *                 wall clock with no zone, kept as seconds read as if UTC.
 *   sessions      one per stretch the machine ran (a gap of 5 s or more in
 *                 the per-second data starts a new one). A night with no
 *                 per-second data left (G3X): its .evt start / stop marks.
 *   maskOn        G3X: from the first 10 s of sustained breathing flow to the
 *                 last breath, when 5 minutes or more of no flow follow it
 *                 (OSCAR's rules; OSCAR's other start rule, skipping the
 *                 pressure ramp, isn't used: a ramp is mask-on time).
 *                 Legacy and .evt-only nights: the whole session (as OSCAR).
 *   events        G3X: obstructive / central / unclassified apnea ('apnea'),
 *                 hypopnea (unclassified, obstructive and central all
 *                 'hypopnea'), rera, periodic-breathing, flow-limitation (one
 *                 breath each). Legacy: obstructive, central, hypopnea, at
 *                 one-minute resolution. `at` is the event's start; apnea and
 *                 hypopnea durations held to 10–180 s as OSCAR does.
 *   readings      one a minute (on the clock's minute), the mean of the
 *                 per-second values: pressure (or epap + ipap in bilevel
 *                 modes), respRate, spo2 + pulse (oximeter fitted), and
 *                 G3X: leak — firmware G3-2.11 (build SC.72) writes leak
 *                   beyond the vent (→ `leak`, raw × 0.16 L/min); G3-2.12+
 *                   writes a field whose ~16 L/min floor OSCAR reads as
 *                   vent flow included (→ `totalLeak`); other firmware is
 *                   told apart by sampling, as OSCAR does; E5 firmware
 *                   scaled × 0.10 (OSCAR: medium confidence, one card).
 *                 Legacy: leak (OSCAR's unintentional-leak channel → `leak`),
 *                   tidalVolume (mL), minuteVent (L/min).
 *   pressureChanges  G3X: the .evt's 30-second pressure records, kept where
 *                 the pressure changed.
 *   settings      G3X: that night's TS block (mode CPAP / AutoCPAP / S /
 *                 AutoS; AutoS gives min EPAP as `epap`, max IPAP as `ipap`),
 *                 ramp, Reslex as flexLevel. Legacy: the index's settings
 *                 record OSCAR picks (the first dated after the night).
 *   deviceCounts  null: the G3X index holds per-day totals (not per session)
 *                 that OSCAR only prints for debugging; legacy has none.
 *
 * Not read, or skipped with a warning (OSCAR fills these in by assumption,
 * or marks them unknown): tidal volume and minute ventilation on G3X (scale
 * not known), Ti / Te / I:E, the flow and pressure waveforms themselves,
 * flow-limitation grade, the .set file (today's settings, which OSCAR applies
 * to past nights without their own), nights with no start / stop record
 * (OSCAR invents a noon start), legacy nights whose per-second data has been
 * overwritten (OSCAR places them from their events), and OSCAR's stretching
 * of a legacy night's last session to the minutes the machine logged.
 *
 * readBmc(files, { onProgress }) → { device, clock, sessions, filesRead, warnings }
 * files: [{ path, read: () => Promise<ArrayBuffer> }]. Throws ReaderError
 * 'not-this-machine' when there's no BMC card in them. */
import { ReaderError } from './errors.js';

export { ReaderError };

/* ---------- bytes and times ---------- */

const u16 = (b, o) => (o >= 0 && o + 2 <= b.length ? b[o] | (b[o + 1] << 8) : 0);
const i16 = (b, o) => {
  const v = u16(b, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (b, o) => (o >= 0 && o + 4 <= b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000 : 0);
/* ASCII up to the first NUL or 0xFF (erased flash) */
function ascii(b, o, n) {
  let s = '';
  for (let i = o; i < o + n && i < b.length && b[i] !== 0 && b[i] !== 0xff; i++) s += String.fromCharCode(b[i]);
  return s.trim();
}
const validDate = (y, m, d) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
/* a wall-clock time → seconds read as if UTC, or null if it isn't a real time */
const stamp = (y, mo, d, h, mi, s) =>
  validDate(y, mo, d) && h < 24 && mi < 60 && s < 60 ? Date.UTC(y, mo - 1, d, h, mi, s) / 1000 : null;
const isoDay = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);
const round = (v, n = 2) => Math.round(v * 10 ** n) / 10 ** n;
const pad3 = (i) => String(i).padStart(3, '0');
const tick = () => new Promise((r) => setTimeout(r, 0));
const DAY = 86400;
const GAP = 5; // seconds without data that end a session (OSCAR)
const BACKWARD = 7200; // a bigger step back in time is older data, not a clock change (OSCAR)

/* per-second values → one mean a minute, on the clock's minute */
class Minutes {
  constructor() {
    this.m = new Map();
  }
  add(t, key, v) {
    const k = Math.floor(t / 60);
    let b = this.m.get(k);
    if (!b) this.m.set(k, (b = {}));
    const s = (b[key] ??= [0, 0]);
    s[0] += v;
    s[1]++;
  }
  readings(start, end, pick) {
    const out = [];
    for (const k of [...this.m.keys()].sort((a, b) => a - b)) {
      const from = Math.max(k * 60, start);
      const to = Math.min(k * 60 + 60, end);
      if (to <= from) continue;
      const mean = {};
      for (const [key, [sum, n]] of Object.entries(this.m.get(k))) mean[key] = sum / n;
      const values = pick(mean);
      if (Object.keys(values).length) out.push({ at: round(to - start, 3), span: round(to - from, 3), ...values });
    }
    return out;
  }
}

const isBilevel = (settings) => settings.mode === 'bilevel' || settings.mode === 'auto-bilevel';
/* OSCAR's pressure channel is IPAP; in CPAP modes IPAP = EPAP */
const pressureValues = (settings, m) => {
  if (isBilevel(settings)) {
    const r = {};
    if (m.epap != null) r.epap = round(m.epap);
    if (m.ipap != null) r.ipap = round(m.ipap);
    return r;
  }
  return m.ipap != null ? { pressure: round(m.ipap) } : {};
};

/* ---------- finding the card ---------- */

const NAME = /^(.*)\.([^./]+)$/;
function findCards(paths) {
  const bases = new Map();
  for (const p of paths) {
    const m = NAME.exec(p);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!bases.has(key)) bases.set(key, new Map());
    bases.get(key).set(m[2].toLowerCase(), p);
  }
  const cards = [];
  for (const [key, exts] of bases) {
    if (exts.has('usr') && exts.has('idx') && exts.has('000')) cards.push({ kind: 'legacy', key, exts });
    else if (exts.has('idx') && (exts.has('evt') || exts.has('000'))) cards.push({ kind: 'g3x', key, exts });
  }
  return cards;
}

/* a BMC card: <base>.idx with <base>.evt or <base>.000 (G3X), or <base>.USR +
 * .idx + .000 (legacy). readBmc also checks the G3X index's signature. */
export const isBmc = (paths) => findCards(paths.map((p) => p.replace(/\\/g, '/'))).length > 0;

const G3X_SIGNATURE = 'BMC G/E/P INDEX';

export async function readBmc(files, { onProgress } = {}) {
  const warnings = [];
  const byPath = new Map(files.map((f) => [f.path.replace(/\\/g, '/'), f]));
  const usable = [];
  for (const card of findCards([...byPath.keys()])) {
    card.file = (ext) => byPath.get(card.exts.get(ext));
    if (card.kind === 'g3x') {
      try {
        card.idx = new Uint8Array(await card.file('idx').read());
      } catch {
        continue;
      }
      if (ascii(card.idx, 0, G3X_SIGNATURE.length) !== G3X_SIGNATURE) continue;
    }
    usable.push(card);
  }
  if (!usable.length) throw new ReaderError('not-this-machine', 'No BMC card found.');
  usable.sort((a, b) => b.exts.size - a.exts.size);
  if (usable.length > 1) warnings.push(`The card holds ${usable.length} machines; read the one with the most files.`);
  const card = usable[0];
  return card.kind === 'g3x' ? readG3x(card, warnings, onProgress) : readLegacy(card, warnings, onProgress);
}

/* ======================= G3 / G3X / E5 ======================= */

const SPAN = 64 * 1024 * 1024; // each waveform file
const PACKET = 0x800;
const EVT = 0x20;
const ok = (h) => h >= 400 && h <= 3500; // a plausible pressure, hundredths of cmH2O (OSCAR)

/* OSCAR tested these; anything else imports, with a note */
const KNOWN_FIRMWARE = /^(G3-2\.11\.|G3-2\.12\.|E5-1\.02\.|E5-1\.SC\.00\.)|SC\.7[2456]/;
const KNOWN_MODELS = ['G3 A20', 'G3 B20A', 'E5 B25A Plus'];

/* the night's TS block (OSCAR's DecodeTsBlock); null when it isn't one OSCAR's map covers */
function g3xSettings(ts) {
  if (!ts) return null;
  const p = (o) => u16(ts, o);
  const fine = (h) => h >= 300 && h <= 3500;
  const mode = ts[0x08];
  const s = {};
  if (mode === 0) {
    if (!fine(p(0x0a))) return null;
    Object.assign(s, { mode: 'cpap', pressure: p(0x0a) / 100 });
  } else if (mode === 1) {
    if (!fine(p(0x0e)) || !fine(p(0x10)) || p(0x10) < p(0x0e)) return null;
    Object.assign(s, { mode: 'auto-cpap', pressureMin: p(0x0e) / 100, pressureMax: p(0x10) / 100 });
  } else if (mode === 2) {
    if (!fine(p(0x0a)) || !fine(p(0x12)) || p(0x12) < p(0x0a)) return null;
    Object.assign(s, { mode: 'bilevel', epap: p(0x0a) / 100, ipap: p(0x12) / 100 });
  } else if (mode === 6) {
    if (!fine(p(0x0e)) || !fine(p(0x16)) || p(0x16) < p(0x0e)) return null;
    Object.assign(s, { mode: 'auto-bilevel', epap: p(0x0e) / 100, ipap: p(0x16) / 100 }); // min EPAP, max IPAP
  } else return null; // S/T, T, titration: not in OSCAR's confirmed map
  if (!(ts[0x8a] & 0x01)) s.rampMinutes = ts[0x82]; // bit 0: ramp "Auto", no number
  s.flexLevel = ts[0x86]; // Reslex
  return s;
}

const RESP = { 0x01: 'hypopnea', 0x02: 'apnea', 0x03: 'obstructive', 0x04: 'central', 0x07: 'hypopnea', 0x08: 'hypopnea', 0x0a: 'rera' };

/* one day's slice of the .evt */
function evtDay(evt, day) {
  const out = { events: [], pressures: [], starts: [], ends: [] };
  if (!evt) return out;
  const from = Math.min(day.evtStart, evt.length);
  const to = Math.min(day.evtEnd, evt.length);
  // the index's start isn't always on a record boundary (OSCAR): round down, the magic check skips the fragment
  for (let o = Math.floor(from / EVT) * EVT; o + EVT <= to; o += EVT) {
    if (evt[o] !== 0xae || evt[o + 1] !== 0xaa) continue;
    const sec = stamp(1900 + evt[o + 0x14], evt[o + 0x15], evt[o + 0x16], evt[o + 0x17], evt[o + 0x18], evt[o + 0x19]);
    if (sec == null) continue;
    const ms = u16(evt, o + 0x1a);
    const t = ms <= 999 ? sec + ms / 1000 : sec;
    const type = evt[o + 0x10];
    const v2 = u16(evt, o + 0x1c);
    const v3 = u16(evt, o + 0x1e);
    if (type in RESP) {
      const duration = Math.min(180, Math.max(10, Math.round(v2 / 1000)));
      out.events.push({ t, type: RESP[type], duration });
    } else if (type === 0x09) {
      out.events.push({ t, type: 'periodic-breathing', duration: Math.round((v2 + v3 * 0x10000) / 1000) });
    } else if (type >= 0x0e && type <= 0x10) {
      out.events.push({ t, type: 'flow-limitation', duration: round(v2 / 1000, 3) });
    } else if (type === 0x42 && ok(v2)) {
      out.pressures.push({ t: sec, epap: v2, ipap: ok(v3) ? v3 : v2 });
    } else if (type === 0x40) out.starts.push(t);
    else if (type === 0x41) out.ends.push(t);
    // 0x0C / 0x0D (each breath) and the rest aren't read
  }
  out.events.sort((a, b) => a.t - b.t);
  out.pressures.sort((a, b) => a.t - b.t);
  out.starts.sort((a, b) => a - b);
  out.ends.sort((a, b) => a - b);
  return out;
}

/* breathing in this packet: any of OSCAR's 50 samples of the flow region beyond ±25 */
function breathing(b, o) {
  for (let i = 0; i < 50; i++) {
    const v = Math.max(-2000, Math.min(2000, i16(b, o + 0x56e + Math.floor((i * 99) / 49) * 2)));
    if (v > 25 || v < -25) return true;
  }
  return false;
}

/* OSCAR's mask-on rules on one session's packets → [[from, to]] seconds from start */
function g3xMaskOn(run, start, end) {
  let on = 0;
  let streak = 0;
  for (let i = 0; i < run.length; i++) {
    streak = run[i].flow ? streak + 1 : 0;
    if (streak === 10) {
      on = run[i - 9].t - start;
      break;
    }
  }
  let last = -1;
  for (let i = run.length - 1; i >= 0 && last < 0; i--) if (run[i].flow) last = i;
  const off = last >= 0 && run[run.length - 1].t - run[last].t >= 300 ? run[last].t - start : end;
  return off > on ? [[on, off]] : [];
}

async function readG3x(card, warnings, onProgress) {
  const idx = card.idx;
  const read = new Set([card.exts.get('idx')]);
  const device = {
    manufacturer: 'BMC',
    model: ascii(idx, 0x100, 16) || ascii(idx, 0x48, 16) || null,
    modelNumber: ascii(idx, 0x48, 16) || null,
    serial: ascii(idx, 0x30, 16) || null,
    firmware: null,
  };
  const log = card.file('log');
  if (log) {
    try {
      const head = new Uint8Array((await log.read()).slice(0, 65536));
      let text = '';
      for (const c of head) text += String.fromCharCode(c);
      device.firmware = /[A-Za-z][A-Za-z0-9]-[0-9]+(?:\.[0-9]+){2,}/.exec(text)?.[0] ?? null;
    } catch {
      // the version also sits in the index
    }
  }
  device.firmware ||= ascii(idx, 0x345, 20) || null;
  if (device.firmware && !KNOWN_FIRMWARE.test(device.firmware))
    warnings.push(`Firmware ${device.firmware} hasn’t been checked against a reference card; readings may be off.`);
  if (device.model && !KNOWN_MODELS.includes(device.model))
    warnings.push(`The model ${device.model} hasn’t been checked against a reference card; readings may be off.`);

  let ringFiles = 63;
  if (u32(idx, 0xd4) === SPAN && u32(idx, 0xd8) >= 1 && u32(idx, 0xd8) <= 64) ringFiles = u32(idx, 0xd8);
  else warnings.push('The card’s index didn’t give its recording layout; assumed the usual 63 files.');

  // one index record a day
  const days = [];
  for (let off = 0x800; off + 0x34 <= idx.length; off += 0x800) {
    if (u16(idx, off) !== 0xaaaa) continue;
    const y = 1900 + idx[off + 8];
    const m = idx[off + 9];
    const d = idx[off + 10];
    if (!validDate(y, m, d)) continue;
    const waveStart = u32(idx, off + 0x10);
    let waveEnd = u32(idx, off + 0x14);
    const waveLen = u32(idx, off + 0x18);
    if (waveLen > 0 && waveEnd < waveStart) waveEnd += ringFiles * SPAN; // recorded across the ring's end
    const ts = off + 0x280;
    days.push({
      date: Date.UTC(y, m - 1, d) / 1000,
      waveStart,
      waveEnd: waveLen > 0 ? waveEnd : waveStart,
      evtStart: u32(idx, off + 0x1c),
      evtEnd: u32(idx, off + 0x20),
      ts: ts + 0x100 <= idx.length && idx[ts] === 0x54 && idx[ts + 1] === 0x53 ? idx.subarray(ts, ts + 0x100) : null,
    });
  }
  days.sort((a, b) => a.date - b.date);

  let evt = null;
  if (card.exts.has('evt')) {
    try {
      evt = new Uint8Array(await card.file('evt').read());
      read.add(card.exts.get('evt'));
    } catch {
      warnings.push('The event log (.evt) couldn’t be read: events and pressure records are missing.');
    }
  }

  // the bytes [from, to) of a waveform file: only those, when the caller's
  // files can read a range (`readRange(from, to)`; each file is 64 MiB), else
  // the whole file, two kept at a time (a night rarely spans more)
  const cache = new Map();
  const missing = new Set();
  const waveFile = async (i) => {
    if (cache.has(i)) return cache.get(i);
    let bytes = null;
    const f = card.file(pad3(i));
    if (f) {
      try {
        bytes = new Uint8Array(await f.read());
        read.add(card.exts.get(pad3(i)));
      } catch {
        bytes = null;
      }
    }
    if (!bytes) missing.add(i);
    cache.set(i, bytes);
    if (cache.size > 2) cache.delete(cache.keys().next().value);
    return bytes;
  };
  const waveBytes = async (i, from, to) => {
    const f = card.file(pad3(i));
    if (f?.readRange) {
      try {
        const bytes = new Uint8Array(await f.readRange(from, to));
        read.add(card.exts.get(pad3(i)));
        return bytes;
      } catch {
        missing.add(i);
        return null;
      }
    }
    const whole = await waveFile(i);
    return whole && whole.subarray(Math.min(from, whole.length), Math.min(to, whole.length));
  };

  // which leak field: by firmware where OSCAR knows it, else by sampling (below)
  const fw = device.firmware ?? '';
  let leakAt = /G3-2\.11\.|\.SC\.72/.test(fw) ? 0x52a : fw.startsWith('G3-2.') ? 0x568 : null;
  const leakScale = /^E5/i.test(fw) ? 0.1 : 0.16;
  const leakOf = (raw) => Math.min(5000, Math.round(raw * leakScale * 10)) / 10;
  const probe = { days: 0, total: 0, nonZero: 0 };

  const sessions = [];
  let unplaced = 0;
  let noTimes = 0;
  let noSettings = 0;
  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    const settings = g3xSettings(day.ts);
    if (!settings) noSettings++;
    const ev = evtDay(evt, day);

    // the day's packets, oldest first
    const packets = [];
    let last = -Infinity;
    let probed = 0;
    let fileMissing = false;
    const probing = leakAt == null && probe.days < 5;
    for (let fi = Math.floor(day.waveStart / SPAN); fi * SPAN < day.waveEnd; fi++) {
      // this file's part of the day, from a packet boundary
      const from = Math.floor(Math.max(day.waveStart - fi * SPAN, 0) / PACKET) * PACKET;
      const b = await waveBytes(fi % ringFiles, from, Math.min(day.waveEnd - fi * SPAN, SPAN));
      if (!b) {
        fileMissing = true;
        continue;
      }
      for (let o = 0; o + PACKET <= b.length; o += PACKET) {
        if (b[o] !== 0xad || b[o + 1] !== 0xaa) continue;
        if (probing && probed < 2000) {
          probed++;
          probe.total++;
          if (u16(b, o + 0x52a) > 0) probe.nonZero++;
        }
        const t = stamp(1900 + b[o + 4], b[o + 5], b[o + 6], b[o + 7], b[o + 8], b[o + 9]);
        // outside the record's day: overwritten by a later night
        if (t == null || t < day.date || t >= day.date + 2 * DAY) continue;
        if (t === last || t < last - BACKWARD) continue;
        last = t;
        packets.push({
          t,
          flow: breathing(b, o),
          la: u16(b, o + 0x52a),
          lb: u16(b, o + 0x568),
          rr: u16(b, o + 0x530),
          spo2: b[o + 0x8a],
          pulse: b[o + 0x8c],
          epap: u16(b, o + 0x76c),
          ipap: u16(b, o + 0x76e),
        });
      }
    }
    if (probed) probe.days++;

    const daySessions = [];
    if (packets.length) {
      let run = [packets[0]];
      const runs = [run];
      for (let i = 1; i < packets.length; i++) {
        if (packets[i].t - packets[i - 1].t >= GAP) runs.push((run = []));
        run.push(packets[i]);
      }
      for (const r of runs) {
        const start = r[0].t;
        const end = r[r.length - 1].t + 1 - start;
        const minutes = new Minutes();
        const has = { la: false, lb: false };
        for (const p of r) {
          if (p.epap > 0) {
            minutes.add(p.t, 'epap', p.epap / 100);
            if (p.ipap > 0) minutes.add(p.t, 'ipap', p.ipap / 100);
          }
          minutes.add(p.t, 'la', leakOf(p.la));
          minutes.add(p.t, 'lb', leakOf(p.lb));
          has.la ||= p.la > 0;
          has.lb ||= p.lb > 0;
          if (p.rr > 0) minutes.add(p.t, 'respRate', p.rr);
          if (p.spo2 > 0) minutes.add(p.t, 'spo2', p.spo2);
          if (p.pulse > 0) minutes.add(p.t, 'pulse', p.pulse);
        }
        daySessions.push({ start, end, maskOn: g3xMaskOn(r, start, end), minutes, has, settings: { ...settings } });
      }
    } else {
      if (day.waveEnd > day.waveStart && !fileMissing)
        warnings.push(`${isoDay(day.date)}: its per-second data was unreadable or overwritten; read from the event log alone.`);
      // the .evt's start / stop marks: each start runs to the first stop before the next start
      ev.starts.forEach((s, i) => {
        const next = ev.starts[i + 1] ?? Infinity;
        const stop = ev.ends.find((e) => e > s && e < next);
        if (stop == null) return void noTimes++;
        const start = Math.floor(s);
        daySessions.push({ start, end: round(stop - start, 3), maskOn: [[0, round(stop - start, 3)]], minutes: null, settings: { ...settings } });
      });
      if (!ev.starts.length && ev.events.length) noTimes++;
    }

    let placed = 0;
    for (const s of daySessions) {
      const until = s.start + s.end + 0.999; // events carry milliseconds, sessions whole seconds
      const events = ev.events
        .filter((e) => e.t >= s.start && e.t <= until)
        .map((e) => ({ type: e.type, at: round(e.t - s.start, 3), duration: e.duration, countedByDevice: true }));
      placed += events.length;
      const pressureChanges = [];
      let prev = null;
      for (const p of ev.pressures) {
        if (p.t < s.start || p.t > s.start + s.end) continue;
        if (prev && prev.epap === p.epap && prev.ipap === p.ipap) continue;
        prev = p;
        const at = p.t - s.start;
        pressureChanges.push(p.epap === p.ipap ? { at, pressure: p.epap / 100 } : { at, epap: p.epap / 100, ipap: p.ipap / 100 });
      }
      sessions.push({
        id: s.start,
        start: s.start,
        end: s.end,
        maskOn: s.maskOn,
        settings: s.settings,
        deviceCounts: null,
        events,
        readings: [],
        pressureChanges,
        _minutes: s.minutes,
        _has: s.has,
      });
    }
    if (daySessions.length) unplaced += ev.events.length - placed;
    onProgress?.({ done: di + 1, total: days.length });
    await tick();
  }

  // the leak field, once for the machine (OSCAR: under 10% non-zero at 0x52A → it's unused)
  leakAt ??= probe.total > 0 && probe.nonZero < Math.floor(probe.total / 10) ? 0x568 : 0x52a;
  const leakKey = leakAt === 0x52a ? 'leak' : 'totalLeak';
  const field = leakAt === 0x52a ? 'la' : 'lb';
  for (const s of sessions) {
    if (s._minutes) {
      s.readings = s._minutes.readings(s.start, s.start + s.end, (m) => {
        const r = pressureValues(s.settings, m);
        if (s._has[field] && m[field] != null) r[leakKey] = round(m[field]);
        if (m.respRate != null) r.respRate = round(m.respRate);
        if (m.spo2 != null) r.spo2 = round(m.spo2);
        if (m.pulse != null) r.pulse = round(m.pulse);
        return r;
      });
    }
    delete s._minutes;
    delete s._has;
  }

  if (missing.size)
    warnings.push(`${missing.size} recording file${missing.size > 1 ? 's' : ''} the card’s index points to weren’t there or couldn’t be read; those nights were read from the event log alone.`);
  if (noTimes) warnings.push(`${noTimes} stretch${noTimes > 1 ? 'es' : ''} in the event log had no recorded start and stop, so ${noTimes > 1 ? 'they' : 'it'} weren’t read.`);
  if (noSettings) warnings.push(`Settings for ${noSettings} night${noSettings > 1 ? 's' : ''} weren’t in a form this reader knows, so they’re left out.`);
  if (unplaced > 0) warnings.push(`${unplaced} event${unplaced > 1 ? 's' : ''} fell outside any recorded session and weren’t placed.`);

  sessions.sort((a, b) => a.start - b.start);
  return { device, clock: 'device-local', sessions, filesRead: read.size, warnings };
}

/* ======================= legacy RESmart / Luna ======================= */

const USR_SESSIONS = 0x102340;
const LEGACY_PACKET = 0x100;

/* the USR's packed date → noon of that day (OSCAR's day runs noon to noon) */
function legacyNoon(v) {
  const y = (v >> 9) + 2000;
  const m = (v >> 5) & 0x0f;
  const d = v & 0x1f;
  return validDate(y, m, d) ? Date.UTC(y, m - 1, d, 12) / 1000 : null;
}

const LEGACY_EVENT = { 0x83: 'obstructive', 0x84: 'hypopnea', 0x87: 'central' };

/* one historic USR record → { noon, events, cut } */
function usrRecord(rec) {
  const noon = legacyNoon(u16(rec, 7));
  const events = [];
  let p = 0x45;
  for (;;) {
    if (p + 5 > rec.length) return { noon, events, cut: true };
    const b = rec[p];
    p += 5;
    if (b === 0xff) break;
  }
  while (p + 5 <= rec.length) {
    const type = rec[p];
    const count = u16(rec, p + 1);
    p += 5;
    const size = type === 0x82 || type === 0x86 ? 4 : type in LEGACY_EVENT ? 3 : 2;
    if (p + count * size > rec.length) return { noon, events, cut: true };
    if (type in LEGACY_EVENT)
      for (let i = 0; i < count; i++) {
        const q = p + i * 3;
        events.push({ t: noon + rec[q] * 3600 + rec[q + 1] * 60, type: LEGACY_EVENT[type], duration: rec[q + 2] });
      }
    p += count * size;
  }
  return { noon, events, cut: false };
}

function usrDays(usr) {
  const days = [];
  let cut = 0;
  const nextOf = (pos) => {
    if (pos + 5 > usr.length) return 0;
    const n = u32(usr, pos + 1);
    return n <= pos || n > usr.length ? 0 : n;
  };
  const isHeader = (pos) => pos + 9 <= usr.length && usr[pos] === 0xe1 && legacyNoon(u16(usr, pos + 7)) != null;
  const findHeader = (from) => {
    for (let pos = from; pos < usr.length; pos++) if (isHeader(pos) && nextOf(pos)) return pos;
    return usr.length;
  };
  // each record points to the next; a fragment without a header is stepped over (OSCAR)
  let here = USR_SESSIONS;
  while (here < usr.length) {
    if (!isHeader(here)) {
      here = findHeader(here + 1);
      continue;
    }
    const next = nextOf(here) || findHeader(here + 1);
    const r = usrRecord(usr.subarray(here, next));
    if (r.cut) cut++;
    days.push(r);
    here = next;
  }
  // today's record, still being written
  const today = legacyNoon(u16(usr, 0x431));
  if (today != null) {
    const events = [];
    let p = 0x441;
    while (p < usr.length && usr[p] !== 0xff) {
      const type = usr[p++];
      const len = type === 0x02 ? 3 : usr[p++];
      if (p + len > usr.length) {
        cut++;
        break;
      }
      const kind = { 0x07: 'central', 0x08: 'obstructive', 0x09: 'hypopnea' }[type];
      if (kind && len >= 3) events.push({ t: today + usr[p] * 3600 + usr[p + 1] * 60, type: kind, duration: usr[p + 2] });
      p += len;
    }
    days.push({ noon: today, events, cut: false });
  }
  return { days, cut };
}

/* the settings records in the .idx: [{ date, settings }] */
function legacySettings(idx) {
  const list = [];
  for (let off = 0x800; off + 0x200 <= idx.length; off += 0x200) {
    if (u16(idx, off) !== 0xaaaa || u16(idx, off + 0x0f) > 999) break; // OSCAR stops at the first bad record
    const y = idx[off + 4] + 2000;
    const m = idx[off + 5];
    const d = idx[off + 6];
    if (!validDate(y, m, d)) continue;
    const r = idx.subarray(off, off + 0x200);
    const half = (o) => r[o] / 2;
    const treat = half(0x141);
    const mode = r[0x14d] >> 4;
    const s = {};
    if (mode === 0) Object.assign(s, { mode: 'cpap', pressure: treat });
    else if (mode === 1) Object.assign(s, { mode: 'auto-cpap', pressureMin: treat, pressureMax: half(0x14c) });
    else if (mode === 2) Object.assign(s, { mode: 'bilevel', epap: treat, ipap: treat + (r[0x148] >> 2) / 2 });
    else if (mode === 6) Object.assign(s, { mode: 'auto-bilevel', epap: treat, ipap: half(0x14c) }); // min EPAP, max IPAP
    else if (mode >= 3 && mode <= 5) s.mode = 'other'; // S/T, T, titration: OSCAR reads no pressures for them
    if (r[0x142] !== 0xff) s.rampMinutes = r[0x142]; // 0xFF: ramp "Auto"
    s.flexLevel = r[0x148] & 0x03; // Reslex
    list.push({ date: Date.UTC(y, m - 1, d) / 1000, settings: s });
  }
  return list;
}

async function readLegacy(card, warnings, onProgress) {
  const read = new Set();
  let usr;
  try {
    usr = new Uint8Array(await card.file('usr').read());
    read.add(card.exts.get('usr'));
  } catch {
    warnings.push('The machine’s log (.USR) couldn’t be read, so no nights could be placed.');
    usr = new Uint8Array(0);
  }
  const device = { manufacturer: 'BMC', model: ascii(usr, 0x2296, 32) || null, modelNumber: null, serial: ascii(usr, 0x2d, 32) || null, firmware: null };

  const { days: logged, cut } = usrDays(usr);
  if (cut) warnings.push(`${cut} day${cut > 1 ? 's' : ''} in the machine’s log ${cut > 1 ? 'were' : 'was'} cut short; the events after the break are missing.`);
  const byNoon = new Map();
  for (const d of logged) if (!byNoon.has(d.noon)) byNoon.set(d.noon, d); // OSCAR reads the first record of a date

  let settingsList = [];
  try {
    settingsList = legacySettings(new Uint8Array(await card.file('idx').read()));
    read.add(card.exts.get('idx'));
  } catch {
    warnings.push('The card’s index (.idx) couldn’t be read: settings are missing.');
  }
  // OSCAR takes the first record dated after the night, else the last
  const settingsFor = (noon) => {
    const date = noon - 12 * 3600;
    return (settingsList.find((x) => x.date > date) ?? settingsList[settingsList.length - 1])?.settings ?? {};
  };

  // the waveform ring, file by file, into runs of consecutive seconds within one day
  const waveNames = [];
  for (let i = 0; i <= 999 && card.exts.has(pad3(i)); i++) waveNames.push(pad3(i));
  const runs = [];
  let run = null;
  for (let fi = 0; fi < waveNames.length; fi++) {
    let b;
    try {
      b = new Uint8Array(await card.file(waveNames[fi]).read());
      read.add(card.exts.get(waveNames[fi]));
    } catch {
      warnings.push(`Recording file .${waveNames[fi]} couldn’t be read.`);
      run = null;
      continue;
    }
    // some files start with a 255-byte tail of an older packet (OSCAR)
    const first = b.length > 0x100 && b[0xff] === 0xaa && b[0x100] === 0xaa ? 0xff : 0;
    for (let o = first; o + LEGACY_PACKET <= b.length; o += LEGACY_PACKET) {
      const year = u16(b, o + 0xf8);
      const t = year >= 2000 ? stamp(year, b[o + 0xfa], b[o + 0xfb], b[o + 0xfc], b[o + 0xfd], b[o + 0xfe]) : null;
      if (t == null) continue;
      const noon = Math.floor((t - 12 * 3600) / DAY) * DAY + 12 * 3600;
      if (!byNoon.has(noon)) {
        run = null;
        continue;
      }
      if (!run || run.noon !== noon || t - run.last >= GAP || t < run.last) {
        run = { noon, first: t, last: t, minutes: new Minutes(), hasLeak: false };
        runs.push(run);
      } else if (t === run.last) continue;
      run.last = t;
      const m = run.minutes;
      const epap = i16(b, o + 0x04);
      const ipap = i16(b, o + 0x06);
      if (epap > 0) m.add(t, 'epap', epap / 2);
      if (ipap > 0) m.add(t, 'ipap', ipap / 2);
      const leak = i16(b, o + 0xc4);
      if (leak >= 0) m.add(t, 'leak', leak / 10);
      run.hasLeak ||= leak > 0;
      const tv = i16(b, o + 0xc6);
      if (tv > 0) m.add(t, 'tidalVolume', tv);
      const mv = i16(b, o + 0xca);
      if (mv > 0) m.add(t, 'minuteVent', mv / 10);
      const spo2 = i16(b, o + 0xcc);
      if (spo2 > 0) m.add(t, 'spo2', spo2);
      const pulse = i16(b, o + 0xce);
      if (pulse > 0) m.add(t, 'pulse', pulse);
      const rr = u16(b, o + 0xd0);
      if (rr > 0) m.add(t, 'respRate', rr);
    }
    onProgress?.({ done: fi + 1, total: waveNames.length });
    await tick();
  }

  // runs → sessions: in time order (the ring may have wrapped mid-night), joined across gaps under 5 s
  runs.sort((a, b) => a.first - b.first);
  const merged = [];
  for (const r of runs) {
    const prev = merged[merged.length - 1];
    if (prev && prev.noon === r.noon && r.first - prev.last < GAP) {
      prev.last = Math.max(prev.last, r.last);
      prev.hasLeak ||= r.hasLeak;
      for (const [k, v] of r.minutes.m) {
        const into = prev.minutes.m.get(k);
        if (!into) prev.minutes.m.set(k, v);
        else for (const [key, [sum, n]] of Object.entries(v)) {
          const s = (into[key] ??= [0, 0]);
          s[0] += sum;
          s[1] += n;
        }
      }
    } else merged.push(r);
  }

  const sessions = [];
  const seen = new Set();
  let placed = 0;
  for (const r of merged) {
    seen.add(r.noon);
    const settings = settingsFor(r.noon);
    const start = r.first;
    const end = r.last + 1 - start;
    const events = byNoon
      .get(r.noon)
      .events.filter((e) => e.t >= start && e.t <= start + end)
      .map((e) => ({ type: e.type, at: e.t - start, duration: e.duration, countedByDevice: true }));
    placed += events.length;
    const readings = r.minutes.readings(start, start + end, (m) => {
      const v = pressureValues(settings, m);
      if (r.hasLeak && m.leak != null) v.leak = round(m.leak);
      for (const key of ['tidalVolume', 'minuteVent', 'respRate', 'spo2', 'pulse']) if (m[key] != null) v[key] = round(m[key]);
      return v;
    });
    sessions.push({ id: start, start, end, maskOn: [[0, end]], settings, deviceCounts: null, events, readings, pressureChanges: [] });
  }

  const lost = [...byNoon.keys()].filter((n) => !seen.has(n)).length;
  if (lost) warnings.push(`${lost} night${lost > 1 ? 's' : ''} in the machine’s log ${lost > 1 ? 'have' : 'has'} no per-second data left on the card (the machine overwrites its oldest), so ${lost > 1 ? 'they' : 'it'} weren’t read.`);
  const outside = [...byNoon.values()].filter((d) => seen.has(d.noon)).reduce((n, d) => n + d.events.length, 0) - placed;
  if (outside > 0) warnings.push(`${outside} event${outside > 1 ? 's' : ''} fell outside any recorded session and weren’t placed.`);

  sessions.sort((a, b) => a.start - b.start);
  return { device, clock: 'device-local', sessions, filesRead: read.size, warnings };
}
