# Browser CI coverage

Procurement runs on four independent runner shards, with two page-isolated
workers per runner. Its fully parallel configuration distributes individual tests
across shards. The former Dropship pricing suite runs only its affected feature
groups, with at most four runners at once and one worker per runner. Catalog and
listing settings use three file-based shards; the other groups use one runner
each. Both desktop and mobile projects remain included. No retries or shorter
timeouts are introduced, and every shard uploads its own failure artifacts.

Procurement's financial retry scenarios use Playwright's controlled browser clock
to advance the existing 2, 4, and 8 second backoff delays. They verify that no
attempt occurs before each delay boundary and that the next attempt occurs at
the boundary, while retaining request-body and idempotency-key assertions.
Production retry behavior is unchanged.

The stable aggregate checks retain the original journey names. They pass only
when dependency selection succeeds and either every shard succeeds or the
selector explicitly reports that the suite is unaffected. Missing outputs,
selector errors, cancelled shards, and failed shards cannot produce a green gate.

## Selecting affected suites

`browser-suite-impact.mjs` inspects the complete NUL-delimited pull-request diff.
It follows static imports, exports, literal dynamic imports, CommonJS requires,
and type imports from the suite's runtime entrypoints, browser specs, and
HTML-injected harness entrypoints. Full-application suites also follow non-page
application-shell imports. It parses source; it never executes imported
application code.

Procurement uses the real `main.tsx` / `App.tsx`, which currently imports every
page eagerly. Its graph must include those pages: a packaging module can break
application startup even without visiting a packaging route. Therefore most
frontend changes still run procurement. Its speedup comes primarily from
sharding, not unsafe route-only filtering. Order editing retains its existing
selection behavior as well.

## Selecting affected feature groups

`dropship-browser-impact.mjs` selects groups declared in
`dropship-browser-features.mjs`: catalog/listing settings, catalog at scale
(choose, publish and end; step 1 plan S2-5), cost changes, wallet,
orders, finance, onboarding, shipping estimates, shipping configuration, catalog
conversions, page loading, and inventory opening. (The prices, content and
policies/categories groups went with the older panels in Listing settings
PR 12.) Each group starts from its own specs and HTML-injected harnesses. These
harnesses do not load App, so unrelated application pages and unimported shared
modules do not trigger them.

Imports are followed transitively, including spec helpers and shared components.
For example, a wallet page edit runs wallet coverage, a finance money helper edit
runs finance coverage, and a Listing settings price row edit runs the
catalog/listing settings group, whose catalog harness mounts the real step. A
spec edit runs its owning group. The selector logs the decision and reason for
every group.

These browser journeys mock their API responses. Unimported backend changes do
not trigger them; existing unit, contract and PostgreSQL checks remain unchanged.
Backend source imported by a spec is still part of that group's dependency graph.
Build/test tooling, package manifests, styles and public assets trigger all
groups. Shared source changes trigger every group that imports that source.

When adding another injected HTML harness, add its module to the owning group's
roots. Assign every new spec to exactly one group. The fast CI guard compares
that assignment with Playwright's actual unfiltered discovery and checks injected
harnesses, including those injected through spec helpers. Missing or duplicate
assignments fail the guard; selection falls back to the unfiltered suite rather
than omitting tests. App imports automatically bring newly added routes into
procurement's dependency graph.

Browser tests import the declared `@playwright/test` package. Importing its
undeclared transitive dependency `playwright/test` makes dependency traversal
uncertain and forces otherwise unnecessary suite runs. The selector regression
checks the actual Playwright-discovered Dropship spec set and its injected HTML
harness roots, including catalog conversions, so restoring safe skips does not
leave those entrypoints uncovered.

Full-application suites retain their broad triggers for App/main, shared code,
shared UI/layout, hooks/libraries, styles, assets and tooling. Known files outside
the relevant dependency graph can skip unrelated coverage. Unknown paths run
coverage conservatively.

Deleted/renamed/copied files, missing files, unresolved dependencies, dynamic
imports that cannot be resolved, missing diff evidence, and parse failures all
run coverage conservatively. An uncertain group graph runs that group. Missing
diff evidence, invalid feature registration, and manual dispatch run the original
unfiltered suite on two shards. Invalid feature names fail instead of producing
an empty successful run.
The workflow listens on every PR so GitHub's path-filter limits cannot silently
omit a needed check. The selection job installs the lockfile's dependencies for
the TypeScript parser; this has a small fixed startup cost even for a safe skip.

## Validation

`server/__tests__/unit/browser-ci-selection.test.ts` exercises selection and
failure cases against the real repository, including unrelated-path skips,
unresolved-import fallback, and a box-suite-only edit that still runs procurement
because App imports it eagerly. `dropship-browser-features.test.ts` exercises
feature dependencies, coverage registration and conservative fallbacks.
`ci-fast-feedback.test.ts` verifies the workflow matrix and aggregate checks,
including failures, cancellations, and explicit safe skips.

The full local command remains:

```sh
npx playwright test --config playwright.dropship-pricing.config.ts
```

Set `BROWSER_FEATURE` to a manifest key such as `wallet` to run one group, or
`all` to force unfiltered discovery. Omit the variable for ordinary full runs.
Verify that unfiltered `playwright test --list --reporter=json` IDs equal the
union of every feature/shard listing's IDs, with no duplicates, when changing
the partition. All 536 desktop/mobile cases were preserved by the initial split.
Do not enable shared-database test concurrency as part of browser optimization.

## Connected procurement acceptance

`procurement-connected.yml` runs `playwright.procurement-connected.config.ts`
separately from the mocked browser suite. Each case starts the built frontend
and real login/session, procurement HTTP routes and application/database owners
against its own disposable PostgreSQL database. Desktop and mobile run serially.
Only external inventory-channel dispatch is inert; losing a response forwards the
actual request first, waits for the commit response, then aborts browser delivery.

The fixture installs the actual schema columns and selected migrations needed by
these owners. It does not boot every production scheduler/provider or replay the
complete release migration history. Connected results are local/CI integration
acceptance, not production acceptance.

The `procurementConnected` selector includes the frontend and the child server
entry point explicitly, because process spawning is not a static import. Changed
procurement server files and migrations always select it. The existing dependency
and aggregate guards reject missing selection, failures and cancellations. New
connected specifications are discovered from `test/connected/procurement` and
checked against Playwright's unfiltered discovery.

For a local run, build with `npx vite build`, set
`ECHELON_TEST_DATABASE_DISPOSABLE=true` and `ECHELON_TEST_DATABASE_URL` to a
loopback test PostgreSQL role able to create databases, then run:

```sh
npx tsc -p tsconfig.tests.connected.json
npx playwright test --config playwright.procurement-connected.config.ts
```

Do not supply live connection strings or provider credentials. The parent passes
only runtime essentials and explicit test configuration into each child. Each
child reports its unique database identity before importing database owners;
teardown closes the real session/application pools and removes that database.
A fallback removal is permitted only after the child's exit event has been
observed and the exact database ownership has been verified. Forced fallback is
a test failure, never a silent successful cleanup.
