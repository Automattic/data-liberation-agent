# Interaction phase budgets

Refs #1068. This slice implements contracts 1–3 for route post-baseline
interaction probing, document-root candidacy, and discovery recovery.

Every post-baseline probe uses `screenshot/phase-budget.ts`. Each named phase
gets at most a tenth of the remaining route deadline, capped at 30 seconds.
Repeated entries into a phase share that allocation. All phases together get
at most a quarter of the remaining deadline, capped at 90 seconds. Disabling
the route deadline still leaves optional probes bounded.

On expiry the probe page closes, stopping pending browser evaluations and
locator actions. Capture retains the baseline and completed evidence, marks the
interaction report `coverage: "partial"`, and records the profile diagnostic
`interaction_phase_budget_exceeded`. Remaining probes on that page are skipped;
other profiles and routes continue. Cleanup is audited against the authoritative
baseline before probing. The absolute capture time window is unchanged, but a
probe overrun is excluded from projected route-duration estimates.

Server-response HTML links enter the next discovery wave even when a route
fails before its rendered HTML can be recorded. Normal scope, action-URL,
frontier, and route-limit checks still govern admission.

The CLI exposes the existing per-route deadline as `--route-deadline <duration>`.
For example, `--route-limit 3 --route-deadline 30s` bounds optional probes well
inside each route's deadline rather than allowing an input drive to run for five
minutes.

Synthetic acceptance uses real Chromium and disk manifests: a stalled choice
activation, an input that becomes permanently disabled during search, root-only
selectable markup, and an entrypoint stalled before serialization. The combined
stalled-probe fixture takes approximately 35 seconds; server-link recovery takes
approximately 6 seconds. Existing interaction assertions and tolerances remain
unchanged.

Remaining slices: private-corpus operator verification, the broader route model
(#1034), and unification of the pre-route device-mode/shared-chrome bootstrap
probe budgets with route-level scheduling. Those bootstrap probes precede the
baseline and are not post-baseline route phases.
