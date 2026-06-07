# CLAUDE.md

Project-specific guidance for working in this repository. See also `AGENTS.md` for
broader rules and the skills under `.agents/skills/`.

## Testing

`npm test` skips two slow tests **by default** so iterative development stays fast:

- the mesh-validation sweep in `test/mesh-sweep-sample.test.ts` (~6 minutes), and
- the text-clearance test in `test/text3d.test.ts` (~60 seconds).

Both are gated behind the `RUN_SLOW_TESTS` environment variable. With it unset, they
report as skipped (with a reason); `npm run check` is fast for the same reason.

### Only run the slow tests when you actually need to

Do **not** run them routinely. Run them only when your change could affect what they
cover:

- **Mesh sweep** — when changing model construction, the manifold-3d CSG pipeline,
  mesh generation, or mesh validation (e.g. `test-utils/mesh-sweep.ts`, the
  model/export pipeline, the validation detectors).
- **Text-clearance test** — when changing text placement / clearance logic
  (`computeRankedTextPlacements` and the text-placement module under `src/text*`).

To run them on demand:

```bash
npm run test:slow          # full suite including both slow tests
RUN_SLOW_TESTS=1 npm test  # equivalent
```

CI runs the full suite including both slow tests automatically (via
`RUN_SLOW_TESTS=1` in `.github/workflows/deploy-pages.yml`), so they always remain
covered on every push to `main` — there is no need to run them locally just to be
safe.
