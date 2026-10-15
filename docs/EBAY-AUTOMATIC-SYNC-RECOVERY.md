# Automatic recovery for existing eBay listing updates

Baseline: `ec1b87c53f021e9ce021f8598bcde4a6baa8e2fe`.

An interrupted quantity request can retain an unknown outcome indefinitely. Existing
listing sync checks that history before updating catalog content and pictures, so a
lost response can strand the entire saved sync. The recovery dialog can also retain
an obsolete error after a successful recovery handoff.

## Implementation contract

- Existing Sync owns the saved request through recovery and verified content
  completion. Repeated clicks coalesce; process restarts resume durable work.
- Inventory remains the sole quantity publisher. Automatic recovery applies only
  to verified existing listings and supported replacement/absolute-quantity
  operations, after excluding live local senders and checking every affected scope.
- Superseding an unknown request preserves its unknown outcome and immutable audit
  evidence. A local timeout is not proof that an eBay request terminated.
- Recovery atomically retains follow-up work. New writes use current canonical
  stock and current catalog content, never a replay of historical quantities.
- A durable recurring check continues after recovery, including after a successful
  readback. It detects late provider writes and uses the same publication and
  listing-sync owners to restore current stock and content. There is no assumed
  maximum delay after which an unknown remote request is declared harmless.
- Completion and progress distinguish verified listing content from stock
  publication. Genuine identity, permission, connection and catalog problems retain
  their protections and actionable UI; historical errors do not masquerade as the
  current state after recovery.

This provides eventual correction after delayed provider effects. It cannot make
eBay apply requests transactionally with Echelon, prevent every transient remote
overwrite, or establish the historical result of a lost response.

## Acceptance evidence

Implementation and validation results will be recorded here before review. Required
coverage includes real disposable PostgreSQL transactions, rollback and immutable
receipts; lost response and process restart; overlapping publishers and repeated
clicks; delayed old stock and photo writes after newer completion; and browser
progress from retry through verified completion. No production recovery or
publication is part of this change's local acceptance.
