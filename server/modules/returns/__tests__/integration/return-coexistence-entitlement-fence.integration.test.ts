import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const dbHoisted = vi.hoisted(() => {
  const state: {
    pool: Pool | null;
  } = {
    pool: null,
  };

  const requirePool = (): Pool => {
    if (!state.pool) {
      throw new Error("Disposable PostgreSQL pool has not been initialized.");
    }
    return state.pool;
  };

  return { state, requirePool };
});

vi.mock("../../../../db", async () => {
  const pgModule = await import("pg");
  const { drizzle: createDrizzle } = await import("drizzle-orm/node-postgres");
  const fullSchema = await import("@shared/schema");
  const poolProxy = Object.assign(Object.create(pgModule.default.Pool.prototype), {
    query: (...args: unknown[]) =>
      (dbHoisted.requirePool().query as (...params: unknown[]) => unknown)(...args),
    connect: (...args: unknown[]) =>
      (dbHoisted.requirePool().connect as (...params: unknown[]) => unknown)(...args),
    end: () => dbHoisted.requirePool().end(),
    on: () => poolProxy,
  }) as Pool;
  return {
    pool: poolProxy,
    db: createDrizzle(poolProxy, { schema: fullSchema }),
  };
});

import { computeDropshipReturnSettlement } from "../../../dropship/domain/return-fee-engine";
import { PgDropshipNoInspectionReviewRepository } from "../../../dropship/infrastructure/dropship-no-inspection-review.repository";
import { PgDropshipReturnRepository } from "../../../dropship/infrastructure/dropship-return.repository";
import {
  OpenReturnCaseService,
  type OpenReturnCaseInput,
} from "../../application/open-return-case.service";
import type {
  ReturnFinancialCaseSource,
  VendorSettlementQuote,
} from "../../application/return-case-financial.service";
import { PostgresOpenReturnCaseStore } from "../../infrastructure/open-return-case.repository";
import {
  PostgresReturnCaseFinancialSourceStore,
  PostgresReturnCaseVendorSettlementStore,
} from "../../infrastructure/return-case-financial.repository";
import { createIntakeTestSchema } from "../support/customer-return-intake-database";

const enabled =
  Boolean(process.env.ECHELON_TEST_DATABASE_URL) &&
  process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";

function assertLoopbackDisposableUrl(raw: string | undefined): URL {
  if (!raw || process.env.ECHELON_TEST_DATABASE_DISPOSABLE !== "true") {
    throw new Error("Coexistence integration tests require an explicitly disposable database URL.");
  }
  const parsed = new URL(raw);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("Coexistence integration tests only run against a loopback PostgreSQL server.");
  }
  return parsed;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TEST_NOW = new Date("2026-10-15T12:00:00.000Z");
const CHANNEL_ID = 36;
const VENDOR_ID = 11;
const STORE_CONNECTION_ID = 21;
const PRODUCT_VARIANT_ID = 501;

describe.skipIf(!enabled).sequential(
  "Canonical ReturnCase and legacy dropship RMA coexistence entitlement & settlement fence (CF-F09 / CF-B8)",
  () => {
    const databaseName = `returns_coexistence_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    let adminPool: Pool;
    let testPool: Pool;
    let openService: OpenReturnCaseService;
    let openStore: PostgresOpenReturnCaseStore;
    let dropshipRepo: PgDropshipReturnRepository;
    let noInspectionRepo: PgDropshipNoInspectionReviewRepository;
    let vendorSettlementStore: PostgresReturnCaseVendorSettlementStore;

    beforeAll(async () => {
      const adminUrl = assertLoopbackDisposableUrl(process.env.ECHELON_TEST_DATABASE_URL);
      adminPool = new Pool({ connectionString: adminUrl.toString(), max: 2 });
      await adminPool.query(`CREATE DATABASE "${databaseName}"`);

      const testUrl = new URL(adminUrl.toString());
      testUrl.pathname = `/${databaseName}`;
      testPool = new Pool({
        connectionString: testUrl.toString(),
        max: 8,
        connectionTimeoutMillis: 5_000,
        statement_timeout: 15_000,
      });

      dbHoisted.state.pool = testPool;

      await createIntakeTestSchema(testPool);
      await testPool.query(
        readFileSync(resolve("migrations", "111_oms_wms_fulfillment_partitions.sql"), "utf8"),
      );

      await testPool.query(`
        CREATE TABLE IF NOT EXISTS public.audit_events (
          id BIGSERIAL PRIMARY KEY,
          timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
          level TEXT NOT NULL DEFAULT 'AUDIT',
          actor TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT,
          changes JSONB,
          context JSONB
        );
        CREATE SCHEMA IF NOT EXISTS membership;
        CREATE TABLE IF NOT EXISTS membership.members (id varchar(255) PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS membership.member_subscriptions (id varchar(255) PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS membership.plans (id varchar(255) PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS catalog.product_lines (id integer PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS catalog.products (id integer PRIMARY KEY);
        DROP TABLE IF EXISTS dropship.dropship_order_intake, dropship.dropship_store_connections, dropship.dropship_vendors CASCADE;
      `);

      for (const migrationFile of [
        "0086_dropship_v2_foundation.sql",
        "0087_dropship_auth_identity.sql",
        "0097_dropship_returns_notifications.sql",
        "0100_dropship_rma_status_updates.sql",
        "0105_dropship_return_policy_config.sql",
        "186_dropship_return_policy_foundation.sql",
        "190_dropship_rma_state_fees.sql",
        "191_dropship_collection_sweep_noinspection.sql",
        "192_dropship_return_channel_intake.sql",
        "193_dropship_rma_order_line_items.sql",
        "194_dropship_system_rma_numbers.sql",
        "0611_dropship_rma_per_fee_responsibility.sql",
      ]) {
        await testPool.query(readFileSync(resolve("migrations", migrationFile), "utf8"));
      }

      await testPool.query(`
        ALTER TABLE dropship.dropship_wallet_ledger
          ADD COLUMN IF NOT EXISTS rewards_balance_after_cents bigint;

        ALTER TABLE returns.return_cases
          ADD CONSTRAINT return_cases_vendor_id_fkey
          FOREIGN KEY (vendor_id) REFERENCES dropship.dropship_vendors(id);
        ALTER TABLE returns.return_cases
          ADD CONSTRAINT return_cases_store_connection_id_fkey
          FOREIGN KEY (store_connection_id) REFERENCES dropship.dropship_store_connections(id);

        DROP TABLE IF EXISTS
          returns.return_case_inventory_treatment_items,
          returns.return_case_inventory_treatments,
          returns.return_case_customer_refunds,
          returns.return_case_disposition_items,
          returns.return_case_dispositions,
          returns.return_case_inspections
        CASCADE;
      `);

      for (const returnsMigration of [
        "200_return_case_operations.sql",
        "201_return_case_inspection_completion.sql",
        "203_return_case_dispositions.sql",
        "204_return_case_inventory_treatments.sql",
        "207_return_case_financial_actions.sql",
      ]) {
        await testPool.query(readFileSync(resolve("migrations", returnsMigration), "utf8"));
      }

      openStore = new PostgresOpenReturnCaseStore();
      openService = new OpenReturnCaseService(openStore, () => new Date(TEST_NOW));
      dropshipRepo = new PgDropshipReturnRepository(testPool);
      noInspectionRepo = new PgDropshipNoInspectionReviewRepository(testPool);
      vendorSettlementStore = new PostgresReturnCaseVendorSettlementStore();
    });

    afterAll(async () => {
      dbHoisted.state.pool = null;
      await testPool?.end();
      if (adminPool) {
        await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
        await adminPool.end();
      }
    });

    async function seedDropshipOrderFixture(options: { quantity: number }) {
      const qty = options.quantity;
      await testPool.query(`
        TRUNCATE
          public.audit_events,
          channels.channels,
          channels.channel_connections,
          catalog.product_variants,
          oms.oms_orders,
          oms.oms_order_lines,
          wms.orders,
          wms.order_items,
          wms.returns,
          wms.return_items,
          returns.return_policies,
          returns.return_cases,
          returns.customer_return_authorizations,
          membership.members,
          dropship.dropship_vendors,
          dropship.dropship_store_connections,
          dropship.dropship_order_intake,
          dropship.dropship_order_economics_snapshots,
          dropship.dropship_wallet_accounts,
          dropship.dropship_wallet_ledger,
          dropship.dropship_insurance_pool_ledger,
          dropship.dropship_rmas,
          dropship.dropship_rma_items,
          dropship.dropship_rma_inspections,
          dropship.dropship_rma_status_updates,
          dropship.dropship_audit_events
        RESTART IDENTITY CASCADE;
      `);

      await testPool.query(`
        INSERT INTO membership.members (id) VALUES ('member-coexistence-1');

        INSERT INTO channels.channels (id, name, type, provider, status)
        OVERRIDING SYSTEM VALUE
        VALUES (${CHANNEL_ID}, 'Dropship Marketplace Channel', 'internal', 'ebay', 'active');

        INSERT INTO catalog.product_variants (id, product_id, name, sku, weight_grams)
        OVERRIDING SYSTEM VALUE
        VALUES (${PRODUCT_VARIANT_ID}, 1, 'Pro Toploader 25ct', 'TL-25', 120);

        INSERT INTO dropship.dropship_vendors (id, member_id, business_name, email, status, entitlement_status)
        OVERRIDING SYSTEM VALUE
        VALUES (${VENDOR_ID}, 'member-coexistence-1', 'Alpha Cards LLC', 'ops@alphacards.test', 'active', 'active');

        INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, external_account_id, status, setup_status)
        OVERRIDING SYSTEM VALUE
        VALUES (${STORE_CONNECTION_ID}, ${VENDOR_ID}, 'ebay', 'ebay-acct-1', 'connected', 'complete');

        INSERT INTO oms.oms_orders (
          id, channel_id, external_order_id, external_order_number,
          customer_name, customer_email, fulfillment_status, currency, ordered_at, ship_to_country
        )
        OVERRIDING SYSTEM VALUE
        VALUES (100, ${CHANNEL_ID}, 'EBAY-ORD-100', '#DS-100', 'Buyer One', 'buyer@example.com', 'fulfilled', 'USD', '2026-10-01T10:00:00Z', 'US');

        INSERT INTO oms.oms_order_lines (
          id, order_id, product_variant_id, external_line_item_id, title, sku, quantity, requires_shipping
        )
        OVERRIDING SYSTEM VALUE
        VALUES (101, 100, ${PRODUCT_VARIANT_ID}, 'LINE-500', 'Pro Toploader 25ct', 'TL-25', ${qty}, true);

        INSERT INTO wms.orders (
          id, oms_fulfillment_order_id, channel_id, source, external_order_id, order_number,
          fulfillment_partition_key, customer_name, warehouse_status
        )
        OVERRIDING SYSTEM VALUE
        VALUES (201, '100', ${CHANNEL_ID}, 'oms', 'EBAY-ORD-100', 'WMS-DS-100', 'p-1', 'Buyer One', 'shipped');

        INSERT INTO wms.order_items (
          id, order_id, oms_order_line_id, source_item_id,
          sku, name, quantity, fulfilled_quantity, paid_price_cents, requires_shipping
        )
        OVERRIDING SYSTEM VALUE
        VALUES (301, 201, 101, 'LINE-500', 'TL-25', 'Pro Toploader 25ct', ${qty}, ${qty}, 1000, 1);

        INSERT INTO returns.return_policies (
          id, name, scope_kind, scope_key, business_context, version, status,
          return_window_days, return_destination, approval_authority, label_provider,
          return_shipping_payer, inspection_requirement, inspection_owner,
          customer_refund_authority, vendor_settlement_trigger, returnless_refund_allowed, created_by
        )
        OVERRIDING SYSTEM VALUE
        VALUES (
          1, 'Dropship Default Return Policy', 'business_context', 'context:dropship', 'dropship', 1, 'active',
          30, 'card_shellz', 'card_shellz', 'vendor',
          'vendor', 'required', 'card_shellz',
          'vendor', 'inspection_approved', false, 'admin:seed'
        );
        SELECT setval(pg_get_serial_sequence('returns.return_policies', 'id'), 1, true);
      `);

      const normalizedPayload = {
        lines: [
          {
            externalLineItemId: "LINE-500",
            productVariantId: PRODUCT_VARIANT_ID,
            sku: "TL-25",
            quantity: qty,
          },
        ],
      };

      const intakeInsert = await testPool.query<{ id: number }>(
        `INSERT INTO dropship.dropship_order_intake (
           id, channel_id, vendor_id, store_connection_id, platform,
           external_order_id, external_order_number, status,
           normalized_payload, oms_order_id, received_at, accepted_at, updated_at
         )
         OVERRIDING SYSTEM VALUE
         VALUES (
           401, $1, $2, $3, 'ebay',
           'EBAY-ORD-100', '#DS-100', 'accepted',
           $4::jsonb, 100, '2026-10-01T10:00:00Z', '2026-10-01T10:05:00Z', '2026-10-01T10:05:00Z'
         )
         RETURNING id`,
        [CHANNEL_ID, VENDOR_ID, STORE_CONNECTION_ID, JSON.stringify(normalizedPayload)],
      );

      const pricingSnapshot = {
        wholesale: {
          lines: [
            {
              productVariantId: PRODUCT_VARIANT_ID,
              wholesaleUnitCostCents: 600,
              quantity: qty,
            },
          ],
        },
      };

      await testPool.query(
        `INSERT INTO dropship.dropship_order_economics_snapshots (
           intake_id, oms_order_id, vendor_id, store_connection_id, member_id,
           currency, retail_subtotal_cents, wholesale_subtotal_cents, shipping_cents,
           insurance_pool_cents, fees_cents, total_debit_cents, pricing_snapshot
         )
         VALUES ($1, 100, $2, $3, 'member-coexistence-1', 'USD', $4, $5, 400, 50, 0, $6, $7::jsonb)`,
        [
          intakeInsert.rows[0].id,
          VENDOR_ID,
          STORE_CONNECTION_ID,
          qty * 1000,
          qty * 600,
          qty * 600 + 400 + 50,
          JSON.stringify(pricingSnapshot),
        ],
      );

      return {
        omsOrderId: 100,
        wmsOrderId: 201,
        wmsOrderItemId: 301,
        intakeId: 401,
      };
    }

    function buildOpenCanonicalInput(
      quantity: number,
      idempotencyKey = `open-case-${randomUUID()}`,
    ): OpenReturnCaseInput {
      return {
        idempotencyKey,
        actor: "admin:coexistence-test",
        omsOrderId: 100,
        wmsOrderId: 201,
        reasonCode: "damaged",
        notes: "Coexistence integration test",
        items: [{ wmsOrderItemId: 301, quantity }],
      };
    }

    function buildCreateLegacyRmaInput(
      quantity: number,
      idempotencyKey = `legacy-rma-${randomUUID()}`,
    ) {
      return {
        vendorId: VENDOR_ID,
        storeConnectionId: STORE_CONNECTION_ID,
        intakeId: 401,
        omsOrderId: 100,
        reasonCode: "damaged" as const,
        faultCategory: "card_shellz" as const,
        returnWindowDays: 30,
        policyVersionId: null,
        labelSource: "vendor" as const,
        returnTrackingNumber: null,
        vendorNotes: "Legacy RMA coexistence test",
        items: [
          {
            source: "order" as const,
            status: "requested" as const,
            orderLineIndex: 0,
            productVariantId: PRODUCT_VARIANT_ID,
            externalLineItemId: "LINE-500",
            quantity,
          },
        ],
        idempotencyKey,
        requestHash: sha256Hex(`${idempotencyKey}:${quantity}`),
        actor: { actorType: "admin" as const, actorId: "admin:coexistence-test" },
        now: TEST_NOW,
      };
    }

    async function prepareCanonicalCaseForVendorSettlement(caseId: number, quantity: number): Promise<ReturnFinancialCaseSource> {
      const itemRow = (
        await testPool.query<{
          id: string;
          wms_return_item_id: number;
          oms_order_line_id: string | null;
          external_line_item_id: string | null;
          product_variant_id: number | null;
          sku: string | null;
          title: string | null;
        }>(
          `SELECT rci.id, rci.wms_return_item_id, rci.oms_order_line_id, rci.external_line_item_id,
                  ol.product_variant_id, rci.sku, rci.title
           FROM returns.return_case_items rci
           LEFT JOIN oms.oms_order_lines ol ON ol.id = rci.oms_order_line_id
           WHERE rci.return_case_id = $1`,
          [caseId],
        )
      ).rows[0];

      const caseHeader = (
        await testPool.query<{ case_number: string; wms_return_id: number }>(
          `SELECT case_number, wms_return_id FROM returns.return_cases WHERE id = $1`,
          [caseId],
        )
      ).rows[0];

      const client = await testPool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE wms.returns SET status = 'received', received_at = $2 WHERE id = $1`,
          [caseHeader.wms_return_id, TEST_NOW],
        );
        await client.query(
          `UPDATE wms.return_items SET received_qty = $2 WHERE id = $1`,
          [itemRow.wms_return_item_id, quantity],
        );

        const inspectionInsert = await client.query<{ id: string }>(
          `INSERT INTO returns.return_case_inspections (
             return_case_id, status, started_at, started_by, completed_at, completed_by
           ) VALUES ($1, 'approved', $2, 'admin:test', $2, 'admin:test')
           RETURNING id`,
          [caseId, TEST_NOW],
        );

        await client.query(
          `UPDATE returns.return_cases
           SET logistics_status = 'received',
               inspection_status = 'approved',
               vendor_settlement_status = 'eligible',
               updated_at = $2
           WHERE id = $1`,
          [caseId, TEST_NOW],
        );

        const dispositionInsert = await client.query<{ id: string }>(
          `INSERT INTO returns.return_case_dispositions (
             return_case_id, inspection_id, inspection_resolution,
             idempotency_key, request_hash, recorded_by, recorded_at
           ) VALUES ($1, $2, 'approved', $3, $4, 'admin:test', $5)
           RETURNING id`,
          [
            caseId,
            Number(inspectionInsert.rows[0].id),
            `disp-${caseId}`,
            sha256Hex(`disp-${caseId}`),
            TEST_NOW,
          ],
        );

        await client.query(
          `INSERT INTO returns.return_case_disposition_items (
             disposition_id, return_case_item_id, treatment, quantity
           ) VALUES ($1, $2, 'restock_sellable', $3)`,
          [Number(dispositionInsert.rows[0].id), Number(itemRow.id), quantity],
        );

        await client.query(
          `INSERT INTO returns.return_case_commands (
             return_case_id, command_type, idempotency_key, request_hash, response, actor, created_at
           ) VALUES ($1, 'record_disposition', $2, $3, $4::jsonb, 'admin:test', $5)`,
          [
            caseId,
            `disp-${caseId}`,
            sha256Hex(`disp-${caseId}`),
            JSON.stringify({ dispositionId: Number(dispositionInsert.rows[0].id) }),
            TEST_NOW,
          ],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const loaded = await new PostgresReturnCaseFinancialSourceStore().loadCase(caseId);
      if (!loaded) {
        throw new Error(`Expected canonical ReturnCase ${caseId} to load from financial source store.`);
      }
      return loaded;
    }

    function buildVendorSettlementQuote(quantity: number): VendorSettlementQuote {
      const settlement = computeDropshipReturnSettlement({
        faultCategory: "card_shellz",
        acceptedLines: [
          {
            productVariantId: PRODUCT_VARIANT_ID,
            acceptedQuantity: quantity,
            wholesaleUnitCostCents: 600,
          },
        ],
        originalShippingCents: 400,
        returnShippingActualCents: null,
        fees: {
          restockingFee: null,
          processingFee: null,
          returnShippingFee: null,
        },
      });
      return {
        currency: "USD",
        faultCategory: "card_shellz",
        returnShippingActualCents: null,
        settlement,
        policyFeeIds: {
          restockingFeeId: null,
          processingFeeId: null,
          returnShippingFeeId: null,
        },
      };
    }

    beforeEach(async () => {
      await seedDropshipOrderFixture({ quantity: 2 });
    });

    it("deducts canonical ReturnCase claims when creating legacy dropship RMAs and preserves same-key replay", async () => {
      const opened = await openService.open(buildOpenCanonicalInput(1, "canon-first-1"));
      expect(opened.replayed).toBe(false);

      await expect(
        dropshipRepo.createRma(buildCreateLegacyRmaInput(2, "legacy-overclaim-2")),
      ).rejects.toMatchObject({
        code: "DROPSHIP_RETURN_QUANTITY_EXCEEDED",
        context: expect.objectContaining({
          orderedQuantity: 2,
          alreadyClaimedQuantity: 1,
          requestedQuantity: 2,
          remainingQuantity: 1,
        }),
      });

      const validLegacyInput = buildCreateLegacyRmaInput(1, "legacy-remaining-1");
      const createdLegacy = await dropshipRepo.createRma(validLegacyInput);
      expect(createdLegacy.idempotentReplay).toBe(false);
      expect(createdLegacy.rma.items).toHaveLength(1);
      expect(createdLegacy.rma.items[0].quantity).toBe(1);

      // Idempotent replay with the same key must still return the created RMA cleanly even at 0 remaining units.
      const replayedLegacy = await dropshipRepo.createRma(validLegacyInput);
      expect(replayedLegacy.idempotentReplay).toBe(true);
      expect(replayedLegacy.rma.rmaId).toBe(createdLegacy.rma.rmaId);

      // Both units are now claimed across the two models; canonical search hides fully claimed orders.
      const searchAfterBoth = await openService.searchSourceOrders({
        search: "EBAY-ORD-100",
        channelId: null,
        page: 1,
        limit: 20,
      });
      expect(searchAfterBoth.orders).toHaveLength(0);
    });

    it("deducts active or credited legacy dropship RMAs from canonical ReturnCase eligibility and restores rejected uncredited RMAs", async () => {
      const createdLegacy = await dropshipRepo.createRma(buildCreateLegacyRmaInput(1, "legacy-first-1"));
      const rmaId = createdLegacy.rma.rmaId;

      const detailWhileRequested = await openService.getSourceOrder(100);
      expect(detailWhileRequested.partitions[0]?.items[0]).toMatchObject({
        fulfilledQuantity: 2,
        alreadyExpectedQuantity: 1,
        returnableQuantity: 1,
      });

      await expect(
        openService.open(buildOpenCanonicalInput(2, "canon-overclaim-2")),
      ).rejects.toMatchObject({
        code: "RETURN_CASE_QUANTITY_UNAVAILABLE",
        status: 409,
      });

      // Terminal uncredited rejection releases the legacy claim.
      await testPool.query(
        `UPDATE dropship.dropship_rmas SET status = 'rejected', credited_at = NULL WHERE id = $1`,
        [rmaId],
      );
      const detailAfterReject = await openService.getSourceOrder(100);
      expect(detailAfterReject.partitions[0]?.items[0]).toMatchObject({
        fulfilledQuantity: 2,
        alreadyExpectedQuantity: 0,
        returnableQuantity: 2,
      });

      // Terminal closed RMA that WAS credited keeps the unit permanently consumed.
      await testPool.query(
        `UPDATE dropship.dropship_rmas SET status = 'closed', credited_at = $2 WHERE id = $1`,
        [rmaId, TEST_NOW],
      );
      const detailAfterCreditedClose = await openService.getSourceOrder(100);
      expect(detailAfterCreditedClose.partitions[0]?.items[0]).toMatchObject({
        fulfilledQuantity: 2,
        alreadyExpectedQuantity: 1,
        returnableQuantity: 1,
      });

      const openedRemaining = await openService.open(buildOpenCanonicalInput(1, "canon-remaining-1"));
      expect(openedRemaining.caseId).toBeGreaterThan(0);
    });

    it("serializes concurrent canonical ReturnCase open and legacy dropship RMA create on a 1-unit order with zero over-claim", async () => {
      await seedDropshipOrderFixture({ quantity: 1 });

      const [canonicalOutcome, legacyOutcome] = await Promise.allSettled([
        openService.open(buildOpenCanonicalInput(1, "race-canonical-1")),
        dropshipRepo.createRma(buildCreateLegacyRmaInput(1, "race-legacy-1")),
      ]);

      const fulfilledCount = [canonicalOutcome, legacyOutcome].filter(
        (outcome) => outcome.status === "fulfilled",
      ).length;
      const rejectedOutcomes = [canonicalOutcome, legacyOutcome].filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );

      expect(fulfilledCount).toBe(1);
      expect(rejectedOutcomes).toHaveLength(1);
      expect(["DROPSHIP_RETURN_QUANTITY_EXCEEDED", "RETURN_SOURCE_PARTITION_NOT_FOUND"]).toContain(
        (rejectedOutcomes[0].reason as { code?: string })?.code,
      );

      const totalClaimedCheck = await testPool.query<{
        canonical_units: number;
        legacy_units: number;
      }>(`
        SELECT
          COALESCE((SELECT SUM(quantity)::int FROM returns.return_case_items), 0) AS canonical_units,
          COALESCE((SELECT SUM(quantity)::int FROM dropship.dropship_rma_items), 0) AS legacy_units
      `);
      expect(
        totalClaimedCheck.rows[0].canonical_units + totalClaimedCheck.rows[0].legacy_units,
      ).toBe(1);
    });

    it("blocks double vendor wallet settlement in both directions on pre-existing split return records", async () => {
      // Direction 1: Canonical vendor settlement completes first -> legacy inspection & no-inspection approval both block.
      await seedDropshipOrderFixture({ quantity: 1 });
      const canonicalCase = await openService.open(buildOpenCanonicalInput(1, "split-canon-1"));

      // Insert a pre-existing historical un-adopted legacy RMA row directly (simulating pre-fence split state).
      const preExistingRma = await testPool.query<{ id: number }>(
        `INSERT INTO dropship.dropship_rmas (
           vendor_id, store_connection_id, intake_id, oms_order_id,
           status, reason_code, fault_category, return_window_days,
           requested_at, received_at, updated_at, idempotency_key, request_hash
         )
         VALUES ($1, $2, 401, 100, 'inspecting', 'damaged', 'card_shellz', 30, $3, $3, $3, 'hist-rma-1', $4)
         RETURNING id`,
        [VENDOR_ID, STORE_CONNECTION_ID, TEST_NOW, sha256Hex("hist-rma-1")],
      );
      const rmaId1 = preExistingRma.rows[0].id;
      const preExistingItem = await testPool.query<{ id: number }>(
        `INSERT INTO dropship.dropship_rma_items (
           rma_id, product_variant_id, source, order_line_index, external_line_item_id, quantity, status, created_at
         )
         VALUES ($1, $2, 'order', 0, 'LINE-500', 1, 'requested', $3)
         RETURNING id`,
        [rmaId1, PRODUCT_VARIANT_ID, TEST_NOW],
      );

      const source1 = await prepareCanonicalCaseForVendorSettlement(canonicalCase.caseId, 1);
      const quote1 = buildVendorSettlementQuote(1);
      const settledCanonical = await vendorSettlementStore.settle({
        source: source1,
        quote: quote1,
        quoteHash: sha256Hex("quote-1"),
        requestHash: sha256Hex("req-1"),
        idempotencyKey: "settle-canon-first-1",
        notes: "Canonical settlement wins",
        actor: "admin:finance",
        now: TEST_NOW,
      });
      expect(settledCanonical.grossCreditCents).toBe(1000);

      await expect(
        dropshipRepo.processInspection({
          rmaId: rmaId1,
          outcome: "approved",
          faultCategory: "card_shellz",
          notes: "Attempt duplicate legacy inspection settlement",
          photos: [],
          creditCents: 1000,
          feeCents: 0,
          settlement: {
            creditLedgerType: quote1.settlement.creditLedgerType,
            breakdown: quote1.settlement.breakdown,
            computed: quote1.settlement,
            policyVersionId: null,
            overrideReason: null,
          },
          items: [
            {
              rmaItemId: preExistingItem.rows[0].id,
              status: "approved",
              finalCreditCents: 600,
              feeCents: 0,
            },
          ],
          idempotencyKey: "legacy-inspect-blocked-1",
          requestHash: sha256Hex("legacy-inspect-blocked-1"),
          actor: { actorType: "admin", actorId: "admin:ops" },
          now: TEST_NOW,
        }),
      ).rejects.toMatchObject({
        code: "DROPSHIP_RETURN_CANONICAL_SETTLEMENT_CONFLICT",
      });

      await testPool.query(
        `UPDATE dropship.dropship_rmas SET status = 'no_inspection_review' WHERE id = $1`,
        [rmaId1],
      );
      await expect(
        noInspectionRepo.approveReview({
          rmaId: rmaId1,
          vendorId: VENDOR_ID,
          creditCents: 1000,
          currency: "USD",
          reason: "Attempt duplicate no-inspection credit",
          policyVersionId: null,
          idempotencyKey: "legacy-no-insp-blocked-1",
          requestHash: sha256Hex("legacy-no-insp-blocked-1"),
          actor: { actorType: "admin", actorId: "admin:ops" },
          now: TEST_NOW,
        }),
      ).rejects.toMatchObject({
        code: "DROPSHIP_RETURN_CANONICAL_SETTLEMENT_CONFLICT",
      });

      const ledgerAfterDirection1 = await testPool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM dropship.dropship_wallet_ledger WHERE vendor_id = $1`,
        [VENDOR_ID],
      );
      expect(ledgerAfterDirection1.rows[0].count).toBe(1);

      // Direction 2: Legacy RMA inspection credits vendor first -> canonical vendor settlement blocks with 409.
      await seedDropshipOrderFixture({ quantity: 1 });
      const canonicalCase2 = await openService.open(buildOpenCanonicalInput(1, "split-canon-2"));
      const preExistingRma2 = await testPool.query<{ id: number }>(
        `INSERT INTO dropship.dropship_rmas (
           vendor_id, store_connection_id, intake_id, oms_order_id,
           status, reason_code, fault_category, return_window_days,
           requested_at, received_at, updated_at, idempotency_key, request_hash
         )
         VALUES ($1, $2, 401, 100, 'inspecting', 'damaged', 'card_shellz', 30, $3, $3, $3, 'hist-rma-2', $4)
         RETURNING id`,
        [VENDOR_ID, STORE_CONNECTION_ID, TEST_NOW, sha256Hex("hist-rma-2")],
      );
      const rmaId2 = preExistingRma2.rows[0].id;
      const preExistingItem2 = await testPool.query<{ id: number }>(
        `INSERT INTO dropship.dropship_rma_items (
           rma_id, product_variant_id, source, order_line_index, external_line_item_id, quantity, status, created_at
         )
         VALUES ($1, $2, 'order', 0, 'LINE-500', 1, 'requested', $3)
         RETURNING id`,
        [rmaId2, PRODUCT_VARIANT_ID, TEST_NOW],
      );

      const source2 = await prepareCanonicalCaseForVendorSettlement(canonicalCase2.caseId, 1);
      const quote2 = buildVendorSettlementQuote(1);

      const legacySettled = await dropshipRepo.processInspection({
        rmaId: rmaId2,
        outcome: "approved",
        faultCategory: "card_shellz",
        notes: "Legacy inspection settles first",
        photos: [],
        creditCents: 1000,
        feeCents: 0,
        settlement: {
          creditLedgerType: quote2.settlement.creditLedgerType,
          breakdown: quote2.settlement.breakdown,
          computed: quote2.settlement,
          policyVersionId: null,
          overrideReason: null,
        },
        items: [
          {
            rmaItemId: preExistingItem2.rows[0].id,
            status: "approved",
            finalCreditCents: 600,
            feeCents: 0,
          },
        ],
        idempotencyKey: "legacy-inspect-first-2",
        requestHash: sha256Hex("legacy-inspect-first-2"),
        actor: { actorType: "admin", actorId: "admin:ops" },
        now: TEST_NOW,
      });
      expect(legacySettled.rma.status).toBe("credited");

      await expect(
        vendorSettlementStore.settle({
          source: source2,
          quote: quote2,
          quoteHash: sha256Hex("quote-2"),
          requestHash: sha256Hex("req-2"),
          idempotencyKey: "settle-canon-blocked-2",
          notes: "Attempt duplicate canonical vendor settlement",
          actor: "admin:finance",
          now: TEST_NOW,
        }),
      ).rejects.toMatchObject({
        code: "RETURN_VENDOR_SETTLEMENT_LEGACY_CONFLICT",
        status: 409,
      });

      const canonicalSettlementCount = await testPool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM returns.return_case_vendor_settlements`,
      );
      expect(canonicalSettlementCount.rows[0].count).toBe(0);

      const ledgerAfterDirection2 = await testPool.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM dropship.dropship_wallet_ledger WHERE vendor_id = $1`,
        [VENDOR_ID],
      );
      expect(ledgerAfterDirection2.rows[0].count).toBe(1);
    });
  },
);
