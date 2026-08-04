# Marketplace listing replacement

This module owns the provider-neutral `marketplace.*` publication-generation and
replacement-operation state. Channels and Dropship retain ownership of their
configuration. Stage 1 consumes their owner snapshots through the reader port in
`application/ports.ts`; provider adapters and execution ports belong to a later
stage.

## Stage 1 boundary

Stage 1 provides:

- immutable publication generations and variant-membership snapshots;
- an idempotent, leased replacement-operation and step state model;
- append-only, ordered evidence for exactly one event per subject state version;
- deterministic request/desired-state hashes;
- atomic PostgreSQL persistence for a replacement plan and deferred
  operation/publication final-state consistency; and
- owner-scoped replay for both Channel and Dropship owners.

Stage 1 does **not** register existing live listings, call a marketplace, change
inventory, retire a listing, expose an HTTP route, or render an admin UI. The
planning repository requires a previously registered listing scope and active
source publication. It creates the durable plan only; it does not expose a
transition executor.

A `failed` publication means that generation never became Echelon's active
generation. It does not, by itself, claim that a provider artifact is absent or
not sellable. A safely failed replacement requires an active source and failed
target. After any external-effect phase, it also requires successful
compensation evidence that the target is not sellable and the source is live.
Uncertain external state belongs in
`manual_recovery_required`, not `failed`.

## Required later stages

1. Add owner-owned registration/read adapters that establish a listing scope
   and observed active publication without writing Channels or Dropship tables
   from this module. Before registration is enabled, add an account-qualified,
   serialized claim registry for provider listing/group/member identities; the
   Stage 1 publication indexes are generation/scope guards, not proof of
   account-wide ownership. Registration must also lock the owner row and the
   owner API must prevent its provider identity from changing while a scope is
   bound.
2. Add a provider execution contract and an eBay adapter shared by Channel and
   Dropship owners. Prove provider-specific sequencing, retry, verification,
   and compensation behavior before enabling execution. The executor must use
   compare-and-set writes with the current lease token and explicitly lock the
   operation before any step update; triggers validate state but cannot prove
   that a caller possessed the lease or impose row-lock order before the update
   statement begins.
3. Add the internal admin workflow for preview, confirmation, progress,
   recovery, and audit evidence.
4. Enable production execution only after disposable-PostgreSQL concurrency
   tests and provider sandbox tests cover partial failures and retries.

Provider calls must remain outside the domain and PostgreSQL repository. Every
transition writer must lock in this order: scope, operation, publication or
step. It must update one subject version and append that exact version's event
in the same transaction. A success finalization must supersede the source,
activate the target, and complete the operation atomically after every forward
step succeeds. A direct preflight failure may atomically fail an untouched
target while the source remains active. A post-effect safe failure must finish
both compensation steps, fail the target, and fail the operation atomically
while the source remains active.
