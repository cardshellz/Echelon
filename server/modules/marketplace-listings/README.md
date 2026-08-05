# Marketplace listings

This module owns the provider-neutral `marketplace.*` publication-generation and
replacement-operation state. Channels and Dropship retain ownership of their
configuration and credentials.

## Stage 2A registration boundary

Stage 2A adds a safe import path for an existing live marketplace listing:

- preview validates the complete owner variant snapshot before invoking the
  read-only provider observer;
- the observer receives that validated candidate set and must not re-read owner
  state;
- observed archived/inactive and zero-quantity variants remain included;
- every unobserved local variant remains in the immutable snapshot as excluded
  with reason `not_in_observed_publication`;
- confirmation checks replay before any owner/provider call, then re-observes
  and requires the user-confirmed observation hash;
- confirmation next invokes the owner-owned stable-account claimer. That
  durable, idempotent owner identity claim may remain if the marketplace
  transaction later fails;
- only stable `provider_user_id` evidence is accepted; mutable usernames are
  display snapshots, never identity keys;
- one bounded transaction locks owner and account identity, revalidates every
  catalog variant, creates or locks an empty scope, writes planned members,
  stages identities, inserts claims, activates generation 1, and appends the
  immutable receipt; and
- publication-key, listing, variant, offer, and inventory-item identities stay
  distinct and unique within their provider-account namespace.

Registration does not create, revise, publish, end, or otherwise mutate an
external marketplace listing. It imports only a provider-confirmed live listing
into a new or empty local scope. Owner account claiming and marketplace state
persistence are intentionally separate durable boundaries.

The repository exposes request-keyed replay plus bounded, owner-scoped current
status reads. Authenticated Channel and Dropship HTTP routes expose the same
provider-neutral preview, confirm, and status contracts while owner modules
retain credentials and catalog authority. The Channel eBay listing feed reads
the durable status instead of treating browser-session state as proof of a
registration. Dropship uses the same backend boundary; a Dropship admin launcher
requires a view that exposes the store connection, product, and external listing
identity together.

## Stage 1 boundary

Stage 1 provides:

- immutable publication generations and variant-membership snapshots;
- an idempotent, leased replacement-operation and step state model;
- append-only, ordered evidence for exactly one event per subject state version;
- deterministic request/desired-state hashes;
- atomic PostgreSQL persistence for a replacement plan and deferred
  operation/publication final-state consistency; and
- owner-scoped replay for both Channel and Dropship owners.

Stage 1 by itself does **not** register existing live listings or call a
marketplace. Its planning repository requires the active publication created by
registration. It creates a durable replacement plan only; it does not execute
external transitions.

A `failed` publication means that generation never became Echelon's active
generation. It does not, by itself, claim that a provider artifact is absent or
not sellable. A safely failed replacement requires an active source and failed
target. After any external-effect phase, it also requires successful
compensation evidence that the target is not sellable and the source is live.
Uncertain external state belongs in
`manual_recovery_required`, not `failed`.

## Stage 2B replacement execution

Stage 2B now provides:

- a provider-neutral execution contract and one eBay adapter used by Channel and
  Dropship owners;
- owner-bound, leased step claims, evidence persistence, deterministic retries,
  verification, compensation, and manual-recovery classification;
- exact target membership, so variants explicitly excluded from the plan are
  not copied into the replacement item group;
- Channel and Dropship HTTP planning/execution routes with server-derived actors
  and operation-owner validation before any lease mutation;
- a reusable review/execute dialog that explicitly includes or excludes every
  local variant; the Channel listing feed launches it for a registered current
  baseline, while a future Dropship listing-publication view can supply the same
  owner and variant contract; and
- default-off live execution. Set
  `MARKETPLACE_LISTING_REPLACEMENT_EXECUTION_ENABLED=true` only after eBay
  sandbox validation for the intended account and listing shape.

Production enablement remains a rollout decision, not a code default. Provider
sandbox tests must still prove the account-specific group replacement behavior,
partial failures, retries, and compensation before the flag is enabled.
Disposable-PostgreSQL concurrency coverage must also be run in CI; the unit
contract proves the repository locks scope before operation, but it does not
replace a two-connection lock-contention test.
Provider calls must remain outside the domain and PostgreSQL repository. Every
transition writer must lock in this order: scope, operation, publication or
step. It must update one subject version and append that exact version's event
in the same transaction. A success finalization must supersede the source,
activate the target, and complete the operation atomically after every forward
step succeeds. A direct preflight failure may atomically fail an untouched
target while the source remains active. A post-effect safe failure must finish
both compensation steps, fail the target, and fail the operation atomically
while the source remains active.
