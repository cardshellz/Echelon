import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "dotenv";
import pg from "pg";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const describeWithDb = TEST_DB_URL ? describe : describe.skip;
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0086_dropship_v2_foundation.sql"),
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
});
