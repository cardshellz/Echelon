# In-House Marketing System — Discovery Q&A

> Status: **IN PROGRESS** — recording answers before any design/scoping work.
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

**Q5.1 Order data path: marketing engine consumes order events via Echelon
(hardened push + reconciliation poll), or does the marketing system also get its
OWN direct store connectors? Note: storefront behavioral data (product viewed,
checkout started) never passes through Echelon — abandoned-checkout and browse
flows need a direct-to-store connector or web tracking regardless.**
> A: —

**Q5.2 Web tracking: do you want an onsite JS snippet (viewed product, add to
cart, identified sessions) in v1, or defer browse-behavior triggers?**
> A: —

**Q5.3 Catalog: product data for email blocks/recommendations — sync per store
from the platform, or reuse Echelon catalog for Card Shellz and platform sync for
foreign stores?**
> A: —

**Q5.4 Coupons: are unique/per-send discount codes needed (requires per-platform
connector capability, e.g. Shopify discount API)?**
> A: —

## Round 6 — Compliance & consent

**Q6.1 Customer jurisdictions: US-only, or EU/UK/Canada too (GDPR/CASL change
consent + deletion requirements)?**
> A: —

**Q6.2 Where is marketing consent captured today (Shopify checkout opt-in, club
signup, popups)? Do you want double opt-in going forward?**
> A: —

**Q6.3 Preference center: one global per brand/store, and what granularity
(unsubscribe-all vs topic preferences)?**
> A: —

**Q6.4 Consent migration: is Shopify's customer consent state + Klaviyo's
suppression list export the agreed source of truth to seed the new system?**
> A: —

## Round 7 — Feature priorities

**Q7.1 Rank the launch flows (what must work on day one vs later): welcome,
abandoned checkout, back-in-stock, post-purchase, winback, tier/membership
lifecycle, birthday.**
> A: —

**Q7.2 Campaign features at launch: A/B testing? send-time optimization? or plain
scheduled sends first?**
> A: —

**Q7.3 Segmentation depth needed at launch: profile-property rules only, or
behavioral event conditions ("purchased X in last N days", "opened nothing in
60d") from day one?**
> A: —

**Q7.4 AI's role: keep the existing generate→approve→export pipeline pointed at
the new engine? Should AI ever author/modify journeys, and with what approval
gates?**
> A: —

## Round 8 — Analytics & reporting

**Q8.1 Attribution model you actually want to see (e.g. last-click within 5 days,
click-only vs click+open), and is revenue-per-campaign/flow the headline metric?**
> A: —

**Q8.2 Click/open tracking: per-store tracking domains (links.store.com)?
Comfortable that opens are directional-only (Apple MPP)?**
> A: —

**Q8.3 Where does reporting live — Archon CommandDeck/daily_metrics, and should
campaign performance feed the AI analyst's context?**
> A: —

## Round 9 — Ops, quality bar & cutover

**Q9.1 Does Echelon's financial-grade engineering contract (CLAUDE.md: evidence
discipline, idempotency, transactions, structured errors, tests-with-change)
apply verbatim to this system?**
> A: —

**Q9.2 Environments: is there a staging story, and do you want a send-sandbox
mode (render + log but don't deliver) from day one?**
> A: —

**Q9.3 Scale targets to size for: profiles, emails/day at peak (drop + campaign
days), acceptable send latency for triggered flows?**
> A: —

**Q9.4 Cutover appetite: dual-run duration alongside Klaviyo, domain warm-up
tolerance (weeks of throttled volume), and who flips each flow over?**
> A: —

---

## Parking lot / follow-ups raised during Q&A

- (none yet)
