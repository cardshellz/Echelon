import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql, cutoverCompositionSeedSql, cutoverCompositionLegacyChannelSeedSql,
  installCutoverCompositionMigrations } from "../fixtures/inventory-cutover-composition-database.fixture";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresQuantityProviderResponseRecovery } from "../../infrastructure/quantity-provider-response-recovery.repository";
import { PostgresEbayPublicationRejectionReader, type EbayPublicationRejectionInput } from "../../infrastructure/ebay-publication-rejection.reader";
import { observeEbayQuantityRequest, recordQuantityProviderResponse, type QuantityProviderResponseEvidence } from "../../application/quantity-provider-request-evidence";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";

vi.mock("../../../../db", () => ({ pool: {} }));
const dbDescribe = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const groupPath = "/sell/inventory/v1/offer/publish_by_inventory_item_group";
const retainedRejection: QuantityProviderResponseEvidence = { outcome: "uncertain", httpStatus: 400,
  requestTerminated: true, responseHash: "a".repeat(64), providerRequestId: null,
  errorCodes: ["25007"], retryNotBefore: null, cooldownScope: null };

dbDescribe.sequential("eBay publication refusal evidence on disposable PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let sequence = 0;
  let time = Date.parse("2026-10-16T14:00:00.000Z");
  const clock = () => new Date(time);
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    for (const file of ["0709_walmart_quantity_admission.sql", "0716_inventory_publication_reconciliation.sql",
      "0729_ebay_listing_sync_recovery.sql", "0733_ebay_provider_response_finality.sql", "0734_ebay_operator_republication_recovery.sql",
      "0749_quantity_outbox_preflight_completion.sql", "900000008000018120001_ebay_automatic_sync_recovery.sql"]) {
      await database.pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionLegacyChannelSeedSql);
  }, 60000);
  afterAll(async () => { await database?.close(); });

  function fixture() {
    const groupKey = `REJECT-${++sequence}`;
    const base = { destinationKind: "channel_connection" as const, connectionId: 1, providerKey: "ebay" as const,
      providerScopeType: "account" as const, externalScopeId: `account-${sequence}`, productId: 20 };
    const group: QuantityPublicationScope = { ...base, externalInventoryItemId: `group:${groupKey}`, productVariantId: null };
    const members: QuantityPublicationScope[] = [101, 102].map(productVariantId => ({ ...base,
      externalInventoryItemId: `${groupKey}-${productVariantId}`, productVariantId }));
    const input: EbayPublicationRejectionInput = { scopes: [group, ...members], startedAt: clock().toISOString(),
      groupKey, marketplaceId: "EBAY_US", offerIds: ["offer-P5", "offer-C50"] };
    const admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
    const reader = new PostgresEbayPublicationRejectionReader(database.pool);
    const recovery = (pool: Pick<Pool, "connect"> = database.pool) => new PostgresQuantityProviderResponseRecovery(pool, clock);
    const work = async (publish: () => Promise<unknown>, stockTerminated: boolean | null = true) => {
      for (const member of members) await observeEbayQuantityRequest({ method: "POST",
        path: "/sell/inventory/v1/bulk_update_price_quantity", body: { requests: [{ sku: member.externalInventoryItemId,
          shipToLocationAvailability: { quantity: 17 }, offers: [] }] } }, async () => {
          recordQuantityProviderResponse({ ...retainedRejection, outcome: "completed", httpStatus: 200,
            requestTerminated: stockTerminated, errorCodes: [] });
        });
      return publish();
    };
    const publish = (evidence: QuantityProviderResponseEvidence | null = retainedRejection, stockTerminated: boolean | null = true) =>
      admission.runListingGroup(group, members, async () => { throw new Error("Legacy fixture unexpectedly requested a canonical plan"); }, () =>
        work(() => observeEbayQuantityRequest({ method: "POST", path: groupPath,
          body: { inventoryItemGroupKey: groupKey, marketplaceId: "EBAY_US" } }, async () => {
          if (evidence) recordQuantityProviderResponse(evidence);
          if (evidence?.outcome !== "completed") throw new Error("retained publication failure");
          return { listingId: "listing-1" };
        }), stockTerminated));
    const attempts = async () => (await database.pool.query<{ id: string; record: Record<string, unknown> }>(
      "SELECT id::text,to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE scope_key=$1 ORDER BY id",
      [quantityPublicationScopeLockKey(group)])).rows;
    const receipts = async (id: string) => (await database.pool.query(`SELECT to_jsonb(q) AS request,to_jsonb(r) AS response
      FROM inventory.quantity_provider_requests q LEFT JOIN inventory.quantity_provider_request_results r ON r.request_id=q.id
      WHERE q.attempt_id=$1 ORDER BY q.ordinal`, [id])).rows;
    return { group, members, input, admission, reader, recovery, publish, attempts, receipts };
  }

  it("recovers the exact two-stock-requests plus rejected publication history, without rewriting or claiming delivery", async () => {
    const f = fixture();
    await expect(f.publish()).rejects.toThrow("retained publication failure");
    const attempt = (await f.attempts())[0];
    const original = await f.receipts(attempt.id);
    const proof = await f.reader.read(f.input);
    expect(proof).toMatchObject({ busy: false, evidence: { attemptIds: [attempt.id], requests: [{
      attemptId: attempt.id, ordinal: 3, outcome: "uncertain", httpStatus: 400, errorCodes: ["25007"], requestTerminated: true,
    }] } });
    expect(proof.evidence?.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.recovery().reconcile(f.input.scopes)).toEqual({ busy: false, resolved: [attempt.id], unresolved: [] });
    expect(await f.reader.read(f.input)).toEqual(proof); // Crash after inventory commit is recoverable.
    expect(await f.recovery().reconcile(f.input.scopes)).toEqual({ busy: false, resolved: [], unresolved: [] });
    expect(await f.receipts(attempt.id)).toEqual(original);
    expect((await f.attempts())[0].record).toMatchObject({ state: "resolved", resolution_basis: "provider_response_terminal" });
    expect((await database.pool.query("SELECT request_receipts FROM inventory.quantity_publication_response_recoveries WHERE attempt_id=$1", [attempt.id])).rows)
      .toMatchObject([{ request_receipts: [{ outcome: "completed" }, { outcome: "completed" }, { outcome: "uncertain" }] }]);
    const catchups = (await database.pool.query("SELECT revision,completed_revision FROM inventory.quantity_publication_catchup WHERE scope_key=ANY($1::text[])",
      [f.members.map(quantityPublicationScopeLockKey)])).rows;
    expect(catchups).toHaveLength(2);
    for (const catchup of catchups) expect(BigInt(catchup.completed_revision)).toBeLessThan(BigInt(catchup.revision));
  });

  it("does not associate another group, marketplace, incomplete member scope, or earlier request with a stage", async () => {
    const f = fixture(); await expect(f.publish()).rejects.toThrow();
    expect((await f.reader.read({ ...f.input, marketplaceId: "EBAY_CA" })).evidence).toBeNull();
    expect((await f.reader.read({ ...f.input, scopes: [f.group] })).evidence).toBeNull();
    expect((await f.reader.read({ ...f.input, startedAt: new Date(time + 1).toISOString() })).evidence).toBeNull();
    await expect(f.reader.read({ ...f.input, groupKey: "different-group" })).rejects.toThrow("exact group");
  });

  it("requires the exact single-offer path and empty publish body, including a retained invalid-field refusal", async () => {
    const f = fixture();
    const scope = f.members[0];
    await expect(f.admission.run(scope, () => observeEbayQuantityRequest({ method: "POST",
      path: "/sell/inventory/v1/offer/offer-P5/publish" }, async () => {
      recordQuantityProviderResponse({ ...retainedRejection, errorCodes: ["25016"] });
      throw new Error("retained invalid-field refusal");
    }))).rejects.toThrow("retained invalid-field refusal");
    const input = { ...f.input, groupKey: null, scopes: [scope], offerIds: ["offer-P5"] };
    expect((await f.reader.read(input)).evidence).toMatchObject({ requests: [{
      path: "/sell/inventory/v1/offer/offer-P5/publish", errorCodes: ["25016"], outcome: "uncertain",
    }] });
    expect((await f.reader.read({ ...input, offerIds: ["different-offer"] })).evidence).toBeNull();
    expect((await f.recovery().reconcile([scope])).resolved).toHaveLength(1);
  });

  it.each([
    { ...retainedRejection, httpStatus: 500 },
    { ...retainedRejection, errorCodes: ["25001"] },
    { ...retainedRejection, requestTerminated: null },
    { ...retainedRejection, outcome: "completed" as const, httpStatus: 200, errorCodes: [] },
    null,
  ])("leaves missing, accepted, or unknown publication effects fenced (%j)", async evidence => {
    const f = fixture();
    if (evidence?.outcome === "completed") await f.publish(evidence);
    else await expect(f.publish(evidence)).rejects.toThrow();
    const attempt = (await f.attempts())[0];
    expect((await f.reader.read(f.input)).evidence).toBeNull();
    const result = await f.recovery().reconcile(f.input.scopes);
    expect(result.resolved).toEqual([]);
    if (evidence?.outcome !== "completed") expect(result.unresolved).toEqual([attempt.id]);
  });

  it("rejects historical bulk success without complete per-operation response evidence", async () => {
    const f = fixture(); await expect(f.publish(retainedRejection, null)).rejects.toThrow();
    const attempt = (await f.attempts())[0];
    expect((await f.reader.read(f.input)).evidence).toBeNull();
    expect((await f.recovery().reconcile(f.input.scopes)).unresolved).toEqual([attempt.id]);
  });

  it("retains caller transaction locks while the listing owner records the proof", async () => {
    const f = fixture(); await expect(f.publish()).rejects.toThrow();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      expect((await f.reader.read(f.input, client)).evidence).not.toBeNull();
      expect(await f.reader.read(f.input)).toEqual({ busy: true, evidence: null });
      await expect(f.admission.run(f.group, vi.fn())).rejects.toMatchObject({ code: "PUBLICATION_SCOPE_BUSY" });
      await client.query("ROLLBACK");
      expect((await f.reader.read(f.input)).evidence).not.toBeNull();
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("rolls back the audit and recovery transition together, then safely replays under concurrent recovery", async () => {
    const f = fixture(); await expect(f.publish()).rejects.toThrow();
    const attempt = (await f.attempts())[0];
    const faulty = { connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (sql: string, args?: unknown[]) => {
          if (sql.includes("SET state='resolved'")) throw new Error("injected owner transition failure");
          return client.query(sql, args);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
    await expect(f.recovery(faulty).reconcile(f.input.scopes)).rejects.toMatchObject({ code: "PUBLICATION_RESPONSE_RECOVERY_FAILED" });
    expect((await f.attempts())[0].record).toEqual(attempt.record);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_response_recoveries WHERE attempt_id=$1", [attempt.id])).rows[0].n).toBe(0);
    const results = await Promise.all([f.recovery().reconcile(f.input.scopes), f.recovery().reconcile(f.input.scopes)]);
    expect(results.flatMap(result => result.resolved)).toEqual([attempt.id]);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_response_recoveries WHERE attempt_id=$1", [attempt.id])).rows[0].n).toBe(1);
  });

  it("does not reuse an earlier rejection proof after a later accepted publication", async () => {
    const f = fixture(); await expect(f.publish()).rejects.toThrow();
    await f.recovery().reconcile(f.input.scopes);
    time += 1;
    await f.publish({ ...retainedRejection, outcome: "completed", httpStatus: 200, errorCodes: [] });
    expect((await f.reader.read(f.input)).evidence).toBeNull();
  });

  it("persists the actual title-case provider refusal as rejected and keeps the policy reason", async () => {
    const f = fixture();
    const request = vi.fn<typeof fetch>(async (_url, options) => options?.method === "GET"
      ? new Response(JSON.stringify({ variantSKUs: f.members.map(member => member.externalInventoryItemId) }), { status: 200 })
      : new Response(JSON.stringify({ errors: [{ errorId: 25007,
        category: "Request", message: "You've provided an invalid shipping policy." }] }), { status: 400 }));
    const api = new EbayApiClient({ getAccessToken: async () => "mock-token" }, 67, "sandbox", { request, now: clock,
      quantityAdmission: async () => ({ item: (_sku, work) => work(null), group: (_group, _skus, work) => work(null), reducing: (_identity, work) => work() }) });
    await expect(f.admission.run(f.group, () => api.publishOfferByInventoryItemGroup(f.input.groupKey!, "EBAY_US")))
      .rejects.toMatchObject({ code: "EBAY_SHIPPING_POLICY_REJECTED", message: expect.stringContaining("invalid shipping policy") });
    expect((await f.attempts())[0].record).toMatchObject({ state: "rejected", resolution_basis: "provider_rejection" });
    expect((await f.reader.read({ ...f.input, scopes: [f.group] })).evidence).not.toBeNull();
    expect(request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(1);
  });
});
