import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import pg from "pg";
import { PgDropshipCarrierClaimRepository } from "../../infrastructure/dropship-carrier-claim.repository";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const describeWithDb = TEST_DB_URL ? describe : describe.skip;
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0086_dropship_v2_foundation.sql"),
  "utf8",
);
const adminCommandMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0101_dropship_shipping_admin_config.sql"),
  "utf8",
);
const carrierProtectionMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0585_dropship_carrier_protection_policies.sql"),
  "utf8",
);
const carrierClaimMigrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0586_dropship_carrier_claim_intake.sql"),
  "utf8",
);

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

async function expectDatabaseError(
  client: pg.PoolClient,
  operation: () => Promise<unknown>,
  code: string,
) {
  await client.query("SAVEPOINT dropship_constraint_check");
  let error: unknown;
  try {
    await operation();
  } catch (err) {
    error = err;
  }
  await client.query("ROLLBACK TO SAVEPOINT dropship_constraint_check");
  await client.query("RELEASE SAVEPOINT dropship_constraint_check");

  expect(error).toBeTruthy();
  expect((error as { code?: string }).code).toBe(code);
}

async function createMinimalDependencies(client: pg.PoolClient) {
  await client.query(`
    CREATE SCHEMA IF NOT EXISTS membership;
    CREATE SCHEMA IF NOT EXISTS catalog;
    CREATE SCHEMA IF NOT EXISTS channels;
    CREATE SCHEMA IF NOT EXISTS warehouse;
    CREATE SCHEMA IF NOT EXISTS wms;
    CREATE SCHEMA IF NOT EXISTS oms;

    CREATE TABLE IF NOT EXISTS membership.members (
      id varchar PRIMARY KEY,
      email text
    );

    CREATE TABLE IF NOT EXISTS membership.plans (
      id varchar PRIMARY KEY,
      name text,
      includes_dropship boolean
    );

    CREATE TABLE IF NOT EXISTS membership.member_subscriptions (
      id varchar PRIMARY KEY,
      member_id varchar REFERENCES membership.members(id),
      plan_id varchar REFERENCES membership.plans(id),
      status text
    );

    CREATE TABLE IF NOT EXISTS catalog.product_lines (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      code varchar(50) UNIQUE NOT NULL,
      name varchar(100) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS catalog.products (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      sku varchar(100),
      name text NOT NULL,
      category varchar(100),
      is_active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS catalog.product_variants (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      product_id integer NOT NULL REFERENCES catalog.products(id),
      sku varchar(100),
      name text NOT NULL,
      units_per_variant integer NOT NULL DEFAULT 1,
      is_active boolean NOT NULL DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS channels.channels (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      name varchar(100) NOT NULL,
      type varchar(20) NOT NULL DEFAULT 'internal',
      provider varchar(30) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending_setup',
      is_default integer NOT NULL DEFAULT 0,
      priority integer NOT NULL DEFAULT 0,
      allocation_pct integer,
      allocation_fixed_qty integer,
      sync_enabled boolean DEFAULT false,
      sync_mode varchar(10) DEFAULT 'dry_run'
    );

    CREATE TABLE IF NOT EXISTS warehouse.warehouses (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      code varchar(20) UNIQUE NOT NULL,
      name varchar(200) NOT NULL
    );

    CREATE TABLE IF NOT EXISTS wms.orders (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      oms_fulfillment_order_id varchar(128),
      warehouse_status varchar(40) NOT NULL DEFAULT 'ready'
    );

    CREATE TABLE IF NOT EXISTS wms.outbound_shipments (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      order_id integer NOT NULL REFERENCES wms.orders(id),
      status varchar(40) NOT NULL DEFAULT 'planned',
      carrier varchar(100),
      tracking_number varchar(200),
      shipped_at timestamptz,
      carrier_cost_cents integer NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS wms.outbound_shipment_items (
      id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      shipment_id integer NOT NULL REFERENCES wms.outbound_shipments(id),
      product_variant_id integer,
      qty integer NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS oms.oms_orders (
      id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
      channel_id integer NOT NULL REFERENCES channels.channels(id),
      external_order_id varchar(100) NOT NULL,
      status varchar(30) NOT NULL DEFAULT 'pending'
    );
  `);
}

async function seedVendor(
  client: pg.PoolClient,
  memberId: string,
  email: string,
): Promise<number> {
  const planId = `${memberId}-ops-plan`;
  const subscriptionId = `${memberId}-subscription`;

  await client.query(
    "INSERT INTO membership.members (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
    [memberId, email],
  );
  await client.query(
    "INSERT INTO membership.plans (id, name, includes_dropship) VALUES ($1, '.ops', true) ON CONFLICT (id) DO NOTHING",
    [planId],
  );
  await client.query(
    `INSERT INTO membership.member_subscriptions (id, member_id, plan_id, status)
     VALUES ($1, $2, $3, 'active')
     ON CONFLICT (id) DO NOTHING`,
    [subscriptionId, memberId, planId],
  );

  const result = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_vendors
      (member_id, current_subscription_id, current_plan_id, business_name, contact_name, email, status, entitlement_status)
     VALUES ($1, $2, $3, $4, $5, $6, 'active', 'active')
     RETURNING id`,
    [memberId, subscriptionId, planId, `Business ${memberId}`, `Contact ${memberId}`, email],
  );

  return result.rows[0].id;
}

async function seedStore(
  client: pg.PoolClient,
  vendorId: number,
  platform: "ebay" | "shopify",
  status = "connected",
): Promise<number> {
  const result = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_store_connections
      (vendor_id, platform, external_account_id, external_display_name, status)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      vendorId,
      platform,
      `${platform}-${vendorId}-${status}`,
      `${platform} ${vendorId}`,
      status,
    ],
  );

  return result.rows[0].id;
}

describeWithDb("Dropship V2 database foundation", () => {
  let pool: pg.Pool | undefined;
  let client: pg.PoolClient | undefined;
  let channelId: number;
  let vendorAId: number;
  let vendorBId: number;
  let storeAId: number;
  let storeBId: number;
  let variantId: number;
  let warehouseId: number;

  beforeAll(async () => {
    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 1,
      ssl: sslConfig(TEST_DB_URL!),
    });
    client = await pool.connect();
    await client.query("BEGIN");
    await createMinimalDependencies(client);
    await client.query(migrationSql);
    await client.query(adminCommandMigrationSql);
    await client.query(carrierProtectionMigrationSql);
    await client.query(carrierClaimMigrationSql);

    const channel = await client.query<{ id: number }>(
      `INSERT INTO channels.channels (name, type, provider, status, sync_enabled, sync_mode)
       VALUES ('Dropship OMS', 'internal', 'manual', 'active', false, 'dry_run')
       RETURNING id`,
    );
    channelId = channel.rows[0].id;

    vendorAId = await seedVendor(client, "member-dropship-a", "a@example.test");
    vendorBId = await seedVendor(client, "member-dropship-b", "b@example.test");
    storeAId = await seedStore(client, vendorAId, "ebay");
    storeBId = await seedStore(client, vendorBId, "shopify");

    const warehouse = await client.query<{ id: number }>(
      "INSERT INTO warehouse.warehouses (code, name) VALUES ('DSV2', 'Dropship Test Warehouse') RETURNING id",
    );
    warehouseId = warehouse.rows[0].id;

    const product = await client.query<{ id: number }>(
      "INSERT INTO catalog.products (sku, name, category) VALUES ('DSV2-P', 'Dropship V2 Product', 'supplies') RETURNING id",
    );
    const variant = await client.query<{ id: number }>(
      `INSERT INTO catalog.product_variants (product_id, sku, name, units_per_variant)
       VALUES ($1, 'DSV2-V', 'Dropship V2 Variant', 1)
       RETURNING id`,
      [product.rows[0].id],
    );
    variantId = variant.rows[0].id;
  });

  afterAll(async () => {
    if (client) {
      await client.query("ROLLBACK");
      client.release();
    }
    await pool?.end();
  });

  it("enforces one active store connection per vendor while retaining disconnected history", async () => {
    await client!.query(
      `INSERT INTO dropship.dropship_store_connections
        (vendor_id, platform, external_account_id, status)
       VALUES ($1, 'shopify', 'historical-shopify', 'disconnected')`,
      [vendorAId],
    );

    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_store_connections
          (vendor_id, platform, external_account_id, status)
         VALUES ($1, 'shopify', 'second-active-shopify', 'connected')`,
        [vendorAId],
      ),
      "23505",
    );
  });

  it("makes order intake idempotent by store connection and external order", async () => {
    await client!.query(
      `INSERT INTO dropship.dropship_order_intake
        (channel_id, vendor_id, store_connection_id, platform, external_order_id, raw_payload)
       VALUES ($1, $2, $3, 'ebay', 'ORDER-100', '{"source":"ebay"}'::jsonb)`,
      [channelId, vendorAId, storeAId],
    );

    await client!.query(
      `INSERT INTO dropship.dropship_order_intake
        (channel_id, vendor_id, store_connection_id, platform, external_order_id, raw_payload)
       VALUES ($1, $2, $3, 'shopify', 'ORDER-100', '{"source":"shopify"}'::jsonb)`,
      [channelId, vendorBId, storeBId],
    );

    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_order_intake
          (channel_id, vendor_id, store_connection_id, platform, external_order_id)
         VALUES ($1, $2, $3, 'ebay', 'ORDER-100')`,
        [channelId, vendorAId, storeAId],
      ),
      "23505",
    );
  });

  it("enforces wallet ledger idempotency and nonnegative account balances", async () => {
    const wallet = await client!.query<{ id: number }>(
      `INSERT INTO dropship.dropship_wallet_accounts
        (vendor_id, available_balance_cents, pending_balance_cents)
       VALUES ($1, 0, 5000)
       RETURNING id`,
      [vendorAId],
    );

    await client!.query(
      `INSERT INTO dropship.dropship_wallet_ledger
        (wallet_account_id, vendor_id, type, status, amount_cents, reference_type, reference_id, idempotency_key)
       VALUES ($1, $2, 'funding', 'pending', 5000, 'stripe_payment_intent', 'pi_v2_1', 'funding-v2-1')`,
      [wallet.rows[0].id, vendorAId],
    );

    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_wallet_ledger
          (wallet_account_id, vendor_id, type, status, amount_cents, reference_type, reference_id)
         VALUES ($1, $2, 'funding', 'pending', 5000, 'stripe_payment_intent', 'pi_v2_1')`,
        [wallet.rows[0].id, vendorAId],
      ),
      "23505",
    );

    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_wallet_accounts
          (vendor_id, available_balance_cents, pending_balance_cents)
         VALUES ($1, -1, 0)`,
        [vendorBId],
      ),
      "23514",
    );
  });

  it("blocks missing package dimensions and invalid shipping policy values", async () => {
    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_package_profiles
          (product_variant_id, weight_grams, length_mm, width_mm, height_mm)
         VALUES ($1, 100, 0, 20, 30)`,
        [variantId],
      ),
      "23514",
    );

    const insurance = await client!.query<{ fee_bps: number }>(
      "INSERT INTO dropship.dropship_insurance_pool_config (name) VALUES ('Default pool') RETURNING fee_bps",
    );
    expect(insurance.rows[0].fee_bps).toBe(200);
  });

  it("keeps return and notification rules enforceable by the database", async () => {
    const intake = await client!.query<{ id: number }>(
      `INSERT INTO dropship.dropship_order_intake
        (channel_id, vendor_id, store_connection_id, platform, external_order_id)
       VALUES ($1, $2, $3, 'ebay', 'ORDER-RETURN-1')
       RETURNING id`,
      [channelId, vendorAId, storeAId],
    );

    const rma = await client!.query<{ return_window_days: number }>(
      `INSERT INTO dropship.dropship_rmas
        (rma_number, vendor_id, store_connection_id, intake_id, fault_category)
       VALUES ('RMA-V2-1', $1, $2, $3, 'carrier')
       RETURNING return_window_days`,
      [vendorAId, storeAId, intake.rows[0].id],
    );
    expect(rma.rows[0].return_window_days).toBe(30);

    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_notification_preferences
          (vendor_id, event_type, critical, email_enabled, in_app_enabled)
         VALUES ($1, 'payment_hold', true, false, true)`,
        [vendorAId],
      ),
      "23514",
    );
  });

  it("stores USDC amounts as exact atomic units and deduplicates chain transactions", async () => {
    await client!.query(
      `INSERT INTO dropship.dropship_usdc_ledger_entries
        (vendor_id, chain_id, transaction_hash, amount_atomic_units)
       VALUES ($1, 8453, '0xabc', '123456789012345678901234567890')`,
      [vendorAId],
    );

    const stored = await client!.query<{ amount_atomic_units: string }>(
      `SELECT amount_atomic_units::text
       FROM dropship.dropship_usdc_ledger_entries
       WHERE transaction_hash = '0xabc'`,
    );
    expect(stored.rows[0].amount_atomic_units).toBe("123456789012345678901234567890");

    await expectDatabaseError(
      client!,
      () => client!.query(
        `INSERT INTO dropship.dropship_usdc_ledger_entries
          (vendor_id, chain_id, transaction_hash, amount_atomic_units)
         VALUES ($1, 8453, '0xabc', '1')`,
        [vendorAId],
      ),
      "23505",
    );
  });

  it("keeps carrier-claim migrations repeatable and enforces captured-cost provenance", async () => {
    await client!.query(carrierProtectionMigrationSql);
    await client!.query(carrierClaimMigrationSql);

    const order = await client!.query<{ id: number }>(
      "INSERT INTO wms.orders (warehouse_status) VALUES ('shipped') RETURNING id",
    );
    const shipment = await client!.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipments (order_id, status, carrier_cost_cents)
       VALUES ($1, 'shipped', 0)
       RETURNING id`,
      [order.rows[0].id],
    );

    await expectDatabaseError(
      client!,
      () => client!.query(
        `UPDATE wms.outbound_shipments
         SET carrier_cost_source = 'shipstation_ship_notify', carrier_cost_recorded_at = now()
         WHERE id = $1`,
        [shipment.rows[0].id],
      ),
      "23514",
    );

    await client!.query(
      `UPDATE wms.outbound_shipments
       SET carrier_cost_cents = 499,
           carrier_cost_source = 'shipstation_ship_notify',
           carrier_cost_recorded_at = now()
       WHERE id = $1`,
      [shipment.rows[0].id],
    );
  });

  it("persists exact split-shipment allocation and replays claim intake idempotently", async () => {
    const now = new Date("2026-07-11T14:00:00.000Z");
    const shippedAt = new Date("2026-07-10T14:00:00.000Z");
    const occurredAt = new Date("2026-07-11T13:00:00.000Z");
    const omsOrder = await client!.query<{ id: number }>(
      `INSERT INTO oms.oms_orders (channel_id, external_order_id, status)
       VALUES ($1, 'CLAIM-ORDER-1', 'shipped')
       RETURNING id`,
      [channelId],
    );
    const quote = await client!.query<{ id: number }>(
      `INSERT INTO dropship.dropship_shipping_quote_snapshots
        (vendor_id, store_connection_id, warehouse_id, package_count, base_rate_cents,
         total_shipping_cents, quote_payload)
       VALUES ($1, $2, $3, 2, 1000, 1000, $4::jsonb)
       RETURNING id`,
      [vendorAId, storeAId, warehouseId, JSON.stringify({ destination: { country: "US", region: "PA" } })],
    );
    const intake = await client!.query<{ id: number }>(
      `INSERT INTO dropship.dropship_order_intake
        (channel_id, vendor_id, store_connection_id, platform, external_order_id,
         status, oms_order_id, accepted_at)
       VALUES ($1, $2, $3, 'ebay', 'CLAIM-ORDER-1', 'accepted', $4, $5)
       RETURNING id`,
      [channelId, vendorAId, storeAId, omsOrder.rows[0].id, shippedAt],
    );
    await client!.query(
      `INSERT INTO dropship.dropship_order_economics_snapshots
        (intake_id, oms_order_id, vendor_id, store_connection_id, member_id,
         shipping_quote_snapshot_id, warehouse_id, currency, retail_subtotal_cents,
         wholesale_subtotal_cents, shipping_cents, total_debit_cents, pricing_snapshot)
       VALUES ($1, $2, $3, $4, 'member-dropship-a', $5, $6, 'USD', 2000, 1000, 1000, 2000, $7::jsonb)`,
      [
        intake.rows[0].id,
        omsOrder.rows[0].id,
        vendorAId,
        storeAId,
        quote.rows[0].id,
        warehouseId,
        JSON.stringify({
          wholesale: {
            lines: [{ productVariantId: variantId, quantity: 2, wholesaleUnitCostCents: 500 }],
          },
        }),
      ],
    );
    const wmsOrder = await client!.query<{ id: number }>(
      `INSERT INTO wms.orders (oms_fulfillment_order_id, warehouse_status)
       VALUES ($1, 'shipped')
       RETURNING id`,
      [String(omsOrder.rows[0].id)],
    );
    const firstShipment = await client!.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipments
        (order_id, status, carrier, service_code, tracking_number, shipped_at,
         carrier_cost_cents, carrier_cost_source, carrier_cost_recorded_at)
       VALUES ($1, 'shipped', 'USPS', 'priority_mail', 'TRACK-CLAIM-1', $2,
         300, 'shipstation_ship_notify', $2)
       RETURNING id`,
      [wmsOrder.rows[0].id, shippedAt],
    );
    const secondShipment = await client!.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipments
        (order_id, status, carrier, service_code, tracking_number, shipped_at,
         carrier_cost_cents, carrier_cost_source, carrier_cost_recorded_at)
       VALUES ($1, 'shipped', 'USPS', 'priority_mail', 'TRACK-CLAIM-2', $2,
         700, 'shipstation_ship_notify', $2)
       RETURNING id`,
      [wmsOrder.rows[0].id, shippedAt],
    );
    await client!.query(
      `INSERT INTO wms.outbound_shipment_items (shipment_id, product_variant_id, qty)
       VALUES ($1, $2, 2)`,
      [firstShipment.rows[0].id, variantId],
    );

    const policy = await client!.query<{ id: number }>(
      `INSERT INTO dropship.dropship_carrier_protection_policies
        (policy_key, version, name, status, loss_wait_days, misdelivery_wait_days,
         carrier_claim_required, effective_from, created_by)
       VALUES ('integration-default', 1, 'Integration default', 'active', 0, 0,
         false, $1, 'integration-test')
       RETURNING id`,
      [new Date("2026-07-01T00:00:00.000Z")],
    );
    await client!.query(
      `INSERT INTO dropship.dropship_carrier_protection_assignments
        (policy_id, name, is_default, created_by)
       VALUES ($1, 'Integration default assignment', true, 'integration-test')`,
      [policy.rows[0].id],
    );

    const repository = new PgDropshipCarrierClaimRepository(createSavepointPool(client!));
    const command = {
      wmsShipmentId: firstShipment.rows[0].id,
      eventType: "loss" as const,
      occurredAt,
      rmaId: null,
      externalClaimId: null,
      notes: "Database integration proof",
      idempotencyKey: "claim-integration-idempotency-1",
      requestHash: "a".repeat(64),
      actor: { actorType: "admin" as const, actorId: "integration-test" },
      now,
    };

    const created = await repository.createClaim(command);
    const replayed = await repository.createClaim(command);

    expect(created.idempotentReplay).toBe(false);
    expect(replayed.idempotentReplay).toBe(true);
    expect(replayed.record.claimId).toBe(created.record.claimId);
    expect(created.record.shippingChargeSnapshotCents).toBe(300);
    expect(created.record.wholesaleCostSnapshotCents).toBe(1000);
    expect(created.record.calculatedCreditCents).toBe(1300);
    expect(created.record.status).toBe("pending_approval");

    const allocations = await client!.query<{
      wms_shipment_id: number;
      shipment_carrier_cost_cents: string;
      allocated_shipping_charge_cents: string;
    }>(
      `SELECT wms_shipment_id, shipment_carrier_cost_cents, allocated_shipping_charge_cents
       FROM dropship.dropship_shipment_shipping_allocations
       WHERE intake_id = $1
       ORDER BY wms_shipment_id`,
      [intake.rows[0].id],
    );
    expect(allocations.rows).toEqual([
      {
        wms_shipment_id: firstShipment.rows[0].id,
        shipment_carrier_cost_cents: "300",
        allocated_shipping_charge_cents: "300",
      },
      {
        wms_shipment_id: secondShipment.rows[0].id,
        shipment_carrier_cost_cents: "700",
        allocated_shipping_charge_cents: "700",
      },
    ]);

    const counts = await client!.query<{
      claim_count: string;
      allocation_count: string;
      audit_count: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM dropship.dropship_carrier_claims WHERE intake_id = $1)::text AS claim_count,
         (SELECT COUNT(*) FROM dropship.dropship_shipment_shipping_allocations WHERE intake_id = $1)::text AS allocation_count,
         (SELECT COUNT(*) FROM dropship.dropship_audit_events
           WHERE entity_type = 'dropship_carrier_claim' AND entity_id = $2)::text AS audit_count`,
      [intake.rows[0].id, String(created.record.claimId)],
    );
    expect(counts.rows[0]).toEqual({ claim_count: "1", allocation_count: "2", audit_count: "1" });

    await expectDatabaseError(
      client!,
      () => client!.query(
        `UPDATE dropship.dropship_shipment_shipping_allocations
         SET allocated_shipping_charge_cents = 301
         WHERE intake_id = $1 AND wms_shipment_id = $2`,
        [intake.rows[0].id, firstShipment.rows[0].id],
      ),
      "23514",
    );
  });
});

function createSavepointPool(client: pg.PoolClient): pg.Pool {
  let sequence = 0;
  return {
    connect: async () => {
      const savepoint = `dropship_claim_repository_${++sequence}`;
      let transactionOpen = false;
      return {
        query: async (query: unknown, values?: unknown[]) => {
          if (typeof query === "string") {
            const normalized = query.trim().replace(/\s+/g, " ").toUpperCase();
            if (normalized.startsWith("BEGIN")) {
              await client.query(`SAVEPOINT ${savepoint}`);
              transactionOpen = true;
              return { rows: [], rowCount: null };
            }
            if (normalized === "COMMIT") {
              await client.query(`RELEASE SAVEPOINT ${savepoint}`);
              transactionOpen = false;
              return { rows: [], rowCount: null };
            }
            if (normalized === "ROLLBACK") {
              if (transactionOpen) {
                await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                await client.query(`RELEASE SAVEPOINT ${savepoint}`);
                transactionOpen = false;
              }
              return { rows: [], rowCount: null };
            }
          }
          return client.query(query as never, values as never);
        },
        release: () => undefined,
      } as unknown as pg.PoolClient;
    },
  } as unknown as pg.Pool;
}
