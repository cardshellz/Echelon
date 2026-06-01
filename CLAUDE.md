# Echelon — Engineering Standards & Agent Operating Rules

> This file is auto-loaded every session. It is the **authoritative coding contract**
> for any agent working in this repo. If a change violates these rules, it is invalid
> and must be rewritten. Architecture/system references live in `BOUNDARIES.md`,
> `SYSTEM.md`, `WMS_ARCHITECTURE.md`, and `SHIPSTATION-WMS-REFACTOR.md`.

This is a financial system. **Assume bugs cause financial loss.** Write code that
would pass a financial audit. Correctness > speed > cleverness, always.

---

## 1. Evidence Discipline (how to reason, debug, and review)

Do **not** guess. Do **not** infer missing implementation details unless you clearly
label them as assumptions. Only make claims directly supported by the code, logs,
config, or files provided.

For every conclusion:
1. Cite the exact file and function (or pasted snippet) it comes from.
2. Explain the reasoning from that evidence.
3. State what is still unknown.

If there is not enough evidence, say exactly what is missing instead of filling gaps.
Prefer **"I cannot verify this from the provided code"** over speculation.

**When debugging**, build a concrete trace before answering:
1. Identify the relevant files/functions.
2. Quote or reference the exact lines that matter.
3. Trace inputs, conditionals, side effects, and outputs end to end.
4. Check related config, env vars, schema, and error handling.
5. Separate facts from hypotheses, then give the answer.

Label any statement not grounded in the material as **HYPOTHESIS**. If grounding is
impossible, say **INSUFFICIENT EVIDENCE**. Never answer from general experience alone.

**Debug/analysis output format:**
- What the code definitely does
- What is likely happening
- What is not proven
- Next checks

---

## 2. Architecture

Enforce clean architecture and strict separation of concerns. No mixed responsibilities.

Layers:
- **Domain** — business logic (pure rules)
- **Application** — orchestration / use-cases
- **Infrastructure** — DB, external APIs (ShipStation, Shopify, eBay)
- **Interface** — HTTP routes / UI

**No business logic** in controllers, routes, views, or DB queries. Routes orchestrate;
they do not decide. (See `server/modules/*/**.routes.ts` vs `*.use-cases.ts` /
`*.service.ts`.)

Respect system boundaries (`BOUNDARIES.md`): each system calls INTO the next system's
public interface and never reaches into another system's tables directly.
- OMS owns order lifecycle. WMS owns inventory/picks/ships. Reservation goes through
  `reserveForOrder()` only — no raw SQL, no reimplementation.
- Never use `allowNegative: true`. If the math goes negative, flag it; don't force it.

---

## 3. Determinism

- No hidden state. No reliance on system time or randomness for financial outcomes —
  **inject the clock / seed** so behavior is reproducible and testable.
- Functions should be pure, or explicitly and obviously stateful.

---

## 4. Data Integrity & Money

- **Never use floating point for money.** Use integer cents or a decimal library.
- Never mutate input objects.
- Validate all inputs at system boundaries (webhooks, API responses, user input).
- Validate inbound **and** outbound data against explicit schemas.

---

## 5. Types & Contracts

- No implicit `any` at boundaries. Define DTOs, Zod schemas, and interfaces.
- Validate channel payloads (Shopify/eBay/ShipStation) before trusting them.

---

## 6. Error Handling

- No silent failures. Every error is caught, classified, logged.
- No empty `catch {}` that swallows financial state. Fire-and-forget is only acceptable
  for true side-channels (e.g., audit-log best-effort) and must be a deliberate,
  commented decision.
- Use structured errors: `{ code, message, context }` with a namespaced code.
- **Classify every error** as `transient` (retry with backoff), `permanent` (stamp
  `requires_review` + dead-letter; **stop retrying**), or `fatal` (abort + alert). Handlers
  branch on the class. **Never retry a `permanent` error** — that is how you get infinite-retry
  log spam against an already-terminal external state.
- Never ACK a webhook 200 when its work failed and should be retried — persist to the inbox
  first, then 2xx; otherwise return 5xx so the sender retries.

---

## 7. Idempotency (financial requirement)

Any retryable operation must be idempotent: order ingestion, OMS→WMS sync, inventory
adjustments, shipment push, SHIP_NOTIFY processing, fulfillment write-back.
- Use idempotency keys, unique constraints, advisory locks, and status checks.
- Duplicate/replayed webhooks must be safe.

---

## 8. Database Discipline

- Never do multi-step financial writes without a transaction + rollback protection.
- Wrap related mutations (e.g., inventory decrement + order-item status, or WMS order +
  items + reservation) in a single DB transaction. If any step fails, all roll back.
- Enforce integrity at the schema: foreign keys, unique indexes.
- Do **not** perform mutating side effects inside read/GET paths.

---

## 9. Concurrency Safety

No race conditions on balances, inventory, or order state. Use row locks, transactions,
and atomic conditional updates (e.g., claim-order via guarded `UPDATE ... WHERE status = ?`).
Re-check order state before mutating inventory (e.g., reject picks on cancelled/held orders).

---

## 10. Logging & Auditability

Every critical action logs who / what / when / before→after state, structured (JSON-able),
to an append-only trail (`inventory_transactions`, `picking_logs`, `oms_order_events`).
Logs that establish financial history are immutable.

- **One structured logger** (JSON), not raw `console.*`. Each line carries `level, action,
  outcome, before, after, error_code`. Level discipline: ERROR = needs a human, WARN = anomaly
  auto-recovered, INFO = state transition, DEBUG = detail. Expected/terminal conditions are DEBUG,
  not repeated WARNs.
- **Thread a correlation context** — `{ oms_order_id, wms_order_id, shipment_id, channel_event_id,
  engine_ref }` — on every log line and every emitted event, from intake to write-back. A single
  query on one order id must return its entire life story across OMS → WMS → shipping engine.
- Surface permanent failures as `requires_review` (with the structured code) and dead-letter
  un-processable events; alert on push failures, no-match events, and reconciler-correction rate.

---

## 11. Testing Requirements

Produce tests with the change:
- Unit tests for all business-logic paths.
- Integration tests for DB interactions and external APIs (mocked).
- Edge cases: zero values, max values, invalid input, concurrency, partial failure,
  duplicate/replayed events.
Behavior must be deterministic and test-friendly (inject clock/seed; minimal hidden
side effects).

---

## 12. Security

Never trust input. Sanitize everything. No secrets in code — use env vars. No unsafe
`eval`, no injection risks (parameterize SQL), secure defaults.

---

## 13. Readability

Boring > clever. Code should be obvious to a senior engineer in 30 seconds. Consistent
naming, small focused functions, modular design. No magic numbers — name and document
constants. Document non-obvious decisions, assumptions, and tradeoffs inline (the WHY,
not the WHAT).

---

## 14. Before Finishing — self-review checklist

- Reviewed for bugs, edge cases, and failure modes (concurrency, bad data, partial failure).
- No floating-point money; all inputs validated; no DB writes from controllers; no
  swallowed errors; no hidden side effects; no non-idempotent financial operations.
- Removed dead code, misleading comments, unnecessary complexity.
- Preserved backward compatibility unless a breaking change was explicitly requested.
- Result is cohesive and production-ready.

---

## 15. Required Output For Every Change (PR / summary)

Always state:
- **Summary of changes**
- **Assumptions made** (clearly labeled)
- **Risks**
- **Test coverage** (what's covered, what isn't)
- **Failure modes**

---

## 16. Absolute Prohibitions

Never: use floating point for currency · skip validation · write to the DB directly from
controllers/routes · ignore error handling · create hidden side effects · introduce
non-idempotent financial operations · use `allowNegative: true` · commit secrets.

---

## Project-specific operational notes

- **Database:** uses the EXTERNAL database (`EXTERNAL_DATABASE_URL`), not Replit's. The
  dev database is empty; production is on Heroku (`cardshellz-echelon`).
- **Money:** confirm the unit (cents vs decimal) of any financial column before computing.
- **Migrations:** numbered SQL files in `migrations/`; `server/db.ts` has fallback
  startup migrations.
- **Shipping engine:** fully engine-agnostic via `shippingEngine.*` interface (C9 complete).
  ShipStation adapter is the only implementation. Legacy `shipstation_order_id` /
  `shipstation_order_key` columns remain on `oms.oms_orders` and `wms.outbound_shipments`
  as back-compat shadow columns with dual-writes. **TODO (post-soak):** drop legacy columns,
  remove dual-writes in `pushOrder()` / `pushShipment()`, and delete COALESCE fallbacks.
