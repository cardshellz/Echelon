# Shellz Club Admin Portal — UX Design Review

**Date:** 2026-03-23
**Reviewer:** Senior UX Designer / Frontend Architect
**Scope:** Full frontend audit of `/client/src/pages/` and `/client/src/components/`

---

## Executive Summary

The Shellz Club admin portal is **functionally complete but structurally overwhelmed**. The biggest problem isn't missing features — it's that too many features are crammed into too few pages with no consistent organizational pattern.

**The numbers tell the story:**
- `Plans.tsx` — **2,950 lines** (a single dialog contains ~1,800 lines of form fields)
- `Rewards.tsx` — **3,106 lines** (6 tabs doing unrelated things)
- `Members.tsx` — **2,512 lines** (list + 5 modal dialogs + inline sync UI)
- `Settings.tsx` — **2,453 lines** (7+ unrelated config sections stacked vertically)
- `MemberPortal.tsx` — **3,812 lines** (public portal, separate concern)

A non-technical user (the Overlord or a future CS team member) would be lost within 30 seconds.

---

## Part 1: Current State Assessment

### Navigation (Sidebar.tsx, lines 30-42)

**Current sidebar:** 12 items, flat list, no grouping.

```
Overview
Members
Plans
Rewards
Price Rules
Access Rules
Collection Alerts
Notifications
Member Portal
Storefront Preview
Settings
Debug
```

**Problems:**
- **No grouping** — "Price Rules" and "Access Rules" are conceptually related (both are about controlling who gets what) but separated by position
- **"Storefront Preview"** is a dev/design tool mixed with admin ops
- **"Member Portal"** config page (`/portal-config`) is in the sidebar as "Member Portal" but there's also a public `/portal` route — confusing naming
- **"Collection Alerts"** feels orphaned — it's a notification/marketing feature but sits between Access Rules and Notifications
- **"Debug"** should be hidden or collapsible for non-dev users
- **No visual hierarchy** — everything has equal weight. "Overview" and "Debug" look identical
- **Mobile:** sidebar works via Sheet component (`MobileSidebar`), acceptable pattern

### Dashboard (Dashboard.tsx — 425 lines) ✅ Mostly Good

**What it does:** 3 stat cards (Active Members, Points Earned, Points Redeemed), bar chart of monthly signups, pie chart of members by plan, recent signups list.

**Assessment:**
- Clean, well-structured, good information hierarchy
- Stat cards are clear and scannable
- Charts provide useful at-a-glance data
- **Minor issue:** No link from stat cards to their detail pages (clicking "Active Members" should go to `/members`)
- **Minor issue:** No time period selector for charts
- **Mobile:** Grid collapses properly (`md:grid-cols-2 lg:grid-cols-3`)

**Verdict:** Best page in the app. Keep this pattern.

---

### Plans (Plans.tsx — 2,950 lines) 🔴 Critical Issues

**What it does:** Lists plan cards + a single 900px-wide dialog for creating/editing plans that contains:
1. Plan basics (name, tier, billing interval)
2. Renewal & cancellation policy
3. Promotional pricing (trial, intro)
4. Portal upsell toggle
5. Price & display order
6. Description
7. Plan icon (built-in, URL, or upload)
8. Storefront badge colors (dot color, text color)
9. Member price label
10. Savings badge template
11. **Split-pill design** — 6 color pickers, shimmer style, border radius, scale, border width, border opacity, member verb, upsell verb (lines 1658-2055)
12. UI accent color
13. Member price color
14. Badge design — collection & product page styles
15. Plan features (bullet points)
16. Shopify wholesale pricing (tag, discount %)
17. Klaviyo email list + sync
18. Points expiry
19. Free shipping threshold
20. Shopify product linking
21. Active toggle
22. **[Right column, edit only]** Rewards configuration — per-plan earning activity overrides
23. **[Right column, edit only]** Redemption option overrides with 4-column override grids

**This is 23 distinct configuration domains in ONE dialog.**

**Specific problems:**
- **Dialog is a monster.** At 900px wide with `max-h-[90vh] overflow-y-auto`, users must scroll through ~2,500px of form content. No tabs, no sections, no progressive disclosure — just an endless scroll of separators.
- **Pill design config** (lines 1658-2055) is ~400 lines of color pickers, sliders, and preview rendering with inline CSS animations. This is a design tool embedded in a plan editor. It should be its own page or at minimum a collapsible section.
- **Rewards configuration** shares a dialog with plan basics. When editing, the dialog becomes a 2-column layout (`md:grid-cols-[1fr,1fr]`) but the left column alone is 1,500+ lines.
- **No save-per-section.** You edit 23 things and hit one "Update Plan" button. Accidentally close the dialog? Everything's gone.
- **Klaviyo bulk sync card** (lines 994-1028) is pinned to the Plans list page but has nothing to do with individual plans — it's a global operation.
- **Form state is enormous** — the `form` state object (lines 80-121) has **42 fields**. This is a code smell that mirrors a UX smell.
- **Mobile:** The 900px dialog is `sm:max-w-[900px]` — on mobile it's full-width but the content isn't designed for narrow screens. Color picker grids and 2-column layouts break down.

**User story failure:** "I want to change the free shipping threshold for the Gold plan." → Open Plans → Find the Gold card → Click Edit → Scroll past ~20 sections → Find "Free Shipping Threshold" → Change it → Scroll to bottom → Click Update. **~15 seconds of scrolling for a 2-second change.**

---

### Members (Members.tsx — 2,512 lines) 🟡 Moderate Issues

**What it does:** Member list with stats cards, search/filter, table, and slide-out detail sheet.

**The good:**
- Stats cards across the top provide quick counts (Total, Active, per-plan)
- Plan stat cards double as filters (click to filter by plan) — smart UX
- Table has reasonable columns: name, email, plan, status, joined, orders, points, savings
- Bulk actions exist (export, import CSV)
- MemberDetailSheetV2 is well-designed with summary ribbon and order history

**Problems:**
- **Action button bar** (lines 930-960): 4 buttons in a row (Sync Shopify, Import CSV, Export, Add Member) — on mobile these will overflow or wrap awkwardly. No responsive handling.
- **Shopify sync progress banner** (lines 1049-1100) takes up significant vertical space with detailed progress stats. Should be a toast/notification bar, not an inline card.
- **5 separate Dialog components** inline in the page: Extend Membership, Adjust Points, Merge Members, Edit Membership, Import CSV. These are defined at the bottom of the file (lines 1406-2050+), making the component massive.
- **Member edit dialog** (line 1789) is `sm:max-w-[550px] max-h-[90vh]` and contains plan change, status change, expiry date, and address — acceptable scope but could be tabbed.
- **Merge members dialog** (lines 1499-1787) is complex: search for target, preview, confirm. This is ~290 lines for a rarely-used feature occupying prime real estate in the file.
- **No pagination indicator** showing "Showing 1-25 of 347 members" — disorienting for large member lists.
- **Table columns aren't sortable** from what I can see — no sort indicators on headers.

**MemberDetailSheetV2 (1,020 lines):**
- Well-structured slide-out panel with header, summary ribbon, order history
- Summary ribbon shows Orders, Spent (with breakdown), Points, Savings (with breakdown) — information-dense but scannable
- **Good:** Uses sticky header with actions menu
- **Issue:** Order history shows line items inline with no collapse — for a member with 50+ orders, this becomes an extremely long scroll
- **Issue:** No tabs in the detail sheet — everything is one long scroll (member info → stats → orders)

---

### Rewards (Rewards.tsx — 3,106 lines) 🟡 Moderate Issues

**What it does:** 6-tab interface managing the entire rewards ecosystem.

**Tabs:**
1. **Activities** — earning activity configuration (purchase %, signup, referral, social)
2. **Redemptions** — store credit rate + "Other Redemption Options" (discount codes, free shipping)
3. **Badges** — storefront badge design configuration (collection + product page styles)
4. **Balances** — member points balances table with search and bulk import
5. **History** — reward transaction ledger
6. **Medals** — achievement medals system

**Problems:**
- **6 tabs is too many** for one page. The tab bar requires horizontal scroll on mobile (line 1799: `inline-flex w-auto min-w-full`). On a 375px screen, you see ~3 tabs and must scroll.
- **"Badges" tab doesn't belong here.** Badge design is a storefront/display concern, not a rewards concern. It's about how rewards are *shown*, not how they *work*. It's also duplicated — the same badge config exists in the Plans dialog.
- **"Balances" tab is an operational view** (who has how many points), while "Activities" is a configuration view. Mixing operational and configuration UX in the same tab set is confusing.
- **"Medals" tab** is a full CRUD for achievement medals with its own dialog — it's a separate feature crammed into the Rewards page.
- **Earning activities** use inline editing (toggle + points/multiplier input per activity). This is fine for ~5 activities but doesn't scale.
- **Redemption options** have a well-structured dialog for create/edit — good pattern.
- **History tab** has a transaction ledger — good for debugging but could be a sub-page.

---

### Settings (Settings.tsx — 2,453 lines) 🔴 Critical Issues

**What it does:** Everything that didn't fit elsewhere. Currently contains:
1. Shopify Integration (connect/disconnect, domain, status)
2. Crypto Token Rewards (enable, token name, contract address, conversion rate, behavior settings)
3. Marketplace Exclusions (email domains, customer tags for eBay/Amazon filtering)
4. Social Media Links (Facebook, Instagram, X, YouTube, TikTok URLs)
5. Klaviyo Integration (connect, auto-sync toggle)
6. **Upsell Widget Controls** — this is MASSIVE:
   - Global enable/disable
   - Upsell plan selection
   - Collection page toggle
   - Product page toggle
   - Message template
   - Savings display mode
   - Widget color customization (6+ color pickers)
   - Fly-in drawer configuration
   - And more (~700 lines just for upsell widget)

**Problems:**
- **"Settings" is a dumping ground.** 7 completely unrelated configuration domains stacked in one scrolling page with no tabs, no sections, no grouping.
- **Upsell Widget Controls** (lines 1150-2050+, ~900 lines) is a full storefront customization tool buried in Settings. It controls visual appearance of product pages, collection pages, and fly-in drawers. This is not a "setting" — it's storefront design.
- **No save confirmation pattern.** Each Card has its own Save button, which is good, but there's no visual indicator of unsaved changes.
- **Crypto Token Rewards** (lines 715-960) is ~250 lines of blockchain configuration. This is a complex feature hidden in a generic Settings page where a user might never find it.
- **Marketplace Exclusions** is rendered via a separate `<MarketplaceExclusionsCard />` component (line 978) — good extraction, but it's still in the wrong place conceptually.
- **Mobile:** Each card stacks vertically, which works, but the total scroll length is enormous (~4,000px of content).

---

### Price Rules / Discounts (Discounts.tsx — 1,128 lines) 🟡 Moderate Issues

**What it does:** Per-plan pricing configuration with flat discount, collection exclusions, and per-variant overrides. Has tabs for different view modes (Overview, Per-Plan Config, Overrides, Import).

**The good:**
- Tabbed interface for different modes — good pattern
- Per-plan pricing is clearly organized

**Problems:**
- **Naming confusion:** Route is `/discounts`, component is `PriceRules`, sidebar says "Price Rules" — but this is really "Wholesale Pricing Configuration"
- **Override management** with per-variant pricing is complex but necessarily so

---

### Access Rules (AccessRules.tsx — 817 lines) 🟢 Acceptable

**What it does:** Content gating — lock collections/products/pages behind plan tiers.

**Assessment:** Reasonably well-structured. Table + dialog pattern. Combobox for resource selection. Plan multi-select for gating.

**Problems:**
- Could benefit from better empty state guidance
- Resource type selection (collection/page/product) could show counts

---

### Notifications (Notifications.tsx — 870 lines) 🟢 Acceptable

**What it does:** Email template management with tabs for membership and rewards categories. Klaviyo list assignment.

**Assessment:** Clean tabbed interface. Template editing is inline with expand/collapse.

**Problems:**
- HTML body editing in a textarea is primitive — no preview
- Template variables need better documentation

---

### Portal Config (PortalConfig.tsx — 790 lines) 🟡 Moderate Issues

**What it does:** Member portal customization — benefit cards, welcome message, featured products, featured collections.

**Problems:**
- This page configures the public member portal but is named "Member Portal" in the sidebar, which could be confused with the actual portal (`/portal`)
- Drag-and-drop ordering for benefit cards would improve UX
- Preview is separate (Storefront Preview page) — should be inline or at least linked

---

### Collection Alerts (CollectionAlerts.tsx — 541 lines) 🟢 Acceptable

**What it does:** Back-in-stock / new product notifications per collection.

**Assessment:** Simple, well-scoped. Add collection → configure alerts → view subscribers.

---

### Storefront Preview (StorefrontPreview.tsx — 1,404 lines) 🟡 Moderate Issues

**What it does:** Live preview of storefront elements — member pricing, badges, pills, upsells.

**Problems:**
- This is a developer/design tool, not an admin function
- Should be integrated into the pages where you *configure* these visual elements, not a separate page
- 1,400 lines of preview rendering duplicates logic from the actual storefront

---

### Debug (Debug.tsx — 175 lines) 🟢 Fine

**What it does:** System diagnostics — environment info, API health checks.

**Assessment:** Appropriately scoped. Should be hidden from non-dev users.

---

### Subscriptions (Subscriptions.tsx — 518 lines) 🟢 Not in nav

**Note:** This page exists but is NOT in the sidebar navigation. It handles Shopify selling plan groups and subscription contracts. It's a future page that will need to be integrated.

---

## Part 2: Pain Points Summary

### Critical (Fix First)
1. **Plans dialog is unusable** — 42-field form in one scrolling dialog, no organization
2. **Settings is a dumping ground** — 7 unrelated config domains with no structure
3. **Navigation has no grouping** — 12 flat items, no hierarchy

### Major (Fix Second)
4. **Rewards page tries to do too much** — 6 tabs mixing config, operations, and design
5. **Badge/pill design is duplicated** — exists in both Plans dialog AND Rewards "Badges" tab
6. **Storefront visual config is scattered** — pill design in Plans, badge design in Rewards, upsell widget in Settings, preview in Storefront Preview
7. **Members action bar doesn't work on mobile** — 4 buttons in a row

### Minor (Fix Later)
8. **Naming inconsistencies** — "Price Rules" vs "Discounts" vs "Wholesale Pricing"
9. **No breadcrumbs or page context** — header says "Store Admin > Apps > WholesaleHub" on every page
10. **No unsaved changes indicators** — close dialog = lose everything

---

## Part 3: Proposed New Navigation Structure

### Design Principles
- **Group by domain** — related features together
- **Max 2 levels** — top-level groups with sub-items
- **Separate operations from configuration** — "managing members" ≠ "configuring plans"
- **Hide complexity until needed** — progressive disclosure

### Proposed Sidebar

```
📊 Dashboard

👥 MEMBERS
   Members              (current Members page, streamlined)
   Subscriptions        (billing, contracts — future)

📦 MEMBERSHIP
   Plans                (plan CRUD — basics only)
   Pricing              (wholesale pricing rules — current "Discounts")
   Access               (content gating — current "Access Rules")

🎁 REWARDS
   Earning Rules        (activities config)
   Redemptions          (store credit + options)
   Medals               (achievement system)
   Balances & History   (operational views, merged)

🎨 STOREFRONT
   Theme & Design       (ALL visual config: pills, badges, colors, upsell widget)
   Portal               (member portal config)
   Preview              (live preview of all storefront elements)

📣 MARKETING
   Notifications        (email templates)
   Collection Alerts    (back-in-stock)

⚙️ SETTINGS
   Integrations         (Shopify, Klaviyo, Blockchain)
   Social Links         (Facebook, Instagram, etc.)
   Exclusions           (marketplace filtering)

🔧 Debug               (collapsed/hidden by default)
```

**Key changes:**
- **7 groups** instead of 12 flat items
- Groups are collapsible in sidebar
- **STOREFRONT** group consolidates all visual/design config that's currently scattered across Plans, Rewards, and Settings
- **Subscriptions** gets a home for when billing management launches
- **Debug** is de-emphasized

---

## Part 4: Proposed Page Layouts

### Plans Page — Redesigned

**Current:** Card grid + monster dialog
**Proposed:** Card grid + full-page editor with tabs

```
┌─────────────────────────────────────────┐
│ Plans                         [+ Create] │
│ Configure membership tiers               │
├─────────────────────────────────────────┤
│ ┌─────────┐ ┌─────────┐ ┌─────────┐    │
│ │ Free    │ │ Silver  │ │ Gold    │    │
│ │ Tier 0  │ │ $49/yr  │ │ $99/yr  │    │
│ │ Active  │ │ Active  │ │ Active  │    │
│ │ [Edit]  │ │ [Edit]  │ │ [Edit]  │    │
│ └─────────┘ └─────────┘ └─────────┘    │
└─────────────────────────────────────────┘
```

**On Edit → Full-page editor (not a dialog):**

```
┌─────────────────────────────────────────┐
│ ← Back to Plans    Gold Wholesale  [Save]│
├───────┬─────────────────────────────────┤
│       │                                  │
│ Tabs: │  [Currently selected tab content]│
│       │                                  │
│ Basic │  Plan Name: [Gold Wholesale    ] │
│       │  Tier Level: [2]                 │
│ Price │  Billing: [Yearly ▼]             │
│       │  Price: [$99.00]                 │
│Renew  │  Description: [........]         │
│       │  Active: [✓]                     │
│Reward │                                  │
│       │                                  │
│Shopify│                                  │
│       │                                  │
│       │                                  │
└───────┴─────────────────────────────────┘
```

**Tabs for the plan editor:**
1. **Basics** — Name, tier, billing, description, active, display order, icon
2. **Pricing & Promotions** — Price, trial, intro pricing, promo mode, auto-convert
3. **Renewal & Cancellation** — Auto-renew, cancellation policy, refund modes
4. **Rewards** — Per-plan earning overrides, redemption overrides, points expiry
5. **Shopify** — Product linking, customer tag, discount %, Klaviyo list
6. **Features** — Bullet point features list, free shipping threshold, portal upsell toggle

**What's REMOVED from the plan editor:**
- All visual/design config (pill design, badge colors, badge styles, UI accent, member price color) → moved to **Storefront > Theme & Design**
- Klaviyo bulk sync → moved to **Settings > Integrations**

This reduces the form from **42 fields** to ~**20 fields spread across 6 focused tabs**.

---

### Members Page — Streamlined

```
┌─────────────────────────────────────────┐
│ Members                                  │
│ Manage membership base                   │
├─────────────────────────────────────────┤
│ [Total: 347] [Active: 312] [Gold: 89]..│
├─────────────────────────────────────────┤
│ 🔍 Search...    [Plan ▼] [Status ▼]     │
│                          [+ Add] [⋮ More]│
├─────────────────────────────────────────┤
│ Name        Email       Plan   Status    │
│ John Doe    j@...       Gold   Active    │
│ Jane Smith  s@...       Silver Active    │
│ Bob Jones   b@...       Free   Expired   │
├─────────────────────────────────────────┤
│ Showing 1-25 of 347    [← 1 2 3 ... →]  │
└─────────────────────────────────────────┘
```

**Key changes:**
- **Action overflow menu** [⋮ More] contains: Sync Shopify, Import CSV, Export — instead of 4 separate buttons
- **Shopify sync progress** becomes a toast notification, not an inline banner
- **Pagination info** added
- **Merge members** becomes accessible from member detail actions, not a standalone dialog
- **Extend membership** and **Adjust points** stay as small dialogs (well-scoped)

**Member Detail Sheet — Add Tabs:**

```
┌──────────────────────────────┐
│ John Doe          Gold [Active]│
│ john@example.com    [⋮ Actions]│
├──────────────────────────────┤
│ Orders: 12  Spent: $1,240     │
│ Points: 450  Saved: $186      │
├──────────────────────────────┤
│ [Overview] [Orders] [Rewards] │
├──────────────────────────────┤
│ (Tab content)                 │
│                               │
│                               │
└──────────────────────────────┘
```

Tabs:
- **Overview** — membership info, dates, plan details
- **Orders** — order history (currently the bulk of the sheet)
- **Rewards** — points history, redemptions, medals

---

### Storefront > Theme & Design — NEW Page

**Consolidates ALL visual configuration currently scattered across Plans, Rewards, and Settings.**

```
┌─────────────────────────────────────────┐
│ Theme & Design                           │
│ Customize how your membership appears    │
├─────────────────────────────────────────┤
│ [Pill Badge] [Rewards Badges] [Upsell]  │
│ [Colors] [Plan Visuals]                  │
├─────────────────────────────────────────┤
│                                          │
│  ┌──────────┐  ┌──────────────────────┐ │
│  │ Live     │  │ Configuration        │ │
│  │ Preview  │  │ ...                  │ │
│  │          │  │                      │ │
│  │ [pill]   │  │ Shimmer: [Metallic ▼]│ │
│  │ [badge]  │  │ Radius: [Square ▼]   │ │
│  │ [upsell] │  │ Colors: [🎨] [🎨]   │ │
│  │          │  │                      │ │
│  └──────────┘  └──────────────────────┘ │
└─────────────────────────────────────────┘
```

**Key design:**
- **Side-by-side layout:** Live preview on left, controls on right
- **Per-plan visual config** is driven by a plan selector dropdown at the top
- **Tabs** for different element types (pill, badges, upsell, colors)
- **Inline preview updates** — no separate "Storefront Preview" page needed
- The current `StorefrontPreview.tsx` preview rendering merges into this page

---

### Settings — Simplified

```
┌─────────────────────────────────────────┐
│ Settings                                 │
├─────────────────────────────────────────┤
│ [Integrations] [Social] [Exclusions]    │
├─────────────────────────────────────────┤
│                                          │
│  Integrations tab:                       │
│  ┌──────────────────────────┐           │
│  │ 🟢 Shopify   [Connected] │           │
│  │    store.myshopify.com    │           │
│  │    [Manage] [Disconnect]  │           │
│  ├──────────────────────────┤           │
│  │ 🟢 Klaviyo   [Connected] │           │
│  │    Auto-sync: On          │           │
│  │    [Manage]               │           │
│  ├──────────────────────────┤           │
│  │ ⚪ Crypto     [Disabled]  │           │
│  │    [Enable & Configure]   │           │
│  └──────────────────────────┘           │
└─────────────────────────────────────────┘
```

**Key changes:**
- **Upsell Widget Controls REMOVED** → moved to Storefront > Theme & Design
- **3 clean tabs** instead of 7 stacked cards
- Integration cards show status at a glance with expand for config

---

### Rewards — Focused

```
┌─────────────────────────────────────────┐
│ Rewards                                  │
├─────────────────────────────────────────┤
│ [Earning Rules] [Redemptions] [Medals]  │
├─────────────────────────────────────────┤
│                                          │
│  Earning Rules tab:                      │
│  Same as current Activities tab          │
│                                          │
│  Redemptions tab:                        │
│  Same as current                         │
│                                          │
│  Medals tab:                             │
│  Same as current                         │
└─────────────────────────────────────────┘
```

**What's removed:**
- **Badges tab** → moved to Storefront > Theme & Design
- **Balances tab** → merged into Members (available via member detail or a sub-view)
- **History tab** → accessible from Members detail or a dedicated "Reward Ledger" sub-view under Rewards

**Result:** 3 tabs instead of 6. All configuration-focused. No operational views mixed in.

---

## Part 5: Design Pattern Standards

### List Pages (Members, Plans, Access Rules, etc.)

```
Header:     Title + description + primary action button
Stats:      Summary cards (optional, for pages with KPIs)
Filters:    Search + filter dropdowns + clear button
Table/Grid: Data with sort headers + row actions
Footer:     Pagination with count ("Showing 1-25 of 347")
```

**Rules:**
- Primary action (Create/Add) is always top-right
- Secondary actions (Import, Export, Sync) go in overflow menu [⋮]
- Inline row actions: Edit, Delete, View Details
- Bulk actions appear when rows are selected

### Detail Views (Member Detail, Plan Editor)

**For simple entities:** Slide-out Sheet (current MemberDetailSheetV2 pattern)
**For complex entities:** Full-page editor with vertical tabs (proposed Plans editor)

**Rules:**
- Header is always sticky with entity name + primary action (Save)
- Tabs separate logical domains
- Each tab should be independently saveable if possible
- Back navigation is always top-left

### Settings/Config Pages

```
Header:     Title + description
Tabs:       Category tabs (3-5 max)
Sections:   Card per config group within tab
Actions:    Save button per Card (not per page)
```

**Rules:**
- Show unsaved state (dot indicator or button color change)
- Disable Save when no changes
- Group related fields in same Card
- Max ~8 fields per Card section

### Form Patterns

| Scope | Pattern | Example |
|-------|---------|---------|
| 1-3 fields | Inline edit | Toggle active status |
| 4-10 fields | Modal dialog | Add member, create access rule |
| 10+ fields | Full-page with tabs | Edit plan |
| Destructive | Confirm dialog | Delete plan, disconnect Shopify |

### Mobile Patterns (375px minimum)

- **Tables:** Convert to card lists on mobile (or horizontal scroll with sticky first column)
- **Dialogs:** Full-screen on mobile (`sm:max-w-[X]` + no max on base)
- **Action buttons:** Max 2 visible, rest in overflow menu
- **Tab bars:** Max 4 visible tabs, scroll for more
- **Color pickers:** Stack vertically, not side-by-side
- **Side-by-side layouts:** Stack vertically below `md` breakpoint

---

## Part 6: Scalability Considerations

### Incoming Features

**Subscription billing management:**
- Already has `Subscriptions.tsx` (518 lines) — just needs sidebar placement
- Proposed location: Members > Subscriptions
- Content: Selling plan groups, contract management, billing cycles

**Dropship access control:**
- Fits naturally into Membership > Access as a new access rule type
- May need a new resource type in the Access Rules dialog

**More plan tiers:**
- Current card grid scales fine for 5-8 plans
- Beyond 8, consider a table/list view toggle
- Plan editor tabs prevent the dialog-explosion problem

**More benefits per plan:**
- Features list already supports arbitrary items
- Plan editor "Basics" tab keeps this manageable
- Rewards tab handles per-plan earning/redemption overrides

### Architecture Recommendations

**Component extraction priorities:**
1. **PlanEditor/** — extract from Plans.tsx into a sub-directory with tab components
2. **StorefrontDesigner/** — consolidate visual config from Plans, Rewards, Settings
3. **MemberActions/** — extract dialog components (Extend, Adjust, Merge, Edit) from Members.tsx
4. **IntegrationCards/** — extract Shopify, Klaviyo, Blockchain cards from Settings.tsx

**File size targets:**
- No page component should exceed **500 lines**
- Complex pages should be composed of imported sub-components
- Each tab panel should be its own component file

---

## Part 7: Implementation Priority

### Phase 1 — Critical (Week 1-2)
1. **Extract Plans dialog into full-page editor with tabs** — biggest UX win
2. **Restructure sidebar navigation** with groups
3. **Move visual/design config out of Plans and Settings** into new Storefront section

### Phase 2 — Major (Week 3-4)
4. **Split Settings into tabbed Integrations/Social/Exclusions**
5. **Reduce Rewards from 6 tabs to 3** (move Badges out, merge Balances/History)
6. **Streamline Members action bar** for mobile
7. **Add tabs to MemberDetailSheetV2** (Overview/Orders/Rewards)

### Phase 3 — Polish (Week 5-6)
8. **Add pagination info to all list views**
9. **Add unsaved changes indicators**
10. **Implement consistent empty states**
11. **Add Dashboard card click-through navigation**
12. **Hide Debug page behind feature flag or admin role**

### Phase 4 — Scalability (As needed)
13. **Integrate Subscriptions page into navigation**
14. **Add plan list/table view toggle for 5+ plans**
15. **Build inline preview for Storefront Design page**

---

## Appendix: File-to-Proposed-Location Mapping

| Current File | Lines | Proposed Location |
|---|---|---|
| `Plans.tsx` | 2,950 | Split → `PlanList.tsx` (300) + `PlanEditor/` (5 tab components, ~200 each) |
| `Rewards.tsx` | 3,106 | Split → `EarningRules.tsx` + `Redemptions.tsx` + `Medals.tsx` + move Badges/Balances/History |
| `Settings.tsx` | 2,453 | Split → `Integrations.tsx` + `SocialLinks.tsx` + `Exclusions.tsx` + move Upsell to Storefront |
| `Members.tsx` | 2,512 | Slim → `Members.tsx` (800) + extract dialogs to `MemberDialogs/` |
| `MemberPortal.tsx` | 3,812 | Keep (public portal, separate concern) |
| `Discounts.tsx` | 1,128 | Rename → `Pricing.tsx`, keep structure |
| `StorefrontPreview.tsx` | 1,404 | Merge into new `StorefrontDesign.tsx` |
| `AccessRules.tsx` | 817 | Keep, minor improvements |
| `Notifications.tsx` | 870 | Keep, minor improvements |
| `PortalConfig.tsx` | 790 | Rename → `PortalEditor.tsx`, keep structure |
| `CollectionAlerts.tsx` | 541 | Keep as-is |
| `Subscriptions.tsx` | 518 | Add to navigation when ready |
| `Dashboard.tsx` | 425 | Keep, add click-through |
| `Debug.tsx` | 175 | Keep, hide from non-dev |

---

*End of review. This document is the source of truth for frontend restructuring of the Shellz Club admin portal.*
