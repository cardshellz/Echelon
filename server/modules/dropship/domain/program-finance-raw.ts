/**
 * The raw aggregates the Program finance repository hands to the pure
 * summary builder (contract §2–§3). One field per SQL statement of the
 * summary snapshot (Q0–Q9, VENDORS_SQL and each check's summary wrapper),
 * each with its own outcome, so a statement that failed in its savepoint or
 * was skipped by the time budget shows as that section's error while the
 * rest of the page still renders.
 *
 * Money and counts are bigint exactly as Postgres returns them (int8 and
 * numeric arrive as decimal text: parse with parseIntegerString from
 * shared/dropship/program-finance-money.ts; a value that is not integer
 * text fails that statement with DROPSHIP_FINANCE_DATA_INVALID). A bigint
 * may be larger than a JSON number can carry; the builder, not the
 * repository, turns each into a number and withholds one that is not safe
 * (the line reads "unavailable", DROPSHIP_FINANCE_AMOUNT_OUT_OF_RANGE).
 *
 * NULL rules for the repository:
 * - A field typed `bigint` is a SUM or COUNT whose SQL NULL can only mean
 *   "no row matched", which is a true zero for that population: map NULL
 *   to 0n (COALESCE in SQL or in the mapper).
 * - A field typed `bigint | null` keeps NULL: there it means "not known"
 *   (no pieces per pack, no paired pull-back, no wallet) and the builder
 *   says so instead of showing 0.
 *
 * Ids (vendor, wallet, ledger row) are integer columns and arrive as JS
 * numbers. Text is passed as stored; the builder bounds what it shows.
 *
 * This file is types and constants only.
 */

import type {
  FinanceCheckId,
  FinanceNeverChargedKind,
  FinanceWaitingReason,
} from "../../../../shared/dropship/program-finance";

// ── statement outcome ───────────────────────────────────────────────────

/** A DROPSHIP_FINANCE_* error code (contract §5). */
export type FinanceErrorCode = `DROPSHIP_FINANCE_${string}`;

/**
 * One statement's outcome. `error`: its savepoint rolled back (statement
 * timeout, missing table, undefined column, bad data); `skipped`: the
 * request budget ran out before it ran (DROPSHIP_FINANCE_BUDGET_EXCEEDED).
 */
export type FinanceRawResult<T> =
  | { readonly status: "ok"; readonly data: T }
  | { readonly status: "error" | "skipped"; readonly errorCode: FinanceErrorCode };

// ── Q0: bounds and tables ───────────────────────────────────────────────

/**
 * The tables the page reads, by the Q0 column that tests them
 * (`to_regclass(...) IS NOT NULL AS t_<key>`), and whether the page can
 * work without them.
 *
 * - `core`: a statement that needs the table fails with
 *   DROPSHIP_FINANCE_TABLE_MISSING (the repository reports it as that
 *   statement's error).
 * - `optional`: the repository leaves the join out and the builder marks
 *   only the lines that need it "unavailable" (reason table_missing).
 *
 * Every missing table is an exception of check P2. Two differ from contract
 * §2.0: `funding_methods` is core because a deposit's rail, and so whether
 * it is cash or a staff credit, can come from the funding method alone; and
 * `vendors` (not in the contract's Q0) is added because Q7 and VENDORS_SQL
 * join it, so Q0 must also select `to_regclass('dropship.dropship_vendors')`.
 */
export const FINANCE_TABLES = Object.freeze([
  { key: "economics", relation: "dropship.dropship_order_economics_snapshots", kind: "core" },
  { key: "intake", relation: "dropship.dropship_order_intake", kind: "core" },
  { key: "quotes", relation: "dropship.dropship_shipping_quote_snapshots", kind: "optional" },
  { key: "ledger", relation: "dropship.dropship_wallet_ledger", kind: "core" },
  { key: "accounts", relation: "dropship.dropship_wallet_accounts", kind: "core" },
  { key: "funding_methods", relation: "dropship.dropship_funding_methods", kind: "core" },
  { key: "vendors", relation: "dropship.dropship_vendors", kind: "core" },
  { key: "lots", relation: "dropship.dropship_wallet_rewards_lots", kind: "optional" },
  { key: "pool_ledger", relation: "dropship.dropship_insurance_pool_ledger", kind: "optional" },
  { key: "claims", relation: "dropship.dropship_carrier_claims", kind: "optional" },
  { key: "rmas", relation: "dropship.dropship_rmas", kind: "optional" },
  { key: "inspections", relation: "dropship.dropship_rma_inspections", kind: "optional" },
  { key: "usdc", relation: "dropship.dropship_usdc_ledger_entries", kind: "optional" },
  { key: "collection_attempts", relation: "dropship.dropship_collection_attempts", kind: "optional" },
  { key: "maintenance_runs", relation: "dropship.dropship_wallet_maintenance_runs", kind: "optional" },
  { key: "audit", relation: "dropship.dropship_audit_events", kind: "optional" },
  { key: "allocations", relation: "dropship.dropship_shipment_shipping_allocations", kind: "optional" },
  { key: "oms_orders", relation: "oms.oms_orders", kind: "core" },
  { key: "oms_lines", relation: "oms.oms_order_lines", kind: "core" },
  { key: "costs", relation: "oms.order_item_costs", kind: "core" },
  { key: "wms_orders", relation: "wms.orders", kind: "core" },
  { key: "wms_items", relation: "wms.order_items", kind: "core" },
  { key: "shipments", relation: "wms.outbound_shipments", kind: "core" },
  { key: "shipment_items", relation: "wms.outbound_shipment_items", kind: "core" },
  { key: "variants", relation: "catalog.product_variants", kind: "optional" },
  { key: "products", relation: "catalog.products", kind: "optional" },
  { key: "lots_inv", relation: "inventory.inventory_lots", kind: "optional" },
  { key: "pick_movements", relation: "inventory.availability_claim_pick_movements", kind: "optional" },
  { key: "return_cases", relation: "returns.return_cases", kind: "optional" },
  { key: "settlements", relation: "returns.return_case_vendor_settlements", kind: "optional" },
] as const);

export type FinanceTableKey = (typeof FINANCE_TABLES)[number]["key"];

/** Q0 `t_<key>` flags: true when the table exists. */
export type FinanceRawTables = Readonly<Record<FinanceTableKey, boolean>>;

/**
 * Q0's bounds, as Postgres worked them out from the same wall-clock text.
 * The builder refuses to label numbers with a window whose instants differ
 * from these (Intl and Postgres zone data disagreeing would be a bug).
 * `startAt` is null for all time ('-infinity'); `endAt` is Q0 `end_at`
 * (LEAST(now, end)), not the 'infinity' `end_bound`.
 */
export interface FinanceRawBounds {
  readonly startAt: Date | null;
  readonly endAt: Date;
  /** Both null when there is no comparison window. */
  readonly compareStartAt: Date | null;
  readonly compareEndAt: Date | null;
}

// ── Q1 / Q1c: orders (contract §2.1) ────────────────────────────────────

/**
 * The grand-total row of Q1 (grouping set ()). `fc` = fully costed: no
 * waiting reason. An empty period is every field 0n (no row came back, or
 * the row's sums were NULL).
 */
export interface FinanceRawOrderTotals {
  /** COUNT(*) */
  readonly orders: bigint;
  /** COUNT(*) FILTER (WHERE waiting_reason IS NULL) */
  readonly fcOrders: bigint;
  /** Σ total_debit_cents */
  readonly billed: bigint;
  readonly billedFc: bigint;
  /** Σ wholesale_subtotal_cents, all / fully costed */
  readonly productBilled: bigint;
  readonly productBilledFc: bigint;
  /** Σ shipping_cents */
  readonly shippingBilled: bigint;
  /** Σ (shipping_cents − insurance_pool_cents) over fully costed orders */
  readonly shippingNetPoolFc: bigint;
  /** Σ quote base_rate_cents / markup_cents / dunnage_cents (orders with a quote) */
  readonly quoteBase: bigint;
  readonly quoteMarkup: bigint;
  readonly quoteDunnage: bigint;
  /** COUNT(*) FILTER (WHERE quote_base_cents IS NULL) */
  readonly ordersWithoutQuote: bigint;
  /** Σ insurance_pool_cents, all / fully costed */
  readonly poolAll: bigint;
  readonly poolFc: bigint;
  /** Σ paid_cash_cents (−order_debit) and Σ paid_points (−rewards_spent) */
  readonly paidCash: bigint;
  readonly paidPoints: bigint;
  /** Σ cogs_mills over fully costed orders: signed mills, rounded to cents once by the builder */
  readonly cogsMillsFc: bigint;
  /** Σ label_cents / replacement_label_cents over fully costed orders (each label once) */
  readonly labelsFc: bigint;
  readonly replacementLabelsFc: bigint;
  /** Q1 `cov_labels` / `cov_labels_costed`: distinct labels over all of E(P) */
  readonly coverageLabels: bigint;
  readonly coverageLabelsCosted: bigint;
  /** Q1 `buyer_paid` (Σ readable grandTotalCents), `buyer_unknown` */
  readonly buyerPaid: bigint;
  readonly buyerUnknown: bigint;
}

/** A Q1 row of grouping set (waiting_reason) with a non-null reason. */
export interface FinanceRawWaitingReasonRow {
  readonly reason: FinanceWaitingReason;
  readonly orders: bigint;
  /** Σ total_debit_cents */
  readonly billed: bigint;
}

export interface FinanceRawOrders {
  readonly totals: FinanceRawOrderTotals;
  /** One row per waiting reason present (Q1 grouping 2); empty for Q1c. */
  readonly byReason: readonly FinanceRawWaitingReasonRow[];
}

// ── Q2: products by size (contract §2.2) ────────────────────────────────

interface FinanceRawProductFigures {
  /** Σ ol.quantity */
  readonly packs: bigint;
  /** Σ quantity × units_per_variant over lines with a size; null when no line has one */
  readonly pieces: bigint | null;
  /** COUNT of lines with no units_per_variant */
  readonly linesWithoutPieces: bigint;
  /** Σ customer_fulfillment qty on shipped, returned or lost packages */
  readonly packsShipped: bigint;
  /** Σ ol.quantity over lines of fully costed orders */
  readonly packsFc: bigint;
  /** Σ ol.total_price_cents, all / fully costed */
  readonly billedProduct: bigint;
  readonly billedProductFc: bigint;
  /** Σ signed cost mills linked to these lines, fully costed orders only */
  readonly cogsMillsFc: bigint;
}

/** A Q2 group row: one per catalog size ("v:<variantId>") or unlinked SKU ("sku:<sku>"). */
export interface FinanceRawProductGroupRow extends FinanceRawProductFigures {
  readonly groupKey: string;
  readonly productVariantId: number | null;
  readonly productId: number | null;
  readonly productName: string | null;
  readonly sizeName: string | null;
  readonly sku: string | null;
  readonly unitsPerVariant: bigint | null;
}

export interface FinanceRawProducts {
  /** The Q2 total row (GROUPING = 1); zeros (pieces null) for an empty period. */
  readonly totals: FinanceRawProductFigures & {
    /** Q2 `unlinked_cogs_mills_fc` (C10): cost rows of fully costed orders linked to no line of the order */
    readonly unlinkedCogsMillsFc: bigint;
  };
  /** Every group row, any order (the builder sorts by billed, then group key). */
  readonly groups: readonly FinanceRawProductGroupRow[];
}

// ── Q3: received and never charged (contract §2.3) ──────────────────────

export interface FinanceRawNeverChargedRow {
  readonly kind: FinanceNeverChargedKind;
  readonly orders: bigint;
  /** Σ readable buyer grandTotalCents, and how many had none */
  readonly buyerTotal: bigint;
  readonly buyerUnknown: bigint;
  /**
   * Σ the latest payment-hold audit `totalDebitCents`; only the two held
   * kinds have one, every other kind is null.
   */
  readonly wouldHaveCharged: bigint | null;
}

// ── Q4: ledger groups (contract §2.4) ───────────────────────────────────

/** Q4 `cash_line` of a deposit (funding row); null for every other type. */
export type FinanceCashLine = "stripe_ach" | "stripe_card" | "usdc_base" | "manual" | "collection" | "unknown";

/**
 * One Q4 group: GROUP BY vendor_id, type, status, reference_type,
 * cash_line, rewards_rail, auto_reload, auto_reload_reason, chain_watcher.
 * `_p` columns count settled rows that moved in the period (deposits by
 * settled_at, everything else by created_at); `_cmp` the same for the
 * comparison window (0n when there is none).
 */
export interface FinanceRawLedgerGroup {
  readonly vendorId: number;
  /** dropship_wallet_ledger.type as stored */
  readonly type: string;
  readonly status: string;
  readonly referenceType: string | null;
  readonly cashLine: FinanceCashLine | null;
  /** COALESCE(metadata->>'rail', funding method rail, 'unknown') of rewards_earned rows; null otherwise */
  readonly rewardsRail: string | null;
  /** metadata->>'autoReload' = 'true' / metadata->>'autoReloadReason' / metadata->>'source' = 'chain_watcher' */
  readonly autoReload: boolean | null;
  readonly autoReloadReason: string | null;
  readonly chainWatcher: boolean | null;
  readonly nP: bigint;
  readonly amountP: bigint;
  /** Σ COALESCE(int(chargedCents), amount_cents), funding rows */
  readonly chargedP: bigint;
  /** Σ int(cardFeeCents), funding rows */
  readonly cardFeeP: bigint;
  /** Σ int(disputeAmountCents) and COUNT without a readable one, funding_reversal rows */
  readonly disputeP: bigint;
  readonly disputeMissingP: bigint;
  /** Σ int(rewardsClawback.fromCashCents), funding_reversal rows */
  readonly fromCashP: bigint;
  /** COUNT of rows in P with any of the four metadata amounts present but not whole cents (D7) */
  readonly malformedP: bigint;
  readonly nCmp: bigint;
  readonly amountCmp: bigint;
  readonly chargedCmp: bigint;
  readonly disputeCmp: bigint;
  /** Σ amount_cents of settled rows with settled_at before the start / before the end bound */
  readonly amountBeforeStart: bigint;
  readonly amountBeforeEnd: bigint;
  /** COUNT / Σ amount_cents of status = 'pending' rows, now */
  readonly nPendingNow: bigint;
  readonly amountPendingNow: bigint;
  /** pending rows created before now − FINANCE_STALE_PENDING_DEPOSIT_DAYS */
  readonly nStale: bigint;
  readonly amountStale: bigint;
  /** CD 1 pending(T) at the end bound: funding created before it, not settled or failed by then */
  readonly amountPendingAtEnd: bigint;
  /** failed rows whose ISO failedAt text falls in the period */
  readonly nFailedP: bigint;
  readonly amountFailedP: bigint;
  /** failed rows with no readable failedAt (D7) */
  readonly failedWithoutTime: bigint;
}

export interface FinanceRawLedger {
  readonly groups: readonly FinanceRawLedgerGroup[];
  /**
   * metadata->'failure'->>'code' of the earliest failed deposit in the
   * period (by failedAt text, then id); null when none failed or it has no
   * code. Shown as stored (contract-stage deviation: no code-to-words map).
   */
  readonly firstFailureCode: string | null;
}

// ── Q5a / Q5b: disputes (contract §2.5) ─────────────────────────────────

/** A settled funding_reinstated row in the period or the comparison window, with its paired pull-back. */
export interface FinanceRawWonDispute {
  readonly inP: boolean;
  readonly inCompare: boolean;
  readonly reinstatedId: number;
  /** The reinstated row's amount_cents (wallet money). */
  readonly restoredCents: bigint;
  /** The paired funding_reversal id; null when none was found. */
  readonly reversalId: number | null;
  /** int() of the pull-back's disputeAmountCents / creditAmountCents / rewardsClawback.fromCashCents; null when missing */
  readonly disputedCents: bigint | null;
  readonly creditCents: bigint | null;
  readonly fromCashCents: bigint | null;
}

export interface FinanceRawDisputes {
  readonly won: readonly FinanceRawWonDispute[];
  /** Q5b: settled pull-backs in the period with no stripe_dispute_reinstated row */
  readonly notWonBack: { readonly disputes: bigint; readonly disputedCents: bigint };
}

// ── Q6: return-fee parts (contract §2.6) ────────────────────────────────

export interface FinanceRawReturnFeeRow {
  readonly referenceType: string | null;
  readonly feeRows: bigint;
  /** Σ −amount_cents */
  readonly feeCents: bigint;
  /** Σ of each part from the settlement column or the inspection fee_breakdown */
  readonly restocking: bigint;
  readonly processing: bigint;
  readonly returnLabel: bigint;
  /** fee rows with neither a settlement nor an inspection fee breakdown */
  readonly splitNotRecorded: bigint;
}

// ── Q7: wallets now (contract §2.7) ─────────────────────────────────────

/**
 * One wallet with its points-lot expiry buckets relative to now. The
 * reconciled-lot and audit counts of contract Q7 feed check W3's row list
 * (part 2) and are not part of the summary.
 */
export interface FinanceRawWallet {
  readonly walletId: number;
  readonly vendorId: number;
  readonly available: bigint;
  readonly pending: bigint;
  readonly points: bigint;
  /** Σ remaining_cents of lots expiring before now + 30 days (past-due lots included) */
  readonly expiresNext30Days: bigint;
  readonly expiresDays31To90: bigint;
  readonly expiresLater: bigint;
  readonly neverExpires: bigint;
}

// ── Q8: insurance pool and claims (contract §2.8) ───────────────────────

export interface FinanceRawPoolClaims {
  readonly status: string;
  readonly claims: bigint;
  /** Σ calculated_credit_cents */
  readonly asked: bigint;
}

export interface FinanceRawPool {
  /** Σ economics.insurance_pool_cents accepted before the start / in the period */
  readonly setAsideBeforeStart: bigint;
  readonly setAsideP: bigint;
  /** Σ pool-ledger claim_replenishment + manual_adjustment before the start / in the period (program-wide) */
  readonly toppedUpBeforeStart: bigint;
  readonly toppedUpP: bigint;
  /** Σ every pool-ledger row before the end bound (program-wide) */
  readonly recordedLedgerAtEnd: bigint;
  readonly claims: readonly FinanceRawPoolClaims[];
}

// ── Q9: Overview bridge (contract §2.9, program view only) ──────────────

export interface FinanceRawBridge {
  /** Σ oms_orders.total_cents on dropship channels, ordered in the period (naive ET), not cancelled */
  readonly omsRow: bigint;
  /** the part with no economics row */
  readonly notAccepted: bigint;
  readonly notAcceptedOrders: bigint;
}

// ── VENDORS_SQL (contract §2.11) ────────────────────────────────────────

/**
 * One vendor that ordered, moved money in the period or holds a balance.
 * The builder works out kept on orders from the parts (one rounding rule),
 * so the contract's SQL `kept_on_orders` column is not needed.
 */
export interface FinanceRawVendorRow {
  readonly vendorId: number;
  readonly businessName: string | null;
  readonly contactName: string | null;
  readonly status: string;
  readonly orders: bigint;
  readonly billed: bigint;
  /** orders with a waiting reason */
  readonly waiting: bigint;
  readonly billedFc: bigint;
  readonly cogsMillsFc: bigint;
  readonly labelsFc: bigint;
  readonly poolFc: bigint;
  /** card fees + advance fees + return fees, positive (VENDORS_SQL `fees`) */
  readonly fees: bigint;
  /** return_credit / return_credit + insurance_pool_credit, in the period */
  readonly creditsCs: bigint;
  readonly creditsAll: bigint;
  /** Σ charged of deposits settled in the period, staff credits aside */
  readonly cashIn: bigint;
  /** The wallet now; all null when the vendor has no wallet. */
  readonly available: bigint | null;
  readonly pending: bigint | null;
  readonly points: bigint | null;
}

// ── checks (contract §3) ────────────────────────────────────────────────

/** The checks the repository runs as SQL; P1 (page identities) and P2 (Q0 flags) are worked out by the builder. */
export type FinanceSqlCheckId = Exclude<FinanceCheckId, "P1" | "P2">;

/** A check's summary wrapper: COUNT(*), COUNT(*) FILTER (is_exception), SUM(|difference|) FILTER (is_exception). */
export interface FinanceRawCheckCounts {
  readonly examined: bigint;
  readonly exceptions: bigint;
  /** null when no exception carries a money difference (SQL SUM over none). */
  readonly difference: bigint | null;
}

/**
 * Every SQL check. N2 is program-only: in a vendor's view the builder
 * reports it "program_wide" and the repository need not run it.
 */
export type FinanceRawChecks = Readonly<Record<Exclude<FinanceSqlCheckId, "N2">, FinanceRawResult<FinanceRawCheckCounts>>> & {
  readonly N2?: FinanceRawResult<FinanceRawCheckCounts>;
};

// ── everything ──────────────────────────────────────────────────────────

export interface FinanceRawAggregates {
  readonly tables: FinanceRawTables;
  readonly bounds: FinanceRawBounds;
  /** Q1 over the period */
  readonly orders: FinanceRawResult<FinanceRawOrders>;
  /** Q1c over the comparison window; null when there is none */
  readonly compareOrders: FinanceRawResult<FinanceRawOrders> | null;
  readonly products: FinanceRawResult<FinanceRawProducts>;
  readonly neverCharged: FinanceRawResult<readonly FinanceRawNeverChargedRow[]>;
  readonly ledger: FinanceRawResult<FinanceRawLedger>;
  readonly disputes: FinanceRawResult<FinanceRawDisputes>;
  readonly returnFees: FinanceRawResult<readonly FinanceRawReturnFeeRow[]>;
  readonly wallets: FinanceRawResult<readonly FinanceRawWallet[]>;
  readonly pool: FinanceRawResult<FinanceRawPool>;
  /** Q9; null in a vendor's view (the bridge is program-wide) */
  readonly bridge: FinanceRawResult<FinanceRawBridge> | null;
  readonly vendors: FinanceRawResult<readonly FinanceRawVendorRow[]>;
  readonly checks: FinanceRawChecks;
}
