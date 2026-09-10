# Browser CI coverage

Procurement runs on four independent runner shards; dropship and shared shipping
configuration run on two. Playwright's existing file-level sharding partitions
the unchanged test configurations, including both desktop and mobile projects.
One worker per runner preserves fixture isolation. No retries or shorter timeouts
are introduced, and every shard uploads its own failure artifacts.

The stable aggregate checks retain the original journey names. They pass only
when dependency selection succeeds and either every shard succeeds or the
selector explicitly reports that the suite is unaffected. Missing outputs,
selector errors, cancelled shards, and failed shards cannot produce a green gate.

## Selecting affected suites

`browser-suite-impact.mjs` inspects the complete NUL-delimited pull-request diff.
It follows static imports, exports, literal dynamic imports, CommonJS requires,
and type imports from the suite's runtime entrypoints, browser specs, and
HTML-injected harness entrypoints. It also follows non-page application-shell
imports. It parses source; it never executes imported application code.

Procurement uses the real `main.tsx` / `App.tsx`, which currently imports every
page eagerly. Its graph must include those pages: a packaging module can break
application startup even without visiting a packaging route. Therefore most
frontend changes still run procurement. Its speedup comes primarily from
sharding, not unsafe route-only filtering. The dropship suite uses isolated
harnesses and can safely exclude more unrelated feature changes.

When adding another injected HTML harness, add its module to the owning suite's
roots. Specs are discovered from the same existing filename patterns; adding or
changing a spec always runs its suite. App imports automatically bring newly
added routes into procurement's dependency graph.

Changes to App/main, shared code, shared UI/layout, hooks/libraries, styles, public
assets, package manifests, and build/test tooling run both suites. Local imports
crossing feature directories are included transitively. Known feature files
outside the resulting graph can skip an unrelated suite. Known backend,
migration, and documentation paths can skip browser coverage; dropship backend
changes retain the previous dropship trigger. Other unknown paths run coverage.

Deleted/renamed/copied files, missing files, unresolved dependencies, dynamic
imports that cannot be resolved, missing diff evidence, and parse failures all
run coverage conservatively. Manual dispatch always runs the complete suite.
The workflow listens on every PR so GitHub's path-filter limits cannot silently
omit a needed check. The selection job installs the lockfile's dependencies for
the TypeScript parser; this has a small fixed startup cost even for a safe skip.

## Validation

`server/__tests__/unit/browser-ci-selection.test.ts` exercises selection and
failure cases, including a real-repository check that a box-suite-only edit still
runs procurement because App imports it eagerly. Verify each
configuration's unsharded `playwright test --list --reporter=json` IDs equal the
union of its shard listing IDs, with no duplicates, when changing shard layout.
Do not enable shared-database test concurrency as part of browser optimization.
