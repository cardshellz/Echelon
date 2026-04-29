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
- [ ] MAP enforcement tooling — automated listing price monitoring, violation alerts, escalation workflow
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

---

## 18. Portal Design Review Decisions

> **Date:** 2026-04-26
> **Context:** Decisions made during the .ops vendor portal design review. Where these conflict with earlier sections, **this section governs**. Section 16 corrections still apply where not explicitly superseded.

### 18.1 Brand & Portal Identity

- Portal brand: **Card Shellz .ops** (or **.ops**), the vendor-facing operational surface
- Domain: **cardshellz.io** (separate from cardshellz.com retail)
- .ops is both the Shellz Club membership tier (gating dropship access) AND the portal name
- Aesthetic: light background, professional, Apple-like, business-forward
- Primary purple: `rgb(192, 96, 224)` / `#C060E0`
- Typography: Inter Tight (headings) + Inter (body) — sans serif, business-forward, easy to read
- Logo: `.ops` cube logomark for portal; `.ops` shellz hex reserved for parent Card Shellz brand surfaces

### 18.2 Authentication

- **SSO bridge from cardshellz.com** — single account across both sites
- cardshellz.com is the identity provider; cardshellz.io trusts it
- Vendor never creates a separate .ops account; their Shellz Club membership IS their .ops identity
- Portal login button: "Sign in with Card Shellz"

### 18.3 Phase Coverage

The portal is designed to the full Phase 2 vision (USDC, Shopify, agent API, analytics) with Phase 2 features marked as "Coming Phase 2" placeholders so the trajectory is visible without committing UI to unbuilt features.

### 18.4 eBay Integration — Product Selection & Disconnect

**Product selection:** three-level hierarchy — vendor can subscribe to:
- Entire catalog (auto-syncs new SKUs)
- Specific categories (auto-syncs new SKUs in those categories)
- Individual SKU variants (manual additions only)

**Pricing on eBay:**
- Vendor sees Card Shellz list price + their wholesale cost per SKU variant
- Vendor sets their own retail price in .ops (free to set whatever they want)
- If vendor edits price directly on eBay, change flows back to .ops for monitoring
- Pricing controls (floor/ceiling) infrastructure built but **off** at launch
- Per-SKU and global override capability built; soft enforcement (alert/log) when activated; escalation to hard/block in later phases

**Multiple stores:** one eBay store per .ops account at launch; multi-store later as a paid add-on

**Disconnect handling (Option B — 72-hour grace period):**
- Voluntary disconnect: confirmation modal explains 72-hour grace, then auto-end
- Involuntary disconnect (eBay token revoked, password change, etc.): email + in-portal banner immediately
- During grace period: .ops rejects new orders from that vendor's eBay
- Reconnect within 72 hours: listings stay live, ATP sync resumes, no damage done
- After 72 hours without reconnect: all listings auto-end via final API call

### 18.5 Shipping Model — REPLACES Section 16.3 free-ship tier reference for .ops

**No free shipping ever in .ops.** Real cost-based, transparent, calculated per order.

Section 16.3 still governs that vendors see a single "shipping" charge per order (composed of label cost + dunnage + insurance pool + margin), but the calculation is now real-time per order, not absorbed.

**Why this differs from cardshellz.com retail:**
- cardshellz.com retail keeps free shipping over $69 for .club members
- .ops is a B2B fulfillment service — vendors are not end consumers, they understand COGS
- Loss aversion principle: starting paid prevents the future pain of removing a free benefit
- Vendors who want free shipping on personal orders can still buy through their .club account on cardshellz.com

### 18.6 Cartonization & Shipping Cost Calculation

**Required dependency before .ops launch.** Also benefits cardshellz.com retail pricing accuracy.

**Per-SKU packaging profile** (new data per SKU):
- Weight
- Dimensions
- Ship-alone flag (master cases SIOC; small items consolidate)
- Default carrier
- Default service (e.g., USPS First Class, UPS Ground, FedEx Ground)
- Box type assignment (or "use master case" for SIOC items)

**Cartonization algorithm:**
1. Separate ship-alone items → each becomes its own shipment
2. Group remaining items by carrier preference + handling flags
3. Bin-pack each group into smallest box that fits by volume + weight; split if overflow
4. Output: list of shipments, each with weight + dims + carrier + service

**Rate table** (admin-configurable):
- Indexed by `carrier × service × zone × weight_break`
- Admin updates when carriers raise rates (annually)
- Or sourced from EasyPost/Shippo APIs and cached
- Version-controlled with effective dates so historical orders audit cleanly

**Markup configuration** (admin UI, all configurable):
- Shipping markup %
- Insurance pool allocation %
- Dunnage allocation %
- Per-SKU packaging profiles
- Box catalog (mailer/box sizes with internal dims and tare weight)
- Zone definitions

**Vendor sees:**
- Per-order: total shipping cost + package count
- Wallet debit detail: per-shipment breakdown (e.g., "Shipping: $47.49, 3 packages")
- Catalog: weight + dimensions per SKU for their own pricing decisions

**Vendor does NOT see:** insurance pool allocation, dunnage breakdown, Card Shellz margin

**Pre-submission rate quote API** (`POST /api/dropship/orders/quote`): vendors can quote shipping before committing to an order.

### 18.7 Wallet Architecture

**Visibility:**
- Vendor sees: balance, per-order debits (wholesale + shipping with package count), refund credits, deposits, auto-reload settings, transaction history with running balance, downloadable per-order receipts + monthly statements
- Vendor does NOT see: insurance pool %, dunnage breakdown, Card Shellz margin, other vendors' data

**Auto-reload is REQUIRED.** At least one funding method must be on file before account activates.

**Reload model — dynamic single charge:**
- Vendor sets minimum balance (default $50, admin-configurable floor)
- Vendor sets optional max single reload cap (default unlimited)
- When balance falls below minimum: charge = (order cost - current balance) + minimum buffer
- Single Stripe charge (or USDC pull) — no chained partial reloads
- If reload would exceed max cap: order placed in **payment hold** state, notification sent, vendor manually tops up to release
- Held orders auto-cancel after configurable timeout (default 48h, admin-configurable) with full reservation release

**Funding methods at launch (all three):**
- Stripe ACH (Plaid verified for 1-day credit on in-transit ACH)
- Stripe card
- USDC on Base (smart contract `transferFrom` allowance, routes to Coinbase Business)

**Receipts/invoices:** auto-generated per-order PDF receipt + monthly statement, downloadable from wallet (B2B purchase invoices, not tax forms)

**Refund timing:** pending → credit after Card Shellz inspection (matches reality, sets expectations)

**Withdrawal:** wallet balance is **locked** to .ops fulfillment during active membership. Refundable on account closure per Section 11.1 termination clause.

### 18.8 Returns — Refines Section 16.7

**No vendor approval gate.** Vendor submits RMA = notification, not authorization. Card Shellz isn't approving customer's right to return — that's between vendor and customer per the vendor's own eBay policy.

**RMA submission (lightweight):**
- Original order reference
- Items being returned
- Reason code (changed mind, defective, damaged in transit, wrong item, not received)
- Optional vendor notes
- Optional return tracking number (vendor adds when customer ships)

**Photos:**
- Optional from vendor (they typically don't have them — customer does)
- **Required from Card Shellz on rejection** (proof of why credit denied)

**Time window:** 60 days from original delivery date

**Inspection result fully visible to vendor:** approved/rejected status, inspection notes, photos if rejected, credit amount, full breakdown

**Credit calculation:**
- Vendor-fault returns (changed mind, vendor's policy): wholesale - $3 processing fee
- Card Shellz-fault returns (defective, wrong item, damaged): full wholesale + return label reimbursement, no $3 fee
- Rejected returns (item used, damaged beyond resale, missing): held 14 days for vendor pickup/disposal instructions, then disposed

**Card Shellz never generates return labels.** Vendor uses eBay's return flow or customer pays. When Card Shellz is at fault, the return label cost is reimbursed as wallet credit on receipt.

### 18.9 Customer PII in Order Detail

- Full ship-to data displayed in vendor's order detail view (name, address, phone)
- Vendor already has this data on eBay — hiding it in .ops would create unnecessary friction
- Section 11.1 #7 still governs Card Shellz's data handling (no marketing to end customers, retention per legal requirements)

### 18.10 Notifications

**Channels at launch (all four):**
- Email
- In-app (portal)
- SMS
- Webhook (HMAC-signed, vendor-provided endpoint)

**Per-event preference controls in vendor settings.** Vendor can mute or route each event type to specific channels.

**Critical events cannot be muted** (admin-flagged):
- Order rejected
- Auto-reload failed
- eBay token expiring
- Account suspended

### 18.11 API Access

- **Self-service key generation** in vendor portal
- **Scoped keys:** read-only, orders-only, wallet-only, full-access
- **Per-endpoint rate limits** (orders endpoint at 100/hr per vendor per Section 4.3; other endpoints at higher limits)
- **HMAC signing** on all outbound webhooks; vendor verifies authenticity
- **Public docs** at `docs.cardshellz.io` for SEO and agent commerce discoverability per Section 15

### 18.12 Onboarding

**5 steps, gated.** Account remains in `onboarding` status until all 5 complete; cannot transition to `active` partially.

1. Welcome (post-SSO landing)
2. Connect eBay (OAuth handoff)
3. Pick products (catalog / category / individual SKUs)
4. Fund wallet (method on file + initial deposit + auto-reload settings)
5. Done (confirmation, listings begin pushing, redirect to dashboard)

### 18.13 Settings Structure

Sections in vendor settings:

1. **Account** — profile (read-only, SSO-managed), tier, member-since, active sessions
2. **eBay connection** — store handle, status, last sync, token expiry, reconnect, disconnect
3. **Wallet & payment** — auto-reload thresholds, funding methods management
4. **Notifications** — per-event channel preferences
5. **API keys** — self-service generation, scoping, revocation
6. **Webhooks** — endpoint URLs, signing secret, event subscriptions, delivery logs
7. **Return address & contact display** — Card Shellz warehouse address used on listings (per Section 16.1, both display address on listing AND physical return destination are Card Shellz)

### 18.14 Dashboard Philosophy

**Hybrid: alerts top, metrics below.**
- Action items needing attention surfaced first (low balance, expiring tokens, pending RMAs, rejected orders)
- KPIs: wallet balance, orders today, monthly revenue, average ship time
- Recent orders list
- Top SKUs this month
- eBay sync status panel
- Wallet activity panel

### 18.15 Empty / Loading / Error States

Designed states:

**Empty:** no orders yet, no products selected, no transactions yet, no RMAs yet

**Loading:** skeleton screens for catalog, orders list, dashboard metrics

**Error states:**
- eBay token expired → banner + reconnect CTA
- Auto-reload failed → banner + update payment method CTA
- Order rejected (out of stock) → modal/toast
- Order rejected (payment hold, cap exceeded) → banner explaining hold + manual top-up CTA
- Account suspended → full-screen state + contact support CTA
- API/network failure → toast with retry

### 18.16 Pre-Launch Dependencies (Updated)

Building on Section 17's launch phases, these dependencies must exist in Echelon before .ops Phase 0 ships:

- Cartonization engine (per-SKU packaging profiles + bin-packing algorithm)
- Rate table (carrier × service × zone × weight) with admin UI
- Zone calculator (origin ZIP → destination ZIP → zone number)
- Box catalog (mailer/box sizes with internal dims and tare weight)
- Multi-tenant eBay OAuth (extending existing Echelon channel sync)
- Stripe Customer Balance integration with auto-reload
- USDC smart contract on Base (Phase 1, audited before mainnet)
- Wallet ledger schema and reconciliation jobs
- SSO bridge from cardshellz.com (cardshellz.com as identity provider)
- Admin UI for shipping markup %, insurance pool %, dunnage %, rate table maintenance

---

*Section 18 appended 2026-04-26. Portal design review decisions; supersedes earlier sections where conflict exists.*
