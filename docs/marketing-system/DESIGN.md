# Helm — In-House Marketing Engine: Design Document

> Status: **APPROVED** — all seven deferred decisions (D1–D7, §3) user-confirmed
> as recommended on 2026-08-08. Input: `DISCOVERY.md` (all 9 rounds answered).
> Working name: **Helm** (the marketing module inside Archon). Rename freely —
> the name only appears in schema/module identifiers at implementation time.
>
> Implementation target: the **Archon repo** (`cardshellz/archon`), as a bounded
> module. This doc lives in Echelon's repo because discovery ran here; copy or
> move it into `archon/docs/` when implementation begins. Echelon-side changes
> (hardening the order-event push) are called out explicitly in §6.3.

---

## 1. Goals & non-goals

**Goals** (from discovery):
- Replace Klaviyo entirely — campaigns, flows, lists/segments, forms-fed
  signups, SMS — with Resend as the email delivery provider.
- Generic by construction: any Shopify or marketplace store connects through
  the same connector + canonical-event contract with zero engine changes
  (Q1.1, Q5.1). Card Shellz Shopify at launch; Hobby Hive within 12 months.
- Aggressive timeline: campaign-parity cutover in ~4–6 weeks (Q1.2, Q9.4).
- Behavioral segmentation and all four live flow families (welcome, abandoned
  checkout, back-in-stock, post-purchase/winback) before Klaviyo flows turn
  off (Q7.1, Q7.3).
- AI agents as first-class operators behind non-overridable server-side
  guardrails (Q7.4).
- Solo + AI-agent operations: near-zero-touch, aggressive alerting (Q1.4).
- Sized for 500k profiles / 5M emails-month without redesign (Q9.3).

**Non-goals for v1** (explicitly deferred, design must not preclude):
- SMS sending (fast-follow phase — Q3.1); ad-audience sync (Meta/Google
  Customer Match); social content; push notifications (Q2.2).
- Transactional email (separate stream design reserved — Q3.3).
- A/B testing and send-time optimization (variant-shaped send log reserved —
  Q7.2); topic-level preference center (topic-ready data model — Q6.3).
- GDPR machinery (US + Canada only — Q6.1).
- SaaS packaging (kept extractable, not built — Q1.1).

---

## 2. System context & boundaries

```
  Shopify store(s) ─┐  webhooks/API           ┌─ Resend (email port)
  Web snippet ──────┤                          ├─ Twilio (SMS port, phase S)
  Shellz Club ──────┼─► CANONICAL EVENT API ──►│
  Echelon OMS ──────┘   (Helm ingestion)       └─ [future: ads/social ports]
                              │
        ┌─────────────────────▼──────────────────────┐
        │  HELM (marketing schema + module in Archon) │
        │  profiles · consent · events · segments     │
        │  journeys · campaigns · messages · stats    │
        └─────────────────────┬──────────────────────┘
                              │ published module interface (TS) 
              Archon UI / tRPC / AI agents (operators)
```

Boundary rules (Echelon BOUNDARIES.md discipline, adopted verbatim per Q9.1):
- Helm owns every table in the `marketing` schema. **No other Archon code
  writes them; Helm writes nothing outside them.** All access via the
  published TS interface (`server/marketing/index.ts` in Archon).
- No cross-schema joins between `marketing.*` and Archon's existing tables,
  even though they share a database (Q4.2). The interface is the boundary.
- External replaceable vendors sit behind **ports**: `EmailProvider` (Resend
  adapter first), `SmsProvider` (Twilio recommended), future
  `AudienceProvider`. No `resend_*` identifiers outside the adapter — generic
  `(provider, provider_message_id)` pairs, mirroring Echelon's
  `(engine, engine_ref)` rule.
- Sources (stores/apps) integrate ONLY by producing canonical events through
  the ingestion contract (§5). Connectors are anti-corruption adapters; no
  Shopify field names past the connector.

**Why this shape** (recap of decided rationale): everything enters as a
canonical event and exits through a port, so "connect any store" and "swap
any vendor" are structural properties, and extraction to a standalone service
later = lift schema + put HTTP in front of the same interface.

---

## 3. Resolved design decisions (the seven deferred from discovery)

> All seven confirmed by the owner on 2026-08-08, each as recommended:
> D1 Postgres queues · D2 Helm-owned profile store · D3 first-party snippet in
> v1 · D4 per-store platform catalog sync · D5 per-source opt-in policy ·
> D6 click-based attribution · D7 own link/open tracking.

### D1. Queue infrastructure → **Postgres queues (Echelon pattern)** (Q4.3)
5M emails/month ≈ 170k/day average; a worst-case full-list campaign is ~500k
messages in a day. A `FOR UPDATE SKIP LOCKED` claim loop on an indexed,
partitioned jobs/messages table handles this with enormous headroom — Echelon
already proves the pattern (channel-fulfillment outbox, PO email outbox), and
the true bottleneck is the provider rate limit, not the queue. Redis/BullMQ
would add a second stateful service, a second failure domain, and new
operational surface for a solo operator, and buys nothing at this scale.
Revisit only past ~10× the target. Advisory-lock scheduler exclusion +
per-worker kill-switch env vars, copied from Echelon.

### D2. Identity master → **Helm owns the profile store** (Q4.4)
`marketing.profiles` (+ identities, consent, merges) is the canonical customer
identity for marketing. Archon's existing `customers` table remains what it
actually is today — an analytics cache fed by sync jobs — and is progressively
demoted: Phase 2 adds a one-way projection (Helm → a read model the dashboards
can use), and customer-intel reads migrate to the Helm interface over time.
Rationale: the existing `customers` pipeline has documented intake-quality
problems (no HMAC verification called, events ACKed-and-lost, hardcoded
workspace, dead code paths), no alias/merge machinery, and no consent model.
Evolving it in place means carrying that debt into a legally auditable store;
a fresh store with a strict writer is cheaper and extraction-clean. Seed it
from `customers` + Shopify + Klaviyo exports at migration (§10).

### D3. Web tracking snippet → **Yes, v1 — built in Phase 3** (Q5.2)
Behavioral segmentation is a day-one requirement (Q7.3) and the Klaviyo
snippet is live today (Q2.3), so browse behavior is part of current parity.
A minimal first-party snippet (~2 KB): anonymous id cookie, `product.viewed`,
`session.active`, identify-on-click (links in Helm emails carry a profile
token) and identify-on-signup. It posts to the same canonical event API as
every other source. Not needed for campaign cutover (Phases 0–2) — needed
before flow cutover completes.

### D4. Catalog source → **Per-store platform sync** (Q5.3)
Each connected store syncs its own catalog from its platform (Shopify
products API first) into `marketing.catalog_items`, keyed
`(store_id, external_product_id, external_variant_id)` with title, image,
price cents, url, stock state. Fully generic — works for Hobby Hive and any
foreign store with zero engine changes. Echelon's richer catalog is NOT wired
in v1 (it would special-case Card Shellz inside the engine); if stock-truth
precision matters later, Echelon can push `product.stock_changed` canonical
events like any other source. Back-in-stock triggering keys off Shellz Club's
`back_in_stock.requested` events + catalog stock state.

### D5. Consent policy → **Per-source: single opt-in for checkout & club signup; double opt-in for site forms/popups** (Q6.2)
Checkout and club signup are high-intent, identity-verified contexts —
single opt-in, recorded as **express** consent with evidence. Site
popups/forms are where bots and typos enter — double opt-in (confirmation
email before sendable) protects list quality and gives CASL-grade proof.
CASL requirements encoded in the ledger itself: every consent row carries
`basis` (express | implied), `evidence` (source payload snapshot), and
`expires_at` — implied consent (e.g. a purchase without the checkbox) expires
2 years after the transaction and the engine stops sending unless refreshed.

### D6. Attribution → **Click-based last-touch, 5-day window, per-workspace config** (Q8.1)
An order attributes to the last Helm message the profile **clicked** within
5 days before `order.placed`. Opens never attribute (Apple MPP inflation).
Stored as computed rows (`marketing.attributions`) written by a worker that
joins order events to message-click events, so the model + window are
workspace config and history can be recomputed. Expect reported revenue to
drop vs Klaviyo's open-inclusive numbers at cutover — same reality, honest
counting; called out in the cutover comms (§10).

### D7. Link/open tracking → **Own link wrapping + own open pixel, per-store tracking domain; Resend webhooks for delivery/bounce/complaint** (Q8.2)
Attribution (D6) needs click events joined to messages — owning the redirect
(`links.<store-domain>/r/<token>`) keeps that first-party, branded, and
provider-portable; Resend's built-in tracking would tie click data and
link-domain branding to the vendor. Build cost is one redirect endpoint + a
token table. Opens via own 1px pixel, stored but directional-only. Resend
webhooks remain authoritative for `sent/delivered/bounced/complained`.

---

## 4. Data model (`marketing` schema)

All money integer cents; all tables carry `workspace_id`; timestamps
`timestamptz`; every mutation through the module interface. Partitioned
tables marked ⊞ (monthly range partitions, pruned per retention policy —
designed day one per Q9.3).

**Tenancy & sources**
- `stores` — one row per connected store/app source: `workspace_id`,
  `kind` (shopify | ebay | web | shellz_club | echelon | import | manual),
  `name`, `status`, `config` jsonb (non-secret).
- `store_credentials` — encrypted secrets per store (reuses Archon's
  encryption helper): access token, webhook secret (per-store HMAC —
  fixing the global-secret weakness Echelon's Shopify intake has), API keys
  for inbound event auth.

**Ingestion**
- `event_inbox` ⊞ — durable raw intake: `idempotency_key` UNIQUE
  (`source:topic:external_id` or payload hash), `store_id`, `topic`, `payload`
  jsonb, `status` (received | processing | succeeded | failed | dead),
  `attempts`, `next_attempt_at`, `last_error` jsonb. Persist **before** ACK;
  Echelon inbox semantics verbatim.
- `events` ⊞ — canonical, immutable: `profile_id`, `store_id`, `name`,
  `occurred_at`, `properties` jsonb, `source_event_id`,
  UNIQUE (`store_id`, `name`, `source_event_id`) for replay safety. bigint
  identity PK = watermark for downstream consumers (segment eval, triggers).

**Identity & consent**
- `profiles` — `id`, `workspace_id`, `primary_email`, `primary_phone`,
  `attributes` jsonb (first/last name, location, tier snapshot…),
  `lifecycle_stage` (computed), `created_at/updated_at`.
- `profile_identities` — `profile_id`, `kind` (email | phone |
  shopify_customer_id | shellz_member_id | ebay_buyer | anonymous_id),
  `value`, `store_id` nullable, UNIQUE (`workspace_id`, `kind`, `value`).
  Identity resolution: match inbound event identities in precedence order
  (explicit platform id → email → phone → anonymous id); no fuzzy matching.
- `profile_merges` — append-only merge history (`winner_id`, `loser_id`,
  `reason`, `merged_by`); losers keep a tombstone redirect.
- `consents` — **append-only ledger** (audit-grade, CASL): `profile_id`,
  `channel` (email | sms), `topic` (default `marketing` — topic-ready per
  Q6.3), `store_id`, `status` (granted | revoked), `basis` (express |
  implied), `method` (checkout | club_signup | form_double_optin | import |
  preference_page | sms_keyword), `evidence` jsonb, `occurred_at`,
  `expires_at` nullable. Current state = latest row per
  (profile, channel, topic, store); a partial index materializes it.
- `suppressions` — `workspace_id`, `channel`, `address` (normalized email or
  E.164 phone), `reason` (hard_bounce | complaint | unsubscribe | manual |
  import), `source`, `created_at`, UNIQUE (`workspace_id`, `channel`,
  `address`). **Checked at send time, always, no bypass path — including for
  AI-initiated sends.**

**Audience**
- `segments` — `definition` jsonb: a small rule AST
  (`all/any` groups over profile-attribute predicates AND event predicates —
  `{event: "order.placed", within_days: 90, count_gte: 1}`), `status`,
  `refreshed_at`.
- `segment_memberships` — `segment_id`, `profile_id`, `entered_at`,
  `exited_at` nullable. Incrementally updated by the segment worker on new
  events/profile changes (watermark over `events.id`); nightly full-rebuild
  reconciler repairs drift and logs a correction-rate metric (alert if high).
- `lists` — static membership (`list_id`, `profile_id`) for imports/one-offs.

**Content**
- `templates` — metadata + builder document (Archon's visual builder output
  moves here or is referenced); `template_versions` — **immutable** rendered
  HTML/text + variable manifest; every send records the exact version id.
- `catalog_items` — per D4.
- `coupon_pools` / `coupons` — pool config (prefix, value, expiry) +
  generated codes; codes created through the store connector's
  `createCoupons` capability (Shopify discount API first per Q5.4), assigned
  one-per-message at render time, UNIQUE (`pool_id`, `assigned_message_id`).

**Orchestration**
- `campaigns` — `audience` (segment/list ref), `template_version_id`,
  `variant` fields reserved (single variant in v1 — Q7.2), `stream`
  (marketing | transactional — reserved), `scheduled_at`, `status`
  (draft | scheduled | fanning_out | sending | sent | cancelled),
  `sandbox` bool, `created_by` (user | agent:<id> — Q7.4 audit).
- `journeys` / `journey_versions` — immutable definition jsonb: trigger
  (`event` | `segment_entered` | `date_property`), steps DAG (send | wait
  {duration | until} | branch {predicate} | exit), exit conditions, quiet
  hours, re-entry policy. Activating = new version; running profiles finish
  on their version.
- `journey_runs` — one per profile per active journey: `journey_version_id`,
  `profile_id`, `current_step`, `state` jsonb, `wake_at`, `status`
  (active | completed | exited | failed), UNIQUE active per
  (`journey_id`, `profile_id`). The wake scheduler claims due runs via
  SKIP LOCKED. **Every step transition is idempotent** — step execution
  writes a `(run_id, step_id)` guard row; replays no-op.

**Delivery**
- `messages` ⊞ — one row per message: `profile_id`, `channel`, `to_address`,
  `campaign_id` | (`journey_run_id`, `step_id`), `template_version_id`,
  `stream`, `idempotency_key` UNIQUE (deterministic:
  `campaign:<id>:profile:<id>` / `run:<id>:step:<id>`), `status` (queued |
  rendered | sent | delivered | bounced | failed | suppressed | sandboxed),
  `provider`, `provider_message_id`, `error` jsonb, timestamps. **The
  suppression/consent/frequency check is INSIDE the send transaction**, not
  at enqueue time.
- `message_events` ⊞ — delivery lifecycle + engagement: `message_id`, `type`
  (sent | delivered | bounce | complaint | open | click | unsubscribe),
  `occurred_at`, `meta` jsonb (url, user-agent), from Resend webhooks (via
  `event_inbox`) and own pixel/redirect.
- `tracked_links` — `message_id`, `token` UNIQUE, `destination_url`.
- `send_policies` — per-workspace guardrails: frequency caps (e.g. max N
  marketing emails per profile per 7 days), quiet hours, per-agent daily send
  budget, sandbox seed list. **Enforced in the send pipeline; not overridable
  through the module interface** (Q7.4).

**Analytics & ops**
- `attributions` — per D6. `campaign_stats` / `journey_stats` — rolled up
  counters (sends, delivered, clicks, revenue cents), feeding Archon
  `daily_metrics` and the AI analyst context (Q8.3).
- `jobs` — generic Postgres work queue (type, payload, run_at, attempts,
  status, SKIP LOCKED claims) for anything not modeled by its own table;
  `dead_letters` — terminal failures with structured error + replay support.
- `audit_log` — append-only who/what/before→after for every operator action
  (human or agent), per the engineering contract.

---

## 5. Canonical event contract (the "works with any store" seam)

Envelope (Zod-validated at the boundary — no implicit `any`):

```ts
{
  source_event_id: string,      // idempotency within (store, name)
  name: string,                 // from the vocabulary below
  occurred_at: string,          // ISO-8601
  identities: [{ kind, value }],// at least one; resolution per §4
  properties: object            // event-specific, validated per event name
}
```

Ingestion paths: `POST /api/marketing/v1/events` (batch ≤ 500, per-store API
key) for app sources and the web snippet; connector webhooks land in
`event_inbox` first and are normalized asynchronously. 2xx only after the
inbox row is durable (Echelon rule: never ACK work you might lose).

**v1 vocabulary** (closed set; connectors map INTO it, unknown names rejected):

| Event | Producers | Consumed by |
|---|---|---|
| `profile.identified` | all sources, snippet, forms | identity resolution |
| `consent.granted` / `consent.revoked` | checkout, forms, prefs page, SMS keywords, import | consent ledger |
| `order.placed / fulfilled / refunded / cancelled` | Echelon (primary), Shopify connector (foreign stores) | segments, journeys, attribution |
| `checkout.started` | Shopify connector | abandoned-checkout journey |
| `product.viewed` / `session.active` | web snippet | segments, browse triggers |
| `back_in_stock.requested` | Shellz Club | back-in-stock journey |
| `member.created` / `member.plan_changed` | Shellz Club | segments, tier journeys |
| `product.stock_changed` | connectors (catalog sync) | back-in-stock release |

Adding an event name = vocabulary PR + schema for its properties; connectors
never invent names. This table is the entire integration contract a new store
must satisfy — the "no custom coding per store" guarantee.

**Connector SPI** (per store kind): `verifyWebhook(headers, raw)` (per-store
secret), `registerWebhooks()`, `normalize(topic, payload) → CanonicalEvent[]`,
plus optional capabilities: `syncCatalog()`, `createCoupons(pool, n)`,
`readConsent()` (backfill), `syncAudience()` (future ads). Shopify connector
is the reference implementation; its webhook set: `orders/*`,
`checkouts/create|update`, `customers/create|update` (consent!),
`products/*` + inventory for catalog.

---

## 6. Source integrations at launch

**6.1 Shopify (Card Shellz)** — full connector per §5. Note Shopify customer
webhooks carry `email_marketing_consent`/`sms_marketing_consent` — the
connector emits `consent.*` events from them, closing today's gap where
consent dies unparsed in raw payloads.

**6.2 Shellz Club** — replaces its 997-line `klaviyo.ts` with one small
emitter posting `member.*`, `back_in_stock.requested`, and `consent.*`
canonical events to the ingestion API. Its per-plan Klaviyo list churn
becomes a Helm segment rule (`plan_name = X`), deleting that machinery.

**6.3 Echelon (changes in THIS repo)** — the existing `mc-push.ts`
fire-and-forget POST becomes a durable outbox: order lifecycle events write
an outbox row in the same transaction as the OMS event, a worker delivers to
Helm's ingestion API with retry/backoff/DLQ (pattern already exists —
channel-fulfillment outbox), and the hardcoded fallback secret is removed
(env-only, per CLAUDE.md §16). Helm additionally polls
`GET /api/internal/orders` on a slow schedule as the reconciliation sweep,
mirroring the carrier-tracking projection precedent.

**6.4 Klaviyo (one-time import)** — migration-only source (§10): profiles,
list memberships, email consent + suppression, SMS/TCPA consent records,
historical engagement (opens/clicks if exportable) as backdated events.

---

## 7. Sending pipeline

```
audience resolve → fan-out (message rows, idempotent) → render (template
version + variables + coupon + wrapped links) → policy gate (consent ∧ not
suppressed ∧ frequency cap ∧ quiet hours ∧ sandbox?) → provider port →
webhook lifecycle updates → stats rollup
```

- **Fan-out** inserts `messages` with deterministic idempotency keys —
  re-running a crashed fan-out cannot double-send (financial-grade rule).
- **Policy gate runs inside the send transaction** at dispatch time, not
  enqueue time — a profile who unsubscribes between schedule and send is
  caught. Gate refusals stamp `status = suppressed` with the structured
  reason; they are DEBUG-level expected outcomes, not errors.
- **Throttle**: token-bucket per (provider, sending domain), configured by
  warm-up schedule (§10) then steady-state limits; batches use Resend's batch
  endpoint (verify current size/rate limits at implementation — request an
  increase for campaign bursts).
- **Sandbox** (Q9.2): workspace/campaign flag; renders and logs everything,
  delivers only to the seed list, stamps `sandboxed`. New journeys activate
  sandbox-first, always.
- **Streams**: `marketing` vs `transactional` reserved on every message;
  transactional (later, Q3.3) gets a separate sending subdomain and skips
  marketing suppression (still honors hard bounces).
- **Compliance baked into render**: CAN-SPAM footer (physical address),
  working unsubscribe link, `List-Unsubscribe` + `List-Unsubscribe-Post`
  (RFC 8058 one-click) headers on every marketing email; CASL sender
  identification. Unsubscribe endpoint writes `consent.revoked` +
  `suppressions` and requires no login.

**Ports**: `EmailProvider.send(batch) → [{provider_message_id | error}]`,
`verifyDomain()`, webhook verification helper. Resend adapter first;
`SmsProvider` (Twilio recommended — D-recommendation from Q3.2; number
port-vs-fresh decided after the Klaviyo number-type check) implements the
same shape with segment-count/cost metadata. Errors classified
transient/permanent/fatal per the contract; permanent → dead-letter +
`requires_review`, never retried.

---

## 8. Journey runtime

- **Trigger evaluation**: a worker tails `events` by id watermark; matching
  events open `journey_runs` (unique-active guard prevents duplicates;
  re-entry policy per journey). Segment-entry triggers key off
  `segment_memberships.entered_at`.
- **Wake scheduler**: claims runs with `wake_at <= now()` via SKIP LOCKED,
  executes the current step, writes the step-guard row + next `wake_at`
  atomically. Crash between claim and commit → lease expiry → safe re-claim →
  guard row makes re-execution a no-op.
- **Exit conditions** evaluated at every wake AND on relevant events (e.g.
  `order.placed` exits an abandoned-checkout run immediately via the trigger
  worker, not waiting for the next wake).
- **The four launch journeys** are expressed purely in the definition DSL —
  no journey-specific code. That's the test that the runtime is generic:
  1. *Welcome*: trigger `consent.granted` (email, first grant) → send → wait
     2d → branch on `order.placed` since entry → send variant.
  2. *Abandoned checkout*: trigger `checkout.started` → wait 1h → exit-if
     `order.placed` → send (with checkout contents + coupon) → wait 23h →
     exit-if → send.
  3. *Back in stock*: trigger `back_in_stock.requested` → wait-until
     `product.stock_changed(in_stock)` for that item (with expiry) → send.
  4. *Post-purchase/winback*: trigger `order.placed` → wait 7d → send
     (review/cross-sell) → wait 90d → exit-if new order → send winback.
- **Stuck-run reconciler**: alerts on runs past `wake_at` by > tolerance and
  on failed runs; dead-letters after max attempts. Solo-operator rule: every
  reconciler alert is actionable or it doesn't alert.

---

## 9. Module interface, AI operators & guardrails

One published TS interface consumed by Archon tRPC routers (UI) and AI agents
identically: profiles/consent lookups, segment CRUD + preview-count, template
listing, campaign create/schedule/cancel, journey CRUD + activate
(sandbox-first), stats reads. Every call carries an actor
(`user:<id>` | `agent:<id>`) written to `audit_log`.

Guardrail layers the interface can NEVER bypass (enforced in the engine, per
Q7.4): consent + suppression gates; frequency caps and quiet hours;
per-agent budgets (max recipients/day, max sends/day) from `send_policies`;
approval thresholds (sends above N recipients or outside sandbox require a
human approval record — threshold per workspace, so autonomy can widen as
trust grows). The AI analyst keeps its generate→approve pipeline in Phase 1,
now targeting Helm instead of Klaviyo export; agentic operation deepens after
cutover, inside these rails. Campaign/journey stats feed the analyst prompt
(Q8.3), closing the learning loop Klaviyo never provided.

---

## 10. Migration & cutover plan (aggressive: ~4–6 weeks to campaign cutover)

**Prereqs (user actions, from the discovery parking lot):** Klaviyo dashboard
inventory (exact flow configs, forms, SMS number type); Klaviyo exports
(profiles, suppression, email + SMS consent); Resend account creation; DNS
records for sending + tracking subdomains (e.g. `mail.cardshellz.com`,
`links.cardshellz.com`); seed-list membership.

**Seed** (Q6.4, conservative): import Shopify customers + consent state,
Klaviyo profiles/suppression/consent (email AND SMS/TCPA records, preserved
verbatim in `consents.evidence`), Shellz members. **Nobody without
affirmative evidence is sendable.** Klaviyo engagement history imports as
backdated events so engagement-based warm-up segments exist on day one.

**Warm-up** (cold domain, 30k list, low prior volume): start sends the day
Phase 1 works — engaged-first ramp roughly 500 → 1k → 2.5k → 5k → 10k →
full-segment sends over ~3–4 weeks, monitoring bounce/complaint rates with
automatic ramp-halt thresholds (complaint > 0.1%, hard bounce > 2% pauses the
schedule and alerts). Klaviyo continues normal operation during ramp
(dual-run); Klaviyo tier downgrade at campaign cutover, cancellation after
flow cutover + SMS migration.

**Flow cutover**: one family at a time — build in sandbox → verify against
the Klaviyo inventory → enable in Helm + disable in Klaviyo in the same
change window (double-delivery guard: never both live). Suppression/consent
deltas re-imported from Klaviyo immediately before each cutover step.

**SMS fast-follow** (Q3.1): Twilio setup + number decision, TCPA consent
verified from import, quiet-hours + STOP/HELP handling via the same policy
gate, then Klaviyo SMS off and Klaviyo cancelled.

**Attribution expectation-setting**: reported campaign revenue will read
lower than Klaviyo's open-inclusive model (D6) — same reality, stricter
counting. Noted here so the first post-cutover report isn't a surprise.

---

## 11. Phased build

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Foundation** (wk 1) | `marketing` schema migrations; profiles/identities/consents/suppressions; imports (Shopify, Klaviyo, Shellz, `customers` seed); Resend + DNS setup; Archon CLAUDE.md engineering contract; structured logger + correlation context for the module | Imported profiles queryable; consent state provably correct on samples; contract merged |
| **1 — Campaign sending** (wk 2–3) | Templates/versions; messages + send pipeline + policy gate; Resend adapter + webhooks; unsubscribe endpoint + headers; sandbox + seed list; link wrapping + pixel; warm-up throttles; campaign scheduled sends; ops alerts | First real campaign sent via Helm to an engaged segment; warm-up ramp running; unsubscribe verified end-to-end |
| **2 — Events & segments** (wk 3–4) | Event inbox + canonical API; Shopify connector (webhooks, consent, catalog); Echelon outbox hardening (Echelon-side PR); Shellz emitter; behavioral segment engine + rebuild reconciler; stats rollups → daily_metrics | Behavioral segments live and reconciler-verified; **campaign cutover complete — Klaviyo campaigns off, tier downgraded** |
| **3 — Journeys** (wk 4–6) | Journey runtime (triggers, wake scheduler, guards, reconciler); the four flow families sandbox→live; web snippet; coupon capability; attribution worker | All four families live in Helm, Klaviyo flows off |
| **S — SMS fast-follow** (wk 6–8) | Twilio adapter, number, TCPA gate, STOP/HELP, SMS journeys/campaigns | Klaviyo SMS off; **Klaviyo cancelled** |
| **4+ — Growth** | A/B variants; topic preference center; transactional stream; ad-audience port (Meta/Google); deeper agentic operation; Hobby Hive workspace onboarding (the generic-connector proof) | — |

Weeks are calendar targets against the aggressive appetite (Q9.4), assuming
solo + AI-agent build cadence; Phase 2's Echelon-side PR is the only
cross-repo dependency.

---

## 12. Risks & failure modes

- **Deliverability transition** (highest risk): cold domain + ambition to
  send more than historical volume. Mitigations: engaged-first ramp,
  automatic ramp-halt thresholds, conservative consent seed, one-click
  unsubscribe, complaint monitoring from day one. Accepting residual risk
  was an explicit discovery decision (Q9.4).
- **Double-send bugs**: mitigated structurally (deterministic message
  idempotency keys, step-guard rows, unique active runs) and by
  sandbox-first activation; a duplicate send is treated as a sev-1 class
  financial bug per the contract.
- **Consent gaps**: unknown = not sendable; append-only ledger with
  evidence; CASL implied-consent expiry enforced by the policy gate, with an
  expiry-sweep worker emitting `consent.revoked`.
- **Klaviyo-side unknowns**: dashboard flow configs may contain logic not in
  the four assumed families — the manual inventory (§10 prereqs) gates flow
  cutover, not the build start.
- **Archon codebase quality**: existing intake paths are explicitly NOT
  reused (D2); the engineering contract applies to all new module code; the
  module boundary protects Helm from the legacy paths.
- **Solo-operator overload**: every worker has DLQ + replay + one actionable
  alert stream (Discord, reusing Echelon's log-drain alerting convention);
  reconcilers self-heal drift and alert only on anomaly.
- **Provider limits**: Resend rate/batch limits verified and increase
  requested before first large campaign; throttle config makes limits a
  config value, not a code change.

## 13. Open items

1. Klaviyo dashboard inventory + exports (user; gates §10, not build start).
2. Resend account + DNS records (user, Phase 0).
3. Name check: `marketing` schema + "Helm" module naming sign-off.
4. Twilio number strategy after the Klaviyo SMS number-type check.
5. Verify current Resend batch size / rate limits / webhook event set at
   Phase 1 implementation (documented values move fast).
6. Where Archon's visual builder documents live vs `templates` (Phase 1
   detail — likely a move with a compatibility view).
