# nocta-card-readers

Reads CPAP machines' SD cards, in the browser, into plain therapy sessions:
when the mask was on, the events the machine flagged, its readings over the
night, its settings and its own counts. Nothing about any one app: no nights,
scores or advice, and it imports nothing from outside this folder.

Licensed under the **GNU General Public License, version 3** (`LICENSE`),
separately from the Nocta app that uses it.

## Machines

| Reader | Machines | Leak | Checked on a real card |
|---|---|---|---|
| `philips-ds2` | Philips DreamStation 2 (410X, 420X, 520X, 521X) | total | Not yet |
| `bmc` | BMC / React Health / 3B: Luna G3, G3X, E5 (index + per-second ring); RESmart G2/GII, Luna, Luna II (legacy `.USR`) | beyond the vent (G3 2.11, legacy); total (G3 2.12+) | Not yet |
| `prisma` | Löwenstein prisma SMART, SOFT (`config.pscfg`); prisma LINE 20A, 20C, 25S, 25ST (`config.pcfg` + `therapy.pdat`) | beyond the vent | Not yet |
| `sleepstyle` | Fisher & Paykel SleepStyle CPAP / Auto (`FPHCARE/ICON/…`) | total | Not yet |
| `resvent` | Resvent iBreeze 20A, 20C, 25A, 30STA, iDisc 20A; Hoffrichter Point / Trend (`THERAPY/…`) | beyond the vent | Not yet |

Every reader is tested on synthetic cards built from the same reading of the
format (`npm test`): that shows each is consistent and survives damaged files,
not that it matches a real machine. A real card from any of these machines is
the most useful contribution.

## Use

```js
import { readerFor } from 'nocta-card-readers';

const reader = readerFor(files.map((f) => f.path)); // null if no reader knows the card
const { device, clock, sessions, warnings, notes } = await reader.read(files);
// files: [{ path, read: () => Promise<ArrayBuffer>, readRange?: (from, to) => Promise<ArrayBuffer> }]
// every file on the card; readRange lets big files (BMC's 64 MiB ring) be read in part
```

Each reader is also its own entry (`nocta-card-readers/bmc`, `/prisma`,
`/sleepstyle`, `/resvent`, `/philips-ds2`).

The session shape is described at the top of `src/philips-ds2.js`. Times are
seconds; `clock` says whether they're true instants or the machine's own wall
clock (`'device-local'`).

`src/prs1.js` is the chunk framing every Philips Respironics machine writes,
for the readers to come (System One, BiPAP).

## Credits

- `bmc`, `prisma`, `sleepstyle` and `resvent` are adapted from
  [OSCAR](https://gitlab.com/CrimsonNape/oscar-sql)'s loaders (commit
  `4438aecb259e63b53219a861062b7878bfe77cfc`), Copyright 2019-2026 The OSCAR Team,
  2011-2018 Mark Watkins. Each file's header says which, and where it differs.
- `philips-ds2` is adapted from [OpenCPAP](https://github.com/cdelcollado/OpenCPAP)'s
  DreamStation 2 loader (commit `d2a68d9be9a98630d8af91b49e900f1aa3c34bc6`) and its
  format note, which are adapted from [OSCAR](https://gitlab.com/CrimsonNape/oscar-sql)'s
  PRS1 loader. Both GPL-3.0.
- The PRS1 framing follows the format note of
  [dreamstation](https://github.com/mattjoyce/dreamstation) (Apache License 2.0).

Source: https://github.com/jmchiang1/nocta-card-readers, and with Nocta's site at
`/source/card-readers/`. (Nocta's app keeps its working copy in `packages/card-readers/`
and publishes each change here.)
