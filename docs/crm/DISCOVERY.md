# In-House Marketing System — Discovery Q&A

> Status: **COMPLETE** — all 9 rounds answered; design doc written (`DESIGN.md`)
> and its seven deferred decisions user-confirmed 2026-08-08.
> Naming note (post-discovery): the schema/module referred to below as
> "`marketing`" was finalized as **`crm`** on 2026-08-08 (see `DESIGN.md` status
> note). Answers are preserved verbatim as the historical record.
> Goal: replace Klaviyo with an in-house marketing/email/SMS system (Resend as the
> email delivery engine), generic enough that any Shopify/marketplace store can
> connect with zero custom coding.
>
> Context established prior to this Q&A (from code mapping of both repos):
> - **Archon** (`cardshellz/archon`, Heroku `archon-os`) is the marketing/brain app:
>   customers, segments, flows/templates/campaigns tables, visual email builder,
>   provider-adapter registry, AI campaign generation. All actual sending is Klaviyo.
> - **Echelon** (this repo) owns OMS/WMS, multi-store channel connections, and the
>   proven durable inbox/outbox/retry/DLQ patterns.
> - **Shellz Club** (separate app) syncs members to per-plan Klaviyo lists and pushes
>   back-in-stock events; Klaviyo-dashboard-side flows are presumed live (invisible
>   to code — must be inventoried).
> - Code-level Klaviyo usage is narrow: template CRUD, lists, profile import,
>   immediate campaigns. No flows API, no metrics pull.
> - No consent/marketing-opt-in capture exists anywhere today; Shopify consent
>   survives only in raw order payloads.

Answers are recorded verbatim-ish under each question as they are given.
`—` means not yet asked/answered.

---

## Round 1 — Business intent & shape

**Q1.1 Is this a sellable multi-merchant product (SaaS) someday, or an internal
tool that is merely built generic?**
Drives: tenancy model, in-Archon module vs standalone service, auth/billing scope.
> A: **Undecided — keep the option open.** Build with strict boundaries + tenancy
> columns so extraction into a standalone product later is mechanical, not a
> rewrite. No SaaS auth/billing scope now.

**Q1.2 What is the timeline pressure? Is there a Klaviyo renewal date or cost
driver forcing a cutover-by date?**
> A: **ASAP — the Klaviyo cost is hurting now.** Implication: sequence for the
> earliest possible cutover of paid usage (campaign-parity first, flows next);
> consider downgrading the Klaviyo tier mid-build.

**Q1.3 Which stores/sources must be connected at launch, and what does the
12-month store roadmap look like?**
> A: **Card Shellz Shopify at launch; Hobby Hive within ~12 months.** eBay-channel
> buyers and a second Shopify store were NOT selected as launch requirements.
> Hobby Hive arrives as a separate workspace/tenant.

**Q1.4 Who operates and maintains this long-term? What is the acceptable ongoing
ops burden?**
> A: **Solo + AI agents.** Design for near-zero-touch operations: aggressive
> alerting, self-healing reconcilers, boring technology, no ops rotations.

## Round 2 — Current Klaviyo state (migration inventory)

**Q2.1 Which flows are LIVE in the Klaviyo dashboard today? These are invisible
to code and are the true replacement checklist.**
> A: **All four families are live: welcome series, abandoned checkout,
> back-in-stock, post-purchase/winback.** (Why this matters: these exist only as
> Klaviyo-dashboard configuration — no repo contains them — so they are the
> hidden cutover checklist; each must be rebuilt and verified in the new engine
> before Klaviyo can be shut off.)

**Q2.2 Current scale: profiles/subscribers, emails per month, campaign cadence?**
> A: **~30K active subscribers; current send volume <10k/month — deliberately
> small, and the goal is to grow it substantially.** Wants more frequent
> marketing across MULTIPLE channels: email, SMS, targeted ads, videos, posts —
> "a real marketing engine across multiple channels." Scope implication: the
> engine's channel model must extend beyond email/SMS to ad-audience sync
> (Meta/Google) and social content — aligned with Archon's original Social
> Command Center vision. Warm-up note: 30K profiles with low historical volume
> means domain warm-up must be gradual and engagement-segmented.

**Q2.3 Are Klaviyo signup forms/popups on the storefront? Is the Klaviyo onsite
tracking snippet installed?**
> A: **Both — forms AND the tracking snippet are live.** Replacement therefore
> needs (a) a signup-form/popup story and (b) first-party onsite behavioral
> tracking (viewed product / active on site), or those triggers and signups die
> at cutover.

**Q2.4 Anything else load-bearing in Klaviyo (SMS, reviews, referrals, reports)?**
> A: **SMS runs through Klaviyo today.** SMS is therefore not a later phase —
> replacement needs an SMS channel sooner, and Klaviyo SMS consent records
> (TCPA evidence) must be exported and preserved during migration.

## Round 3 — Channels & delivery

**Q3.1 Channel rollout order (email / SMS / ads / social)?**
> A: **Email first, SMS fast-follow.** Klaviyo SMS keeps running briefly after
> email cutover; SMS migrates as the immediate next phase. Ads/social later.

**Q3.2 SMS provider and number strategy?**
> A: **No preference — recommend during design.** Working recommendation: Twilio
> as the first `SmsProvider` adapter (boring default, best docs). Number
> strategy (port existing Klaviyo toll-free/short code vs fresh number +
> re-registration) to be decided after checking what number type Klaviyo holds
> today. Follow-up: inventory the Klaviyo SMS number type. TCPA consent export
> from Klaviyo is required either way.

**Q3.3 Transactional email in scope, or marketing only?**
> A: **Marketing now, transactional later.** Shopify keeps order/shipping
> notifications for now. Design the send pipeline with separate message streams
> (marketing vs transactional: separate sending identity, suppression rules
> don't apply to transactional) so it can be added later — e.g. for Hobby Hive
> or dropship contexts without a Shopify storefront.

**Q3.4 Resend account + DNS status?**
> A: **No Resend account yet — starting from zero.** DNS access for store
> domains is available. Setup tasks: account, per-store sending subdomain
> (e.g. mail.cardshellz.com) with SPF/DKIM/DMARC, click-tracking subdomain,
> rate-limit review, and a warm-up plan (30K list, low historical volume →
> gradual, engagement-segmented ramp).

## Round 4 — Architecture placement

**Q4.1 Marketing engine as bounded module inside Archon vs separate service?**
> A: **DECIDED: inside Archon with hard boundaries.** Own schema + published
> module interface; ingestion and delivery contracts designed as if standalone
> so later extraction (or SaaS-ification) is mechanical.

**Q4.2 Database placement?**
> A: **DECIDED: a new dedicated `marketing` schema in Archon's existing
> Postgres.** Boundary rule: no cross-schema joins into Archon's other tables
> even though physically possible — all access through the module interface.

**Q4.3 Job/queue infrastructure?**
> A: **Recommend during design.** Working recommendation to validate: Postgres
> queues per the Echelon pattern (SKIP LOCKED leases, advisory-lock schedulers,
> retry + DLQ) — zero new infra, proven in-stack, sufficient at 30–100k
> profiles; revisit Redis/BullMQ only if send-volume targets demand it.

**Q4.4 Identity master: evolve Archon `customers` vs engine-owned profile store?**
> A: **Recommend during design.** Open tradeoff to resolve with a reusability
> audit of Archon's current customers/sync code (which has known intake-quality
> issues): one-truth evolution of `customers` (+aliases, +consent ledger,
> +merge history) vs an engine-owned profile store with `customers` demoted to
> an analytics cache.

## Round 5 — Data ingestion & tracking

**Q5.1 Order data path: via Echelon, direct store connectors, or hybrid?**
> A: **DECIDED: Hybrid.** Echelon events are the order source for
> Echelon-managed stores (harden today's fire-and-forget push into a durable
> outbox + reconciliation poll). The engine ALSO gets its own connector
> framework for storefront-only data (checkout started, consent, signups) and
> for future stores that never touch Echelon.

**Q5.2 First-party web tracking snippet in v1?**
> A: **Recommend during design.** Decide after inventorying which live Klaviyo
> flows depend on browse events (Klaviyo's snippet with Viewed Product /
> Active on Site IS currently installed — see Q2.3 — so cutover parity likely
> requires it; confirm during design).

**Q5.3 Product catalog source for email content?**
> A: **Recommend during design.** Options: per-store platform sync (fully
> generic; `syncedProducts` as seed) vs Echelon's richer catalog for Card
> Shellz + platform sync for foreign stores. Decide from what email blocks
> actually need (images, price, stock state — back-in-stock needs stock truth,
> which for Card Shellz lives in Echelon/WMS).

**Q5.4 Unique coupon/discount codes?**
> A: **DECIDED: launch requirement.** Per-recipient/expiring codes are part of
> the playbook — the Shopify discount-API connector capability is v1 scope
> (modeled as an optional per-connector capability, not engine core).

## Round 6 — Compliance & consent

**Q6.1 Customer jurisdictions?**
> A: **US + Canada.** CAN-SPAM + TCPA (SMS) + CASL. CASL implications: express
> vs implied consent must be distinguished in the consent ledger, implied
> consent expires (2 years from purchase), and sender identification rules
> apply. No GDPR machinery required.

**Q6.2 Consent capture strategy / double opt-in?**
> A: **Recommend during design.** Likely per-source policy (e.g. double opt-in
> for popups/forms, single for checkout + club signup). Engine must record
> source/timestamp/method/evidence for every consent regardless — CASL makes
> proof of consent mandatory.

**Q6.3 Preference center granularity?**
> A: **DECIDED: simple unsubscribe-all per store at launch; data model supports
> per-topic + per-channel subscriptions so a hosted preference page can come
> later without migration.** List-Unsubscribe + one-click (RFC 8058) headers
> from day one.

**Q6.4 Consent migration seed?**
> A: **DECIDED: Shopify customer consent state + Klaviyo exports (email
> suppression/consent AND SMS/TCPA consent records) seed the new system.
> Anyone in neither is NOT sendable.** Conservative and defensible.

## Round 7 — Feature priorities

**Q7.1 Which flows must work on day one of flow cutover?**
> A: **All four: welcome series, abandoned checkout, back-in-stock,
> post-purchase/winback.** No partial flow cutover — the journey runtime must
> support event triggers (signup, checkout started, back-in-stock, order
> placed), time-based waits, and exit conditions before Klaviyo flows turn off.
> Note: abandoned checkout requires checkout-started events (store connector);
> back-in-stock requires the Shellz Club feed + stock truth.

**Q7.2 Campaign features at launch?**
> A: **Plain scheduled sends** (segment/list + template + scheduled/immediate).
> A/B and send-time optimization later. (Design note: structure the send log
> around variants anyway so A/B arrives without schema migration.)

**Q7.3 Segmentation depth at launch?**
> A: **Behavioral from day one.** Event-based conditions ("purchased in last
> 90d", "opened nothing in 60d", "viewed product X") — Klaviyo-parity
> segmentation, not just profile properties. This makes the canonical event
> store + aggregate computation a v1 requirement, not a later phase.

**Q7.4 AI's role?**
> A: **Full agentic ambition.** AI agents run marketing semi-autonomously
> within guardrails (budgets, frequency caps, approval thresholds) — the
> long-term Archon vision. Design implication: the engine's published module
> interface must be complete enough that an AI agent is a first-class operator
> (create segment, draft campaign, schedule send, read results) with hard
> server-side guardrails (caps, suppression, consent) that agents CANNOT
> override — safety enforced in the engine, not in the prompt.

## Round 8 — Analytics & reporting

**Q8.1 Attribution model?**
> A: **Recommend during design; make it configurable per workspace.** Working
> recommendation to validate: click-based last-touch within ~5 days (opens
> directional-only due to Apple MPP). Note historical Klaviyo reports likely
> used open-inclusive attribution — expect the new numbers to look smaller for
> the same reality; call this out at cutover.

**Q8.2 Click/open tracking mechanics?**
> A: **Recommend during design.** Decide per-store branded tracking domains +
> own link wrapping vs Resend's built-in open/click tracking, after checking
> what Resend's webhooks expose vs what the chosen attribution model needs.

**Q8.3 Reporting home + AI feedback loop?**
> A: **DECIDED: Archon dashboards + AI context.** Performance lands in the
> marketing schema, surfaces on CommandDeck/daily_metrics, and feeds the AI
> analyst's prompt so recommendations learn from real send results — closing
> the loop Klaviyo never gave Archon (it pulls zero analytics today).

## Round 9 — Ops, quality bar & cutover

**Q9.1 Does Echelon's financial-grade engineering contract apply?**
> A: **DECIDED: yes, verbatim.** Adopt Echelon's CLAUDE.md standards for the
> marketing module — sends are money-adjacent and consent is legally
> auditable. Action: write an Archon CLAUDE.md section enforcing the contract
> for the `marketing` module (Archon has no such contract today).

**Q9.2 Environments & safe-send story?**
> A: **DECIDED: first-class sandbox mode + internal seed list.** Engine renders
> and logs but delivers only to the seed list; sandbox flag per
> workspace/campaign. No separate staging app.

**Q9.3 Scale target without redesign?**
> A: **DECIDED: 500k profiles / 5M emails-month.** Design an order of magnitude
> beyond today: influences queue technology choice (Q4.3) and means send-log +
> event tables are partitioned/pruned by design from day one.

**Q9.4 Cutover appetite?**
> A: **DECIDED: aggressive (~4–6 weeks).** Start domain warm-up the moment v1
> campaigns work; downgrade the Klaviyo tier ASAP; accept some deliverability
> risk to stop the cost bleeding sooner. Warm-up ramps on most-engaged
> segments first.

---

## Parking lot / follow-ups raised during Q&A

**Manual inventory needed before design finalizes (Klaviyo/Shopify dashboards —
not visible from code):**
- Exact configuration of the four live Klaviyo flow families (triggers, steps,
  timing, templates).
- Klaviyo SMS number type (toll-free vs short code) → port vs fresh-number
  decision (Q3.2).
- Which Klaviyo forms/popups are live on the storefront and what they collect.
- Export procedure for Klaviyo suppression list + email consent + SMS/TCPA
  consent records (the migration seed per Q6.4).

**Decisions deliberately deferred to the design doc** *(all seven resolved in
`DESIGN.md` §3 and user-confirmed 2026-08-08 — see D1–D7 there)*:
- Queue infra: Postgres queues vs Redis/BullMQ — now constrained by the 500k/5M
  scale target (Q4.3 × Q9.3).
- Identity master: evolve Archon `customers` vs engine-owned profile store (Q4.4).
- First-party web-tracking snippet in v1 (Q5.2 — leaning yes, since the Klaviyo
  snippet is live and behavioral segmentation is a day-one requirement per Q7.3).
- Catalog source per store (Q5.3).
- Per-source consent policy / double opt-in (Q6.2).
- Attribution model + window, configurable per workspace (Q8.1).
- Link wrapping: own tracking domains vs Resend built-in (Q8.2).

**Scope notes captured along the way:**
- Multi-channel ambition beyond email/SMS: ad-audience sync (Meta/Google),
  video/social content — later phases, but the channel-port design must not
  preclude them (Q2.2).
- AI agents as first-class operators of the engine with server-side guardrails
  they cannot override (Q7.4).
- Unique coupon codes = v1 connector capability (Q5.4).
- Behavioral segmentation day one ⇒ canonical event store + aggregates are v1
  core, not phase 2 (Q7.3).
- All four flow families must work before Klaviyo flows turn off (Q7.1).

## Status: DISCOVERY COMPLETE — ready for design doc.
