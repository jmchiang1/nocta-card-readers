// SPDX-License-Identifier: GPL-3.0-only
/* nocta-card-readers — every reader, and which one knows a card.
 * Copyright (C) 2026 Nocta. GPL-3.0 (see LICENSE).
 *
 *   readerFor(paths) → { id, read(files, { onProgress }) } | null
 *
 * paths: every file path on the card ('/'-separated). Each reader returns the
 * shape in SESSIONS.md. */
import { isDreamStation2, readDreamStation2 } from './philips-ds2.js';
import { isPrisma, readPrisma } from './prisma.js';
import { isSleepStyle, readSleepStyle } from './sleepstyle.js';
import { isResvent, readResvent } from './resvent.js';
import { isBmc, readBmc } from './bmc.js';
import { ReaderError } from './errors.js';

export { ReaderError };

export const READERS = [
  { id: 'philips-ds2', name: 'Philips DreamStation 2', is: isDreamStation2, read: readDreamStation2 },
  { id: 'prisma', name: 'Löwenstein prisma', is: isPrisma, read: readPrisma },
  { id: 'sleepstyle', name: 'Fisher & Paykel SleepStyle', is: isSleepStyle, read: readSleepStyle },
  { id: 'resvent', name: 'Resvent iBreeze', is: isResvent, read: readResvent },
  { id: 'bmc', name: 'BMC / React Health Luna', is: isBmc, read: readBmc },
];

export function readerFor(paths) {
  const norm = paths.map((p) => p.replace(/\\/g, '/'));
  return READERS.find((r) => r.is(norm)) ?? null;
}
