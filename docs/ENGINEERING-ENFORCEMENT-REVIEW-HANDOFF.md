# Engineering enforcement review and implementation scoping

Act as a senior software engineering manager and staff engineer reviewing Echelon. Your assignment is to turn the existing engineering standards into a practical, evidence-backed enforcement plan: determine what CI already protects, what violations can still pass, and which implementation batches would close the most important gaps.

This assignment is discovery and scoping. Deliver a plan another engineer can implement without rediscovering the architecture. Do not begin the implementation, merge changes, deploy, change repository protections, or mutate production data as part of this assignment.

## Intended outcome

Make architectural and financial requirements explicit, testable, and difficult to bypass accidentally. Preserve one authority for each business decision and state change. Treat performance and growth as measurable requirements rather than calling code "scalable" without evidence.

The project must address three separate questions:

1. Are the boundaries and invariants clearly defined and consistent with the intended business behavior?
2. Do automated checks detect violations of those boundaries and invariants?
3. Does the delivery process actually require those checks, including when someone changes the checks themselves?

Report separately what can be enforced mechanically, what needs behavioral tests, and what still requires engineering review or operational evidence. Do not promise that a green build proves perfect architecture or production correctness.

## Scope and operating constraints

Echelon is the primary repository: [cardshellz/Echelon](https://github.com/cardshellz/Echelon). Inspect the Shopify theme and Club application only where an actual shared contract, build, or deployment dependency requires it. Record additional repository-wide work as a separately scoped follow-up.

Read the current user instructions and repository engineering standards before analysis. Resolve contradictions explicitly; do not silently choose the easier interpretation. The user's latest instruction controls over older documentation. Distinguish a policy requirement from proof that the implementation meets it.

Preserve unrelated checkout changes. Fetch the current default branch and record its full SHA, retrieval date, repository, and worktree. Use an isolated checkout when needed. Do not use a dirty feature branch as evidence of current main. Record open PRs separately; an open PR, merged code, passing CI, a deployment, and observed runtime behavior are different states.

Authorized work is source/configuration inspection, read-only repository-setting inspection, review documents, and local diagnostic probes. Before running a test or script, inspect its database and provider configuration. Use disposable local databases and synthetic data for mutation tests. Do not run production load tests, operational recovery jobs, payments, refunds, coupon redemptions, inventory changes, or warehouse holds.

Do not add a generic architecture framework, microservices, interchangeable adapters for internal domains, or duplicate business algorithms merely to facilitate enforcement. Reuse and strengthen established authorities and test infrastructure where appropriate. Proposed dependencies need a concrete gap, alternatives, maintenance cost, and migration justification.

## Evidence starting point

The following source was inspected on October 18, 2026, after fetching `origin/main`, at commit `d2407415c573ba7dd2315cbcf6cde785ecca49a3`. These are discovery starting points, not a completed audit or a statement about deployed behavior. Refresh them when this assignment starts.

The working repository was `C:/Users/owner/Echelon`; source inspection used `C:/Users/owner/Echelon/.codex-worktrees/compact-order-edit-picker` with `git show` against the pinned main commit. The primary checkout contained unrelated changes. Do not assume either checkout is suitable for your work without checking again.

| Existing material | What the inspected source establishes | What you must establish next |
| --- | --- | --- |
| [Engineering standards](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/CLAUDE.md#L13-L164) and [boundary policy](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/BOUNDARIES.md#L18-L53) | The stated requirements include separated layers, exact money, validated contracts, idempotency, transaction safety, and published interfaces for internal domains. External integrations use ports and adapters; internal ownership does not require swappable implementations. | Where implementation, documentation, and enforcement agree or disagree. An architectural document is evidence of intended policy, not runtime compliance. |
| [Writer ownership tests](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/server/__tests__/unit/writer-ratchet.test.ts#L98-L130) and [baseline removal check](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/server/__tests__/unit/writer-ratchet.test.ts#L214-L227) | The tests compare detected table writers with a checked-in baseline and contain stronger sole-owner assertions for selected tables, including order-edit tables. Removed writers must also leave the baseline. | Which tables remain covered only by historical exceptions, which executable roots are scanned, and whether changes within an existing module can bypass a canonical command without creating a new writer bucket. |
| [`scanWriterTopology`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/scripts/writer-ratchet/scan.ts#L23-L36) and [scan implementation](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/scripts/writer-ratchet/scan.ts#L103-L196) | The scanner defaults to `server`, can accept other roots, and reports unresolved Drizzle table identifiers separately. Its documented limitations include dynamic table parameters that are not gated. | Demonstrate actual missed and falsely reported cases with isolated fixtures. Do not equate matching source text with complete semantic enforcement. |
| [Unit-test command](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/package.json#L45-L52), [Vitest discovery](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/vitest.config.ts#L11-L22), and [CI job](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/.github/workflows/ci.yml#L88-L105) | CI invokes `test:unit`, whose command includes the `unit` selection filter; Vitest has its own include patterns. Other tests have separately configured jobs. | Trace every proposed guard to a discovered test, executed job, aggregate result, and required merge check. A test file existing in the repository is insufficient. |
| [Core aggregate job](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/.github/workflows/ci.yml#L227-L239) and [`requireSuccessfulJobs`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/scripts/ci/require-success.mjs#L10-L29) | The aggregate explicitly requires the expected dependencies and rejects results other than `success`. | Whether GitHub actually requires this check, which identities may bypass it, and whether all intended checks are represented. Workflow comments are not evidence of active branch protection. |
| [Test-typecheck exclusion guard](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/server/__tests__/unit/test-typecheck-ratchet.test.ts#L21-L68) | The guard fixes the exclusion count, checks test-path suffixes, and checks inherited coverage between the two typecheck configurations. | Test whether replacing one excluded test with another can evade the count check. Distinguish a suspected coverage gap from a demonstrated violation. |
| [Database test execution contract](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/docs/CI-TEST-EXECUTION.md#L11-L50) | The documented harness uses isolated disposable databases and a manifest for PostgreSQL suites. | Verify the current runner, manifest, discovery tests, and failure handling. Historical counts in this document are not the current test inventory. |

A concrete presentation-boundary example is also available:

- [`assertCouponAdjustmentSupported`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/server/modules/order-edits/domain/order-edit-coupon-boundary.ts#L26-L54) throws a stable error code together with English customer wording. [`ShopifyOrderEditProvider.codePricing`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/server/modules/order-edits/infrastructure/shopify-order-edit.provider.ts#L673-L700) invokes this boundary before native calculation verification.
- The `failed` handler inside [`registerCustomerAccountRoutes`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/server/modules/customer-account/interfaces/customer-account.routes.ts#L98-L122) serializes known errors with both `code` and `message`.
- [`createCustomerAccountTransport`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/client/src/customer-account/customer-account.transport.ts#L53-L87) supplies the bridge to the canonical edit client. [`orderEditRequest`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/client/src/lib/order-edits.ts#L140-L155) retains the response message and code in `OrderEditRequestError`.
- [`OrderEditCodeEntry.run`](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/client/src/components/order-edits/OrderEditCodeEntry.tsx#L36-L48) stores the error's message; [the component renders it](https://github.com/cardshellz/Echelon/blob/d2407415c573ba7dd2315cbcf6cde785ecca49a3/client/src/components/order-edits/OrderEditCodeEntry.tsx#L156-L158).

This establishes specific backend wording and client display behavior. Complete the request/callback trace and inspect the current theme bootstrap before proposing a replacement. Do not assume all account errors follow the same client path, or that moving a string alone establishes a reliable message contract.

## Review sequence

### 1 Establish the baseline and inventory existing enforcement

Read the engineering standards, boundary documentation, build scripts, test configurations, migrations policy, and relevant historical audits. Treat older audits as leads to revalidate. Record rules that conflict, have no operational definition, or no longer match the intended architecture.

Inventory existing lint, type, import/dependency, writer-ownership, migration, contract, integration, and browser checks before proposing new tooling. For each, record its entry command, actual input scope, exclusions, failure conditions, CI job, known limitations, and maintenance owner or owner gap.

Inspect scripts, jobs, webhooks, startup migrations, maintenance tools, generated code, and alternate API entrypoints as well as the main request path. Check whether a new file or renamed directory can fall outside discovery. Do not execute operational scripts merely because their names contain "audit" or "test".

Run only the targeted existing checks needed to establish a baseline. Record exact commands, SHA, environment, result, and evidence. Do not report checks you did not run as passing. Separate pre-existing failures from failures introduced by a diagnostic probe.

### 2 Map ownership and trace representative critical workflows

Produce a module and dependency map showing domain decisions, application orchestration, persistence, provider integration, and HTTP/UI responsibilities. For important state, identify the canonical reader, command writer, schema constraints, public interface, and every caller that can bypass it.

Choose representative workflows using financial impact, concurrency exposure, prior incidents, and reach across modules. Explain the selection and list unreviewed areas; do not label sampling as a full codebase audit. Initial candidates are order edits and returns, payment/refund effects, inventory reservation and quantity posting, procurement receipt/AP effects, and webhook/queue recovery.

For each selected workflow, trace:

1. Entry, authentication/authorization, request and response validation.
2. Business decision and its single authority.
3. Persistence, transaction boundaries, constraints, and lock lifetime.
4. External side effects and durable evidence of their outcomes.
5. Retries, duplicate commands, concurrent requests, crashes, and lost responses.
6. Recovery, audit history, logs, customer output, and relevant tests.

Distinguish a local database rollback from recovery after an external provider may have committed. Propose a durable recovery contract where needed, not an unsupported assertion that a database transaction makes a remote operation atomic.

### 3 Convert requirements into enforceable invariants

Create a rule register. Each entry must contain: rule ID, business risk, exact requirement, scope, current authority, source evidence, current protection, demonstrated or suspected gap, proposed enforcement mechanism, proving test, false-positive/false-negative risks, exception policy, owner, and expected CI cost.

The following are required review areas. They are proposed review criteria, not findings that each area is currently broken.

| Review area | Questions the plan must answer | Candidate proof mechanism |
| --- | --- | --- |
| Module ownership and layer boundaries | Can routes, UI, jobs, or another module decide business policy or bypass the owning command? Does module-level bucketing hide competing writers inside one module? | Import/dependency rules, writer analysis, focused command and DB tests, documented semantic review where static checks cannot prove intent. |
| Money and deterministic decisions | Are units and rounding explicit? Are safe ranges and currency compatibility validated? Are time-dependent business decisions reproducible? | Existing exact-money contracts, boundary/rounding tests, deterministic clocks, targeted analysis of financial operations rather than banning all numeric arithmetic. |
| Idempotency and concurrency | Can retries or simultaneous commands cause duplicate financial/inventory effects? Are keys, constraints, transactions, and recovery state coherent? | Real PostgreSQL race/replay/rollback tests and mocked provider faults, including commit followed by lost response. |
| Contracts and presentation | Are business decisions represented by stable codes and validated parameters? Which layer owns customer wording and unknown-error fallback? Can old clients tolerate new codes? | Provider/API contracts, safe message resolution, locale completeness, browser checks, and compatibility tests. |
| Errors and auditability | Are failures classified and actionable? Can one command be traced across services? Is financial history durable and protected from ordinary edits? | Error-path tests, structured context assertions, audit persistence/permissions review, recovery tests, sensitive-data checks. |
| Security and access | Are all entrypoints authorized independently of UI visibility? Are tenant/customer boundaries, untrusted provider payloads, secrets, and SQL handled correctly? | Negative authorization and payload tests, existing security tooling, schema validation, and least-privilege review. |
| Scalability and bounded work | Are queries, memory, queues, retries, caches, and provider calls bounded under the expected workload? | Query-count and pagination tests, plans/index inspection, deterministic work budgets, synthetic load evidence where appropriate. |

For every proposed automated guard, specify at least one prohibited example that must fail and one permitted example that must pass. Test aliases, indirect calls, dynamic references, alternate paths, and excluded/generated files where relevant. Prove the guard is discovered and executed by CI. A test that merely asserts that a particular source string exists is not sufficient proof of behavior.

Do not add a second business implementation just to compare its answer with the first. Test externally meaningful invariants and the existing canonical authority.

### 4 Make scalability requirements measurable

Identify workload dimensions from available evidence: orders/items per request, catalog size, concurrent users, background event volume, tenant count, provider limits, and data-retention growth. Record measured values separately from proposed targets. If capacity targets are missing, provide the measurements and explicit decisions needed; do not invent production volume.

For selected hot paths, inspect pagination, N+1 behavior, batch size, indexes/query plans, lock duration, connection-pool demand, memory use, queue backpressure, retry budgets, and provider timeouts. For caching, define identity/tenant isolation, key contents, lifetime, invalidation, and whether stale data can affect a financial decision.

Prefer stable CI assertions about bounded work where possible. Label wall-clock benchmarks with their environment and variability. Separate PR checks from scheduled capacity tests and production monitoring. Propose thresholds with a baseline and rationale, not arbitrary numbers intended only to produce a green check.

### 5 Verify CI and merge governance

Trace a rule all the way from its test to the merge decision. Inspect repository rulesets/branch protections read-only. Record what is required on the relevant branches, check identity/source, bypass permissions, review requirements, and who can alter workflows, baselines, exclusions, or ownership rules. Report inaccessible settings as INSUFFICIENT EVIDENCE.

Examine skipped/cancelled jobs, conditional workflows, changed-file selectors, missing artifacts, manual dispatch, merge-queue behavior if configured, and checks against an outdated SHA. Confirm that uncertainty in test selection cannot silently remove required coverage.

Distinguish four states: implemented locally, executed in CI, required for merge, and verified in deployment/runtime. Recommend settings changes separately from source changes. Do not enable protections or permissions during discovery.

Define how enforcement changes themselves receive review. A PR must not evade a rule by weakening the rule, increasing an exception baseline, swapping excluded files, disabling discovery, or omitting a required job without an explicit reviewed policy change.

For existing debt, propose scoped exceptions with a reason, owner, evidence, review/expiry condition, and removal plan. Prevent new violations while reducing existing ones. Do not declare legacy violations compliant simply because a baseline permits them; critical correctness defects may require immediate remediation rather than an exception.

### 6 Scope the implementation in independent batches

Separate confirmed defects from missing safeguards and from improvements that need a product or architecture decision. Prioritize by financial/security impact and likelihood, not by how easy a lint rule is to add.

For each batch provide the problem, affected workflows/files/repos, proposed design, dependencies, compatibility and migration impact, tests, acceptance criteria, observability, rollback/recovery plan, and effort range with assumptions/confidence. Identify whether repository settings or another deployment must precede it.

Recommend one bounded first batch that proves the approach end to end. Compare strengthening existing ownership/coverage guards with a customer-message contract pilot; choose based on verified impact and readiness. Do not presuppose that the message pilot is the highest priority. Make the chosen batch specific enough to implement without another architecture discovery pass.

Do not require a wholesale rewrite before useful safeguards can ship. Keep unrelated feature work out of the enforcement project. Clearly identify any necessary change to an established business rule for owner approval.

## Customer account pilot constraints

Use these as user requirements when scoping any account/order-edit example; verify current behavior separately:

- Backend services own validation, eligibility, calculation, and state transitions. The theme/presentation layer should own editable customer wording using the existing localization/configuration mechanism. Scope a typed public-code/parameter contract and safe fallback; do not display arbitrary provider diagnostics or move business rules into theme JavaScript.
- Shopify coupon codes and reward points are separate concepts and systems. Do not introduce a rewards ledger dependency to make ordinary coupon handling fit an abstraction. Reuse existing authorities for each.
- Drafts and previews must not place warehouse holds. Holds belong to approved submission. If submission never starts, release the hold. If a provider outcome is uncertain, distinguish that state from "never started" and use verified recovery before releasing protection or repeating the action.
- Reuse existing customer identity and member-pricing authorities. Preserve price display meaning, compatibility, and approved state transitions while improving boundaries.
- Theme and shared-backend deployment have different blast radii. Historical staging theme ID is `174740308127`; re-verify its role and repository/branch mapping before any later deployment. A preview URL is not proof of data isolation or authorization.

A message-contract pilot proposal must identify every owner: domain error codes, public error DTO/schema, safe parameters, transport preservation, presentation resolution, theme locale/bootstrap data, unknown/missing-key fallback, and diagnostics. Include old/new client compatibility and a browser test showing that a theme wording change takes effect without modifying backend rules. Do not propose editing a generated asset by hand or maintaining competing message maps without a defined owner and build source.

## Required deliverables

Create durable review artifacts in the review checkout and link them in the final report. Use repository documentation conventions; record full absolute paths in the handoff response.

1. **Evidence and architecture review.** Baseline SHAs/configuration, ownership/dependency map, selected workflow traces, guard inventory, findings ranked by risk, and coverage limitations. For each finding cite exact file, function, lines and revision; explain the trace and remaining unknowns.
2. **Enforcement matrix.** One row per rule with its invariant, owner, current/proposed mechanism, positive/negative proof, CI/merge status, limitations, exception policy, and maintenance cost. Cross-reference findings rather than repeating them.
3. **Phased implementation plan.** Ordered batches and dependencies, the detailed first batch, compatibility/rollout/recovery decisions, effort ranges and confidence, and acceptance criteria. Include only questions that materially affect scope or safety; continue independent review while those questions remain open.

Findings must use explicit classifications: CONFIRMED GAP, ALREADY ENFORCED, HYPOTHESIS, or INSUFFICIENT EVIDENCE. A new safeguard being absent is not automatically proof that the corresponding production defect exists.

Structure the review conclusions as: What the code definitely does; What is likely happening; What is not proven; Next checks. Include summary of documentation/probe changes, assumptions, risks, test coverage and exclusions, and failure modes. State local results, remote CI, merge protection, and runtime evidence separately.

## Completion criteria

The review is complete when another engineer can answer all of these questions from the deliverables:

- Which requirements are protected today, by what exact checks, and which protections are required for merge?
- Which important violations can still pass, and what evidence demonstrates that gap?
- What should be enforced automatically, tested behaviorally, or reviewed by a human, and why?
- What workload and failure assumptions will the first implementation batch support?
- What exactly changes in that batch, how will its guard be proven to fail on a violation, and what are the acceptance and recovery criteria?
- What remains unreviewed or blocked on evidence, and what is the next concrete check?

Stop after delivering the review and implementation scope. Do not transition automatically into implementation. The owner will select and authorize the next batch.
