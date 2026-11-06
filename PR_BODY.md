## Summary
- Fit breakpoint/container uniform-scale observations as viewport-based media-query segments, retaining the sampled-origin requirement and rejecting unfitted series.
- Add a standalone real capture/export regression with a neutral container switching from `min(760px, 55vw)` to `70vw` at 900px.
- Stabilize the two reported gate failures: await the actual runtime slide phase instead of fixed sleeps, and hold the lazy-image replacement pending until a second sweep visits it.

## Before / after evidence
Command: `npx vitest run src/lib/screenshot/fluid-transform-breakpoint.test.ts`

Before (temporarily restored `fluid-capture.ts` from the candidate's parent): FAIL at 768px — frame width 760px, container width 537.59375px (222.40625px error).

After: PASS through real capture + export; frame and container widths agree within 0.5px at 768 and 1024px, and both are 760px at 1440px. The regression also checks the frame's left edge to preserve origin behavior. One browser capture/export takes approximately 13 seconds locally.

## Validation
- Focused regression plus both reported failing files: 3 files / 70 tests passed (83 seconds).
- `npm test`: 318 files passed, 1 skipped; 2,902 tests passed, 4 skipped (727 seconds).
- No generated bundles changed.
