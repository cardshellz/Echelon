# Card Shellz 3PL / Dropship Platform — Design Document

> **Version:** 1.0 DRAFT  
> **Date:** 2026-03-22  
> **Author:** Business Architecture (Archon)  
> **Status:** Ready for Review  
> **Audience:** Overlord, Echelon engineering team

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Business Model Overview](#2-business-model-overview)
3. [Product Feed](#3-product-feed)
4. [Order Flow](#4-order-flow)
5. [Inventory Management](#5-inventory-management)
6. [Payments — Decision Matrix](#6-payments--decision-matrix)
7. [Pricing & Fees](#7-pricing--fees)
8. [Returns & Refunds](#8-returns--refunds)
9. [Risk Management](#9-risk-management)
10. [Technical Architecture](#10-technical-architecture)
11. [Legal Framework](#11-legal-framework)
12. [Launch Strategy](#12-launch-strategy)
13. [USDC / Crypto Payments — Future Note](#13-usdc--crypto-payments--future-note)
14. [Appendix: Edge Cases](#14-appendix-edge-cases)

---

## 1. Executive Summary

Card Shellz wants to enable resellers (vendors) to list and sell Card Shellz products on their own eBay and Shopify stores, with Card Shellz handling all fulfillment. The vendor never touches product. This is a **Card Shellz-powered reseller** model — vendors own customer acquisition and storefront merchandising, while Card Shellz fulfillment/packaging/return identity is allowed and expected.

**Why this matters:**
- Expands sales volume without Card Shellz managing more storefronts
- Vendors handle customer acquisition; Card Shellz handles product + fulfillment
- Leverages existing Echelon infrastructure (OMS, WMS, ATP, channel sync)
- Low marginal cost per vendor once platform is built

**Key constraint:** Card Shellz is a 1-person operation backed by AI agents. The platform must be **self-service for vendors** and **low-maintenance for Card Shellz**. No manual order processing. No babysitting vendor accounts.

**Recommended payment model:** Prepaid Wallet (Option C) for MVP, with Stripe Connect (Option D) as Phase 2 upgrade. Details in Section 6.

---

## 2. Business Model Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        VENDOR'S WORLD                           │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐     │
│  │ Customer  │───▶│ Vendor's     │───▶│ Vendor sets price  │     │
│  │ browses   │    │ eBay/Shopify │    │ (wholesale + markup)│     │
│  └──────────┘    └──────┬───────┘    └────────────────────┘     │
│                         │                                       │
│                    Customer buys                                │
│                    & pays vendor                                │
└─────────────────────────┼───────────────────────────────────────┘
                          │
                    Order submitted
                    via API / webhook
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│                     CARD SHELLZ WORLD                            │
│                                                                 │
│  ┌──────────────┐   ┌───────────┐   ┌───────────────────────┐   │
│  │ Echelon OMS  │──▶│ WMS picks │──▶│ Ship Card Shellz      │   │
│  │ validates &  │   │ packs     │   │ branded fulfillment    │   │
│  │ reserves inv │   │ orders    │   │ as reseller program)   │   │
│  └──────────────┘   └───────────┘   └──────────┬────────────┘   │
│                                                 │               │
│                                          Tracking number        │
│                                          flows back to vendor   │
│                                                 │               │
│  ┌──────────────┐                               │               │
│  │ Wallet debit │◀──────────────────────────────┘               │
│  │ (wholesale + │   (deducted at order placement                │
│  │  shipping)   │    or shipment confirmation)                  │
│  └──────────────┘                                               │
└─────────────────────────────────────────────────────────────────┘
```

**Ownership at Each Stage:**

| Stage | Owner | Notes |
|-------|-------|-------|
| Product listing | Vendor | Using Card Shellz catalog data |
| Customer relationship | Vendor | Card Shellz never contacts customer |
| Payment collection | Vendor | On their store, their processor |
| Order submission | Shared | Vendor submits → Card Shellz validates |
| Inventory allocation | Card Shellz | Via Echelon ATP engine |
| Fulfillment | Card Shellz | Pittsburgh warehouse or ShipMonk |
| Shipping label | Card Shellz | Card Shellz carrier accounts |
| Customer service | Vendor | Card Shellz supports vendor, not customer |
| Returns processing | Shared | See Section 8 |

---

## 3. Product Feed

### 3.1 How Vendors Get the Catalog

**Primary method: Vendor Portal + API**

Vendors log into the Card Shellz Vendor Portal (web app within Echelon) where they can:
- Browse the full product catalog with images, descriptions, specs
- See real-time ATP quantities
- See their wholesale pricing (based on tier)
- Select which products they want to list on their stores
- Push approved listings directly to the connected vendor store/account
- Access APIs for programmatic/agent integration

**Feed/listing methods (prioritized):**

| Method | Use Case | MVP? |
|--------|----------|------|
| **Direct eBay connection/push** | Vendor connects eBay; Card Shellz pushes approved listings | ✅ |
| **Direct Shopify connection/push** | Vendor connects Shopify; Card Shellz pushes approved listings | ✅ |
| **REST/agent API** | Automated integrations, future agent commerce | Later |
| **CSV export** | Admin/manual fallback only, not the primary vendor path | Fallback |

### 3.2 Product Data Included

For each product/variant in the feed:

- **SKU** (Card Shellz SKU — vendor maps to their own)
- **Title & description** (Card Shellz copywriting)
- **Product images** (hosted on Card Shellz CDN — vendors hotlink or download)
- **Wholesale price** (vendor's cost, tier-dependent)
- **MSRP / suggested retail** (optional guidance)
- **Weight & dimensions** (for vendor's shipping calculator)
- **Barcode / UPC** (if applicable)
- **ATP quantity** (real-time available to promise)
- **Product status** (active, discontinued, temporarily out of stock)
- **Category / product type**

### 3.3 Inventory Availability in the Feed

- ATP is refreshed on every feed pull or API call
- Vendors see **Dropship channel allocated ATP** from Echelon's existing channel allocation engine, not raw inventory and not full Card Shellz ATP.
- Dropship uses one shared Card Shellz Dropship channel allocation pool for all vendors. Vendor selections/listings sit on top of that pool; vendors are not separate inventory allocation channels.
- When allocated ATP hits 0, product shows as "out of stock" in the feed
- Vendors are responsible for delisting or marking OOS on their stores


**Implementation requirement:** Dropship catalog, listing push, and vendor portal availability must read from the existing ATP + channel allocation path. Do not calculate dropship availability directly from `inventory.inventory_levels` inside dropship routes.

**Real-time option (Phase 2):** Webhook push when ATP changes for products a vendor has selected. Vendor registers a webhook URL, Card Shellz pushes `{ sku, atp, timestamp }` on every meaningful change.

### 3.4 Vendor Product Selection

Vendors don't have to list everything. Selection follows the same override structure as pricing: broad controls first, SKU-level exceptions when needed.

In the portal:
1. Browse catalog → approve/select at the product level by default
2. Product-level approval selects all active dropship-eligible SKU variants under that product
3. Vendors can opt out of specific SKU variants under an approved product
4. Selected products/SKUs appear in their "My Products" view
5. Listing push only includes selected SKU variants
6. ATP webhooks only fire for selected SKU variants
7. Vendor pricing auto-fills from MAP and follows the pricing override rules in Section 7.5


**Data model requirement:** vendor selection is product-level by default, with SKU-level exceptions.

Recommended tables/concepts:

`vendor_product_selections`
- `vendor_id`
- `product_id`
- `enabled`
- represents: vendor wants this product family/listing group

`vendor_variant_overrides`
- `vendor_id`
- `product_variant_id`
- `enabled_override` nullable
- `price_override_type` nullable (`percent`, `fixed`)
- `price_override_value`
- represents: this SKU differs from product/default rules

Product approval stays simple. SKU exceptions stay precise.

### 3.5 Image Hosting

Card Shellz hosts product images. Vendors can:
- **Hotlink** — use Card Shellz CDN URLs directly (simplest, recommended)
- **Download** — bulk download images for self-hosting

Hotlinking is fine for Shopify and eBay. Both platforms allow external image URLs. This also means when Card Shellz updates an image, all vendor listings auto-update.

---

## 4. Order Flow

### 4.0 OMS Channel Model

Dropship gets its own OMS channel: **Dropship**. This is distinct from Card Shellz-owned internal sales channels, including Card Shellz's own eBay store/channel.

Vendor marketplace/storefront platforms are vendor-side surfaces under the Dropship program, not separate OMS channels. At launch, vendors may sell through eBay and Shopify; later surfaces may include TikTok, Instagram, BigCommerce, and others. Orders from those vendor surfaces still enter OMS through the Dropship channel.

`vendor_id` identifies the reseller/commercial owner for wallet billing, reporting, permissions, and support. The vendor-side source platform/order reference should be stored as order metadata/source detail, but the OMS channel remains Dropship.

Do not create one OMS channel per vendor and do not conflate vendor eBay activity with Card Shellz's internal eBay channel.

**Idempotency:** dropship OMS order uniqueness must be enforced by a DB-level unique constraint on `(channel_id, external_order_id)`. `vendor_id` is ownership metadata, not part of the primary OMS idempotency boundary.

Dropship-specific source detail should be stored separately from the OMS channel identity:
- `vendor_id`
- `source_platform` (`ebay`, `shopify`, etc.)
- `source_account_id`
- `source_order_id`

The canonical order ingestion idempotency key remains `(Dropship channel_id, external_order_id)`.


### 4.0.1 Vendor Store Connection Model

For MVP, each dropship subscription includes **one connected vendor store/account**. That store may be eBay or Shopify at launch. Later, Card Shellz can offer additional connected stores/accounts as a paid add-on.

The data model should still be store-connection aware rather than hardcoding a single eBay account directly on the vendor record. Store connection records should include:
- `vendor_id`
- `source_platform` (`ebay`, `shopify`, later `tiktok`, `instagram`, `bigcommerce`, etc.)
- `source_account_id` (eBay username, Shopify domain, etc.)
- OAuth/token/config fields as needed
- status

MVP policy: enforce one active store connection per subscription/vendor. Future policy: allow multiple active store connections when a paid add-on is enabled.

Connection limits should be entitlement/config driven, not hardcoded:
- `included_store_connections = 1` for MVP
- `extra_store_connections_allowed = false` for MVP
- future paid add-on can increase the allowed active connection count without schema surgery


### 4.0.2 Store Token Security and Health

Vendor store OAuth/access tokens are production secrets.

Requirements:
- Tokens must be encrypted at rest or stored through the existing secrets mechanism.
- Access/refresh token values must never be returned to the frontend.
- Store connections need refresh handling and explicit failure states.
- Vendor and ops portals should show token/store health without exposing token values.
- Audit events must be written when a store is connected, disconnected, re-authorized, token refresh succeeds, or token refresh fails.

Store health states should include at minimum: `connected`, `needs_reauth`, `refresh_failed`, `disconnected`.

OAuth state security requirements:
- State must be server-side nonce-backed or HMAC-signed.
- State must expire quickly.
- Callback vendor/store connection must match the authenticated vendor/session that initiated OAuth.
- State must be one-time use.
- Failed or suspicious OAuth callbacks must be audited.

Never trust a plain vendor ID parsed from OAuth `state` as authorization by itself.


### 4.0.3 Store Setup Checklist

Marketplace/store setup must be explicit and visible. Required policy/config setup cannot silently partially fail.

Requirements:
- Store setup checklist per connected store/platform
- Required marketplace policies/config validated before listing push
- Setup failures shown in vendor Action Center
- Setup blockers visible in ops/admin portal
- Listing push blocked while required setup is incomplete

For eBay, this includes fulfillment/return/payment/location/category/policy prerequisites needed to create valid listings. If policy seeding or validation fails, record a setup blocker instead of only logging it.

### 4.1 Order Submission Path

```
Customer buys on vendor's store
         │
         ▼
┌─────────────────┐
│ Vendor's store   │
│ processes payment│
│ (Stripe/PayPal)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Option A:        │     │ Option B:        │
│ Vendor submits   │     │ Auto-webhook     │
│ via Portal/API   │     │ from vendor's    │
│ (manual or       │     │ Shopify/eBay     │
│  automated)      │     │ (Phase 2+)       │
└────────┬────────┘     └────────┬────────┘
         │                       │
         └───────────┬───────────┘
                     ▼
         ┌───────────────────┐
         │ Echelon OMS       │
         │ Dropship Ingestion│
         │                   │
         │ 1. Validate vendor│
         │    (active, good  │
         │     standing)     │
         │ 2. Validate SKUs  │
         │    (exist, active)│
         │ 3. Check ATP      │
         │    (in stock?)    │
         │ 4. Check wallet   │
         │    (funds >= cost)│
         │ 5. Reserve inv    │
         │ 6. Debit wallet   │
         │ 7. Create OMS     │
         │    order          │
         └────────┬──────────┘
                  │
                  ▼
         ┌───────────────────┐
         │ WMS Pick/Pack/Ship│
         │                   │
         │ • Card Shellz     │
         │   branded/standard│
         │   fulfillment     │
         │                   │
         │ • Ship via Card   │
         │   Shellz carriers │
         └────────┬──────────┘
                  │
                  ▼
         ┌───────────────────┐
         │ Tracking pushed   │
         │ back to vendor    │
         │ via API callback  │
         │ or portal display │
         └───────────────────┘
```

### 4.2 Order Submission — API Specification

**Endpoint:** `POST /api/dropship/orders`

**Request:**
```json
{
  "vendor_order_ref": "VENDOR-12345",
  "ship_to": {
    "name": "John Smith",
    "address1": "123 Main St",
    "address2": "Apt 4",
    "city": "Pittsburgh",
    "state": "PA",
    "zip": "15201",
    "country": "US",
    "phone": "555-0123"
  },
  "items": [
    { "sku": "CS-TL-35PT-25", "quantity": 2 },
    { "sku": "CS-PS-STD-100", "quantity": 1 }
  ],
  "shipping_method": "standard",
  "packing_slip": "plain",
  "notes": "Gift order — no pricing on slip"
}
```

**Response (success):**
```json
{
  "dropship_order_id": "DS-00142",
  "status": "accepted",
  "estimated_ship_date": "2026-03-23",
  "items_cost": 12.50,
  "shipping_cost": 4.99,
  "total_charged": 17.49,
  "wallet_balance_remaining": 482.51
}
```

**Response (failure examples):**
```json
{
  "status": "rejected",
  "reason": "insufficient_funds",
  "required": 17.49,
  "wallet_balance": 10.00
}
```
```json
{
  "status": "rejected",
  "reason": "out_of_stock",
  "items": [
    { "sku": "CS-TL-35PT-25", "requested": 2, "available": 0 }
  ]
}
```

### 4.3 Order Validation Rules

Every dropship order runs through this validation chain (all must pass):

1. **Vendor authentication** — valid API key, active account
2. **Vendor standing** — not suspended, not on credit hold
3. **SKU validation** — all SKUs exist and are active in catalog
4. **ATP check** — sufficient dropship-allocated inventory for all line items
5. **Wallet balance** — vendor has funds ≥ full order charge before acceptance
6. **Ship-to validation** — address is deliverable (basic format check; carrier validates at label time)
7. **Rate limiting** — prevent bulk spam (100 orders/hour per vendor max)

If any check fails, the order is rejected with a clear error. No partial orders — all items must pass or the whole order is rejected.


### 4.3.1 Zero Credit Exposure Requirement

Card Shellz must have **zero credit exposure** on dropship orders. An accepted dropship order must mean the order is funded and inventory is reserved.

Wallet debit happens at order acceptance/reservation time, not shipment time.

In one transaction:
1. Validate vendor/store/order/SKUs/allocated ATP
2. Calculate full vendor charge
3. Create OMS order under the Dropship channel
4. Reserve inventory
5. Debit vendor wallet
6. Write immutable wallet ledger row

If any step fails, the whole order is rejected/rolled back. No partial OMS order, no unpaid reserve, no shipment without funds.


### 4.3.2 Vendor Intake Audit Trail

Vendors need a detailed record of what succeeded, what failed, and why. Failed intake must not disappear silently.

Use a dropship intake/audit record separate from OMS orders:
- accepted intake → linked OMS order exists
- rejected intake → no OMS order, but vendor portal shows the rejected attempt and reason

Common rejection/success reasons to expose:
- accepted/funded/reserved
- insufficient available wallet balance
- auto-reload pending or failed
- insufficient Dropship channel allocated ATP
- SKU not approved/listed for this vendor
- invalid or incomplete address
- duplicate order
- disconnected store/token issue
- marketplace/API payload validation error

This preserves OMS cleanliness while giving vendors and Card Shellz a full audit trail.


### 4.3.3 Order Intake Processing Jobs

Marketplace order webhooks and polling should create intake events/jobs. The webhook/polling request should not perform long-running fulfillment work directly.

Flow:
1. Marketplace webhook or poll discovers an order
2. System writes/updates an idempotent intake event
3. Intake processor validates vendor/store/order/SKUs/allocated ATP/wallet
4. Processor attempts the atomic acceptance transaction
5. Intake record is marked accepted or rejected with detailed reason
6. Retries are idempotent and never create duplicate OMS orders, reserves, or wallet debits

The acceptance transaction itself must remain atomic: OMS order creation, inventory reservation, wallet debit, and ledger write succeed together or roll back together.

### 4.4 Card Shellz-Powered Fulfillment

**Critical requirement:** This is not blind dropship. It is a Card Shellz-powered reseller program.

- **Return address:** Card Shellz warehouse by default.
- **Packaging/packing slip:** Card Shellz branded or Card Shellz-standard fulfillment is allowed and expected.
- **Vendor customer relationship:** Vendor owns customer service and storefront merchandising, but Card Shellz can be visible as fulfillment/return identity.
- **No vendor-branded packing slips in MVP** unless explicitly added later as a paid/phase feature.
- **No Card Shellz pricing** visible anywhere in the package.
- **Shipping label:** Card Shellz warehouse/approved return address.

### 4.5 Tracking Flow

```
Card Shellz ships order
         │
         ▼
Carrier provides tracking number
         │
         ├──▶ Stored in Echelon OMS / shipment records
         │
         ├──▶ System pushes tracking back to the vendor's connected store
         │    (eBay/Shopify at launch; later TikTok/Instagram/BigCommerce/etc.)
         │
         ├──▶ Vendor portal displays shipment/tracking status
         │
         └──▶ If marketplace pushback fails:
              • create vendor + ops action item
              • record failure reason
              • retry through tracking push job
```

Vendor should not manually copy tracking unless automation is broken. Portal display is backup/visibility, not the primary tracking delivery path.

**Tracking data provided:**
- Carrier name (USPS, UPS, FedEx)
- Tracking number
- Estimated delivery date
- Ship date
- Current status (shipped, in transit, delivered)

### 4.6 Order Lifecycle & Status

| Status | Meaning | Who Moves It |
|--------|---------|-------------|
| `submitted` | Vendor submitted, pending validation | System |
| `accepted` | Validated, inventory reserved, wallet debited | System |
| `processing` | In WMS pick queue | WMS |
| `picking` | Being picked | Warehouse |
| `packed` | Packed, awaiting label | Warehouse |
| `shipped` | Label created, carrier has package | Shipping |
| `delivered` | Carrier confirms delivery | Carrier webhook |
| `cancelled` | Order cancelled before shipment | Vendor or System |
| `rejected` | Failed validation | System |
| `returned` | Customer returned item | Return processing |

---

## 5. Inventory Management

### 5.1 Dropship Allocation Model

Card Shellz sells through multiple channels: their own Shopify, their own eBay, and now vendor dropship. Inventory must be allocated across these channels.

**Echelon already has an allocation engine** (`allocation-engine.service.ts`, `channel_allocation_rules`). Dropship becomes a new "channel" in this system: one shared Card Shellz Dropship channel allocation pool feeds all vendors. Vendors are reseller/listing surfaces on top of that pool, not independent inventory allocation channels.

```
Total On-Hand Inventory
         │
         ├── Card Shellz Shopify allocation (e.g., 80%)
         ├── Card Shellz eBay allocation (e.g., 10%)
         ├── Dropship pool allocation (e.g., 10%)
         │        │
         │        ├── Shared across all vendors
         │        │   (first-come-first-served)
         │        │
         │        └── Per-vendor limits possible
         │            (e.g., max 50 units/vendor)
         │
         └── Safety stock / reserve (held back from all channels)
```

**Key decisions:**

| Decision | Recommendation | Rationale |
|----------|---------------|-----------|
| Separate dropship pool? | **Yes** | Prevents vendors from eating into Card Shellz direct sales inventory |
| Per-vendor limits? | **Phase 2** | Start with shared pool, add limits if abuse occurs |
| Allocation % | Start at **10%** | Conservative; increase as vendor volume grows |
| Priority | **Card Shellz direct > Dropship** | Card Shellz margins are higher on direct sales |

### 5.2 ATP Calculation for Dropship

```
Dropship vendor-visible ATP = allocated quantity from the shared Card Shellz Dropship channel
                      - active reservations/orders already consuming that allocation
```

This ties directly into Echelon's existing `atp.service.ts` and `allocation-engine.service.ts`. Add a Dropship channel/allocation rule, then dropship catalog, portal availability, and listing push must consume that channel allocation output. Dropship routes must not calculate availability directly from raw inventory tables.

### 5.3 Inventory Reservation

When a vendor submits a dropship order:

1. **Hard reserve** the requested quantities against the dropship pool
2. If insufficient ATP → reject the order immediately
3. Reservation creates an `inventory_transactions` record (type: `dropship_reserve`)
4. Reservation holds for **48 hours** — if not picked/shipped by then, auto-cancel and notify vendor
5. On shipment → reservation converts to decrement (normal flow)
6. On cancellation → reservation released, ATP restored, wallet refunded

### 5.4 Out-of-Stock Scenarios

| Scenario | What Happens |
|----------|-------------|
| Vendor listed product, ATP drops to 0 | ATP feed shows 0. Vendor should delist. Card Shellz not liable for vendor's delayed delist. |
| Vendor submits order, product is OOS | Order rejected immediately with `out_of_stock` error |
| Product goes OOS after order accepted, before pick | **Should not happen** — inventory was reserved at acceptance. If it does (system error), Card Shellz contacts vendor, refunds wallet, cancels order. |
| Card Shellz restocks | ATP updates, vendors see availability in next feed pull or webhook |

### 5.5 Inventory Sync to Vendors

| Method | Frequency | Use Case |
|--------|-----------|----------|
| API pull (`GET /api/dropship/products`) | On-demand | Vendor checks before listing |
| Direct listing push job | On approval / retry | Create/update vendor store listings |
| Webhook push (Phase 2) | Real-time on ATP change | Auto-update vendor store listings |

---

## 6. Payments — Decision Matrix

This is the critical business decision. Analyzed five options:

### Option A: Per-Order Invoicing

**How it works:** Vendor receives customer payment on their store. Card Shellz invoices vendor for wholesale cost + shipping after fulfillment. Settlement weekly or Net-15.

| Criterion | Assessment | Score |
|-----------|-----------|-------|
| Cash flow timing | ❌ Card Shellz ships first, gets paid days/weeks later | 2/10 |
| Risk exposure | ❌ HIGH — vendor may not pay; Card Shellz already shipped | 2/10 |
| Vendor friction | ✅ Easy — vendor just pays invoices | 8/10 |
| Scalability | ⚠️ Collections become a full-time job at 50+ vendors | 4/10 |
| Legal/compliance | ✅ Simple B2B invoicing | 9/10 |
| **Overall** | **Not recommended for MVP** | **5/10** |

**Why not:** Card Shellz is buying product from China, paying for shipping labels. Cash flow can't absorb a model where you ship first and hope vendors pay. One deadbeat vendor could cost thousands.

---

### Option B: Card Shellz Collects, Pays Vendor Commission

**How it works:** Customer payment somehow routes to Card Shellz, who keeps wholesale + shipping and pays vendor the markup.

| Criterion | Assessment | Score |
|-----------|-----------|-------|
| Cash flow timing | ✅ Card Shellz gets paid at sale | 9/10 |
| Risk exposure | ✅ Low — Card Shellz holds the money | 8/10 |
| Vendor friction | ❌ Vendor can't use their own payment processor | 2/10 |
| Scalability | ⚠️ Complex payment routing | 5/10 |
| Legal/compliance | ❌ Card Shellz becomes a payment intermediary — potential money transmission issues | 3/10 |
| **Overall** | **Not feasible** | **5.4/10** |

**Why not:** Vendors sell on THEIR stores with THEIR Stripe/PayPal. Card Shellz can't collect payment on someone else's eBay listing. This model only works if Card Shellz runs the storefront (which is marketplace, not dropship).

---

### Option C: Prepaid Wallet ⭐ RECOMMENDED FOR MVP

**How it works:** Vendor deposits funds into a Card Shellz wallet. Each dropship order deducts wholesale + shipping from the balance. No credit risk.

| Criterion | Assessment | Score |
|-----------|-----------|-------|
| Cash flow timing | ✅ Card Shellz has funds BEFORE shipping | 10/10 |
| Risk exposure | ✅ Zero credit risk — can't order without funds | 10/10 |
| Vendor friction | ⚠️ Vendor must pre-fund; adds a step | 6/10 |
| Scalability | ✅ Fully automated, no invoicing/collections | 9/10 |
| Legal/compliance | ⚠️ May need to consider stored-value regulations (see notes) | 6/10 |
| **Overall** | **Recommended for MVP** | **8.2/10** |

**Details:**

- **Funding methods:**
  - ACH bank transfer (lowest fees, 2-3 day clearing)
  - Credit card via Stripe (immediate, but Card Shellz eats ~3% processing fee — pass to vendor or absorb)
  - Wire transfer (for large deposits)
  - USDC on-chain (future — see Section 13)

- **Minimum balance:** $50 to keep account active. Orders rejected below $0.

- **Auto-top-up (Phase 2):** Vendor sets a threshold (e.g., "reload $200 when balance drops below $50") with saved ACH or card.

- **Wallet ledger:** Full transaction history — deposits, order debits, refund credits, adjustments. Ties into Echelon's existing ledger patterns (`reward_ledger`, `inventory_transactions`).

- **Regulatory note:** Holding customer funds in a wallet may trigger state money transmitter regulations depending on implementation. **Mitigation:** Structure as a **prepaid purchasing account** (B2B trade credit), not a general-purpose stored value card. Funds are only usable for purchasing Card Shellz fulfillment services. Consult a fintech attorney before launch. Alternatively, use Stripe's "Customer Balance" feature to avoid holding funds directly.

```
Wallet Flow:

Vendor deposits $500
    │
    ▼
┌───────────────────────────────┐
│ Wallet Balance: $500.00       │
│                               │
│ Order DS-00142:               │
│   Items:    -$12.50           │
│   Shipping: -$ 4.99           │
│   ────────────────            │
│   Balance:   $482.51          │
│                               │
│ Order DS-00143:               │
│   Items:    -$28.00           │
│   Shipping: -$ 5.99           │
│   ────────────────            │
│   Balance:   $448.52          │
│                               │
│ Refund (cancelled order):     │
│   Credit:   +$17.49           │
│   Balance:   $465.01          │
└───────────────────────────────┘
```

---

### Option D: Stripe Connect / Payment Splitting

**How it works:** Vendor connects their Stripe account to Card Shellz's Stripe Connect platform. When customer pays on vendor's Shopify (which uses Stripe), Stripe automatically splits: wholesale + shipping to Card Shellz, remainder to vendor.

| Criterion | Assessment | Score |
|-----------|-----------|-------|
| Cash flow timing | ✅ Card Shellz gets paid at sale (minus Stripe delay) | 8/10 |
| Risk exposure | ✅ Low — Stripe handles the split | 8/10 |
| Vendor friction | ⚠️ Only works for Shopify+Stripe vendors (not eBay, not PayPal) | 5/10 |
| Scalability | ✅ Stripe handles everything | 8/10 |
| Legal/compliance | ✅ Stripe handles compliance | 9/10 |
| **Overall** | **Good for Phase 2 — Shopify-only vendors** | **7.6/10** |

**Limitations:**
- Only works when vendor uses Stripe for payment processing
- eBay has its own managed payments — can't integrate Stripe Connect
- Requires Stripe Connect platform setup (not trivial but well-documented)
- Stripe takes platform fees on top of processing fees

**Recommendation:** Add as Phase 2 option for Shopify vendors. Keep wallet as primary/universal method.

---

### Option E: Shellz Club Integration

**How it works:** Shellz Club members already get wholesale pricing. Extend membership to include dropship access. Monthly/annual fee covers platform access.

| Criterion | Assessment | Score |
|-----------|-----------|-------|
| Cash flow timing | Depends on payment method used for orders | — |
| Risk exposure | Depends on payment method used for orders | — |
| Vendor friction | ✅ Already a Shellz Club member? One click to enable dropship | 9/10 |
| Scalability | ✅ Self-service enrollment | 8/10 |
| Legal/compliance | ✅ Membership is clean | 9/10 |
| **Overall** | **Not a payment method — it's an access gate** | N/A |

**Key insight:** Shellz Club isn't a payment method. It's a **gating mechanism** for who gets access to the dropship platform. You still need Option C or D for actual order payments.

**Recommended integration:**
- **Shellz Club membership required** to access the dropship platform
- Membership tier determines **wholesale pricing** (existing tier structure)
- Add a "Dropship" add-on or tier to Shellz Club: +$X/month for API access, branded packing slips, etc.
- Vendors who are already Shellz Club members get a frictionless onramp

---

### Payment Decision Matrix — Summary

| | Cash Flow | Risk | Vendor Friction | Scale | Legal | **Total** |
|---|---|---|---|---|---|---|
| **A: Invoicing** | 2 | 2 | 8 | 4 | 9 | **5.0** |
| **B: CS Collects** | 9 | 8 | 2 | 5 | 3 | **5.4** |
| **C: Wallet** ⭐ | 10 | 10 | 6 | 9 | 6 | **8.2** |
| **D: Stripe Connect** | 8 | 8 | 5 | 8 | 9 | **7.6** |
| **E: Shellz Club** | — | — | 9 | 8 | 9 | N/A (gate, not payment) |

### ⭐ Recommended Payment Architecture

```
┌────────────────────────────────────────────────┐
│           PAYMENT ARCHITECTURE                  │
│                                                │
│  ┌──────────────────┐                          │
│  │ Shellz Club      │ ◄── ACCESS GATE          │
│  │ Membership       │     Must be a member     │
│  │ (existing system)│     to use dropship      │
│  └────────┬─────────┘                          │
│           │                                    │
│           ▼                                    │
│  ┌──────────────────┐  ┌────────────────────┐  │
│  │ Option C: Wallet │  │ Option D: Stripe   │  │
│  │ (All vendors,    │  │ Connect            │  │
│  │  all platforms)  │  │ (Shopify+Stripe    │  │
│  │                  │  │  vendors only)     │  │
│  │  MVP ⭐          │  │  Phase 2           │  │
│  └──────────────────┘  └────────────────────┘  │
│                                                │
│  Vendor chooses their payment method.          │
│  Wallet is always available.                   │
│  Stripe Connect is optional if eligible.       │
└────────────────────────────────────────────────┘
```

---


### 6.1.1 Available vs Pending Wallet Funds

Zero credit exposure requires separating spendable funds from pending deposits.

Wallet model should distinguish:
- `available_balance_cents` — settled/spendable funds
- `pending_balance_cents` — initiated but not yet settled funds
- ledger entry status: `pending`, `settled`, `failed`

Order acceptance may only use available/settled wallet balance. Pending funds must not reserve inventory, accept orders, or ship product.

Auto-reload behavior:
- Card auto-reload may continue order acceptance only after Stripe confirms successful payment and wallet credit is settled/available.
- ACH reload/deposit typically takes 3–5 business days to settle and remains pending until settlement confirmation.
- If wallet is short and auto-reload is pending or fails, the order is not accepted as funded.


### 6.1.2 Wallet Ledger Idempotency

Wallet ledger writes must be rock-solid idempotent. Retries, duplicate webhooks, polling loops, and worker restarts must not double-credit or double-debit.

Required DB constraint:
- Unique `(reference_type, reference_id)` when `reference_id IS NOT NULL`

Reference conventions:
- Order debit: `reference_type = dropship_order`, `reference_id = OMS order id` or canonical `(channel_id, external_order_id)` reference
- Deposit credit: Stripe payment intent/session/charge id
- Refund credit: original order/return id
- Manual adjustment: explicit admin adjustment id/reference

Application checks are not enough. Idempotency must be enforced at the database level and handled gracefully in application code.

## 7. Pricing & Fees

### 7.1 Wholesale Cost to Vendor

The Shellz Club app / configured member plan is the source of truth for vendor pricing and dropship entitlement. For this program, the relevant configured plan is the `.ops` plan (or whatever Shellz Club plan is configured for that vendor).

Echelon must not maintain independent hardcoded tier discount maps. Echelon should read/sync the vendor's current Shellz Club plan/entitlements and use that plan configuration to calculate wholesale cost.

At order acceptance, Echelon must snapshot the plan/entitlement values used for auditability so later Shellz Club plan changes do not rewrite historical order economics.

### 7.2 Fee Structure

| Fee | Amount | When Charged | Notes |
|-----|--------|-------------|-------|
| **Wholesale cost** | Tier-based | Per order (wallet debit) | The product cost |
| **Fulfillment fee** | $1.50/order + $0.25/item | Per order (wallet debit) | Covers pick/pack labor |
| **Shipping cost** | Fixed dropship shipping fee schedule | Per order at acceptance/reservation | Known upfront to preserve zero credit exposure; no label-cost reconciliation in MVP |
| **Platform fee** | $0 (included in membership) | — | Shellz Club membership IS the platform fee |
| **Returns processing** | $3.00/return | Per return (wallet debit) | See Section 8 |

### 7.3 Example Economics

**Product:** Premium UV Shield Toploaders 25-pack  
**Retail price:** $12.99  
**Wholesale (25% tier):** $9.74  

| | Vendor | Card Shellz |
|---|---|---|
| Customer pays vendor | $14.99 (vendor's price) | — |
| Vendor pays Card Shellz wholesale | ($9.74) | $9.74 |
| Fulfillment fee | ($1.75) | $1.75 |
| Shipping (USPS First Class) | ($4.50) | $4.50 (pass-through, label cost) |
| **Net per order** | **$5.00 profit** | **$11.99 revenue** (wholesale + fulfillment + shipping) |

Card Shellz's COGS on the product might be $4-5 for a 25-pack of toploaders, so Card Shellz nets ~$7 gross margin on the fulfillment. The vendor nets $5. Everyone wins.



### 7.4.1 MVP Shipping Charge Rule

MVP uses a fixed dropship shipping fee schedule by service/package class. Shipping is charged at order acceptance/reservation time along with product wholesale and any fulfillment fees.

Do not wait for final carrier label cost to bill the vendor in MVP. Avoid estimated-shipping reconciliation and micro debits/credits.

This preserves zero credit exposure and keeps order acceptance deterministic.

### 7.5 Vendor Listing Price Rules

Vendor listing prices are auto-filled from MAP, then vendors can approve all, approve by category, or fine-tune by SKU before pushing listings.

**MAP baseline:** Card Shellz retail price before discounts. Site sales/promos do not lower vendor MAP.

**Pricing source of truth:** Shellz Club plan configuration, specifically the vendor's configured `.ops`/dropship-entitled plan, owns wholesale discount and entitlement. Echelon consumes that configuration and snapshots the values used at order acceptance.


**Override precedence:**
1. Catalog/global markup percentage
2. Category/product-type markup percentage
3. SKU-level override

The most specific rule wins. All resolved prices must be `>= MAP`.

**Allowed override types:**
- Global/catalog: percentage only
- Category/product-type: percentage only
- SKU: percentage or fixed dollar price

Fixed dollar prices are intentionally limited to SKU-level overrides because global/category fixed prices behave badly across products with different retail prices.

Pricing rules should be separate from listing approval/selection. Recommended table/concept:

`vendor_pricing_rules`
- `vendor_id`
- `scope` (`global`, `category`, `product`, `variant`)
- `scope_id` nullable depending on scope
- `rule_type` (`percent`, `fixed`)
- `value`
- specificity/priority metadata
- timestamps

Listing resolution flow:
1. Check product selection
2. Apply SKU opt-out/override if present
3. Resolve price rule by most-specific scope
4. Validate final advertised product price against MAP
5. Generate listing preview for vendor approval

The portal must show the resolved price source, for example: `Price: $24.99, from SKU fixed override` or `Price: $17.24, from Toploaders +20% rule`.

The portal may show computed margin/profit based on the vendor's chosen listing price and known Card Shellz charges. This is informational only, not a suggested price.

Show:
- wholesale product cost
- fixed shipping charge
- fulfillment/return fees when applicable
- MAP floor
- vendor chosen listing price
- computed gross margin/profit based on chosen price

Do not recommend a margin or suggested listing price beyond auto-filling MAP.


### 7.6 Listing Preview and Approval Flow

Listing push must not be a direct "select products then push" action. The portal needs a first-class preview/approval step.

Recommended flow:
1. Vendor selects products
2. Vendor configures pricing rules
3. System generates fresh listing preview
4. Preview validates each SKU:
   - selected SKU and not opted out
   - Dropship channel allocated ATP available
   - MAP pass/fail
   - title/images/category/policies present
   - resolved price and price source
5. Vendor approves all, approves by category, or approves by SKU
6. Push creates/updates external listings

Preview should be computed fresh from current catalog, MAP, pricing rules, selection rules, and channel allocation output. Persist actual `vendor_listings` state only after an external push succeeds.

Reason: previews become stale quickly as ATP, MAP, catalog data, or rules change. Persisting preview rows as source of truth invites drift.


### 7.6.1 Listing Push Jobs

External marketplace listing push should not run directly inside a request/route flow. Use a job-based push model.

Flow:
1. Vendor approves listing preview
2. System creates a listing push job
3. Worker pushes listings to the connected marketplace/store
4. Each SKU records success/failure details
5. Vendor sees progress and results
6. Failed SKUs can be retried safely

Each listing target needs an idempotency key, for example `(vendor_store_connection_id, product_variant_id, target_platform)`, so retries update/continue the intended listing instead of creating duplicates.

This prevents request timeouts, supports partial marketplace failures, and gives vendors/admins the audit trail needed for support.

### 7.4 Shipping Rate Tiers

| Method | Rate | Delivery |
|--------|------|----------|
| USPS First Class (< 1 lb) | $4.00–5.50 | 3-5 days |
| USPS Priority | $7.50–12.00 | 2-3 days |
| UPS Ground | $8.00–14.00 | 3-7 days |
| Free shipping (vendor-subsidized) | Vendor pays Card Shellz rate; absorbs it | — |

**Vendor can offer free shipping to their customers** — they just eat the Card Shellz shipping charge in their margin. Card Shellz always gets paid for the label.

---

## 8. Returns & Refunds

### 8.1 Return Flow

```
Customer wants return
        │
        ▼
Contacts VENDOR (not Card Shellz)
        │
        ▼
┌─────────────────────────────────────────┐
│ Vendor decides:                          │
│                                         │
│ Option 1: Refund only (no return)       │
│   → Vendor refunds customer             │
│   → Card Shellz NOT involved            │
│   → Vendor eats the cost               │
│                                         │
│ Option 2: Return to Card Shellz         │
│   → Vendor generates RMA via portal     │
│   → Customer ships to Card Shellz       │
│   → Card Shellz inspects               │
│   → If acceptable: wallet credit        │
│     (wholesale - restocking fee)        │
│   → Vendor refunds their customer       │
│                                         │
│ Option 3: Vendor handles directly       │
│   → Customer returns to vendor          │
│   → Vendor deals with it               │
│   → Card Shellz not involved            │
└─────────────────────────────────────────┘
```

### 8.2 Return Scenarios

| Scenario | Who's Responsible | Card Shellz Action |
|----------|------------------|-------------------|
| Customer changed mind | Vendor | If returned to CS warehouse: inspect, credit wallet minus $3 restocking + return shipping |
| Damaged in transit | Card Shellz (shipping insurance/carrier claim) | Full wallet credit + file carrier claim |
| Wrong item shipped | Card Shellz | Full wallet credit + ship correct item free |
| Defective product | Card Shellz | Full wallet credit |
| Customer claims not received | Vendor initially investigates tracking; if confirmed lost → Card Shellz | File carrier claim, wallet credit |

### 8.3 Return Credits

When Card Shellz accepts a return:
- **Wallet credit** = wholesale cost paid - restocking fee ($3.00)
- **Fulfillment fee is NOT refunded** (labor was performed)
- **Shipping cost is NOT refunded** (label was used)
- Exception: if the error was Card Shellz's fault (wrong item, defective), full credit of all charges

### 8.4 Return Window

- Returns to Card Shellz warehouse must be initiated within **30 days** of delivery
- Product must be in resaleable condition (sealed, undamaged)
- Card Shellz reserves the right to reject returns that are opened, damaged, or unsaleable

---

## 9. Risk Management

### 9.1 Chargeback Handling

```
Customer files chargeback on vendor's store
        │
        ▼
Vendor's payment processor (Stripe/PayPal) debits VENDOR
        │
        ▼
Card Shellz is NOT directly affected
(vendor already paid via wallet)
        │
        ▼
Vendor may request wallet credit (treated as a return — see Section 8)
```

**Key point:** Because Card Shellz uses the prepaid wallet model, chargebacks are 100% the vendor's problem. Card Shellz was already paid at order submission. This is a major advantage of Option C.

### 9.2 Fraud Prevention

| Risk | Mitigation |
|------|-----------|
| Vendor submits fraudulent orders | Wallet model limits exposure to wallet balance. Address validation. |
| Vendor uses stolen credit card to fund wallet | Stripe's fraud detection on wallet funding. 3-day hold on first ACH deposit. |
| Bulk order abuse (vendor buys out all inventory) | Per-vendor allocation limits (Phase 2). Rate limiting on orders. |
| Vendor re-ships to forwarding address (fraud triangle) | Address monitoring. Flag orders to known freight forwarders. |

### 9.3 Vendor Goes MIA

| Scenario | Action |
|----------|--------|
| Vendor abandons account with wallet balance | Wallet balance held for 180 days. After 180 days, attempt contact. After 365 days, funds escheat per state law (consult attorney). |
| Vendor has orders in progress, goes dark | Complete fulfillment (already paid for). Mark account as suspended. |
| Vendor disputes wallet charges | Full audit trail in wallet ledger. Card Shellz has records of every order + delivery confirmation. |

### 9.4 IP Protection

| Control | Purpose |
|---------|---------|
| Authorized Reseller Agreement | Legal contract specifying allowed channels |
| Channel restrictions | Vendor must declare which platforms they sell on |
| Product listing audit (periodic) | Card Shellz can spot-check vendor listings |
| Watermarked images (future) | Subtle per-vendor watermarks on product images to trace unauthorized use |
| Termination clause | Card Shellz can revoke access for violations |

### 9.5 Vendor Tier System

| Tier | Criteria | Benefits |
|------|----------|----------|
| **New** | First 30 days | $200 max wallet balance, 10 orders/day limit |
| **Active** | 30+ days, 20+ orders, no issues | $2,000 max wallet, 50 orders/day |
| **Trusted** | 90+ days, 100+ orders, no issues | Unlimited wallet, 200 orders/day, priority allocation |
| **Suspended** | Payment issues, policy violations | No new orders, investigate |

---

## 10. Technical Architecture

### 10.1 System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    ECHELON (Existing)                         │
│                                                             │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────────┐  │
│  │ Catalog  │  │   OMS   │  │   WMS    │  │  Channel     │  │
│  │ Module   │  │ Module  │  │  Module  │  │  Sync Engine │  │
│  └────┬─────┘  └────┬────┘  └────┬─────┘  └──────┬───────┘  │
│       │             │            │               │          │
│       │     ┌───────┴────────────┴───────────────┘          │
│       │     │                                               │
│  ┌────▼─────▼──────────────────────────────────────────┐    │
│  │              DROPSHIP MODULE (New)                    │    │
│  │                                                      │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │    │
│  │  │ Vendor       │  │ Dropship     │  │ Wallet     │  │    │
│  │  │ Management   │  │ Order        │  │ Ledger     │  │    │
│  │  │              │  │ Ingestion    │  │            │  │    │
│  │  │ • Accounts   │  │              │  │ • Balance  │  │    │
│  │  │ • API keys   │  │ • Validation │  │ • Deposits │  │    │
│  │  │ • Tiers      │  │ • Reservation│  │ • Debits   │  │    │
│  │  │ • Settings   │  │ • OMS bridge │  │ • Credits  │  │    │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │    │
│  │                                                      │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌────────────┐  │    │
│  │  │ Product Feed │  │ Store Setup  │  │ Tracking   │  │    │
│  │  │ API          │  │ + Listings   │  │ Callback   │  │    │
│  │  │              │  │              │  │            │  │    │
│  │  │ • Catalog    │  │ • Policies   │  │ • Webhook  │  │    │
│  │  │ • ATP alloc  │  │ • Preview    │  │ • Polling  │  │    │
│  │  │ • Push jobs  │  │ • Audit      │  │ • Email    │  │    │
│  │  └──────────────┘  └──────────────┘  └────────────┘  │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              VENDOR PORTAL (New)                      │    │
│  │                                                      │    │
│  │  React app — separate auth from main Echelon UI      │    │
│  │                                                      │    │
│  │  Pages:                                              │    │
│  │  • Dashboard (orders, balance, recent activity)      │    │
│  │  • Product Catalog (browse, select, preview/push)    │    │
│  │  • My Orders (status, tracking)                      │    │
│  │  • Wallet (balance, deposit, history)                │    │
│  │  • Settings (store connection, wallet, webhooks)      │    │
│  │  • Returns (RMA requests)                            │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 New Database Tables

| Table | Purpose |
|-------|---------|
| `dropship_vendors` | Vendor accounts (linked to `members` for Shellz Club) |
| `dropship_vendor_settings` | Per-vendor config (webhook URL, notification/settings) |
| `dropship_api_keys` | API authentication keys per vendor |
| `dropship_product_selections` | Which products each vendor has selected to list |
| `dropship_order_intake` | Intake/audit records for accepted and rejected marketplace orders. Accepted records link to `oms_orders`. |
| `dropship_wallet_ledger` | Full wallet transaction history (deposits, debits, credits, adjustments) |
| `dropship_wallet_balances` | Current balance per vendor (materialized from ledger) |
| `dropship_returns` | RMA tracking |
| `dropship_vendor_tiers` | Tier history / current tier per vendor |

### 10.3 API Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `POST` | `/api/dropship/auth/login` | Vendor login (returns JWT) |
| `GET` | `/api/dropship/products` | Browse catalog with ATP |
| `GET` | `/api/dropship/products/:sku` | Single product detail |
| `POST` | `/api/dropship/orders` | Submit a dropship order |
| `GET` | `/api/dropship/orders` | List vendor's orders |
| `GET` | `/api/dropship/orders/:id` | Order detail + tracking |
| `DELETE` | `/api/dropship/orders/:id` | Cancel order (if not yet shipped) |
| `GET` | `/api/dropship/wallet/balance` | Current wallet balance |
| `GET` | `/api/dropship/wallet/transactions` | Transaction history |
| `POST` | `/api/dropship/wallet/deposit` | Initiate deposit (Stripe checkout or ACH) |
| `POST` | `/api/dropship/returns` | Create RMA request |

All endpoints authenticated via API key (header: `X-Dropship-Key`) or JWT (Bearer token from portal login).

### 10.4 Integration with Echelon

| Echelon System | Integration Point |
|---------------|-------------------|
| **Catalog** (`products`, `product_variants`, `product_assets`) | Read-only access for product feed. No writes. |
| **Allocation Engine** (`allocation-engine.service.ts`) | New channel type `dropship`. Allocation rules configured via existing UI. |
| **ATP** (`atp.service.ts`) | Dropship ATP = allocation pool - reservations. Uses existing ATP logic. |
| **OMS** (`oms_orders`, `oms_order_lines`) | Dropship orders create OMS orders with `channel = 'dropship'`, `source_vendor_id = vendor.id`. |
| **WMS** (pick/pack/ship flow) | Dropship orders enter the same pick queue. WMS picks/packs using Card Shellz-standard fulfillment. |
| **Reservation** (`reservation.service.ts`) | Dropship orders create reservations same as any channel order. |
| **Shipping** | Same label generation. Card Shellz warehouse/approved return address for MVP. |
| **Shellz Club** (`members`, `member_subscriptions`) | Vendor account linked to member record. Membership status gates dropship access. |

### 10.5 Fulfillment Presentation

No custom packing slip generator is required for MVP. Dropship orders use Card Shellz-standard/branded fulfillment.

Requirements:
- No vendor-branded packing slips in MVP
- No product pricing visible in the package
- Card Shellz warehouse/approved return address
- WMS should not need a separate pack flow beyond identifying the order as Dropship for any required handling notes

### 10.6 Vendor Portal Home UX

The vendor portal home should do both: surface urgent blockers and show business performance.

**Top: Action Center**
Revenue-blocking or attention-needed items appear first:
- low available wallet balance / pending ACH funds
- store disconnected or token/auth issue
- listing preview validation failures
- rejected order intake records with reason
- products/SKUs out of Dropship channel allocated ATP
- marketplace push failures

**Below: Performance Dashboard**
Business metrics and trend views:
- sales/orders count
- gross customer revenue reported by vendor marketplace when available
- wallet spend
- top products
- accepted vs rejected orders
- fulfillment status
- trend over time

Principle: actionability first, performance second. Blockers cost money immediately, but vendors still need stats to judge whether the program is working.


### 10.7 Admin/Ops Portal UX

The internal Card Shellz ops portal should mirror the vendor audit trail from an operator perspective. It should aggregate vendor health, revenue blockers, and program performance by severity.

Ops views should include:
- vendors with blocked revenue
- rejected intake reasons by vendor and reason code
- low available wallet / pending ACH
- marketplace push failures
- disconnected stores or expired tokens
- top vendors by order volume
- accepted vs rejected orders
- products/SKUs causing repeated listing or ATP issues
- zero-credit-exposure status: no accepted orders without settled funds and reserve

Principle: ops should be able to answer, "Who needs attention, why, and how much revenue is blocked?" without digging through logs.


### 10.8 No Hardcoded Business Rules

Dropship implementation should avoid hardcoded business rules whenever possible. Business configuration must live in the owning system, database config, or explicit environment/config records.

Examples that must not be hardcoded in production code:
- wholesale discounts / tier behavior (owned by Shellz Club `.ops` or configured member plan)
- channel IDs (lookup Dropship/internal eBay/etc. by stable key/slug/provider, not numeric ID)
- vendor portal URLs except local-dev defaults
- eBay policy names/location data
- fixed shipping fee schedule
- product selection limits
- order rate limits
- store connection limits

Rules:
- Code may have safe local-development defaults only.
- Production behavior requires explicit config/source-of-truth data.
- Hardcoded numeric channel IDs are prohibited.
- Any fallback used in production must fail closed or surface an ops blocker, not silently guess.


### 10.9 Application Use Cases / Clean Architecture

Dropship implementation should be organized around application use cases. Routes/controllers should validate DTOs/auth and call use cases; they should not contain business logic, pricing logic, ATP calculations, wallet math, or external marketplace orchestration.

Recommended use cases:
- `GenerateVendorListingPreview`
- `CreateListingPushJob`
- `ProcessListingPushJob`
- `RecordMarketplaceOrderIntake`
- `AcceptDropshipOrder`
- `CreditWalletDeposit`
- `DebitWalletForOrder`
- `RefreshStoreToken`
- `PushTrackingToVendorStore`

Each use case should have explicit inputs/outputs, deterministic validation, structured errors, and tests.

Implementation warning: do not patch more business logic into large route files. Current route-level SQL/pricing/ATP/eBay/Stripe mixing should be refactored into domain/application/infrastructure layers before launch.


### 10.10 Required Test Coverage

Dropship launch requires tests for the financial/order/listing failure modes, not just happy paths.

Required coverage:
- pricing source of truth from Shellz Club `.ops` / configured dropship-entitled plan
- integer money math, no floating point currency calculations
- MAP enforcement
- pricing override precedence
- product selection + SKU opt-out
- listing preview validation
- listing push idempotency and retry behavior
- order intake idempotency
- wallet debit/credit idempotency
- pending ACH not spendable
- zero-credit transaction rollback
- Dropship allocated ATP path; no raw inventory ATP calculation in dropship routes/use cases
- tracking push retry/failure audit
- OAuth state validation and token health states

Tests should include unit tests for domain/use-case logic and integration tests for DB constraints/transactions. External marketplace and Stripe calls must be mocked.


### 10.11 Implementation Direction: Clean Restart

The current dropship backend should be treated as prototype/scaffold/reference only, not the production foundation. Starting over for the dropship module is cleaner than patching the prototype.

Keep only useful reference snippets, such as eBay API call shapes, wallet locking concepts, and portal UI ideas. Rebuild production code around the updated design, clean use cases, shared Dropship channel allocation, Shellz Club `.ops` source-of-truth pricing, zero-credit wallet semantics, job-based marketplace operations, and DB-level idempotency.

See `DROPSHIP-IMPLEMENTATION-DELTA.md` for the dev-ready implementation delta.

## 11. Legal Framework

### 11.1 Vendor Agreement — Key Terms

The **Card Shellz Authorized Reseller & Dropship Agreement** should cover:

1. **Authorized Channels** — Vendor must declare where they sell (eBay store URL, Shopify domain). Sales on undeclared channels are a violation.

2. **MAP Policy (Minimum Advertised Price)** — Required. Sets a floor price vendors can advertise. Protects Card Shellz brand and prevents a race to the bottom.
   - MAP equals Card Shellz retail price before discounts. Card Shellz sales/promos do not lower vendor MAP.
   - Vendors may advertise above MAP, but never below MAP.
   - Shipping is vendor-side merchandising: Card Shellz charges the vendor wholesale + fulfillment/shipping costs; vendors decide what they charge their own customers for shipping.
   - Enforcement: First violation = warning. Second = 30-day suspension. Third = termination.

3. **Product Listing Standards** — Vendors must use Card Shellz product descriptions and images. No modifications to descriptions that misrepresent the product. Vendor can add their own branding to listings.

4. **No Warranty Claims** — Card Shellz provides product warranty to the vendor (as the buyer). Vendor provides warranty to their customer. Card Shellz does NOT have a direct relationship with the end customer.

5. **Termination** — Either party can terminate with 30 days notice. Card Shellz can terminate immediately for policy violations. On termination: remaining wallet balance refunded within 30 days minus any outstanding fees.

6. **Indemnification** — Vendor indemnifies Card Shellz for claims arising from vendor's sales, marketing, or customer service. Card Shellz indemnifies vendor for product defects.

7. **Data Privacy** — Card Shellz receives customer shipping addresses solely for fulfillment. Card Shellz will not market to vendor's customers. Shipping data retained per legal requirements then purged.

8. **Non-Compete (light)** — Vendor cannot represent themselves as Card Shellz or an official Card Shellz store. They are an "Authorized Reseller."

### 11.2 Tax Implications

- **Sales tax:** The vendor is the seller of record. Vendor is responsible for collecting and remitting sales tax on their sales. Card Shellz is selling wholesale to the vendor (B2B). Vendor should provide a resale certificate.
- **1099 reporting:** Not applicable — Card Shellz is NOT paying vendors (vendors are buying from Card Shellz).
- **Nexus:** Card Shellz shipping from Pittsburgh to customers nationwide may create nexus questions. Consult tax advisor. This is the same nexus exposure Card Shellz already has from direct sales.

---

## 12. Launch Strategy

### Phase 0: Foundation (Weeks 1-4)

**Goal:** Build the minimum platform and onboard 2-3 test vendors.

**Build:**
- [ ] `dropship_vendors` + `dropship_wallet_ledger` + `dropship_orders` tables
- [ ] Vendor authentication (API keys)
- [ ] Product feed API (`GET /api/dropship/products` with ATP)
- [ ] Order submission API (`POST /api/dropship/orders`)
- [ ] Wallet: manual deposits (Card Shellz admin adds balance), auto-debit on order
- [ ] Dropship channel in allocation engine (10% pool)
- [ ] OMS integration: dropship orders flow into existing pick/pack/ship
- [ ] Card Shellz-standard/branded fulfillment handling notes
- [ ] Tracking callback (webhook push to vendor)

**Skip for now:**
- Vendor portal UI (vendors use API + Card Shellz manually manages accounts)
- Vendor-facing CSV exports (direct push is the primary flow)
- Auto-deposit / Stripe funding
- Returns portal

**Onboard:**
- 2-3 existing Shellz Club members who resell on eBay
- Card Shellz manually creates their accounts, sets up API keys
- Weekly check-ins for feedback

### Phase 1: Self-Service (Weeks 5-10)

**Goal:** Vendors can sign up and operate independently.

**Build:**
- [ ] Vendor Portal (React web app)
  - Dashboard, product catalog browser, order history, wallet management
- [ ] Stripe-based wallet funding (credit card deposits)
- [ ] ACH deposits via Stripe
- [ ] Direct Shopify connection/push
- [ ] Direct eBay connection/push
- [ ] Vendor self-registration (linked to Shellz Club membership)
- [ ] Returns / RMA portal

**Onboard:**
- Open to all Shellz Club members
- Announcement email to 273 existing members
- Onboarding guide / documentation

### Phase 2: Scale & Automate (Weeks 11-20)

**Build:**
- [ ] Real-time ATP webhooks (push inventory changes to vendor endpoints)
- [ ] Stripe Connect option for Shopify vendors
- [ ] Auto-top-up for wallets
- [ ] Per-vendor allocation limits
- [ ] Vendor tier system (automated based on order history)
- [ ] Shopify app for auto-sync (product + inventory + order — vendor installs app, everything flows automatically)
- [ ] Analytics dashboard for vendors (sales, margins, top products)
- [ ] MAP enforcement tooling

### Phase 3: Marketplace (Future)

**Explore:**
- [ ] Card Shellz marketplace where vendors list alongside Card Shellz (like Amazon FBA model)
- [ ] USDC wallet funding
- [ ] International dropship (non-US addresses)
- [ ] Multi-warehouse routing (Pittsburgh + ShipMonk)
- [ ] White-label packaging (custom boxes with vendor branding)

### Beta Program

- **Invite 3-5 vendors** from the existing Shellz Club member base
- Criteria: active resellers, eBay or Shopify store, good communication
- **Beta perks:** No fulfillment fees for first 90 days, direct Slack/Discord channel with Card Shellz for support
- **Beta obligations:** Weekly feedback, report all issues, test edge cases
- **Duration:** 4-6 weeks before general availability

---

## 13. USDC / Crypto Payments — Future Note

Overlord has expressed interest in USDC/crypto as a future payment rail. Here's how it fits:

**Wallet Funding via USDC:**
- Vendor sends USDC (on Ethereum, Solana, or Base) to a Card Shellz wallet address
- Card Shellz confirms on-chain, credits vendor wallet in USD equivalent
- Near-instant settlement, minimal fees (especially on L2s like Base or Solana)
- No chargebacks on crypto — even lower risk than ACH

**Implementation path:**
1. Generate a unique deposit address per vendor (or use a memo/reference system)
2. Monitor chain for incoming transfers
3. Credit wallet on N confirmations (1 for Solana, 6 for Ethereum, 1 for Base)
4. Use a service like Circle, Coinbase Commerce, or direct on-chain monitoring

**When to build:** Phase 3. The vendor base needs to be large enough that some vendors actually want this. Crypto-native vendors exist in the trading card space (NFT crossover crowd). Don't build it until there's demand, but design the wallet system to support multiple funding methods from day one.

**Tax note:** Receiving USDC is a taxable event (same as receiving USD). No special crypto tax treatment needed — it's a stablecoin pegged 1:1 to USD.

---

## 14. Appendix: Edge Cases

### Order Edge Cases

| Scenario | Handling |
|----------|---------|
| Vendor submits order, ATP shows available, but item is actually out of stock (ATP drift) | Order accepted → during pick, item not found → Card Shellz cancels line, credits wallet, notifies vendor |
| Vendor submits duplicate order (same vendor_order_ref) | Reject with `duplicate_order_ref` error. Idempotency key. |
| Vendor submits order with invalid address | Order accepted (basic format OK) → carrier rejects at label time → Card Shellz contacts vendor for corrected address. Hold order 48h, then cancel + wallet credit. |
| Vendor submits, then immediately cancels | If status is `accepted` and not yet in pick queue → cancel, release reservation, credit wallet. If already picking → too late, ships as normal. |
| Power outage / system down during order submission | API returns 500 → vendor retries. Idempotency on vendor_order_ref prevents duplicates. |
| Vendor's customer provides PO Box | Ship via USPS (not UPS/FedEx). Auto-routing in shipping. |

### Wallet Edge Cases

| Scenario | Handling |
|----------|---------|
| Wallet balance goes negative (race condition) | Should be impossible — check balance atomically in same transaction as debit. If it happens: flag account, allow fulfillment, require immediate deposit. |
| Vendor disputes a wallet charge | Full ledger audit trail. Every charge maps to an order. Card Shellz can provide delivery confirmation. |
| Refund exceeds original charge (rounding) | Cap refund at original charge amount. |
| Vendor funds wallet with a credit card, then does a chargeback on the funding | Stripe handles initial chargeback. Suspend vendor account immediately. Wallet balance frozen. Legal recovery if needed. This is why 3-day hold on first deposit is important. |
| ACH deposit bounces | Stripe notifies. Deduct bounced amount from wallet. If insufficient balance: suspend account. |

### Inventory Edge Cases

| Scenario | Handling |
|----------|---------|
| Card Shellz discontinues a product vendors are selling | 30-day notice via portal + email. ATP goes to 0 when stock is out. Vendors responsible for delisting. |
| Multiple vendors race for last unit | First valid order wins (atomic reservation). Loser gets `out_of_stock` rejection. |
| Card Shellz needs to recall inventory from dropship pool | Reduce dropship allocation %. Existing reservations honored. New orders may be rejected. |
| ShipMonk has stock but Pittsburgh doesn't (or vice versa) | Phase 1: Dropship only from Pittsburgh warehouse. Phase 3: Multi-warehouse routing. |

### Vendor Edge Cases

| Scenario | Handling |
|----------|---------|
| Vendor creates a second account to bypass tier limits | Link to Shellz Club member ID (unique). One dropship account per member. |
| Vendor lists products below MAP | Automated monitoring (Phase 2). Warning → suspension → termination. |
| Vendor's eBay/Shopify store gets suspended | Not Card Shellz's problem directly. Vendor can't submit orders if their customers can't buy. If they have wallet balance, it stays until they request withdrawal. |
| Vendor wants to sell on Amazon | Analyze case-by-case. Amazon has specific dropship policies. May require different approach (FBA vs. MFN). Add as approved channel only if compliant. |

---

## Summary of Key Decisions Needed

| # | Decision | Recommendation | Impact |
|---|----------|---------------|--------|
| 1 | Payment model | Prepaid Wallet (Option C) for MVP | Eliminates credit risk |
| 2 | Access gate | Shellz Club membership required | Leverages existing member base |
| 3 | Dropship allocation | 10% of inventory pool, shared across vendors | Protects direct sales |
| 4 | MAP policy | Yes, equal to Card Shellz retail before discounts | Prevents race to bottom and protects direct storefront pricing |
| 5 | Fulfillment fee | $1.50/order + $0.25/item | Covers labor cost |
| 6 | Packing slips | Card Shellz-standard/branded fulfillment for MVP | Supports Card Shellz-powered reseller positioning |
| 7 | First vendors | 3-5 existing Shellz Club members | Known quantities, low risk |
| 8 | Shipping pricing | Pass-through at Card Shellz rate | Transparent, no margin games |
| 9 | Return policy | Vendor handles customer; Card Shellz credits wallet if product returned | Clean separation |
| 10 | Vendor portal | Build in Phase 1, API-only for Phase 0 | Reduces MVP scope |

---

*End of document. Ready for review.*

---

## 15. Expanded Vision — Unified Commerce Platform

The dropship platform evolved during architectural review into a broader play: a unified commerce platform serving four distinct customer tiers on the same Echelon infrastructure. Same catalog, same inventory, same warehouse — different frontends, different payment rails, different pricing.

### 15.1 Customer Tiers

**Tier 1: Retail Customer (cardshellz.io)**
- Crypto-native storefront — USDC on Base only, no Stripe, no card payments
- Retail pricing, open to anyone
- Coinbase Onramp widget available for customers who need to acquire USDC with a debit card (~1.5% fee, paid by customer)
- Zero payment processing fees for Card Shellz
- Separate domain from cardshellz.com — Shopify stays for traditional retail

**Tier 2: Shellz Club Member**
- Wholesale pricing gated behind existing Shellz Club membership
- Same USDC payment rail as Tier 1
- B2B pricing on the same storefront (cardshellz.io)

**Tier 3: Dropship Vendor**
- Wholesale pricing + fulfillment fee (as defined in Sections 5–6)
- eBay/Shopify integration — Echelon pushes listings to vendor stores
- Orders flow back automatically into OMS
- Wallet with auto-reload (Stripe or USDC)

**Tier 4: Agent Commerce**
- API-first — no UI required
- Agent discovers products via agents.json, OpenAPI spec, and llms.txt
- `POST /api/orders` with SKUs, quantities, and ship-to address
- USDC payment via smart contract allowance (pre-approved spend limit)
- Fully programmatic — no human interaction, no browser

### 15.2 Payment Architecture (Updated)

Two funding rails feed into one Echelon ledger:

**Rail 1: Stripe**
- Card and ACH payments — compliant, turnkey
- Used for vendor wallet auto-reload (set-and-forget)
- Automatic via Stripe Customer Balance (built-in feature)

**Rail 2: USDC on Base**
- Zero-fee transactions (~$0.01 per tx on Base L2)
- Used for:
  - Retail checkout on cardshellz.io (Tiers 1 & 2)
  - Vendor wallet funding — manual deposit or auto via smart contract approval (Tier 3)
  - Agent commerce — fully programmatic (Tier 4)

**Smart Contract Design:**
- Deployed on Base (Coinbase L2)
- Vendor or agent calls `approve()` on the USDC contract once, authorizing the Card Shellz contract to pull up to X USDC
- Card Shellz contract exposes a `pullFunds(address vendor, uint256 amount)` function — callable only by the Card Shellz backend
- Echelon detects low wallet balance → triggers `pullFunds` → USDC lands in Card Shellz's Coinbase Business account
- Transaction cost: ~$0.01 on Base
- Contract complexity: ~20 lines of Solidity

**Auto-Reload Logic:**
- Stripe path: automatic via Stripe Customer Balance when wallet drops below threshold
- USDC path: automatic via smart contract `transferFrom` triggered by Echelon when balance drops below threshold
- Both paths credit the same Echelon vendor ledger — funding source is transparent to OMS/WMS

**Coinbase Business Account:**
- Single destination for all USDC payments across all tiers
- Full reporting, audit trail, and tax documentation
- Easy off-ramp to USD when needed

### 15.3 The Storefront Split

| Channel | Audience | Payment | Platform Fee |
|---|---|---|---|
| cardshellz.com (Shopify) | Traditional retail | Visa/MC/PayPal | Shopify + Stripe ~3.2% |
| cardshellz.io (Own) | Crypto-native retail | USDC on Base | ~$0.01 flat |
| Vendor dropship | eBay/Shopify resellers | Stripe wallet + USDC | Fulfillment fee |
| Agent API | AI agents | USDC on Base | Fulfillment fee |

Same catalog. Same ATP. Same warehouse. Same Echelon backend. Different frontends, different payment rails.

### 15.4 Positioning

- "The first trading card supplies company with an agent-native commerce API"
- "Zero-fee crypto checkout at cardshellz.io"
- Shopify stays for mainstream customers. cardshellz.io is the cutting edge — crypto buyers, agent commerce, B2B wholesale
- Long-term trajectory: cardshellz.io replaces Shopify entirely as crypto adoption grows

### 15.5 Technical Architecture (Updated)

- **Echelon** is the single backend for all four channels
- **cardshellz.io** is a new React frontend hitting Echelon's API directly
- **Smart contract on Base** handles USDC payments and pre-approved allowances
- **agents.json + OpenAPI spec** enable agent discovery and programmatic ordering
- **Stripe** serves as traditional payment fallback and auto-reload mechanism
- **All orders** — regardless of channel — flow through OMS → WMS → same pick/pack/ship pipeline

---

*Section 15 appended 2026-03-22. Unified commerce vision expanding Echelon from dropship platform to multi-tier commerce engine.*

---

## 16. Design Review Corrections

> **Date:** 2026-03-22  
> **Context:** Decisions made during design review that override or clarify the original document (Sections 1–15). Where these corrections conflict with earlier sections, **this section governs**.

### 16.1 Shipping & Branding — NOT Blind Shipment

The original doc (Section 4.4) describes a blind dropship model. **This is reversed.**

- **Card Shellz branded shipping** — branded tape, branded boxes, Card Shellz branding visible on the outside of every package
- **No packing slips** — nothing inside the box. No plain slip, no vendor-branded slip, no Card Shellz slip. Empty box + product.
- **Card Shellz WANTS brand exposure** to the vendor's end customer. Every package is a Card Shellz brand touchpoint.
- **Return address:** Card Shellz warehouse on all packages and all vendor listings
- **No "packing slip options"** — the entire packing slip feature (Section 10.5, Section 7.2 branded packing slip fee) is removed from scope

**What this means for the system:**
- Remove packing slip generator from technical architecture
- Remove `packing_slip` field from order submission API
- Remove `$0.50/order branded packing slip` fee line item
- WMS workflow: pick → pack in Card Shellz branded box with Card Shellz tape → ship. No slip printing step.
- Simplifies WMS — no per-vendor packing logic

### 16.2 Product Feed — Direct Push, Not CSV Export

The original doc (Section 3) describes CSV exports and vendor-managed imports. **This is replaced with direct push.**

- **Echelon pushes listings directly** to the vendor's eBay or Shopify store via OAuth
- Vendor connects their eBay/Shopify account → Echelon creates and manages listings on their behalf
- **No CSV exports** — remove Shopify CSV and eBay CSV export endpoints from the API
- **eBay vendors first** — primary launch channel. Reuse existing Echelon eBay push infrastructure with multi-tenant vendor tokens
- **Shopify vendors second** — Phase 2

**What this means for the system:**
- Vendor onboarding includes eBay OAuth flow (vendor grants Echelon access to their eBay account)
- Echelon's existing `channel-sync-engine` extends to handle vendor eBay accounts (multi-tenant)
- Product selection in vendor portal still exists — vendor picks which SKUs to list, Echelon pushes those listings
- ATP sync pushes inventory updates directly to vendor's eBay listings (real-time, not webhook-to-vendor)
- Orders flow back via eBay API (Echelon polls vendor's eBay orders or receives eBay notifications)
- Remove `/api/dropship/export/shopify` and `/api/dropship/export/ebay` endpoints

### 16.3 Fees — Simplified Structure

The original doc (Section 7.2) lists separate fulfillment fees and branded packing slip fees. **Simplified.**

| Fee | Amount | Notes |
|-----|--------|-------|
| **Wholesale price** | Tier-based (per Shellz Club) | All-in: covers product + handling. No separate fulfillment fee. |
| **Shipping** | One number to the vendor | Composed of: pass-through label cost + ~10-15% markup for dunnage (box, tape, packing paper) + insurance pool allocation (~2%) + margin. Vendor sees a single "shipping" charge. |
| **Return processing** | $3.00 per return | Per return, NOT per item. A multi-item return = $3. |
| **Platform fee** | $0 | Included in Shellz Club membership |

**Removed from the fee structure:**
- ~~Fulfillment fee ($1.50/order + $0.25/item)~~ — baked into wholesale
- ~~Branded packing slip ($0.50/order)~~ — no packing slips at all
- ~~Free shipping threshold for dropship~~ — vendor ALWAYS pays shipping, no exceptions

**Updated example economics:**

**Product:** Premium UV Shield Toploaders 25-pack  
**Retail price:** $12.99  
**Wholesale (25% tier):** $9.74 (all-in: product + handling)

| | Vendor | Card Shellz |
|---|---|---|
| Customer pays vendor | $14.99 (vendor's price) | — |
| Wholesale (all-in) | ($9.74) | $9.74 |
| Shipping (vendor sees this number) | ($5.25) | $5.25 (label ~$4.50 + dunnage + insurance pool + margin) |
| **Net per order** | **$5.00 profit** | **$14.99 revenue** |

### 16.4 SLA — 1 Business Day

- **Dropship orders: 1 business day ship SLA** for orders received by 2:00 PM ET
- Orders after 2:00 PM ET ship next business day
- **Dropship orders receive priority in the pick queue** over standard Card Shellz retail orders
- Rationale: vendor's eBay metrics depend on fast shipping. Late shipment = defects on vendor's account. Card Shellz must protect vendor accounts.

### 16.5 Payment — Updated Architecture

The original doc recommends Prepaid Wallet (Option C). **Updated to use Stripe Customer Balance + USDC on Base.**

**One Echelon ledger, two funding rails:**

| Rail | Method | Details |
|------|--------|---------|
| **Stripe** | Stripe Customer Balance | ACH or card. Vendor saves a payment method. Auto-reload when balance drops below threshold. |
| **USDC on Base** | Smart contract `transferFrom` | Vendor approves Card Shellz contract once. Echelon auto-pulls USDC when wallet is low. USDC routes to Card Shellz Coinbase Business account. |

**Key changes from original:**
- **No manual wallet deposits** — auto-reload from day one (Stripe saved payment method)
- **ACH in transit = ship on 1-day credit** if vendor is Plaid-verified (de-risks ACH float)
- **USDC goes to Coinbase Business account** — not a self-custodied wallet
- **Smart contract on Base** for USDC auto-pull (same design as Section 15.2)
- Stripe Customer Balance eliminates stored-value / money transmitter regulatory concerns (Stripe holds the funds, not Card Shellz)

**Auto-Reload Logic:**
```
Vendor wallet balance drops below threshold
         │
         ├── Stripe rail: Stripe charges saved payment method automatically
         │   (built-in Stripe Customer Balance feature)
         │
         └── USDC rail: Echelon calls pullFunds() on Base smart contract
             → USDC transfers to Card Shellz Coinbase Business account
             → Echelon credits vendor wallet
```

### 16.6 Insurance Pool

- **Internal allocation** from the shipping markup — not a separate line item
- ~2% of shipping fees set aside into an internal damage/loss claims budget
- **Not exposed to vendors** — they don't know it exists. It's an internal Card Shellz risk budget.
- Used to self-insure instead of purchasing per-package carrier insurance
- Claims process: vendor reports damage/loss → Card Shellz evaluates → credits wallet from insurance pool if approved
- Pool is a P&L line item, not a vendor-facing feature

### 16.7 Returns — Updated Policy

The original doc (Section 8) describes three return paths. **Simplified and updated.**

**Core principles:**
- Vendor owns their customer return policy (Card Shellz does not dictate)
- All returns ship to **Card Shellz warehouse** (Card Shellz branded return address on all vendor listings)
- $3.00 per return processing fee (per return, not per item)

**Return credit calculation:**

| Scenario | Wallet Credit | Shipping Refund | Fulfillment Refund | Return Label |
|----------|--------------|----------------|-------------------|-------------|
| Customer changed mind / vendor's policy | Wholesale minus restocking | ❌ Not refunded | ❌ Not refunded (baked into wholesale) | Vendor (via eBay) or customer pays — Card Shellz never generates return labels |
| Card Shellz fault (wrong item, defective, damaged) | Full wholesale credit | ❌ Not refunded | ❌ Not refunded | Card Shellz reimburses label cost via wallet credit |

**Key changes from original:**
- ~~Option 3 (vendor handles directly)~~ — removed. Returns always come to Card Shellz warehouse.
- ~~Fulfillment fee refund exception~~ — no separate fulfillment fee exists, so nothing to refund separately
- **Card Shellz never generates return labels** — vendor generates via eBay's return flow, or customer pays their own return shipping
- When Card Shellz is at fault, Card Shellz reimburses the return label cost as a wallet credit (not by generating a label)
- $3 processing fee applies to ALL returns, including Card Shellz fault returns

---

*Section 16 appended 2026-03-22. Design review corrections override conflicting content in Sections 1–15.*

---

## 17. Launch Strategy (Revised)

> Replaces Section 12. This phased plan reflects the corrected design decisions from Section 16 and the unified commerce vision from Section 15.


### 17.1 Recommended Build Sequence After Design Review

Do not continue patching the started backend route files as-is. The design now depends on clean use cases, shared allocation, idempotent jobs, and zero-credit wallet semantics.

Recommended sequence:
1. Data model + migrations
2. Clean use-case layer
3. Pricing/entitlement adapter from Shellz Club `.ops` / configured dropship-entitled plan
4. Shared Dropship channel allocation integration
5. Listing preview endpoint
6. Listing push jobs
7. Wallet available/pending balances + ledger idempotency
8. Order intake jobs + atomic order acceptance
9. Tracking push jobs
10. Vendor/admin portal polish

Reason: avoid building UI or marketplace flows on backend assumptions that were invalidated by this review.

### Phase 0: Foundation (4 weeks)

**Goal:** Prove the core loop — vendor connects eBay → products push to their store → customer buys → Card Shellz fulfills → tracking flows back.

**What's Built:**
- [ ] Vendor portal (basic) — account management, product selection, wallet view, order history
- [ ] eBay OAuth flow — vendor connects their eBay account, grants Echelon listing/order permissions
- [ ] Multi-tenant eBay push — extend existing Echelon channel sync to push listings to vendor eBay accounts using vendor OAuth tokens
- [ ] Stripe Customer Balance integration — vendor wallet funded via Stripe (saved ACH or card)
- [ ] Wallet ledger in Echelon — deposits, debits, credits, full audit trail
- [ ] Dropship order ingestion — eBay orders from vendor accounts pulled into Echelon OMS as dropship orders
- [ ] 1-day ship SLA queue priority for dropship orders
- [ ] Card Shellz branded packing (no packing slips — just branded box + tape)
- [ ] Tracking push back to vendor's eBay (via eBay API, auto-updates buyer's order)

**Who's Onboarded:**
- 2-3 hand-picked beta vendors — existing Shellz Club members who already sell on eBay
- Must have active eBay store with good seller metrics
- Personally onboarded by Overlord / Card Shellz team

**What's Manual:**
- Vendor onboarding (account creation, eBay OAuth walkthrough)
- Wallet funding via Stripe dashboard (no auto-reload yet)
- Product selection (Card Shellz picks initial catalog for each vendor)

**What's Validated:**
- [ ] eBay OAuth grants work and tokens persist
- [ ] Listings push correctly to vendor's eBay store (title, images, price, ATP)
- [ ] ATP syncs — when Card Shellz inventory changes, vendor eBay listings update
- [ ] Customer buys on vendor's eBay → order flows into Echelon OMS
- [ ] Wallet debit works — wholesale + shipping deducted at order acceptance
- [ ] Pick/pack/ship with Card Shellz branded packaging (no slips)
- [ ] Tracking number pushes back to vendor's eBay → buyer sees tracking
- [ ] 1-day ship SLA is achievable with current warehouse operations

**Risks & Blockers:**
- **eBay API rate limits** — multi-tenant token management must respect eBay's per-app and per-user limits
- **eBay listing policies** — ensure vendor listings created by Echelon comply with eBay's automated listing rules (no duplicate listings, proper item specifics)
- **Warehouse capacity** — dropship orders add volume. Validate that 1-day SLA is feasible alongside existing retail order volume
- **Token expiry** — eBay OAuth tokens expire. Must implement refresh flow before tokens lapse mid-operation

### Phase 1: Self-Service (6 weeks)

**Goal:** Any Shellz Club member can sign up, connect their eBay, select products, fund their wallet, and start selling — without Card Shellz hand-holding.

**What's Built:**
- [ ] Vendor self-service portal — full signup flow: create account → link Shellz Club membership → connect eBay via OAuth → browse catalog → select products → fund wallet → go live
- [ ] Auto-reload via Stripe — vendor sets threshold (e.g., "reload $200 when balance drops below $50"), Stripe charges saved payment method automatically
- [ ] Real-time ATP sync to vendor listings — inventory changes push to vendor's eBay listings within minutes
- [ ] Order status dashboard — vendor sees all orders, statuses, tracking in real-time
- [ ] Wallet management UI — balance, transaction history, reload settings, payment method management
- [ ] Returns processing — vendor submits RMA via portal, Card Shellz inspects return, wallet credit applied
- [ ] Plaid verification for ACH — verified vendors get 1-day credit on ACH in transit

**Who's Onboarded:**
- Open to all Shellz Club members
- Announcement via email to existing member base + social media
- Self-service — vendor signs up, connects, and goes live without Card Shellz involvement

**What's Automated:**
- Vendor onboarding (fully self-service)
- Wallet top-up (Stripe auto-reload)
- Order flow (eBay order → Echelon OMS → fulfillment → tracking → eBay update)
- ATP sync (inventory changes → vendor listing updates)

**What's Validated:**
- [ ] Self-service onboarding works end-to-end without support tickets
- [ ] Auto-reload prevents wallet depletion (no missed orders due to insufficient funds)
- [ ] ATP sync keeps vendor listings accurate (no overselling)
- [ ] Return credits process correctly (wholesale minus restocking, $3 fee)
- [ ] Vendor retention — are beta vendors continuing to use the platform and growing volume?

**Risks & Blockers:**
- **Support volume** — self-service launch may generate support tickets. Need FAQ / knowledge base ready.
- **eBay policy compliance at scale** — more vendors = more listings = more surface area for eBay policy violations. Need monitoring.
- **Wallet funding friction** — if Stripe onboarding is clunky, vendors may drop off. UX must be polished.
- **Pricing pressure** — vendors may undercut each other. Consider MAP enforcement timeline.

### Phase 2: Scale (8 weeks)

**Goal:** Add USDC payments, Shopify vendor support, analytics, and agent commerce API. Position Card Shellz as a platform, not just a supplier.

**What's Built:**
- [ ] USDC on Base — smart contract for auto-pull, Coinbase Business integration, vendor wallet funding via USDC
- [ ] Shopify vendor support — OAuth for Shopify stores, push listings to vendor's Shopify, pull orders from vendor's Shopify
- [ ] Vendor analytics dashboard — sales volume, top products, margin analysis, fulfillment speed metrics
- [ ] Agent commerce API — `agents.json` at cardshellz.com, OpenAPI spec, `llms.txt` for agent discoverability
- [ ] MAP enforcement tooling — pre-push validation in MVP; automated live listing monitoring, violation alerts, escalation workflow in Phase 2
- [ ] Per-vendor allocation limits (if needed based on Phase 1 data)
- [ ] Vendor tier system — automated tier progression based on order history

**Who's Onboarded:**
- Public launch — marketing to eBay trading card sellers beyond existing Shellz Club membership
- Shopify vendors can now join
- Crypto-native vendors attracted by USDC option
- First agent commerce integrations (outreach to agent platforms)

**What's Validated:**
- [ ] USDC auto-pull works — Echelon triggers smart contract, funds arrive in Coinbase Business
- [ ] Shopify push/pull works — listings sync, orders flow, tracking updates
- [ ] Agent API is discoverable and functional — an AI agent can find, browse, and order Card Shellz products programmatically
- [ ] Vendor analytics drive behavior — vendors use data to optimize their product selection
- [ ] Unit economics are healthy — shipping markup covers dunnage + insurance pool + margin

**Risks & Blockers:**
- **Smart contract security** — USDC auto-pull contract must be audited before mainnet deployment. Even at ~20 lines of Solidity, it handles real money.
- **Shopify app review** — if building a Shopify app for vendor integration, Shopify's review process can take weeks. Plan accordingly.
- **Agent commerce demand** — may be early. Build it, but don't over-invest until there's traction.
- **Multi-platform complexity** — supporting eBay + Shopify multiplies edge cases (different order formats, different tracking flows, different return policies per platform)

### Phase 3: Platform (12+ weeks)

**Goal:** Full unified commerce platform. Card Shellz becomes the infrastructure layer for trading card supplies commerce.

**What's Built:**
- [ ] cardshellz.xyz — crypto retail storefront (USDC on Base checkout, Coinbase Onramp for fiat-to-USDC)
- [ ] Vendor tier system with earned benefits — Trusted vendors get returns guarantee (Card Shellz absorbs return risk), priority allocation, lower shipping markup
- [ ] International shipping — extend dropship to non-US addresses (start with Canada, then expand)
- [ ] Multi-warehouse routing — orders route to nearest fulfillment center (Pittsburgh + future locations)
- [ ] White-label API — partners can build their own frontends on Card Shellz's commerce infrastructure
- [ ] Vendor referral program — existing vendors earn credit for onboarding new vendors

**Who's Onboarded:**
- International vendors / international shipping customers
- cardshellz.xyz retail customers (crypto-native buyers)
- Platform partners building on Card Shellz APIs

**What's Validated:**
- [ ] cardshellz.xyz generates meaningful retail revenue via USDC
- [ ] Vendor tier system incentivizes growth and loyalty
- [ ] International shipping is operationally sustainable (customs, duties, carrier partnerships)
- [ ] Platform economics — does the unified commerce model generate more total revenue than direct-only?

**Risks & Blockers:**
- **International complexity** — customs documentation, duties, prohibited items by country, carrier partnerships. Significant operational lift.
- **Crypto retail adoption** — cardshellz.xyz assumes crypto-native buyers exist in volume. May be ahead of market. Monitor conversion rates closely.
- **Platform ambition vs. execution** — this phase is a major expansion. Must be funded by Phase 0–2 revenue, not speculative investment.
- **Regulatory** — international sales, crypto payments, and platform economics each carry regulatory considerations. Legal review required.

### Phase Summary

| Phase | Duration | Key Deliverable | Success Metric |
|-------|----------|----------------|----------------|
| **0: Foundation** | 4 weeks | Core loop working with 2-3 beta vendors | Orders flowing, tracking pushing, wallet debiting |
| **1: Self-Service** | 6 weeks | Any Shellz Club member can self-onboard | 10+ active vendors, zero-touch onboarding |
| **2: Scale** | 8 weeks | USDC, Shopify, agent API, public launch | 50+ vendors, first USDC transaction, first agent order |
| **3: Platform** | 12+ weeks | cardshellz.xyz, international, vendor tiers | Revenue from all four customer tiers (Section 15.1) |

### Go/No-Go Criteria Between Phases

| Gate | Criteria | Decision Maker |
|------|----------|----------------|
| Phase 0 → 1 | Beta vendors have completed 50+ orders. Ship SLA met >95%. No critical bugs. Vendor feedback is positive. | Overlord |
| Phase 1 → 2 | 10+ self-service vendors onboarded. Auto-reload working. ATP sync reliable. Unit economics confirmed positive. | Overlord |
| Phase 2 → 3 | 50+ active vendors. USDC pipeline operational. Shopify integration stable. Revenue justifies platform investment. | Overlord |

---

*Section 17 appended 2026-03-22. Revised launch strategy reflecting design review corrections and unified commerce vision.*
