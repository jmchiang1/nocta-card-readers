// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — the chunk framing every Philips Respironics (PRS1)
 * machine writes: DreamStation, DreamStation 2, and the System One and BiPAP
 * families to come.
 *
 * Copyright (C) 2026 Nocta. Written from the format notes of the
 * `dreamstation` project (https://github.com/mattjoyce/dreamstation,
 * docs/FORMAT.md, Apache License 2.0) and OpenCPAP (docs/formats/ds2.md,
 * GPL-3.0). Licensed under the GNU General Public License, version 3 (see
 * LICENSE). Distributed WITHOUT ANY WARRANTY.
 *
 * A file is a run of chunks. Each: a 15-byte header (format version 3, block
 * size, header type 0, family, family version, file number, session number,
 * start time), a table of (record code, record size), an 8-bit header sum,
 * the records, and a CRC-32 over them (MSB first, poly 0x04C11DB7, init
 * 0xFFFFFFFF, no final inversion, each byte fed as the word 00 00 00 bb). */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crcWords(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    for (let z = 0; z < 3; z++) crc = (CRC_TABLE[(crc >>> 24) & 0xff] ^ (crc << 8)) >>> 0;
    crc = (CRC_TABLE[(data[i] ^ (crc >>> 24)) & 0xff] ^ (crc << 8)) >>> 0;
  }
  return crc >>> 0;
}

export const u16 = (b, i = 0) => b[i] | (b[i + 1] << 8);

/* a file's bytes → its chunks, each checked:
 * { family, familyVersion, fileNumber, session, timestamp, sizes, data } */
export function parseChunks(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const chunks = [];
  let pos = 0;
  while (pos < u8.length) {
    if (u8.length - pos < 15) throw new Error(`trailing ${u8.length - pos} bytes`);
    const version = u8[pos];
    const size = dv.getUint16(pos + 1, true);
    const headerType = u8[pos + 3];
    if (version !== 3) throw new Error(`chunk format version ${version}`);
    if (headerType !== 0) throw new Error(`header type ${headerType}`);
    if (size < 21 || pos + size > u8.length) throw new Error(`block size ${size} doesn't fit`);
    const count = u8[pos + 15];
    const hbEnd = pos + 16 + 2 * count;
    if (hbEnd >= pos + size - 4) throw new Error('header block runs past the chunk');
    const sizes = new Map();
    for (let i = pos + 16; i < hbEnd; i += 2) sizes.set(u8[i], u8[i + 1]);
    let sum = 0;
    for (let i = pos; i < hbEnd; i++) sum += u8[i];
    if ((sum & 0xff) !== u8[hbEnd]) throw new Error('header checksum mismatch');
    const data = u8.subarray(hbEnd + 1, pos + size - 4);
    if (crcWords(data) !== dv.getUint32(pos + size - 4, true)) throw new Error('data CRC mismatch');
    chunks.push({
      family: u8[pos + 4],
      familyVersion: u8[pos + 5],
      fileNumber: u8[pos + 6],
      session: dv.getUint32(pos + 7, true),
      timestamp: dv.getUint32(pos + 11, true),
      sizes,
      data,
    });
    pos += size;
  }
  return chunks;
}

/* chunks from several files, by session number: the first copy of each kept,
 * byte-identical repeats ignored, a different second copy reported */
export function collectChunks(table, chunk, warnings) {
  const prior = table.get(chunk.session);
  if (!prior) table.set(chunk.session, chunk);
  else if (prior.timestamp !== chunk.timestamp || prior.data.length !== chunk.data.length || prior.data.some((b, j) => b !== chunk.data[j])) {
    warnings.push(`Session ${chunk.session.toString(16)}: two different copies; kept the first.`);
  }
}
