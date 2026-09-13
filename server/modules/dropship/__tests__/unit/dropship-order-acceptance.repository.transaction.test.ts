/**
 * Transaction-level tests for PgDropshipOrderAcceptanceRepository.
 *
 * A stubbed pg client answers every statement of the acceptance transaction so
 * the real repository code runs end to end: the wallet debit must equal the
 * `.ops` product cost times quantity plus shipping, the economics snapshot and
 * ledger row must carry the cost provenance, and an unavailable cost must roll
 * the whole transaction back before any financial write.
 */

import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";

import type { DropshipProductCost, DropshipProductCostReader } from "../../application/dropship-product-cost";
import type { DropshipOrderAcceptanceInput } from "../../application/dropship-order-acceptance-service";
import { PgDropshipOrderAcceptanceRepository } from "../../infrastructure/dropship-order-acceptance.repository";

const ACCEPTED_AT = new Date("2026-09-12T15:00:00.000Z");
const VARIANT_ID = 66;
const UNIT_COST_CENTS = 809;
const SHIPPING_CENTS = 1122;
const WALLET_BALANCE_CENTS = 100_000;

interface QueryCall { sql: string; params: unknown[] }

type RowHandler = { match: string; rows: unknown[] | ((params: unknown[]) => unknown[]) };

function createFakeDb(handlers: RowHandler[]) {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    const handler = handlers.find((candidate) => sql.includes(candidate.match));
    if (!handler) throw new Error(`Unexpected statement in acceptance transaction: ${sql.trim().slice(0, 90)}`);
    const rows = typeof handler.rows === "function" ? handler.rows(params) : handler.rows;
    return { rows, rowCount: rows.length };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const statements = (fragment: string) => calls.filter((call) => call.sql.includes(fragment));
  return { pool, client, calls, statements };
}

function intakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    channel_id: 103,
    vendor_id: 10,
    store_connection_id: 22,
    platform: "ebay",
    external_order_id: "EBAY-ORDER-1",
    external_order_number: "10-01",
    status: "received",
    payment_hold_expires_at: null,
    normalized_payload: {
      lines: [{ productVariantId: VARIANT_ID, quantity: 2, sku: "ARM-ENV-SGL-P50", externalLineItemId: "li-1", title: "Armalope Envelope" }],
      shipTo: { name: "Buyer", address1: "1 Main St", city: "Pittsburgh", region: "PA", postalCode: "16046", country: "US" },
      orderedAt: "2026-09-12T14:00:00.000Z",
      buyerShippingServiceCode: "USPSPriority",
    },
    raw_payload: {},
    oms_order_id: null,
    ...overrides,
  };
}

function baseHandlers(overrides: Partial<Record<string, RowHandler>> = {}): RowHandler[] {
  const defaults: Record<string, RowHandler> = {
    intake: { match: "FROM dropship.dropship_order_intake", rows: [intakeRow()] },
    vendor: {
      match: "FROM dropship.dropship_vendors v",
      rows: [{
        vendor_id: 10, member_id: "member-1", current_plan_id: "plan-ops", membership_plan_id: "plan-ops",
        membership_plan_tier: "ops", vendor_status: "active", entitlement_status: "active",
        store_connection_id: 22, store_platform: "ebay", store_status: "connected", setup_status: "ready",
        access_token_ref: "vault:access", refresh_token_ref: "vault:refresh",
      }],
    },
    quote: {
      match: "FROM dropship.dropship_shipping_quote_snapshots",
      rows: [{
        id: 33, vendor_id: 10, store_connection_id: 22, warehouse_id: 1, currency: "USD",
        destination_country: "US", destination_postal_code: "16046", package_count: 1,
        total_shipping_cents: SHIPPING_CENTS, insurance_pool_cents: 0,
        quote_payload: { items: [{ productVariantId: VARIANT_ID, quantity: 2 }] },
      }],
    },
    listings: {
      match: "FROM dropship.dropship_vendor_listings dl",
      rows: [{
        listing_id: 501, vendor_id: 10, store_connection_id: 22, product_id: 7, product_variant_id: VARIANT_ID,
        product_line_ids: [], listing_status: "active", external_listing_id: "L1", external_offer_id: "O1",
        vendor_retail_price_cents: 1152, product_sku: "ARM-ENV", variant_sku: "ARM-ENV-SGL-P50",
        product_name: "Armalope Envelope", variant_name: "Pack of 50", category: "supplies",
        product_is_active: true, variant_is_active: true, sales_eligibility: "sellable", dropship_eligible: true,
        catalog_retail_price_cents: 899,
      }],
    },
    policies: { match: "FROM dropship.dropship_pricing_policies", rows: [] },
    inventory: {
      match: "FROM inventory.inventory_levels il",
      rows: [{ id: 1, warehouse_location_id: 5, product_variant_id: VARIANT_ID, variant_qty: 10, reserved_qty: 0, picked_qty: 0, packed_qty: 0 }],
    },
    walletInsert: { match: "INSERT INTO dropship.dropship_wallet_accounts", rows: [] },
    walletSelect: {
      match: "FROM dropship.dropship_wallet_accounts",
      rows: [{ id: 1, vendor_id: 10, available_balance_cents: WALLET_BALANCE_CENTS, pending_balance_cents: 0, currency: "USD", status: "active" }],
    },
    holdTimeout: { match: "FROM dropship.dropship_auto_reload_settings", rows: [] },
    omsOrder: { match: "INSERT INTO oms.oms_orders", rows: [{ id: 1001 }] },
    omsEvent: { match: "INSERT INTO oms.oms_order_events", rows: [] },
    omsLines: { match: "INSERT INTO oms.oms_order_lines", rows: [{ id: 2001, product_variant_id: VARIANT_ID, quantity: 2 }] },
    walletUpdate: { match: "UPDATE dropship.dropship_wallet_accounts", rows: [] },
    ledger: { match: "INSERT INTO dropship.dropship_wallet_ledger", rows: [{ id: 77 }] },
    audit: { match: "INSERT INTO dropship.dropship_audit_events", rows: [] },
    snapshot: { match: "INSERT INTO dropship.dropship_order_economics_snapshots", rows: [{ id: 55 }] },
    intakeUpdate: { match: "UPDATE dropship.dropship_order_intake", rows: [] },
    existingSnapshot: { match: "FROM dropship.dropship_order_economics_snapshots", rows: [] },
    existingLedger: { match: "FROM dropship.dropship_wallet_ledger", rows: [] },
  };
  return Object.values({ ...defaults, ...overrides });
}

function acceptanceInput(): DropshipOrderAcceptanceInput {
  return {
    intakeId: 1,
    vendorId: 10,
    storeConnectionId: 22,
    shippingQuoteSnapshotId: 33,
    idempotencyKey: "accept-order-0001",
    actor: { actorType: "vendor", actorId: "member-1" },
    requestHash: "a".repeat(64),
    acceptedAt: ACCEPTED_AT,
  };
}

function availableCost(overrides: Partial<DropshipProductCost> = {}): DropshipProductCost {
  return {
    status: "available",
    unitCostCents: UNIT_COST_CENTS,
    planId: "plan-ops",
    source: "variant_fixed_price",
    overrideId: "override-1",
    issue: null,
    ...overrides,
  };
}

function costReader(cost: DropshipProductCost | undefined) {
  const loadProductCosts = vi.fn(async () => new Map(cost ? [[VARIANT_ID, cost]] : []));
  const reader: DropshipProductCostReader = { loadProductCosts };
  return { reader, loadProductCosts };
}

function createRepository(db: ReturnType<typeof createFakeDb>, cost: DropshipProductCost | undefined) {
  const { reader, loadProductCosts } = costReader(cost);
  const productCostReaderForTransaction = vi.fn(() => reader);
  const repository = new PgDropshipOrderAcceptanceRepository(db.pool, { productCostReaderForTransaction });
  return { repository, loadProductCosts, productCostReaderForTransaction };
}

describe("PgDropshipOrderAcceptanceRepository (transaction)", () => {
  it("debits the wallet by the .ops cost times quantity plus shipping and freezes the provenance", async () => {
    const db = createFakeDb(baseHandlers());
    const { repository, loadProductCosts, productCostReaderForTransaction } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    const expectedDebit = UNIT_COST_CENTS * 2 + SHIPPING_CENTS;
    expect(result).toMatchObject({
      outcome: "accepted",
      omsOrderId: 1001,
      walletLedgerEntryId: 77,
      economicsSnapshotId: 55,
      totalDebitCents: expectedDebit,
      idempotentReplay: false,
    });

    // The cost reader is bound to the transaction's own client and asked only for the matched variant.
    expect(productCostReaderForTransaction).toHaveBeenCalledWith(db.client);
    expect(loadProductCosts).toHaveBeenCalledWith({ vendorId: 10, productVariantIds: [VARIANT_ID] });

    // No partner-profile discount participates in a live order.
    expect(db.calls.some((call) => call.sql.includes("partner_profiles"))).toBe(false);

    const [walletUpdate] = db.statements("UPDATE dropship.dropship_wallet_accounts");
    expect(walletUpdate.params[2]).toBe(WALLET_BALANCE_CENTS - expectedDebit);

    const [ledger] = db.statements("INSERT INTO dropship.dropship_wallet_ledger");
    expect(ledger.params[2]).toBe(-expectedDebit);
    const ledgerMetadata = JSON.parse(String(ledger.params[8]));
    expect(ledgerMetadata).toMatchObject({
      wholesaleSubtotalCents: UNIT_COST_CENTS * 2,
      shippingCents: SHIPPING_CENTS,
      pricingSnapshotVersion: 2,
      costAuthority: "shellz_club_ops_product_cost",
    });
    expect(ledgerMetadata.costEvidenceHash).toMatch(/^[0-9a-f]{64}$/);

    const [snapshot] = db.statements("INSERT INTO dropship.dropship_order_economics_snapshots");
    expect(snapshot.params[10]).toBe(UNIT_COST_CENTS * 2);
    expect(snapshot.params[14]).toBe(expectedDebit);
    const pricingSnapshot = JSON.parse(String(snapshot.params[15]));
    expect(pricingSnapshot).toMatchObject({
      version: 2,
      requestHash: "a".repeat(64),
      wholesale: {
        authority: "shellz_club_ops_product_cost",
        costResolvedAt: ACCEPTED_AT.toISOString(),
        costEvidenceHash: ledgerMetadata.costEvidenceHash,
        lines: [{
          productVariantId: VARIANT_ID,
          quantity: 2,
          catalogRetailPriceCents: 899,
          wholesaleUnitCostCents: UNIT_COST_CENTS,
          wholesaleLineTotalCents: UNIT_COST_CENTS * 2,
          costSource: "variant_fixed_price",
          costPlanId: "plan-ops",
          costOverrideId: "override-1",
        }],
      },
    });
    expect(JSON.stringify(pricingSnapshot)).not.toContain("channelDiscountPercent");

    // The buyer's paid marketplace shipping service survives acceptance on the OMS order.
    const [omsOrder] = db.statements("INSERT INTO oms.oms_orders");
    const omsRawPayload = JSON.parse(String(omsOrder.params[18]));
    expect(omsRawPayload.dropship).toMatchObject({
      intakeId: 1,
      vendorId: 10,
      storeConnectionId: 22,
      externalOrderId: "EBAY-ORDER-1",
      buyerShippingServiceCode: "USPSPriority",
    });

    // OMS lines carry the same unit cost as paid price.
    const [omsLine] = db.statements("INSERT INTO oms.oms_order_lines");
    expect(omsLine.params[7]).toBe(UNIT_COST_CENTS);
    expect(omsLine.params[8]).toBe(UNIT_COST_CENTS * 2);

    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("rolls back before any financial write when the .ops cost is unavailable", async () => {
    const db = createFakeDb(baseHandlers());
    const { repository } = createRepository(db, {
      status: "unavailable", unitCostCents: null, planId: "plan-ops", source: null, overrideId: null, issue: "plan_unavailable",
    });

    await expect(repository.acceptOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE",
      context: { productVariantId: VARIANT_ID, issue: "plan_unavailable", retryable: false, planId: "plan-ops" },
    });

    expect(db.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(db.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    for (const fragment of [
      "UPDATE dropship.dropship_wallet_accounts",
      "INSERT INTO dropship.dropship_wallet_ledger",
      "INSERT INTO oms.oms_orders",
      "INSERT INTO dropship.dropship_order_economics_snapshots",
      "UPDATE dropship.dropship_order_intake",
    ]) {
      expect(db.statements(fragment), fragment).toHaveLength(0);
    }
  });

  it("marks a failed cost source read as retryable and refuses a zero cost outright", async () => {
    const readFailed = createRepository(createFakeDb(baseHandlers()), {
      status: "unavailable", unitCostCents: null, planId: null, source: null, overrideId: null, issue: "source_read_failed",
    });
    await expect(readFailed.repository.acceptOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE",
      context: { retryable: true, issue: "source_read_failed" },
    });

    const zero = createRepository(createFakeDb(baseHandlers()), availableCost({ unitCostCents: 0 }));
    await expect(zero.repository.acceptOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PRODUCT_COST_ZERO",
      context: { retryable: false },
    });

    const missing = createRepository(createFakeDb(baseHandlers()), undefined);
    await expect(missing.repository.acceptOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PRODUCT_COST_UNAVAILABLE",
      context: { issue: "variant_unmapped", retryable: false },
    });
  });

  it("replays an accepted intake from its stored snapshot without re-reading cost", async () => {
    const db = createFakeDb(baseHandlers({
      intake: { match: "FROM dropship.dropship_order_intake", rows: [intakeRow({ status: "accepted", oms_order_id: 1001 })] },
      existingSnapshot: {
        match: "FROM dropship.dropship_order_economics_snapshots",
        rows: [{ id: 55, shipping_quote_snapshot_id: 33, total_debit_cents: 2740, currency: "USD", pricing_snapshot: { requestHash: "a".repeat(64) } }],
      },
      existingLedger: { match: "FROM dropship.dropship_wallet_ledger", rows: [{ id: 77 }] },
    }));
    const { repository, loadProductCosts } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "accepted", idempotentReplay: true, totalDebitCents: 2740, walletLedgerEntryId: 77 });
    expect(loadProductCosts).not.toHaveBeenCalled();
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
  });
});
