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
import { observeEbayQuantityRequest, recordQuantityProviderResponse, withEbayQuantityRequestJournal } from "../../application/quantity-provider-request-evidence";
import { preflightEvidenceHash, type EbayRequestJournalContract, type LegacyEbayPublicationPreflightProof } from "../../domain/ebay-publication-preflight";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";

vi.mock("../../../../db", () => ({ pool: {} }));
const dbDescribe = process.env.ECHELON_TEST_DATABASE_URL && process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true" ? describe : describe.skip;
const groupPath = "/sell/inventory/v1/offer/publish_by_inventory_item_group";
const timestamp = new Date("2026-10-17T12:00:00.000Z");
const clock = () => new Date(timestamp);

dbDescribe.sequential("eBay preflight no-send recovery on disposable PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let sequence = 0;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(process.env.ECHELON_TEST_DATABASE_URL, true, cutoverCompositionBaseSql);
    await installCutoverCompositionMigrations(database.pool);
    for (const file of ["0709_walmart_quantity_admission.sql", "0716_inventory_publication_reconciliation.sql",
      "0729_ebay_listing_sync_recovery.sql", "0733_ebay_provider_response_finality.sql", "0734_ebay_operator_republication_recovery.sql",
      "0749_quantity_outbox_preflight_completion.sql", "900000008000018120001_ebay_automatic_sync_recovery.sql",
      "900000011000018270001_ebay_publication_preflight_recovery.sql"]) {
      await database.pool.query(readFileSync(resolve(process.cwd(), "migrations", file), "utf8"));
    }
    await database.pool.query(cutoverCompositionSeedSql);
    await database.pool.query(cutoverCompositionLegacyChannelSeedSql);
  }, 60000);
  afterAll(async () => { await database?.close(); });

  function fixture(pool: Pick<Pool, "connect"> = database.pool) {
    const groupKey = `PREFLIGHT-${++sequence}`;
    const base = { destinationKind: "channel_connection" as const, connectionId: 1, providerKey: "ebay" as const,
      providerScopeType: "account" as const, externalScopeId: `account-${sequence}`, productId: 20 };
    const group: QuantityPublicationScope = { ...base, externalInventoryItemId: `group:${groupKey}`, productVariantId: null };
    const members: QuantityPublicationScope[] = ["C500", "P10"].map((suffix, index) => ({ ...base,
      externalInventoryItemId: `${groupKey}-${suffix}`, productVariantId: 101 + index }));
    const input: EbayPublicationRejectionInput = { scopes: [group, ...members], startedAt: clock().toISOString(),
      groupKey, marketplaceId: "EBAY_US", offerIds: ["offer-C500", "offer-P10"] };
    const admission = new PostgresQuantityPublicationAdmission(pool, clock);
    let currentQuantity = 17;
    let failRead = true;
    let publishCount = 0;
    const request = vi.fn<typeof fetch>(async (url, options) => {
      const path = new URL(String(url)).pathname;
      if (options?.method === "GET") {
        if (path.includes("inventory_item_group")) return Response.json({ variantSKUs: members.map(member => member.externalInventoryItemId) });
        if (path.endsWith("/offer")) {
          if (failRead) return Response.json({ errors: [{ errorId: 25001, category: "System", message: "A system error has occurred." }] }, { status: 500 });
          const sku = new URL(String(url)).searchParams.get("sku")!;
          return Response.json({ total: 1, offers: [{ sku, offerId: sku.endsWith("C500") ? "offer-C500" : "offer-P10", status: "UNPUBLISHED" }] });
        }
        return Response.json({ product: { title: "Current catalog", imageUrls: ["https://example.com/current.jpg"] },
          availability: { shipToLocationAvailability: { quantity: 0 } } });
      }
      if (path.endsWith("bulk_update_price_quantity")) {
        const body = JSON.parse(String(options?.body));
        const responses = body.requests.flatMap((row: { sku: string; offers: Array<{ offerId: string }> }) =>
          [{ sku: row.sku, statusCode: 200 }, ...row.offers.map(offer => ({ sku: row.sku, offerId: offer.offerId, statusCode: 200 }))]);
        return Response.json({ responses });
      }
      if (path === groupPath) { publishCount += 1; return Response.json({ listingId: "listing-current" }); }
      throw new Error(`Unexpected provider mutation ${options?.method} ${path}`);
    });
    const api = new EbayApiClient({ getAccessToken: async () => "test-token" }, 67, "sandbox", { request, now: clock,
      quantityAdmission: async () => ({ item: (_sku, work) => work(null), reducing: (_identity, work) => work(),
        group: (_key, _skus, work) => admission.runListingGroup(group, members,
          async () => { throw new Error("Legacy fixture must not calculate ATP"); },
          () => work(new Map(members.map(member => [member.externalInventoryItemId, currentQuantity])))) }) });
    const attempts = async () => (await database.pool.query<{ id: string; state: string; request_journal_contract: unknown; record: Record<string, unknown> }>(
      "SELECT id::text,state,request_journal_contract,to_jsonb(a) AS record FROM inventory.quantity_publication_attempts a WHERE scope_key=$1 ORDER BY id",
      [quantityPublicationScopeLockKey(group)])).rows;
    const reader = new PostgresEbayPublicationRejectionReader(pool, clock);
    const recover = async (proof?: LegacyEbayPublicationPreflightProof, stageJournalContract?: EbayRequestJournalContract) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await reader.recoverNotSent({ ...input, ...(proof ? { legacyPreflightProof: proof } : {}),
          ...(stageJournalContract ? { stageJournalContract } : {}) }, client);
        await client.query("COMMIT");
        return result;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    };
    const proof: LegacyEbayPublicationPreflightProof = { jobId: "a431361e-5bf5-4249-9b17-bf3dc860a980", revision: "1",
      stageEventId: "101", stageStartedAt: clock().toISOString(), failureEventId: "102", failureAt: clock().toISOString(),
      groupKey, marketplaceId: "EBAY_US", memberSkus: members.map(member => member.externalInventoryItemId),
      failedRequest: { method: "GET", path: `/sell/inventory/v1/offer?sku=${members[0].externalInventoryItemId}&marketplace_id=EBAY_US`,
        httpStatus: 500, errorCodes: ["25001"] }, sourceEvidenceHash: "a".repeat(64) };
    const stageContract: EbayRequestJournalContract = { version: 1, provider: "ebay", method: "POST", path: groupPath,
      requestHash: preflightEvidenceHash({ inventoryItemGroupKey: groupKey, marketplaceId: "EBAY_US" }) };
    const nonPublication = (method: "POST" | "PUT", path: string, response = true) => {
      const mutation = { method, path, body: { fixture: "stock/content" } };
      return withEbayQuantityRequestJournal(mutation, () => admission.runListingGroup(group, members,
        async () => { throw new Error("No plan expected"); }, () => observeEbayQuantityRequest(mutation, async () => {
          if (!response) throw new Error("stock response lost");
          recordQuantityProviderResponse({ outcome: "completed", httpStatus: 200, providerRequestId: null,
            responseHash: preflightEvidenceHash({ accepted: true }), errorCodes: [], retryNotBefore: null,
            cooldownScope: null, requestTerminated: true });
        })));
    };
    return { group, members, input, admission, api, request, attempts, recover, proof, reader, stageContract, nonPublication,
      publish: () => api.publishOfferByInventoryItemGroup(groupKey, "EBAY_US"),
      allowRead: (quantity: number) => { failRead = false; currentQuantity = quantity; }, publishCount: () => publishCount,
      legacyFailure: () => admission.runListingGroup(group, members, async () => { throw new Error("No plan expected"); },
        async () => { throw new Error("retained first-member GET failed (500)"); }) };
  }

  function faultyPool(fail: (sql: string, args: unknown[] | undefined) => "before" | "after" | null): Pick<Pool, "connect"> {
    return { connect: async () => {
      const client = await database.pool.connect();
      return new Proxy(client, { get(target, property) {
        if (property === "query") return async (sql: string, args?: unknown[]) => {
          const failure = fail(sql, args);
          if (failure === "before") throw new Error("injected process interruption");
          const result = await client.query(sql, args);
          if (failure === "after") throw new Error("injected process interruption");
          return result;
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
    } };
  }

  it("marks a failed offer GET not_sent and retries the same offers with fresh quantities before one publication", async () => {
    const f = fixture();
    await expect(f.publish()).rejects.toThrow("GET /sell/inventory/v1/offer?");
    const [first] = await f.attempts();
    expect(first).toMatchObject({ state: "not_sent", request_journal_contract: { version: 1, method: "POST", path: groupPath } });
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_provider_requests WHERE attempt_id=$1", [first.id])).rows[0].n).toBe(0);
    expect(f.request.mock.calls.every(([, options]) => options?.method === "GET")).toBe(true);
    expect((await f.recover()).evidence).toMatchObject({ attemptIds: [first.id] });
    f.allowRead(29);
    await expect(f.publish()).resolves.toEqual({ listingId: "listing-current" });
    expect(f.publishCount()).toBe(1);
    const bulkWrites = f.request.mock.calls.filter(([url]) => String(url).includes("bulk_update_price_quantity"));
    expect(bulkWrites).toHaveLength(2);
    for (const [, options] of bulkWrites) expect(JSON.parse(String(options?.body)).requests[0]).toMatchObject({
      shipToLocationAvailability: { quantity: 29 }, offers: [{ availableQuantity: 29 }],
    });
    expect((await f.attempts()).map(attempt => attempt.state)).toEqual(["not_sent", "succeeded"]);
    expect((await f.recover()).evidence).toBeNull(); // A later publish cannot be relabeled as not sent.
  });

  it("recovers a journaled stage crash before admission but never infers coverage for an old empty stage", async () => {
    const f = fixture();
    expect((await f.recover()).evidence).toBeNull();
    expect((await f.recover(f.proof)).evidence).toBeNull();
    expect((await f.recover(undefined, { ...f.stageContract, requestHash: "b".repeat(64) })).evidence).toBeNull();
    expect((await f.recover(undefined, { ...f.stageContract, path: "/sell/inventory/v1/offer/other/publish" })).evidence).toBeNull();
    const result = await f.recover(undefined, f.stageContract);
    expect(result).toMatchObject({ busy: false, evidence: { attemptIds: [], proofs: [], stageJournalContract: f.stageContract } });
    expect(await f.recover(undefined, f.stageContract)).toEqual(result);
    expect(await f.attempts()).toEqual([]);
    f.allowRead(41); await f.publish();
    expect(f.publishCount()).toBe(1);
    expect((await f.recover(undefined, f.stageContract)).evidence).toBeNull();
  });

  it("requires the exact scope locks even when no request has entered admission", async () => {
    const f = fixture();
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,918420))", [quantityPublicationScopeLockKey(f.members[0])]);
      expect(await f.recover(undefined, f.stageContract)).toEqual({ busy: true, evidence: null });
    } finally { await client.query("ROLLBACK"); client.release(); }
    expect((await f.recover(undefined, f.stageContract)).evidence).not.toBeNull();
  });

  it("does not mistake completed same-millisecond preparations for the publish stage", async () => {
    const f = fixture();
    for (const path of [`/sell/inventory/v1/inventory_item/${f.members[0].externalInventoryItemId}`,
      "/sell/inventory/v1/offer/offer-C500", `/sell/inventory/v1/inventory_item_group/${f.input.groupKey}`]) {
      await f.nonPublication("PUT", path);
    }
    await expect(f.legacyFailure()).rejects.toThrow();
    const attempts = await f.attempts();
    expect(attempts.slice(0, 3).every(attempt => attempt.state === "succeeded")).toBe(true);
    expect((await f.recover(f.proof)).evidence?.attemptIds).toEqual([attempts[3].id]);
    expect((await f.attempts()).map(attempt => attempt.state)).toEqual(["succeeded", "succeeded", "succeeded", "not_sent"]);
  });

  it("keeps old no-send proof replayable after multiple pages of later completed stock updates", async () => {
    const f = fixture(); await expect(f.legacyFailure()).rejects.toThrow();
    const original = await f.recover(f.proof);
    // Stock is admitted only after the old uncertain attempt has its real
    // no-send receipt. Retained channel recovery must still accept that receipt
    // if later stock history exists when its checkpoint is inspected again.
    for (let index = 0; index < 101; index++) await f.nonPublication("POST", "/sell/inventory/v1/bulk_update_price_quantity");
    expect(await f.recover(f.proof)).toEqual(original);
    expect((await f.attempts()).filter(attempt => attempt.state === "succeeded")).toHaveLength(101);
  }, 30000);

  it("preserves a later lost stock response for normal quantity recovery", async () => {
    const f = fixture(); await expect(f.legacyFailure()).rejects.toThrow();
    await f.recover(f.proof);
    await expect(f.nonPublication("POST", "/sell/inventory/v1/bulk_update_price_quantity", false)).rejects.toThrow("stock response lost");
    const attempts = await f.attempts();
    const unresolved = attempts[1];
    expect(unresolved.state).toBe("uncertain");
    expect((await f.recover(f.proof)).evidence).toBeNull();
    expect((await f.recover(undefined, f.stageContract)).evidence).toBeNull();
    expect(await new PostgresQuantityProviderResponseRecovery(database.pool, clock).reconcile(f.input.scopes))
      .toEqual({ resolved: [], unresolved: [unresolved.id], busy: false });
    expect((await f.attempts())[1].record).toEqual(unresolved.record);
  });

  it("recovers a crash after attempt commit before callback, preserves the contract and replays recovery once", async () => {
    let created = false, crashed = false;
    const pool = faultyPool(sql => {
      if (sql.includes("INSERT INTO inventory.quantity_publication_attempts")) created = true;
      if (created && !crashed && sql === "COMMIT") { crashed = true; return "after"; }
      return null;
    });
    const f = fixture(pool);
    await expect(f.publish()).rejects.toThrow("injected process interruption");
    const [before] = await f.attempts();
    expect(before.state).toBe("running");
    const recovered = await f.recover();
    expect(recovered.evidence?.attemptIds).toEqual([before.id]);
    expect(await f.recover()).toEqual(recovered);
    const receipt = (await database.pool.query("SELECT before_record,proof FROM inventory.quantity_publication_no_request_recoveries WHERE attempt_id=$1", [before.id])).rows;
    expect(receipt).toEqual([{ before_record: before.record, proof: { source: "request_journal_contract", contract: before.request_journal_contract } }]);
    f.allowRead(31);
    await f.publish();
    expect(f.publishCount()).toBe(1);
  });

  it("recovers a lost no-send acknowledgement through general response recovery after restart", async () => {
    let crashed = false;
    const f = fixture(faultyPool((sql, args) => {
      if (!crashed && sql.includes("SET state=$4") && args?.[3] === "not_sent") { crashed = true; return "before"; }
      return null;
    }));
    await expect(f.publish()).rejects.toThrow("injected process interruption");
    const [before] = await f.attempts(); expect(before.state).toBe("running");
    expect(await new PostgresQuantityProviderResponseRecovery(database.pool, clock).reconcile(f.input.scopes))
      .toEqual({ resolved: [before.id], unresolved: [], busy: false });
    expect((await f.recover()).evidence?.attemptIds).toEqual([before.id]);
  });

  it("does not clear a start committed before transport, even when the worker then crashes", async () => {
    let started = false, crashed = false;
    const f = fixture(faultyPool(sql => {
      if (sql.includes("INSERT INTO inventory.quantity_provider_requests")) started = true;
      if (started && !crashed && sql === "COMMIT") { crashed = true; return "after"; }
      return null;
    }));
    f.allowRead(19);
    await expect(f.publish()).rejects.toThrow("injected process interruption");
    const [attempt] = await f.attempts(); expect(attempt.state).toBe("uncertain");
    expect((await f.recover()).evidence).toBeNull();
    expect((await f.recover(undefined, f.stageContract)).evidence).toBeNull();
    expect(await new PostgresQuantityProviderResponseRecovery(database.pool, clock).reconcile(f.input.scopes))
      .toEqual({ resolved: [], unresolved: [attempt.id], busy: false });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "POST")).toHaveLength(0);
  });

  it("recovers an old exact first-member GET failure only with the immutable channel proof", async () => {
    const f = fixture(); await expect(f.legacyFailure()).rejects.toThrow();
    const [attempt] = await f.attempts(); expect(attempt).toMatchObject({ state: "uncertain", request_journal_contract: null });
    expect((await f.recover()).evidence).toBeNull();
    expect((await new PostgresQuantityProviderResponseRecovery(database.pool, clock).reconcile(f.input.scopes)).unresolved).toEqual([attempt.id]);
    const first = await f.recover(f.proof);
    expect(first.evidence?.attemptIds).toEqual([attempt.id]);
    expect(await f.recover(f.proof)).toEqual(first);
    expect((await f.recover({ ...f.proof, sourceEvidenceHash: "b".repeat(64) })).evidence).toBeNull();
    expect((await f.attempts())[0].record).toMatchObject({ state: "not_sent", error_code: "PROVIDER_OUTCOME_UNCERTAIN", resolution_basis: "owner_preflight_no_request" });
    f.allowRead(23); await f.publish(); expect(f.publishCount()).toBe(1);
  });

  it("keeps a historical proof scoped to its original stage, complete members and first read", async () => {
    const f = fixture(); await expect(f.legacyFailure()).rejects.toThrow();
    expect((await f.recover({ ...f.proof, groupKey: "different" })).evidence).toBeNull();
    await expect(f.recover({ ...f.proof, failedRequest: { ...f.proof.failedRequest,
      path: `/sell/inventory/v1/offer?sku=${f.members[1].externalInventoryItemId}&marketplace_id=EBAY_US` } })).rejects.toThrow("first ordered member");
    expect((await f.recover({ ...f.proof, failureAt: "2026-10-17T12:00:00.001Z", memberSkus: [f.members[0].externalInventoryItemId] })).evidence).toBeNull();
    expect((await f.recover({ ...f.proof, stageStartedAt: "2026-10-17T11:59:59.000Z" })).evidence).toBeNull();
    expect((await f.attempts())[0].state).toBe("uncertain");
  });

  it("rolls back recovery evidence when the transition fails, then safely accepts one concurrent recovery", async () => {
    let failTransition = true;
    const f = fixture(faultyPool(sql => failTransition && sql.includes("SET state='not_sent'") ? "before" : null));
    await expect(f.legacyFailure()).rejects.toThrow();
    const [before] = await f.attempts();
    await expect(f.recover(f.proof)).rejects.toThrow("injected process interruption");
    expect((await f.attempts())[0].record).toEqual(before.record);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_no_request_recoveries WHERE attempt_id=$1", [before.id])).rows[0].n).toBe(0);
    failTransition = false;
    const results = await Promise.all([f.recover(f.proof), f.recover(f.proof)]);
    expect(results.some(result => result.evidence?.attemptIds.includes(before.id))).toBe(true);
    expect((await database.pool.query("SELECT count(*)::int AS n FROM inventory.quantity_publication_no_request_recoveries WHERE attempt_id=$1", [before.id])).rows[0].n).toBe(1);
    await expect(database.pool.query("DELETE FROM inventory.quantity_publication_no_request_recoveries WHERE attempt_id=$1", [before.id]))
      .rejects.toMatchObject({ code: "23514" });
  });

  it("cannot resolve while a live owner could still send a delayed mutation", async () => {
    const f = fixture();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { release = resolve; });
    const mutation = { method: "POST", path: groupPath, body: { inventoryItemGroupKey: f.input.groupKey, marketplaceId: "EBAY_US" } };
    const running = withEbayQuantityRequestJournal(mutation, () => f.admission.runListingGroup(f.group, f.members,
      async () => { throw new Error("No plan expected"); }, async () => {
        entered(); await pending;
        await observeEbayQuantityRequest(mutation, async () => {
          recordQuantityProviderResponse({ outcome: "completed", httpStatus: 200, providerRequestId: null,
            responseHash: preflightEvidenceHash({ listingId: "live" }), errorCodes: [], retryNotBefore: null, cooldownScope: null, requestTerminated: true });
        });
      }));
    await started;
    try { expect(await f.recover()).toEqual({ busy: true, evidence: null }); }
    finally { release(); await running; }
    expect((await f.attempts())[0].state).toBe("succeeded");
  });
});
