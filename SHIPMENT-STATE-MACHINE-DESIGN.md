# Shipment State Machine & Engine Sync — Single-Flow Design

**Status:** Proposed — 2026-06-19. Awaiting approval; no implementation yet.
**Extends:** `SHIPSTATION-WMS-REFACTOR.md` (WMS-first routing) and the §6 commit series.
**Scope:** the WMS shipment lifecycle, how it syncs to the shipping engine (ShipStation today), and the migration off the current parallel-path design.

---

## 1. Why this exists

The fulfillment layer has produced a steady stream of incidents, almost all tracing to **two structural choices**. Recent fixes treated symptoms; this design removes the causes.

### A. `on_hold` is a lifecycle *status*
Setting `status = 'on_hold'` **overwrites** the shipment's real status, so the physical truth (was it `queued`? `labeled`? `shipped`?) is destroyed. Root of the status-regression class:

- post-ship refund/cancel flipped `shipped → on_hold` → order dropped out of fulfilled view (**#659**; 18 rows backfilled).
- a sales-channel cancel could not cancel an already-`on_hold` shipment, so channel-cancelled orders sat open (**#668**; 6 rows backfilled).
- `deriveWmsFromShipments` needs an `on_hold` "highest priority" hack to compensate.

### B. Shipment identity is keyed on the engine *order* id
But the unit that carries a label + tracking is the engine **shipment** (label). One engine order accrues many labels over time (void → relabel) and many at once (split), so they **collapse onto one WMS row**:

- a stale void clobbered a re-labeled shipment's live tracking (**#663**; order #58984).
- split handling only works because ShipStation happens to assign split shipments *distinct* order ids — fragile.

### C. Parallel path
Orders are pushed to ShipStation at WMS-sync **before picking**, so a hold races an async `engine.hold`, ship-before-pick happens, and there is no single guardrail. (#658 added a fenced ship-before-pick fallback as a temporary bridge.)

---

## 2. Target design

### 2.1 Linchpin — hold is a *flag*, not a status
A shipment has **two independent dimensions**:

- **lifecycle status** — physical truth, engine-owned: `planned → queued → labeled → shipped → delivered`, plus `cancelled`, `voided`, `returned`, `lost`.
- **`held`** — a boolean flag (+ `hold_reason`, `held_at`), WMS-intent-owned, layered on top.

`{queued, held}` and `{labeled, held}` are valid. A held shipment keeps its real status; **release just clears the flag**. `shipped` ignores `held` (it's done). This single change makes the entire status-regression class structurally impossible.

### 2.2 State machine

**Lifecycle (engine-owned physical facts), forward-only:**

| Event | from | to |
|---|---|---|
| create | ∅ | `planned` |
| push to engine | `planned` | `queued` |
| engine: label bought | `queued` | `labeled` * |
| engine: ship-notify | `queued`/`labeled` | `shipped` |
| engine: delivery scan | `shipped` | `delivered` |
| engine: returned / lost | `shipped` | `returned` / `lost` |
| cancel (pre-ship) | `planned`/`queued`/`labeled` | `cancelled` |
| engine: label void | (per label row) | `voided` |

\* *SS gives a bought label tracking + shipDate immediately, so today `labeled` collapses into `shipped` (0 rows are ever `labeled`). Kept in the model for engines/visibility that can distinguish "printed, not handed off."*

**Held (orthogonal), any pre-ship status:**

| Event | effect |
|---|---|
| hold(reason) | `held = true`, `hold_reason`, `held_at` + `engine.hold` |
| release | `held = false` + `engine.releaseHold` |

**Invariants:**
1. `shipped` (and delivered/returned/lost) is forward-only — only engine facts move it.
2. `cancel` is **pre-ship only**; a post-ship "cancel" is a **refund** and changes no lifecycle status.
3. a refund is financial — it never touches the shipment lifecycle (it may set `held` while under review, then resolve to release or cancel).
4. order `warehouse_status` is **derived** from its shipments, never written directly.

### 2.3 Engine-sync — ownership (single writer per fact)

The bidirectional sync only works if every fact has exactly one owner:

| Fact | Owner | Direction |
|---|---|---|
| label created · **shipped** · tracking · voided · delivered | **engine** | engine → WMS (webhook + reconcile) |
| `held` / released | **WMS intent** | WMS → engine (`hold` / `releaseHold`) |
| `cancelled` | **WMS intent** | WMS → engine (`cancel`) |
| contents / address | **WMS** | WMS → engine (upsert) |
| order `warehouse_status` | **derived** | from shipments |

**Reconciler convergence** (periodic + on webhook):
- engine shipped & WMS not → apply shipped (physical fact wins).
- WMS `held` & engine not held → `engine.hold`; WMS not held & engine held → `releaseHold`.
- WMS `cancelled` & engine not → `engine.cancel`.
- **never** regress `shipped` from a WMS-side intent.

"Only the engine sets `shipped`" stops being a rule to remember and becomes a *consequence of ownership*.

### 2.4 Identity — key on the engine *shipment* id

- `WMS order →(1:N) WMS shipments`. Each WMS shipment ↔ **one engine shipment (label)**, identified by the engine **shipment id**, grouped under a parent engine **order id**.
- **relabel:** void label A (its row → `voided`) + create label B (new row, live). No collapse.
- **split:** N labels → N WMS rows by construction.
- void/ship events target a specific shipment id → only that row changes. #663's "label of record" tracking-string guard becomes structural.
- The `engine_shipment_ref` column already exists (today it stores the orderKey); the migration repopulates it with the real engine shipment id.

### 2.5 Single push gate
One place pushes to the engine — at the allocation / pick-ready gate, behind the pick-before-push guardrail. A hold *before* the gate is WMS-only (nothing in the engine to hold yet); *after* the gate → `engine.hold`. Retires the wms-sync pre-pick push and the #658 fenced fallback.

---

## 3. Current state (verified 2026-06-19)

- **Engine port** (`server/modules/shipping/engine.ts`, "C9"): `cancel`, `hold`, `releaseHold`, `markShipped`, `getShipments`, `getState`, `normalizeWebhook` (a no-op today), `processWebhook`. Only **ShipStation** implements it (eBay/Shopify are channels but can mint labels).
- **Statuses today:** `planned`, `queued`, `labeled` (unused — 0 rows; SS reports a bought label as `shipped`), `shipped`, `on_hold` (a status), `cancelled`, `voided`, `returned`, `lost`.
- **Holds are inconsistent today:** a manual/order hold uses `engine.hold` (`holdUntil 2099`); the **refund** hold sets shipment `status='on_hold'` **and `engine.cancel`s** the SS order (for `queued`). The design makes every hold → `engine.hold`.
- **Identity today:** `outbound_shipments.shipstation_order_id` / `engine_order_ref` = engine **order**. Splits get a per-shipment `external_fulfillment_id = shipstation_shipment:<id>`, but the original row collapses by order id.
- **Two inbound paths:** legacy `processShipNotifyV2` (webhook) and `deriveReconcileEvent` (engine reconcile). `deriveReconcileEvent` already prefers a shipped label over voided ones; the legacy per-shipment path does not.
- **Parallel push:** `wms-sync.service.ts` pushes to SS at order creation, before picking.

---

## 4. Migration plan — phased, each independently shippable

### Phase 1 — Hold as a flag (+ hold-not-cancel)  *(highest value, lowest risk; answers the open question)*
- **Schema:** add `held boolean not null default false`, `held_at timestamptz`; reuse existing `on_hold_reason` as the reason.
- **Writers:** every hold path sets `held=true` and **keeps** the lifecycle status; release clears it. The refund-hold switches from `engine.cancel` → `engine.hold`.
- **Readers:** `deriveWmsFromShipments` and the Flow Monitor "on hold" / "review" buckets read `held` instead of `status='on_hold'` — **enumerate every `status='on_hold'` reader first** (this is the main risk).
- **Engine-sync:** `held → engine.hold`; released → `engine.releaseHold`.
- **Backfill:** existing `status='on_hold'` rows → `held=true` + restore the real lifecycle status (`shipped_at` present → `shipped`; else engine-ref present → `queued`; else `planned`). The worst offenders are already backfilled (#659/#668); this generalizes it and retires `on_hold` as a status.
- **Tests:** hold/release round-trip preserves the underlying status; refund-hold *holds* (not cancels) the engine order; deriveWmsFromShipments ignores `held` for the physical roll-up.

### Phase 2 — Ownership / reconciler convergence
- Consolidate so **only** the engine-event applier writes `shipped`/`voided`; the reconciler converges `held` and `cancelled` intent to the engine. Largely formalizes #659/#663/#668. Begin collapsing the two inbound paths toward one applier (legacy `processShipNotifyV2` → the canonical `dispatchShipmentEvent` applier).

### Phase 3 — Identity re-key to the engine shipment id  *(largest; gate behind a clean state machine)*
- Populate `engine_shipment_ref` with the real engine **shipment** id; match webhooks/reconcile by shipment id (fall back to order id during transition); model each label as its own row. Backfill historical rows from SS. Removes the void/relabel/split collapse class structurally.

### Phase 4 — Single push gate (retire the parallel path)
- Move the engine push from `wms-sync` (pre-pick) to the pick-ready gate; add the pick-before-push guardrail; retire the #658 fenced fallback.

---

## 5. Risks & open questions
- **`labeled` vs `shipped`:** SS can't cleanly separate "label printed" from "handed to carrier." Decision: keep collapsing `label → shipped` unless we want explicit "printed, not handed off" visibility (would need a carrier-scan signal).
- **Hold reliability:** the design only holds up if `engine.hold` genuinely removes the order from the shippable queue (no automation rule auto-buying a label). **Verify before trusting hold over cancel.**
- **Backfill correctness:** restoring the *real* lifecycle status under existing `on_hold` rows depends on `shipped_at` / engine-ref being trustworthy — spot-check before the bulk update.
- **Multi-engine future:** eBay / Shopify-direct as engines behind the same port — the design is engine-agnostic, but each must implement `hold`/`releaseHold` or declare "cancel-only" (then on_hold for that engine degrades to cancel, explicitly).

---

## 6. Decision log
- 2026-06-19 — drafted after the #659/#663/#665/#668 incident series. Open for review. Implementation starts at Phase 1 on approval.
