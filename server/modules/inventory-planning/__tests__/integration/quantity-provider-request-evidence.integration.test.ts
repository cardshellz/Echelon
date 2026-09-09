import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, installCutoverCompositionMigrations } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";

vi.mock("../../../../db", () => ({ pool: {} }));
const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = databaseUrl && disposable ? describe : describe.skip;
const daily = { errors: [{ errorId: 25001, category: "APPLICATION",
  message: "You have exceeded your maximum call limit of 250 for item per day. Try back after 1 day." }] };

dbDescribe.sequential("durable eBay terminal evidence with actual migration0663", () => {
  let database: InventoryCutoverTestDatabase; let sequence = 0;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(databaseUrl,disposable,cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    await database.pool.query(cutoverCompositionSeedSql);
  });
  afterAll(async () => { await database?.close(); });
  function setup(request: typeof fetch, pool: Pick<Pool,"connect"> = database.pool) {
    let timestamp = Date.parse("2026-09-08T20:00:00.000Z");
    const clock = () => new Date(timestamp);
    const scope: QuantityPublicationScope = { destinationKind: "channel_connection", connectionId: 1,
      providerKey: "ebay", providerScopeType: "account", externalScopeId: `account-${++sequence}`, externalInventoryItemId: `EVIDENCE-${sequence}`,
      productId: 20, productVariantId: 101 };
    const admission = new PostgresQuantityPublicationAdmission(pool,clock);
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" },67,"sandbox", {
      request,now: clock,quantityAdmission: async () => ({ item: (_sku,work) => work(null),
        group: (_key,_members,work) => work(null),reducing: (_identity,work) => work() }),
    });
    const publish = (quantity = 4) => admission.run(scope,() => api.createOrReplaceInventoryItem(scope.externalInventoryItemId,
      { product: { title: "Test",imageUrls: [] },condition: "NEW",availability: { shipToLocationAvailability: { quantity } } }));
    const attempts = async () => (await database.pool.query(`SELECT id::text,state,resolution_basis,completed_at FROM inventory.quantity_publication_attempts
      WHERE scope->>'externalInventoryItemId'=$1 ORDER BY id`,[scope.externalInventoryItemId])).rows;
    return { scope,clock,admission,publish,attempts,advance: (ms: number) => { timestamp += ms; } };
  }

  it("records a terminal rejection and durable cooldown; restart and new events cannot bypass it", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(daily),{ status: 400,headers: { "x-ebay-c-request-id": "receipt-1" } }));
    const test = setup(request);
    await expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_DAILY_LIMIT" });
    const attempt = (await test.attempts())[0];
    expect(attempt).toMatchObject({ state: "rejected",resolution_basis: "provider_rejection",completed_at: test.clock() });
    const evidence = (await database.pool.query(`SELECT q.method,q.path,q.request_hash,r.* FROM inventory.quantity_provider_requests q
      JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id WHERE q.attempt_id=$1`,[attempt.id])).rows;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({ method: "PUT",outcome: "rejected",http_status: 400,provider_request_id: "receipt-1",
      retry_not_before: new Date("2026-09-09T20:00:00.000Z") });
    const restarted = new PostgresQuantityPublicationAdmission(database.pool,test.clock);
    const forbidden = vi.fn();
    await expect(restarted.run(test.scope,forbidden)).rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    // This is the SAME physical provider item through another destination/connection.
    await expect(restarted.run({ ...test.scope,connectionId: 2,destinationKind: "dropship_store_connection" },forbidden))
      .rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    expect(forbidden).not.toHaveBeenCalled();
    expect((await restarted.listDue(100)).filter(row => row.scope.externalInventoryItemId===test.scope.externalInventoryItemId)).toEqual([]);
    expect(await test.attempts()).toHaveLength(1);
    expect(request).toHaveBeenCalledOnce();

    test.advance(24*60*60*1000);
    const due = (await restarted.listDue(100)).find(row => row.scope.externalInventoryItemId===test.scope.externalInventoryItemId && row.scope.connectionId===1)!;
    expect(due).toBeDefined();
    expect(await restarted.complete(due)).toBe(false); // Rejection is not delivery.
    request.mockImplementation(async () => new Response(null,{ status: 204 }));
    await test.publish(17);
    expect(JSON.parse(String(request.mock.calls.at(-1)![1]!.body)).availability.shipToLocationAvailability.quantity).toBe(17);
    expect(await restarted.complete(due)).toBe(true);
    expect((await test.attempts()).map(row => row.state)).toEqual(["rejected","succeeded"]);
  });

  it("records 429 retry-after beyond the worker interval without another HTTP call", async () => {
    const request = vi.fn<typeof fetch>(async () => new Response("{}",{ status: 429,headers: { "Retry-After": "172800" } }));
    const test = setup(request);
    await expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_REJECTED" });
    const forbidden = vi.fn();
    await expect(test.admission.run({ ...test.scope,externalInventoryItemId: "OTHER-SKU" },forbidden))
      .rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    expect(forbidden).not.toHaveBeenCalled();
    test.advance(24*60*60*1000);
    await expect(test.publish()).rejects.toMatchObject({ code: "PUBLICATION_PROVIDER_COOLDOWN" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each([408,500,503])("preserves uncertainty for HTTP %s, with no automatic resend", async status => {
    const request = vi.fn<typeof fetch>(async () => new Response("{}",{ status })); const test = setup(request);
    await expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_RESPONSE_UNCERTAIN" });
    expect((await test.attempts())[0]).toMatchObject({ state: "uncertain",completed_at: null });
    test.advance(3*24*60*60*1000);
    await expect(test.publish()).rejects.toMatchObject({ code: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("leaves missing terminal persistence unresolved, and records no false rejection", async () => {
    let injected = false;
    const pool = { connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client,{ get(target,property) {
        if (property==="query") return async (sql: string,args?: unknown[]) => {
          if (!injected && sql.includes("INSERT INTO inventory.quantity_provider_request_results")) {
            injected=true; throw new Error("simulated lost response persistence");
          }
          return client.query(sql,args);
        };
        const value=Reflect.get(target,property); return typeof value==="function" ? value.bind(target) : value;
      } });
    } };
    const test=setup(async () => new Response(JSON.stringify(daily),{ status: 400 }),pool);
    await expect(test.publish()).rejects.toThrow("simulated lost response persistence");
    const attempt=(await test.attempts())[0]; expect(attempt.state).toBe("uncertain");
    const rows=(await database.pool.query(`SELECT r.request_id FROM inventory.quantity_provider_requests q
      LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id WHERE q.attempt_id=$1`,[attempt.id])).rows;
    expect(rows).toEqual([{ request_id: null }]);
  });

  it("keeps a lost owner acknowledgement running even when the rejected response and cooldown were saved", async () => {
    let injected=false;
    const pool={ connect: async () => {
      const client=await database.pool.connect();
      return new Proxy(client,{ get(target,property) {
        if (property==="query") return async (sql: string,args?: unknown[]) => {
          if (!injected && sql.includes("SET state=$4") && args?.[3]==="rejected") { injected=true; throw new Error("lost owner acknowledgement"); }
          return client.query(sql,args);
        };
        const value=Reflect.get(target,property); return typeof value==="function" ? value.bind(target) : value;
      } });
    } };
    const test=setup(async () => new Response(JSON.stringify(daily),{ status: 400 }),pool);
    await expect(test.publish()).rejects.toThrow("lost owner acknowledgement");
    expect((await test.attempts())[0].state).toBe("running");
    const rows=(await database.pool.query(`SELECT retry_not_before FROM inventory.quantity_publication_cooldowns
      WHERE external_inventory_item_id=$1`,[test.scope.externalInventoryItemId])).rows;
    expect(rows).toEqual([{ retry_not_before: new Date("2026-09-09T20:00:00.000Z") }]);
  });

  it("keeps exact-scope locks during HTTP without an open database transaction", async () => {
    let entered!: () => void; let release!: () => void;
    const gate=new Promise<void>(resolve => { release=resolve; });
    const started=new Promise<void>(resolve => { entered=resolve; });
    const test=setup(async () => { entered(); await gate; return new Response(JSON.stringify(daily),{ status: 400 }); });
    const first=expect(test.publish()).rejects.toMatchObject({ code: "EBAY_QUANTITY_DAILY_LIMIT" });
    await started;
    try {
      const transactions=(await database.pool.query(`SELECT count(*)::int AS count FROM pg_stat_activity
        WHERE datname=current_database() AND state='idle in transaction'`)).rows[0].count;
      expect(transactions).toBe(0);
      await expect(new PostgresQuantityPublicationAdmission(database.pool,test.clock).run(test.scope,vi.fn()))
        .rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
    } finally { release(); await first; }
  });

  it("enforces immutable evidence and prevents rejection without a complete request history", async () => {
    const test=setup(async () => new Response(JSON.stringify(daily),{ status: 400 }));
    await expect(test.publish()).rejects.toThrow();
    const attempt=(await test.attempts())[0];
    await expect(database.pool.query("DELETE FROM inventory.quantity_provider_requests WHERE attempt_id=$1",[attempt.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query(`UPDATE inventory.quantity_provider_request_results SET outcome='completed'
      WHERE request_id IN (SELECT id FROM inventory.quantity_provider_requests WHERE attempt_id=$1)`,[attempt.id]))
      .rejects.toMatchObject({ code: "23514" });
    await expect(database.pool.query("UPDATE inventory.quantity_publication_attempts SET state='uncertain',completed_at=NULL WHERE id=$1",[attempt.id]))
      .rejects.toMatchObject({ code: "23514" });
    const uncertain=setup(async () => { throw new Error("unknown transport result"); });
    await expect(uncertain.publish()).rejects.toThrow();
    await expect(database.pool.query(`UPDATE inventory.quantity_publication_attempts SET state='rejected',completed_at=$2,
      resolution_basis='provider_rejection' WHERE id=$1`,[(await uncertain.attempts())[0].id,uncertain.clock()]))
      .rejects.toMatchObject({ code: "23514" });
  });
});
