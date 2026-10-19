import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { installEbayPublicationInventoryFixture } from "../fixtures/ebay-publication-inventory.fixture";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import { PostgresQuantityPublicationAdmission, quantityPublicationScopeLockKey } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresEbayAutomaticPublicationRecoveryRepository } from "../../infrastructure/ebay-automatic-publication-recovery.repository";
import { PostgresEbayPublicationRejectionReader } from "../../infrastructure/ebay-publication-rejection.reader";
import { EbayAutomaticPublicationRecoveryService } from "../../application/ebay-automatic-publication-recovery.service";
import { InventoryPublicationNotSentError } from "../../application/inventory-publication-transport";
import { observeEbayQuantityRequest } from "../../application/quantity-provider-request-evidence";
import { preflightEvidenceHash, type EbayRequestJournalContract } from "../../domain/ebay-publication-preflight";
import type { QuantityPublicationScope } from "../../domain/quantity-publication-admission";
import { EbayAdapter } from "../../../channels/adapters/ebay.adapter";
import { ChannelInventoryPublicationTransportAdapter } from "../../../channels/channel-inventory-publication-transport.adapter";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const member: QuantityPublicationScope = { destinationKind: "channel_connection", connectionId: 9, providerKey: "ebay", providerScopeType: "account",
  externalScopeId: "seller-36", externalInventoryItemId: "P5", productId: 20, productVariantId: 101 };
const group: QuantityPublicationScope = { ...member, externalInventoryItemId: "group:PACK", productVariantId: null };
const contract: EbayRequestJournalContract = { version: 1, provider: "ebay", method: "POST",
  path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
  requestHash: preflightEvidenceHash({ inventoryItemGroupKey: "PACK", marketplaceId: "EBAY_US" }) };

dbDescribe.sequential("stock preflight attribution and saved publication recovery on PostgreSQL", () => {
  let database: InventoryCutoverTestDatabase;
  let now: Date;
  const clock = () => new Date(now);
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayPublicationInventoryFixture(database.pool, { includePreflightRecoveryMigrations: true, seedPublicationJob: false });
    for (const file of ["0731_ebay_listing_sync_verification_checkpoint.sql", "0732_ebay_listing_sync_identity_admission.sql",
      "0736_ebay_listing_mapping_repairs.sql", "0737_ebay_publication_completion.sql"])
      await database.pool.query(readFileSync(resolve("migrations", file), "utf8"));
    await database.pool.query("UPDATE channels.channel_listings SET external_sku='P5',external_product_id='listing-20'");
    now = (await database.pool.query<{ now: Date }>("SELECT transaction_timestamp() AS now")).rows[0]!.now;
    await ensureEbayPublicationReady(database.pool, { channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production", productId: 20,
      purpose: "sync", variants: [{ productVariantId: 101, sku: "P5" }] }, { commandKey: randomUUID(), actor: "fixture", now });
    now = new Date(now.getTime() + 1_000);
  }, 60_000);
  afterEach(async () => { vi.restoreAllMocks(); await database?.close(); });

  const command = () => ({ syncJobId: randomUUID(), syncRevision: "1", scopes: [group, member] });
  function recovery() { return new EbayAutomaticPublicationRecoveryService(new PostgresEbayAutomaticPublicationRecoveryRepository(database.pool), clock); }
  async function history(count = 1, options: { scope?: QuantityPublicationScope; contract?: EbayRequestJournalContract; errorCode?: string | null } = {}) {
    const scope = options.scope ?? { ...member, productId: null };
    const key = quantityPublicationScopeLockKey(scope);
    // Historical admission snapshots model a process loss before completion;
    // real automatic-recovery transactions must supply every retained receipt.
    return (await database.pool.query<{ id: string }>(`INSERT INTO inventory.quantity_publication_attempts
      (owner_token,owner_kind,gate_epoch,scope_key,scope,outbox_id,affected_scope_keys,affected_scopes,state,started_at,error_code,request_journal_contract)
      SELECT token,'outbox',0,$2,$3::jsonb,o.id,ARRAY[$2],$4::jsonb,'running',$5,$6,$7::jsonb
      FROM (SELECT id FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 AND product_variant_id=101
        ORDER BY desired_revision DESC LIMIT 1) o CROSS JOIN unnest($1::uuid[]) token
      RETURNING id::text`, [Array.from({ length: count }, () => randomUUID()), key, JSON.stringify(scope), JSON.stringify([scope]), now,
      options.errorCode ?? null, options.contract ? JSON.stringify(options.contract) : null])).rows.map(row => row.id);
  }
  async function snapshot() {
    return (await database.pool.query(`SELECT
      (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.id) FROM inventory.quantity_publication_attempts a) AS attempts,
      (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.attempt_id) FROM inventory.ebay_automatic_publication_recoveries r) AS receipts,
      (SELECT jsonb_agg(to_jsonb(n) ORDER BY n.attempt_id) FROM inventory.quantity_publication_no_request_recoveries n) AS no_request_recoveries,
      (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM inventory.ebay_publication_reconciliation_watches w) AS watches,
      (SELECT jsonb_agg(to_jsonb(q) ORDER BY q.id) FROM inventory.quantity_provider_requests q) AS requests`)).rows[0];
  }
  const input = () => ({ scopes: [group, member], startedAt: now.toISOString(), groupKey: "PACK", marketplaceId: "EBAY_US",
    offerIds: ["offer-P5"], stageJournalContract: contract });
  async function recover(rollback = false) {
    const client = await database.pool.connect();
    const query = vi.spyOn(client, "query");
    try {
      await client.query("BEGIN");
      const result = await new PostgresEbayPublicationRejectionReader(database.pool, clock).recoverNotSent(input(), client);
      await client.query(rollback ? "ROLLBACK" : "COMMIT");
      return { result, statements: query.mock.calls.map(call => String(call[0])) };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { query.mockRestore(); client.release(); }
  }
  async function claim() {
    const claims = await new PostgresInventoryPublicationOutboxRepository(database.pool).claimDue({
      batchSize: 25, leaseSeconds: 3600, leaseToken: randomUUID(), now });
    const selected = claims.find(row => row.publicationTargetId === 3);
    expect(selected).toBeDefined();
    return selected!;
  }

  it("attributes 655 historical read failures and a null-code crash without changing their unknown outcome or watch", async () => {
    await database.pool.query("SELECT setval('inventory.quantity_publication_attempts_id_seq',9007199254740993,false)");
    const ids: string[] = [];
    for (let offset = 0; offset < 655; offset += 100) {
      const batch = await history(Math.min(100, 655 - offset), { errorCode: "EBAY_INVENTORY_OFFER_AMBIGUOUS" });
      ids.push(...batch);
      expect(await recovery().recover(command())).toMatchObject({ superseded: batch, unresolved: [], busy: false });
    }
    const crash = await history(); ids.push(...crash);
    expect(ids[0]).toBe("9007199254740993");
    expect(crash).toEqual(["9007199254741648"]);
    expect(await recovery().recover(command())).toMatchObject({ superseded: crash, unresolved: [] });
    // Reconciliation evolves independently. Immutable scope/receipt authority
    // remains valid while the same recurring obligation needs attention.
    await database.pool.query("UPDATE inventory.ebay_publication_reconciliation_watches SET state='needs_attention',last_error_code='EBAY_INVENTORY_OFFER_AMBIGUOUS'");
    const before = await snapshot();
    const first = await recover();
    expect(first.result).toMatchObject({ busy: false, evidence: { attemptIds: [], proofs: [], stageJournalContract: contract,
      excludedStockHistory: { count: 656, preflightNotSentCount: 0, supersededUnknownCount: 656,
        firstAttemptId: ids[0], lastAttemptId: ids.at(-1), evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/) } } });
    expect(JSON.stringify(first.result.evidence).length).toBeLessThan(1_000);
    expect(first.statements.filter(sql => sql.includes("AS before_record_text"))).toHaveLength(7);
    expect(first.statements.filter(sql => sql.includes('q.id::text AS "requestId"'))).toHaveLength(0);
    expect((await recover(true)).result).toEqual(first.result);
    expect((await recover()).result).toEqual(first.result);
    expect(await snapshot()).toEqual(before);
  }, 60_000);

  it("keeps a null-code crash blocked without its immutable replacement receipt", async () => {
    await history();
    const before = await snapshot();
    expect((await recover()).result).toEqual({ busy: false, evidence: null });
    expect(await snapshot()).toEqual(before);
  });
  it("rolls back the actual no-send transition with its caller transaction while preserving attributed stock history", async () => {
    await history();
    await recovery().recover(command());
    const scopes = [group, member].sort((a, b) => quantityPublicationScopeLockKey(a).localeCompare(quantityPublicationScopeLockKey(b)));
    const attempt = (await database.pool.query<{ id: string }>(`INSERT INTO inventory.quantity_publication_attempts
      (owner_token,owner_kind,gate_epoch,scope_key,scope,affected_scope_keys,affected_scopes,state,started_at,request_journal_contract)
      VALUES($1,'legacy',0,$2,$3::jsonb,$4,$5::jsonb,'running',$6,$7::jsonb) RETURNING id::text`,
    [randomUUID(), quantityPublicationScopeLockKey(group), JSON.stringify(group), scopes.map(quantityPublicationScopeLockKey),
      JSON.stringify(scopes), now, JSON.stringify(contract)])).rows[0]!;
    const before = await snapshot();
    const rolledBack = await recover(true);
    expect(rolledBack.result.evidence).toMatchObject({ attemptIds: [attempt.id], excludedStockHistory: { count: 1 } });
    expect(await snapshot()).toEqual(before);
    const committed = await recover();
    expect(committed.result).toEqual(rolledBack.result);
    const after = await snapshot();
    expect(after.receipts).toEqual(before.receipts);
    expect(after.watches).toEqual(before.watches);
    expect(after.attempts).toEqual([before.attempts[0], expect.objectContaining({ state: "not_sent", resolution_basis: "owner_preflight_no_request" })]);
    expect(after.no_request_recoveries).toHaveLength(1);
    expect((await recover()).result).toEqual(committed.result);
  });
  it.each(["externalInventoryItemId", "externalScopeId", "productVariantId"] as const)("rejects an outbox snapshot with mismatched %s", async field => {
    const scope = { ...member, productId: null, [field]: field === "productVariantId" ? 102 : "OTHER" };
    const ids = await history(1, { scope });
    expect(await recovery().recover({ ...command(), scopes: [{ ...scope, productId: 20 }] })).toMatchObject({ superseded: [], unresolved: ids });
    // For a key that overlaps the saved listing (variant mismatch), the reader
    // also refuses attribution. Unrelated account/SKU keys never count as proof.
    if (field === "productVariantId") expect((await recover()).result.evidence).toBeNull();
    expect((await snapshot()).receipts).toBeNull();
  });
  it("does not let a contradictory original publication contract borrow a stock replacement receipt", async () => {
    const ids = await history(1, { contract });
    expect(await recovery().recover(command())).toMatchObject({ superseded: ids, unresolved: [] });
    const before = await snapshot();
    expect((await recover()).result).toEqual({ busy: false, evidence: null });
    expect(await snapshot()).toEqual(before);
  });
  it("accepts an explicit valid stock-only journal contract without claiming the stock effect is known", async () => {
    const ids = await history(1, { contract: { ...contract, path: "/sell/inventory/v1/bulk_update_price_quantity" } });
    expect(await recovery().recover(command())).toMatchObject({ superseded: ids, unresolved: [] });
    const before = await snapshot();
    expect((await recover()).result.evidence).toMatchObject({ attemptIds: [], excludedStockHistory: {
      count: 1, supersededUnknownCount: 1, preflightNotSentCount: 0 } });
    expect(await snapshot()).toEqual(before);
  });
  it("retains the publication-candidate limit for 101 unproved crashes", async () => {
    await history(101);
    expect((await recover()).result).toEqual({ busy: false, evidence: null });
    expect((await snapshot()).receipts).toBeNull();
  });
  it("fences concurrent recovery and forbids rewriting receipt, outbox or watch identity", async () => {
    const ids = await history();
    const replaced = await recovery().recover(command());
    expect(replaced.superseded).toEqual(ids);
    for (const [sql, code] of [["UPDATE inventory.ebay_automatic_publication_recoveries SET scope_keys=ARRAY['wrong']", "23514"],
      ["UPDATE inventory.ebay_automatic_publication_recoveries SET request_evidence='[{}]'::jsonb", "23514"],
      ["UPDATE inventory.ebay_publication_reconciliation_watches SET scopes='[]'::jsonb", "23514"],
      ["UPDATE inventory.inventory_publication_outbox SET external_inventory_item_id_snapshot='OTHER' WHERE publication_target_id=3", "P0001"]])
      await expect(database.pool.query(sql)).rejects.toMatchObject({ code });
    const blocker = await database.pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1,918420))", [quantityPublicationScopeLockKey(member)]);
      expect((await recover()).result).toEqual({ busy: true, evidence: null });
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
    expect((await recover()).result.evidence?.excludedStockHistory?.count).toBe(1);
  });
  it.each([{ method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", stock: true },
    { method: "POST", path: "/sell/inventory/v1/offer/offer-P5/publish", stock: false },
    { method: "PUT", path: "/sell/inventory/v1/inventory_item/P5", stock: false }])(
    "preserves unknown effects while separating immutable stock purpose from publication: $method $path", async ({ method, path, stock }) => {
      const outbox = await claim();
      await expect(new PostgresQuantityPublicationAdmission(database.pool, clock).runOutbox(outbox, () =>
        observeEbayQuantityRequest({ method, path, body: {} }, async () => {
          throw new InventoryPublicationNotSentError("TEST_PREFLIGHT", "A request already started", true);
        }))).rejects.toThrow("A request already started");
      const beforeRecovery = await snapshot();
      expect(beforeRecovery.attempts).toEqual([expect.objectContaining({ state: "uncertain", completed_at: null })]);
      const replaced = await recovery().recover(command());
      expect(replaced.superseded.length).toBe(stock || method === "PUT" ? 1 : 0);
      const before = await snapshot();
      const recovered = (await recover()).result;
      if (stock) expect(recovered.evidence).toMatchObject({ attemptIds: [], excludedStockHistory: {
        count: 1, preflightNotSentCount: 0, supersededUnknownCount: 1 } });
      else expect(recovered).toEqual({ busy: false, evidence: null });
      expect(await snapshot()).toEqual(before);
    });
  it("classifies actual Channel offer discovery failures as not_sent using the independent PostgreSQL request collector", async () => {
    const outbox = await claim();
    const adapter = new EbayAdapter({ select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn() } as never,
      { resolve: vi.fn(async () => ({ byVariantId: new Map(), groupImageUrls: [] })) });
    const client = { getInventoryOffersPage: vi.fn(async () => ({ total: 1, offers: [
      { sku: "P5", marketplaceId: "EBAY_US", offerId: "offer-P5", status: "UNPUBLISHED", availableQuantity: 0 }] })),
      getInventoryItem: vi.fn(), bulkUpdatePriceQuantity: vi.fn() };
    vi.spyOn(adapter as unknown as { getApiClient(): Promise<typeof client> }, "getApiClient").mockResolvedValue(client);
    vi.spyOn(adapter as unknown as { getConnectionMetadata(): Promise<{ siteId: string }> }, "getConnectionMetadata").mockResolvedValue({ siteId: "EBAY_US" });
    const transport = new ChannelInventoryPublicationTransportAdapter(adapter);
    const admission = new PostgresQuantityPublicationAdmission(database.pool, clock);
    await expect(admission.runOutbox(outbox, () => transport.publishAbsolute({
      destination: { kind: "channel_connection", channelConnectionId: 9, dropshipStoreConnectionId: null }, channelId: 67,
      productVariantId: 101, providerScopeType: "account", externalScopeId: "seller-36", externalInventoryItemId: "P5",
      externalSku: "P5", desiredQuantity: Number(outbox.desiredQuantity),
    }))).rejects.toMatchObject({ code: "EBAY_INVENTORY_OFFER_AMBIGUOUS" });
    expect(client.bulkUpdatePriceQuantity).not.toHaveBeenCalled();
    const before = await snapshot();
    expect(before.attempts).toEqual([expect.objectContaining({ state: "not_sent", resolution_basis: "owner_preflight_no_request",
      outcome_hash: expect.stringMatching(/^[a-f0-9]{64}$/), completed_at: expect.any(String) })]);
    expect(before.requests).toBeNull();
    expect((await recover()).result.evidence).toMatchObject({ attemptIds: [], excludedStockHistory: {
      count: 1, preflightNotSentCount: 1, supersededUnknownCount: 0 } });
    expect(await snapshot()).toEqual(before);
  });
});
