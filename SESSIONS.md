# The session shape every reader returns

Each reader exports `read<Machine>(files, { onProgress })` and an
`is<Machine>(paths)` test, and returns:

```js
{
  device: { manufacturer, model, modelNumber, serial, firmware },  // null where unknown
  clock: 'device-local' | 'utc',  // 'device-local': times are the machine's own wall
                                  // clock with no zone, written as seconds read as if UTC
  sessions: [Session],
  filesRead,                      // how many therapy files it tried
  warnings: [string],             // what it couldn't read, in plain words
  notes: [string],                // optional: how this machine's card is, not a fault
                                  // (e.g. "only the current settings are kept")
}
```

A `Session` is one stretch the machine was running:

```js
{
  id,                 // the machine's session number, or a stable string
  start,              // seconds (see clock)
  end,                // seconds from start when it stopped
  maskOn: [[from, to]],          // seconds from start
  settings: {         // cmH2O; leave a key out when the card doesn't say
    mode,             // 'cpap' | 'auto-cpap' | 'bilevel' | 'auto-bilevel' | 'cpap-check' | 'asv' | 'other'
    pressure, pressureMin, pressureMax, epap, ipap, rampMinutes, flexLevel,
  },
  deviceCounts: { obstructive, central, hypopnea, rera, flowLimitation } | null,
                      // the machine's OWN totals, only when the card stores them
  events: [{ type, at, duration, countedByDevice }],
                      // at: seconds from start; duration: seconds (0 for a flag)
                      // type: 'obstructive' | 'central' | 'apnea' (unclassified) |
                      //   'hypopnea' | 'rera' | 'flow-limitation' | 'snore' |
                      //   'large-leak' | 'periodic-breathing' | 'variable-breathing'
                      // countedByDevice: false for an event the machine leaves out
                      //   of its own AHI
  readings: [{ at, span, ...values }],
                      // at: seconds from start; span: seconds it covers, ending at `at`
                      // values (only those the card has):
                      //   pressure, epap, ipap (cmH2O)
                      //   totalLeak (L/min, vent included) | leak (L/min, beyond the vent)
                      //   respRate (/min), tidalVolume (mL), minuteVent (L/min)
                      //   snore, flowLimitation (the machine's own index)
                      //   snoreCount (snores counted in the span)
                      //   spo2 (%), pulse (/min)
  pressureChanges: [{ at, pressure }],   // when the machine set a new pressure, if recorded
}
```

Rules:

- Never guess. A record or setting the source doesn't explain is skipped (and
  noted in `warnings` if it means something is missing), not interpreted.
- A wrong checksum, a short file or an unknown format version: a warning for
  that file, and the rest of the card still reads.
- Throw `ReaderError('not-this-machine', …)` only when the files aren't this
  machine's card at all.
- No serial numbers in warnings.
- Readers import only from this folder (`./edf.js`, `./prs1.js`, `./errors.js`).
