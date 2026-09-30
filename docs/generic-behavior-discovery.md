# Generic source behavior discovery (in progress)

Ordinary URL capture now observes diagnosed dynamic pages without an author
recipe. It instruments source DOM mutations, visibility, event registrations,
and drawing API operations before navigation. Bounded startup and click phases
record timestamped evidence; pointer input records both bitmap change and the
actual drawing methods used. Circle and line fixtures produce distinct canvas
evidence. The observer never identifies an arbitrary drawing algorithm as a
preselected particle effect.

Two controlled Date/timezone runs identify targets dependent on local time,
separately from editorial content. The current semantic recognizer supports a
bounded set of clock representations (12/24-hour digits, minutes, AM/PM, ISO,
GMT offset and locale-derived uppercase date). A target must match the chosen
representation in both counterfactuals; other dynamic text stays unsupported.

The text recognizer learns one-character prefix progressions and interval
distributions from observations. Cyclic loading dots are separate from one-shot
reveals. A compiled text candidate captures its replay value from the current
exported DOM, so later editorial edits replay their new value. No editorial
strings or source JavaScript are embedded in the candidate runtime. The clock
candidate computes current browser-local time rather than replaying captured
digits. Neutral real-browser tests exercise renamed targets, changed text,
different timings, different drawing algorithms, controlled Date values and
edited output content.

## Evidence boundary

`source-behavior.json` retains the browser traces and model hypotheses, including
sampling limits, truncation and unknown capabilities. Candidate scripts live in
`behavior/`, outside `website/`. They remain unpromoted until complete source
startup/replay/pointer/visibility behavior and the existing fidelity gate pass.
This implementation does **not** clear the unreproduced-motion finding.

## Remaining translation requirements

- A Date-dependent field still needs its startup/replay state machine, not only
  its settled clock role. Masks, date typewriting and click-triggered clock reset
  are independently observable transitions that need faithful compilation.
- Pending messages, cycling dots, indicator visibility and linked sequence
  readiness need explicit causal state transitions. Observed timing distributions
  are evidence, not exact authored timer values.
- Canvas calls/bitmaps show response but do not reconstruct arbitrary source
  computation. Translating the actual supported algorithm requires a bounded
  semantics-preserving behavior IR and renderer, with explicit unknowns when the
  input exceeds the supported language. Neither replaying recorded pixels nor
  substituting a canned effect is sufficient.
- Discovery must distinguish direct and delegated event ownership and retain
  action safety boundaries; nested mutations and sparse drawing activity need
  neutral fixtures and strict sampling-completeness evidence.
- Full plain-URL source/capture/WordPress parity at 390/768/1440 is the acceptance
  gate. Manual recipes and independently configured earlier sites do not count.

Tracker: https://github.com/Automattic/data-liberation-agent/issues/425
