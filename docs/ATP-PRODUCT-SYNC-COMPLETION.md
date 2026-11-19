# Product inventory sync completion

The selected-product command must own the complete path from existing channel
inventory identities to canonical ATP publication. A missing ATP mapping is a
registration step, not evidence that the operator has not linked the listing.

## Command contract

- Opening or refreshing the review is read-only.
- An explicit sync records one durable, actor-bound, idempotent product request.
- Acceptance wakes only that product's eligible missing stock-link checks,
  including historical draft rejections. It never resets a destination pause,
  halt, permanent error, or another worker's live lease.
- A bounded worker runs the existing provider-specific stock-link policies for
  exactly those target/variant pairs. It does not run a global discovery sweep.
- Registration can itself enqueue inventory through the canonical owner. The
  request is therefore durable before registration begins, and the UI must not
  describe this stage as a read-only preview.
- After registration settles, the worker obtains a fresh ATP plan and publishes
  eligible rows through the existing product publication transaction. The exact
  publication command is saved before execution so an uncertain commit replays
  the same command. Provider delivery remains owned by the admitted outbox.
- Partial failures are visible by destination. Queued is not verified; only exact
  provider readback confirms delivery. A stopped request is never shown as success.
- Worker leases, bounded retries, persisted progress, and immutable audit events
  make a restart or lost HTTP response recoverable without broad inventory sync.

## Required acceptance evidence

Exercise existing feed links with absent ATP mappings and future-dated draft
rejections, exact product isolation, Shopify draft eligibility, multiple provider
policies, duplicate identity refusal, target/global controls, concurrent retries,
lost responses and worker restarts, partial channel failures, zero quantities,
unchanged warehouse inventory, and verified provider delivery. Report local tests,
hosted CI, deployment, and production acceptance separately.
