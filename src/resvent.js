// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — Resvent iBreeze SD cards → plain therapy sessions.
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
 * Adapted from OSCAR's resvent_loader.cpp / resvent_loader.h (oscar/SleepLib/
 * loader_plugins, commit 4438aecb259e63b53219a861062b7878bfe77cfc), with
 * channel meanings from oscar/SleepLib/schema.cpp. Changes: plain JavaScript
 * over a list of files; a plain session result; damaged or unexplained data is
 * skipped with a warning instead of zero-filled.
 *
 * Machines: Resvent iBreeze (20A, 20C, 25A, 30STA) and iDisc 20A; OSCAR also
 * names the Hoffrichter Point / Trend, which write the same card.
 *
 * The card (no encryption or scrambling: text files and plain int16 samples):
 *   THERAPY/CONFIG/<name>       the machine's CURRENT settings, one key=value per
 *                               line after a 4-byte prefix OSCAR skips (so do we).
 *                               SYSCFG (models, sn), TCTRL (VentMode), COMFORT
 *                               (iPR), plus ALARM, CHECK.TXT, SETTING, VERSION;
 *                               then the mode's own file N_CPAP / N_APAP / N_S30 /
 *                               N_AS30 / N_ST30 / N_AST30 / N_T30 / N_PC
 *                               (pressures in 1/100 cmH2O).
 *   THERAPY/RECORD/<YYYYMM>/<DD>/  one folder per day:
 *     STAT                      the day's summary: not read (OSCAR doesn't either)
 *     STAT<nn>                  one session ("usage"): secStart, secUsed and the
 *                               machine's counts cntOAI, cntCAI, cntHI, cntRERA, …
 *     EV<nn>                    its events, one per line: ID=<type>,DT=<secs>,DR=<secs>,GD=…,
 *     P<nn>_<k>                 its slow readings (one every few seconds): a 0x24-byte
 *                               header (u16 seconds per chunk at 0x10, u16 channel
 *                               count at 0x12), 0x20 bytes per channel (8-byte name,
 *                               u16 samples per chunk at 0x1e), then chunks: for each
 *                               channel in turn its samples as int16 LE. The chunk
 *                               files continue one another in order of <k>.
 *     W<nn>_<k>                 the 25 Hz flow and mask-pressure waveforms: not read.
 *     ALM<nn>                   alarms: not read.
 *   THERAPY/LOG/…               the machine's log (setting changes, card events): not read.
 *
 * Clock: 'device-local'. secStart / DT are seconds the machine writes as if
 * its own wall clock were UTC+8; OSCAR adds 8 hours to get that wall clock
 * back (kDateTimeOffset) before placing it in the computer's zone. Here
 * start = secStart + 8 h: the machine's wall clock, read as if UTC.
 *
 * Leak: OSCAR files the P channel "Leak" (x 0.1 L/min) as CPAP_Leak, "Rate of
 * detected mask leakage", not CPAP_LeakTotal ("including natural mask
 * leakages"), so it comes out as `leak` (beyond the vent). OSCAR's mapping,
 * not checked against the manufacturer.
 *
 * readResvent(files) → {
 *   device:   { manufacturer: 'Resvent' | 'Hoffrichter', model (SYSCFG models),
 *               modelNumber: null, serial (SYSCFG sn), firmware: null }
 *   clock:    'device-local'
 *   sessions: [{
 *     id                 '<YYYYMMDD>-<nn>': the day folder and the session's number in it
 *     start              seconds (see Clock)
 *     end                secUsed: seconds from start the machine ran
 *     maskOn             [[0, end]]: a session is one stretch; a break is a new session
 *     settings           from THERAPY/CONFIG, the same on every session (the card
 *                        keeps only the current ones; a warning says so):
 *                        mode (VentMode 1 cpap, 3 auto-cpap, 10 S / 12 S/T / 14 T /
 *                        15 PC bilevel, 11 auto S / 13 auto S/T auto-bilevel, as
 *                        OSCAR files them), pressure (Press), pressureMin / Max
 *                        (PMin / PMax), epap / ipap (EPAP / IPAP; in the auto
 *                        bilevel modes EPAPMin / IPAPMax), flexLevel (iPR, the
 *                        exhale relief level). Not read: PS, TitraTime (backup
 *                        rate), ramp (only in the log).
 *     deviceCounts       STAT<nn>'s cntOAI → obstructive, cntCAI → central,
 *                        cntHI → hypopnea, cntRERA → rera; a key the file lacks
 *                        is left out (it has no flow-limitation count); null if none
 *     events             EV<nn>: 17 obstructive, 18 central, 19 hypopnea,
 *                        20 flow-limitation, 21 rera, 22 periodic-breathing, 23 snore;
 *                        at = when it began (DT), duration = DR (0 for a RERA, as
 *                        OSCAR: its DR runs long). Other IDs: not events OSCAR
 *                        knows, skipped. countedByDevice: true (nothing says otherwise).
 *     readings           P<nn>_*: { at, span, pressure (Press), ipap, epap (cmH2O),
 *                        leak (L/min), tidalVolume (Vt, mL), minuteVent (MV, L/min),
 *                        respRate (RR, /min) }, at = the sample's time as OSCAR places
 *                        it, span = one sample's period. Not read: Ti, I:E (no field
 *                        here); SpO2, PR (OSCAR: "not present", no scale known).
 *     pressureChanges    [] (not recorded)
 *   }]
 *   filesRead, warnings
 * }
 * files: [{ path, read: () => Promise<ArrayBuffer> }]. Throws ReaderError
 * 'not-this-machine' when there's no Resvent card in them. */
import { ReaderError } from './errors.js';

export { ReaderError };

const CONFIG_FILE = /^(.*?)THERAPY\/CONFIG\/([^/]+)$/i;
const RECORD_FILE = /^(.*?)THERAPY\/RECORD\//i;
const DAY_FILE = /^(.*?)THERAPY\/RECORD\/(\d{4})(\d{2})\/(\d{1,2})\/([^/]+)$/i;
const STAT_NAME = /^STAT(.{2})$/i;
const EV_NAME = /^EV(.{2})$/i;
const P_NAME = /^P(.{2})_(.+)$/i;

const WALL_CLOCK_SHIFT = 8 * 3600; // OSCAR's kDateTimeOffset

/* a Resvent card: THERAPY/CONFIG beside THERAPY/RECORD (OSCAR's Detect), or,
 * with no nights recorded yet, the CONFIG folder's own SYSCFG / TCTRL */
export function isResvent(paths) {
  const norm = paths.map((p) => p.replace(/\\/g, '/'));
  const config = norm.filter((p) => CONFIG_FILE.test(p));
  if (!config.length) return false;
  return norm.some((p) => RECORD_FILE.test(p)) || config.some((p) => /^(SYSCFG|TCTRL)$/i.test(CONFIG_FILE.exec(p)[2]));
}

/* ---------- text files: a 4-byte prefix, then lines ---------- */

function lines(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 4) throw new Error('file too short');
  let s = '';
  for (let i = 4; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s.split(/\r?\n|\r/).map((l) => l.trim()).filter(Boolean);
}

/* key=value lines → Map; a line that isn't one is counted, not read */
function keyValues(buf) {
  const kv = new Map();
  let bad = 0;
  for (const line of lines(buf)) {
    const parts = line.split('=');
    if (parts.length !== 2 || !parts[0].trim()) bad++;
    else kv.set(parts[0].trim(), parts[1].trim());
  }
  return { kv, bad };
}

const int = (v) => (v != null && /^-?\d+$/.test(v) ? Number(v) : null);
const uint = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/* ---------- settings and device (THERAPY/CONFIG) ---------- */

const CONFIG_FILES = ['ALARM', 'COMFORT', 'CHECK.TXT', 'SETTING', 'VERSION', 'SYSCFG', 'TCTRL'];

/* TCTRL VentMode → the mode's file, the mode (as OSCAR's CPAP_Mode) and the
 * pressures it carries, in 1/100 cmH2O */
const VENT_MODES = {
  1: { file: 'N_CPAP', mode: 'cpap', keys: { pressure: 'Press' } },
  3: { file: 'N_APAP', mode: 'auto-cpap', keys: { pressureMin: 'PMin', pressureMax: 'PMax' } },
  10: { file: 'N_S30', mode: 'bilevel', keys: { epap: 'EPAP', ipap: 'IPAP' } },
  11: { file: 'N_AS30', mode: 'auto-bilevel', keys: { epap: 'EPAPMin', ipap: 'IPAPMax' } },
  12: { file: 'N_ST30', mode: 'bilevel', keys: { epap: 'EPAP', ipap: 'IPAP' } },
  13: { file: 'N_AST30', mode: 'auto-bilevel', keys: { epap: 'EPAPMin', ipap: 'IPAPMax' } },
  14: { file: 'N_T30', mode: 'bilevel', keys: { epap: 'EPAP', ipap: 'IPAP' } },
  15: { file: 'N_PC', mode: 'bilevel', keys: { epap: 'EPAP', ipap: 'IPAP' } },
};

async function readConfig(configFiles, warnings) {
  const byName = new Map(configFiles.map((f) => [f.name.toUpperCase(), f]));
  const kv = new Map();
  const load = async (name) => {
    const f = byName.get(name);
    if (!f) return; // a missing file is skipped, as in OSCAR
    try {
      const r = keyValues(await f.read());
      for (const [k, v] of r.kv) kv.set(k, v); // a later file wins, as in OSCAR
      if (r.bad) warnings.push(`CONFIG/${f.name}: ${r.bad} line(s) not read`);
    } catch (err) {
      warnings.push(`CONFIG/${f.name}: ${err.message}`);
    }
  };
  for (const name of CONFIG_FILES) await load(name);

  const settings = {};
  const ventMode = int(kv.get('VentMode'));
  const vm = VENT_MODES[ventMode];
  if (vm) {
    await load(vm.file);
    settings.mode = vm.mode;
    for (const [field, key] of Object.entries(vm.keys)) {
      const v = uint(kv.get(key));
      if (v != null) settings[field] = v / 100;
    }
  } else if (kv.has('VentMode')) {
    warnings.push(`The machine's mode (${kv.get('VentMode')}) isn't one known; its settings aren't read.`);
  }
  const ipr = int(kv.get('iPR'));
  if (ipr != null) settings.flexLevel = ipr;

  const model = kv.get('models') || null;
  const device = {
    manufacturer: model && /point|trend/i.test(model) ? 'Hoffrichter' : 'Resvent',
    model,
    modelNumber: null,
    serial: kv.get('sn') || null,
    firmware: null,
  };
  if (!device.serial && byName.size) warnings.push('The card’s settings don’t give a serial number (OSCAR won’t import it); read anyway.');
  return { device, settings };
}

/* ---------- one session's files ---------- */

function readUsage(buf) {
  const { kv } = keyValues(buf);
  const secStart = int(kv.get('secStart'));
  const secUsed = int(kv.get('secUsed'));
  if (secStart == null || secUsed == null || secUsed < 0) throw new Error('no start time or length');
  const counts = {};
  for (const [key, field] of [['cntOAI', 'obstructive'], ['cntCAI', 'central'], ['cntHI', 'hypopnea'], ['cntRERA', 'rera']]) {
    const v = int(kv.get(key));
    if (v != null && v >= 0) counts[field] = v;
  }
  return { secStart, secUsed, deviceCounts: Object.keys(counts).length ? counts : null };
}

const EVENT_TYPES = {
  17: 'obstructive',
  18: 'central',
  19: 'hypopnea',
  20: 'flow-limitation',
  21: 'rera',
  22: 'periodic-breathing',
  23: 'snore',
};

/* EV<nn> → events; returns how many lines couldn't be read or fell outside the session */
function readEvents(buf, usage) {
  const events = [];
  let bad = 0;
  let outside = 0;
  for (const line of lines(buf)) {
    const parts = line.split(',').filter(Boolean);
    if (parts.length !== 4) {
      bad++;
      continue;
    }
    const f = Object.fromEntries(parts.map((p) => p.split('=')).filter((kv) => kv.length === 2));
    const id = int(f.ID);
    const dt = int(f.DT);
    const dr = int(f.DR);
    if (id == null || dt == null || dr == null || dr < 0) {
      bad++;
      continue;
    }
    const type = EVENT_TYPES[id];
    if (!type) continue; // not an event OSCAR knows
    const at = dt - usage.secStart;
    if (at < 0 || at > usage.secUsed) {
      outside++;
      continue;
    }
    events.push({ type, at, duration: type === 'rera' ? 0 : dr, countedByDevice: true });
  }
  events.sort((a, b) => a.at - b.at);
  return { events, bad, outside };
}

/* P channel name → reading field and scale (OSCAR's GetEventList) */
const CHANNELS = {
  Press: ['pressure', 0.01],
  IPAP: ['ipap', 0.01],
  EPAP: ['epap', 0.01],
  Leak: ['leak', 0.1],
  Vt: ['tidalVolume', 1],
  MV: ['minuteVent', 0.01],
  RR: ['respRate', 0.1],
};
const KNOWN_UNREAD = new Set(['Ti', 'I:E', 'SpO2', 'PR']);

const MAIN_HEADER = 0x24;
const CHANNEL_HEADER = 0x20;

function readPHeader(dv) {
  if (dv.byteLength < MAIN_HEADER) throw new Error('file too short');
  const chunkSec = dv.getUint16(0x10, true);
  const count = dv.getUint16(0x12, true);
  if (!chunkSec || !count) throw new Error('header has no chunk length or channels');
  const dataStart = MAIN_HEADER + count * CHANNEL_HEADER;
  if (dv.byteLength < dataStart) throw new Error('file too short for its header');
  const channels = [];
  for (let i = 0; i < count; i++) {
    const o = MAIN_HEADER + i * CHANNEL_HEADER;
    let name = '';
    for (let j = 0; j < 8; j++) {
      const c = dv.getUint8(o + j);
      if (!c) break;
      name += String.fromCharCode(c);
    }
    channels.push({ name: name.trim(), spc: dv.getUint16(o + 0x1e, true) });
  }
  return { chunkSec, channels, dataStart };
}

const sameLayout = (a, b) =>
  a.chunkSec === b.chunkSec &&
  a.channels.length === b.channels.length &&
  a.channels.every((c, i) => c.name === b.channels[i].name && c.spc === b.channels[i].spc);

/* P<nn>_* (in order) → readings. Every channel must have the same samples per
 * chunk: OSCAR's reading of a file whose channels differ isn't one we can follow. */
async function readReadings(pFiles, label, warnings, unknownChannels) {
  const readings = [];
  let layout = null;
  let t0 = 0; // seconds from start of the next chunk, carried across files
  for (const f of pFiles) {
    let dv;
    let h;
    try {
      dv = new DataView(await f.read());
      h = readPHeader(dv);
    } catch (err) {
      warnings.push(`${label} ${f.name}: ${err.message}; later readings in this session not read.`);
      break;
    }
    if (!layout) {
      layout = h;
      if (h.channels.some((c) => c.spc !== h.channels[0].spc) || !h.channels[0].spc) {
        warnings.push(`${label}: readings with channels at different rates; not read.`);
        break;
      }
      for (const c of h.channels) if (!CHANNELS[c.name] && !KNOWN_UNREAD.has(c.name)) unknownChannels.add(c.name);
    } else if (!sameLayout(layout, h)) {
      warnings.push(`${label} ${f.name}: a different layout from the session's first readings file; it and later ones not read.`);
      break;
    }
    const spc = layout.channels[0].spc;
    const period = layout.chunkSec / spc;
    const chunkBytes = layout.channels.length * spc * 2;
    const body = dv.byteLength - h.dataStart;
    const chunks = Math.floor(body / chunkBytes);
    for (let c = 0; c < chunks; c++) {
      const base = h.dataStart + c * chunkBytes;
      for (let j = 0; j < spc; j++) {
        const r = { at: t0 + c * layout.chunkSec + j * period, span: period };
        layout.channels.forEach((ch, i) => {
          const m = CHANNELS[ch.name];
          if (m) r[m[0]] = Math.round(dv.getInt16(base + (i * spc + j) * 2, true) * m[1] * 1000) / 1000;
        });
        readings.push(r);
      }
    }
    // a part-chunk at the end: not read, but its time still passes (as in OSCAR)
    const part = body % chunkBytes ? 1 : 0;
    if (part) warnings.push(`${label} ${f.name}: ends part-way through a chunk; that chunk not read.`);
    t0 += (chunks + part) * layout.chunkSec;
  }
  return readings;
}

/* ---------- the whole card ---------- */

export async function readResvent(files, { onProgress } = {}) {
  const warnings = [];
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') }));
  if (!isResvent(norm.map((f) => f.path))) throw new ReaderError('not-this-machine', 'No Resvent card found.');

  // the THERAPY folder with the most days (a selection could hold more than one card)
  const roots = new Map();
  for (const f of norm) {
    const m = DAY_FILE.exec(f.path) ?? CONFIG_FILE.exec(f.path);
    if (m) roots.set(m[1].toLowerCase(), (roots.get(m[1].toLowerCase()) ?? 0) + (DAY_FILE.test(f.path) ? 1 : 0));
  }
  const root = [...roots].sort((a, b) => b[1] - a[1])[0][0];
  if (roots.size > 1) warnings.push(`The files hold ${roots.size} Resvent cards; read the one with the most data.`);
  const inRoot = (m) => m && m[1].toLowerCase() === root;

  const configFiles = [];
  const days = new Map(); // 'YYYYMMDD' → [{ name, read }]
  for (const f of norm) {
    const c = CONFIG_FILE.exec(f.path);
    if (inRoot(c)) {
      configFiles.push({ name: c[2], read: f.read });
      continue;
    }
    const d = DAY_FILE.exec(f.path);
    if (!inRoot(d)) continue;
    const key = `${d[2]}${d[3]}${d[4].padStart(2, '0')}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push({ name: d[5], read: f.read });
  }

  const { device, settings } = await readConfig(configFiles, warnings);

  // every session: one STAT<nn> per day folder
  const todo = [];
  for (const [day, list] of [...days].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    for (const f of list) {
      const m = STAT_NAME.exec(f.name);
      if (!m) continue;
      const nn = m[1];
      const ev = list.find((x) => EV_NAME.exec(x.name)?.[1] === nn);
      const ps = list
        .map((x) => ({ x, m: P_NAME.exec(x.name) }))
        .filter((p) => p.m && p.m[1] === nn)
        .sort((a, b) => {
          const na = Number(a.m[2]);
          const nb = Number(b.m[2]);
          return Number.isNaN(na) || Number.isNaN(nb) ? (a.m[2] < b.m[2] ? -1 : 1) : na - nb;
        })
        .map((p) => p.x);
      todo.push({ day, nn, stat: f, ev, ps });
    }
  }

  const sessions = [];
  const unknownChannels = new Set();
  let filesRead = 0;
  let done = 0;
  for (const s of todo) {
    const label = `${s.day.slice(0, 4)}-${s.day.slice(4, 6)}-${s.day.slice(6)} session ${s.nn}`;
    filesRead += 1 + (s.ev ? 1 : 0) + s.ps.length;
    try {
      let usage;
      try {
        usage = readUsage(await s.stat.read());
      } catch (err) {
        throw new Error(`STAT${s.nn}: ${err.message}; session not read`);
      }
      let events = [];
      if (s.ev) {
        try {
          const r = readEvents(await s.ev.read(), usage);
          events = r.events;
          if (r.bad) warnings.push(`${label}: ${r.bad} event line(s) not read.`);
          if (r.outside) warnings.push(`${label}: ${r.outside} event(s) outside the session's time, left out.`);
        } catch (err) {
          warnings.push(`${label} EV${s.nn}: ${err.message}; events not read.`);
        }
      }
      const readings = await readReadings(s.ps, label, warnings, unknownChannels);
      sessions.push({
        id: `${s.day}-${s.nn}`,
        start: usage.secStart + WALL_CLOCK_SHIFT,
        end: usage.secUsed,
        maskOn: usage.secUsed > 0 ? [[0, usage.secUsed]] : [],
        settings: { ...settings },
        deviceCounts: usage.deviceCounts,
        events,
        readings,
        pressureChanges: [],
      });
    } catch (err) {
      warnings.push(`${label}: ${err.message}.`);
    }
    onProgress?.({ done: ++done, total: todo.length });
    if (done % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  if (unknownChannels.size) warnings.push(`Readings not known to OSCAR, not read: ${[...unknownChannels].join(', ')}.`);
  // not a fault: how this machine's card is (SESSIONS.md › notes)
  const notes = [];
  if (sessions.length && Object.keys(settings).length) {
    notes.push('The card keeps only the machine’s current settings; they’re shown on every night.');
  }
  sessions.sort((a, b) => a.start - b.start);
  return { device, clock: 'device-local', sessions, filesRead, warnings, notes };
}
