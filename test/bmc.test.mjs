// SPDX-License-Identifier: GPL-3.0-only
/* Tests for src/bmc.js on synthetic cards written here from the format as
 * OSCAR reads it (never real patient data). A generator built from the same
 * reading of the format can only check the reader is consistent with that
 * reading, not that the reading matches a real machine.
 * Copyright (C) 2026 Nocta. GPL-3.0. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { readBmc, isBmc, ReaderError } from '../src/bmc.js';

const SPAN = 64 * 1024 * 1024;
const SERIAL = 'TST0000000042';
const at = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;
const parts = (t) => {
  const d = new Date(t * 1000);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()];
};
const put16 = (b, o, v) => b.writeUInt16LE(v & 0xffff, o);
const put32 = (b, o, v) => b.writeUInt32LE(v >>> 0, o);

async function filesOf(dir) {
  const out = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else
        out.push({
          path: relative(dir, full).split('\\').join('/'),
          read: async () => {
            const b = await readFile(full);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
          // as the browser's files do; NO_RANGE=1 tests the whole-file path
          ...(process.env.NO_RANGE
            ? {}
            : {
                readRange: async (a, z) => {
                  const b = await readFile(full);
                  return b.buffer.slice(b.byteOffset + Math.min(a, b.length), b.byteOffset + Math.min(z, b.length));
                },
              }),
        });
    }
  };
  await walk(dir);
  return out;
}

/* ---------- G3X ---------- */

/* one 2048-byte packet a second */
function g3xPacket(t, { breathing, leak = 25, pressure = 850, rr = 15 }) {
  const p = Buffer.alloc(0x800);
  p[0] = 0xad;
  p[1] = 0xaa;
  const [y, mo, d, h, mi, s] = parts(t);
  p.set([y - 1900, mo, d, h, mi, s], 4);
  for (let i = 0; i < 100; i++) p.writeInt16LE(breathing ? Math.round(300 * Math.sin((i / 100) * Math.PI * 2)) : 5, 0x56e + i * 2);
  put16(p, 0x52a, leak); // leak beyond the vent (firmware G3-2.11)
  put16(p, 0x568, 100); // the other leak field
  put16(p, 0x530, rr);
  put16(p, 0x76c, pressure);
  put16(p, 0x76e, pressure);
  return p;
}

/* one 32-byte .evt record */
function evtRecord(t, type, v2 = 0, v3 = 0) {
  const r = Buffer.alloc(0x20);
  r[0] = 0xae;
  r[1] = 0xaa;
  r[0x10] = type;
  const whole = Math.floor(t);
  const [y, mo, d, h, mi, s] = parts(whole);
  r.set([y - 1900, mo, d, h, mi, s], 0x14);
  put16(r, 0x1a, Math.round((t - whole) * 1000));
  put16(r, 0x1c, v2);
  put16(r, 0x1e, v3);
  return r;
}

/* nights: [{ date: [y, m, d], file, runs: [{ from, seconds, breathingFor }], evt: [[t, type, v2, v3]], ts }] */
async function g3xCard(dir, nights, { corrupt = [], firmware = 'G3-2.11.02.33' } = {}) {
  const idx = Buffer.alloc(0x800 + nights.length * 0x800);
  idx.write('BMC G/E/P INDEX', 0, 'latin1');
  idx.write(SERIAL, 0x30, 'latin1');
  idx.write('110A40113', 0x48, 'latin1');
  idx.write('G3 A20', 0x100, 'latin1');
  idx.write('G3-2.SC.72.01', 0x345, 'latin1');
  put32(idx, 0xd4, SPAN);
  put32(idx, 0xd8, 63);
  const evtParts = [];
  let evtLen = 0;
  for (const [n, night] of nights.entries()) {
    const packets = [];
    for (const run of night.runs)
      for (let i = 0; i < run.seconds; i++) packets.push(g3xPacket(run.from + i, { breathing: i < (run.breathingFor ?? run.seconds) }));
    let wave = Buffer.concat(packets);
    if (corrupt.includes(night.file)) wave = Buffer.alloc(wave.length, 0x5a);
    await writeFile(join(dir, `${SERIAL}.${String(night.file).padStart(3, '0')}`), wave);
    const evt = Buffer.concat(night.evt.map((e) => evtRecord(...e)));
    evtParts.push(evt);
    const off = 0x800 + n * 0x800;
    put16(idx, off, 0xaaaa);
    idx.set([night.date[0] - 1900, night.date[1], night.date[2]], off + 8);
    put32(idx, off + 0x10, night.file * SPAN);
    put32(idx, off + 0x14, night.file * SPAN + wave.length);
    put32(idx, off + 0x18, wave.length);
    put32(idx, off + 0x1c, evtLen);
    put32(idx, off + 0x20, evtLen + evt.length);
    put32(idx, off + 0x24, evt.length);
    evtLen += evt.length;
    const ts = off + 0x280; // the night's settings: AutoCPAP 6–12, ramp 15 min, Reslex 2
    idx.write('TS', ts, 'latin1');
    idx[ts + 0x08] = 1;
    put16(idx, ts + 0x0e, 600);
    put16(idx, ts + 0x10, 1200);
    idx[ts + 0x82] = 15;
    idx[ts + 0x86] = 2;
  }
  await writeFile(join(dir, `${SERIAL}.idx`), idx);
  await writeFile(join(dir, `${SERIAL}.evt`), Buffer.concat(evtParts));
  const log = Buffer.alloc(0x600, 0xff);
  log.write(firmware, 0x420, 'latin1');
  await writeFile(join(dir, `${SERIAL}.log`), log);
}

const N1 = at(2026, 3, 10, 23, 0); // night 1: one 30-minute session
const N2 = at(2026, 3, 11, 22, 30); // night 2: 20 min, the machine off 10 min, 15 min (last 6 without breathing)

const nightOne = {
  date: [2026, 3, 10],
  file: 0,
  runs: [{ from: N1, seconds: 1800 }],
  evt: [
    [N1, 0x40],
    [N1 + 0.004, 0x42, 800, 800],
    [N1 + 30, 0x42, 800, 800],
    [N1 + 60, 0x42, 850, 850],
    [N1 + 300.25, 0x03, 15000], // obstructive apnea
    [N1 + 600, 0x01, 12000], // hypopnea
    [N1 + 700, 0x07, 11000], // obstructive hypopnea
    [N1 + 900, 0x04, 4000], // central apnea, 4 s → held to 10
    [N1 + 1000, 0x0a, 9000], // rera, 9 s → held to 10
    [N1 + 1100, 0x0e, 1500], // mild flow limitation
    [N1 + 1200, 0x09, 90000 & 0xffff, 90000 >>> 16], // periodic breathing, 90 s
    [N1 + 1300, 0x0c], // a breath: not read
    [N1 + 1800, 0x41],
  ],
};
const nightTwo = {
  date: [2026, 3, 11],
  file: 1,
  runs: [
    { from: N2, seconds: 1200 },
    { from: N2 + 1800, seconds: 900, breathingFor: 540 },
  ],
  evt: [
    [N2, 0x40],
    [N2 + 120, 0x03, 20000],
    [N2 + 1200, 0x41],
    [N2 + 1500, 0x02, 11000], // while the machine was off
    [N2 + 1800, 0x40],
    [N2 + 1900, 0x04, 12000],
    [N2 + 2700, 0x41],
  ],
};

async function tempCard(make) {
  const dir = await mkdtemp(join(tmpdir(), 'nocta-bmc-'));
  await make(dir);
  return dir;
}

test('G3X: a normal night', async () => {
  const dir = await tempCard((d) => g3xCard(d, [nightOne, nightTwo]));
  try {
    const files = await filesOf(dir);
    assert.ok(isBmc(files.map((f) => f.path)));
    const progress = [];
    const out = await readBmc(files, { onProgress: (p) => progress.push(p) });
    assert.equal(out.clock, 'device-local');
    assert.deepEqual(out.device, { manufacturer: 'BMC', model: 'G3 A20', modelNumber: '110A40113', serial: SERIAL, firmware: 'G3-2.11.02.33' });
    assert.deepEqual(progress.at(-1), { done: 2, total: 2 });
    assert.equal(out.filesRead, 4); // .idx, .evt, .000, .001

    const s = out.sessions[0];
    assert.equal(s.start, N1);
    assert.equal(s.end, 1800);
    assert.deepEqual(s.maskOn, [[0, 1800]]);
    assert.deepEqual(s.settings, { mode: 'auto-cpap', pressureMin: 6, pressureMax: 12, rampMinutes: 15, flexLevel: 2 });
    assert.equal(s.deviceCounts, null);
    assert.deepEqual(
      s.events.map((e) => [e.type, e.at, e.duration]),
      [
        ['obstructive', 300.25, 15],
        ['hypopnea', 600, 12],
        ['hypopnea', 700, 11],
        ['central', 900, 10],
        ['rera', 1000, 10],
        ['flow-limitation', 1100, 1.5],
        ['periodic-breathing', 1200, 90],
      ]
    );
    assert.ok(s.events.every((e) => e.countedByDevice === true));
    assert.deepEqual(s.pressureChanges, [
      { at: 0, pressure: 8 },
      { at: 60, pressure: 8.5 },
    ]);
    // one reading a minute, on the clock's minute
    assert.equal(s.readings.length, 30);
    assert.deepEqual(s.readings[0], { at: 60, span: 60, pressure: 8.5, leak: 4, respRate: 15 });
    assert.deepEqual(s.readings.at(-1), { at: 1800, span: 60, pressure: 8.5, leak: 4, respRate: 15 });
    assert.ok(!out.warnings.some((w) => w.includes(SERIAL)));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('G3X: a night with the machine off for a while and the mask off before the end', async () => {
  const dir = await tempCard((d) => g3xCard(d, [nightOne, nightTwo]));
  try {
    const out = await readBmc(await filesOf(dir));
    const night = out.sessions.filter((s) => s.start >= N2);
    assert.equal(night.length, 2);
    assert.equal(night[0].start, N2);
    assert.equal(night[0].end, 1200);
    assert.deepEqual(night[0].maskOn, [[0, 1200]]);
    assert.deepEqual(night[0].events.map((e) => [e.type, e.at]), [['obstructive', 120]]);
    assert.equal(night[1].start, N2 + 1800);
    assert.equal(night[1].end, 900);
    // last breath at 539 s, then 6 minutes without: the mask came off
    assert.deepEqual(night[1].maskOn, [[0, 539]]);
    assert.deepEqual(night[1].events.map((e) => [e.type, e.at]), [['central', 100]]);
    // the apnea logged while the machine was off isn't placed
    assert.ok(out.warnings.some((w) => /1 event fell outside/.test(w)));
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('G3X: a damaged recording file → a warning, the night read from the event log, the rest intact', async () => {
  const dir = await tempCard((d) => g3xCard(d, [nightOne, nightTwo], { corrupt: [1] }));
  try {
    const out = await readBmc(await filesOf(dir));
    assert.ok(out.warnings.some((w) => w.startsWith('2026-03-11') && /event log alone/.test(w)));
    const first = out.sessions[0];
    assert.equal(first.start, N1);
    assert.equal(first.readings.length, 30);
    assert.equal(first.events.length, 7);
    // night 2 from its start / stop marks: no per-second readings, mask on the whole time
    const night = out.sessions.filter((s) => s.start >= N2);
    assert.deepEqual(
      night.map((s) => [s.start, s.end, s.maskOn, s.readings.length, s.events.length]),
      [
        [N2, 1200, [[0, 1200]], 0, 1],
        [N2 + 1800, 900, [[0, 900]], 0, 1],
      ]
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('G3X: a missing event log → a warning, the per-second data still reads', async () => {
  const dir = await tempCard(async (d) => {
    await g3xCard(d, [nightOne]);
    await writeFile(join(d, `${SERIAL}.evt`), Buffer.alloc(0));
  });
  try {
    const files = (await filesOf(dir)).map((f) => (f.path.endsWith('.evt') ? { ...f, read: async () => { throw new Error('io'); } } : f));
    const out = await readBmc(files);
    assert.ok(out.warnings.some((w) => /event log/.test(w)));
    assert.equal(out.sessions.length, 1);
    assert.equal(out.sessions[0].readings.length, 30);
    assert.deepEqual(out.sessions[0].events, []);
  } finally {
    await rm(dir, { recursive: true });
  }
});

test('G3X: firmware G3-2.12 → the leak field with the vent included (totalLeak)', async () => {
  const dir = await tempCard((d) => g3xCard(d, [nightOne], { firmware: 'G3-2.12.54.13' }));
  try {
    const out = await readBmc(await filesOf(dir));
    assert.equal(out.device.firmware, 'G3-2.12.54.13');
    assert.deepEqual(out.sessions[0].readings[0], { at: 60, span: 60, pressure: 8.5, totalLeak: 16, respRate: 15 });
  } finally {
    await rm(dir, { recursive: true });
  }
});

/* ---------- legacy RESmart / Luna ---------- */

const L1 = at(2026, 2, 1, 23, 0);

async function legacyCard(dir) {
  const base = 'LEGACY0001';
  // the machine's log: one day's record after the header area
  const rec = [];
  rec.push(Buffer.from([0xe1, 0, 0, 0, 0, 0, 0]));
  const head = Buffer.alloc(0x45 - 7);
  rec.push(head);
  const items = Buffer.alloc(10);
  items[0] = 0x01; // one item, then the 0xFF end mark
  items[5] = 0xff;
  rec.push(items);
  const group = (type, count, size, bytes) => {
    const g = Buffer.alloc(5 + count * size);
    g[0] = type;
    put16(g, 1, count);
    Buffer.from(bytes).copy(g, 5);
    return g;
  };
  rec.push(group(0x82, 1, 4, [1, 2, 3, 4]));
  rec.push(group(0x83, 1, 3, [11, 10, 20])); // obstructive, 11 h 10 min after noon (23:10), 20 s
  rec.push(group(0x84, 2, 3, [11, 20, 12, 13, 0, 14])); // hypopneas at 23:20 and 01:00 (after the session)
  rec.push(group(0x87, 1, 3, [12, 5, 10])); // central at 00:05
  rec.push(group(0x10, 2, 2, [0, 0, 0, 0]));
  const record = Buffer.concat(rec);
  put32(record, 1, 0x102340 + record.length); // next record: the end of the file
  put16(record, 7, (26 << 9) | (2 << 5) | 1); // 2026-02-01
  put16(record, 0x0f, 90);
  const usr = Buffer.alloc(0x102340 + record.length);
  usr.write('LGCYSERIAL9', 0x2d, 'latin1');
  usr.write('RESmart GII', 0x2296, 'latin1');
  put16(usr, 0x431, 0xffff); // no record in progress
  record.copy(usr, 0x102340);
  await writeFile(join(dir, `${base}.USR`), usr);

  // settings, dated the day after (OSCAR picks the first record after the night)
  const idx = Buffer.alloc(0x800 + 0x200);
  const r = 0x800;
  put16(idx, r, 0xaaaa);
  idx.set([26, 2, 2], r + 4);
  idx[r + 0x141] = 20; // 10 cmH2O
  idx[r + 0x142] = 10; // ramp
  idx[r + 0x148] = 1; // Reslex 1
  idx[r + 0x14d] = 0 << 4; // CPAP
  await writeFile(join(dir, `${base}.idx`), idx);

  // 90 minutes of packets
  const packets = [];
  for (let i = 0; i < 5400; i++) {
    const p = Buffer.alloc(0x100);
    put16(p, 0, 0xaaaa);
    p.writeInt16LE(20, 0x04);
    p.writeInt16LE(20, 0x06);
    p.writeInt16LE(52, 0xc4);
    p.writeInt16LE(450, 0xc6);
    p.writeInt16LE(68, 0xca);
    p.writeInt16LE(95, 0xcc);
    p.writeInt16LE(60, 0xce);
    put16(p, 0xd0, 14);
    const [y, mo, d, h, mi, s] = parts(L1 + i);
    put16(p, 0xf8, y);
    p.set([mo, d, h, mi, s], 0xfa); // 0xFF stays 0: a 0xAA there would read as OSCAR's shifted layout
    packets.push(p);
  }
  await writeFile(join(dir, `${base}.000`), Buffer.concat(packets));
}

test('legacy RESmart: a normal night', async () => {
  const dir = await tempCard(async (d) => {
    await mkdir(join(d, 'BMC'));
    await legacyCard(join(d, 'BMC'));
  });
  try {
    const files = await filesOf(dir);
    assert.ok(isBmc(files.map((f) => f.path)));
    const out = await readBmc(files);
    assert.deepEqual(out.device, { manufacturer: 'BMC', model: 'RESmart GII', modelNumber: null, serial: 'LGCYSERIAL9', firmware: null });
    assert.equal(out.sessions.length, 1);
    const s = out.sessions[0];
    assert.equal(s.start, L1);
    assert.equal(s.end, 5400);
    assert.deepEqual(s.maskOn, [[0, 5400]]);
    assert.deepEqual(s.settings, { mode: 'cpap', pressure: 10, rampMinutes: 10, flexLevel: 1 });
    assert.deepEqual(
      s.events.map((e) => [e.type, e.at, e.duration]),
      [
        ['obstructive', 600, 20],
        ['hypopnea', 1200, 12],
        ['central', 3900, 10],
      ]
    );
    assert.equal(s.readings.length, 90);
    assert.deepEqual(s.readings[0], { at: 60, span: 60, pressure: 10, leak: 5.2, tidalVolume: 450, minuteVent: 6.8, respRate: 14, spo2: 95, pulse: 60 });
    assert.ok(out.warnings.some((w) => /1 event fell outside/.test(w)));
    assert.ok(!out.warnings.some((w) => w.includes('LGCYSERIAL9')));
  } finally {
    await rm(dir, { recursive: true });
  }
});

/* ---------- not this machine ---------- */

test('an unrelated folder → not-this-machine', async () => {
  const dir = await tempCard(async (d) => {
    await mkdir(join(d, 'DATALOG', '20260310'), { recursive: true });
    await writeFile(join(d, 'STR.edf'), Buffer.alloc(512));
    await writeFile(join(d, 'DATALOG', '20260310', '20260310_230000_BRP.edf'), Buffer.alloc(512));
    await writeFile(join(d, 'notes.idx'), Buffer.from('an index of something else'));
    await writeFile(join(d, 'notes.evt'), Buffer.alloc(64));
  });
  try {
    const files = await filesOf(dir);
    await assert.rejects(readBmc(files), (err) => err instanceof ReaderError && err.code === 'not-this-machine');
    assert.equal(isBmc(files.filter((f) => !f.path.startsWith('notes')).map((f) => f.path)), false);
  } finally {
    await rm(dir, { recursive: true });
  }
});
