// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — Fisher & Paykel SleepStyle cards → plain therapy sessions.
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
 * Adapted from OSCAR's sleepstyle_loader.cpp/.h and sleepstyle_EDFinfo.cpp/.h
 * (https://gitlab.com/CrimsonNape/oscar-sql, commit
 * 4438aecb259e63b53219a861062b7878bfe77cfc). Changes: plain JavaScript; a
 * plain session result; damaged files are skipped with a warning; the
 * real-time leak is averaged into two-minute readings.
 *
 * Machines: SleepStyle CPAP and SleepStyle Auto (an SD card or the InfoUSB
 * stick, same layout). The older ICON uses the same folders but isn't read.
 *
 * The card: FPHCARE/ICON/<serial>/ holds
 *   SUM*.FPH   summary: a 512-byte text header ("… <serial> SLEEPSTYLE <type> …",
 *              ending ';' at 0x1FF), then 40-byte little-endian records, one per
 *              session, until 0xFFFFFFFF or a word ending FA FE. Per record:
 *              start (packed date, below), use time in tenths of an hour, the
 *              set CPAP / minimum / maximum pressures (tenths of cmH2O), the
 *              pressures seen, ramp, humidity, SensAwake and EPR level.
 *   DET*.FPH   detail: the same header, a 2 KB index of 9-byte entries (start,
 *              first record, record count, unknown), then 21-byte records of
 *              three 7-byte two-minute blocks: pressure (tenths of cmH2O), a
 *              byte OSCAR doesn't use, and five flag bytes whose low 6 bits mark
 *              the six 20-second slots of the block.
 *   REALTIME/HRD*.EDF  plain EDF: Flow, Pressure (at the mask) and Leak.
 *   HIS*, LOG files    not read (OSCAR doesn't read them either).
 * Nothing on the card needs decrypting to read this.
 *
 * Packed date (32 bits): day [0..4], month [5..8], year-2000 [9..14],
 * second [15..20], minute [21..26], hour [27..31]; OSCAR then takes 54 seconds
 * off (its own "why?" correction), and so does this reader so the summary and
 * detail times line up with OSCAR's.
 *
 * What's read, following OSCAR:
 *   settings   mode is OSCAR's guess from the summary: 'cpap' (pressure) when the
 *              highest and 95th-percentile pressures seen both equal the set
 *              CPAP pressure, else 'auto-cpap' (pressureMin, pressureMax).
 *              flexLevel is the EPR level (0 = off). The ramp is only on/off
 *              on the card, so rampMinutes is left out; humidity and
 *              SensAwake aren't in the session shape.
 *   maskOn     [[0, use time]]: the summary's use time, to the nearest 6
 *              minutes. The card has no mask-on / mask-off marks inside a
 *              session; a break shows as a new session.
 *   events     from the detail flags, as OSCAR maps them: byte 2 obstructive,
 *              byte 3 central (OSCAR's clear airway), bytes 4 and 5 hypopnea,
 *              byte 6 flow-limitation, each at its slot's start + 60 s (OSCAR's
 *              placing). Durations aren't recorded (0). SensAwake (the top two
 *              bits of bytes 4-6) and the top bits of bytes 2-3 aren't read.
 *   readings   every two minutes: { at, span: 120, pressure } from the detail
 *              (at the block's end), and totalLeak (L/min, vent included:
 *              OSCAR reads the EDF's Leak as total leak) as the mean of the
 *              real-time Leak samples in those two minutes, when an HRD file
 *              starts inside the session. The leak beyond the vent isn't on the
 *              card (OSCAR works it out from a mask profile the user types in).
 *   deviceCounts  null: the summary has four 16-bit fields OSCAR leaves unknown.
 *   Not read: the detail's leak byte, the mask-pressure and flow waveforms,
 *   the pressures seen, the summary's other unknown bytes.
 *
 * Clock: 'device-local'. The packed dates and the EDF header are the machine's
 * wall clock with no zone (OSCAR reads both as UTC), so times are seconds read
 * as if UTC.
 *
 * readSleepStyle(files) → { device, clock, sessions, filesRead, warnings } as in
 * SESSIONS.md. files: [{ path, read: () => Promise<ArrayBuffer> }]. isSleepStyle
 * only sees paths, so an ICON card passes it too; readSleepStyle then reads the
 * summary header and throws ReaderError 'not-this-machine'. */
import { readEdf } from './edf.js';
import { ReaderError } from './errors.js';

export { ReaderError };

const MACHINE_DIR = /(?:^|\/)ICON\/[^/]+$/i;
const REALTIME_DIR = /(?:^|\/)ICON\/[^/]+\/REALTIME$/i;
const SUM_NAME = /^SUM[^/]*\.FPH$/i;
const DET_NAME = /^DET[^/]*\.FPH$/i;
const HRD_NAME = /^HRD[^/]*\.EDF$/i;

const HEADER = 0x200;
const INDEX = 0x800;
const SUM_RECORD = 0x28;
const DET_RECORD = 21; // three 7-byte blocks
const BLOCK = 120; // seconds in a detail block
const SLOT = 20; // seconds in a flag slot

const split = (path) => {
  const i = path.lastIndexOf('/');
  return [i < 0 ? '' : path.slice(0, i), path.slice(i + 1)];
};

/* an F&P ICON-layout card (SleepStyle or ICON): a summary file in a machine folder */
export const isSleepStyle = (paths) =>
  paths.some((p) => {
    const [dir, name] = split(p.replace(/\\/g, '/'));
    return SUM_NAME.test(name) && MACHINE_DIR.test(dir);
  });

/* ---------- the packed date ---------- */

/* OSCAR's ssconvertDate: device wall clock → seconds read as if UTC, minus 54 s.
 * null when the fields aren't a real date. */
function convertDate(ts) {
  const day = ts & 0x1f;
  const month = (ts >>> 5) & 0x0f;
  const year = 2000 + ((ts >>> 9) & 0x3f);
  const t2 = ts >>> 15;
  const second = t2 & 0x3f;
  const minute = (t2 >>> 6) & 0x3f;
  const hour = t2 >>> 12;
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const d = new Date(ms);
  if (
    month < 1 || day < 1 || hour > 23 || minute > 59 || second > 59 ||
    d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day
  ) return null;
  return ms / 1000 - 54;
}

const isEnd = (ts) => ts === 0xffffffff || (ts & 0xffff) === 0xfafe;

/* ---------- the shared 512-byte header ---------- */

function readHeader(u8) {
  let text = '';
  for (let i = 0; i < HEADER; i++) text += String.fromCharCode(u8[i]);
  // h1, version, file name, serial, model, type ("SPSAAN": 4th letter A = Auto, C = CPAP), unknown
  const [, version, , serial, model, type] = text.replace(/\0/g, ' ').split(/\s+/).filter(Boolean);
  return { version, serial, model: model ?? '', type: type ?? '', terminated: u8[0x1ff] === 0x3b };
}

/* ---------- the summary file ---------- */

function readSummary(u8, warn) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const sessions = [];
  let badDates = 0;
  let pos = HEADER;
  while (pos + 4 <= u8.length) {
    const ts = dv.getUint32(pos, true);
    if (isEnd(ts)) break;
    if (pos + SUM_RECORD > u8.length) {
      warn('ends partway through a session record');
      break;
    }
    const b = (o) => u8[pos + o];
    const start = convertDate(ts);
    if (start == null) badDates++;
    else {
      const useTime = b(0x05) * 360; // tenths of an hour → seconds
      const [maxSeen, pct95Seen] = [b(0x08), b(0x07)];
      const [cpapSet, minSet, maxSet] = [b(0x1c), b(0x1d), b(0x1e)];
      const settings =
        maxSeen === cpapSet && pct95Seen === cpapSet
          ? { mode: 'cpap', pressure: cpapSet / 10 }
          : { mode: 'auto-cpap', pressureMin: minSet / 10, pressureMax: maxSet / 10 };
      settings.flexLevel = b(0x21); // EPR level, 0 = off
      sessions.push({ start, useTime, settings });
    }
    pos += SUM_RECORD;
  }
  if (badDates) warn(`${badDates} session record${badDates > 1 ? 's' : ''} with an unreadable date skipped`);
  return sessions;
}

/* ---------- the detail file ---------- */

// flag byte (offset in the 7-byte block) → event type, as OSCAR maps them
const FLAGS = [
  [2, 'obstructive'],
  [3, 'central'],
  [4, 'hypopnea'],
  [5, 'hypopnea'],
  [6, 'flow-limitation'],
];

/* index entries → { start: seconds, events, readings } for each session it holds */
function readDetail(u8, warn) {
  if (u8.length < HEADER + INDEX) throw new Error('too short for its index');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const entries = [];
  for (let pos = HEADER; pos + 4 <= HEADER + INDEX; pos += 9) {
    const ts = dv.getUint32(pos, true);
    if (isEnd(ts) || pos + 9 > HEADER + INDEX) break;
    const start = convertDate(ts);
    if (start == null) continue;
    entries.push({ start, first: dv.getUint16(pos + 4, true), records: u8[pos + 6] });
  }

  const data = u8.subarray(HEADER + INDEX);
  const out = [];
  for (const e of entries) {
    const events = [];
    const readings = [];
    let idx = e.first * DET_RECORD;
    let blocks = e.records * 3;
    const fit = Math.max(0, Math.floor((data.length - idx) / 7));
    if (fit < blocks) {
      warn('a session’s detail runs past the end of the file; read what’s there');
      blocks = fit;
    }
    for (let k = 0; k < blocks; k++, idx += 7) {
      const t0 = k * BLOCK;
      readings.push({ at: t0 + BLOCK, span: BLOCK, pressure: data[idx] / 10 });
      for (let slot = 0; slot < 6; slot++) {
        for (const [off, type] of FLAGS) {
          if (data[idx + off] & (1 << slot)) events.push({ type, at: t0 + slot * SLOT + 60, duration: 0, countedByDevice: true });
        }
      }
    }
    out.push({ start: e.start, events, readings });
  }
  return out;
}

/* ---------- the real-time EDF ---------- */

const LPM = /^(l\/?min|l\/m|lpm)$/i;

/* the Leak signal → { start (s), end (s), rate (Hz), values } */
function readRealtime(buf) {
  const edf = readEdf(buf, { signals: ['Leak'] });
  const leak = edf.signals.Leak;
  const start = edf.start / 1000;
  const end = start + edf.nrec * edf.recordSec;
  if (!leak) return { start, end, leak: null, note: 'has no Leak signal' };
  if (!LPM.test(leak.dim.replace(/\s/g, ''))) return { start, end, leak: null, note: `leak in “${leak.dim}”, not L/min: not read` };
  return { start, end, leak };
}

/* ---------- the whole card ---------- */

export async function readSleepStyle(files, { onProgress } = {}) {
  const warnings = [];
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') }));
  if (!isSleepStyle(norm.map((f) => f.path))) throw new ReaderError('not-this-machine', 'No Fisher & Paykel SleepStyle card found.');

  // machine folders → their SUM / DET / HRD files, in name order (as OSCAR lists them)
  const machines = new Map();
  const folder = (dir) => {
    if (!machines.has(dir)) machines.set(dir, { sum: [], det: [], hrd: [] });
    return machines.get(dir);
  };
  for (const f of norm) {
    const [dir, name] = split(f.path);
    if (MACHINE_DIR.test(dir) && SUM_NAME.test(name)) folder(dir).sum.push(f);
    else if (MACHINE_DIR.test(dir) && DET_NAME.test(name)) folder(dir).det.push(f);
    else if (REALTIME_DIR.test(dir) && HRD_NAME.test(name)) folder(split(dir)[0]).hrd.push(f);
  }
  const byName = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const m of machines.values()) for (const k of ['sum', 'det', 'hrd']) m[k].sort(byName);

  // a SleepStyle folder: its first summary's header names the model SLEEPSTYLE
  const found = [];
  for (const [dir, m] of machines) {
    if (!m.sum.length) continue;
    try {
      const u8 = new Uint8Array(await m.sum[0].read());
      if (u8.length < HEADER) continue;
      const h = readHeader(u8);
      if (h.model.toUpperCase() === 'SLEEPSTYLE') found.push({ dir, m, h, firstSum: u8 });
    } catch {
      // unreadable: not counted as a SleepStyle folder
    }
  }
  if (!found.length) throw new ReaderError('not-this-machine', 'No Fisher & Paykel SleepStyle card found.');
  const pick = found.sort((a, b) => b.m.sum.length + b.m.det.length - (a.m.sum.length + a.m.det.length))[0];
  if (found.length > 1) warnings.push(`The card holds ${found.length} SleepStyle machines; read the one with the most files.`);
  const { m, h } = pick;

  // never put the serial (it's also the folder's name) in a warning
  const serialTexts = [split(pick.dir)[1], h.serial].filter((s) => s && s.length > 2);
  const scrub = (s) => serialTexts.reduce((acc, x) => acc.split(x).join('…'), s);
  const nameOf = (f) => scrub(split(f.path)[1]);

  const typex = h.type.length > 4 ? (h.type[3] === 'C' ? 'CPAP' : 'Auto') : '';
  const device = {
    manufacturer: 'Fisher & Paykel',
    model: typex ? `SleepStyle ${typex}` : 'SleepStyle',
    modelNumber: h.type || null,
    serial: h.serial || split(pick.dir)[1] || null,
    firmware: null,
  };

  const total = m.sum.length + m.det.length + m.hrd.length;
  let done = 0;
  const tick = async () => {
    onProgress?.({ done: ++done, total });
    if (done % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  };

  // summaries: one session per record, keyed by start (OSCAR's session id)
  const byStart = new Map();
  for (const f of m.sum) {
    const warn = (msg) => warnings.push(`${nameOf(f)}: ${msg}`);
    try {
      const u8 = f === m.sum[0] ? pick.firstSum : new Uint8Array(await f.read());
      if (u8.length < HEADER) throw new Error('too short for its header');
      if (u8[0x1ff] !== 0x3b) warn('header doesn’t end where expected; read anyway');
      for (const s of readSummary(u8, warn)) if (!byStart.has(s.start)) byStart.set(s.start, s);
    } catch (err) {
      warn(err.message);
    }
    await tick();
  }

  // details: events and pressures for the sessions the summaries know
  const detail = new Map();
  let orphans = 0;
  for (const f of m.det) {
    const warn = (msg) => warnings.push(`${nameOf(f)}: ${msg}`);
    try {
      const u8 = new Uint8Array(await f.read());
      if (u8.length < HEADER) throw new Error('too short for its header');
      if (u8[0x1ff] !== 0x3b) throw new Error('header doesn’t end where expected; not read');
      for (const d of readDetail(u8, warn)) {
        if (!byStart.has(d.start)) orphans++;
        else if (!detail.has(d.start)) detail.set(d.start, d);
      }
    } catch (err) {
      warn(err.message);
    }
    await tick();
  }
  if (orphans) warnings.push(`${orphans} detail entr${orphans > 1 ? 'ies' : 'y'} with no matching summary skipped`);

  // real-time files: leak, for the session they start in (OSCAR's findSession)
  const starts = [...byStart.values()].sort((a, b) => a.start - b.start);
  const leakSums = new Map(); // session start → Map(window → [sum, n])
  const extend = new Map(); // session start → latest end (s from start)
  for (const f of m.hrd) {
    const warn = (msg) => warnings.push(`${nameOf(f)}: ${msg}`);
    try {
      const rt = readRealtime(await f.read());
      const s = starts.find((x) => rt.start >= x.start && rt.start <= x.start + x.useTime);
      if (!s) warn('starts outside every session; not read');
      else {
        extend.set(s.start, Math.max(extend.get(s.start) ?? 0, rt.end - s.start));
        if (!rt.leak) warn(rt.note);
        else {
          const sums = leakSums.get(s.start) ?? new Map();
          leakSums.set(s.start, sums);
          const offset = rt.start - s.start;
          rt.leak.values.forEach((v, i) => {
            if (Number.isNaN(v)) return;
            const w = Math.floor((offset + i / rt.leak.rate) / BLOCK);
            const acc = sums.get(w) ?? [0, 0];
            acc[0] += v;
            acc[1]++;
            sums.set(w, acc);
          });
        }
      }
    } catch (err) {
      warn(err.message);
    }
    await tick();
  }

  const sessions = starts.map((s) => {
    const d = detail.get(s.start);
    const readings = new Map((d?.readings ?? []).map((r) => [r.at, { ...r }]));
    for (const [w, [sum, n]] of leakSums.get(s.start) ?? []) {
      const at = (w + 1) * BLOCK;
      const r = readings.get(at) ?? { at, span: BLOCK };
      r.totalLeak = Math.round((sum / n) * 10) / 10;
      readings.set(at, r);
    }
    return {
      id: s.start,
      start: s.start,
      end: Math.max(s.useTime, extend.get(s.start) ?? 0),
      maskOn: s.useTime > 0 ? [[0, s.useTime]] : [],
      settings: s.settings,
      deviceCounts: null,
      events: (d?.events ?? []).sort((a, b) => a.at - b.at),
      readings: [...readings.values()].sort((a, b) => a.at - b.at),
      pressureChanges: [],
    };
  });

  return { device, clock: 'device-local', sessions, filesRead: total, warnings };
}
