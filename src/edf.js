// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — an EDF / EDF+ reader. Pure JS on an ArrayBuffer, so it
 * runs in the browser and in Node.
 *
 * Copyright (C) 2026 Nocta. Licensed under the GNU General Public License,
 * version 3 (see LICENSE). Distributed WITHOUT ANY WARRANTY.
 *
 * EDF layout: a 256-byte fixed header, 256 bytes per signal, then `nrec` data
 * records; each record holds `spr[i]` little-endian int16 samples per signal.
 * physical = physMin + (digital - digMin) * (physMax - physMin) / (digMax - digMin)
 *
 *  - a digital -1 means "no data" on signals whose digital range starts at 0
 *    (ResMed: SpO2 with no oximeter, a leak gap). Those come back as NaN.
 *  - EDF+ annotation signals ("EDF Annotations") come back as TALs:
 *    ("+onset\x15duration\x14text\x14\0").
 *  - header times are the machine's local wall clock: kept as-is, as ms
 *    read as if UTC. */

export class EdfError extends Error {}

const ascii = (u8, o, n) => {
  let s = '';
  for (let i = o; i < o + n && i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s.trim();
};

/* 'dd.mm.yy' + 'hh.mm.ss' → naive local timestamp in ms (UTC arithmetic, no TZ).
 * EDF's two-digit year: 85–99 → 19xx, 00–84 → 20xx. */
function parseStart(date, time) {
  const [d, m, y] = date.split('.').map(Number);
  const [hh, mm, ss] = time.split(/[.:]/).map(Number);
  if ([d, m, y, hh, mm, ss].some((v) => Number.isNaN(v))) throw new EdfError(`bad start ${date} ${time}`);
  return Date.UTC(y >= 85 ? 1900 + y : 2000 + y, m - 1, d, hh, mm, ss);
}

export function readEdfHeader(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 256) throw new EdfError('file too short for an EDF header');
  const headerBytes = parseInt(ascii(u8, 184, 8), 10);
  const ns = parseInt(ascii(u8, 252, 4), 10);
  if (!(ns > 0) || headerBytes !== 256 + ns * 256 || u8.length < headerBytes) {
    throw new EdfError('not an EDF file');
  }
  const field = (base, width) =>
    Array.from({ length: ns }, (_, i) => ascii(u8, base + i * width, width));
  let o = 256;
  const labels = field(o, 16); o += 16 * ns;
  o += 80 * ns; // transducer
  const dims = field(o, 8); o += 8 * ns;
  const physMin = field(o, 8).map(Number); o += 8 * ns;
  const physMax = field(o, 8).map(Number); o += 8 * ns;
  const digMin = field(o, 8).map(Number); o += 8 * ns;
  const digMax = field(o, 8).map(Number); o += 8 * ns;
  o += 80 * ns; // prefiltering
  const spr = field(o, 8).map((v) => parseInt(v, 10));

  const recordBytes = spr.reduce((a, n) => a + n * 2, 0);
  const declared = parseInt(ascii(u8, 236, 8), 10);
  const available = recordBytes ? Math.floor((u8.length - headerBytes) / recordBytes) : 0;
  // a card pulled mid-write leaves a short file (or nrec = -1): read what's there
  const nrec = declared >= 0 && declared <= available ? declared : available;

  return {
    reserved: ascii(u8, 192, 44), // 'EDF' or 'EDF+D'
    recording: ascii(u8, 88, 80), // "Startdate … SRN=<serial> …"
    start: parseStart(ascii(u8, 168, 8), ascii(u8, 176, 8)),
    headerBytes,
    nrec,
    truncated: nrec !== declared,
    recordSec: Number(ascii(u8, 244, 8)),
    signals: labels.map((label, i) => ({
      label,
      dim: dims[i],
      physMin: physMin[i],
      physMax: physMax[i],
      digMin: digMin[i],
      digMax: digMax[i],
      spr: spr[i],
    })),
    recordBytes,
  };
}

/* Read the named signals as Float32Arrays of physical values (NaN = no data),
 * plus every annotation if the file has them.
 * opts.signals: labels to decode (default: all except annotations / Crc16). */
export function readEdf(buf, opts = {}) {
  const h = readEdfHeader(buf);
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer);
  const base = buf instanceof ArrayBuffer ? 0 : buf.byteOffset;
  const want = opts.signals ? new Set(opts.signals) : null;

  // byte offset of each signal inside a record
  const offsets = [];
  let acc = 0;
  for (const s of h.signals) {
    offsets.push(acc);
    acc += s.spr * 2;
  }

  const signals = {};
  const annotations = [];
  h.signals.forEach((s, i) => {
    if (s.label === 'Crc16') return;
    if (s.label === 'EDF Annotations') {
      for (let r = 0; r < h.nrec; r++) {
        const at = base + h.headerBytes + r * h.recordBytes + offsets[i];
        annotations.push(...parseTals(new Uint8Array(dv.buffer, at, s.spr * 2)));
      }
      return;
    }
    if (want && !want.has(s.label)) return;
    const out = new Float32Array(h.nrec * s.spr);
    const k = (s.physMax - s.physMin) / (s.digMax - s.digMin || 1);
    const minusOneIsGap = s.digMin >= 0;
    for (let r = 0; r < h.nrec; r++) {
      const at = base + h.headerBytes + r * h.recordBytes + offsets[i];
      for (let j = 0; j < s.spr; j++) {
        const d = dv.getInt16(at + j * 2, true);
        out[r * s.spr + j] = d === -1 && minusOneIsGap ? NaN : s.physMin + (d - s.digMin) * k;
      }
    }
    signals[s.label] = { values: out, rate: s.spr / h.recordSec, dim: s.dim };
  });

  return { ...h, signals, annotations };
}

/* EDF+ Time-stamped Annotation Lists inside one record's annotation bytes:
 * "+onset[\x15duration]\x14text\x14[text\x14…]\0". The first TAL of each
 * record is a timekeeping entry with no text — skipped. */
function parseTals(bytes) {
  const out = [];
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  for (const tal of s.split('\0')) {
    if (!tal) continue;
    const parts = tal.split('\x14');
    const [onset, duration] = parts[0].split('\x15');
    const on = Number(onset);
    if (Number.isNaN(on)) continue;
    for (const text of parts.slice(1)) {
      if (text) out.push({ onset: on, duration: duration ? Number(duration) : 0, text });
    }
  }
  return out;
}
