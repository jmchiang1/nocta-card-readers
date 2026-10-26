// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — Philips DreamStation 2 SD cards → plain therapy sessions.
 *
 * Copyright (C) 2026 the OpenCPAP authors (https://github.com/cdelcollado/OpenCPAP)
 * Copyright (C) 2019-2026 The OSCAR Team; (C) 2011-2018 Mark Watkins
 * Copyright (C) 2026 Nocta
 *
 * This program is free software: you can redistribute it and/or modify it
 * under the terms of the GNU General Public License, version 3, as published
 * by the Free Software Foundation. It is distributed in the hope that it will
 * be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See LICENSE.
 *
 * Adapted from OpenCPAP's DreamStation 2 loader (packages/loaders/philips-ds2,
 * commit d2a68d9be9a98630d8af91b49e900f1aa3c34bc6: container.ts, summary.ts,
 * events.ts, device.ts) and its format note (docs/formats/ds2.md), which are
 * adapted from OSCAR's PRS1 loader. Changes: plain JavaScript; decryption on
 * the browser's WebCrypto instead of @noble/ciphers; a plain session result.
 *
 * The card: P-SERIES/<device>/PROP.BIN (model, serial) and
 * P-SERIES/<device>/P<n>/<session>.B01 (summary) / .B02 (events), each file
 * wrapped in AES-256-GCM. The keys are public (OSCAR's "Patient access to
 * their own data"). Inside is the PRS1 chunk framing (prs1.js). The flow
 * waveform (.B05) isn't read.
 *
 * readDreamStation2(files) → {
 *   device:   { manufacturer, model, modelNumber, serial, firmware }
 *   clock:    'device-local' (times are the machine's own wall clock, no zone)
 *   sessions: [{
 *     id, start          seconds, the machine's clock read as if UTC
 *     end                seconds from start (the machine switched off)
 *     maskOn             [[from, to]] seconds from start
 *     settings           { mode: 'cpap' | 'bilevel' | 'auto-cpap' | 'auto-bilevel' | 'cpap-check',
 *                          pressure, pressureMin, pressureMax, epap, ipap,
 *                          rampMinutes, flexLevel }   cmH2O; absent when not set
 *     deviceCounts       the machine's own { obstructive, central, hypopnea, rera,
 *                        flowLimitation }, or null
 *     events             [{ type, at, duration, countedByDevice }]  seconds from start
 *                        type: obstructive | central | hypopnea | rera |
 *                        flow-limitation | snore | large-leak | periodic-breathing |
 *                        variable-breathing
 *     readings           [{ at, span: 120, totalLeak (L/min), pressure (cmH2O), snoreCount }]
 *                        about every two minutes, each covering the two before
 *     pressureChanges    [{ at, pressure }]  the pressures the machine set
 *   }]
 *   warnings: [string]   what couldn't be read
 * }
 * files: [{ path, read: () => Promise<ArrayBuffer> }]. Throws ReaderError
 * 'not-this-machine' when there's no DreamStation 2 card in them. */
import { parseChunks, collectChunks, u16 } from './prs1.js';
import { ReaderError } from './errors.js';

export { ReaderError };

const ROOT = /(?:^|\/)P-Series\/([^/]+)\//i;
const PROP_BIN = /(?:^|\/)P-Series\/([^/]+)\/PROP\.BIN$/i;
const SESSION_FILE = /(?:^|\/)P-Series\/([^/]+)\/P\d+\/([0-9A-F]{8})\.B0([12])$/i;

/* a DreamStation 2 card: its encrypted properties or session files */
export const isDreamStation2 = (paths) => paths.some((p) => PROP_BIN.test(p) || SESSION_FILE.test(p));

/* ---------- the encrypted container ---------- */

const HEADER_SIZE = 0xca;
/* AES-256-ECB-decrypt(key "Patient access to their own data", OSCAR's
 * COMMON_KEY 75 b3 a2 12 4a 65 af 97 54 d8 c1 f3 e5 2e b6 f0 23 20 57 69 7e 38
 * 0e c9 4a dc 46 45 b6 92 5a 98), worked out once: WebCrypto has no ECB */
const COMMON_KEY = Uint8Array.from([
  0x71, 0x84, 0x96, 0x44, 0xa7, 0x28, 0x11, 0x2b, 0x01, 0x5b, 0x62, 0x03, 0xcf, 0xb5, 0xc5, 0x69,
  0x51, 0xdb, 0x5f, 0x18, 0xe3, 0xf4, 0x94, 0x36, 0xfa, 0x4a, 0x0b, 0xeb, 0x75, 0x65, 0x87, 0x42,
]);

function readHeader(b) {
  let pos = 0;
  const word = () => {
    if (pos + 2 > b.length) throw new Error('truncated header');
    const v = b[pos] | (b[pos + 1] << 8);
    pos += 2;
    return v;
  };
  const field = () => {
    const n = word();
    if (pos + n > b.length) throw new Error('truncated header');
    const r = b.subarray(pos, pos + n);
    pos += n;
    return r;
  };
  if (word() !== 0x0d || word() !== 1 || word() !== 1) throw new Error('not a DreamStation 2 file');
  field(); // the device's GUID: not kept
  const iv = field();
  const salt = field();
  if (iv.length !== 12 || salt.length !== 16) throw new Error('unexpected key sizes');
  word();
  word();
  field(); // import key and its tag: a device-specific key, not used
  field();
  const exportKey = field();
  const exportKeyTag = field();
  const payloadTag = field();
  if (pos !== HEADER_SIZE) throw new Error(`header of ${pos} bytes`);
  return { iv, salt, exportKey, exportKeyTag, payloadTag };
}

const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

let commonKey = null;
const payloadKeys = new Map(); // the same keys repeat across a card's files
async function payloadKey(h) {
  const id = hex(join(h.iv, h.salt, h.exportKey, h.exportKeyTag));
  if (!payloadKeys.has(id)) {
    const subtle = globalThis.crypto.subtle;
    commonKey ??= await subtle.importKey('raw', COMMON_KEY, 'PBKDF2', false, ['deriveBits']);
    const salted = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: h.salt, iterations: 10000 }, commonKey, 256);
    const saltedKey = await subtle.importKey('raw', salted, 'AES-GCM', false, ['decrypt']);
    const raw = await subtle.decrypt({ name: 'AES-GCM', iv: h.iv }, saltedKey, join(h.exportKey, h.exportKeyTag));
    payloadKeys.set(id, await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']));
  }
  return payloadKeys.get(id);
}

/* a file's bytes → its plaintext; throws if a key or tag doesn't check out */
async function decrypt(buf) {
  const b = new Uint8Array(buf);
  const h = readHeader(b);
  const key = await payloadKey(h);
  try {
    return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv: h.iv }, key, join(b.subarray(HEADER_SIZE), h.payloadTag)));
  } catch {
    throw new Error('didn’t decrypt (damaged, or a firmware not seen before)');
  }
}

/* ---------- the device ---------- */

/* model numbers OSCAR knows for the DreamStation 2 */
const MODELS = {
  '410X150C': 'DreamStation 2 CPAP',
  '420X150C': 'DreamStation 2 Advanced CPAP',
  '520X110C': 'DreamStation 2 Auto CPAP Advanced',
  '520X130C': 'DreamStation 2 Auto CPAP Advanced',
  '520X150C': 'DreamStation 2 Auto CPAP Advanced',
  '521X120C': 'DreamStation 2 Auto CPAP Advanced',
  '521X140C': 'DreamStation 2 Auto CPAP Advanced',
};

const properties = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .filter((l) => l.indexOf('=') > 0)
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
  );

/* ---------- settings (summary record 0x01) ---------- */

const MODES = ['cpap', 'bilevel', 'auto-cpap', 'auto-bilevel', 'cpap-check'];

function readSettings(b) {
  const s = {};
  let pos = 0;
  while (pos + 2 <= b.length) {
    const code = b[pos];
    const len = b[pos + 1];
    pos += 2;
    if (len < 1 || pos + len > b.length) break;
    const v = b.subarray(pos, pos + len);
    pos += len;
    if (code === 0x00 && MODES[v[0]]) s.mode = MODES[v[0]];
    else if (code === 0x0a) s.pressure = v[0] / 10;
    else if (code === 0x0c && len >= 3) Object.assign(s, { pressureMin: v[0] / 10, pressureMax: v[1] / 10, pressure: v[2] / 10 });
    else if (code === 0x0d && len >= 2) Object.assign(s, { pressureMin: v[0] / 10, pressureMax: v[1] / 10 });
    else if (code === 0x0e && len >= 2) Object.assign(s, { epap: v[0] / 10, ipap: v[1] / 10 });
    else if (code === 0x0f && len >= 2) Object.assign(s, { epap: v[0] / 10, ipap: v[1] / 10 }); // EPAP min, IPAP max
    else if (code === 0x10 && len >= 3) Object.assign(s, { pressureMin: v[1] / 10, pressureMax: v[2] / 10 });
    else if (code === 0x2c) s.rampMinutes = v[0];
    else if (code === 0x30) s.flexLevel = v[0];
    // the rest (humidifier, tubing, lock flags, ones not yet understood) aren't read
  }
  return s;
}

/* ---------- the summary file (.B01) ---------- */

function readSummary(chunk) {
  const d = chunk.data;
  let settings = {};
  let deviceCounts = null;
  const marks = []; // [seconds, 'on' | 'off' | 'end']
  let tt = 0;
  let pos = 0;
  while (pos < d.length) {
    const code = d[pos++];
    const size = chunk.sizes.get(code);
    if (size == null || pos + size > d.length) break; // malformed: keep what's read
    if (code === 0x01) settings = readSettings(d.subarray(pos, pos + size));
    else if ((code === 0x02 || code === 0x03 || code === 0x04) && size >= 2) {
      tt += u16(d, pos);
      marks.push([tt, code === 0x03 ? 'on' : code === 0x04 ? 'off' : 'end']);
    } else if ((code === 0x09 || code === 0x0a || code === 0x0b) && size >= 2) tt += u16(d, pos); // time passing, no change
    else if (code === 0x08 && size >= 0x18) {
      // the machine's own counts, one record per mask-on stretch
      deviceCounts ??= { obstructive: 0, central: 0, hypopnea: 0, rera: 0, flowLimitation: 0 };
      deviceCounts.obstructive += u16(d, pos + 2);
      deviceCounts.central += u16(d, pos + 6);
      deviceCounts.hypopnea += u16(d, pos + 16);
      deviceCounts.rera += u16(d, pos + 20);
      deviceCounts.flowLimitation += u16(d, pos + 22);
    }
    pos += size;
  }
  // a mask-on stretch runs to the next mark
  const maskOn = [];
  marks.forEach(([t, kind], i) => {
    const end = i + 1 < marks.length ? marks[i + 1][0] : tt;
    if (kind === 'on' && end > t) maskOn.push([t, end]);
  });
  return { settings, deviceCounts, maskOn, end: tt };
}

/* ---------- the events file (.B02) ---------- */

/* flagged after the fact: a byte says how many seconds ago */
const FLAG = { 0x05: 'rera', 0x06: 'obstructive', 0x07: 'central', 0x0a: 'hypopnea', 0x14: 'hypopnea', 0x15: 'hypopnea', 0x0c: 'flow-limitation' };
const SPAN = { 0x0e: 'variable-breathing', 0x0f: 'periodic-breathing', 0x10: 'large-leak' };

function readEvents(chunk) {
  const d = chunk.data;
  const events = [];
  const readings = [];
  const pressureChanges = [];
  let t = 0;
  let pos = 0;
  while (pos < d.length) {
    const code = d[pos++];
    const size = chunk.sizes.get(code);
    if (size == null || pos + size > d.length) break;
    const next = pos + size;
    let p = pos;
    if (code !== 0x12) {
      // every record but 0x12 (snores at a pressure) starts with the seconds since the last
      if (size < 2) break;
      t += u16(d, p);
      p += 2;
    }
    const byte = (i) => (p + i < next ? d[p + i] : 0);
    if (code in FLAG) events.push({ type: FLAG[code], at: t - byte(0), duration: 0, countedByDevice: true });
    // a rarer hypopnea record, not in the machine's own count
    else if (code === 0x0b) events.push({ type: 'hypopnea', at: t - byte(1), duration: 0, countedByDevice: false });
    else if (code === 0x0d) events.push({ type: 'snore', at: t, duration: 0, countedByDevice: true });
    else if (code in SPAN) {
      const duration = 2 * (byte(0) | (byte(1) << 8));
      if (duration > 0) events.push({ type: SPAN[code], at: t - byte(2) - duration, duration, countedByDevice: true });
    } else if (code === 0x01) pressureChanges.push({ at: t, pressure: byte(0) / 10 });
    else if (code === 0x11) readings.push({ at: t, span: 120, totalLeak: byte(0), snoreCount: byte(1), pressure: byte(2) / 10 });
    pos = next;
  }
  return { events, readings, pressureChanges };
}

/* ---------- the whole card ---------- */

export async function readDreamStation2(files, { onProgress } = {}) {
  const warnings = [];
  const norm = files.map((f) => ({ ...f, path: f.path.replace(/\\/g, '/') }));
  if (!isDreamStation2(norm.map((f) => f.path))) throw new ReaderError('not-this-machine', 'No DreamStation 2 card found.');

  // the machine folder with the most sessions (a card can hold more than one)
  const byDevice = new Map();
  for (const f of norm) {
    const m = SESSION_FILE.exec(f.path);
    if (m) byDevice.set(m[1], [...(byDevice.get(m[1]) ?? []), f]);
  }
  const busiest = [...byDevice].sort((a, b) => b[1].length - a[1].length)[0];
  const folder = busiest?.[0] ?? ROOT.exec(norm.find((f) => ROOT.test(f.path))?.path ?? '')?.[1];
  const sessionFiles = busiest?.[1] ?? [];
  if (byDevice.size > 1) warnings.push(`The card holds ${byDevice.size} machines; read the one with the most sessions.`);

  const device = { manufacturer: 'Philips Respironics', model: 'DreamStation 2', modelNumber: null, serial: null, firmware: null };
  const propFile = norm.find((f) => PROP_BIN.test(f.path) && PROP_BIN.exec(f.path)[1] === folder);
  if (propFile) {
    try {
      const prop = properties(new TextDecoder('utf-8').decode(await decrypt(await propFile.read())));
      device.modelNumber = prop.MN || null;
      device.model = MODELS[prop.MN] ?? (prop.MN ? `DreamStation 2 (${prop.MN})` : 'DreamStation 2');
      device.serial = prop.SN || null;
      device.firmware = prop.SV || null;
    } catch (err) {
      warnings.push(`PROP.BIN: ${err.message}`);
    }
  }

  // every chunk, by session number
  const summaries = new Map();
  const eventChunks = new Map();
  const total = sessionFiles.filter((f) => /\.B01$/i.test(f.path)).length;
  let done = 0;
  for (let i = 0; i < sessionFiles.length; i++) {
    const f = sessionFiles[i];
    try {
      for (const c of parseChunks(await decrypt(await f.read()))) {
        if (c.family !== 0 || c.familyVersion !== 6) throw new Error(`family ${c.family}.${c.familyVersion}`);
        if (c.fileNumber === 1) collectChunks(summaries, c, warnings);
        else if (c.fileNumber === 2) collectChunks(eventChunks, c, warnings);
      }
    } catch (err) {
      warnings.push(`${f.path.split('/').pop()}: ${err.message}`);
    }
    if (/\.B01$/i.test(f.path)) onProgress?.({ done: ++done, total });
    if (i % 20 === 19) await new Promise((r) => setTimeout(r, 0));
  }

  // a session without its summary has no mask times or settings: skipped
  const sessions = [];
  for (const [id, sc] of [...summaries].sort((a, b) => a[1].timestamp - b[1].timestamp)) {
    try {
      const sum = readSummary(sc);
      const ec = eventChunks.get(id);
      // the events chunk shares the summary's start; shift if it ever doesn't
      const shift = ec ? ec.timestamp - sc.timestamp : 0;
      const ev = ec ? readEvents(ec) : { events: [], readings: [], pressureChanges: [] };
      const moved = (list) => (shift ? list.map((x) => ({ ...x, at: x.at + shift })) : list);
      sessions.push({
        id,
        start: sc.timestamp,
        end: sum.end,
        maskOn: sum.maskOn,
        settings: sum.settings,
        deviceCounts: sum.deviceCounts,
        events: moved(ev.events),
        readings: moved(ev.readings),
        pressureChanges: moved(ev.pressureChanges),
      });
    } catch (err) {
      warnings.push(`Session ${id.toString(16)}: ${err.message}`);
    }
  }

  return { device, clock: 'device-local', sessions, filesRead: sessionFiles.length, warnings };
}
