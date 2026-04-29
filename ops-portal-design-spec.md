# Card Shellz .ops Portal — Design Specification

> **Version:** 1.0
> **Date:** 2026-04-26
> **Status:** Ready for development
> **Domain:** cardshellz.io
> **Companion doc:** `DROPSHIP-V2-CONSOLIDATED-DESIGN.md` (authoritative business/UX decisions)

This document specifies the visual design system, component library, page structures, and behavioral patterns for the .ops vendor portal. It is the source of truth for engineering implementation. Where this document conflicts with the working prototype (`ops-portal.jsx`), this document governs.

---

## 1. Foundation

### 1.1 Tech Stack Recommendations

The reference prototype is built in **React + Tailwind CSS + Lucide Icons**. The dev team is free to choose its own stack, but the visual output should match this spec regardless of implementation. No requirements are stack-specific.

### 1.2 Browser Support

- Modern evergreen browsers (Chrome, Firefox, Safari, Edge — last 2 major versions)
- Desktop-first (vendors operate at desks managing inventory and listings)
- Responsive down to ~1024px tablet width minimum
- Mobile-responsive layout deferred to Phase 2

### 1.3 Accessibility Targets

- WCAG 2.1 AA compliance
- All interactive elements keyboard-navigable
- Visible focus indicators on all focusable elements
- Color contrast ratios: 4.5:1 for body text, 3:1 for large text and UI components
- All form inputs have associated labels
- Status changes announced to screen readers (aria-live regions on alerts, toasts, async state changes)
- All icons that convey meaning have aria-labels; decorative icons have aria-hidden

---

## 2. Design Tokens

### 2.1 Color Palette

```css
:root {
  /* Brand */
  --ops-purple: rgb(192, 96, 224);          /* #C060E0 — primary brand */
  --ops-purple-dark: rgb(154, 65, 184);     /* #9A41B8 — text on purple tints, hover state */
  --ops-purple-tint: rgba(192, 96, 224, 0.08);   /* sidebar active, button bg */
  --ops-purple-tint-2: rgba(192, 96, 224, 0.14); /* badge bg, accent fill */

  /* Surfaces */
  --bg-app: #FAFAFA;        /* page background */
  --bg-card: #FFFFFF;       /* card / panel background */
  --bg-subtle: #F4F4F5;     /* table headers, hover surfaces, code blocks */
  --bg-overlay: rgba(24, 24, 27, 0.40);  /* modal scrim */

  /* Text */
  --text-primary: #18181B;     /* primary text (zinc-900) */
  --text-secondary: #52525B;   /* secondary text (zinc-600) */
  --text-tertiary: #71717A;    /* tertiary / placeholder (zinc-500) */
  --text-quaternary: #A1A1AA;  /* disabled, decorative (zinc-400) */

  /* Borders */
  --border-default: #E4E4E7;   /* default border (zinc-200) */
  --border-subtle: #F4F4F5;    /* subtle dividers (zinc-100) */
  --border-strong: #D4D4D8;    /* strong border, focus (zinc-300) */

  /* Semantic */
  --color-success-bg: #DCFCE7;
  --color-success-fg: #166534;
  --color-success-strong: #15803D;

  --color-warning-bg: #FEF3C7;
  --color-warning-fg: #92400E;
  --color-warning-bg-soft: #FFFBEB;
  --color-warning-border: #FDE68A;

  --color-danger-bg: #FEE2E2;
  --color-danger-fg: #991B1B;
  --color-danger-soft-bg: #FEF2F2;

  --color-info-bg: #EFF6FF;
  --color-info-fg: #1D4ED8;
}
```

**Usage rules:**
- `--ops-purple` is reserved for primary CTAs, brand marks, and the active state indicator. Do not use it for incidental accents — it should always carry meaning.
- `--ops-purple-tint` is for active states and primary button backgrounds with tinted variants.
- Semantic colors (success, warning, danger, info) are for status communication only — not for visual variety.
- Never use pure black (`#000`) for text. Use `--text-primary` (`#18181B`) which is softer and more readable.

### 2.2 Typography

```css
/* Load order — include in document <head> */
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Inter+Tight:wght@500;600;700&display=swap" rel="stylesheet">

:root {
  --font-display: 'Inter Tight', Inter, -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
  --font-body: 'Inter', -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', sans-serif;
  --font-mono: ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace;
}

body {
  font-family: var(--font-body);
  color: var(--text-primary);
  font-feature-settings: 'cv11', 'ss01', 'ss03';  /* Inter stylistic sets for cleaner numerals */
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

**Type scale (use these sizes verbatim — do not introduce intermediate sizes):**

| Token | Size | Line height | Weight | Tracking | Family | Use case |
|---|---|---|---|---|---|---|
| `text-display-lg` | 30px / 1.875rem | 1.2 | 600 | -0.02em | Display | Onboarding headers, "You're live." |
| `text-display` | 26px / 1.625rem | 1.25 | 600 | -0.01em | Display | Page titles (Topbar) |
| `text-display-sm` | 22px / 1.375rem | 1.3 | 600 | -0.01em | Display | Onboarding step headers |
| `text-h2` | 18px / 1.125rem | 1.4 | 600 | normal | Display | Modal titles |
| `text-h3` | 15px / 0.9375rem | 1.4 | 600 | -0.005em | Body | Card section headers |
| `text-body` | 14px / 0.875rem | 1.5 | 400 | normal | Body | Default body text |
| `text-body-sm` | 13px / 0.8125rem | 1.5 | 400 | normal | Body | Compact body, table cells |
| `text-label` | 12px / 0.75rem | 1.4 | 500 | normal | Body | Field labels, secondary text |
| `text-meta` | 11px / 0.6875rem | 1.4 | 500 | 0.04em UPPERCASE | Body | Section labels, KPI titles |
| `text-mono` | 12px / 0.75rem | 1.5 | 400 | normal | Mono | SKUs, order IDs, tracking numbers, API keys |

**Rules:**
- **All numeric data uses `font-variant-numeric: tabular-nums`** — KPI values, prices, totals, balances, ATP quantities, dates. Tabular alignment matters in a B2B portal.
- Never use ALL CAPS except for `text-meta` labels (small uppercase section labels).
- Never use font-weights 100, 200, 300, 800, or 900. Use 400, 500, 600, or 700 only.
- Headings (`text-display*`, `text-h2`, `text-h3`) use **Inter Tight**.
- All other text uses **Inter**.
- SKUs, order IDs, tracking numbers, API keys, webhook URLs, and other code-like identifiers use **Mono**.

### 2.3 Spacing

Tailwind's default spacing scale (multiples of 4px). Use these consistently:

| Token | Pixels | Use |
|---|---|---|
| `space-1` | 4px | Micro gaps (icon-to-text inside a tight button) |
| `space-2` | 8px | Tight spacing inside compact UI |
| `space-3` | 12px | Default gap inside cards |
| `space-4` | 16px | Standard padding inside cards |
| `space-5` | 20px | Large card padding |
| `space-6` | 24px | Page-level spacing between major sections |
| `space-7` | 28px | Generous section breaks |
| `space-8` | 32px | Maximum used in onboarding cards |

### 2.4 Radii

| Token | Value | Use |
|---|---|---|
| `radius-sm` | 6px | Inline tags, small badges |
| `radius-md` | 8px | Buttons, inputs, table rows |
| `radius-lg` | 12px | Cards, alerts, modals |
| `radius-xl` | 16px | Large feature cards (e.g. wallet balance card) |
| `radius-2xl` | 18px | Onboarding flow cards |
| `radius-full` | 9999px | Pills, avatars, status dots |

### 2.5 Elevation

The portal uses **flat surfaces with subtle borders, not heavy shadows.** Cards float on a subtle 1px border with a tiny shadow that suggests depth without being noisy.

```css
--shadow-card: 0 1px 2px rgba(15, 15, 20, 0.04);          /* default cards */
--shadow-modal: 0 24px 48px rgba(15, 15, 20, 0.18),       /* modal */
                0 8px 16px rgba(15, 15, 20, 0.08);
--shadow-focus: 0 0 0 3px rgba(192, 96, 224, 0.20);       /* focus ring */
```

### 2.6 Motion

Restrained. Snappy. Functional.

```css
--motion-fast: 120ms;           /* hover state, button press */
--motion-default: 180ms;        /* most transitions */
--motion-slow: 240ms;           /* layout shifts, modal enter */

--ease-default: cubic-bezier(0.2, 0, 0, 1);     /* smooth, slight overshoot */
--ease-decelerate: cubic-bezier(0.0, 0, 0.2, 1); /* enter animations */
```

- No bouncy spring physics. No long fades. No staggered animations.
- Only animate properties that the GPU handles well: `transform`, `opacity`. Avoid animating `width`, `height`, `top`, `left`.
- Reduce-motion support: respect `prefers-reduced-motion: reduce` and remove non-essential animations.

---

## 3. Component Library

### 3.1 Button

**Variants:**
- `primary` — purple background, white text, used for the single most important action per view
- `secondary` — white bg, dark text, 1px border, used for default actions
- `ghost` — transparent bg, dark text, used for tertiary actions and toolbars
- `danger` — soft red bg, dark red text, used for destructive actions (disconnect, delete)

**Sizes:**
- `sm` — 28px height, 12px horizontal padding, `text-body-sm`
- `md` — 36px height, 16px horizontal padding, `text-body` (default)
- `lg` — 44px height, 20px horizontal padding, `text-body`

**States:**
- Default
- Hover — primary: 90% opacity; secondary: bg becomes `--bg-subtle`
- Active — scale(0.98) for tactile feedback
- Focus — 3px purple focus ring
- Disabled — 50% opacity, cursor not-allowed

**Behaviors:**
- Buttons that trigger destructive actions (disconnect eBay, delete API key, sign out everywhere) MUST show a confirmation dialog before action
- Async buttons show inline spinner replacing the leading icon during the call; full-width buttons stretch the spinner column

### 3.2 Card

```css
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}
```

- Default padding: 20px (`space-5`)
- Cards never nest more than one level deep
- Cards do not have hover states unless they are a clickable target

### 3.3 Input

```css
.input {
  height: 36px;
  padding: 0 12px;
  font-size: 14px;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-md);
  transition: border-color var(--motion-fast) var(--ease-default);
}
.input:hover { border-color: var(--border-strong); }
.input:focus { border-color: var(--ops-purple); box-shadow: var(--shadow-focus); outline: none; }
.input:disabled { background: var(--bg-subtle); color: var(--text-tertiary); }
.input.error { border-color: var(--color-danger-fg); }
```

- Number inputs use `tabular-nums` typography
- Currency inputs prefix with `$` rendered as inline element to the left
- Search inputs include a leading magnifying glass icon

### 3.4 Status Tag

Inline pill showing a state. Used in Orders, Returns, eBay sync status, etc.

```css
.tag {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
}
```

**Status mapping:**

| Status | Background | Text color | Label |
|---|---|---|---|
| submitted | `#F4F4F5` | `#52525B` | Submitted |
| accepted | `#EFF6FF` | `#1D4ED8` | Accepted |
| picking, packed | `#FEF3C7` | `#92400E` | Picking / Packed |
| shipped | `--ops-purple-tint-2` | `--ops-purple-dark` | Shipped |
| delivered, approved | `#DCFCE7` | `#166534` | Delivered / Approved |
| returned, rejected | `#FEE2E2` | `#991B1B` | Returned / Rejected |
| cancelled, pending | `#F4F4F5` | `#52525B` | Cancelled / Pending |

### 3.5 Sidebar

Fixed-width 224px, white background, full viewport height.

**Anatomy:**
- Brand mark at top (32×32px black square with purple `.ops` cube logomark, "OPS" label)
- Nav items: 16px icon, 14px label, optional badge
- Active item: purple-tinted background, purple-dark text
- Inactive: zinc-700 text, hover bg `--bg-subtle`
- Profile card at bottom: avatar (purple circle with initials), business name, ".ops member" label, chevron

**Behaviors:**
- Clicking the brand mark navigates to Dashboard
- Clicking the profile card navigates to Settings → Account
- Badge counts pull live data (pending RMAs count for Returns, etc.)

### 3.6 Topbar

Page-level header inside the main content area.

**Anatomy:**
- Left: page title (`text-display`) + optional subtitle (`text-label` in `--text-tertiary`)
- Right: action buttons (typically 1 secondary + 1 primary)

### 3.7 Modal

```css
.modal-scrim {
  position: fixed;
  inset: 0;
  background: var(--bg-overlay);
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  background: var(--bg-card);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  max-width: 440px;  /* default; overridable */
  width: 100%;
  padding: 24px;
}
```

**Behaviors:**
- Trap focus inside modal while open
- Escape key closes the modal
- Click on scrim closes the modal (unless the modal contains unsaved changes — then prompt to confirm)
- Modal entrance: scrim fades in over 180ms; modal scales from 0.96 to 1.0 over 180ms

### 3.8 Toggle Switch

```css
.toggle {
  width: 36px;
  height: 20px;
  border-radius: var(--radius-full);
  background: var(--border-default);
  transition: background var(--motion-fast) var(--ease-default);
  position: relative;
}
.toggle.on { background: var(--ops-purple); }
.toggle .knob {
  width: 16px;
  height: 16px;
  border-radius: var(--radius-full);
  background: var(--bg-card);
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform var(--motion-fast) var(--ease-default);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.10);
}
.toggle.on .knob { transform: translateX(16px); }
.toggle:disabled { opacity: 0.6; cursor: not-allowed; }
```

### 3.9 Alert Banner

Used at top of page for status communication (token expiring, RMA pending, etc.).

```css
.alert {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-default);
}
.alert.warn { background: var(--color-warning-bg-soft); border-color: var(--color-warning-border); }
.alert.danger { background: var(--color-danger-soft-bg); border-color: var(--color-danger-bg); }
.alert.info { background: var(--bg-card); }
```

- Icon left, text center (title + body), action button right
- Dismissible alerts include an X close button on the right

### 3.10 KPI Card

Compact metric tile. 4-up grid on desktop.

```css
.kpi {
  padding: 16px;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
}
.kpi__label {
  font-size: 11px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}
.kpi__value {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
  color: var(--text-primary);
  margin-top: 6px;
}
.kpi__sub {
  font-size: 12px;
  color: var(--text-tertiary);
  margin-top: 4px;
}
.kpi__trend {
  display: inline-flex;
  align-items: center;
  font-size: 11px;
  font-weight: 500;
}
.kpi__trend.up { color: var(--color-success-strong); }
.kpi__trend.down { color: var(--color-danger-fg); }
```

### 3.11 Data Table

Used for Orders, Returns, Wallet transactions, Catalog products.

**Anatomy:**
- Header row: 12px uppercase labels, `--bg-subtle` background, 12px vertical padding
- Body rows: 14px text, 14px vertical padding, 1px bottom border (`--border-subtle`), hover bg `--bg-subtle`
- Numeric columns right-aligned with `tabular-nums`
- Mono columns (SKUs, IDs, refs) use `--font-mono`
- Empty state: centered illustration + message + CTA inside the table area

**Behaviors:**
- Clickable rows have cursor-pointer and full-row hover
- Sort by column header (where applicable) — single-column sort, click again to invert, third click to clear
- Pagination footer: "{n} of {total}" + prev/next buttons, or infinite scroll for activity feeds

### 3.12 Sidebar/Tab Navigation (Settings)

Settings uses a vertical tab pattern:
- Left rail: 200px wide, list of section labels
- Right pane: section content
- Active tab: purple-tinted background, purple-dark text
- Sections persist independently (tab change doesn't lose form state in other tabs unless the user navigates away)

---

## 4. Page Specifications

### 4.1 Dashboard (`/dashboard`)

**Purpose:** Operational nerve center. Action items first, metrics second.

**Layout:**
- Topbar: "Good {time-of-day}, {first-name}" + subtitle
- Right actions: "Notifications" secondary button, "Add products" primary button
- Alerts row (1-N alert banners stacked vertically)
- KPI grid (4 columns): Wallet balance, Orders today, Monthly revenue, Avg ship time
- Two-column row:
  - Left (2/3 width): Recent orders list (5 most recent, click to navigate to Orders)
  - Right (1/3 width): Top SKUs this month (4 items with progress bars showing relative volume)
- Two-column row:
  - Left: eBay sync status panel (active listings, last sync, token expiry, store handle)
  - Right: Wallet activity panel (auto-reload status, pending charges, last reload, method on file)

**States:**
- Empty (no orders ever): show welcome message, CTA "Add your first products"
- eBay disconnected: full-width amber alert at top, all eBay data sections show "Not connected" placeholder
- Wallet suspended: full-width red alert at top, fund-now CTA

### 4.2 Catalog (`/catalog`)

**Purpose:** Browse Card Shellz products and select what to push to eBay.

**Layout:**
- Topbar: "Catalog" + subtitle
- Right actions: Filter, "Push N to eBay" primary
- Two-column layout:
  - Left rail (220px): Category list with counts; Bulk action card below
  - Right (flex): Search input + product table

**Product table columns:**
1. Checkbox (selection)
2. Product (name + SKU + weight + "Live on eBay" indicator if listed)
3. Wholesale (right-aligned, tabular nums)
4. MSRP (right-aligned)
5. ATP (right-aligned, amber if low stock)
6. Your retail price (editable input when selected)

**Behaviors:**
- Search filters by name OR SKU (case-insensitive)
- Category filter narrows the visible products
- Selecting at the catalog or category level subscribes the vendor; selecting individual SKUs is a manual list
- "Push N to eBay" button is disabled when no changes from last sync; enabled when selections diverge from currently-listed products
- Bulk subscribe button shows confirmation modal explaining auto-list behavior

### 4.3 Orders (`/orders`)

**Purpose:** Real-time view of all eBay orders, fulfillment status, and tracking.

**Layout:**
- Topbar with Export and Filter buttons
- Status filter tabs: All, Picking, Shipped, Delivered, Returned (with counts)
- Table: Order ID (mono), eBay ref (mono), Destination, Status, Total, When, expand chevron

**Order detail (expanded inline below row):**
- 3-column section: Ship-to address (full PII), Items list, Wallet debit breakdown
- Tracking section below if shipped: tracking number (mono, copyable), carrier, service, "Track package" link to carrier site

**Behaviors:**
- Click row to expand/collapse detail (single row at a time)
- Tracking number copy-to-clipboard on click
- "Track package" opens carrier tracking site in new tab
- Date filter and SKU filter accessible via Filter button (Phase 1)

### 4.4 Wallet (`/wallet`)

**Purpose:** Balance, funding methods, transaction history.

**Layout:**
- Topbar with Statement and "Add funds" buttons
- Hero card (left, 1.4fr): Available balance (large display number, tabular), auto-reload status pill, pending charges, last reload, 3 stats row (min balance, max single reload, default method)
- Funding methods card (right, 1fr): list of methods with icons, default badge, "Coming Phase 2" for USDC, add new method button
- Transactions table: Date, Description, Order ref, Amount, Running balance

**Behaviors:**
- "Add funds" opens FundingModal with amount presets ($50, $100, $200, $500, $1000) + custom input + funding source selector
- Transaction filter chips (All, Debits, Reloads, Refunds) above the table
- Statement download generates PDF for selected month (default: current month)
- Currency display: `$X,XXX.XX` format with thousands separator and 2 decimal places always

### 4.5 Returns (`/returns`)

**Purpose:** Submit RMAs and track inspection.

**Layout:**
- Topbar with "New RMA" button
- Pending inspection alert card (if any RMAs in pending state)
- RMA table: RMA ID (mono), Order (mono), Reason, Status, Credit amount

**New RMA form fields:**
- Original order (autocomplete from delivered orders)
- Items being returned (multi-select from order items)
- Reason code (dropdown: changed mind, defective, damaged in transit, wrong item shipped, customer claims not received)
- Optional notes (textarea, 500 char max)
- Optional return tracking number

**Behaviors:**
- RMA submission is notification-only (no approval gate)
- Inspection status updates push via webhook + email
- Rejected RMAs display Card Shellz inspection photos and reasoning to the vendor
- $3 processing fee shown clearly on credit calculation preview before final credit

### 4.6 Settings (`/settings`)

**Purpose:** Account configuration, integrations, preferences.

**Layout:**
- Topbar (no actions in header, actions live within tabs)
- Two-column: 200px tab list left, content right

**Tabs:**

#### 4.6.1 Account
- Profile section: business name, contact name, email (with "SSO" note), member-since, tier (purple badge)
- Active sessions list: device, location, last active timestamp, "Current" indicator, "Sign out everywhere" button

#### 4.6.2 eBay connection
- Status pill (Connected/Disconnected/Grace period)
- Store handle (mono), active listings count, last sync, token expiry (warn color if <30 days)
- Reconnect alert if approaching expiry
- Disconnect section at bottom: explains 72-hour grace period

#### 4.6.3 Wallet & payment
- Auto-reload settings: minimum balance, max single reload (both editable)
- Funding methods list with default indicator and add-new button

#### 4.6.4 Notifications
- Table: Event name | Email | In-app | SMS | Webhook (each cell = toggle)
- Critical events tagged "CRITICAL" and have email + in-app forced on (toggle disabled)
- "Reset to defaults" button at bottom

#### 4.6.5 API keys
- List of keys with name, scope, created date, last used, status badge
- "New key" button opens modal: name, scope (read-only / orders / wallet / full), confirm
- Key value shown ONCE at creation time; subsequent views show masked
- Show/hide toggle on key value, copy button
- Revoke action with confirmation modal

#### 4.6.6 Webhooks
- List of webhook endpoints with URL (mono), event subscriptions, delivery success rate
- Each endpoint has Configure (manage events, view delivery logs, regenerate signing secret)
- "Add endpoint" opens form: URL, event subscriptions (checkboxes), test ping button

---

## 5. Onboarding Flow (`/onboarding`)

**Gated 5-step flow.** Account remains in `onboarding` status until all 5 complete.

**Layout:**
- Top progress bar: brand mark left, 5-step indicator center, "Skip preview" right (skip is for prototype demo only — production should not allow skip)
- Centered card (max 520px wide) per step
- Each step has Continue (primary) and Back (text link) buttons

### Step 1: Welcome
- Purple square icon, "Welcome to .ops, {name}." display heading
- Body copy: brief intro
- 3-step preview list inside the card
- "Get started" primary button

### Step 2: Connect eBay
- Heading: "Connect your eBay store"
- Body explaining OAuth handoff
- Permissions box: "What .ops will be able to do" with 4 checkmark items
- "Continue to eBay" primary button (production: redirects to eBay OAuth)

### Step 3: Pick products
- Heading: "What do you want to sell?"
- 3 selectable cards: Entire catalog / Pick categories / Hand-pick products
- Each card has icon, title, description, radio indicator
- Selected card has purple border + tinted background
- "Continue" primary button

### Step 4: Fund wallet
- Heading: "Set up your wallet"
- Initial deposit preset chips ($100, $200, $500, $1000)
- Auto-reload settings card: "When balance falls below" + "Max single charge" (both with default values)
- Funding method radio list: ACH (Plaid, recommended) / Card / USDC (disabled, "Available Phase 2")
- "Fund wallet & continue" primary button (production: triggers Stripe checkout / Plaid / contract approve)

### Step 5: Done
- Centered checkmark icon (purple-tinted circle)
- "You're live." display heading
- Body explaining what happens next
- "What's next" callout box with 3 checkmark items
- "Go to dashboard" primary button (transitions account to `active`)

---

## 6. Behavioral Patterns

### 6.1 Loading States

- **Initial page load:** Skeleton screens for tables and cards (animated shimmer using `--bg-subtle` and `--border-subtle`)
- **Inline loading:** Spinner replaces leading icon in buttons during async actions
- **Optimistic updates:** Toggle switches and selection checkboxes flip immediately, revert on error
- **Background sync:** Status indicator dot in eBay panel shows "Syncing..." with subtle pulse during ATP refresh

### 6.2 Error Handling

- **Form validation:** Inline error message below the field in `--color-danger-fg`, red border on input
- **API errors:** Toast notification (top-right, slides in from top, auto-dismisses after 5s, manually dismissible)
- **Critical errors (account suspended, eBay disconnected, wallet failed):** Full-width banner at top of page that persists until resolved
- **Network failure:** Toast with retry button; preserve form state so vendor doesn't lose work

### 6.3 Confirmation Dialogs

Required for destructive actions:
- Disconnect eBay
- Revoke API key
- Cancel order (if cancellable)
- Sign out everywhere
- Delete webhook endpoint

Each dialog must:
- Clearly state what will happen and what cannot be undone
- Have a labeled action button (e.g., "Disconnect" not just "OK")
- Have a Cancel option
- Use `danger` button variant for the destructive action

### 6.4 Real-time Updates

- **Order status changes:** Push via WebSocket or SSE to update the Orders page without refresh
- **Wallet balance:** Update inline when a debit or reload occurs
- **eBay sync status:** Last-sync timestamp updates without refresh
- **RMA status:** Push when inspection completes

When real-time updates are not available (Phase 0 / fallback), polling at 30-second intervals on the active page is acceptable.

### 6.5 Empty States

| Page | Empty state message | CTA |
|---|---|---|
| Orders | "No orders yet" — illustration of empty package | "Browse catalog" |
| Catalog (filter no results) | "No products match" + clear filters link | Clear filters |
| Wallet transactions | "Your transactions will appear here" | "Add funds" |
| Returns | "No returns yet" — illustration | None |
| API keys | "No keys yet" + brief explanation | "Generate your first key" |
| Webhooks | "No webhooks configured" + brief explanation | "Add endpoint" |

### 6.6 Toast Notifications

```css
.toast {
  position: fixed;
  top: 24px;
  right: 24px;
  background: var(--bg-card);
  border: 1px solid var(--border-default);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  padding: 12px 16px;
  display: flex;
  align-items: center;
  gap: 12px;
  z-index: 100;
  max-width: 400px;
}
.toast.success { border-left: 3px solid var(--color-success-strong); }
.toast.danger { border-left: 3px solid var(--color-danger-fg); }
.toast.warn { border-left: 3px solid var(--color-warning-fg); }
```

- Auto-dismiss after 5 seconds (success), 8 seconds (warning), manual-only dismiss (error)
- Stack vertically when multiple are present (newest on top)
- Slide in from the right over 180ms

---

## 7. Number, Currency, and Date Formatting

### 7.1 Currency

- Always 2 decimal places: `$12.50` not `$12.5`
- Thousands separator: `$1,234.56`
- All currency values use `tabular-nums`
- USD only at launch; future internationalization deferred

### 7.2 Numbers

- ATP and quantity counts: comma-separated thousands, no decimals (`1,247`)
- Percentages: 1 decimal place when meaningful (`12.4%`), no decimal when round (`+8%`)
- Weights: 1 decimal place with unit (`0.4 lb`, `18 lb`)
- Dimensions: integer with unit (`14×10×8 in`)

### 7.3 Dates

- **Relative for recent:** "2 minutes ago", "3 hours ago", "Yesterday", "3 days ago"
- **Absolute for older than 7 days:** "Mar 18, 2026"
- **Full timestamps where precision matters:** "Today, 2:14 PM" (transactions)
- **Always use the user's local timezone** (display only — store UTC)

### 7.4 IDs and References

- Order IDs: `DS-00142` format, mono font
- RMA IDs: `RMA-0042` format, mono font
- eBay refs: `EBY-9912` format, mono font
- API keys: `csops_live_xxxxxxxxxx...` format with show/hide toggle

---

## 8. Iconography

**Library:** Lucide Icons (https://lucide.dev). Open source, comprehensive, geometrically consistent.

**Sizing:**
- 16px (`w-4 h-4`) — default for inline icons next to text
- 18px (`w-[18px] h-[18px]`) — primary nav, alert icons
- 20px (`w-5 h-5`) — feature card icons
- 24px (`w-6 h-6`) — onboarding hero icons

**Stroke width:** 2px default. 2.5px for the brand `Hexagon` mark to give it more presence.

**Colors:** Inherit from text color. Override only for semantic icons (warning amber, success green, etc.).

---

## 9. Mock Data for Development

### 9.1 Vendor

```json
{
  "name": "Mike Castellano",
  "business": "Castellano Cards & Collectibles",
  "email": "mike@castellanocards.com",
  "tier": ".ops",
  "ebayStore": "castellano-cards-co",
  "memberSince": "Jan 2026"
}
```

### 9.2 Wallet

```json
{
  "balance": 482.51,
  "minBalance": 50,
  "maxReload": 500,
  "pending": 17.49,
  "autoReload": true,
  "paymentMethod": "ACH •••• 4421"
}
```

### 9.3 Categories (sample)

`Toploaders`, `Penny Sleeves`, `Magnetic Holders`, `Card Boxes & Storage`, `Armalopes`, `Binders & Pages`, `Graded Card Supplies`, `Wax & Display`, `Misc Supplies`

### 9.4 SKU Format

`CS-{TYPE}-{VARIANT}-{COUNT}` — examples: `CS-TL-35PT-25` (toploader 35pt 25-pack), `CS-PS-STD-100` (penny sleeves standard 100ct), `CS-MAG-55PT-1` (magnetic holder 55pt single), `CS-ARM-CASE-100` (armalope case of 100).

---

## 10. Implementation Notes for Dev Team

### 10.1 What's in the Reference Prototype (`ops-portal.jsx`)

The companion JSX file is a working React prototype demonstrating layout, interactions, states, and visual tone. Treat it as design intent, not production code:

- Mock data is hardcoded; production must wire to Echelon API
- No real auth — production uses SSO from cardshellz.com
- No real Stripe, no real eBay OAuth, no real USDC contract
- Single-file React for the artifact constraint; production should split into proper component modules

### 10.2 What's NOT in the Prototype (must be built)

- Actual SSO bridge implementation (cardshellz.com → cardshellz.io OAuth/OIDC handoff)
- API key generation and revocation backend
- Webhook signing (HMAC-SHA256 over the request body with vendor's signing secret)
- Stripe Customer Balance integration with auto-reload
- USDC smart contract on Base + Coinbase Business integration
- eBay OAuth flow + multi-tenant token management + token refresh
- Cartonization engine and rate table (per `DROPSHIP-V2-CONSOLIDATED-DESIGN.md`)
- Real-time push (WebSocket/SSE) for order status, wallet, eBay sync
- Notification delivery (email, SMS, webhook) per channel preferences
- PDF generation for receipts and statements

### 10.3 Pre-Launch Dependencies

Must exist in Echelon before .ops Phase 0 ships:

- Cartonization engine + per-SKU packaging profiles
- Carrier rate table with admin UI
- Zone calculator
- Box catalog
- Multi-tenant eBay OAuth
- Stripe Customer Balance integration
- Wallet ledger schema and reconciliation
- SSO bridge from cardshellz.com
- Admin UI for shipping markup %, insurance pool %, dunnage %, rate table

### 10.4 Open Items for Engineering Decision

These are not specified by design and need engineering input:

- State management library (Redux, Zustand, React Query — recommend React Query for server state)
- Routing (React Router, TanStack Router — either is fine)
- Form library (React Hook Form recommended)
- Component testing strategy
- E2E testing approach for the 5-step onboarding gate

---

*End of design specification. Companion files: `ops-portal.jsx` (reference prototype), `DROPSHIP-V2-CONSOLIDATED-DESIGN.md` (authoritative business and UX decisions).*
