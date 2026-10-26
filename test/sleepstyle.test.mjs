// SPDX-License-Identifier: GPL-3.0-only
/* Tests for the Fisher & Paykel SleepStyle reader, on synthetic cards built
 * here from the format as OSCAR's sleepstyle_loader reads it (no real patient
 * data). Because the generator and the reader come from the same reading of
 * the format, these tests check the reader is self-consistent and robust, not
 * that the reading of the format is right: that needs a real card. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readSleepStyle, isSleepStyle, ReaderError } from '../src/sleepstyle.js';

const SERIAL = '210999000111'; // made up
const DIR = `FPHCARE/ICON/${SERIAL}`;

/* ---------- the generator ---------- */

/* the machine's packed date; the reader's start is this as if UTC, minus 54 s */
const pack = (y, mo, d, h, mi, s) => ((d | (mo << 5) | ((y - 2000) << 9) | (s << 15) | (mi << 21) | (h << 27)) >>> 0);
const startOf = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - 54;

function header(fname, { model = 'SLEEPSTYLE', type = 'SPSAAN', terminator = true } = {}) {
  const b = new Uint8Array(0x200).fill(0x20);
  const text = ['FPHCARE', '0103', fname, SERIAL, model, type, '0005'].join('\r') + '\r';
  for (let i = 0; i < text.length; i++) b[i] = text.charCodeAt(i);
  if (terminator) b[0x1ff] = 0x3b;
  return b;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

/* one 40-byte summary record */
function sumRecord({ ts, useTime, minSeen = 50, pct95Seen = 90, maxSeen = 110, cpapSet = 80, minSet = 50, maxSet = 150, epr = 0, ramp = 0 }) {
  const b = new Uint8Array(0x28);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, ts, true);
  b[0x04] = useTime; // run time
  b[0x05] = useTime;
  b[0x06] = minSeen;
  b[0x07] = pct95Seen;
  b[0x08] = maxSeen;
  b[0x19] = ramp;
  b[0x1c] = cpapSet;
  b[0x1d] = minSet;
  b[0x1e] = maxSet;
  b[0x1f] = 30; // SensAwake
  b[0x20] = 3; // humidity
  b[0x21] = epr;
  b[0x22] = 0x04;
  return b;
}

const END = Uint8Array.from([0xff, 0xff, 0xff, 0xff]);
const sumFile = (records, opts) => concat(header('SUM0001.FPH', opts), ...records.map(sumRecord), END);

/* detail: sessions [{ ts, blocks: [{ pressure, flags: [a1..a5] }] }] laid end to end */
function detFile(sessions, opts) {
  const index = new Uint8Array(0x800).fill(0xff);
  const idv = new DataView(index.buffer);
  const data = [];
  let first = 0;
  sessions.forEach((s, i) => {
    const records = Math.ceil(s.blocks.length / 3);
    idv.setUint32(i * 9, s.ts, true);
    idv.setUint16(i * 9 + 4, s.first ?? first, true);
    index[i * 9 + 6] = s.records ?? records;
    idv.setUint16(i * 9 + 7, 0, true);
    for (let k = 0; k < records * 3; k++) {
      const blk = s.blocks[k] ?? { pressure: 0, flags: [] };
      const f = blk.flags ?? [];
      data.push(Uint8Array.from([blk.pressure, 25, f[0] ?? 0, f[1] ?? 0, f[2] ?? 0, f[3] ?? 0, f[4] ?? 0]));
    }
    first += records;
  });
  return concat(header('DET0001.FPH', opts), index, ...data);
}

/* a plain EDF: Flow (25/s), Pressure (1/s), Leak (1/s, L/min), 1-second records */
function edfFile({ y, mo, d, h, mi, s, seconds, leakAt }) {
  const sigs = [
    { label: 'Flow', dim: 'L/min', pmin: -200, pmax: 200, dmin: -2000, dmax: 2000, spr: 25, v: () => 0 },
    { label: 'Pressure', dim: 'cmH2O', pmin: 0, pmax: 25, dmin: 0, dmax: 250, spr: 1, v: () => 80 },
    { label: 'Leak', dim: 'L/min', pmin: 0, pmax: 200, dmin: 0, dmax: 2000, spr: 1, v: (t) => Math.round(leakAt(t) * 10) },
  ];
  const ns = sigs.length;
  const hdr = new Uint8Array(256 + ns * 256).fill(0x20);
  let o = 0;
  const put = (str, w) => {
    for (let i = 0; i < Math.min(str.length, w); i++) hdr[o + i] = str.charCodeAt(i);
    o += w;
  };
  const p2 = (n) => String(n).padStart(2, '0');
  put('0', 8);
  put('X X X X', 80);
  put(`Startdate X X X X ${SERIAL}`, 80);
  put(`${p2(d)}.${p2(mo)}.${p2(y % 100)}`, 8);
  put(`${p2(h)}.${p2(mi)}.${p2(s)}`, 8);
  put(String(256 + ns * 256), 8);
  put('', 44);
  put(String(seconds), 8);
  put('1', 8);
  put(String(ns), 4);
  for (const g of sigs) put(g.label, 16);
  for (const g of sigs) put('', 80);
  for (const g of sigs) put(g.dim, 8);
  for (const g of sigs) put(String(g.pmin), 8);
  for (const g of sigs) put(String(g.pmax), 8);
  for (const g of sigs) put(String(g.dmin), 8);
  for (const g of sigs) put(String(g.dmax), 8);
  for (const g of sigs) put('', 80);
  for (const g of sigs) put(String(g.spr), 8);
  for (const g of sigs) put('', 32);
  const rec = sigs.reduce((n, g) => n + g.spr * 2, 0);
  const body = new Uint8Array(rec * seconds);
  const dv = new DataView(body.buffer);
  for (let t = 0; t < seconds; t++) {
    let at = t * rec;
    for (const g of sigs) for (let j = 0; j < g.spr; j++, at += 2) dv.setInt16(at, g.v(t), true);
  }
  return concat(hdr, body);
}

/* every card written here is removed once the tests are done */
const made = [];
after(() => Promise.all(made.map((dir) => fs.rm(dir, { recursive: true, force: true }))));

/* write the card under os.tmpdir() and hand back the reader's file list */
async function card(entries) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sleepstyle-'));
  made.push(root);
  for (const [rel, bytes] of Object.entries(entries)) {
    const full = path.join(root, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, bytes);
  }
  const files = [];
  const walk = async (dir) => {
    for (const e of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else {
        const rel = path.relative(root, full).split(path.sep).join('/');
        files.push({
          path: rel,
          read: async () => {
            const b = await fs.readFile(full);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
        });
      }
    }
  };
  await walk(root);
  return files;
}

/* ---------- tests ---------- */

test('a normal night: session, mask-on time, events, readings, settings', async () => {
  const ts = pack(2025, 3, 1, 22, 30, 0);
  const blocks = Array.from({ length: 225 }, (_, k) => ({ pressure: 80 + (k % 10), flags: [] }));
  blocks[0].flags = [0b1 | 0xc0]; // obstructive, slot 0 (+ top bits OSCAR doesn't read)
  blocks[2].flags = [0, 0b1000]; // central, slot 3
  blocks[5].flags = [0, 0, 0b100000 | 0x40, 0b10]; // hypopnea slot 5 (+ a SensAwake bit), hypopnea slot 1
  blocks[10].flags = [0, 0, 0, 0, 0b100]; // flow limitation, slot 2
  const files = await card({
    [`${DIR}/SUM0001.FPH`]: sumFile([{ ts, useTime: 75, minSeen: 60, pct95Seen: 110, maxSeen: 130, minSet: 50, maxSet: 150, epr: 2, ramp: 1 }]),
    [`${DIR}/DET0001.FPH`]: detFile([{ ts, blocks }]),
    // the real-time file starts 30 s after the machine's start time; leak steps by two-minute window
    [`${DIR}/REALTIME/HRD00001.EDF`]: edfFile({ y: 2025, mo: 3, d: 1, h: 22, mi: 30, s: 30, seconds: 600, leakAt: (t) => 10 + Math.floor((84 + t) / 120) * 5 }),
    [`${DIR}/HIS0001.FPH`]: new Uint8Array(16),
  });
  assert.ok(isSleepStyle(files.map((f) => f.path)));

  let progress = 0;
  const r = await readSleepStyle(files, { onProgress: () => progress++ });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.clock, 'device-local');
  assert.equal(r.filesRead, 3);
  assert.equal(progress, 3);
  assert.deepEqual(r.device, { manufacturer: 'Fisher & Paykel', model: 'SleepStyle Auto', modelNumber: 'SPSAAN', serial: SERIAL, firmware: null });

  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.start, startOf(2025, 3, 1, 22, 30, 0));
  assert.equal(s.end, 27000);
  assert.deepEqual(s.maskOn, [[0, 27000]]);
  assert.deepEqual(s.settings, { mode: 'auto-cpap', pressureMin: 5, pressureMax: 15, flexLevel: 2 });
  assert.equal(s.deviceCounts, null);
  assert.deepEqual(s.pressureChanges, []);

  // slot start + 60 s, as OSCAR places them
  assert.deepEqual(
    s.events.map((e) => [e.type, e.at]),
    [
      ['obstructive', 60],
      ['central', 360],
      ['hypopnea', 680],
      ['hypopnea', 760],
      ['flow-limitation', 1300],
    ]
  );
  assert.ok(s.events.every((e) => e.duration === 0 && e.countedByDevice === true));

  assert.equal(s.readings.length, 225);
  assert.deepEqual(s.readings[0], { at: 120, span: 120, pressure: 8, totalLeak: 10 });
  assert.deepEqual(s.readings[1], { at: 240, span: 120, pressure: 8.1, totalLeak: 15 });
  assert.deepEqual(s.readings[5], { at: 720, span: 120, pressure: 8.5, totalLeak: 35 });
  assert.deepEqual(s.readings[6], { at: 840, span: 120, pressure: 8.6 });
  assert.equal(s.readings[224].at, 27000);
});

test('a night with a break: two sessions, each with its own detail; CPAP mode', async () => {
  const ts1 = pack(2025, 3, 2, 22, 0, 0);
  const ts2 = pack(2025, 3, 2, 23, 30, 0);
  const b1 = Array.from({ length: 30 }, () => ({ pressure: 100 }));
  b1[1] = { pressure: 100, flags: [0, 0b1] }; // central, slot 0 of block 1
  const b2 = Array.from({ length: 180 }, () => ({ pressure: 100 }));
  b2[0] = { pressure: 100, flags: [0b1] }; // obstructive, slot 0
  const cpap = { minSeen: 100, pct95Seen: 100, maxSeen: 100, cpapSet: 100, epr: 0 };
  const files = await card({
    [`${DIR}/SUM0001.FPH`]: sumFile([{ ts: ts1, useTime: 10, ...cpap }, { ts: ts2, useTime: 60, ...cpap }], { type: 'SPSCAN' }),
    [`${DIR}/DET0001.FPH`]: detFile([{ ts: ts1, blocks: b1 }, { ts: ts2, blocks: b2 }]),
  });
  const r = await readSleepStyle(files);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.device.model, 'SleepStyle CPAP');
  assert.equal(r.sessions.length, 2);
  const [a, b] = r.sessions;
  assert.equal(b.start - a.start, 5400);
  assert.equal(b.start - (a.start + a.end), 1800); // the break
  assert.deepEqual(a.maskOn, [[0, 3600]]);
  assert.deepEqual(b.maskOn, [[0, 21600]]);
  assert.deepEqual(a.settings, { mode: 'cpap', pressure: 10, flexLevel: 0 });
  assert.deepEqual(a.events.map((e) => [e.type, e.at]), [['central', 180]]);
  assert.deepEqual(b.events.map((e) => [e.type, e.at]), [['obstructive', 60]]);
  assert.equal(a.readings.length, 30);
  assert.equal(b.readings.length, 180);
});

test('damaged files: a warning each, the rest of the card still reads', async () => {
  const ts = pack(2025, 3, 3, 23, 0, 0);
  const tsLost = pack(2025, 3, 4, 23, 0, 0);
  const second = sumFile([{ ts: tsLost, useTime: 70 }]).subarray(0, 0x200 + 20); // cut mid-record
  const files = await card({
    [`${DIR}/SUM0001.FPH`]: sumFile([{ ts, useTime: 80 }, { ts: 0, useTime: 5 }]), // a blank date
    [`${DIR}/SUM0002.FPH`]: second,
    [`${DIR}/SUM0003.FPH`]: new Uint8Array(100), // too short
    [`${DIR}/DET0001.FPH`]: detFile([{ ts, blocks: [{ pressure: 90, flags: [1] }] }], { terminator: false }),
    [`${DIR}/DET0002.FPH`]: detFile([{ ts, first: 0, records: 50, blocks: [{ pressure: 95, flags: [0, 1] }] }]), // index runs past the data
    [`${DIR}/REALTIME/HRD00001.EDF`]: Uint8Array.from({ length: 300 }, (_, i) => i & 0xff), // not an EDF
  });
  const r = await readSleepStyle(files);
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.start, startOf(2025, 3, 3, 23, 0, 0));
  assert.deepEqual(s.maskOn, [[0, 28800]]);
  // DET0001 is skipped; DET0002 gives what it holds
  assert.deepEqual(s.events.map((e) => [e.type, e.at]), [['central', 60]]);
  assert.equal(s.readings.length, 3);

  const w = r.warnings.join('\n');
  assert.match(w, /SUM0001\.FPH: 1 session record with an unreadable date/);
  assert.match(w, /SUM0002\.FPH: ends partway/);
  assert.match(w, /SUM0003\.FPH: too short/);
  assert.match(w, /DET0001\.FPH: header/);
  assert.match(w, /DET0002\.FPH: .*runs past the end/);
  assert.match(w, /HRD00001\.EDF: /);
  assert.ok(!w.includes(SERIAL), 'no serial numbers in warnings');
});

test('an unrelated folder, or an ICON card: not-this-machine', async () => {
  const resmed = await card({ 'DATALOG/20250301/20250301_220000_BRP.edf': new Uint8Array(10), 'STR.edf': new Uint8Array(10) });
  assert.equal(isSleepStyle(resmed.map((f) => f.path)), false);
  await assert.rejects(readSleepStyle(resmed), (e) => e instanceof ReaderError && e.code === 'not-this-machine');

  const icon = await card({ [`${DIR}/SUM0001.FPH`]: sumFile([{ ts: pack(2025, 3, 1, 22, 0, 0), useTime: 10 }], { model: 'ICON' }) });
  assert.equal(isSleepStyle(icon.map((f) => f.path)), true); // same layout
  await assert.rejects(readSleepStyle(icon), (e) => e instanceof ReaderError && e.code === 'not-this-machine');
});
