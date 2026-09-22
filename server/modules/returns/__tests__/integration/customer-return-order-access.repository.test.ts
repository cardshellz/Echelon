import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PostgresCustomerReturnOrderAccessRepository } from "../../infrastructure/customer-return-order-access.repository";
import { resolveReturnsTestDatabase } from "../support/disposable-database";

// Deliberately separate from the authorization suite, which rebuilds its schemas.
const connectionString = resolveReturnsTestDatabase(process.env, "access");
const integration = connectionString ? describe.sequential : describe.skip;

integration("customer return order lookup against migration-defined PostgreSQL", () => {
  let pool: Pool;
  let repository: PostgresCustomerReturnOrderAccessRepository;
  let guestOrderId: number;
  beforeAll(async () => {
    pool = new Pool({ connectionString: connectionString!, max: 3, connectionTimeoutMillis: 5_000, statement_timeout: 10_000 });
    const source = readFileSync("migrations/0002_concerned_darwin.sql", "utf8");
    const table = source.match(/CREATE TABLE "oms"\."oms_orders" \([\s\S]*?\r?\n\);/);
    if (!table) throw new Error("Canonical OMS order table migration was not found.");
    await pool.query("DROP SCHEMA IF EXISTS oms CASCADE; CREATE SCHEMA oms");
    await pool.query(table[0]);
    await pool.query(readFileSync("migrations/104_oms_orders_external_customer_id.sql", "utf8"));
    repository = new PostgresCustomerReturnOrderAccessRepository(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE oms.oms_orders RESTART IDENTITY");
    await pool.query(`INSERT INTO oms.oms_orders
      (channel_id, external_order_id, external_order_number, external_customer_id, ordered_at)
      VALUES (36, 'gid://shopify/Order/1', '#63210', 'customer-a', '2026-09-01'),
             (36, 'gid://shopify/Order/2', '#163210', 'customer-a', '2026-09-01'),
             (37, 'gid://shopify/Order/3', '#63210', 'customer-a', '2026-09-01'),
             (36, 'gid://shopify/Order/4', '#63210', 'customer-b', '2026-09-01'),
             (36, 'gid://shopify/Order/5', '#063210', 'customer-a', '2026-09-01')`);
    const guest = await pool.query(`INSERT INTO oms.oms_orders
      (channel_id, external_order_id, external_order_number, ordered_at)
      VALUES (36, 'gid://shopify/Order/6', '#guest-7', '2026-09-01') RETURNING id`);
    guestOrderId = Number(guest.rows[0].id);
  });
  afterAll(async () => { await pool?.end(); });

  const customerInput = {
    channelId: 36, scope: { kind: "customer" as const, externalCustomerId: "customer-a" },
    orderNumberAliases: ["63210", "#63210"],
  };
  it("matches exact aliases only within the verified channel and customer", async () => {
    const result = await repository.findExactOrderCandidates(customerInput);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ omsOrderId: 1, channelId: 36, externalOrderId: "gid://shopify/Order/1" });
  });
  it("preserves leading zero identity", async () => {
    const result = await repository.findExactOrderCandidates({ ...customerInput, orderNumberAliases: ["063210", "#063210"] });
    expect(result.map(row => row.externalOrderId)).toEqual(["gid://shopify/Order/5"]);
  });
  it("returns two distinct candidates so the service can reject ambiguity", async () => {
    await pool.query(`INSERT INTO oms.oms_orders
      (channel_id, external_order_id, external_order_number, external_customer_id, ordered_at)
      VALUES (36, 'gid://shopify/Order/8', '63210', 'customer-a', '2026-09-01')`);
    expect(await repository.findExactOrderCandidates(customerInput)).toHaveLength(2);
  });
  it("treats SQL metacharacters literally", async () => {
    expect(await repository.findExactOrderCandidates({ ...customerInput, orderNumberAliases: ["%", "#63210' OR 1=1 --"] })).toEqual([]);
  });
  it("accepts a verified guest order grant without a customer ID", async () => {
    const result = await repository.findExactOrderCandidates({
      channelId: 36, scope: { kind: "order", omsOrderId: guestOrderId, externalOrderId: "gid://shopify/Order/6" },
      orderNumberAliases: ["guest-7", "#guest-7"],
    });
    expect(result).toHaveLength(1);
    expect(result[0].externalCustomerId).toBeNull();
  });
  it("requires both guest grant identities and its exact display alias", async () => {
    for (const scope of [
      { kind: "order" as const, omsOrderId: guestOrderId, externalOrderId: "gid://shopify/Order/1" },
      { kind: "order" as const, omsOrderId: 1, externalOrderId: "gid://shopify/Order/6" },
    ]) expect(await repository.findExactOrderCandidates({ channelId: 36, scope, orderNumberAliases: ["#guest-7"] })).toEqual([]);
  });
  it("never treats a failed database read as order absence", async () => {
    await pool.query("ALTER TABLE oms.oms_orders RENAME TO hidden_orders");
    try {
      await expect(repository.findExactOrderCandidates(customerInput)).rejects.toMatchObject({ code: "CUSTOMER_RETURN_ORDER_READ_FAILED" });
    } finally {
      await pool.query("ALTER TABLE oms.hidden_orders RENAME TO oms_orders");
    }
  });
});
