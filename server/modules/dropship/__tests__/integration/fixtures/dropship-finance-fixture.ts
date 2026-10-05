/**
 * The contract §6.4 seeded program for the Program finance Postgres suite
 * (dropship-finance.integration.test.ts): the source tables the finance SQL
 * reads, and the rows that make up orders A–K, H and P1, the V12, V13 and
 * V14 ledgers, the pool, the claim and the intakes that were never charged.
 *
 * The tables are minimal copies: only the columns the finance SQL reads
 * (plus each primary key), with the type, nullability and default each
 * column has after the migrations, so a type the SQL does not expect fails
 * here. OMS and WMS money columns are INTEGER where the migrations create
 * them INTEGER (oms_orders and oms_order_lines: 0002/0071; outbound_shipments
 * carrier_cost_cents: 0070/0071); order_item_costs cents are BIGINT after
 * 0576 and its mills columns BIGINT NOT NULL DEFAULT 0 (server/db.ts). CHECK
 * constraints and unique indexes are kept where they only involve those
 * columns, so the seed must use values production can hold. Foreign keys are
 * left out: the finance SQL never relies on them, and the variants drop
 * tables one at a time.
 *
 * The amounts are integer cents (or mills where named); the seed builds the
 * wallet accounts from its own ledger rows so W1–W3 tie, as the contract asks.
 */

import { signedMillsToCents } from "../../../../../../shared/dropship/program-finance-money";
import type { FinanceWaitingReason } from "../../../../../../shared/dropship/program-finance";
import { FINANCE_TABLES } from "../../../domain/program-finance-raw";

/** The contract §6.4 clock. */
export const FINANCE_FIXTURE_NOW = new Date("2026-10-05T13:14:00.000Z");

/**
 * The DST case needs a clock after 2026-11-01 (a custom range may not end
 * after today, program-finance-period.ts `to_after_today`).
 */
export const FINANCE_FIXTURE_DST_NOW = new Date("2026-11-10T15:00:00.000Z");

/** The Dropship channel every seeded intake and OMS order belongs to. */
const DROPSHIP_CHANNEL_ID = 7;
/** Every economics row names a store connection (NOT NULL in 0086); none of the SQL groups by it. */
const STORE_CONNECTION_ID = 1;
/** One inventory lot carries every cost row: order_item_costs.inventory_lot_id is NOT NULL, and no finance statement reads the lot. */
const INVENTORY_LOT_ID = 1;
const USDC_BASE_CHAIN_ID = 8453;

// ── relations and qualification ─────────────────────────────────────────

/**
 * Every relation the finance SQL may name (FINANCE_TABLES), plus the WMS
 * shipment status type the DDL creates. Qualification refuses any other
 * name, so a statement that reads an unlisted table fails the suite.
 */
const SOURCE_RELATIONS: ReadonlySet<string> = new Set([
  ...FINANCE_TABLES.map((table) => table.relation),
  "wms.shipment_status",
]);

const ISOLATED_SCHEMA = /^dropship_finance_[0-9]+(_[a-z0-9]+)?$/;

/** Rewrites every source relation into the isolated schema; refuses anything unknown. */
export function qualifyFinanceSql(sql: string, schema: string): string {
  if (!ISOLATED_SCHEMA.test(schema)) throw new Error("Invalid isolated finance schema name.");
  return sql.replace(/\b(dropship|oms|wms|catalog|inventory|returns)\.([a-z_]+)\b/g, (relation, _namespace, name: string) => {
    if (!SOURCE_RELATIONS.has(relation)) throw new Error(`Unexpected finance source relation: ${relation}`);
    return `"${schema}"."${name}"`;
  });
}

export function assertFinanceSchemaName(schema: string): void {
  if (!ISOLATED_SCHEMA.test(schema)) throw new Error("Invalid isolated finance schema name.");
}

// ── DDL (types from the migrations named beside each table) ─────────────

export const FINANCE_FIXTURE_DDL = `
-- 060_outbound_shipments_expand.sql
CREATE TYPE wms.shipment_status AS ENUM ('planned', 'queued', 'labeled', 'shipped', 'on_hold', 'voided', 'cancelled', 'returned', 'lost');

-- 0086_dropship_v2_foundation.sql
CREATE TABLE dropship.dropship_vendors (
  id integer PRIMARY KEY,
  business_name varchar(200),
  contact_name varchar(200),
  status varchar(30) NOT NULL DEFAULT 'onboarding',
  CONSTRAINT dropship_vendors_status_chk CHECK (status IN ('onboarding','active','paused','lapsed','suspended','closed'))
);

-- 0086; rewards_balance_cents 0702; dropship_wallet_available_chk dropped in 191 (a vendor may owe us)
CREATE TABLE dropship.dropship_wallet_accounts (
  id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  available_balance_cents bigint NOT NULL DEFAULT 0,
  pending_balance_cents bigint NOT NULL DEFAULT 0,
  rewards_balance_cents bigint NOT NULL DEFAULT 0,
  CONSTRAINT dropship_wallet_pending_chk CHECK (pending_balance_cents >= 0),
  CONSTRAINT dropship_wallet_rewards_chk CHECK (rewards_balance_cents >= 0)
);
CREATE UNIQUE INDEX dropship_wallet_vendor_idx ON dropship.dropship_wallet_accounts(vendor_id);

-- 0086
CREATE TABLE dropship.dropship_funding_methods (
  id integer PRIMARY KEY,
  rail varchar(40) NOT NULL,
  CONSTRAINT dropship_funding_rail_chk CHECK (rail IN ('stripe_ach','stripe_card','usdc_base','manual'))
);

-- 0086; type list as of 0705; balance-after checks dropped in 191
CREATE TABLE dropship.dropship_wallet_ledger (
  id integer PRIMARY KEY,
  wallet_account_id integer,
  vendor_id integer NOT NULL,
  type varchar(40) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  amount_cents bigint NOT NULL,
  reference_type varchar(80),
  reference_id varchar(255),
  funding_method_id integer,
  metadata jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CONSTRAINT dropship_wallet_ledger_type_chk CHECK (type IN ('funding','order_debit','refund_credit','return_credit','return_fee','insurance_pool_credit','manual_adjustment','advance_fee','funding_reversal','funding_reinstated','rewards_earned','rewards_spent','rewards_reversed','rewards_reinstated','rewards_expired')),
  CONSTRAINT dropship_wallet_ledger_status_chk CHECK (status IN ('pending','settled','failed','voided')),
  CONSTRAINT dropship_wallet_ledger_amount_chk CHECK (amount_cents <> 0),
  CONSTRAINT dropship_wallet_ledger_reference_chk CHECK (
    (reference_type IS NULL AND reference_id IS NULL) OR (reference_type IS NOT NULL AND reference_id IS NOT NULL))
);
CREATE UNIQUE INDEX dropship_wallet_ref_idx ON dropship.dropship_wallet_ledger(reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;

-- 0705_dropship_wallet_rewards_expiry.sql
CREATE TABLE dropship.dropship_wallet_rewards_lots (
  id integer PRIMARY KEY,
  wallet_account_id integer NOT NULL,
  remaining_cents bigint NOT NULL,
  expires_at timestamptz,
  CONSTRAINT dropship_wallet_rewards_lots_remaining_chk CHECK (remaining_cents >= 0)
);

-- 0086
CREATE TABLE dropship.dropship_order_intake (
  id integer PRIMARY KEY,
  channel_id integer NOT NULL,
  vendor_id integer NOT NULL,
  status varchar(40) NOT NULL DEFAULT 'received',
  cancellation_status varchar(40),
  normalized_payload jsonb,
  oms_order_id bigint,
  received_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  CONSTRAINT dropship_order_intake_status_chk CHECK (status IN ('received','processing','accepted','rejected','retrying','failed','payment_hold','cancelled','exception'))
);

-- 0086
CREATE TABLE dropship.dropship_shipping_quote_snapshots (
  id integer PRIMARY KEY,
  base_rate_cents bigint NOT NULL,
  markup_cents bigint NOT NULL DEFAULT 0,
  dunnage_cents bigint NOT NULL DEFAULT 0,
  insurance_pool_cents bigint NOT NULL DEFAULT 0,
  total_shipping_cents bigint NOT NULL
);

-- 0086
CREATE TABLE dropship.dropship_order_economics_snapshots (
  id integer PRIMARY KEY,
  intake_id integer NOT NULL,
  oms_order_id bigint,
  vendor_id integer NOT NULL,
  store_connection_id integer NOT NULL,
  shipping_quote_snapshot_id integer,
  wholesale_subtotal_cents bigint NOT NULL,
  shipping_cents bigint NOT NULL,
  insurance_pool_cents bigint NOT NULL DEFAULT 0,
  fees_cents bigint NOT NULL DEFAULT 0,
  total_debit_cents bigint NOT NULL,
  pricing_snapshot jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX dropship_order_econ_intake_idx ON dropship.dropship_order_economics_snapshots(intake_id);

-- 0086
CREATE TABLE dropship.dropship_audit_events (
  id integer PRIMARY KEY,
  entity_type varchar(80) NOT NULL,
  entity_id varchar(255),
  event_type varchar(120) NOT NULL,
  payload jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 191_dropship_collection_sweep_noinspection.sql
CREATE TABLE dropship.dropship_insurance_pool_ledger (
  id integer PRIMARY KEY,
  entry_type varchar(40) NOT NULL,
  amount_cents bigint NOT NULL,
  wallet_ledger_entry_id integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_pool_ledger_type_chk CHECK (entry_type IN ('no_inspection_payout','claim_replenishment','manual_adjustment')),
  CONSTRAINT dropship_pool_ledger_amount_chk CHECK (amount_cents <> 0)
);

-- 0086; calculated_credit_cents 0585
CREATE TABLE dropship.dropship_carrier_claims (
  id integer PRIMARY KEY,
  intake_id integer,
  status varchar(40) NOT NULL DEFAULT 'pending',
  calculated_credit_cents bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 0086
CREATE TABLE dropship.dropship_rmas (
  id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  intake_id integer
);

-- 0086; fee_breakdown 0611; one inspection per RMA 0097
CREATE TABLE dropship.dropship_rma_inspections (
  id integer PRIMARY KEY,
  rma_id integer NOT NULL,
  credit_cents bigint NOT NULL DEFAULT 0,
  fee_cents bigint NOT NULL DEFAULT 0,
  fee_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dropship_rma_inspection_money_chk CHECK (credit_cents >= 0 AND fee_cents >= 0)
);
CREATE UNIQUE INDEX dropship_rma_inspection_one_per_rma_idx ON dropship.dropship_rma_inspections(rma_id);

-- 0086; status lifecycle and log index 0691
CREATE TABLE dropship.dropship_usdc_ledger_entries (
  id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  wallet_ledger_id integer,
  chain_id integer NOT NULL DEFAULT 8453,
  transaction_hash varchar(100) NOT NULL,
  log_index integer,
  amount_atomic_units numeric(78,0) NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  CONSTRAINT dropship_usdc_amount_chk CHECK (amount_atomic_units > 0),
  CONSTRAINT dropship_usdc_status_chk CHECK (status IN ('pending', 'settled', 'voided', 'dust')),
  CONSTRAINT dropship_usdc_log_index_chk CHECK (log_index IS NULL OR log_index >= 0)
);
CREATE UNIQUE INDEX dropship_usdc_tx_log_idx ON dropship.dropship_usdc_ledger_entries(chain_id, transaction_hash, COALESCE(log_index, -1));

-- 191
CREATE TABLE dropship.dropship_collection_attempts (
  id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  amount_cents bigint NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  wallet_ledger_entry_id integer,
  CONSTRAINT dropship_collection_attempts_status_chk CHECK (status IN ('pending','succeeded','failed','escalated','skipped')),
  CONSTRAINT dropship_collection_attempts_amount_chk CHECK (amount_cents > 0)
);

-- 0676_dropship_wallet_maintenance_runs.sql
CREATE TABLE dropship.dropship_wallet_maintenance_runs (
  id integer PRIMARY KEY,
  vendor_id integer NOT NULL,
  amount_cents bigint,
  card_fee_cents bigint,
  charged_cents bigint,
  wallet_ledger_entry_id integer,
  CONSTRAINT dropship_wallet_maintenance_runs_amount_chk CHECK (amount_cents IS NULL OR amount_cents >= 0),
  CONSTRAINT dropship_wallet_maintenance_runs_fee_chk CHECK (card_fee_cents IS NULL OR card_fee_cents >= 0),
  CONSTRAINT dropship_wallet_maintenance_runs_charged_chk CHECK (charged_cents IS NULL OR charged_cents >= 0)
);

-- 0586_dropship_carrier_claim_intake.sql
CREATE TABLE dropship.dropship_shipment_shipping_allocations (
  id bigint PRIMARY KEY,
  intake_id integer NOT NULL,
  allocated_shipping_charge_cents bigint NOT NULL
);

-- 0002/0071 (money columns INTEGER; no later migration widens them)
CREATE TABLE oms.oms_orders (
  id bigint PRIMARY KEY,
  channel_id integer NOT NULL,
  status varchar(30) NOT NULL DEFAULT 'pending',
  financial_status varchar(30) DEFAULT 'paid',
  subtotal_cents integer NOT NULL DEFAULT 0,
  shipping_cents integer NOT NULL DEFAULT 0,
  tax_cents integer NOT NULL DEFAULT 0,
  discount_cents integer NOT NULL DEFAULT 0,
  total_cents integer NOT NULL DEFAULT 0,
  ordered_at timestamp NOT NULL,
  cancelled_at timestamp
);

-- 0002/0071
CREATE TABLE oms.oms_order_lines (
  id bigint PRIMARY KEY,
  order_id bigint NOT NULL,
  product_variant_id integer,
  sku varchar(100),
  quantity integer NOT NULL,
  total_price_cents integer NOT NULL DEFAULT 0
);

-- 0002/0071; cents BIGINT 0576; mills server/db.ts startup columns
CREATE TABLE oms.order_item_costs (
  id integer PRIMARY KEY,
  order_id integer NOT NULL,
  order_item_id integer NOT NULL,
  inventory_lot_id integer NOT NULL,
  qty integer NOT NULL,
  unit_cost_cents bigint NOT NULL,
  total_cost_cents bigint NOT NULL,
  unit_cost_mills bigint NOT NULL DEFAULT 0,
  total_cost_mills bigint NOT NULL DEFAULT 0
);

-- 0002/0071
CREATE TABLE wms.orders (
  id integer PRIMARY KEY,
  source varchar(20) NOT NULL DEFAULT 'shopify',
  oms_fulfillment_order_id varchar(128)
);

-- 0002/0071; oms_order_line_id BIGINT 108
CREATE TABLE wms.order_items (
  id integer PRIMARY KEY,
  order_id integer NOT NULL,
  oms_order_line_id bigint,
  picked_quantity integer NOT NULL DEFAULT 0
);

-- 0002/0071; status enum 060; carrier cost source and its capture check 0586 (carrier_cost_recorded_at
-- is kept only for that check); shipment_purpose 0587
CREATE TABLE wms.outbound_shipments (
  id integer PRIMARY KEY,
  order_id integer,
  status wms.shipment_status NOT NULL DEFAULT 'planned',
  shipment_purpose varchar(30) NOT NULL DEFAULT 'customer_fulfillment',
  carrier_cost_cents integer DEFAULT 0,
  carrier_cost_source varchar(40),
  carrier_cost_recorded_at timestamptz,
  external_fulfillment_id varchar(200),
  CONSTRAINT outbound_shipments_purpose_chk CHECK (shipment_purpose IN ('customer_fulfillment', 'replacement')),
  CONSTRAINT outbound_shipments_carrier_cost_capture_chk CHECK (
    (carrier_cost_source IS NULL AND carrier_cost_recorded_at IS NULL)
    OR (btrim(carrier_cost_source) <> '' AND carrier_cost_recorded_at IS NOT NULL AND carrier_cost_cents > 0))
);

-- 0002/0071; shipment_item_purpose 143
CREATE TABLE wms.outbound_shipment_items (
  id integer PRIMARY KEY,
  shipment_id integer NOT NULL,
  order_item_id integer,
  qty integer NOT NULL DEFAULT 1,
  shipment_item_purpose varchar(30),
  CONSTRAINT outbound_shipment_items_purpose_chk CHECK (shipment_item_purpose IN ('customer_fulfillment', 'replacement', 'concession', 'unclassified'))
);

-- 0002/0071
CREATE TABLE catalog.products (
  id integer PRIMARY KEY,
  name text NOT NULL
);
CREATE TABLE catalog.product_variants (
  id integer PRIMARY KEY,
  product_id integer NOT NULL,
  sku varchar(100),
  name text NOT NULL,
  units_per_variant integer NOT NULL DEFAULT 1
);

-- Only their existence is read (Q0 table flags).
CREATE TABLE inventory.inventory_lots (id integer PRIMARY KEY);
CREATE TABLE inventory.availability_claim_pick_movements (id bigint PRIMARY KEY);

-- 0613_return_cases.sql
CREATE TABLE returns.return_cases (
  id bigint PRIMARY KEY,
  oms_order_id bigint NOT NULL
);

-- 207_return_case_financial_actions.sql
CREATE TABLE returns.return_case_vendor_settlements (
  id bigint PRIMARY KEY,
  return_case_id bigint NOT NULL,
  vendor_id integer NOT NULL,
  gross_credit_cents bigint NOT NULL,
  total_fee_cents bigint NOT NULL,
  restocking_fee_cents bigint NOT NULL,
  processing_fee_cents bigint NOT NULL,
  return_shipping_fee_cents bigint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`;

// ── the program ─────────────────────────────────────────────────────────

export type FinanceFixtureTable =
  | (typeof FINANCE_TABLES)[number]["relation"];

export interface FinanceFixtureRow {
  readonly table: FinanceFixtureTable;
  readonly row: Readonly<Record<string, unknown>>;
}

export const FIXTURE_VENDORS = Object.freeze({ acme: 12, packRat: 13, noOrders: 14 });
type VendorId = (typeof FIXTURE_VENDORS)[keyof typeof FIXTURE_VENDORS];
const WALLET_OF: Readonly<Record<VendorId, number>> = Object.freeze({ 12: 1, 13: 2, 14: 3 });

const VARIANT = Object.freeze({ toploaders: 101, pennySleeves: 102 });

interface FixtureLine {
  readonly variantId: number | null;
  readonly sku: string;
  readonly packs: number;
  readonly unitCents: number;
}

interface FixtureLabel {
  /** wms.outbound_shipments.external_fulfillment_id */
  readonly externalId: string;
  /** null: the label has no recorded cost (no carrier_cost_source). */
  readonly costCents: number | null;
  readonly purpose: "customer_fulfillment" | "replacement";
}

export interface FinanceFixtureOrder {
  /** The §6.4 order letter. */
  readonly key: string;
  readonly intakeId: number;
  readonly vendorId: VendorId;
  readonly acceptedAt: string;
  readonly lines: readonly FixtureLine[];
  readonly quote: { readonly base: number; readonly markup: number; readonly pool: number };
  readonly paidCash: number;
  readonly paidPoints: number;
  /** Packs on the first label's customer_fulfillment item (and picked). */
  readonly shippedPacks: number;
  readonly labels: readonly FixtureLabel[];
  readonly costRows: readonly { readonly packs: number; readonly unitMills: number }[];
  /** The buyer's grand total on the intake; null when the marketplace sent none. */
  readonly buyerTotalCents: number | null;
  readonly cancelledInOms?: boolean;
  /** An advance fee recorded with the order debit (O1 pairs them). */
  readonly advanceFeeCents?: number;
  /** What §6.4 says the order waits for; null when fully costed. */
  readonly expectedWaitingReason: FinanceWaitingReason | null;
}

const tl = (packs: number, unitCents: number): FixtureLine => ({ variantId: VARIANT.toploaders, sku: "TL-25", packs, unitCents });
const ps = (packs: number, unitCents: number): FixtureLine => ({ variantId: VARIANT.pennySleeves, sku: "PS-100", packs, unitCents });
const label = (externalId: string, costCents: number | null, purpose: FixtureLabel["purpose"] = "customer_fulfillment"): FixtureLabel =>
  ({ externalId, costCents, purpose });

/** Orders A–K, H and P1 (contract §6.4 "Orders"). */
export const FINANCE_FIXTURE_ORDERS: readonly FinanceFixtureOrder[] = Object.freeze([
  { key: "A", intakeId: 1001, vendorId: 12, acceptedAt: "2026-10-02T14:00:00.000Z", lines: [tl(6, 670)], quote: { base: 740, markup: 120, pool: 50 },
    paidCash: 4530, paidPoints: 400, shippedPacks: 6,
    labels: [label("shipstation_shipment:9101", 685), label("shipstation_shipment:9102", 250, "replacement")],
    costRows: [{ packs: 4, unitMills: 47_400 }, { packs: 2, unitMills: 47_300 }], buyerTotalCents: 6495, expectedWaitingReason: null },
  { key: "B", intakeId: 1002, vendorId: 12, acceptedAt: "2026-10-03T15:00:00.000Z", lines: [ps(2, 1000)], quote: { base: 450, markup: 100, pool: 50 },
    paidCash: 2600, paidPoints: 0, shippedPacks: 2, labels: [label("shipstation_shipment:9103", 520)],
    costRows: [{ packs: 2, unitMills: 31_075 }], buyerTotalCents: 3400, advanceFeeCents: 10, expectedWaitingReason: null },
  { key: "C", intakeId: 1003, vendorId: 13, acceptedAt: "2026-10-04T12:00:00.000Z", lines: [tl(3, 500)], quote: { base: 500, markup: 150, pool: 50 },
    paidCash: 2200, paidPoints: 0, shippedPacks: 3, labels: [label("shipstation_shipment:9104", 480)],
    costRows: [{ packs: 1, unitMills: 10_050 }, { packs: 2, unitMills: 10_000 }], buyerTotalCents: 2999, expectedWaitingReason: null },
  { key: "D", intakeId: 1004, vendorId: 13, acceptedAt: "2026-10-04T16:00:00.000Z", lines: [ps(2, 500)], quote: { base: 380, markup: 80, pool: 40 },
    paidCash: 1500, paidPoints: 0, shippedPacks: 2, labels: [label("shipstation_combined:9001:order:7004", 900)],
    costRows: [{ packs: 2, unitMills: 20_000 }], buyerTotalCents: 1999, expectedWaitingReason: "shared_label" },
  { key: "E", intakeId: 1005, vendorId: 12, acceptedAt: "2026-10-05T12:00:00.000Z", lines: [tl(2, 600)], quote: { base: 450, markup: 100, pool: 50 },
    paidCash: 0, paidPoints: 1800, shippedPacks: 2, labels: [label("shipstation_combined:9001:order:7005", 900)],
    costRows: [{ packs: 2, unitMills: 30_000 }], buyerTotalCents: 2450, expectedWaitingReason: "shared_label" },
  { key: "F", intakeId: 1006, vendorId: 12, acceptedAt: "2026-10-05T13:00:00.000Z", lines: [ps(1, 800)], quote: { base: 380, markup: 80, pool: 40 },
    paidCash: 1300, paidPoints: 0, shippedPacks: 0, labels: [], costRows: [], buyerTotalCents: 1700, expectedWaitingReason: "not_shipped" },
  // 05:00Z is 01:00 EDT on Oct 1: the first hours of the month count.
  { key: "G", intakeId: 1007, vendorId: 13, acceptedAt: "2026-10-01T05:00:00.000Z", lines: [tl(2, 500)], quote: { base: 370, markup: 90, pool: 40 },
    paidCash: 1500, paidPoints: 0, shippedPacks: 1, labels: [label("shipstation_shipment:9107", 410)],
    costRows: [{ packs: 1, unitMills: 20_000 }], buyerTotalCents: 2100, expectedWaitingReason: "partly_shipped" },
  { key: "I", intakeId: 1008, vendorId: 13, acceptedAt: "2026-10-03T18:00:00.000Z", lines: [ps(1, 600)], quote: { base: 300, markup: 70, pool: 30 },
    paidCash: 1000, paidPoints: 0, shippedPacks: 1, labels: [label("shipstation_shipment:9108", null)],
    costRows: [{ packs: 1, unitMills: 21_000 }], buyerTotalCents: 1350, expectedWaitingReason: "label_missing" },
  { key: "J", intakeId: 1009, vendorId: 12, acceptedAt: "2026-10-02T19:00:00.000Z", lines: [tl(1, 700)], quote: { base: 290, markup: 80, pool: 30 },
    paidCash: 1100, paidPoints: 0, shippedPacks: 1, labels: [label("shipstation_shipment:9109", 300)],
    costRows: [], buyerTotalCents: 1500, expectedWaitingReason: "item_cost_missing" },
  { key: "K", intakeId: 1010, vendorId: 13, acceptedAt: "2026-10-02T20:00:00.000Z", lines: [{ variantId: null, sku: "MYSTERY-1", packs: 1, unitCents: 500 }],
    quote: { base: 220, markup: 60, pool: 20 }, paidCash: 800, paidPoints: 0, shippedPacks: 0, labels: [], costRows: [], buyerTotalCents: null,
    cancelledInOms: true, expectedWaitingReason: "cancelled_in_oms" },
  // 03:30Z on Oct 1 is 23:30 EDT on Sep 30: outside the month (the boundary order).
  { key: "H", intakeId: 1011, vendorId: 12, acceptedAt: "2026-10-01T03:30:00.000Z", lines: [tl(2, 500)], quote: { base: 380, markup: 80, pool: 40 },
    paidCash: 1500, paidPoints: 0, shippedPacks: 2, labels: [label("shipstation_shipment:9111", 300)],
    costRows: [{ packs: 2, unitMills: 25_000 }], buyerTotalCents: 2000, expectedWaitingReason: null },
  { key: "P1", intakeId: 1012, vendorId: 12, acceptedAt: "2026-09-03T15:00:00.000Z", lines: [ps(2, 1000)], quote: { base: 450, markup: 100, pool: 50 },
    paidCash: 2600, paidPoints: 0, shippedPacks: 2, labels: [label("shipstation_shipment:9112", 500)],
    costRows: [{ packs: 2, unitMills: 50_000 }], buyerTotalCents: 3200, expectedWaitingReason: null },
] satisfies FinanceFixtureOrder[]);

/**
 * The DST case (contract §6.4): Nov 1 2026 in New York runs 25 hours, from
 * 04:00Z to 05:00Z the next day. Two orders fall inside it, one exactly on
 * the next midnight falls outside. None is shipped.
 */
export const FINANCE_DST_ORDERS: readonly FinanceFixtureOrder[] = Object.freeze([
  { key: "DST-IN-FIRST", intakeId: 1201, vendorId: 12, acceptedAt: "2026-11-01T04:30:00.000Z", lines: [ps(1, 600)], quote: { base: 300, markup: 70, pool: 30 },
    paidCash: 1000, paidPoints: 0, shippedPacks: 0, labels: [], costRows: [], buyerTotalCents: 1300, expectedWaitingReason: "not_shipped" },
  { key: "DST-IN-LAST", intakeId: 1202, vendorId: 12, acceptedAt: "2026-11-02T04:30:00.000Z", lines: [ps(1, 1600)], quote: { base: 300, markup: 70, pool: 30 },
    paidCash: 2000, paidPoints: 0, shippedPacks: 0, labels: [], costRows: [], buyerTotalCents: 2500, expectedWaitingReason: "not_shipped" },
  { key: "DST-OUT", intakeId: 1203, vendorId: 12, acceptedAt: "2026-11-02T05:00:00.000Z", lines: [ps(1, 3600)], quote: { base: 300, markup: 70, pool: 30 },
    paidCash: 4000, paidPoints: 0, shippedPacks: 0, labels: [], costRows: [], buyerTotalCents: 4800, expectedWaitingReason: "not_shipped" },
] satisfies FinanceFixtureOrder[]);

/** The ledger rows the variants change, by what they are. */
export const FIXTURE_LEDGER_REFERENCES = Object.freeze({
  /** V12's card deposit (chargedCents 10,300, cardFeeCents 300). */
  cardDeposit: { referenceType: "stripe_payment_intent", referenceId: "pi_card_10000" },
  /** V12's open ACH dispute dp_2 (disputeAmountCents 2,000). */
  openDispute: { referenceType: "stripe_dispute", referenceId: "dp_2" },
});

/**
 * Eastern wall-clock text for an instant: oms_orders.ordered_at and
 * cancelled_at are naive Eastern timestamps (contract §2.9 Q9).
 */
export function easternWallClock(instant: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

const minutesBefore = (instant: string, minutes: number) => new Date(new Date(instant).getTime() - minutes * 60_000).toISOString();

/** The balance-moving entry types (AVAILABLE_TYPES_SQL, recon 1). */
const AVAILABLE_TYPES: ReadonlySet<string> = new Set([
  "funding", "order_debit", "advance_fee", "funding_reversal", "funding_reinstated", "return_credit",
  "insurance_pool_credit", "return_fee", "refund_credit", "manual_adjustment",
]);

interface LedgerOptions {
  readonly status?: "pending" | "settled" | "failed";
  /** For deposits: when the money settled; defaults to created_at for settled rows, null otherwise. */
  readonly settledAt?: string | null;
  readonly reference?: { readonly referenceType: string; readonly referenceId: string };
  readonly fundingMethodId?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

class FixtureBuilder {
  readonly rows: FinanceFixtureRow[] = [];
  private readonly ledger: Array<Record<string, unknown>> = [];
  private nextLedgerId = 1;

  add(table: FinanceFixtureTable, row: Readonly<Record<string, unknown>>): void {
    this.rows.push({ table, row });
  }

  /** One wallet ledger row; returns its id. */
  led(vendorId: VendorId, type: string, amountCents: number, createdAt: string, options: LedgerOptions = {}): number {
    const id = this.nextLedgerId++;
    const status = options.status ?? "settled";
    this.ledger.push({
      id,
      wallet_account_id: WALLET_OF[vendorId],
      vendor_id: vendorId,
      type,
      status,
      amount_cents: amountCents,
      reference_type: options.reference?.referenceType ?? null,
      reference_id: options.reference?.referenceId ?? null,
      funding_method_id: options.fundingMethodId ?? null,
      metadata: options.metadata ?? {},
      created_at: createdAt,
      settled_at: options.settledAt !== undefined ? options.settledAt : status === "settled" ? createdAt : null,
    });
    return id;
  }

  order(order: FinanceFixtureOrder): void {
    const econId = order.intakeId - 1000;
    const omsOrderId = 5000 + econId;
    const wmsOrderId = 7000 + econId;
    const wholesale = order.lines.reduce((sum, line) => sum + line.packs * line.unitCents, 0);
    const shipping = order.quote.base + order.quote.markup + order.quote.pool;
    const billed = wholesale + shipping;
    if (order.paidCash + order.paidPoints !== billed) throw new Error(`Fixture order ${order.key} is not paid in full.`);
    const packs = order.lines.reduce((sum, line) => sum + line.packs, 0);

    this.add("dropship.dropship_order_intake", {
      id: order.intakeId, channel_id: DROPSHIP_CHANNEL_ID, vendor_id: order.vendorId, status: "accepted", cancellation_status: null,
      normalized_payload: {
        totals: order.buyerTotalCents === null ? {} : { grandTotalCents: order.buyerTotalCents },
        lines: order.lines.map((line) => ({ quantity: line.packs })),
      },
      oms_order_id: omsOrderId, received_at: minutesBefore(order.acceptedAt, 5), accepted_at: order.acceptedAt,
    });
    this.add("dropship.dropship_shipping_quote_snapshots", {
      id: econId, base_rate_cents: order.quote.base, markup_cents: order.quote.markup, dunnage_cents: 0,
      insurance_pool_cents: order.quote.pool, total_shipping_cents: shipping,
    });
    this.add("dropship.dropship_order_economics_snapshots", {
      id: econId, intake_id: order.intakeId, oms_order_id: omsOrderId, vendor_id: order.vendorId, store_connection_id: STORE_CONNECTION_ID,
      shipping_quote_snapshot_id: econId, wholesale_subtotal_cents: wholesale, shipping_cents: shipping,
      insurance_pool_cents: order.quote.pool, fees_cents: 0, total_debit_cents: billed,
      pricing_snapshot: { wholesale: { lines: order.lines.map((line) => ({ quantity: line.packs, wholesaleLineTotalCents: line.packs * line.unitCents })) } },
      created_at: order.acceptedAt,
    });
    this.add("oms.oms_orders", {
      id: omsOrderId, channel_id: DROPSHIP_CHANNEL_ID, status: order.cancelledInOms ? "cancelled" : "open", financial_status: "paid",
      subtotal_cents: wholesale, shipping_cents: shipping, tax_cents: 0, discount_cents: 0, total_cents: billed,
      ordered_at: easternWallClock(order.acceptedAt),
      cancelled_at: order.cancelledInOms ? easternWallClock("2026-10-03T12:00:00.000Z") : null,
    });
    this.add("wms.orders", { id: wmsOrderId, source: "oms", oms_fulfillment_order_id: String(omsOrderId) });
    order.lines.forEach((line, lineIndex) => {
      const lineId = omsOrderId * 10 + lineIndex;
      const itemId = wmsOrderId * 10 + lineIndex;
      this.add("oms.oms_order_lines", {
        id: lineId, order_id: omsOrderId, product_variant_id: line.variantId, sku: line.sku, quantity: line.packs,
        total_price_cents: line.packs * line.unitCents,
      });
      this.add("wms.order_items", { id: itemId, order_id: wmsOrderId, oms_order_line_id: lineId, picked_quantity: order.shippedPacks });
      order.costRows.forEach((cost, costIndex) => {
        const totalMills = cost.packs * cost.unitMills;
        this.add("oms.order_item_costs", {
          id: itemId * 10 + costIndex, order_id: wmsOrderId, order_item_id: itemId, inventory_lot_id: INVENTORY_LOT_ID, qty: cost.packs,
          unit_cost_mills: cost.unitMills, total_cost_mills: totalMills,
          // The cents columns are derived display mirrors (oms.schema.ts); the SQL reads the mills.
          unit_cost_cents: Number(signedMillsToCents(BigInt(cost.unitMills))),
          total_cost_cents: Number(signedMillsToCents(BigInt(totalMills))),
        });
      });
    });
    order.labels.forEach((shipmentLabel, labelIndex) => {
      const packageId = wmsOrderId * 10 + labelIndex;
      this.add("wms.outbound_shipments", {
        id: packageId, order_id: wmsOrderId, status: "shipped", shipment_purpose: shipmentLabel.purpose,
        external_fulfillment_id: shipmentLabel.externalId,
        // A label with no cost keeps the column default (0) and no source, as the capture check allows.
        ...(shipmentLabel.costCents === null
          ? {}
          : { carrier_cost_cents: shipmentLabel.costCents, carrier_cost_source: "shipstation", carrier_cost_recorded_at: order.acceptedAt }),
      });
      if (labelIndex === 0 && order.shippedPacks > 0) {
        this.add("wms.outbound_shipment_items", {
          id: packageId * 10, shipment_id: packageId, order_item_id: wmsOrderId * 10, qty: order.shippedPacks,
          shipment_item_purpose: "customer_fulfillment",
        });
      }
    });
    if (packs <= 0) throw new Error(`Fixture order ${order.key} has no packs.`);

    const intake = String(order.intakeId);
    if (order.paidCash > 0) {
      this.led(order.vendorId, "order_debit", -order.paidCash, order.acceptedAt, {
        reference: { referenceType: "order_intake", referenceId: intake },
        metadata: order.advanceFeeCents ? { advance: { feeCents: order.advanceFeeCents } } : {},
      });
    }
    if (order.paidPoints > 0) {
      this.led(order.vendorId, "rewards_spent", -order.paidPoints, order.acceptedAt, {
        reference: { referenceType: "order_intake_rewards", referenceId: intake },
      });
    }
    if (order.advanceFeeCents) {
      this.led(order.vendorId, "advance_fee", -order.advanceFeeCents, order.acceptedAt, {
        reference: { referenceType: "order_intake_advance_fee", referenceId: intake },
      });
    }
  }

  /** The wallet accounts, equal to the seeded ledger (contract §6.4 "seed wallet accounts equal to these sums"). */
  finish(): FinanceFixtureRow[] {
    for (const row of this.ledger) this.add("dropship.dropship_wallet_ledger", row);
    for (const vendorId of Object.values(FIXTURE_VENDORS)) {
      const mine = this.ledger.filter((row) => row.vendor_id === vendorId);
      const sum = (keep: (row: Record<string, unknown>) => boolean) =>
        mine.filter(keep).reduce((total, row) => total + (row.amount_cents as number), 0);
      this.add("dropship.dropship_wallet_accounts", {
        id: WALLET_OF[vendorId], vendor_id: vendorId,
        available_balance_cents: sum((row) => row.status === "settled" && AVAILABLE_TYPES.has(row.type as string)),
        pending_balance_cents: sum((row) => row.type === "funding" && row.status === "pending"),
        rewards_balance_cents: sum((row) => row.status === "settled" && String(row.type).startsWith("rewards_")),
      });
    }
    return this.rows;
  }
}

const stripe = (referenceId: string) => ({ referenceType: "stripe_payment_intent", referenceId });
const rewardsFor = (fundingLedgerId: number) => ({ referenceType: "wallet_funding_rewards", referenceId: String(fundingLedgerId) });

function seedCatalog(fixture: FixtureBuilder): void {
  for (const [id, businessName, contactName, status] of [
    [12, "Acme TCG", "A. Person", "active"], [13, "PackRat", null, "active"], [14, null, null, "paused"],
  ] as const) {
    fixture.add("dropship.dropship_vendors", { id, business_name: businessName, contact_name: contactName, status });
  }
  fixture.add("catalog.products", { id: 201, name: "Toploaders" });
  fixture.add("catalog.products", { id: 202, name: "Penny sleeves" });
  fixture.add("catalog.product_variants", { id: VARIANT.toploaders, product_id: 201, sku: "TL-25", name: "25 pack", units_per_variant: 25 });
  fixture.add("catalog.product_variants", { id: VARIANT.pennySleeves, product_id: 202, sku: "PS-100", name: "100 pack", units_per_variant: 100 });
  fixture.add("inventory.inventory_lots", { id: INVENTORY_LOT_ID });
  for (const [id, rail] of [[1, "stripe_ach"], [2, "stripe_card"], [3, "stripe_ach"], [4, "usdc_base"], [5, "stripe_ach"]] as const) {
    fixture.add("dropship.dropship_funding_methods", { id, rail });
  }
}

/** V12's money besides its orders (contract §6.4 "Ledger" V12). */
function seedAcmeLedger(fixture: FixtureBuilder): { readonly noInspectionCredit: number } {
  const ach8000 = fixture.led(12, "funding", 8000, "2026-07-29T12:00:00.000Z", {
    settledAt: "2026-08-01T12:00:00.000Z", fundingMethodId: 1, reference: stripe("pi_ach_8000"), metadata: { rail: "stripe_ach" },
  });
  fixture.led(12, "rewards_earned", 80, "2026-08-01T12:00:00.000Z", {
    reference: rewardsFor(ach8000), metadata: { rail: "stripe_ach", creditAmountCents: 8000, rateBps: 100 },
  });
  const ach300k = fixture.led(12, "funding", 300_000, "2026-08-29T12:00:00.000Z", {
    settledAt: "2026-09-02T14:00:00.000Z", fundingMethodId: 1, reference: stripe("pi_ach_300000"), metadata: { rail: "stripe_ach" },
  });
  fixture.led(12, "rewards_earned", 3000, "2026-09-02T14:00:00.000Z", {
    reference: rewardsFor(ach300k), metadata: { rail: "stripe_ach", creditAmountCents: 300_000, rateBps: 100 },
  });
  fixture.led(12, "rewards_expired", -80, "2026-10-01T05:00:00.000Z", { reference: { referenceType: "wallet_rewards_lot_expiry", referenceId: "1:1" } });
  const ach50k = fixture.led(12, "funding", 50_000, "2026-09-28T12:00:00.000Z", {
    settledAt: "2026-10-01T12:00:00.000Z", fundingMethodId: 1, reference: stripe("pi_ach_50000"), metadata: { rail: "stripe_ach" },
  });
  fixture.led(12, "rewards_earned", 500, "2026-10-01T12:00:00.000Z", {
    reference: rewardsFor(ach50k), metadata: { rail: "stripe_ach", creditAmountCents: 50_000, rateBps: 100 },
  });
  const card = fixture.led(12, "funding", 10_000, "2026-10-02T10:00:00.000Z", {
    fundingMethodId: 2, reference: FIXTURE_LEDGER_REFERENCES.cardDeposit,
    metadata: { rail: "stripe_card", chargedCents: 10_300, cardFeeCents: 300 },
  });
  const noInspectionCredit = fixture.led(12, "insurance_pool_credit", 1100, "2026-10-03T20:00:00.000Z", {
    reference: { referenceType: "dropship_rma_no_inspection", referenceId: "303" },
  });
  fixture.led(12, "return_credit", 1200, "2026-10-04T13:00:00.000Z", { reference: { referenceType: "dropship_rma", referenceId: "301:credit" } });
  fixture.led(12, "return_fee", -300, "2026-10-04T13:00:00.000Z", { reference: { referenceType: "dropship_rma", referenceId: "301:fee" } });
  // A staff credit: a deposit whose rail is manual.
  fixture.led(12, "funding", 2500, "2026-10-04T15:00:00.000Z", { metadata: { rail: "manual" } });
  const cardReversal = fixture.led(12, "funding_reversal", -10_000, "2026-10-04T18:00:00.000Z", {
    reference: { referenceType: "stripe_dispute", referenceId: "dp_1" }, fundingMethodId: 2,
    metadata: {
      disputeAmountCents: 10_300, creditAmountCents: 10_000, fundingLedgerEntryId: card, rail: "stripe_card",
      rewardsClawback: { fromCashCents: 0, fromRewardsCents: 0 },
    },
  });
  fixture.led(12, "funding_reinstated", 10_000, "2026-10-05T09:00:00.000Z", {
    reference: { referenceType: "stripe_dispute_reinstated", referenceId: "dp_1" }, metadata: { reversalLedgerEntryId: cardReversal },
  });
  fixture.led(12, "funding_reversal", -2000, "2026-10-05T10:00:00.000Z", {
    reference: FIXTURE_LEDGER_REFERENCES.openDispute, fundingMethodId: 1,
    metadata: {
      disputeAmountCents: 2000, creditAmountCents: 50_000, fundingLedgerEntryId: ach50k, rail: "stripe_ach",
      rewardsClawback: { fromCashCents: 0, fromRewardsCents: 20 },
    },
  });
  fixture.led(12, "rewards_reversed", -20, "2026-10-05T10:00:00.000Z", { reference: { referenceType: "stripe_dispute_rewards", referenceId: "dp_2" } });
  return { noInspectionCredit };
}

/** V13's and V14's money besides their orders (contract §6.4 "Ledger" V13, V14). */
function seedPackRatAndV14Ledger(fixture: FixtureBuilder): { readonly collection: number; readonly usdc: number } {
  fixture.led(13, "funding", 7000, "2026-10-01T15:00:00.000Z", {
    status: "failed", settledAt: null, fundingMethodId: 3, reference: stripe("pi_ach_failed_7000"),
    metadata: { rail: "stripe_ach", failure: { failedAt: "2026-10-03T10:00:00.000Z", code: "R01" } },
  });
  // The weekly collection names no rail; its funding method says stripe_ach.
  const collection = fixture.led(13, "funding", 5000, "2026-10-02T08:00:00.000Z", {
    fundingMethodId: 3, reference: stripe("pi_collection_5000"), metadata: { collection: true },
  });
  const usdc = fixture.led(13, "funding", 25_000, "2026-10-03T09:00:00.000Z", {
    fundingMethodId: 4, reference: { referenceType: "usdc_base_transaction", referenceId: "0xabc:0" },
    metadata: { rail: "usdc_base", source: "chain_watcher" },
  });
  fixture.led(13, "rewards_earned", 250, "2026-10-03T09:00:00.000Z", {
    reference: rewardsFor(usdc), metadata: { rail: "usdc_base", creditAmountCents: 25_000, rateBps: 100 },
  });
  // Carrier-fault RMA r2 for order I: a pool credit with no fee and no pool row.
  fixture.led(13, "insurance_pool_credit", 600, "2026-10-04T20:00:00.000Z", { reference: { referenceType: "dropship_rma", referenceId: "302:credit" } });
  fixture.led(13, "funding", 15_000, "2026-10-04T21:00:00.000Z", {
    status: "pending", settledAt: null, fundingMethodId: 3, reference: stripe("pi_ach_15000"), metadata: { rail: "stripe_ach" },
  });
  fixture.led(13, "return_credit", 800, "2026-10-05T11:00:00.000Z", { reference: { referenceType: "return_case_vendor_settlement", referenceId: "501:credit" } });
  fixture.led(13, "return_fee", -150, "2026-10-05T11:00:00.000Z", { reference: { referenceType: "return_case_vendor_settlement", referenceId: "501:fee" } });
  fixture.led(14, "return_fee", -1250, "2026-08-20T12:00:00.000Z", { reference: { referenceType: "dropship_rma", referenceId: "304:fee" } });
  fixture.led(14, "funding", 4000, "2026-09-20T12:00:00.000Z", {
    status: "pending", settledAt: null, fundingMethodId: 5, reference: stripe("pi_ach_4000"), metadata: { rail: "stripe_ach" },
  });
  return { collection, usdc };
}

function seedReturnsPoolAndIntakes(fixture: FixtureBuilder, ids: { noInspectionCredit: number; collection: number; usdc: number }): void {
  for (const [id, walletAccountId, remaining, expiresAt] of [
    [1, 1, 0, "2026-10-01T05:00:00.000Z"], [2, 1, 1280, null], [3, 1, 0, "2026-12-30T12:00:00.000Z"], [4, 2, 250, "2027-01-01T12:00:00.000Z"],
  ] as const) {
    fixture.add("dropship.dropship_wallet_rewards_lots", { id, wallet_account_id: walletAccountId, remaining_cents: remaining, expires_at: expiresAt });
  }
  // 250,004,321 atomic units: 25,000 whole cents (USDC has 6 decimals) plus dust.
  fixture.add("dropship.dropship_usdc_ledger_entries", {
    id: 1, vendor_id: 13, wallet_ledger_id: ids.usdc, chain_id: USDC_BASE_CHAIN_ID, transaction_hash: "0xABC", log_index: 0,
    amount_atomic_units: "250004321", status: "settled",
  });
  fixture.add("dropship.dropship_collection_attempts", { id: 1, vendor_id: 13, amount_cents: 5000, status: "succeeded", wallet_ledger_entry_id: ids.collection });
  for (const [id, vendorId, intakeId] of [[301, 12, 1001], [302, 13, 1008], [303, 12, 1009], [304, 14, null]] as const) {
    fixture.add("dropship.dropship_rmas", { id, vendor_id: vendorId, intake_id: intakeId });
  }
  fixture.add("dropship.dropship_rma_inspections", {
    id: 1, rma_id: 301, credit_cents: 1200, fee_cents: 300, created_at: "2026-10-04T13:00:00.000Z",
    fee_breakdown: { fees: { restocking: { chargedCents: 200 }, processing: { chargedCents: 100 } } },
  });
  fixture.add("dropship.dropship_rma_inspections", { id: 2, rma_id: 302, credit_cents: 600, fee_cents: 0, fee_breakdown: { fees: {} }, created_at: "2026-10-04T20:00:00.000Z" });
  fixture.add("returns.return_cases", { id: 401, oms_order_id: 5003 });
  fixture.add("returns.return_case_vendor_settlements", {
    id: 501, return_case_id: 401, vendor_id: 13, gross_credit_cents: 800, total_fee_cents: 150, restocking_fee_cents: 150,
    processing_fee_cents: 0, return_shipping_fee_cents: 0, created_at: "2026-10-05T11:00:00.000Z",
  });
  fixture.add("dropship.dropship_insurance_pool_ledger", {
    id: 1, entry_type: "no_inspection_payout", amount_cents: -1100, wallet_ledger_entry_id: ids.noInspectionCredit, created_at: "2026-10-03T20:00:00.000Z",
  });
  fixture.add("dropship.dropship_insurance_pool_ledger", {
    id: 2, entry_type: "claim_replenishment", amount_cents: 300, wallet_ledger_entry_id: null, created_at: "2026-10-05T08:00:00.000Z",
  });
  fixture.add("dropship.dropship_carrier_claims", { id: 601, intake_id: 1004, status: "pending_approval", calculated_credit_cents: 900, created_at: "2026-10-04T10:00:00.000Z" });

  // Received in the month and never charged: a payment hold, an expired hold whose OMS order is still pending, a rejection.
  fixture.add("dropship.dropship_order_intake", {
    id: 1101, channel_id: DROPSHIP_CHANNEL_ID, vendor_id: 12, status: "payment_hold", cancellation_status: null,
    normalized_payload: { totals: { grandTotalCents: 3000 } }, oms_order_id: null, received_at: "2026-10-03T10:00:00.000Z", accepted_at: null,
  });
  fixture.add("dropship.dropship_audit_events", {
    id: 1, entity_type: "dropship_order_intake", entity_id: "1101", event_type: "order_acceptance_payment_hold",
    payload: { totalDebitCents: 2500 }, created_at: "2026-10-03T10:01:00.000Z",
  });
  fixture.add("oms.oms_orders", {
    id: 5101, channel_id: DROPSHIP_CHANNEL_ID, status: "pending", financial_status: "pending", subtotal_cents: 1200, shipping_cents: 600,
    tax_cents: 0, discount_cents: 0, total_cents: 1800, ordered_at: easternWallClock("2026-10-02T10:00:00.000Z"), cancelled_at: null,
  });
  fixture.add("dropship.dropship_order_intake", {
    id: 1102, channel_id: DROPSHIP_CHANNEL_ID, vendor_id: 13, status: "cancelled", cancellation_status: "payment_hold_expired",
    normalized_payload: { totals: { grandTotalCents: 2200 } }, oms_order_id: 5101, received_at: "2026-10-02T10:00:00.000Z", accepted_at: null,
  });
  fixture.add("dropship.dropship_order_intake", {
    id: 1103, channel_id: DROPSHIP_CHANNEL_ID, vendor_id: 12, status: "rejected", cancellation_status: null,
    normalized_payload: { totals: { grandTotalCents: 900 } }, oms_order_id: null, received_at: "2026-10-04T10:00:00.000Z", accepted_at: null,
  });
}

export interface FinanceFixtureOptions {
  /** Adds FINANCE_DST_ORDERS (and their debits) to the program. */
  readonly dstOrders?: boolean;
}

/** Every row of the §6.4 program, in an order the inserts can follow. */
export function buildFinanceFixture(options: FinanceFixtureOptions = {}): readonly FinanceFixtureRow[] {
  const fixture = new FixtureBuilder();
  seedCatalog(fixture);
  for (const order of FINANCE_FIXTURE_ORDERS) fixture.order(order);
  if (options.dstOrders) for (const order of FINANCE_DST_ORDERS) fixture.order(order);
  const acme = seedAcmeLedger(fixture);
  const packRat = seedPackRatAndV14Ledger(fixture);
  seedReturnsPoolAndIntakes(fixture, { ...acme, ...packRat });
  return fixture.finish();
}

/** One parameterized INSERT per row; JSON objects are sent as JSON text for the jsonb columns. */
export function financeFixtureInsert(entry: FinanceFixtureRow): { readonly text: string; readonly values: unknown[] } {
  const columns = Object.keys(entry.row);
  if (columns.some((column) => !/^[a-z_]+$/.test(column))) throw new Error("Invalid fixture column name.");
  const values = columns.map((column) => {
    const value = entry.row[column];
    return value !== null && typeof value === "object" ? JSON.stringify(value) : value;
  });
  return {
    text: `INSERT INTO ${entry.table} (${columns.join(", ")}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(", ")})`,
    values,
  };
}
