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

Card Shellz wants to enable resellers (vendors) to list and sell Card Shellz products on their own eBay and Shopify stores, with Card Shellz handling all fulfillment. The vendor never touches product. This is a **blind dropship** model — the end customer sees the vendor's brand, not Card Shellz.

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
│  │ Echelon OMS  │──▶│ WMS picks │──▶│ Ship blind (vendor's  │   │
│  │ validates &  │   │ packs     │   │ branding or plain     │   │
│  │ reserves inv │   │ orders    │   │ packing slip)         │   │
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
- Export selected products in Shopify CSV or eBay CSV format
- Access the API for programmatic integration

**Feed formats (prioritized):**

| Format | Use Case | Effort |
|--------|----------|--------|
| **Shopify CSV export** | Vendor imports into their Shopify store | Low — generate from existing product data |
| **eBay CSV export** | Vendor imports via eBay File Exchange | Low — map to eBay bulk upload format |
| **REST API** | Automated integrations, power vendors | Medium — new endpoints |
| **Shopify app (future)** | Auto-sync products + inventory to vendor's Shopify | High — requires Shopify app approval |

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
- Vendors see a **dropship-allocated ATP** — not the full Card Shellz inventory (see Section 5)
- When ATP hits 0, product shows as "out of stock" in the feed
- Vendors are responsible for delisting or marking OOS on their stores

**Real-time option (Phase 2):** Webhook push when ATP changes for products a vendor has selected. Vendor registers a webhook URL, Card Shellz pushes `{ sku, atp, timestamp }` on every meaningful change.

### 3.4 Vendor Product Selection

Vendors don't have to list everything. In the portal:
1. Browse catalog → toggle "List this product" per SKU
2. Selected products appear in their "My Products" view
3. Exports only include selected products
4. ATP webhooks only fire for selected products
5. Vendor can set their own retail price per SKU in the portal (for reference/tracking — not enforced on their store)

### 3.5 Image Hosting

Card Shellz hosts product images. Vendors can:
- **Hotlink** — use Card Shellz CDN URLs directly (simplest, recommended)
- **Download** — bulk download images for self-hosting

Hotlinking is fine for Shopify and eBay. Both platforms allow external image URLs. This also means when Card Shellz updates an image, all vendor listings auto-update.

---

## 4. Order Flow

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
         │ • Blind packing   │
         │   slip (vendor    │
         │   branding or     │
         │   plain)          │
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
5. **Wallet balance** — vendor has funds ≥ wholesale cost + estimated shipping
6. **Ship-to validation** — address is deliverable (basic format check; carrier validates at label time)
7. **Rate limiting** — prevent bulk spam (100 orders/hour per vendor max)

If any check fails, the order is rejected with a clear error. No partial orders — all items must pass or the whole order is rejected.

### 4.4 Blind Shipment

**Critical requirement:** The customer must NOT know Card Shellz fulfilled the order.

- **Return address:** Configurable per vendor. Options:
  - Vendor's return address (preferred — customer returns go to vendor)
  - Card Shellz warehouse (if vendor opts in for return handling)
  - Plain/generic address
- **Packing slip options:**
  - **Plain** — no branding, just items and quantities (default)
  - **Vendor-branded** — vendor uploads their logo; Card Shellz prints their branded slip
  - **None** — no packing slip included
- **No Card Shellz marketing materials** in the box
- **No Card Shellz pricing** visible anywhere in the package
- **Shipping label** shows ship-from as vendor's address or Card Shellz warehouse (configurable)

### 4.5 Tracking Flow

```
Card Shellz ships order
         │
         ▼
Carrier provides tracking number
         │
         ├──▶ Stored in Echelon OMS (oms_orders, shipments)
         │
         ├──▶ Pushed to vendor via:
         │    • Webhook callback (vendor provides URL)
         │    • API polling (vendor calls GET /api/dropship/orders/{id})
         │    • Portal display (vendor checks status in web UI)
         │
         ▼
Vendor updates their store
(vendor's responsibility to push
 tracking to their customer)
```

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

**Echelon already has an allocation engine** (`allocation-engine.service.ts`, `channel_allocation_rules`). Dropship becomes a new "channel" in this system.

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
Dropship ATP = Dropship Allocation Pool
             - Active Dropship Reservations
             - Safety Stock (if any held from dropship)
```

This ties directly into Echelon's existing `atp.service.ts`. Add a `channel_type = 'dropship'` to the channels table, and the allocation engine handles the rest.

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
| CSV export from portal | On-demand | Bulk import to vendor store |
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

## 7. Pricing & Fees

### 7.1 Wholesale Cost to Vendor

Tied to Shellz Club tier:

| Tier | Membership | Wholesale Discount | Dropship Access |
|------|-----------|-------------------|-----------------|
| Shellz Club Standard | $49/yr | 15% off retail | ✅ Included |
| Shellz Club Pro | $99/yr | 25% off retail | ✅ Included + branded packing slips |
| Shellz Club Elite | $199/yr | 30% off retail + priority allocation | ✅ Included + all features |

**Note:** These tiers are illustrative. Align with whatever Shellz Club tiers currently exist. The point: membership tier determines wholesale pricing, dropship access comes with membership.

### 7.2 Fee Structure

| Fee | Amount | When Charged | Notes |
|-----|--------|-------------|-------|
| **Wholesale cost** | Tier-based | Per order (wallet debit) | The product cost |
| **Fulfillment fee** | $1.50/order + $0.25/item | Per order (wallet debit) | Covers pick/pack labor |
| **Shipping cost** | Pass-through at Card Shellz negotiated rate | Per order (wallet debit) | Card Shellz's USPS/UPS rates — vendor gets the benefit of Card Shellz's volume discounts |
| **Platform fee** | $0 (included in membership) | — | Shellz Club membership IS the platform fee |
| **Branded packing slip** | $0.50/order | Per order (wallet debit) | Only if vendor opts for branded slips |
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
│  │  │ Product Feed │  │ Packing Slip │  │ Tracking   │  │    │
│  │  │ API          │  │ Generator    │  │ Callback   │  │    │
│  │  │              │  │              │  │            │  │    │
│  │  │ • Catalog    │  │ • Plain      │  │ • Webhook  │  │    │
│  │  │ • ATP        │  │ • Branded    │  │ • Polling  │  │    │
│  │  │ • CSV export │  │ • PDF render │  │ • Email    │  │    │
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
│  │  • Product Catalog (browse, select, export)          │    │
│  │  • My Orders (status, tracking)                      │    │
│  │  • Wallet (balance, deposit, history)                │    │
│  │  • Settings (API keys, webhook URLs, packing slip)   │    │
│  │  • Returns (RMA requests)                            │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 10.2 New Database Tables

| Table | Purpose |
|-------|---------|
| `dropship_vendors` | Vendor accounts (linked to `members` for Shellz Club) |
| `dropship_vendor_settings` | Per-vendor config (webhook URL, packing slip preference, return address) |
| `dropship_api_keys` | API authentication keys per vendor |
| `dropship_product_selections` | Which products each vendor has selected to list |
| `dropship_orders` | Dropship-specific order metadata (vendor_id, vendor_order_ref, packing_slip_type). Links to `oms_orders`. |
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
| `GET` | `/api/dropship/export/shopify` | Export selected products as Shopify CSV |
| `GET` | `/api/dropship/export/ebay` | Export selected products as eBay CSV |

All endpoints authenticated via API key (header: `X-Dropship-Key`) or JWT (Bearer token from portal login).

### 10.4 Integration with Echelon

| Echelon System | Integration Point |
|---------------|-------------------|
| **Catalog** (`products`, `product_variants`, `product_assets`) | Read-only access for product feed. No writes. |
| **Allocation Engine** (`allocation-engine.service.ts`) | New channel type `dropship`. Allocation rules configured via existing UI. |
| **ATP** (`atp.service.ts`) | Dropship ATP = allocation pool - reservations. Uses existing ATP logic. |
| **OMS** (`oms_orders`, `oms_order_lines`) | Dropship orders create OMS orders with `channel = 'dropship'`, `source_vendor_id = vendor.id`. |
| **WMS** (pick/pack/ship flow) | Dropship orders enter the same pick queue. WMS doesn't care about the channel — it just picks and packs. Packing slip generation is the only WMS-visible difference. |
| **Reservation** (`reservation.service.ts`) | Dropship orders create reservations same as any channel order. |
| **Shipping** | Same label generation. Return address and packing slip differ per vendor config. |
| **Shellz Club** (`members`, `member_subscriptions`) | Vendor account linked to member record. Membership status gates dropship access. |

### 10.5 Packing Slip Generation

**New component:** A packing slip renderer that accepts:
- Order details (items, quantities)
- Vendor config (logo URL, company name, or "plain")
- Output: PDF for printing during pack step

**WMS integration:** When packer scans an order that's tagged as dropship:
- System fetches vendor's packing slip preference
- Generates appropriate slip (plain or vendor-branded)
- Prints on pack station printer

This is the **only WMS workflow change** for dropship orders.

---

## 11. Legal Framework

### 11.1 Vendor Agreement — Key Terms

The **Card Shellz Authorized Reseller & Dropship Agreement** should cover:

1. **Authorized Channels** — Vendor must declare where they sell (eBay store URL, Shopify domain). Sales on undeclared channels are a violation.

2. **MAP Policy (Minimum Advertised Price)** — Optional but recommended. Sets a floor price vendors can advertise. Protects Card Shellz brand and prevents a race to the bottom.
   - Recommendation: Set MAP at 10% below Card Shellz retail. Vendors can sell for more but not less.
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
- [ ] Plain packing slips (no vendor branding yet)
- [ ] Tracking callback (webhook push to vendor)

**Skip for now:**
- Vendor portal UI (vendors use API + Card Shellz manually manages accounts)
- CSV exports
- Branded packing slips
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
- [ ] Shopify CSV export
- [ ] eBay CSV export
- [ ] Vendor self-registration (linked to Shellz Club membership)
- [ ] Branded packing slip generation (vendor uploads logo)
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
| 4 | MAP policy | Yes, 10% below retail floor | Prevents race to bottom |
| 5 | Fulfillment fee | $1.50/order + $0.25/item | Covers labor cost |
| 6 | Packing slips | Plain (MVP), Vendor-branded (Phase 1) | Maintains blind shipment |
| 7 | First vendors | 3-5 existing Shellz Club members | Known quantities, low risk |
| 8 | Shipping pricing | Pass-through at Card Shellz rate | Transparent, no margin games |
| 9 | Return policy | Vendor handles customer; Card Shellz credits wallet if product returned | Clean separation |
| 10 | Vendor portal | Build in Phase 1, API-only for Phase 0 | Reduces MVP scope |

---

*End of document. Ready for review.*
