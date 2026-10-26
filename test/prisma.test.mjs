// SPDX-License-Identifier: GPL-3.0-only
/* Tests for the Löwenstein prisma reader, on synthetic cards built here from
 * the format as OSCAR's prisma_loader reads it (no real patient data). Because
 * the generator and the reader come from the same reading of the format, these
 * tests check the reader is self-consistent and robust, not that the reading
 * of the format is right: that needs a real card. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { readPrisma, isPrisma, ReaderError } from '../src/prisma.js';

/* ---------- the generator ---------- */

const pad = (s, n) => String(s).slice(0, n).padEnd(n, ' ');
const two = (n) => String(n).padStart(2, '0');

/* a WMEDF file. signals: [{ label, width: 1 | 2, digMin, digMax, physMin, physMax, spr, value(t) }]
 * value(t): the physical value at t seconds; stored as round(value / gain) */
function wmedf({ start, recordSec = 10, nrec, signals, extraBytes = 0 }) {
  const ns = signals.length;
  const [y, mo, d, h, mi, s] = start;
  let head = '0'.padEnd(8) + pad('X', 80) + pad('Startdate X', 80);
  head += `${two(d)}.${two(mo)}.${two(y % 100)}${two(h)}.${two(mi)}.${two(s)}`;
  head += pad(256 + ns * 256, 8) + pad('', 44) + pad(nrec, 8) + pad(recordSec, 8) + pad(ns, 4);
  const col = (f, n) => signals.map((sg) => pad(f(sg), n)).join('');
  head += col((sg) => sg.label, 16) + col(() => '', 80) + col((sg) => sg.dim ?? '', 8);
  head += col((sg) => sg.physMin, 8) + col((sg) => sg.physMax, 8) + col((sg) => sg.digMin, 8) + col((sg) => sg.digMax, 8);
  head += col(() => '', 80) + col((sg) => sg.spr, 8) + col((sg) => `#${sg.width}`, 32);
  const recordBytes = signals.reduce((a, sg) => a + sg.spr * sg.width, 0);
  const out = new Uint8Array(head.length + nrec * recordBytes + extraBytes);
  for (let i = 0; i < head.length; i++) out[i] = head.charCodeAt(i);
  const dv = new DataView(out.buffer);
  let o = head.length;
  for (let r = 0; r < nrec; r++) {
    for (const sg of signals) {
      const gain = (sg.physMax - sg.physMin) / (sg.digMax - sg.digMin);
      for (let j = 0; j < sg.spr; j++) {
        const raw = Math.round(sg.value(r * recordSec + (j * recordSec) / sg.spr) / gain);
        if (sg.width === 2) dv.setInt16(o, raw, true);
        else if (sg.digMin < 0) dv.setInt8(o, raw);
        else dv.setUint8(o, raw);
        o += sg.width;
      }
    }
  }
  return out;
}

/* the usual signals: pressure 8.5, EPAP 6.5 (8-bit unsigned), IPAP 9 (16-bit),
 * leak = the minute number (8-bit signed), flow (not read) */
const SIGNALS = (smart = true) => [
  { label: 'Pressure', width: 2, digMin: 0, digMax: 4000, physMin: 0, physMax: 40, spr: 10, value: () => 8.5 },
  { label: smart ? 'EPAP' : 'EPAPsoll', width: 1, digMin: 0, digMax: 255, physMin: 0, physMax: 25.5, spr: 5, value: () => 6.5 },
  { label: smart ? 'IPAP' : 'IPAPsoll', width: 2, digMin: 0, digMax: 4000, physMin: 0, physMax: 40, spr: 5, value: () => 9 },
  { label: 'LeakFlowBreath', width: 1, digMin: -128, digMax: 127, physMin: -128, physMax: 127, spr: 10, value: (t) => Math.floor(t / 60) },
  { label: 'RespFlow', width: 2, digMin: -32768, digMax: 32767, physMin: -32768, physMax: 32767, spr: 100, value: (t) => Math.round(1000 * Math.sin(t)) },
];

/* event_<n>.xml: params { id: value } (DeviceEventID 0), events [{ id, end, duration }] in seconds */
function eventXml({ params = {}, events = [], changes = [] }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<TherapyData>'];
  for (const [id, v] of Object.entries(params)) lines.push(`  <DeviceEvent DeviceEventID="0" ParameterID="${id}" NewValue="${v}" Time="0"/>`);
  for (const c of changes) lines.push(`  <DeviceEvent DeviceEventID="1" ParameterID="${c.id}" NewValue="${c.value}" Time="${c.at * 10}"/>`);
  for (const e of events) {
    lines.push(`  <RespEvent RespEventID="${e.id}" EndTime="${Math.round(e.end * 10)}" Duration="${Math.round(e.duration * 10)}" Pressure="850" Strength="1"/>`);
  }
  lines.push('</TherapyData>');
  return new TextEncoder().encode(lines.join('\n'));
}

let crcTable;
function crc32(b) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* a plain zip: entries [{ name, data, store }] (deflate unless store) */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = new TextEncoder().encode(e.name);
    const body = e.store ? e.data : new Uint8Array(zlib.deflateRawSync(e.data));
    const crc = crc32(e.data);
    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true);
    l.setUint16(8, e.store ? 0 : 8, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, body.length, true);
    l.setUint32(22, e.data.length, true);
    l.setUint16(26, name.length, true);
    lh.set(name, 30);
    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(10, e.store ? 0 : 8, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, body.length, true);
    c.setUint32(24, e.data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh, body);
    centrals.push(ch);
    offset += lh.length + body.length;
  }
  const cdSize = centrals.reduce((a, x) => a + x.length, 0);
  const end = new Uint8Array(22);
  const v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, offset, true);
  return Buffer.concat([...locals, ...centrals, end]);
}

/* write { relPath: bytes } under a fresh temp folder, read it back as the reader's files */
async function card(tree) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nocta-prisma-'));
  for (const [rel, data] of Object.entries(tree)) {
    await fs.mkdir(path.join(dir, path.dirname(rel)), { recursive: true });
    await fs.writeFile(path.join(dir, rel), typeof data === 'string' ? data : data);
  }
  const files = [];
  const walk = async (d) => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const rel = path.relative(dir, p).split(path.sep).join('/');
        files.push({ path: rel, read: async () => { const b = await fs.readFile(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } });
      }
    }
  };
  await walk(dir);
  return { files, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const SMART_CFG = JSON.stringify({ devid: '0x92', dev: { sn: '1A2B', hwversion: '3' } });
const SMART_DIR = 'CARD/0000006699'; // 0x1A2B = 6699, ten digits
const at = (y, mo, d, h, mi, s) => Date.UTC(y, mo - 1, d, h, mi, s) / 1000;

const APAP_PARAMS = { 6: 2, 9: 600, 10: 1200, 13: 1, 15: 1, 16: 3, 17: 1, 19: 15 };
const NIGHT_EVENTS = [
  { id: 101, end: 100, duration: 12 }, // obstructive 88–100
  { id: 102, end: 400.5, duration: 10.5 }, // central
  { id: 111, end: 900, duration: 15 }, // obstructive hypopnea
  { id: 112, end: 1000, duration: 20 }, // central hypopnea
  { id: 103, end: 1500, duration: 11 }, // apnea in a leak
  { id: 121, end: 1800, duration: 8 }, // rera
  { id: 131, end: 2000, duration: 0 }, // snore
  { id: 151, end: 2100, duration: 30 }, // flow limitation
  { id: 161, end: 2400, duration: 120 }, // critical leak
  { id: 181, end: 3000, duration: 300 }, // CS respiration → periodic breathing
  { id: 141, end: 500, duration: 5 }, // artefact: not read
  { id: 113, end: 600, duration: 12 }, // hypopnea in a leak: not read (OSCAR doesn't)
  { id: 1, end: 120, duration: 120 }, // epoch mark: not read
  { id: 221, end: 700, duration: 0 }, // timed breath: not read
];

/* ---------- the tests ---------- */

test('recognises a prisma card and nothing else', () => {
  assert.equal(isPrisma(['CARD/config.pscfg']), true);
  assert.equal(isPrisma(['config.pcfg', 'therapy.pdat']), true);
  assert.equal(isPrisma(['STR.edf', 'DATALOG/20261020/x_BRP.edf']), false);
});

test('prisma SMART: a normal night', async () => {
  const { files, cleanup } = await card({
    'CARD/config.pscfg': SMART_CFG,
    [`${SMART_DIR}/20261020/event_1.xml`]: eventXml({ params: APAP_PARAMS, events: NIGHT_EVENTS, changes: [{ id: 271, value: 3, at: 0 }] }),
    // an hour of records, plus half a record cut off at the end
    [`${SMART_DIR}/20261020/signal_1.wmedf`]: wmedf({ start: [2026, 10, 20, 22, 30, 0], nrec: 360, signals: SIGNALS(), extraBytes: 100 }),
  });
  try {
    const progress = [];
    const r = await readPrisma(files, { onProgress: (p) => progress.push(p) });
    assert.deepEqual(r.device, { manufacturer: 'Löwenstein', model: 'prisma SMART', modelNumber: '0x92', serial: '1A2B', firmware: null });
    assert.equal(r.clock, 'device-local');
    assert.equal(r.filesRead, 2);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(progress, [{ done: 1, total: 1 }]);
    assert.equal(r.sessions.length, 1);
    const s = r.sessions[0];
    assert.equal(s.id, 1);
    assert.equal(s.start, at(2026, 10, 20, 22, 30, 0));
    assert.equal(s.end, 3600);
    assert.deepEqual(s.maskOn, [[0, 3600]]);
    assert.deepEqual(s.settings, { mode: 'auto-cpap', pressureMin: 6, pressureMax: 12, flexLevel: 1, rampMinutes: 15 });
    assert.equal(s.deviceCounts, null);
    assert.deepEqual(s.pressureChanges, []);
    assert.deepEqual(
      s.events.map((e) => [e.type, e.at, e.duration, e.countedByDevice]),
      [
        ['obstructive', 88, 12, true],
        ['central', 390, 10.5, true],
        ['hypopnea', 885, 15, true],
        ['hypopnea', 980, 20, true],
        ['apnea', 1489, 11, true],
        ['rera', 1792, 8, true],
        ['snore', 2000, 0, true],
        ['flow-limitation', 2070, 30, true],
        ['large-leak', 2280, 120, true],
        ['periodic-breathing', 2700, 300, true],
      ]
    );
    assert.equal(s.readings.length, 60);
    assert.deepEqual(s.readings[0], { at: 60, span: 60, pressure: 8.5, epap: 6.5, ipap: 9, leak: 0 });
    assert.deepEqual(s.readings[59], { at: 3600, span: 60, pressure: 8.5, epap: 6.5, ipap: 9, leak: 59 });
    assert.ok(s.readings.every((x) => !('totalLeak' in x)));
  } finally {
    await cleanup();
  }
});

test('prisma SMART: a mask-off break is two sessions; day folders with subfolders are read through them', async () => {
  const cpap = { 6: 1, 9: 1000, 10: 1000, 13: 2, 19: 0 };
  const { files, cleanup } = await card({
    'config.pscfg': SMART_CFG,
    '0000006699/20261020/event_1.xml': eventXml({ params: cpap, events: [{ id: 101, end: 50, duration: 10 }] }),
    '0000006699/20261020/signal_1.wmedf': wmedf({ start: [2026, 10, 20, 23, 0, 0], nrec: 180, signals: SIGNALS() }),
    // after an hour with the mask off, a second run
    '0000006699/20261021/a/event_2.xml': eventXml({ params: cpap, events: [{ id: 102, end: 30, duration: 10 }] }),
    '0000006699/20261021/a/signal_2.wmedf': wmedf({ start: [2026, 10, 21, 0, 30, 0], nrec: 90, signals: SIGNALS() }),
    // a day folder with a subfolder: files beside the subfolder aren't read (as in OSCAR)
    '0000006699/20261021/signal_9.wmedf': wmedf({ start: [2026, 10, 21, 3, 0, 0], nrec: 6, signals: SIGNALS() }),
    // another machine's folder on the same card: not read
    '0000000001/20261020/signal_5.wmedf': wmedf({ start: [2026, 10, 20, 3, 0, 0], nrec: 6, signals: SIGNALS() }),
  });
  try {
    const r = await readPrisma(files);
    assert.deepEqual(r.warnings, []);
    assert.deepEqual(r.sessions.map((s) => s.id), [1, 2]);
    const [a, b] = r.sessions;
    assert.equal(a.start, at(2026, 10, 20, 23, 0, 0));
    assert.equal(a.end, 1800);
    assert.equal(b.start, at(2026, 10, 21, 0, 30, 0));
    assert.equal(b.end, 900);
    assert.equal(b.start - (a.start + a.end), 3600); // the break between them
    assert.deepEqual(a.settings, { mode: 'cpap', pressure: 10, flexLevel: 2, rampMinutes: 0 });
    assert.deepEqual(b.events, [{ type: 'central', at: 20, duration: 10, countedByDevice: true }]);
  } finally {
    await cleanup();
  }
});

test('prisma LINE: zipped config and therapy files', async () => {
  const device = '<?xml version="1.0"?>\n<Device><DeviceType Value="10"/><DeviceSerialNumber Value="99887766"/><FWVersion Value="5.07"/><FWRevision Value="0002"/></Device>';
  const cpapLine = { 1003: 1, 1201: 1000, 1123: 2, 1127: 10, 1083: 3, 271: 3 };
  const autoLine = { 1003: 2, 1201: 550, 1199: 1150, 1123: 1, 1127: 5 };
  const sLine = { 1003: 4, 1201: 600, 1200: 1200, 1154: 0, 1127: 20 };
  const acsv = { 1003: 3, 1201: 600, 1200: 1000, 1127: 0 };
  const { files, cleanup } = await card({
    'config.pcfg': zip([{ name: 'mnt/flash/conf/device.xml', data: new TextEncoder().encode(device) }]),
    'therapy.pdat': zip([
      { name: 'therapy/event_000042.xml', data: eventXml({ params: cpapLine, events: [{ id: 111, end: 200, duration: 20 }] }) },
      { name: 'therapy/signal_000042.wmedf', data: wmedf({ start: [2026, 10, 22, 22, 0, 0], nrec: 60, signals: SIGNALS(false) }) },
      { name: 'therapy/event_000043.xml', data: eventXml({ params: autoLine }), store: true },
      { name: 'therapy/signal_000043.wmedf', data: wmedf({ start: [2026, 10, 23, 1, 0, 0], nrec: 12, signals: SIGNALS(false) }), store: true },
      { name: 'therapy/event_000044.xml', data: eventXml({ params: sLine }) },
      { name: 'therapy/signal_000044.wmedf', data: wmedf({ start: [2026, 10, 24, 1, 0, 0], nrec: 12, signals: SIGNALS(false) }) },
      { name: 'therapy/event_000045.xml', data: eventXml({ params: acsv }) },
      { name: 'therapy/signal_000045.wmedf', data: wmedf({ start: [2026, 10, 25, 1, 0, 0], nrec: 12, signals: SIGNALS(false) }) },
    ]),
  });
  try {
    const r = await readPrisma(files);
    assert.deepEqual(r.device, { manufacturer: 'Löwenstein', model: 'prisma20A', modelNumber: '10', serial: '99887766', firmware: '5.07.0002' });
    assert.equal(r.filesRead, 8);
    assert.deepEqual(r.sessions.map((s) => s.id), [42, 43, 44, 45]);
    const [a, b, c, d] = r.sessions;
    assert.equal(a.start, at(2026, 10, 22, 22, 0, 0));
    assert.equal(a.end, 600);
    assert.deepEqual(a.settings, { mode: 'cpap', pressure: 10, flexLevel: 2, rampMinutes: 10 });
    assert.deepEqual(a.events, [{ type: 'hypopnea', at: 180, duration: 20, countedByDevice: true }]);
    assert.deepEqual(a.readings[0], { at: 60, span: 60, pressure: 8.5, epap: 6.5, ipap: 9, leak: 0 });
    assert.deepEqual(b.settings, { mode: 'auto-cpap', pressureMin: 5.5, pressureMax: 11.5, flexLevel: 1, rampMinutes: 5 });
    assert.deepEqual(c.settings, { mode: 'auto-bilevel', epap: 6, ipap: 12, rampMinutes: 20 });
    assert.deepEqual(d.settings, { mode: 'asv', rampMinutes: 0 }); // pressures not read: OSCAR's support is partial
    assert.deepEqual(r.warnings, ['AcSV mode is only partly understood: its pressure settings weren’t read.']);
  } finally {
    await cleanup();
  }
});

test('a damaged file is a warning; the rest of the card still reads', async () => {
  const good = (h) => wmedf({ start: [2026, 10, 20, h, 0, 0], nrec: 30, signals: SIGNALS() });
  const event = eventXml({ params: APAP_PARAMS, events: [{ id: 101, end: 50, duration: 10 }] });
  const ambiguous = SIGNALS().map((sg) => (sg.label === 'LeakFlowBreath' ? { ...sg, physMin: 0, physMax: 255 } : sg));
  const { files, cleanup } = await card({
    'CARD/config.pscfg': SMART_CFG,
    [`${SMART_DIR}/20261020/event_1.xml`]: event,
    [`${SMART_DIR}/20261020/signal_1.wmedf`]: good(22),
    [`${SMART_DIR}/20261020/event_2.xml`]: event,
    [`${SMART_DIR}/20261020/signal_2.wmedf`]: good(23).slice(0, 100), // cut short
    [`${SMART_DIR}/20261020/event_3.xml`]: event.slice(0, event.length - 40), // cut short
    [`${SMART_DIR}/20261020/signal_3.wmedf`]: good(23),
    [`${SMART_DIR}/20261020/event_4.xml`]: event, // no signal file
    [`${SMART_DIR}/20261020/event_5.xml`]: event,
    [`${SMART_DIR}/20261020/signal_5.wmedf`]: wmedf({ start: [2026, 10, 21, 3, 0, 0], nrec: 30, signals: ambiguous }),
  });
  try {
    const r = await readPrisma(files);
    assert.deepEqual(r.sessions.map((s) => s.id), [1, 3, 5]);
    assert.equal(r.sessions[0].events.length, 1);
    assert.deepEqual(r.sessions[1].events, []); // its event file was damaged
    assert.deepEqual(r.sessions[1].settings, {});
    assert.ok(r.sessions[1].readings.length > 0);
    assert.ok(!('leak' in r.sessions[2].readings[0])); // the ambiguous signal is skipped
    assert.ok('pressure' in r.sessions[2].readings[0]);
    const w = r.warnings.join('\n');
    assert.match(w, /signal_2\.wmedf: .*Session 2 skipped/);
    assert.match(w, /Session 3 event file: isn’t complete XML/);
    assert.match(w, /Session 4 has no signal file/);
    assert.match(w, /LeakFlowBreath signal’s scale is ambiguous/);
    assert.ok(!w.includes('1A2B'), 'no serial numbers in warnings');
  } finally {
    await cleanup();
  }
});

test('prisma LINE: a damaged zip member is a warning; the other sessions read', async () => {
  const sig = (d) => wmedf({ start: [2026, 10, d, 22, 0, 0], nrec: 30, signals: SIGNALS(false) });
  const ev = eventXml({ params: { 1003: 1, 1201: 800 } });
  const pdat = zip([
    { name: 'event_000001.xml', data: ev },
    { name: 'signal_000001.wmedf', data: sig(20), store: true },
    { name: 'event_000002.xml', data: ev },
    { name: 'signal_000002.wmedf', data: sig(21), store: true },
  ]);
  // flip a byte inside session 2's stored signal: its CRC no longer matches
  const second = pdat.indexOf(Buffer.from('signal_000002.wmedf')) + 'signal_000002.wmedf'.length + 400;
  pdat[second] ^= 0xff;
  const { files, cleanup } = await card({ 'config.pcfg': Buffer.from('not a zip at all'), 'therapy.pdat': pdat });
  try {
    const r = await readPrisma(files);
    assert.deepEqual(r.sessions.map((s) => s.id), [1]);
    assert.deepEqual(r.sessions[0].settings, { mode: 'cpap', pressure: 8 });
    const w = r.warnings.join('\n');
    assert.match(w, /config\.pcfg: not a zip/);
    assert.match(w, /signal_000002\.wmedf: checksum doesn’t match/);
    assert.equal(r.device.serial, null);
  } finally {
    await cleanup();
  }
});

test('an unrelated folder is not this machine', async () => {
  const { files, cleanup } = await card({ 'STR.edf': 'x', 'DATALOG/20261020/20261020_220000_BRP.edf': 'x', 'notes.txt': 'hello' });
  try {
    await assert.rejects(readPrisma(files), (err) => err instanceof ReaderError && err.code === 'not-this-machine');
  } finally {
    await cleanup();
  }
});
