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
import { createFakeRewardsLots, type FakeRewardsLotsSeed } from "../fixtures/fake-rewards-lots";

const ACCEPTED_AT = new Date("2026-09-12T15:00:00.000Z");
const VARIANT_ID = 66;
const UNIT_COST_CENTS = 809;
const SHIPPING_CENTS = 1122;
const WALLET_BALANCE_CENTS = 100_000;

interface QueryCall { sql: string; params: unknown[] }

type RowHandler = { match: string; rows: unknown[] | ((params: unknown[]) => unknown[]) };

/** The lot tables (migration 0705) are answered by an in-memory stand-in, seeded per test when rewards are spent. */
function createFakeDb(handlers: RowHandler[], lotsSeed: FakeRewardsLotsSeed = {}) {
  const calls: QueryCall[] = [];
  const lots = createFakeRewardsLots(lotsSeed);
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    const lotAnswer = lots.handle(sql, params);
    if (lotAnswer) return { rows: lotAnswer.rows, rowCount: lotAnswer.rows.length };
    const handler = handlers.find((candidate) => sql.includes(candidate.match));
    if (!handler) throw new Error(`Unexpected statement in acceptance transaction: ${sql.trim().slice(0, 90)}`);
    const rows = typeof handler.rows === "function" ? handler.rows(params) : handler.rows;
    return { rows, rowCount: rows.length };
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const statements = (fragment: string) => calls.filter((call) => call.sql.includes(fragment));
  return { pool, client, calls, statements, lots };
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

function canonicalStageRow(overrides: Record<string, unknown> = {}) {
  return {
    intake_id: 1,
    oms_order_id: 1001,
    vendor_id: 10,
    store_connection_id: 22,
    shipping_quote_snapshot_id: 33,
    warehouse_id: 1,
    wallet_account_id: 1,
    state: "inventory_claimed",
    claim_attempt_number: 1,
    wms_order_id: 9001,
    request_hash: "a".repeat(64),
    submitted_idempotency_key: "accept-order-0001",
    actor_type: "vendor",
    actor_id: "member-1",
    member_id: "member-1",
    membership_plan_id: "plan-ops",
    currency: "USD",
    retail_subtotal_cents: 2304,
    wholesale_subtotal_cents: UNIT_COST_CENTS * 2,
    shipping_cents: SHIPPING_CENTS,
    insurance_pool_cents: 0,
    fees_cents: 0,
    total_debit_cents: UNIT_COST_CENTS * 2 + SHIPPING_CENTS,
    cost_evidence_hash: "b".repeat(64),
    pricing_snapshot: { version: 2, requestHash: "a".repeat(64) },
    prepared_at: ACCEPTED_AT,
    inventory_claimed_at: ACCEPTED_AT,
    inventory_release_requested_at: null,
    inventory_released_at: null,
    inventory_release_reason: null,
    expired_at: null,
    finalized_at: null,
    ...overrides,
  };
}

function canonicalClaimAttemptRow(overrides: Record<string, unknown> = {}) {
  return {
    intake_id: 1,
    attempt_number: 1,
    oms_order_id: 1001,
    wms_order_id: 9001,
    warehouse_id: 1,
    claim_authority: "canonical",
    claim_owner: "dropship_acceptance",
    claim_outcome: "claimed",
    availability_claim_id: "7001",
    state: "claimed",
    claimed_at: ACCEPTED_AT,
    release_requested_at: null,
    released_at: null,
    release_reason: null,
    expired_at: null,
    finalized_at: null,
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
        membership_plan_tier: "ops", vendor_status: "active", vendor_standing_reason: null, entitlement_status: "active",
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
    warehouseAllocation: {
      match: "FROM channels.channel_warehouse_assignments",
      rows: (params) => (params[0] === 103 && params[1] === 1 ? [{ warehouse_id: 1 }] : []),
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
      rows: [{ id: 1, vendor_id: 10, available_balance_cents: WALLET_BALANCE_CENTS, pending_balance_cents: 0, rewards_balance_cents: 0, currency: "USD", status: "active" }],
    },
    // The wallet policy table is absent by default, so the hold falls back to
    // the vendor row and then the documented default; a dedicated test covers
    // the policy-first path.
    policyTable: { match: "to_regclass('dropship.dropship_wallet_policies')", rows: [{ present: null }] },
    holdTimeout: { match: "FROM dropship.dropship_auto_reload_settings", rows: [] },
    // The pending-ACH advance reads (dropship-advance.reader.ts) probe their
    // relations by parameter. Absent by default, so nothing is advanced and the
    // hold rule is the plain balance check; the advance tests make them present.
    advanceTableProbe: { match: "to_regclass($1)", rows: () => [{ present: null }] },
    advancePolicy: { match: "SELECT advance_fee_bps, advance_cap_cents", rows: [] },
    creditProfile: { match: "SELECT advance_cap_override_cents", rows: [] },
    advanceSources: { match: "FROM dropship.dropship_funding_methods m", rows: [] },
    omsOrder: { match: "INSERT INTO oms.oms_orders", rows: [{ id: 1001 }] },
    omsEvent: { match: "INSERT INTO oms.oms_order_events", rows: [] },
    omsLines: { match: "INSERT INTO oms.oms_order_lines", rows: [{ id: 2001, product_variant_id: VARIANT_ID, quantity: 2 }] },
    walletUpdate: { match: "UPDATE dropship.dropship_wallet_accounts", rows: [] },
    ledger: { match: "INSERT INTO dropship.dropship_wallet_ledger", rows: [{ id: 77 }] },
    audit: { match: "INSERT INTO dropship.dropship_audit_events", rows: [] },
    snapshot: { match: "INSERT INTO dropship.dropship_order_economics_snapshots", rows: [{ id: 55 }] },
    intakeUpdate: { match: "UPDATE dropship.dropship_order_intake", rows: [] },
    stageSelect: { match: "FROM dropship.dropship_order_acceptance_stages", rows: [] },
    stageInsert: { match: "INSERT INTO dropship.dropship_order_acceptance_stages", rows: [] },
    stageUpdate: { match: "UPDATE dropship.dropship_order_acceptance_stages", rows: [] },
    claimAttemptSequence: { match: "SELECT COALESCE(MAX(attempt_number)", rows: [{ attempt_number: 1 }] },
    claimAttemptSelect: {
      match: "FROM dropship.dropship_order_acceptance_claim_attempts",
      rows: [canonicalClaimAttemptRow()],
    },
    claimAttemptInsert: { match: "INSERT INTO dropship.dropship_order_acceptance_claim_attempts", rows: [] },
    claimAttemptUpdate: { match: "UPDATE dropship.dropship_order_acceptance_claim_attempts", rows: [] },
    availabilityClaim: {
      match: "FROM inventory.availability_claims",
      rows: [{ id: "7001", order_id: 9001, status: "active" }],
    },
    wmsOrder: {
      match: "FROM wms.orders",
      rows: [{
        id: 9001,
        warehouse_id: 1,
        source: "oms",
        oms_fulfillment_order_id: "1001",
        fulfillment_partition_key: "default",
      }],
    },
    omsPromote: { match: "UPDATE oms.oms_orders", rows: [{ id: 1001 }] },
    existingSnapshot: { match: "FROM dropship.dropship_order_economics_snapshots", rows: [] },
    existingLedger: { match: "FROM dropship.dropship_wallet_ledger", rows: [] },
  };
  return Object.values({ ...defaults, ...overrides });
}

/** The advance relations present, with the launch policy (1% fee, $500 cap) and no vendor override. */
function advancePresent(): Partial<Record<string, RowHandler>> {
  return {
    advanceTableProbe: { match: "to_regclass($1)", rows: (params) => [{ present: String(params[0]) }] },
    advancePolicy: { match: "SELECT advance_fee_bps, advance_cap_cents", rows: [{ advance_fee_bps: 100, advance_cap_cents: 50_000 }] },
    creditProfile: { match: "SELECT advance_cap_override_cents", rows: [] },
  };
}

/** A company bank account with a verified balance, a settled earlier pull, and $500 pending. */
function eligibleSourceRow(overrides: Record<string, unknown> = {}) {
  return {
    funding_method_id: 100,
    metadata: { provider: "stripe", accountHolderType: "company", financialConnectionsAccountId: "fca_1" },
    pending_cents: "50000",
    prior_pull_settled: true,
    balance_verified: true,
    ...overrides,
  };
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

  it("accepts against pending ACH when the balance is short, posting the debit and the fee in one transaction", async () => {
    const db = createFakeDb(baseHandlers({
      ...advancePresent(),
      walletSelect: {
        match: "FROM dropship.dropship_wallet_accounts",
        rows: [{ id: 1, vendor_id: 10, available_balance_cents: 1_000, pending_balance_cents: 50_000, rewards_balance_cents: 0, currency: "USD", status: "active" }],
      },
      advanceSources: {
        match: "FROM dropship.dropship_funding_methods m",
        rows: (params) => {
          expect(params).toEqual([10, 1, "stripe_ach"]);
          return [eligibleSourceRow()];
        },
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    const expectedDebit = UNIT_COST_CENTS * 2 + SHIPPING_CENTS; // 2740
    const expectedAdvance = expectedDebit - 1_000; // 1740: the debit less the positive balance
    const expectedFee = 17; // 1% of 1740 = 17.4, rounded half up
    expect(result).toMatchObject({
      outcome: "accepted",
      totalDebitCents: expectedDebit,
      advance: { advanceCents: expectedAdvance, feeCents: expectedFee, feeBps: 100, feeLedgerEntryId: 77 },
    });

    // One balance write: the debit and the fee both come off available, which ends negative.
    const walletUpdates = db.statements("UPDATE dropship.dropship_wallet_accounts");
    expect(walletUpdates).toHaveLength(1);
    expect(walletUpdates[0].params[2]).toBe(1_000 - expectedDebit - expectedFee);

    const [orderDebit, advanceFee] = db.statements("INSERT INTO dropship.dropship_wallet_ledger");
    expect(orderDebit.sql).toContain("'order_debit'");
    expect(orderDebit.params[2]).toBe(-expectedDebit);
    expect(orderDebit.params[4]).toBe(1_000 - expectedDebit);
    expect(orderDebit.params[5]).toBe(50_000);
    expect(JSON.parse(String(orderDebit.params[8])).advance).toEqual({
      advanceCents: expectedAdvance,
      feeCents: expectedFee,
      feeBps: 100,
      capCents: 50_000,
      capSource: "policy",
      eligiblePendingCents: 50_000,
      exposureBeforeCents: 0,
      exposureAfterCents: expectedAdvance + expectedFee,
      fundingMethodIds: [100],
    });
    expect(advanceFee.sql).toContain("'advance_fee'");
    expect(advanceFee.sql).toContain("'order_intake_advance_fee'");
    expect(advanceFee.params[2]).toBe(-expectedFee);
    expect(advanceFee.params[4]).toBe(1_000 - expectedDebit - expectedFee);
    expect(String(advanceFee.params[7])).toMatch(/^order:1:[0-9a-f]{32}:advance-fee$/);
    expect(JSON.parse(String(advanceFee.params[8]))).toMatchObject({ intakeId: 1, orderDebitLedgerEntryId: 77, advanceCents: expectedAdvance, feeBps: 100 });

    const auditTypes = db.statements("INSERT INTO dropship.dropship_audit_events").map((call) => call.sql.match(/'([a-z_]+)',\s*\n\s+'system'/)?.[1] ?? call.params[3]);
    expect(auditTypes).toContain("wallet_advance_fee_charged");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("holds the order, with the reason pending money could not be advanced, when the bank account does not qualify", async () => {
    const db = createFakeDb(baseHandlers({
      ...advancePresent(),
      walletSelect: {
        match: "FROM dropship.dropship_wallet_accounts",
        rows: [{ id: 1, vendor_id: 10, available_balance_cents: 1_000, pending_balance_cents: 50_000, rewards_balance_cents: 0, currency: "USD", status: "active" }],
      },
      advanceSources: {
        match: "FROM dropship.dropship_funding_methods m",
        rows: [eligibleSourceRow({ prior_pull_settled: false })],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "payment_hold", paymentHoldReason: "insufficient_balance", advance: null });
    expect(db.statements("UPDATE dropship.dropship_wallet_accounts")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
    const holdAudit = db.statements("INSERT INTO dropship.dropship_audit_events")
      .flatMap((call) => call.params.filter((param) => typeof param === "string" && param.includes('"shortfall"')))
      .map((payload) => JSON.parse(String(payload)));
    expect(holdAudit).toHaveLength(1);
    expect(holdAudit[0].shortfall).toEqual({
      gapCents: UNIT_COST_CENTS * 2 + SHIPPING_CENTS - 1_000,
      advanceRefusal: { code: "no_eligible_source", reasons: ["first_pull_not_settled"] },
    });
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

  it("refuses acceptance when the store's default warehouse is not allocated to Dropship OMS, before any financial write", async () => {
    const db = createFakeDb(baseHandlers({
      warehouseAllocation: { match: "FROM channels.channel_warehouse_assignments", rows: [] },
    }));
    const { repository, loadProductCosts } = createRepository(db, availableCost());

    await expect(repository.acceptOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_WAREHOUSE_NOT_ALLOCATED",
      context: { intakeId: 1, channelId: 103, warehouseId: 1, retryable: false },
    });

    expect(loadProductCosts).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(db.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    for (const fragment of [
      "UPDATE dropship.dropship_wallet_accounts",
      "INSERT INTO dropship.dropship_wallet_ledger",
      "INSERT INTO oms.oms_orders",
      "UPDATE dropship.dropship_order_intake",
    ]) {
      expect(db.statements(fragment), fragment).toHaveLength(0);
    }
  });

  it("refuses canonical preparation when the frozen quote warehouse is not allocated", async () => {
    const db = createFakeDb(baseHandlers({
      warehouseAllocation: { match: "FROM channels.channel_warehouse_assignments", rows: [] },
    }));
    const { repository, loadProductCosts } = createRepository(db, availableCost());

    await expect(repository.prepareCanonicalOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_WAREHOUSE_NOT_ALLOCATED",
      context: { intakeId: 1, channelId: 103, warehouseId: 1, retryable: false },
    });

    expect(loadProductCosts).not.toHaveBeenCalled();
    expect(db.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
    expect(db.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    expect(db.statements("INSERT INTO oms.oms_orders")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_order_acceptance_stages")).toHaveLength(0);
    expect(db.statements("UPDATE dropship.dropship_wallet_accounts")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
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

  it("prepares canonical acceptance without exact-SKU inventory validation or financial writes", async () => {
    const db = createFakeDb(baseHandlers());
    const { repository } = createRepository(db, availableCost());

    const result = await repository.prepareCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "prepared",
      omsOrderId: 1001,
      idempotentReplay: false,
    });
    expect(db.statements("FROM inventory.inventory_levels il")).toHaveLength(0);
    expect(db.statements("UPDATE dropship.dropship_wallet_accounts")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_order_economics_snapshots")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_order_acceptance_stages")).toHaveLength(1);
    const [omsOrder] = db.statements("INSERT INTO oms.oms_orders");
    expect(omsOrder.sql).toContain("'pending', 'pending'");
    expect(JSON.parse(String(omsOrder.params[18])).dropship.acceptanceState)
      .toBe("inventory_claim_required");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("finalizes a claimed canonical stage and debits exactly once in one transaction", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001 })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow()],
      },
    }));
    const { repository, loadProductCosts } = createRepository(db, availableCost());

    const result = await repository.finalizeCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "accepted",
      omsOrderId: 1001,
      walletLedgerEntryId: 77,
      economicsSnapshotId: 55,
      totalDebitCents: UNIT_COST_CENTS * 2 + SHIPPING_CENTS,
    });
    expect(loadProductCosts).not.toHaveBeenCalled();
    expect(db.statements("UPDATE dropship.dropship_wallet_accounts")).toHaveLength(1);
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(1);
    expect(db.statements("UPDATE oms.oms_orders")).toHaveLength(1);
    expect(db.statements("UPDATE dropship.dropship_order_acceptance_stages")).toHaveLength(1);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("reuses a prepared canonical stage on retry without creating another OMS order", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001 })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "prepared",
          claim_attempt_number: null,
          wms_order_id: null,
          inventory_claimed_at: null,
        })],
      },
    }));
    const { repository, loadProductCosts } = createRepository(db, availableCost());

    const result = await repository.prepareCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "prepared", omsOrderId: 1001, idempotentReplay: true });
    expect(loadProductCosts).not.toHaveBeenCalled();
    expect(db.statements("INSERT INTO oms.oms_orders")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_order_acceptance_stages")).toHaveLength(0);
  });

  it("does not resume a prepared canonical stage after its payment-hold deadline", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "payment_hold",
          oms_order_id: 1001,
          payment_hold_expires_at: new Date("2026-09-12T14:59:59.000Z"),
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "prepared",
          claim_attempt_number: null,
          wms_order_id: null,
          inventory_claimed_at: null,
        })],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    await expect(repository.prepareCanonicalOrder(acceptanceInput())).rejects.toMatchObject({
      code: "DROPSHIP_ORDER_PAYMENT_HOLD_EXPIRED",
    });

    expect(db.statements("UPDATE dropship.dropship_order_intake")).toHaveLength(0);
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("persists compensation intent before resuming an inventory-claimed payment hold", async () => {
    const originalExpiry = new Date("2026-09-12T14:59:59.000Z");
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "payment_hold",
          oms_order_id: 1001,
          payment_hold_expires_at: originalExpiry,
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow()],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.prepareCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "compensation_required",
      omsOrderId: 1001,
      wmsOrderId: 9001,
      inventoryClaimId: "7001",
      warehouseId: 1,
      result: { outcome: "payment_hold", paymentHoldExpiresAt: originalExpiry, idempotentReplay: true },
    });
    expect(db.statements("UPDATE dropship.dropship_order_intake")).toHaveLength(0);
    const [stageUpdate] = db.statements("UPDATE dropship.dropship_order_acceptance_stages");
    expect(stageUpdate.sql).toContain("state = 'compensation_pending'");
    expect(stageUpdate.params[1]).toEqual(ACCEPTED_AT);
    expect(stageUpdate.params[2]).toBe("payment_hold_expired_before_finalization");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("does not extend the original payment-hold deadline after an inventory claim", async () => {
    const originalExpiry = new Date("2026-09-12T14:59:59.000Z");
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "processing",
          oms_order_id: 1001,
          payment_hold_expires_at: originalExpiry,
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow()],
      },
      walletSelect: {
        match: "FROM dropship.dropship_wallet_accounts",
        rows: [{
          id: 1,
          vendor_id: 10,
          available_balance_cents: 100,
          pending_balance_cents: 0,
          rewards_balance_cents: 0,
          currency: "USD",
          status: "active",
        }],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.finalizeCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "payment_hold",
      paymentHoldExpiresAt: originalExpiry,
      omsOrderId: null,
      walletLedgerEntryId: null,
    });
    const intakeUpdate = db.statements("UPDATE dropship.dropship_order_intake")[0];
    expect(intakeUpdate?.params[1]).toEqual(originalExpiry);
    expect(db.statements("UPDATE dropship.dropship_wallet_accounts")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
    const stageUpdate = db.statements("UPDATE dropship.dropship_order_acceptance_stages")
      .find((call) => call.sql.includes("compensation_pending"));
    expect(stageUpdate).toBeDefined();
    expect(stageUpdate?.params[2]).toBe("payment_hold_expired_before_finalization");
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("opens a fresh payment hold for the length the active wallet policy sets, not the vendor row", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001, payment_hold_expires_at: null })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow()],
      },
      walletSelect: {
        match: "FROM dropship.dropship_wallet_accounts",
        rows: [{ id: 1, vendor_id: 10, available_balance_cents: 100, pending_balance_cents: 0, rewards_balance_cents: 0, currency: "USD", status: "active" }],
      },
      // The policy table exists and its active row says 24 hours; the vendor
      // row still carries the old 48-hour default and must not win.
      policyTable: {
        match: "to_regclass('dropship.dropship_wallet_policies')",
        rows: [{ present: "dropship.dropship_wallet_policies" }],
      },
      policyRow: {
        match: "FROM dropship.dropship_wallet_policies",
        rows: [{ default_payment_hold_timeout_minutes: 1_440 }],
      },
      holdTimeout: {
        match: "FROM dropship.dropship_auto_reload_settings",
        rows: [{ payment_hold_timeout_minutes: 2_880 }],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.finalizeCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-09-13T15:00:00.000Z"),
    });
    expect(db.statements("FROM dropship.dropship_wallet_policies")).toHaveLength(1);
    // The vendor row is not consulted for the hold length once the policy has
    // answered; the settings row is still read for the rewards preference.
    expect(db.statements("SELECT payment_hold_timeout_minutes")).toHaveLength(0);
    expect(db.statements("SELECT spend_rewards_first")).toHaveLength(1);
  });

  it("falls back to the vendor row for the hold length when the policy table is absent", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001, payment_hold_expires_at: null })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow()],
      },
      walletSelect: {
        match: "FROM dropship.dropship_wallet_accounts",
        rows: [{ id: 1, vendor_id: 10, available_balance_cents: 100, pending_balance_cents: 0, rewards_balance_cents: 0, currency: "USD", status: "active" }],
      },
      holdTimeout: {
        match: "FROM dropship.dropship_auto_reload_settings",
        rows: [{ payment_hold_timeout_minutes: 2_880 }],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.finalizeCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "payment_hold",
      paymentHoldExpiresAt: new Date("2026-09-14T15:00:00.000Z"),
    });
    // A missing relation is never queried inside the transaction: it would abort it.
    expect(db.statements("FROM dropship.dropship_wallet_policies")).toHaveLength(0);
  });

  it("does not debit after an existing payment-hold deadline even when the wallet is now funded", async () => {
    const originalExpiry = new Date("2026-09-12T14:59:59.000Z");
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "processing",
          oms_order_id: 1001,
          payment_hold_expires_at: originalExpiry,
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow()],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.finalizeCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "payment_hold",
      paymentHoldExpiresAt: originalExpiry,
      walletLedgerEntryId: null,
    });
    expect(db.statements("UPDATE dropship.dropship_wallet_accounts")).toHaveLength(0);
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
    expect(db.statements("UPDATE oms.oms_orders")).toHaveLength(0);
    const compensation = db.statements("UPDATE dropship.dropship_order_acceptance_stages")
      .find((call) => call.sql.includes("compensation_pending"));
    expect(compensation?.params[2]).toBe("payment_hold_expired_before_finalization");
  });

  it("refuses to record a canonical claim whose WMS warehouse differs from the frozen quote warehouse", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001 })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "prepared",
          claim_attempt_number: null,
          wms_order_id: null,
          inventory_claimed_at: null,
        })],
      },
      wmsOrder: {
        match: "FROM wms.orders",
        rows: [{
          id: 9001,
          warehouse_id: 2,
          source: "oms",
          oms_fulfillment_order_id: "1001",
          fulfillment_partition_key: "default",
        }],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    await expect(repository.markCanonicalInventoryClaimed({
      acceptance: acceptanceInput(),
      omsOrderId: 1001,
      wmsOrderId: 9001,
      inventoryClaimId: "7001",
    })).rejects.toMatchObject({
      code: "DROPSHIP_CANONICAL_WAREHOUSE_MISMATCH",
      context: { expectedWarehouseId: 1, actualWarehouseId: 2 },
    });

    expect(db.statements("UPDATE dropship.dropship_order_acceptance_stages")).toHaveLength(0);
    expect(db.calls.at(-1)?.sql).toBe("ROLLBACK");
  });

  it("records each successful canonical claim as a new append-only attempt before advancing the stage", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001 })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "prepared",
          claim_attempt_number: null,
          wms_order_id: null,
          inventory_claimed_at: null,
        })],
      },
      claimAttemptSequence: {
        match: "SELECT COALESCE(MAX(attempt_number)",
        rows: [{ attempt_number: 2 }],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    await repository.markCanonicalInventoryClaimed({
      acceptance: acceptanceInput(),
      omsOrderId: 1001,
      wmsOrderId: 9001,
      inventoryClaimId: "7001",
    });

    const [attemptInsert] = db.statements("INSERT INTO dropship.dropship_order_acceptance_claim_attempts");
    expect(attemptInsert.params).toEqual([1, 2, 1001, 9001, 1, "claimed", "7001", ACCEPTED_AT]);
    const [stageUpdate] = db.statements("UPDATE dropship.dropship_order_acceptance_stages");
    expect(stageUpdate.params).toEqual([1, 9001, ACCEPTED_AT, 2]);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("records digital no-claim evidence without inventing a canonical inventory claim ID", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({ status: "processing", oms_order_id: 1001 })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "prepared",
          claim_attempt_number: null,
          wms_order_id: null,
          inventory_claimed_at: null,
        })],
      },
      availabilityClaim: { match: "FROM inventory.availability_claims", rows: [] },
    }));
    const { repository } = createRepository(db, availableCost());

    await repository.markCanonicalInventoryClaimed({
      acceptance: acceptanceInput(),
      omsOrderId: 1001,
      wmsOrderId: 9001,
      inventoryClaimId: null,
    });

    const [attemptInsert] = db.statements("INSERT INTO dropship.dropship_order_acceptance_claim_attempts");
    expect(attemptInsert.params).toEqual([
      1, 1, 1001, 9001, 1, "no_claim_required", null, ACCEPTED_AT,
    ]);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("marks compensation completion idempotently without clearing the claimed WMS identity", async () => {
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "payment_hold",
          oms_order_id: 1001,
          payment_hold_expires_at: new Date("2026-09-12T16:00:00.000Z"),
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "inventory_released",
          inventory_release_requested_at: ACCEPTED_AT,
          inventory_released_at: ACCEPTED_AT,
          inventory_release_reason: "wallet_balance_changed_before_finalization",
        })],
      },
      claimAttemptSelect: {
        match: "FROM dropship.dropship_order_acceptance_claim_attempts",
        rows: [canonicalClaimAttemptRow({
          state: "released",
          release_requested_at: ACCEPTED_AT,
          released_at: ACCEPTED_AT,
          release_reason: "wallet_balance_changed_before_finalization",
        })],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    await repository.markCanonicalInventoryClaimReleased({
      acceptance: acceptanceInput(),
      omsOrderId: 1001,
      wmsOrderId: 9001,
      inventoryClaimId: "7001",
      reason: "wallet_balance_changed_before_finalization",
    });

    expect(db.statements("UPDATE dropship.dropship_order_acceptance_stages")).toHaveLength(0);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("durably marks an already released claim expired on a later retry", async () => {
    const expiredAt = new Date("2026-09-12T14:59:59.000Z");
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "payment_hold",
          oms_order_id: 1001,
          payment_hold_expires_at: expiredAt,
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "inventory_released",
          inventory_release_requested_at: expiredAt,
          inventory_released_at: expiredAt,
          inventory_release_reason: "wallet_balance_changed_before_finalization",
        })],
      },
      claimAttemptSelect: {
        match: "FROM dropship.dropship_order_acceptance_claim_attempts",
        rows: [canonicalClaimAttemptRow({
          state: "released",
          release_requested_at: expiredAt,
          released_at: expiredAt,
          release_reason: "wallet_balance_changed_before_finalization",
        })],
      },
    }));
    const { repository } = createRepository(db, availableCost());

    await repository.markCanonicalInventoryClaimReleased({
      acceptance: acceptanceInput(),
      omsOrderId: 1001,
      wmsOrderId: 9001,
      inventoryClaimId: "7001",
      reason: "wallet_balance_changed_before_finalization",
    });

    const [stageUpdate] = db.statements("UPDATE dropship.dropship_order_acceptance_stages");
    expect(stageUpdate.sql).toContain("state = 'expired'");
    expect(stageUpdate.params).toEqual([1, ACCEPTED_AT]);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("reopens a durably released attempt for a funded retry without erasing attempt evidence", async () => {
    const holdExpiresAt = new Date("2026-09-12T16:00:00.000Z");
    const releasedAt = new Date("2026-09-12T14:59:00.000Z");
    const db = createFakeDb(baseHandlers({
      intake: {
        match: "FROM dropship.dropship_order_intake",
        rows: [intakeRow({
          status: "payment_hold",
          oms_order_id: 1001,
          payment_hold_expires_at: holdExpiresAt,
        })],
      },
      stageSelect: {
        match: "FROM dropship.dropship_order_acceptance_stages",
        rows: [canonicalStageRow({
          state: "inventory_released",
          inventory_release_requested_at: releasedAt,
          inventory_released_at: releasedAt,
          inventory_release_reason: "wallet_balance_changed_before_finalization",
        })],
      },
      claimAttemptSelect: {
        match: "FROM dropship.dropship_order_acceptance_claim_attempts",
        rows: [canonicalClaimAttemptRow({
          state: "released",
          release_requested_at: releasedAt,
          released_at: releasedAt,
          release_reason: "wallet_balance_changed_before_finalization",
        })],
      },
    }));
    const { repository, loadProductCosts } = createRepository(db, availableCost());

    const result = await repository.prepareCanonicalOrder(acceptanceInput());

    expect(result).toMatchObject({
      outcome: "prepared",
      omsOrderId: 1001,
      warehouseId: 1,
      idempotentReplay: true,
    });
    expect(loadProductCosts).not.toHaveBeenCalled();
    const [stageUpdate] = db.statements("UPDATE dropship.dropship_order_acceptance_stages");
    expect(stageUpdate.sql).toContain("claim_attempt_number = NULL");
    expect(stageUpdate.sql).toContain("inventory_released_at = NULL");
    expect(db.statements("UPDATE dropship.dropship_order_acceptance_claim_attempts")).toHaveLength(0);
    expect(db.statements("UPDATE dropship.dropship_order_intake")).toHaveLength(1);
    expect(db.calls.at(-1)?.sql).toBe("COMMIT");
  });
});

describe("PgDropshipOrderAcceptanceRepository rewards at the debit (funding design phase 7)", () => {
  const expectedDebit = UNIT_COST_CENTS * 2 + SHIPPING_CENTS;

  /** A vendor with points who chose to auto-apply them; a test about saving overrides the settings row. */
  function walletWithRewards(rewardsCents: number, availableCents = WALLET_BALANCE_CENTS) {
    return {
      walletSelect: {
        match: "FROM dropship.dropship_wallet_accounts",
        rows: [{ id: 1, vendor_id: 10, available_balance_cents: availableCents, pending_balance_cents: 0, rewards_balance_cents: rewardsCents, currency: "USD", status: "active" }],
      },
      holdTimeout: { match: "FROM dropship.dropship_auto_reload_settings", rows: [{ payment_hold_timeout_minutes: 2_880, spend_rewards_first: true }] },
    };
  }

  it("spends rewards first and cash second: two rows, both balances moved, the split on the record", async () => {
    const db = createFakeDb(baseHandlers(walletWithRewards(300)));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "accepted", totalDebitCents: expectedDebit, rewardsCents: 300, idempotentReplay: false });
    const [walletUpdate] = db.statements("UPDATE dropship.dropship_wallet_accounts");
    expect(walletUpdate.params[2]).toBe(WALLET_BALANCE_CENTS - (expectedDebit - 300));
    expect(walletUpdate.params[4]).toBe(0);

    const [cashRow, rewardsRow] = db.statements("INSERT INTO dropship.dropship_wallet_ledger");
    expect(cashRow.params[2]).toBe(-(expectedDebit - 300));
    expect(cashRow.params[10]).toBe(0);
    expect(JSON.parse(String(cashRow.params[8]))).toMatchObject({ totalDebitCents: expectedDebit, rewardsSpentCents: 300, cashDebitCents: expectedDebit - 300 });
    expect(rewardsRow.sql).toContain("'rewards_spent'");
    expect(rewardsRow.sql).toContain("'order_intake_rewards'");
    expect(rewardsRow.params[2]).toBe(-300);
    expect(rewardsRow.params[7]).toMatch(/:rewards$/);
    expect(JSON.parse(String(rewardsRow.params[8]))).toMatchObject({ intakeId: acceptanceInput().intakeId, orderDebitLedgerEntryId: 77, totalDebitCents: expectedDebit, cashDebitCents: expectedDebit - 300, rewardsBalanceBeforeCents: 300 });
    expect(rewardsRow.params[10]).toBe(0);
    const audits = db.statements("INSERT INTO dropship.dropship_audit_events").map((call) => call.sql.match(/'(wallet_[a-z_]+)'/)?.[1] ?? call.params[3]);
    expect(audits).toContain("wallet_order_debited");
    expect(audits).toContain("wallet_rewards_spent");
    // The 300 points held before lots existed open the account's first lot, and the spend leaves it.
    expect(audits).toContain("wallet_rewards_lots_opened");
    expect(db.lots.lots).toEqual([expect.objectContaining({ wallet_account_id: 1, source: "opening_balance", earned_cents: 300, remaining_cents: 0 })]);
    expect(db.lots.movements).toEqual([expect.objectContaining({ ledger_entry_id: 77, reason: "ledger", amount_cents: -300 })]);
  });

  it("spends the points closest to expiring first, never-expiring points last", async () => {
    const soon = new Date(ACCEPTED_AT.getTime() + 5 * 86_400_000);
    const later = new Date(ACCEPTED_AT.getTime() + 50 * 86_400_000);
    const db = createFakeDb(baseHandlers(walletWithRewards(3_500)), {
      lots: [
        { id: 1, wallet_account_id: 1, source: "opening_balance", remaining_cents: 2_000 },
        { id: 2, wallet_account_id: 1, source: "earned", origin_ledger_entry_id: 40, remaining_cents: 1_000, expires_at: later, expiry_days: 90 },
        { id: 3, wallet_account_id: 1, source: "earned", origin_ledger_entry_id: 41, remaining_cents: 500, expires_at: soon, expiry_days: 90 },
      ],
    });
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "accepted", rewardsCents: expectedDebit });
    expect(db.lots.movements.map((movement) => [movement.lot_id, movement.amount_cents])).toEqual([
      [3, -500],
      [2, -1_000],
      [1, -(expectedDebit - 1_500)],
    ]);
    expect(db.lots.remainingFor(1)).toBe(3_500 - expectedDebit);
    const spendAudit = db.statements("INSERT INTO dropship.dropship_audit_events").find((call) => call.sql.includes("'wallet_rewards_spent'"));
    expect(JSON.parse(String(spendAudit?.params[2])).rewardsLotTakes).toEqual([
      { lotId: 3, cents: 500 },
      { lotId: 2, cents: 1_000 },
      { lotId: 1, cents: expectedDebit - 1_500 },
    ]);
  });

  it("an order the rewards balance pays in full posts no cash row; the rewards row is the record, whatever the cash balance", async () => {
    const db = createFakeDb(baseHandlers(walletWithRewards(expectedDebit + 5, -2_000)));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "accepted", rewardsCents: expectedDebit, walletLedgerEntryId: 77 });
    const [walletUpdate] = db.statements("UPDATE dropship.dropship_wallet_accounts");
    expect(walletUpdate.params[2]).toBe(-2_000);
    expect(walletUpdate.params[4]).toBe(5);
    const rows = db.statements("INSERT INTO dropship.dropship_wallet_ledger");
    expect(rows).toHaveLength(1);
    expect(rows[0].sql).toContain("'rewards_spent'");
    expect(rows[0].params[2]).toBe(-expectedDebit);
  });

  it("a vendor saving their rewards pays from cash alone", async () => {
    const db = createFakeDb(baseHandlers({
      ...walletWithRewards(50_000),
      holdTimeout: { match: "FROM dropship.dropship_auto_reload_settings", rows: [{ payment_hold_timeout_minutes: 2_880, spend_rewards_first: false }] },
    }));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "accepted", rewardsCents: 0 });
    const [walletUpdate] = db.statements("UPDATE dropship.dropship_wallet_accounts");
    expect(walletUpdate.params[2]).toBe(WALLET_BALANCE_CENTS - expectedDebit);
    expect(walletUpdate.params[4]).toBe(50_000);
    const rows = db.statements("INSERT INTO dropship.dropship_wallet_ledger");
    expect(rows).toHaveLength(1);
    expect(rows[0].sql).toContain("'order_debit'");
    expect(rows[0].params[2]).toBe(-expectedDebit);
  });

  it("a vendor who has not chosen gets the default, points first, whether the row says NULL or predates the choice", async () => {
    for (const settingsRow of [{ payment_hold_timeout_minutes: 2_880, spend_rewards_first: null }, { payment_hold_timeout_minutes: 2_880 }]) {
      const db = createFakeDb(baseHandlers({
        ...walletWithRewards(300),
        holdTimeout: { match: "FROM dropship.dropship_auto_reload_settings", rows: [settingsRow] },
      }));
      const { repository } = createRepository(db, availableCost());

      const result = await repository.acceptOrder(acceptanceInput());

      expect(result).toMatchObject({ outcome: "accepted", rewardsCents: 300 });
      const [walletUpdate] = db.statements("UPDATE dropship.dropship_wallet_accounts");
      expect(walletUpdate.params[2]).toBe(WALLET_BALANCE_CENTS - (expectedDebit - 300));
      expect(walletUpdate.params[4]).toBe(0);
      const rows = db.statements("INSERT INTO dropship.dropship_wallet_ledger");
      expect(rows).toHaveLength(2);
      expect(rows[0].sql).toContain("'order_debit'");
      expect(rows[1].sql).toContain("'rewards_spent'");
    }
  });

  it("holds an order the cash cannot cover after rewards, reporting the rewards part so the card covers only the rest", async () => {
    const db = createFakeDb(baseHandlers(walletWithRewards(300, 100)));
    const { repository } = createRepository(db, availableCost());

    const result = await repository.acceptOrder(acceptanceInput());

    expect(result).toMatchObject({ outcome: "payment_hold", totalDebitCents: expectedDebit, rewardsCents: 300 });
    expect(db.statements("INSERT INTO dropship.dropship_wallet_ledger")).toHaveLength(0);
    const holdAudit = db.statements("INSERT INTO dropship.dropship_audit_events").find((call) => call.params.includes("order_acceptance_payment_hold"));
    const payload = holdAudit?.params
      .map((param) => { try { return JSON.parse(String(param)) as Record<string, unknown>; } catch { return null; } })
      .find((value) => value !== null && typeof value === "object" && "shortfall" in value);
    expect(payload).toMatchObject({ rewardsBalanceCents: 300, rewardsCents: 300, shortfall: { gapCents: expectedDebit - 300 - 100 } });
  });
});
