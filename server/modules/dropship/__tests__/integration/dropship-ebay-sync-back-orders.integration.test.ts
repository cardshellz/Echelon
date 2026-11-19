import { PgDialect } from "drizzle-orm/pg-core";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

import {
  createInventoryCutoverTestDatabase,
  type InventoryCutoverTestDatabase,
} from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { decideAcceptedCancelOutcome } from "../../domain/marketplace-order-cancel";
import { ORDER_LISTING_ENDED_BEFORE_ORDER_CODE, ORDER_LISTING_ENDED_BEFORE_ORDER_MESSAGE } from "../../domain/order-listing-acceptability";
import { decideOrderProcessingFailure, ORDER_PROCESSING_MAX_ATTEMPTS } from "../../domain/order-processing-retry";
import { PgDropshipEbayMarketplaceOrderEffects } from "../../infrastructure/dropship-ebay-marketplace-order-effects.repository";
import { DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS } from "../../infrastructure/dropship-marketplace-sync-health.sql";
import { PgDropshipBelowCostSaleNotices } from "../../infrastructure/dropship-marketplace-sync-notices.repository";
import {
  PgDropshipMarketplaceOrderCancelRepository,
  postMarketplaceCancelRefundWithClient,
} from "../../infrastructure/dropship-marketplace-order-cancel.repository";
import { PgDropshipOrderIntakeRepository } from "../../infrastructure/dropship-order-intake.repository";
import { PgDropshipOrderProcessingQueueRepository } from "../../infrastructure/dropship-order-processing-runner";
import { PgDropshipOrderProcessingRepository } from "../../infrastructure/dropship-order-processing.repository";
import { hashDropshipOrderIntakePayload, type DropshipOrderIntakeRepositoryInput } from "../../application/dropship-order-intake-service";
import { ebaySyncBackOrdersFixtureSql } from "../fixtures/ebay-sync-back-orders.fixture";
import { installEbaySyncBackSchema } from "../fixtures/ebay-sync-back.fixture";

/**
 * eBay sync-back's order fixes against a real PostgreSQL (plan v4 §7): the
 * due-time queue and bounded retries (§7.1), an order edit that keeps a
 * failed intake as it is (SB21), the intake table of an eBay cancellation
 * (§7.2), the claim that cancels a flagged intake once nothing is held, the
 * refund of a stopped order (cash with the advance fee, points to their
 * lots, once), the review after the stop's retries run out, the poll's
 * sales-ledger and parked lines (§7.3), and the new ops-health counts.
 */
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

const VENDOR = 10;
const STORE = 22;
const T0 = new Date("2026-10-22T12:00:00.000Z");
const minutes = (count: number) => new Date(T0.getTime() + count * 60_000);

describeDatabase.sequential("eBay sync-back order fixes (PostgreSQL)", () => {
  let database: InventoryCutoverTestDatabase;
  let pool: Pool;

  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, ebaySyncBackOrdersFixtureSql);
    pool = database.pool;
    await installEbaySyncBackSchema(pool);
  });

  afterAll(async () => {
    await database?.close();
  });

  beforeEach(async () => {
    await pool.query(`TRUNCATE dropship.dropship_wallet_rewards_lot_movements, dropship.dropship_wallet_rewards_lots,
      dropship.dropship_wallet_ledger, dropship.dropship_wallet_accounts, dropship.dropship_marketplace_tracking_pushes,
      dropship.dropship_order_acceptance_stages, dropship.dropship_marketplace_sync_notices, dropship.dropship_unmatched_marketplace_orders,
      dropship.dropship_listing_marketplace_sales, dropship.dropship_listing_previous_marketplace_ids, dropship.dropship_audit_events,
      dropship.dropship_order_intake, dropship.dropship_vendor_listings, dropship.dropship_store_connections, dropship.dropship_vendors,
      catalog.product_variants, catalog.products RESTART IDENTITY CASCADE`);
    // The rewards-lot movements are append-only by trigger; TRUNCATE is not a row change, so it is allowed.
    await pool.query(`INSERT INTO dropship.dropship_vendors (id, member_id) VALUES (${VENDOR}, 'member-10')`);
    await pool.query(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, access_token_ref, refresh_token_ref)
      VALUES (${STORE}, ${VENDOR}, 'ebay', 'a', 'r')`);
    await pool.query(`INSERT INTO catalog.products (id, sku) VALUES (1, 'SKU-P'), (2, 'SKU-Q')`);
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku) VALUES (101, 1, 'SKU-101'), (102, 2, 'SKU-102')`);
  });

  async function insertListing(input: { variant: number; itemNumber: string | null }): Promise<number> {
    const result = await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_vendor_listings
        (vendor_id, store_connection_id, product_variant_id, platform, external_listing_id, external_offer_id, status, marketplace_sync_attempted_at)
      VALUES ($1, $2, $3, 'ebay', $4, $5, 'active', $6) RETURNING id`,
    [VENDOR, STORE, input.variant, input.itemNumber, input.itemNumber ? `offer-${input.itemNumber}` : null, T0]);
    return result.rows[0]!.id;
  }

  async function insertIntake(input: {
    externalOrderId: string; status: string; cancellationStatus?: string | null; attempts?: number; nextAttemptAt?: Date | null;
    receivedAt?: Date; marketplaceCancelledAt?: Date | null; omsOrderId?: number | null;
  }): Promise<number> {
    const result = await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_order_intake
        (vendor_id, store_connection_id, platform, external_order_id, status, cancellation_status, processing_attempt_count,
         next_processing_attempt_at, received_at, updated_at, marketplace_cancelled_at, oms_order_id, normalized_payload, raw_payload, payload_hash,
         accepted_at)
      VALUES ($1, $2, 'ebay', $3, $4, $5, $6, $7, $8, $8, $9, $10, $11::jsonb, '{}'::jsonb, 'hash', $12) RETURNING id`,
    [VENDOR, STORE, input.externalOrderId, input.status, input.cancellationStatus ?? null, input.attempts ?? 0, input.nextAttemptAt ?? null,
      input.receivedAt ?? T0, input.marketplaceCancelledAt ?? null, input.omsOrderId ?? null,
      JSON.stringify({ lines: [{ externalLineItemId: "L1", externalListingId: "111", quantity: 1 }] }),
      input.status === "accepted" ? minutes(-60) : null]);
    return result.rows[0]!.id;
  }

  async function intakeRow(id: number) {
    const result = await pool.query(`SELECT status, cancellation_status, processing_attempt_count, next_processing_attempt_at,
      marketplace_cancelled_at, rejection_reason FROM dropship.dropship_order_intake WHERE id = $1`, [id]);
    return result.rows[0];
  }

  async function auditTypes(intakeId: number): Promise<string[]> {
    const result = await pool.query<{ event_type: string }>(`SELECT event_type FROM dropship.dropship_audit_events
      WHERE entity_type = 'dropship_order_intake' AND entity_id = $1 ORDER BY id`, [String(intakeId)]);
    return result.rows.map((row) => row.event_type);
  }

  it("takes a stuck intake again only when it is due, and never ahead of a newer order that is due first (§7.1)", async () => {
    const stuck = await insertIntake({ externalOrderId: "STUCK", status: "retrying", attempts: 3, nextAttemptAt: minutes(10), receivedAt: minutes(-120) });
    const fresh = await insertIntake({ externalOrderId: "FRESH", status: "received", receivedAt: minutes(-1) });
    const queue = new PgDropshipOrderProcessingQueueRepository(pool);

    expect(await queue.listProcessableIntakeIds({ limit: 10, now: T0 })).toEqual([fresh]);
    expect(await queue.listProcessableIntakeIds({ limit: 10, now: minutes(11) })).toEqual([fresh, stuck]);
  });

  it("records a failed attempt's count and next time, which the next claim reads back (§7.1)", async () => {
    const intake = await insertIntake({ externalOrderId: "FAIL", status: "retrying", attempts: 2 });
    const repository = new PgDropshipOrderProcessingRepository(pool);

    const claim = await repository.claimIntake({ intakeId: intake, workerId: "w1", now: T0 });
    expect(claim).toMatchObject({ claimed: true, intake: { processingAttemptCount: 2 } });
    const decision = decideOrderProcessingFailure({ attemptsBefore: 2, retryable: true, now: T0 });
    await repository.markIntakeFailure({ intakeId: intake, vendorId: VENDOR, storeConnectionId: STORE, workerId: "w1", status: "retrying",
      errorCode: "DROPSHIP_ORDER_INVENTORY_SHORTFALL", errorMessage: "short", retryable: true, attemptCount: decision.attemptCount,
      nextAttemptAt: decision.nextAttemptAt, now: T0 });

    expect(await intakeRow(intake)).toMatchObject({ status: "retrying", processing_attempt_count: 3, next_processing_attempt_at: minutes(15) });
    const audit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'order_processing_retry_scheduled'`);
    expect(audit.rows[0].payload).toMatchObject({ attemptCount: 3, nextAttemptAt: minutes(15).toISOString() });
  });

  it("keeps a failed intake's status, count and due time when eBay edits the order, and still updates a received one (SB21)", async () => {
    const repository = new PgDropshipOrderIntakeRepository(pool);
    const first = intakeInput("EDITED", "received", { city: "Austin" });
    const created = await repository.recordMarketplaceIntake(first);
    await pool.query(`UPDATE dropship.dropship_order_intake SET status = 'failed', rejection_reason = 'X: stuck',
      processing_attempt_count = 64, next_processing_attempt_at = NULL WHERE id = $1`, [created.intake.intakeId]);

    const edited = await repository.recordMarketplaceIntake(intakeInput("EDITED", "received", { city: "Dallas" }));
    expect(edited).toMatchObject({ action: "updated", intake: { status: "failed", rejectionReason: "X: stuck" } });
    expect(await intakeRow(created.intake.intakeId)).toMatchObject({ status: "failed", processing_attempt_count: 64 });
    expect(edited.intake.normalizedPayload.shipTo).toMatchObject({ city: "Dallas" });

    const other = await repository.recordMarketplaceIntake(intakeInput("STILL-RECEIVED", "received", { city: "Austin" }));
    const rejected = await repository.recordMarketplaceIntake(intakeInput("STILL-RECEIVED", "rejected", { city: "Waco" }));
    expect(rejected).toMatchObject({ action: "updated", intake: { intakeId: other.intake.intakeId, status: "rejected" } });
  });

  it("applies an eBay cancellation per the intake table, and a replay writes nothing (§7.2)", async () => {
    const effects = new PgDropshipEbayMarketplaceOrderEffects(pool);
    const listing = await insertListing({ variant: 101, itemNumber: "111" });
    const neverCharged = await insertIntake({ externalOrderId: "NEW", status: "received" });
    const heldStage = await insertIntake({ externalOrderId: "HELD", status: "retrying" });
    await pool.query(`INSERT INTO dropship.dropship_order_acceptance_stages (intake_id, state) VALUES ($1, 'inventory_claimed')`, [heldStage]);
    const released = await insertIntake({ externalOrderId: "RELEASED", status: "payment_hold" });
    await pool.query(`INSERT INTO dropship.dropship_order_acceptance_stages (intake_id, state) VALUES ($1, 'inventory_released')`, [released]);
    const processing = await insertIntake({ externalOrderId: "BUSY", status: "processing" });
    const accepted = await insertIntake({ externalOrderId: "TAKEN", status: "accepted", omsOrderId: 900 });
    const outbound = await insertIntake({ externalOrderId: "ASKED", status: "cancelled", cancellationStatus: "payment_hold_expired" });
    await pool.query(`INSERT INTO dropship.dropship_listing_marketplace_sales
        (store_connection_id, listing_id, external_order_id, external_line_item_id, quantity, ordered_at, first_seen_at)
      VALUES ($1, $2, 'NEW', 'L1', 2, $3, $3)`, [STORE, listing, minutes(-30)]);

    const apply = (externalOrderId: string) => effects.applyCancellation({ storeConnectionId: STORE, externalOrderId, at: T0 });
    expect(await apply("NEW")).toEqual({ action: "cancel_intake", intakeId: neverCharged });
    expect(await apply("HELD")).toEqual({ action: "flag_for_processing", intakeId: heldStage });
    expect(await apply("RELEASED")).toEqual({ action: "cancel_intake", intakeId: released });
    expect(await apply("BUSY")).toEqual({ action: "flag_for_processing", intakeId: processing });
    expect(await apply("TAKEN")).toEqual({ action: "stop_accepted", intakeId: accepted });
    expect(await apply("ASKED")).toEqual({ action: "outbound_cancel_unneeded", intakeId: outbound });
    expect(await apply("NEVER-SEEN")).toEqual({ action: "no_intake", intakeId: null });

    expect(await intakeRow(neverCharged)).toMatchObject({ status: "cancelled", cancellation_status: "cancelled_on_marketplace",
      marketplace_cancelled_at: T0 });
    expect(await intakeRow(heldStage)).toMatchObject({ status: "retrying", cancellation_status: null, marketplace_cancelled_at: T0,
      next_processing_attempt_at: T0 });
    expect(await intakeRow(released)).toMatchObject({ status: "cancelled", cancellation_status: "cancelled_on_marketplace" });
    expect(await intakeRow(processing)).toMatchObject({ status: "processing", marketplace_cancelled_at: T0 });
    expect(await intakeRow(accepted)).toMatchObject({ status: "accepted", cancellation_status: "marketplace_cancel_stop_pending",
      processing_attempt_count: 0, next_processing_attempt_at: T0 });
    expect(await intakeRow(outbound)).toMatchObject({ status: "cancelled", cancellation_status: "marketplace_cancelled" });
    const sale = await pool.query(`SELECT cancelled_at FROM dropship.dropship_listing_marketplace_sales WHERE external_order_id = 'NEW'`);
    expect(sale.rows[0].cancelled_at).toEqual(T0);

    const auditCount = (await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events`)).rows[0].n;
    for (const id of ["NEW", "HELD", "RELEASED", "BUSY", "TAKEN", "ASKED"]) await apply(id);
    expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_audit_events`)).rows[0].n).toBe(auditCount);
    expect(await auditTypes(accepted)).toEqual(["order_marketplace_cancel_stop_requested"]);
  });

  it("cancels a flagged intake at claim once nothing is held, and processes one whose stage still holds stock (§7.2)", async () => {
    const repository = new PgDropshipOrderProcessingRepository(pool);
    const free = await insertIntake({ externalOrderId: "FREE", status: "received", marketplaceCancelledAt: minutes(-1) });
    const held = await insertIntake({ externalOrderId: "HOLDS", status: "retrying", marketplaceCancelledAt: minutes(-1) });
    await pool.query(`INSERT INTO dropship.dropship_order_acceptance_stages (intake_id, state) VALUES ($1, 'inventory_claimed')`, [held]);

    expect(await repository.claimIntake({ intakeId: free, workerId: "w1", now: T0 })).toMatchObject({ claimed: false,
      skipReason: "The order was cancelled on eBay." });
    expect(await intakeRow(free)).toMatchObject({ status: "cancelled", cancellation_status: "cancelled_on_marketplace" });
    expect(await auditTypes(free)).toEqual(["order_cancelled_on_marketplace"]);
    expect(await repository.claimIntake({ intakeId: held, workerId: "w1", now: T0 })).toMatchObject({ claimed: true });
    expect(await intakeRow(held)).toMatchObject({ status: "processing" });
  });

  it("refunds a stopped order once: cash with the advance fee as refund_credit, points back to their lot (§7.2)", async () => {
    const intake = await insertIntake({ externalOrderId: "STOPPED", status: "accepted", cancellationStatus: "marketplace_cancel_stop_pending",
      marketplaceCancelledAt: minutes(-5), omsOrderId: 900 });
    const account = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_wallet_accounts
        (vendor_id, available_balance_cents, pending_balance_cents, rewards_balance_cents) VALUES ($1, 64, 0, 0) RETURNING id`, [VENDOR])).rows[0]!.id;
    const ledger = async (type: string, amount: number, referenceType: string | null, at: Date) => (await pool.query<{ id: number }>(`
      INSERT INTO dropship.dropship_wallet_ledger (wallet_account_id, vendor_id, type, status, amount_cents, reference_type, reference_id,
        idempotency_key, created_at, settled_at) VALUES ($1, $2, $3, 'settled', $4, $5, $6, $7, $8, $8) RETURNING id`,
    [account, VENDOR, type, amount, referenceType, referenceType ? String(intake) : null, `${type}:${intake}`, at])).rows[0]!.id;
    const earned = await ledger("rewards_earned", 300, null, minutes(-100));
    await ledger("order_debit", -1200, "order_intake", minutes(-60));
    const spent = await ledger("rewards_spent", -300, "order_intake_rewards", minutes(-60));
    await ledger("advance_fee", -36, "order_intake_advance_fee", minutes(-60));
    const lot = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_wallet_rewards_lots (wallet_account_id, vendor_id, source,
        origin_ledger_entry_id, earned_cents, remaining_cents, earned_at, created_at, updated_at)
      VALUES ($1, $2, 'earned', $3, 300, 0, $4, $4, $4) RETURNING id`, [account, VENDOR, earned, minutes(-100)])).rows[0]!.id;
    await pool.query(`INSERT INTO dropship.dropship_wallet_rewards_lot_movements (lot_id, ledger_entry_id, reason, amount_cents, created_at)
      VALUES ($1, $2, 'ledger', -300, $3)`, [lot, spent, minutes(-60)]);
    const repository = new PgDropshipMarketplaceOrderCancelRepository(pool);
    const candidate = { intakeId: intake, vendorId: VENDOR, storeConnectionId: STORE, omsOrderId: 900, externalOrderId: "STOPPED",
      externalOrderNumber: null, attemptCount: 0 };
    const record = { candidate, kind: "stopped" as const, outcome: decideAcceptedCancelOutcome("stopped"), shipments: [], at: T0, workerId: "w1" };

    expect(await repository.recordStopOutcome(record)).toEqual({ applied: true, refund: { cashCents: 1236, rewardsCents: 300,
      orderDebitRefundCents: 1200, advanceFeeRefundCents: 36, replayed: false } });

    const refunds = await pool.query(`SELECT type, amount_cents::int AS amount, reference_type, idempotency_key, available_balance_after_cents::int AS available,
      rewards_balance_after_cents::int AS rewards FROM dropship.dropship_wallet_ledger WHERE type IN ('refund_credit', 'rewards_reinstated') ORDER BY id`);
    expect(refunds.rows).toEqual([
      { type: "refund_credit", amount: 1236, reference_type: "order_marketplace_cancel_refund", idempotency_key: `order-cancel-credit:${intake}`,
        available: 1300, rewards: 300 },
      { type: "rewards_reinstated", amount: 300, reference_type: "order_marketplace_cancel_rewards",
        idempotency_key: `order-cancel-credit:${intake}:rewards`, available: 1300, rewards: 300 },
    ]);
    expect((await pool.query(`SELECT available_balance_cents::int AS a, rewards_balance_cents::int AS r FROM dropship.dropship_wallet_accounts`)).rows[0])
      .toEqual({ a: 1300, r: 300 });
    expect((await pool.query(`SELECT remaining_cents::int AS n FROM dropship.dropship_wallet_rewards_lots WHERE id = $1`, [lot])).rows[0].n).toBe(300);
    expect(await intakeRow(intake)).toMatchObject({ status: "accepted", cancellation_status: "marketplace_cancel_stopped" });
    const notice = await pool.query(`SELECT kind, subject_key, critical, payload FROM dropship.dropship_marketplace_sync_notices`);
    expect(notice.rows).toEqual([{ kind: "order_cancel_refunded", subject_key: `order-cancel:${intake}`, critical: false,
      payload: expect.objectContaining({ cashRefundCents: 1236, advanceFeeRefundCents: 36, rewardsRefundCents: 300 }) }]);
    const walletAudit = await pool.query(`SELECT event_type FROM dropship.dropship_audit_events WHERE entity_type = 'dropship_wallet_ledger' ORDER BY id`);
    expect(walletAudit.rows.map((row) => row.event_type)).toEqual(["wallet_order_cancel_refunded", "wallet_order_cancel_rewards_reinstated"]);

    // A replay: the stop is recorded, and the refund itself finds its rows.
    expect(await repository.recordStopOutcome(record)).toEqual({ applied: false });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await postMarketplaceCancelRefundWithClient(client, { intakeId: intake, vendorId: VENDOR, at: T0 })).toMatchObject({ replayed: true });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_wallet_ledger WHERE type IN ('refund_credit','rewards_reinstated')`))
      .rows[0].n).toBe(2);
  });

  it("rolls back the refund with the stop when a write fails (one transaction)", async () => {
    const intake = await insertIntake({ externalOrderId: "ROLLBACK", status: "accepted", cancellationStatus: "marketplace_cancel_stop_pending",
      marketplaceCancelledAt: minutes(-5), omsOrderId: 901 });
    const account = (await pool.query<{ id: number }>(`INSERT INTO dropship.dropship_wallet_accounts (vendor_id) VALUES ($1) RETURNING id`,
      [VENDOR])).rows[0]!.id;
    await pool.query(`INSERT INTO dropship.dropship_wallet_ledger (wallet_account_id, vendor_id, type, status, amount_cents, reference_type,
      reference_id, created_at, settled_at) VALUES ($1, $2, 'order_debit', 'settled', -500, 'order_intake', $3, $4, $4)`,
    [account, VENDOR, String(intake), minutes(-60)]);
    // A CHECK the test adds makes the notice outbox refuse the row, after the refund rows were written in the same transaction.
    await pool.query(`ALTER TABLE dropship.dropship_marketplace_sync_notices ADD CONSTRAINT test_refuse_order_notices CHECK (kind <> 'order_cancel_refunded')`);
    try {
      const repository = new PgDropshipMarketplaceOrderCancelRepository(pool);
      await expect(repository.recordStopOutcome({ candidate: { intakeId: intake, vendorId: VENDOR, storeConnectionId: STORE, omsOrderId: 901,
        externalOrderId: "ROLLBACK", externalOrderNumber: null, attemptCount: 0 }, kind: "stopped", outcome: decideAcceptedCancelOutcome("stopped"),
      shipments: [], at: T0, workerId: "w1" })).rejects.toMatchObject({ code: "23514" });
    } finally {
      await pool.query(`ALTER TABLE dropship.dropship_marketplace_sync_notices DROP CONSTRAINT test_refuse_order_notices`);
    }
    expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_wallet_ledger WHERE type = 'refund_credit'`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT available_balance_cents::int AS a FROM dropship.dropship_wallet_accounts`)).rows[0].a).toBe(0);
    expect(await intakeRow(intake)).toMatchObject({ cancellation_status: "marketplace_cancel_stop_pending" });
  });

  it("sends a stop whose retries ran out to review with the not-stopped notice, and no credit", async () => {
    const intake = await insertIntake({ externalOrderId: "GAVE-UP", status: "accepted", cancellationStatus: "marketplace_cancel_stop_pending",
      marketplaceCancelledAt: minutes(-5), omsOrderId: 902, attempts: ORDER_PROCESSING_MAX_ATTEMPTS - 1 });
    const repository = new PgDropshipMarketplaceOrderCancelRepository(pool);
    const candidate = { intakeId: intake, vendorId: VENDOR, storeConnectionId: STORE, omsOrderId: 902, externalOrderId: "GAVE-UP",
      externalOrderNumber: "5009", attemptCount: ORDER_PROCESSING_MAX_ATTEMPTS - 1 };
    expect((await repository.listDueStops({ now: T0, limit: 10 })).map((due) => due.intakeId)).toEqual([intake]);

    const decision = decideOrderProcessingFailure({ attemptsBefore: candidate.attemptCount, retryable: true, now: T0 });
    expect(await repository.recordStopFailure({ candidate, decision, errorCode: "OMS_DROPSHIP_MARKETPLACE_CANCEL_RELEASE_FAILED",
      errorMessage: "release failed", at: T0, workerId: "w1", omsAnswer: null })).toBe(true);

    expect(await intakeRow(intake)).toMatchObject({ cancellation_status: "marketplace_cancel_review",
      processing_attempt_count: ORDER_PROCESSING_MAX_ATTEMPTS });
    expect((await pool.query(`SELECT kind, critical FROM dropship.dropship_marketplace_sync_notices`)).rows)
      .toEqual([{ kind: "order_cancel_not_stopped", critical: true }]);
    expect(await repository.listDueStops({ now: minutes(60), limit: 10 })).toEqual([]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM dropship.dropship_wallet_ledger`)).rows[0].n).toBe(0);
  });

  it("ARCH-7: a refund that could not be posted after OMS stopped the order goes to review with no 'left the warehouse' notice", async () => {
    const intake = await insertIntake({ externalOrderId: "REFUND-FAILED", status: "accepted", cancellationStatus: "marketplace_cancel_stop_pending",
      marketplaceCancelledAt: minutes(-5), omsOrderId: 903 });
    const repository = new PgDropshipMarketplaceOrderCancelRepository(pool);
    const candidate = { intakeId: intake, vendorId: VENDOR, storeConnectionId: STORE, omsOrderId: 903, externalOrderId: "REFUND-FAILED",
      externalOrderNumber: "5010", attemptCount: 0 };
    const decision = decideOrderProcessingFailure({ attemptsBefore: 0, retryable: false, now: T0 });
    expect(await repository.recordStopFailure({ candidate, decision, errorCode: "DROPSHIP_EBAY_ORDER_CANCEL_REFUND_REFUSED",
      errorMessage: "refused", at: T0, workerId: "w1", omsAnswer: "stopped" })).toBe(true);
    expect(await intakeRow(intake)).toMatchObject({ cancellation_status: "marketplace_cancel_review" });
    expect((await pool.query(`SELECT kind FROM dropship.dropship_marketplace_sync_notices`)).rows).toEqual([]);
    const audit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'order_marketplace_cancel_stop_review'`);
    expect(audit.rows[0].payload).toMatchObject({ omsAnswer: "stopped", errorCode: "DROPSHIP_EBAY_ORDER_CANCEL_REFUND_REFUSED" });
  });

  it("records sale lines and parks unknown lines once; proves a line on a previous number; asks the vendor once (§6.4, §7.3)", async () => {
    const effects = new PgDropshipEbayMarketplaceOrderEffects(pool);
    const listing = await insertListing({ variant: 101, itemNumber: "111" });
    const relisted = await insertListing({ variant: 102, itemNumber: "222" });
    await pool.query(`INSERT INTO dropship.dropship_listing_previous_marketplace_ids (listing_id, vendor_id, store_connection_id, external_listing_id,
      reason, replaced_at) VALUES ($1, $2, $3, '999', 'relisted', $4)`, [relisted, VENDOR, STORE, minutes(-500)]);
    const facts = {
      storeConnectionId: STORE, seenAt: T0,
      saleLines: [{ listingId: listing, externalOrderId: "O1", externalLineItemId: "L1", quantity: 2, orderedAt: minutes(-10) }],
      unmatchedLines: [
        { externalOrderId: "O2", externalLineItemId: "L1", externalListingId: "555", sku: "SKU-101", candidateListingId: listing, orderedAt: null },
        { externalOrderId: "O3", externalLineItemId: "L1", externalListingId: "999", sku: "SKU-102", candidateListingId: relisted, orderedAt: null },
      ],
    };

    expect(await effects.recordPollFacts(facts)).toEqual({ saleLinesRecorded: 1, linesParked: 2 });
    expect(await effects.recordPollFacts(facts)).toEqual({ saleLinesRecorded: 0, linesParked: 0 });
    const due = await pool.query(`SELECT id, marketplace_sync_attempted_at FROM dropship.dropship_vendor_listings ORDER BY id`);
    expect(due.rows.map((row) => row.marketplace_sync_attempted_at)).toEqual([null, null]);

    const parked = await effects.listOpenParkedLines({ storeConnectionId: STORE });
    expect(parked.map((line) => ({ order: line.externalOrderId, had: line.candidateHadItemNumber, readAt: line.candidateReadAt }))).toEqual([
      { order: "O2", had: false, readAt: null },
      { order: "O3", had: true, readAt: null },
    ]);
    expect(await effects.resolveParkedLines({ ids: [parked[1]!.id], resolution: "relinked", at: T0 })).toBe(1);
    expect(await effects.askAboutUnknownItem({ vendorId: VENDOR, storeConnectionId: STORE, externalListingId: "555", sku: "SKU-101", at: T0 }))
      .toBe(true);
    expect(await effects.askAboutUnknownItem({ vendorId: VENDOR, storeConnectionId: STORE, externalListingId: "555", sku: "SKU-101", at: minutes(5) }))
      .toBe(false);
    expect((await pool.query(`SELECT kind, subject_key FROM dropship.dropship_marketplace_sync_notices`)).rows)
      .toEqual([{ kind: "unknown_item_number", subject_key: "item:555" }]);
    expect(await effects.expireParkedLines({ now: new Date(T0.getTime() + 31 * 24 * 60 * 60_000) })).toBe(1);
    expect(await effects.startSalesLedger({ storeConnectionId: STORE, since: minutes(60) })).toBe(true);
    expect(await effects.startSalesLedger({ storeConnectionId: STORE, since: minutes(120) })).toBe(false);
  });

  it("ARCH-2/3: keeps a dead-lettered eBay cancel of an accepted order as review state: never checked or applied again, counted until a person clears it", async () => {
    const intake = await insertIntake({ externalOrderId: "DEAD", status: "accepted", omsOrderId: 904 });
    const effects = new PgDropshipEbayMarketplaceOrderEffects(pool);
    const check = { storeConnectionId: STORE, now: T0, limit: 50, acceptedWithinMs: 14 * 24 * 60 * 60_000, recheckAfterMs: 60 * 60_000 };
    expect((await effects.listAcceptedOrdersToCheck(check)).map((order) => order.intakeId)).toEqual([intake]);

    const longAgo = new Date(T0.getTime() - 8 * 24 * 60 * 60_000);
    expect(await effects.recordCancellationDeadLetter({ vendorId: VENDOR, storeConnectionId: STORE, externalOrderId: "DEAD",
      failureCode: "23514", message: "check violation", at: longAgo })).toBe(true);
    expect(await effects.recordCancellationDeadLetter({ vendorId: VENDOR, storeConnectionId: STORE, externalOrderId: "DEAD",
      failureCode: "23514", message: "check violation", at: T0 })).toBe(false);
    expect(await intakeRow(intake)).toMatchObject({ status: "accepted", cancellation_status: "marketplace_cancel_unprocessable",
      marketplace_cancelled_at: null });
    const audit = await pool.query(`SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'order_marketplace_cancel_unprocessable'`);
    expect(audit.rows).toEqual([{ payload: expect.objectContaining({ intakeId: intake, requiresReview: true,
      before: { cancellationStatus: null }, after: { cancellationStatus: "marketplace_cancel_unprocessable" } }) }]);

    expect(await effects.listAcceptedOrdersToCheck(check)).toEqual([]);
    expect(await effects.applyCancellation({ storeConnectionId: STORE, externalOrderId: "DEAD", at: T0 }))
      .toEqual({ action: "already_applied", intakeId: intake });
    expect(await intakeRow(intake)).toMatchObject({ cancellation_status: "marketplace_cancel_unprocessable", marketplace_cancelled_at: null });

    // Eight days later it is still counted: the state clears only when a person changes it.
    const dialect = new PgDialect();
    const health = DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((entry) => entry.code === "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE")!;
    const count = dialect.sqlToQuery(health.countSql);
    expect((await pool.query(count.sql, count.params)).rows[0].count).toBe(1);
    await pool.query(`UPDATE dropship.dropship_order_intake SET cancellation_status = NULL WHERE id = $1`, [intake]);
    expect((await pool.query(count.sql, count.params)).rows[0].count).toBe(0);
  });

  it("OR-3: writes one below-cost warning per listing per UTC day for accepted orders sold under the Card Shellz cost", async () => {
    const listing = await insertListing({ variant: 101, itemNumber: "111" });
    const notices = new PgDropshipBelowCostSaleNotices(pool);
    const lines = [{ listingId: listing, retailUnitPriceCents: 650, unitCostCents: 700, itemLabel: "Toploaders (SKU SKU-101)" }];
    expect(await notices.enqueue({ vendorId: VENDOR, storeConnectionId: STORE, intakeId: 1, lines, at: T0 })).toBe(1);
    expect(await notices.enqueue({ vendorId: VENDOR, storeConnectionId: STORE, intakeId: 2, lines, at: minutes(60) })).toBe(0);
    expect(await notices.enqueue({ vendorId: VENDOR, storeConnectionId: STORE, intakeId: 3, lines, at: minutes(24 * 60) })).toBe(1);
    expect((await pool.query(`SELECT kind, subject_key, payload->>'priceCents' AS price FROM dropship.dropship_marketplace_sync_notices ORDER BY id`)).rows)
      .toEqual([{ kind: "price_below_cost", subject_key: `below-cost:${listing}:2026-10-22`, price: "650" },
        { kind: "price_below_cost", subject_key: `below-cost:${listing}:2026-10-23`, price: "650" }]);
  });

  it("counts the order fixes' ops-health issues", async () => {
    const listing = await insertListing({ variant: 101, itemNumber: "111" });
    await insertIntake({ externalOrderId: "EXHAUSTED", status: "failed", attempts: 64 });
    await pool.query(`UPDATE dropship.dropship_order_intake SET rejection_reason = 'DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED: stopped'`);
    // An order placed on a listing that had ended before it (PR C, PLAN-C v4.1 §5.7, FID-3): failed with the code first.
    const ended = await insertIntake({ externalOrderId: "ENDED", status: "failed", attempts: 1 });
    // markIntakeFailure stores `${code}: ${message}` (dropship-order-processing.repository.ts).
    await pool.query(`UPDATE dropship.dropship_order_intake SET rejection_reason = $2 WHERE id = $1`,
      [ended, `${ORDER_LISTING_ENDED_BEFORE_ORDER_CODE}: ${ORDER_LISTING_ENDED_BEFORE_ORDER_MESSAGE}`]);
    await insertIntake({ externalOrderId: "REVIEW", status: "accepted", cancellationStatus: "marketplace_cancel_review", marketplaceCancelledAt: T0 });
    await new PgDropshipEbayMarketplaceOrderEffects(pool).recordPollFacts({ storeConnectionId: STORE, seenAt: T0, saleLines: [],
      unmatchedLines: [{ externalOrderId: "O9", externalLineItemId: "L1", externalListingId: "777", sku: "SKU-101", candidateListingId: listing,
        orderedAt: null }] });
    await new PgDropshipEbayMarketplaceOrderEffects(pool).recordCancellationDeadLetter({ vendorId: VENDOR, storeConnectionId: STORE,
      externalOrderId: "BAD", failureCode: "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", message: "x", at: new Date() });
    const dialect = new PgDialect();
    for (const code of ["DROPSHIP_ORDER_PROCESSING_RETRIES_EXHAUSTED", "DROPSHIP_ORDER_MARKETPLACE_CANCEL_REVIEW",
      "DROPSHIP_EBAY_ORDER_CANCEL_UNPROCESSABLE", "DROPSHIP_ORDER_UNMATCHED_LISTING", "DROPSHIP_ORDER_LISTING_ENDED_BEFORE_ORDER"]) {
      const check = DROPSHIP_MARKETPLACE_SYNC_HEALTH_CHECKS.find((entry) => entry.code === code)!;
      const count = dialect.sqlToQuery(check.countSql);
      expect((await pool.query(count.sql, count.params)).rows[0].count, code).toBe(1);
      const sample = dialect.sqlToQuery(check.sampleSql);
      expect((await pool.query(sample.sql, sample.params)).rows, code).toHaveLength(1);
    }
  });
});

function intakeInput(externalOrderId: string, status: "received" | "rejected", shipTo: { city: string }): DropshipOrderIntakeRepositoryInput {
  const base = {
    vendorId: VENDOR, storeConnectionId: STORE, platform: "ebay" as const, externalOrderId, idempotencyKey: `dropship:ebay:intake:${STORE}:${externalOrderId}`,
    rawPayload: { orderId: externalOrderId, city: shipTo.city },
    normalizedPayload: { lines: [{ externalLineItemId: "L1", externalListingId: "111", quantity: 1 }], shipTo },
  };
  return {
    ...base, payloadHash: hashDropshipOrderIntakePayload({ rawPayload: base.rawPayload, normalizedPayload: base.normalizedPayload }), status,
    rejectionReason: status === "rejected" ? "paused" : null,
    cancellationStatus: status === "rejected" ? "order_intake_rejected" : null, receivedAt: T0,
  };
}
