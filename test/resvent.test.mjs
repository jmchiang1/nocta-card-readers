// SPDX-License-Identifier: GPL-3.0-only
/* Tests for the Resvent reader, on synthetic cards written here from the
 * format as OSCAR's resvent_loader reads it (no real patient data). A card
 * generated from the same reading of the format only checks that the reader is
 * consistent with that reading, not that it matches a real machine. */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readResvent, isResvent, ReaderError } from '../src/resvent.js';

const SHIFT = 8 * 3600;
// the machine's wall clock (read as if UTC) → the seconds it writes
const cardSecs = (y, mo, d, h, mi, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000 - SHIFT;

/* a text file: 4 prefix bytes, then lines */
const text = (lines) => Buffer.concat([Buffer.from([0x01, 0x02, 0x03, 0x04]), Buffer.from(lines.join('\r\n') + '\r\n', 'latin1')]);
const kv = (o) => text(Object.entries(o).map(([k, v]) => `${k}=${v}`));

/* a P file: 0x24 header, 0x20 per channel, then chunks of int16 LE per channel */
function pFile(chunkSec, channels, chunks) {
  const spc = channels[0].spc;
  const head = Buffer.alloc(0x24 + channels.length * 0x20);
  head.writeUInt16LE(chunkSec, 0x10);
  head.writeUInt16LE(channels.length, 0x12);
  channels.forEach((c, i) => {
    head.write(c.name, 0x24 + i * 0x20, 'latin1');
    head.writeUInt16LE(c.spc, 0x24 + i * 0x20 + 0x1e);
  });
  const body = Buffer.alloc(chunks.length * channels.length * spc * 2);
  let o = 0;
  for (const chunk of chunks) for (const samples of chunk) for (const v of samples) o = body.writeInt16LE(v, o);
  return Buffer.concat([head, body]);
}

const P_CHANNELS = ['Press', 'IPAP', 'EPAP', 'Leak', 'Vt', 'MV', 'RR', 'Ti', 'I:E', 'SpO2', 'PR'].map((name) => ({ name, spc: 2 }));
/* one chunk (4 s, 2 samples per channel) with given pressure / leak */
const chunk = (press, leak) => [[press, press], [press, press], [press - 200, press - 200], [leak, leak + 10], [500, 510], [750, 760], [150, 160], [1200, 1200], [500, 500], [0, 0], [0, 0]];

/* every card written here is removed once the tests are done */
const made = [];
after(() => made.forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

function writeCard(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resvent-'));
  made.push(dir);
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
  return dir;
}

function cardFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else
        out.push({
          path: path.relative(dir, p).split(path.sep).join('/'),
          read: async () => {
            const b = fs.readFileSync(p);
            return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          },
        });
    }
  };
  walk(dir);
  return out;
}

const config = {
  'THERAPY/CONFIG/SYSCFG': kv({ models: 'iBreeze 20A', sn: 'TEST0000', num: 3 }),
  'THERAPY/CONFIG/TCTRL': kv({ VentMode: 3 }),
  'THERAPY/CONFIG/COMFORT': kv({ iPR: 2, RampTime: 20 }),
  'THERAPY/CONFIG/N_APAP': kv({ PMin: 600, PMax: 1450 }),
  'THERAPY/CONFIG/N_CPAP': kv({ Press: 1000 }),
  'THERAPY/CONFIG/VERSION': kv({ ver: '1.0' }),
};

const n1Start = cardSecs(2024, 1, 15, 22, 30);
const n2a = cardSecs(2024, 1, 16, 23, 0);
const n2b = cardSecs(2024, 1, 17, 1, 15);

function baseCard() {
  return {
    ...config,
    // night 1: one session, 7 h
    'THERAPY/RECORD/202401/15/STAT': kv({ cntAHI: 99 }), // the day's own summary: not a session
    'THERAPY/RECORD/202401/15/STAT01': kv({ secStart: n1Start, secUsed: 25200, cntAHI: 4, cntOAI: 2, cntCAI: 1, cntHI: 1, cntRERA: 1, cntSNI: 0 }),
    'THERAPY/RECORD/202401/15/EV01': text([
      `ID=17,DT=${n1Start + 3600},DR=12,GD=0,`,
      `ID=19,DT=${n1Start + 1800},DR=15,GD=0,`,
      `ID=18,DT=${n1Start + 7200},DR=10,GD=0,`,
      `ID=21,DT=${n1Start + 9000},DR=120,GD=0,`,
      `ID=17,DT=${n1Start + 12000},DR=20,GD=0,`,
      `ID=22,DT=${n1Start + 15000},DR=300,GD=0,`,
      `ID=99,DT=${n1Start + 16000},DR=5,GD=0,`, // not an event OSCAR knows
    ]),
    'THERAPY/RECORD/202401/15/P01_0': pFile(4, P_CHANNELS, [chunk(800, 240), chunk(850, 250)]),
    'THERAPY/RECORD/202401/15/P01_1': pFile(4, P_CHANNELS, [chunk(900, 300)]),
    'THERAPY/RECORD/202401/15/W01_0': Buffer.alloc(200), // waveforms: not read
    'THERAPY/RECORD/202401/15/ALM01': text(['x=1']),
    // night 2: a mask-off break → two sessions in one day folder
    'THERAPY/RECORD/202401/16/STAT01': kv({ secStart: n2a, secUsed: 4500, cntOAI: 0, cntCAI: 0, cntHI: 0, cntRERA: 0 }),
    'THERAPY/RECORD/202401/16/EV01': text([]),
    'THERAPY/RECORD/202401/16/STAT02': kv({ secStart: n2b, secUsed: 18000, cntOAI: 1, cntCAI: 0, cntHI: 0, cntRERA: 0 }),
    'THERAPY/RECORD/202401/16/EV02': text([`ID=17,DT=${n2b + 60},DR=11,GD=0,`]),
    'THERAPY/LOG/17/04124800': Buffer.from('2024/01/02 00:12:25 [STAT MAIN]: close record.\n'),
  };
}

test('detects a Resvent card and nothing else', () => {
  assert.equal(isResvent(Object.keys(baseCard())), true);
  assert.equal(isResvent(['THERAPY/CONFIG/SYSCFG']), true);
  assert.equal(isResvent(['DATALOG/20240115/x.edf', 'STR.edf', 'Identification.tgt']), false);
  assert.equal(isResvent(['THERAPY/RECORD/202401/15/STAT01']), false);
});

test('a normal night: session, mask time, events, readings, settings, counts', async () => {
  const dir = writeCard(baseCard());
  const r = await readResvent(cardFiles(dir));
  assert.equal(r.clock, 'device-local');
  assert.deepEqual(r.device, { manufacturer: 'Resvent', model: 'iBreeze 20A', modelNumber: null, serial: 'TEST0000', firmware: null });
  assert.equal(r.sessions.length, 3);

  const s = r.sessions[0];
  assert.equal(s.id, '20240115-01');
  assert.equal(s.start, Date.UTC(2024, 0, 15, 22, 30) / 1000);
  assert.equal(s.end, 25200);
  assert.deepEqual(s.maskOn, [[0, 25200]]);
  assert.deepEqual(s.settings, { mode: 'auto-cpap', pressureMin: 6, pressureMax: 14.5, flexLevel: 2 });
  assert.deepEqual(s.deviceCounts, { obstructive: 2, central: 1, hypopnea: 1, rera: 1 });
  assert.deepEqual(s.pressureChanges, []);

  assert.deepEqual(
    s.events.map((e) => [e.type, e.at, e.duration]),
    [
      ['hypopnea', 1800, 15],
      ['obstructive', 3600, 12],
      ['central', 7200, 10],
      ['rera', 9000, 0],
      ['obstructive', 12000, 20],
      ['periodic-breathing', 15000, 300],
    ]
  );
  assert.ok(s.events.every((e) => e.countedByDevice === true));

  // 3 chunks of 4 s, 2 samples each, across two files
  assert.equal(s.readings.length, 6);
  assert.deepEqual(s.readings.map((x) => x.at), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(s.readings[0], { at: 0, span: 2, pressure: 8, ipap: 8, epap: 6, leak: 24, tidalVolume: 500, minuteVent: 7.5, respRate: 15 });
  assert.equal(s.readings[3].leak, 26);
  assert.equal(s.readings[4].pressure, 9);
  assert.ok(!('spo2' in s.readings[0]) && !('pulse' in s.readings[0]));

  assert.equal(r.filesRead, 4 + 2 + 2); // STAT, EV, two P files; then STAT + EV twice
  assert.ok(r.notes.some((w) => /current settings/.test(w)));
  assert.ok(!r.warnings.some((w) => /TEST0000/.test(w)));
});

test('a mask-off break: two sessions on the same night', async () => {
  const r = await readResvent(cardFiles(writeCard(baseCard())));
  const [a, b] = r.sessions.slice(1);
  assert.equal(a.id, '20240116-01');
  assert.equal(b.id, '20240116-02');
  assert.equal(a.start, Date.UTC(2024, 0, 16, 23, 0) / 1000);
  assert.deepEqual(a.maskOn, [[0, 4500]]);
  assert.equal(b.start, Date.UTC(2024, 0, 17, 1, 15) / 1000);
  assert.ok(b.start - (a.start + a.end) === 3600); // an hour off
  assert.deepEqual(b.events, [{ type: 'obstructive', at: 60, duration: 11, countedByDevice: true }]);
  assert.deepEqual(a.readings, []);
});

test('damaged files: a warning each, the rest of the card still reads', async () => {
  const card = baseCard();
  card['THERAPY/RECORD/202401/16/STAT01'] = Buffer.from([0x00, 0x01]); // too short
  card['THERAPY/RECORD/202401/15/EV01'] = text([`ID=17,DT=${n1Start + 3600},DR=12,GD=0,`, 'ID=17,DT=garbage', `ID=19,DT=${n1Start - 500},DR=10,GD=0,`]);
  const good = pFile(4, P_CHANNELS, [chunk(800, 240)]);
  card['THERAPY/RECORD/202401/15/P01_0'] = good.subarray(0, good.length - 7); // cut mid-chunk
  const r = await readResvent(cardFiles(writeCard(card)));

  assert.deepEqual(r.sessions.map((s) => s.id), ['20240115-01', '20240116-02']);
  const s = r.sessions[0];
  assert.deepEqual(s.events.map((e) => e.type), ['obstructive']);
  // the cut chunk isn't read, but its 4 s still pass before the next file
  assert.deepEqual(s.readings.map((x) => x.at), [4, 6]);
  assert.equal(s.readings[0].pressure, 9);
  assert.ok(r.warnings.some((w) => /session 01: STAT01: file too short/.test(w)));
  assert.ok(r.warnings.some((w) => /1 event line\(s\) not read/.test(w)));
  assert.ok(r.warnings.some((w) => /outside the session/.test(w)));
  assert.ok(r.warnings.some((w) => /part-way through a chunk/.test(w)));
});

test('readings whose channels run at different rates are skipped, not guessed', async () => {
  const card = baseCard();
  const head = pFile(4, [{ name: 'Press', spc: 2 }, { name: 'Leak', spc: 1 }], []);
  card['THERAPY/RECORD/202401/15/P01_0'] = Buffer.concat([head, Buffer.alloc(12)]);
  delete card['THERAPY/RECORD/202401/15/P01_1'];
  const r = await readResvent(cardFiles(writeCard(card)));
  assert.deepEqual(r.sessions[0].readings, []);
  assert.ok(r.warnings.some((w) => /different rates/.test(w)));
});

test('CPAP and bilevel modes map as OSCAR files them', async () => {
  const card = { ...baseCard(), 'THERAPY/CONFIG/TCTRL': kv({ VentMode: 1 }) };
  let r = await readResvent(cardFiles(writeCard(card)));
  assert.deepEqual(r.sessions[0].settings, { mode: 'cpap', pressure: 10, flexLevel: 2 });

  const bi = { ...baseCard(), 'THERAPY/CONFIG/TCTRL': kv({ VentMode: 11 }), 'THERAPY/CONFIG/N_AS30': kv({ EPAPMin: 500, IPAPMax: 1800, PS: 400 }) };
  r = await readResvent(cardFiles(writeCard(bi)));
  assert.deepEqual(r.sessions[0].settings, { mode: 'auto-bilevel', epap: 5, ipap: 18, flexLevel: 2 });

  const odd = { ...baseCard(), 'THERAPY/CONFIG/TCTRL': kv({ VentMode: 42 }) };
  r = await readResvent(cardFiles(writeCard(odd)));
  assert.deepEqual(r.sessions[0].settings, { flexLevel: 2 });
  assert.ok(r.warnings.some((w) => /mode \(42\)/.test(w)));
});

test('a Hoffrichter model is named as such', async () => {
  const card = { ...baseCard(), 'THERAPY/CONFIG/SYSCFG': kv({ models: 'Point 3', sn: 'X' }) };
  const r = await readResvent(cardFiles(writeCard(card)));
  assert.equal(r.device.manufacturer, 'Hoffrichter');
});

test('an unrelated folder is not this machine', async () => {
  const dir = writeCard({ 'DATALOG/20240115/20240115_223000_EVE.edf': Buffer.alloc(300), 'STR.edf': Buffer.alloc(300), 'notes.txt': Buffer.from('hi') });
  await assert.rejects(readResvent(cardFiles(dir)), (err) => err instanceof ReaderError && err.code === 'not-this-machine');
});
