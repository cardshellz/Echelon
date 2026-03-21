# PO → Receiving Flow Audit

**Auditor:** Archon (UX/Systems Analyst)  
**Date:** March 21, 2026  
**System:** Echelon WMS — Card Shellz, LLC  
**Context:** ONE person operation (Overlord does everything solo)

---

## Executive Summary

The PO → Receiving flow is **functional but designed for a 10-person procurement team**, not a one-person operation. The biggest friction points:

1. **4 mandatory clicks** just to go from draft → sent (Submit → auto-approve → Mark as Sent → Acknowledge) when one person approves everything
2. **Incoterms is required** on every PO — overkill for domestic orders
3. **Line items can't be added during PO creation** — forces a two-step flow (create empty PO, then add lines)
4. **Receiving requires separate navigation** away from the PO detail page
5. **Inbound Shipments is a separate module** that adds complexity without clear value for domestic orders

**Good news:** The approval tier system is currently empty (no tiers configured), so POs auto-approve. The vendor catalog system is well-designed. CSV import for receiving works well.

---

## 1. PO Creation Flow

### What the user sees: "New Purchase Order" button → dialog

**Screen: Create PO Dialog** (~8 fields)

| Field | Required? | One-Person Need? | Notes |
|-------|-----------|------------------|-------|
| Vendor | ✅ Yes | ✅ Essential | Typeahead search — works well. Can create new vendor inline. |
| Type | No (defaults "Standard") | ❌ Rarely needed | "Blanket" and "Dropship" are edge cases |
| Priority | No (defaults "Normal") | ❌ Rarely needed | Rush/High — useful but should be hidden in a collapsible |
| Incoterms | ✅ Yes (marked with *) | ⚠️ ONLY for international | 10 options (EXW through DDP). **Overkill for domestic POs.** For Buckeye Corrugated, you don't need incoterms. |
| Expected Delivery | No | ⚠️ Nice to have | Not blocking |
| Vendor Notes | No | ❌ Rarely used | Notes on the printed PO |
| Internal Notes | No | ❌ Rarely used | For warehouse staff — there's only one person |

**Pain point #1:** Incoterms shouldn't be required. The `*` asterisk implies mandatory. For domestic suppliers (Buckeye Corrugated), this is confusing. The code shows `disabled={!newPO.vendorId}` — it won't block creation without incoterms, but the UI implies it's required.

**Pain point #2:** You can't add line items during creation. The dialog says "You can add lines after creation." This means:
1. Click "New Purchase Order"
2. Fill in vendor + incoterms + hit "Create Draft"
3. Get redirected to PO detail page
4. Click "Add Line"
5. Search product, pick variant, enter qty + cost
6. Repeat for each line item

### Click count: "I need to order more product" → "PO is ready to send"

| Step | Action | Clicks |
|------|--------|--------|
| 1 | Click "New Purchase Order" | 1 |
| 2 | Select vendor from dropdown | 2 (open + select) |
| 3 | Select incoterms | 2 (open + select) |
| 4 | Click "Create Draft" | 1 |
| 5 | Click "Add Line" | 1 |
| 6 | Switch to catalog/search mode | 0-1 |
| 7 | Select product from catalog | 1 |
| 8 | Enter qty | 1 (type) |
| 9 | Enter total cost | 1 (type) |
| 10 | Click "Add Line" (confirm) | 1 |
| 11 | Repeat 5-10 for each additional line | ~5 per line |
| 12 | Click "Submit" | 1 |
| 13 | (Auto-approves — no approval tiers) | 0 |
| 14 | Click "Mark as Sent" | 1 |
| **Total (single line PO)** | | **~13 clicks + typing** |

### Status flow analysis

Current: `draft → (submit) → pending_approval → (approve) → approved → (send) → sent → (acknowledge) → acknowledged → (receive) → partially_received → received → closed`

**What actually happens in the DB (from status history):**
```
PO created          → draft
Submit              → approved (auto-approved, no tiers)
Mark as Sent        → sent
Acknowledge         → acknowledged
Receive             → partially_received / received
```

The `pending_approval` status is **never reached** because there are zero approval tiers. But the user still has to manually click through:
- Submit (draft → approved, auto)
- Mark as Sent (approved → sent)  
- Acknowledge (sent → acknowledged)

**That's 3 separate button clicks for status transitions that could be 1.**

### Real data patterns

From the database:
- **11 POs total** (across ~3 weeks of use)
- **4 cancelled** (36% cancel rate — suggests early learning curve or data entry mistakes)
- **0 stuck in draft/pending** — good, means auto-approve works
- **3 acknowledged, 1 sent** — these are "in progress" waiting for goods
- **2 received, 1 partially_received** — completed cycle
- PO-20260306-001 and PO-20260307-001 were both cancelled with reasons "incorrect" / "inccorect" — **clear sign of data entry issues**

### Recommended one-person flow

1. **"Quick PO" mode:** Vendor + add lines in the SAME dialog. Click "Create & Send" → goes straight to `sent` status.
2. **Skip incoterms for domestic vendors:** If vendor.country === "US", default to hidden/optional. Show only for international vendors.
3. **Combine Submit + Send:** For one person, "Submit" should go straight to `sent`. The approve step is meaningless when you approve your own POs.
4. **Make Acknowledge optional:** Record vendor confirmation is nice but shouldn't block receiving. You should be able to receive against a `sent` PO without acknowledging first. (Code already allows this: `["sent", "acknowledged", "partially_received"]` all show the "Create Receipt" button.)

### What to keep for multi-person mode
- Approval tiers (already implemented, just empty)
- `pending_approval` status
- Separate Submit vs Approve vs Send steps
- Vendor Notes (for team communication)
- Internal Notes (warehouse staff)

---

## 2. PO Approval System

### Current implementation

From `purchasing.service.ts`:
```typescript
const tier = await storage.getMatchingApprovalTier(totalCents);
if (tier) {
  // Needs approval → pending_approval
} else {
  // Auto-approve (no tier matches) → approved
}
```

**Database:** `po_approval_tiers` table is **completely empty**. Zero rows.

This means **every PO auto-approves**, which is correct for one person. The system is already designed to scale — when tiers are added, it gates approvals by dollar threshold.

### Pain point

The auto-approve is invisible. The user clicks "Submit" and the PO jumps to "Approved" — but then they still need to click "Mark as Sent" separately. The 2-step dance is unnecessary.

### Recommendation

Add a setting: `procurement.auto_send_on_approve` (default: true for one-person mode). When enabled:
- Submit → auto-approve → auto-send → status is `sent` in one click
- Or even: "Create & Send" button that does the whole thing

---

## 3. Vendor Management

### Current flow (Suppliers page)

The Suppliers page is a **well-designed** expandable table with inline vendor product catalogs. It's actually one of the better parts of the system.

**Creating a vendor:**
1. Click "Add Supplier"
2. Fill Code + Name (required)
3. Optionally fill 15+ fields (type, rating, contact, email, phone, address, website, payment terms, lead time, min order, free freight, country, tax ID, account #, notes)

**For one person:** Code + Name is sufficient. The optional fields are properly optional.

**Vendor product catalog:**
- Expand a vendor row → see product mappings
- Add Product button → typeahead product search, select variant, enter cost, pack size, MOQ, lead time
- "Preferred vendor" toggle

**This is actually good.** The catalog feeds into PO line creation (catalog mode), saving time when reordering the same products from the same vendor.

### How vendor links to PO creation

When creating a PO, the "Add Line" dialog has two modes:
1. **Supplier Catalog** — shows products already mapped to this vendor with pre-filled costs
2. **All Products** — search all products in the system

This is solid. The catalog mode reduces data entry for repeat orders.

### Pain point

Vendor is required for POs, which makes sense. But the "quick add vendor" dialog from the PO creation screen only asks for Code + Name + optional contact/email/phone — this is appropriate.

### What's unnecessary for one person

The full Suppliers page with 20+ fields per vendor is enterprise-grade. For one person, a simpler vendor card would suffice. But since all extra fields are optional, it's not blocking.

---

## 4. Receiving Flow

### Starting a receipt

**Two paths to receiving:**

**Path A: From PO Detail page**
1. Navigate to Purchase Orders → click a PO
2. Click "Create Receipt" button (available on sent/acknowledged/partially_received POs)
3. Receipt is auto-created with lines from the PO
4. Toast says "Receipt RCV-XXXX created. Open Receiving to process it."
5. **BUT:** You have to manually navigate to the Receiving page to find it. The UI doesn't take you there automatically.

**Path B: From Receiving page**
1. Navigate to Receiving
2. Click "New Receipt"
3. Select receipt type: Blind / Purchase Order / ASN / Initial Load
4. If "Purchase Order" — select the PO from a typeahead dropdown
5. Select warehouse (required)
6. Optionally fill vendor, notes
7. Click "Create Receipt"
8. Receipt detail opens in a dialog

### Pain point #1: Path A doesn't navigate to the receipt

After clicking "Create Receipt" on a PO, the toast says to "Open Receiving to process it" — the user has to manually navigate. There should be a direct link or auto-navigate.

### Pain point #2: Two different receipt creation paths with different UIs

Path A creates the receipt server-side and doesn't open it. Path B opens a dialog where you choose the PO. They're functionally the same but feel disjointed.

### Receiving workflow once a receipt is open

**Receipt Detail Dialog** shows:
- Receipt number, status, source type, linked PO
- Action buttons: Download Template, Import CSV, Start (opens the receipt)
- Lines table with: SKU, Product, Expected, Received (editable), Location, Status, Issues

**Steps from "truck arrived" to "inventory updated":**

| Step | Action | Clicks |
|------|--------|--------|
| 1 | Open the receipt (from list or PO detail) | 1-3 |
| 2 | Click "Start" to open the receipt | 1 |
| 3a | **Option A:** Import CSV → paste data → click Import | 3 |
| 3b | **Option B:** Manually update received qty for each line | 1 per line |
| 4 | Set putaway location for each line | 1-2 per line |
| 5 | Click "Complete All" | 1 |
| 6 | Click "Close" (Close & Update Inventory) | 1 |
| **Total (CSV import, 5 lines)** | | **~7-8 clicks** |
| **Total (manual, 5 lines)** | | **~15-20 clicks** |

### Issue resolution flow

When closing a receipt, the system validates:
- Each received line must have a `productVariantId` (linked to a product)
- Each received line must have a `putawayLocationId` (assigned a bin location)

If issues exist:
- Yellow banner: "X lines need attention"
- Click a line → resolve dialog for SKU linking or location assignment
- Can create new variants from SKU patterns (e.g., `ABC-C25` → Case of 25)

**This is actually well-designed.** The auto-resolve attempts SKU matching on close, and the resolution UI is practical.

### Pain points in receiving

1. **Location is required for every line.** For a one-person operation with a known warehouse, the default location should auto-populate from product history or a warehouse default.

2. **"Complete All" vs "Close" buttons are confusing.** "Complete All" marks all lines as received (sets receivedQty = expectedQty). "Close" actually processes inventory. The mental model: "Complete All" = "I received everything as expected" then "Close" = "Finalize and update inventory." But they sound similar. Better names: "Accept All Quantities" and "Finalize & Update Inventory."

3. **The receipt opens in a dialog**, not a full page. For a 20-line PO, the dialog scroll is cramped. Should be a dedicated page like PO detail.

4. **CSV import is good** but requires navigating to the receipt first, then clicking Import CSV. For bulk receiving, a "Receive by CSV" shortcut from the main page would help.

### Real data patterns

From the database:
- **10 receiving orders** (8 closed, 2 draft)
- **2 draft receipts that were never started** (RCV-20260317-001 from PO-20260317-001, RCV-20260304-001 from PO-20260303-001)
  - These were "Create Receipt" clicks from PO detail that were never followed up — evidence of the **navigation gap** pain point
- **3 initial_load receipts** — used for initial inventory setup
- **2 blind receipts** — ad-hoc receives
- **3 PO-linked receipts** that completed successfully

The 2 abandoned draft receipts are a **red flag**. The user created them from the PO page but never processed them because the workflow didn't guide them to the receiving screen.

---

## 5. Inbound Shipments

### What is this?

A separate module for tracking **freight/logistics** — container shipments, air freight, etc. It tracks:
- Shipment mode (Sea FCL/LCL, Air, Ground, LTL, FTL, Courier)
- Carrier, forwarder, container number
- Origin/destination ports
- Status: draft → booked → in_transit → at_port → customs_clearance → delivered → costing → closed
- Estimated vs actual costs
- Line items linked to PO lines

### Is it separate from receiving?

**Yes, completely separate.** Inbound Shipments tracks the logistics (where is the container?). Receiving tracks the physical receipt of goods (what arrived, how many, where to put it).

The connection: A shipment can trigger a receiving order when it's delivered. PO lines can be linked to shipment lines for landed cost calculation.

### Necessary or redundant?

**For international orders: valuable.** Card Shellz sources from China (Joybean, JIN OU, Astrek, Sungreen) — tracking ocean freight, customs clearance, and landed cost per unit is genuinely important for accurate COGS.

**For domestic orders: unnecessary.** Ordering boxes from Buckeye Corrugated doesn't need shipment tracking.

### Real data

- **9 shipments** (5 cancelled, 2 draft, 1 costing, 1 booked)
- **5 cancelled** (55% cancel rate) — suggests early experimentation
- Most are unused or never progressed past draft

### Recommendation

Keep Inbound Shipments but **don't force it into the PO flow.** It should be an optional add-on:
- From PO detail, "Create Shipment" button exists (good)
- But the Inbound Shipments section in PO detail tabs adds visual clutter
- Make it a settings-enabled feature: `procurement.enable_shipment_tracking = true`
- For domestic POs, hide the shipments tab entirely

---

## 6. AP/Invoicing

### Invoice creation from PO

From the PO detail page, the "Create Invoice" button:
1. Auto-generates next invoice number
2. Pre-fills amount from PO total
3. Pre-fills today's date
4. Links to the PO
5. Creates invoice and navigates to invoice detail

### AP Dashboard

Shows:
- Total outstanding, overdue, paid this month, average days to pay
- Aging buckets (0-30, 31-60, 61-90, 90+)
- Vendor aging breakdown
- Recent payments

### 3-way matching

The invoice system has:
- Invoice lines linked to PO lines
- Receipt data linked to PO lines
- PO → Invoice → Receipt matching

### For one person: overkill?

**Partially useful.** A one-person operation does need to track:
- ✅ What invoices are outstanding
- ✅ What's been paid
- ✅ Overdue payments

**Don't need:**
- ❌ Formal 3-way matching (PO vs receipt vs invoice)
- ❌ Invoice approval workflow
- ❌ Multiple payment partial allocations

### Real data

- **15 vendor invoices** (4 paid, 3 approved, 3 partially_paid, 1 received, 4 voided)
- **4 voided** (27%) — suggests learning curve or corrections
- Active use shows the AP module is being used, but the complexity may not be justified

### Recommendation

Keep AP as-is but add a simplified "Quick Pay" flow:
- From PO detail: "Mark as Paid" button that auto-creates an invoice, marks it paid, and records payment in one click
- Full AP module stays available for complex scenarios (partial payments, disputes)

---

## 7. The Complete Flow — As-Is vs Should-Be

### Current flow (11 POs of experience)

```
1.  Purchase Orders page → "New Purchase Order"     [click]
2.  Select vendor                                     [2 clicks]
3.  Select incoterms                                  [2 clicks]
4.  "Create Draft"                                    [click]
5.  ─── redirected to PO detail page ───
6.  "Add Line" button                                 [click]
7.  Select from catalog / search product              [2-3 clicks]
8.  Enter qty + total cost                            [typing]
9.  "Add Line" (confirm)                              [click]
10. Repeat 6-9 for more lines                         [5+ per line]
11. "Submit" button                                   [click]
12. ─── auto-approves (no tiers) ───
13. "Mark as Sent" button                             [click]
14. ─── optional: email PO to vendor ───
15. "Acknowledge" button                              [click]
16. Enter vendor ref # + confirmed date               [typing]
17. "Record Acknowledgment"                           [click]
18. ─── wait for goods to arrive ───
19. "Create Receipt" button                           [click]
20. ─── toast says "go to Receiving page" ───
21. Navigate to Receiving page                        [click]
22. Find the receipt in the list                      [click]
23. Open receipt detail dialog                        [click]
24. "Start" to open the receipt                       [click]
25. Update received quantities per line               [typing per line]
26. Assign putaway locations per line                 [clicks per line]
27. "Complete All"                                    [click]
28. "Close" (& update inventory)                      [click]
```

**Total: ~25-30+ interactions for a single PO lifecycle**

### Proposed one-person flow

```
1.  Purchase Orders page → "Quick PO"                [click]
2.  Select vendor (auto-fills from last PO)           [1 click]
3.  Add lines from catalog inline                     [2 clicks per line]
4.  "Create & Send"                                   [click]
    ─── auto: draft → approved → sent ───
5.  ─── wait for goods to arrive ───
6.  From PO detail: "Receive Shipment"                [click]
    ─── auto-navigates to receipt page ───
7.  "Accept All" (sets received = expected)           [click]
    ─── auto-fills default locations ───
8.  "Finalize"                                        [click]
    ─── inventory updated, PO → received ───
```

**Total: ~8-10 interactions**

---

## 8. Specific Recommendations

### Priority 1 — Quick Wins (High Impact, Low Effort)

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 1 | **Combine Submit + Send** into single "Submit & Send" button (when no approval tiers exist) | Saves 2 clicks per PO | Low — add setting check in `submit()` |
| 2 | **Navigate to receipt** after "Create Receipt" on PO detail (instead of just a toast) | Eliminates abandoned receipts | Low — change `onSuccess` callback |
| 3 | **Rename buttons:** "Complete All" → "Accept All Quantities" / "Close" → "Finalize & Update Inventory" | Reduces confusion | Trivial — label changes |
| 4 | **Default putaway location** from product's last known location or warehouse default | Saves 1 click per receiving line | Medium — query product_locations |
| 5 | **Make Incoterms optional** — remove the `*` asterisk, don't show for domestic vendors | Removes friction for domestic POs | Trivial |

### Priority 2 — Flow Improvements (High Impact, Medium Effort)

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 6 | **"Quick PO" creation** — add line items in the creation dialog before saving | Eliminates 2-step creation flow | Medium — UI refactor of dialog |
| 7 | **Make Acknowledge optional** — don't require it before receiving. Already works in code but the Acknowledge button is prominent on `sent` status | Saves a step when vendor doesn't formally acknowledge | Low — just UI emphasis change |
| 8 | **Receiving as a full page** (not dialog) for PO-linked receipts | Better UX for large orders | Medium — new route/component |
| 9 | **"Mark as Paid" quick action** on PO detail → creates invoice + payment in one click | Simplifies AP for straightforward POs | Medium |

### Priority 3 — Settings for Scaling (Keep for Multi-Person)

| # | Setting | Default (1-person) | Multi-person |
|---|---------|---------------------|-------------|
| 10 | `procurement.require_approval` | `false` | `true` — enables approval tiers |
| 11 | `procurement.auto_send_on_approve` | `true` | `false` — separate approve + send steps |
| 12 | `procurement.require_acknowledge` | `false` | `true` — must acknowledge before receive |
| 13 | `procurement.enable_shipment_tracking` | `true` (for international) | `true` |
| 14 | `procurement.enable_ap_module` | `true` | `true` |
| 15 | `procurement.auto_putaway_location` | `true` (use last known) | `false` — manual assignment |

---

## 9. What's Actually Working Well

Credit where due — these parts are solid:

1. **Vendor catalog system** — the supplier product catalog with preferred vendor flags and pre-filled costs is genuinely useful for repeat purchasing
2. **CSV receiving import** — bulk receive with fuzzy location matching is practical
3. **Auto-approve with empty tiers** — the approval system gracefully degrades to auto-approve
4. **PO document generation** — print/email PO to vendor works
5. **Inline editing** on PO lines — click to edit unit cost, qty, or change SKU variant
6. **Mobile-responsive** — both mobile card views and desktop table views
7. **Status history / audit trail** — full status change logging with timestamps
8. **Incoterms-aware charge management** — shipping/tax fields enable/disable based on incoterms selection

---

## 10. Database Evidence Summary

| Metric | Value | Interpretation |
|--------|-------|----------------|
| Total POs | 11 | Low usage — system is new (~3 weeks) |
| Cancelled POs | 4 (36%) | High cancel rate = data entry mistakes during learning |
| Stuck drafts | 0 | Auto-approve works, no bottleneck |
| Approval tiers | 0 | No approval workflow configured — correct for 1 person |
| Receiving orders | 10 | Active use |
| Abandoned receipts | 2 (20%) | **Navigation gap** — created from PO but never processed |
| Cancelled shipments | 5/9 (55%) | Shipment module was experimented with then abandoned |
| Voided invoices | 4/15 (27%) | AP learning curve |
| Vendors | 10 | Mix of Chinese manufacturers + US domestic suppliers |

---

## Conclusion

Echelon's PO → Receiving flow is **enterprise-capable but solo-hostile**. The bones are excellent — approval tiers, vendor catalogs, landed cost tracking, 3-way matching. But for a one-person operation shipping 100+ orders/day, every unnecessary click is a tax.

The single highest-ROI change: **Combine Submit + Send into one click** and **auto-navigate to receipt after creation**. These two changes alone eliminate ~5 interactions per PO and prevent the abandoned receipt problem visible in the data.

The system should default to "solo mode" (fast, minimal steps) with settings to enable "team mode" (approvals, acknowledgments, formal workflows) when the operation scales.
