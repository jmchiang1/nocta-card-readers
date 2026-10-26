// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — Löwenstein prisma SD cards → plain therapy sessions.
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
 * Adapted from OSCAR's prisma_loader.cpp / prisma_loader.h and the parts of
 * edfparser.cpp / edfparser.h they rely on (gitlab.com/CrimsonNape/oscar-sql,
 * commit 4438aecb259e63b53219a861062b7878bfe77cfc). Changes: plain JavaScript;
 * a small zip reader on the browser's DecompressionStream instead of miniz; a
 * regex attribute scanner instead of QDom; a plain session result. The prisma
 * VENT ventilators (OSCAR's prismavent_loader) are not covered.
 *
 * Two card families, told apart by the config file at the card's root (or one
 * folder down, as OSCAR's findCardPath allows):
 *
 *  prisma SMART / SOFT ("Firefly" platform)
 *    config.pscfg                JSON: devid ("0x92" SMART, "0x91" SOFT),
 *                                dev.sn (serial, hex), dev.hwversion
 *    <serial>/<day>/[<sub>/]     <serial> is dev.sn read as hex, written as a
 *      event_<n>.xml             10-digit decimal. A day folder with subfolders
 *      signal_<n>.wmedf          is read only through them. <n>: the session.
 *
 *  prisma LINE (20A, 20C, 25S, 25ST, …)
 *    config.pcfg                 a zip; mnt/flash/conf/device.xml holds
 *                                DeviceType ("10" 20A, "22" 25S, "23" 25ST),
 *                                DeviceSerialNumber, FWVersion + FWRevision
 *    therapy.pdat                a zip of …event_<nnnnnn>.xml and
 *                                …signal_<nnnnnn>.wmedf (6-digit session)
 *    The zips are plain (stored or deflate, CRC-32 checked). Nothing on either
 *    card is encrypted; an encrypted zip entry would be skipped with a warning.
 *
 * Per session:
 *  - event_<n>.xml: <DeviceEvent DeviceEventID ParameterID NewValue Time>
 *    (ID 0: a setting for the session; ID 1: a change during it, not read)
 *    and <RespEvent RespEventID EndTime Duration Pressure Strength>, times in
 *    tenths of a second from the session start.
 *  - signal_<n>.wmedf: EDF with a twist: each signal's 32-byte "reserved"
 *    field says "#1" (8-bit samples, unsigned when the digital minimum is
 *    ≥ 0) or "#2" (16-bit). The record count comes from the file size, not
 *    the header. A session's span is the signal file's: start (header date,
 *    the machine's own wall clock) to start + records × record length. A
 *    session with no signal file is skipped, as in OSCAR.
 *
 * What's read:
 *  - settings (cmH2O; a key is left out when the card doesn't give it):
 *      SMART: mode 1 cpap (pressure: P9), 2 auto-cpap (pressureMin P9,
 *        pressureMax P10); flexLevel = SoftPAP level (P13: 0 off, 1 slight,
 *        2 standard); rampMinutes = soft-start time (P19).
 *      LINE: mode 1 cpap (pressure P1201), 2 auto-cpap (P1201 – P1199), both
 *        with flexLevel P1123; 4 "S" → 'auto-bilevel' as OSCAR maps it (or
 *        'other' when TriLevel is on), epap P1201, ipap P1200; rampMinutes
 *        P1127 for every LINE mode. Modes OSCAR supports only partly — 3 AcSV
 *        ('asv'), 9 Auto S ('auto-bilevel' / 'other' for TriLevel), 10 Auto
 *        S/T ('other': OSCAR isn't sure of its mapping) — give the mode only,
 *        no pressures, and a warning. An unknown mode: no mode, a warning.
 *  - events (at = EndTime − Duration, seconds from start; duration seconds,
 *    kept to the tenth where OSCAR rounds down to whole seconds):
 *      101 obstructive · 102 central · 103 / 105 / 106 apnea in a leak, at
 *      high pressure, with movement → 'apnea' · 111 obstructive / 112 central
 *      hypopnea → 'hypopnea' · 121 rera · 131 snore · 151 flow-limitation ·
 *      161 critical leakage → 'large-leak' · 181 → 'periodic-breathing'
 *      (OSCAR's CSR channel). countedByDevice is true throughout: the card
 *      holds no AHI of its own to say otherwise.
 *  - readings, one a minute (span 60, the last one shorter), each the mean
 *    of the samples in that minute:
 *      pressure   the "Pressure" signal (OSCAR: mask pressure), cmH2O
 *      epap/ipap  "EPAP"/"IPAP" (SMART) or "EPAPsoll"/"IPAPsoll" (LINE): the
 *                 pressures the machine was aiming for, cmH2O
 *      leak       "LeakFlowBreath", L/min. OSCAR files it as Leak Rate
 *                 (CPAP_Leak), not Total Leak: leak BEYOND the vent → `leak`
 *  - maskOn: [[0, end]]. The card has no mask-on / mask-off marks inside a
 *    session; OSCAR counts the whole session as use. A break shows up as two
 *    sessions.
 *
 * What isn't read: the flow waveform (RespFlow, FlowFull), ObstructLevel,
 * rRMV, rMVFluctuation, PressureMeasured, EEPAPsoll, CPAPPressure; the 2-minute
 * epoch marks (1–5, 261 deep sleep), artefacts (141), timed breaths (221),
 * hypopneas in a leak (113, which OSCAR also leaves out); humidifier, tube,
 * auto-start, PMaxOA, soft-start pressure and other settings; changes made
 * during a session. No machine totals (deviceCounts: null), no pressure-change
 * list. A signal whose header scale would read differently under OSCAR's rule
 * (digital × gain) and EDF's (offset by the minimums) is skipped with a warning
 * rather than guessed.
 *
 * Clock: 'device-local' — the EDF start date is the machine's wall clock with
 * no zone (OSCAR reads it in the computer's zone); kept as seconds read as if
 * UTC.
 *
 * readPrisma(files, { onProgress }) → { device, clock, sessions, filesRead,
 * warnings } as in SESSIONS.md. files: [{ path, read: () => Promise<ArrayBuffer> }].
 * Throws ReaderError 'not-this-machine' when there's no prisma card in them. */
import { ReaderError } from './errors.js';

export { ReaderError };

const SMART_CONFIG = /(?:^|\/)config\.pscfg$/i;
const LINE_CONFIG = /(?:^|\/)config\.pcfg$/i;
const LINE_THERAPY = 'therapy.pdat';

/* a prisma card: OSCAR's Detect — config.pscfg (SMART / SOFT) or config.pcfg (LINE) */
export const isPrisma = (paths) =>
  paths.some((p) => {
    const q = p.replace(/\\/g, '/');
    return SMART_CONFIG.test(q) || LINE_CONFIG.test(q);
  });

const MODELS = {
  '0x92': 'prisma SMART',
  '0x91': 'prisma SOFT',
  10: 'prisma20A',
  22: 'prisma25S',
  23: 'prisma25ST',
};

const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1); // '' or 'a/b/'
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const depth = (p) => p.split('/').length;

/* ---------- small byte helpers ---------- */

const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const u32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const latin1 = (b, o, n) => {
  let s = '';
  for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const INT = /^\s*[+-]?\d+\s*$/;

/* text of an XML file: QDom honours a byte-order mark, so do we */
function decodeText(u8) {
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  return new TextDecoder('utf-8').decode(u8);
}

/* ---------- zip (config.pcfg, therapy.pdat) ---------- */

let crcTable = null;
function crc32(b) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function inflateRaw(u8) {
  if (typeof DecompressionStream !== 'function') throw new Error('this browser can’t unzip');
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* the central directory of a zip → [{ name, flags, method, crc, csize, usize, offset }] */
function zipEntries(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip, or cut short');
  const count = u16(b, eocd + 10);
  const cdOffset = u32(b, eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('a ZIP64 archive, not read');
  const out = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || u32(b, p) !== 0x02014b50) throw new Error('damaged zip directory');
    const nameLen = u16(b, p + 28);
    const entry = {
      flags: u16(b, p + 8),
      method: u16(b, p + 10),
      crc: u32(b, p + 16),
      csize: u32(b, p + 20),
      usize: u32(b, p + 24),
      offset: u32(b, p + 42),
      name: new TextDecoder(u16(b, p + 8) & 0x800 ? 'utf-8' : 'latin1').decode(b.subarray(p + 46, p + 46 + nameLen)),
    };
    out.push(entry);
    p += 46 + nameLen + u16(b, p + 30) + u16(b, p + 32);
  }
  return out;
}

/* one zip member's bytes; throws with a plain reason */
async function zipExtract(b, e) {
  if (e.flags & 0x41) throw new Error('encrypted, not read');
  const p = e.offset;
  if (p + 30 > b.length || u32(b, p) !== 0x04034b50) throw new Error('damaged zip entry');
  const start = p + 30 + u16(b, p + 26) + u16(b, p + 28);
  if (start + e.csize > b.length) throw new Error('cut short');
  const raw = b.subarray(start, start + e.csize);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) {
    try {
      data = await inflateRaw(raw);
    } catch (err) {
      if (typeof DecompressionStream !== 'function') throw err;
      throw new Error('won’t unzip (damaged)');
    }
  }
  else throw new Error(`compression method ${e.method}, not read`);
  if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error('checksum doesn’t match (damaged)');
  return data;
}

/* ---------- the XML files ---------- */

/* every <tag …> start tag's attributes (QDom's elementsByTagName, for flat files) */
function elements(text, tag) {
  const out = [];
  const re = new RegExp(`<${tag}(?=[\\s/>])([^>]*)>`, 'g');
  let m;
  while ((m = re.exec(text))) {
    const attrs = [];
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs.push([a[1], a[2] ?? a[3]]);
    out.push(attrs);
  }
  return out;
}

/* a complete document: one root element, closed (or self-closed) at the end */
function xmlText(u8) {
  const text = decodeText(u8).replace(/<!--[\s\S]*?-->/g, '');
  const body = text.replace(/^﻿?\s*(<\?[\s\S]*?\?>\s*)?(<!DOCTYPE[^>]*>\s*)?/, '');
  const root = /^<([\w:.-]+)/.exec(body)?.[1];
  const trimmed = body.trimEnd();
  if (!root || !(trimmed.endsWith(`</${root}>`) || (/^<[^>]*\/>$/.test(trimmed)))) {
    throw new Error('isn’t complete XML (damaged or cut short)');
  }
  return text;
}

/* device.xml in config.pcfg: OSCAR takes the first attribute of each element */
function readDeviceXml(u8) {
  const text = xmlText(u8);
  const first = (tag) => elements(text, tag)[0]?.[0]?.[1]?.trim() || null;
  const version = first('FWVersion');
  const revision = first('FWRevision');
  return {
    modelNumber: first('DeviceType'),
    serial: first('DeviceSerialNumber'),
    firmware: version && revision ? `${version}.${revision}` : version,
  };
}

/* event_<n>.xml → settings for the session and the breathing events */
function readEventXml(u8) {
  const text = xmlText(u8);
  const params = new Map();
  let skipped = 0;
  for (const attrs of elements(text, 'DeviceEvent')) {
    const a = Object.fromEntries(attrs);
    if (!INT.test(a.DeviceEventID ?? '') || Number(a.DeviceEventID) !== 0) continue; // 1: a change during the session
    if (!INT.test(a.ParameterID ?? '') || !INT.test(a.NewValue ?? '')) {
      skipped++;
      continue;
    }
    params.set(Number(a.ParameterID), Number(a.NewValue));
  }
  const events = [];
  for (const attrs of elements(text, 'RespEvent')) {
    const a = Object.fromEntries(attrs);
    // OSCAR reads a missing Duration as 0; anything unreadable is skipped here
    if (!INT.test(a.RespEventID ?? '') || !INT.test(a.EndTime ?? '') || (a.Duration != null && !INT.test(a.Duration))) {
      skipped++;
      continue;
    }
    events.push({ id: Number(a.RespEventID), end: Number(a.EndTime) / 10, duration: a.Duration != null ? Number(a.Duration) / 10 : 0 });
  }
  return { params, events, skipped };
}

/* ---------- settings ---------- */

const P = {
  SMART_MODE: 6, SMART_PRESSURE: 9, SMART_PRESSURE_MAX: 10, SMART_SOFTPAP: 13, SMART_SOFTSTART_TIME: 19,
  LINE_MODE: 1003, LINE_SOFT_PAP_LEVEL: 1123, LINE_SOFT_START_TIME: 1127, LINE_EXTRA_OBSTRUCTION_PROTECTION: 1154,
  LINE_IPAP_MAX: 1199, LINE_IPAP: 1200, LINE_EPAP: 1201,
};

function readSettings(params, note) {
  const s = {};
  const has = (id) => params.has(id);
  const cm = (key, id) => {
    if (has(id)) s[key] = params.get(id) / 100;
  };
  const int = (key, id) => {
    if (has(id)) s[key] = params.get(id);
  };

  if (has(P.SMART_MODE)) {
    const mode = params.get(P.SMART_MODE);
    if (mode === 1) {
      s.mode = 'cpap';
      cm('pressure', P.SMART_PRESSURE);
    } else if (mode === 2) {
      s.mode = 'auto-cpap';
      cm('pressureMin', P.SMART_PRESSURE);
      cm('pressureMax', P.SMART_PRESSURE_MAX);
    } else note(`A therapy mode the reader doesn’t know (${mode}): its settings weren’t read.`);
    int('flexLevel', P.SMART_SOFTPAP);
    int('rampMinutes', P.SMART_SOFTSTART_TIME);
  }

  if (has(P.LINE_MODE)) {
    const mode = params.get(P.LINE_MODE);
    const triLevel = params.get(P.LINE_EXTRA_OBSTRUCTION_PROTECTION) === 1;
    const partly = (name) => note(`${name} mode is only partly understood: its pressure settings weren’t read.`);
    if (mode === 1) {
      s.mode = 'cpap';
      cm('pressure', P.LINE_EPAP);
      int('flexLevel', P.LINE_SOFT_PAP_LEVEL);
    } else if (mode === 2) {
      s.mode = 'auto-cpap';
      cm('pressureMin', P.LINE_EPAP);
      cm('pressureMax', P.LINE_IPAP_MAX);
      int('flexLevel', P.LINE_SOFT_PAP_LEVEL);
    } else if (mode === 4) {
      s.mode = triLevel ? 'other' : 'auto-bilevel';
      cm('epap', P.LINE_EPAP);
      cm('ipap', P.LINE_IPAP);
    } else if (mode === 9) {
      s.mode = triLevel ? 'other' : 'auto-bilevel';
      partly('Auto S');
    } else if (mode === 10) {
      s.mode = 'other';
      partly('Auto S/T');
    } else if (mode === 3) {
      s.mode = 'asv';
      partly('AcSV');
    } else note(`A therapy mode the reader doesn’t know (${mode}): its settings weren’t read.`);
    if ([1, 2, 3, 4, 9, 10].includes(mode)) int('rampMinutes', P.LINE_SOFT_START_TIME);
  }
  return s;
}

/* ---------- events ---------- */

const EVENT_TYPES = {
  101: 'obstructive',
  102: 'central',
  103: 'apnea', // in a leak
  105: 'apnea', // at high pressure
  106: 'apnea', // with movement
  111: 'hypopnea', // obstructive
  112: 'hypopnea', // central
  121: 'rera',
  131: 'snore',
  151: 'flow-limitation',
  161: 'large-leak',
  181: 'periodic-breathing',
};

/* ---------- the signal file (WMEDF) ---------- */

const WANT = {
  pressure: ['Pressure'],
  epap: ['EPAP', 'EPAPsoll'],
  ipap: ['IPAP', 'IPAPsoll'],
  leak: ['LeakFlowBreath'],
};

/* OSCAR's EDFInfo::parseHeader + WMEDFInfo::ParseSignalData, for the signals we keep */
function readWmedf(buf, note) {
  const b = new Uint8Array(buf);
  if (b.length <= 256) throw new Error('too short for an EDF header');
  const field = (o, n) => latin1(b, o, n).trim();
  if (!INT.test(field(0, 8))) throw new Error('not an EDF file');
  const date = /^(\d\d)\.(\d\d)\.(\d\d)$/.exec(latin1(b, 168, 8));
  const time = /^(\d\d)\.(\d\d)\.(\d\d)$/.exec(latin1(b, 176, 8));
  if (!date || !time) throw new Error('no readable start time');
  const [d, mo, y] = date.slice(1).map(Number);
  const [hh, mi, ss] = time.slice(1).map(Number);
  const startMs = Date.UTC(2000 + y, mo - 1, d, hh, mi, ss); // OSCAR: two-digit years are 20xx
  const check = new Date(startMs);
  if (check.getUTCDate() !== d || check.getUTCMonth() !== mo - 1 || hh > 23 || mi > 59 || ss > 59) throw new Error('no readable start time');
  const headerBytes = Number(field(184, 8));
  const recordSec = Number(field(244, 8));
  const ns = Number(field(252, 4));
  if (!Number.isInteger(ns) || ns < 1 || ns > 256) throw new Error('bad signal count');
  if (headerBytes !== 256 + ns * 256 || b.length < headerBytes) throw new Error('header cut short or malformed');
  if (!(recordSec > 0)) throw new Error('bad record length');

  let o = 256;
  const list = (width, map = (v) => v) => {
    const r = Array.from({ length: ns }, (_, i) => map(field(o + i * width, width)));
    o += ns * width;
    return r;
  };
  const labels = list(16);
  o += ns * 80; // transducer
  list(8); // dimension
  const physMin = list(8, Number);
  const physMax = list(8, Number);
  const digMin = list(8, Number);
  const digMax = list(8, Number);
  o += ns * 80; // prefiltering
  const spr = list(8, (v) => parseInt(v, 10));
  const width = list(32, (v) => (v === '#1' ? 1 : v === '#2' ? 2 : 0));

  const recordBytes = spr.reduce((a, n, i) => a + (n > 0 ? n * width[i] : 0), 0);
  if (!(recordBytes > 0)) throw new Error('no readable signals');
  const nrec = Math.floor((b.length - headerBytes) / recordBytes);
  const offsets = [];
  let acc = 0;
  for (let i = 0; i < ns; i++) {
    offsets.push(acc);
    acc += spr[i] > 0 ? spr[i] * width[i] : 0;
  }

  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const signals = {};
  for (const [key, names] of Object.entries(WANT)) {
    const i = names.map((n) => labels.indexOf(n)).find((x) => x >= 0);
    if (i == null) continue;
    if (!width[i] || !(spr[i] > 0)) {
      note(`The ${labels[i]} signal is in a sample size the reader doesn’t know: not read.`);
      continue;
    }
    const gain = (physMax[i] - physMin[i]) / (digMax[i] - digMin[i]);
    // OSCAR reads digital × gain; EDF reads physMin + (digital − digMin) × gain.
    // Where those disagree it isn't clear which the machine means: skip.
    const offset = physMin[i] - digMin[i] * gain;
    if (!Number.isFinite(gain) || Math.abs(offset) > 1e-6 * Math.max(1, Math.abs(physMax[i]), Math.abs(physMin[i]))) {
      note(`The ${labels[i]} signal’s scale is ambiguous: not read.`);
      continue;
    }
    const values = new Float32Array(nrec * spr[i]);
    const signed8 = digMin[i] < 0;
    for (let r = 0; r < nrec; r++) {
      const at = headerBytes + r * recordBytes + offsets[i];
      for (let j = 0; j < spr[i]; j++) {
        const raw = width[i] === 2 ? dv.getInt16(at + j * 2, true) : signed8 ? dv.getInt8(at + j) : dv.getUint8(at + j);
        values[r * spr[i] + j] = raw * gain;
      }
    }
    signals[key] = { values, rate: spr[i] / recordSec };
  }
  return { start: startMs / 1000, duration: nrec * recordSec, signals };
}

/* one reading a minute: the mean of each signal's samples in it */
function toReadings(signals, duration) {
  const keys = Object.keys(signals);
  if (!keys.length || !(duration > 0)) return [];
  const n = Math.ceil(duration / 60);
  const sums = Object.fromEntries(keys.map((k) => [k, new Float64Array(n)]));
  const counts = Object.fromEntries(keys.map((k) => [k, new Uint32Array(n)]));
  for (const k of keys) {
    const { values, rate } = signals[k];
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (Number.isNaN(v)) continue;
      const bucket = Math.min(n - 1, Math.floor(i / rate / 60));
      sums[k][bucket] += v;
      counts[k][bucket]++;
    }
  }
  const round = (v) => Math.round(v * 100) / 100;
  const out = [];
  for (let m = 0; m < n; m++) {
    const at = Math.min((m + 1) * 60, duration);
    const r = { at, span: at - m * 60 };
    let any = false;
    for (const k of keys) {
      if (counts[k][m]) {
        r[k] = round(sums[k][m] / counts[k][m]);
        any = true;
      }
    }
    if (any) out.push(r);
  }
  return out;
}

/* ---------- one session ---------- */

function buildSession(id, eventBytes, signalBytes, warnings, note, hadEventFile) {
  const sig = readWmedf(signalBytes, note);
  let params = new Map();
  let raw = [];
  if (eventBytes) {
    try {
      const ev = readEventXml(eventBytes);
      params = ev.params;
      raw = ev.events;
      if (ev.skipped) warnings.push(`Session ${id}: ${ev.skipped} unreadable entries in its event file were skipped.`);
    } catch (err) {
      warnings.push(`Session ${id} event file: ${err.message}. No events or settings for it.`);
    }
  } else if (!hadEventFile) {
    warnings.push(`Session ${id} has no event file: no events or settings for it.`);
  }
  const events = raw
    .filter((e) => EVENT_TYPES[e.id])
    .map((e) => ({ type: EVENT_TYPES[e.id], at: Math.round((e.end - e.duration) * 10) / 10, duration: e.duration, countedByDevice: true }))
    .sort((a, b) => a.at - b.at);
  return {
    id,
    start: sig.start,
    end: sig.duration,
    maskOn: sig.duration > 0 ? [[0, sig.duration]] : [],
    settings: readSettings(params, note),
    deviceCounts: null,
    events,
    readings: toReadings(sig.signals, sig.duration),
    pressureChanges: [],
  };
}

/* ---------- the whole card ---------- */

/* the folder holding the config: the shallowest, then by name (OSCAR: the
 * folder given, else its first subfolder that has one) */
function findRoot(files, re) {
  const hits = files.filter((f) => re.test(f.path)).sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path));
  return hits[0] ?? null;
}

/* OSCAR's sscanf("%x") into an int, printed with "%010d" */
function serialFolder(sn) {
  if (typeof sn !== 'string' || !/^\s*(0x)?[0-9a-f]/i.test(sn)) return null;
  const v = parseInt(sn.trim(), 16);
  if (!(v >= 0 && v <= 0xffffffff)) return null;
  const n = v | 0;
  return n < 0 ? `-${String(-n).padStart(9, '0')}` : String(n).padStart(10, '0');
}

export async function readPrisma(files, { onProgress } = {}) {
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') }));
  if (!isPrisma(norm.map((f) => f.path))) throw new ReaderError('not-this-machine', 'No Löwenstein prisma card found.');

  const warnings = [];
  const notes = new Set(); // repeated per session: said once
  const note = (s) => notes.add(s);
  const device = { manufacturer: 'Löwenstein', model: 'prisma', modelNumber: null, serial: null, firmware: null };
  const pairs = new Map(); // session → { event, signal } as () => Promise<Uint8Array>
  let filesRead = 0;
  const pair = (id) => pairs.get(id) ?? pairs.set(id, {}).get(id);

  const smart = findRoot(norm, SMART_CONFIG);
  const line = findRoot(norm, LINE_CONFIG);
  // OSCAR prefers SMART when one folder has both
  const useSmart = smart && (!line || depth(smart.path) <= depth(line.path));

  if (useSmart) {
    const root = dirOf(smart.path);
    device.model = 'prisma SMART';
    let folder = null;
    try {
      const cfg = JSON.parse(decodeText(new Uint8Array(await smart.read())));
      const devid = typeof cfg?.devid === 'string' ? cfg.devid : null;
      device.modelNumber = devid;
      device.model = MODELS[devid] ?? 'prisma';
      device.serial = typeof cfg?.dev?.sn === 'string' ? cfg.dev.sn : null;
      folder = serialFolder(device.serial);
      if (devid && !MODELS[devid]) warnings.push(`A prisma model (${devid}) OSCAR hasn’t been tested on: its data may read wrongly.`);
    } catch {
      warnings.push('config.pscfg couldn’t be read: the machine’s details are missing.');
    }
    if (!folder) warnings.push('The therapy folder couldn’t be told from config.pscfg: read every folder on the card.');

    // <root><folder>/<day>/[<sub>/]event_<n>.xml | signal_<n>.wmedf
    const inData = norm
      .filter((f) => f.path.startsWith(root))
      .map((f) => ({ f, parts: f.path.slice(root.length).split('/') }))
      .filter(({ parts }) => (parts.length === 3 || parts.length === 4) && (!folder || parts[0] === folder));
    const daysWithSubs = new Set(inData.filter(({ parts }) => parts.length === 4).map(({ parts }) => parts.slice(0, 2).join('/')));
    const picked = inData
      .filter(({ parts }) => parts.length === 4 || !daysWithSubs.has(parts.slice(0, 2).join('/')))
      .sort((a, b) => a.f.path.localeCompare(b.f.path));
    if (folder && !picked.length && !norm.some((f) => f.path.startsWith(`${root}${folder}/`))) {
      warnings.push('The machine’s therapy folder isn’t on the card.');
    }
    for (const { f } of picked) {
      const name = nameOf(f.path).toLowerCase();
      const m = /^(event_(.*)\.xml|signal_(.*)\.wmedf)$/.exec(name);
      if (!m) continue;
      const sid = m[2] ?? m[3];
      if (!/^\d+$/.test(sid)) {
        warnings.push(`${nameOf(f.path)}: no session number in its name, not read.`);
        continue;
      }
      filesRead++;
      pair(Number(sid))[m[2] != null ? 'event' : 'signal'] = { name: nameOf(f.path), load: async () => new Uint8Array(await f.read()) };
    }
  } else {
    const root = dirOf(line.path);
    device.model = 'prisma LINE';
    try {
      const cfg = new Uint8Array(await line.read());
      const entry = zipEntries(cfg).find((e) => e.name === 'mnt/flash/conf/device.xml');
      if (!entry) throw new Error('no device.xml in it');
      const info = readDeviceXml(await zipExtract(cfg, entry));
      Object.assign(device, info);
      device.model = MODELS[info.modelNumber] ?? 'prisma';
      if (info.modelNumber && !MODELS[info.modelNumber]) {
        warnings.push(`A prisma model (${info.modelNumber}) OSCAR hasn’t been tested on: its data may read wrongly.`);
      }
    } catch (err) {
      warnings.push(`config.pcfg: ${err.message}. The machine’s details are missing.`);
    }

    const therapy = norm.find((f) => f.path.toLowerCase() === `${root}${LINE_THERAPY}`.toLowerCase());
    if (!therapy) warnings.push('therapy.pdat isn’t on the card: no sessions to read.');
    else {
      try {
        const zip = new Uint8Array(await therapy.read());
        for (const e of zipEntries(zip)) {
          const isEvent = e.name.includes('event_') && e.name.endsWith('.xml');
          const isSignal = e.name.includes('signal_') && e.name.endsWith('.wmedf');
          if (!isEvent && !isSignal) continue;
          const sid = e.name.slice(0, e.name.length - (isEvent ? 4 : 6)).slice(-6);
          const name = nameOf(e.name);
          if (!/^\d{6}$/.test(sid)) {
            warnings.push(`therapy.pdat › ${name}: no session number in its name, not read.`);
            continue;
          }
          filesRead++;
          pair(Number(sid))[isEvent ? 'event' : 'signal'] = { name, load: () => zipExtract(zip, e) };
        }
      } catch (err) {
        warnings.push(`therapy.pdat: ${err.message}. No sessions read.`);
      }
    }
  }

  const sessions = [];
  const ids = [...pairs.keys()].sort((a, b) => a - b);
  let done = 0;
  for (const id of ids) {
    const { event, signal } = pairs.get(id);
    if (!signal) {
      warnings.push(`Session ${id} has no signal file: skipped.`);
    } else {
      let eventBytes = null;
      if (event) {
        try {
          eventBytes = await event.load();
        } catch (err) {
          warnings.push(`${event.name}: ${err.message}. No events or settings for session ${id}.`);
        }
      }
      try {
        const s = buildSession(id, eventBytes, await signal.load(), warnings, note, !!event);
        if (s.end > 0) sessions.push(s);
        else warnings.push(`${signal.name}: no complete records, skipped.`);
      } catch (err) {
        warnings.push(`${signal.name}: ${err.message}. Session ${id} skipped.`);
      }
    }
    onProgress?.({ done: ++done, total: ids.length });
    if (done % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  sessions.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)));
  warnings.push(...notes);

  return { device, clock: 'device-local', sessions, filesRead, warnings };
}
