import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool } from "pg";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { installCutoverAdmissionFixturePrerequisites } from "../fixtures/inventory-cutover-admission.fixture";
import { createDropshipEbayTarget, sealDropshipMapping } from "../fixtures/dropship-ebay-stock.fixture";
import { createAuthorityAwareInventoryPublicationService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { PostgresQuantityPublicationRecoveryRepository } from "../../infrastructure/quantity-publication-recovery.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";
import { QuantityPublicationRecoveryService } from "../../application/quantity-publication-recovery.service";
import {
  channelStockUpdateDeadLetterDestinationCountSql,
  channelStockUpdateDeadLetterDestinationSampleSql,
} from "../../channel-stock-update-dead-letters";
import { ChannelInventoryPublicationTransportAdapter } from "../../../channels/channel-inventory-publication-transport.adapter";
import { ShopifyAdapter } from "../../../channels/adapters/shopify.adapter";

// Channels PR1 (PLAN-CH-v3 section 6 "Outbox (PR1)" and Ops Health): end to end over the
// real outbox, request admission, planner and Ops Health reader, with Shopify's HTTP faked.
// A Shopify 404 on the stock write dead-letters the update on its FIRST attempt (it used to
// be retried 10 times), the dead letter is logged with its correlation ids, and Ops Health's
// reader keeps showing the store until a newer stock update of that size reaches Shopify.
// A newer update that is only queued does not count: after the refused write the admission
// attempt stays "uncertain", so that newer update is refused before any HTTP call.
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const dbDescribe = url && disposable ? describe : describe.skip;
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const SHOPIFY_CHANNEL = 35;
const SHOPIFY_CONNECTION = 7;
const SHOPIFY_LOCATION = "98765";
const SECOND_LOCATION = "98766";
const SHOPIFY_ITEM = "222";
const SIBLING_ITEM = "223";
const SET_PATH = "https://card-shellz.myshopify.com/admin/api/2024-01/inventory_levels/set.json";

/** What the fake Shopify answers for one (location, item) stock write; any other write is a test bug. */
type ShopifyAnswer = 200 | 400 | 404 | 422;

dbDescribe.sequential("refused Shopify stock update, real PostgreSQL outbox and Ops Health reader", () => {
  let database: InventoryCutoverTestDatabase;
  let targetId: number;
  let now: Date;
  let originalFetch: typeof globalThis.fetch;
  let attestations = 0;
  const dialect = new PgDialect();
  const read = async (query: SQL) => {
    const { sql, params } = dialect.sqlToQuery(query);
    return (await database.pool.query(sql, params as unknown[])).rows;
  };
  const deadLetterHealth = async () => ({
    count: Number((await read(channelStockUpdateDeadLetterDestinationCountSql()))[0]?.count),
    sample: await read(channelStockUpdateDeadLetterDestinationSampleSql(10)),
  });
  const outbox = async (publicationTargetId = targetId, productVariantId = 101) => (await database.pool.query(`SELECT id::text,
      desired_revision::text,desired_quantity::text,state,last_error_class,attempt_count
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 AND product_variant_id=$2 ORDER BY desired_revision`,
  [publicationTargetId, productVariantId])).rows;
  const publish = (publicationTargetId = targetId, productVariantIds = [101]) => createAuthorityAwareInventoryPublicationService(database.pool,
    { logger: quiet }).publishProduct({ productId: 20, publicationTargetId, productVariantIds, dryRun: false, triggeredBy: "dead_letter_test" },
    async () => null);
  const sellFiveUnits = () => database.pool.query(`UPDATE inventory.inventory_levels SET variant_qty=variant_qty-5 WHERE product_variant_id=101;
    UPDATE inventory.inventory_lots SET qty_on_hand=qty_on_hand-5 WHERE product_variant_id=101`);
  const nextDue = async () => {
    now = (await database.pool.query(`SELECT date_trunc('milliseconds',max(available_at))+interval '1 millisecond' AS due
      FROM inventory.inventory_publication_outbox WHERE state='queued'`)).rows[0].due;
  };
  const worker = (pool: Pool, log: ConstructorParameters<typeof PostgresInventoryPublicationOutboxRepository>[1]) => {
    const admission = new PostgresQuantityPublicationAdmission(pool, () => now);
    // Credentials of the exact Shopify connection; the real adapter reads nothing else.
    const credentials = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: SHOPIFY_CONNECTION,
      channelId: SHOPIFY_CHANNEL, shopDomain: "card-shellz.myshopify.com", accessToken: "test-token", apiVersion: "2024-01" }] }) }) }) };
    const adapter = new ShopifyAdapter(credentials as never, admission);
    vi.spyOn(adapter as unknown as { delay(ms: number): Promise<void> }, "delay").mockResolvedValue(undefined);
    const transport = new ChannelInventoryPublicationTransportAdapter(adapter);
    return new InventoryPublicationOutboxService(new PostgresInventoryPublicationOutboxRepository(pool, log),
      { get: () => transport }, { now: () => now }, () => "dead-letter-lease", admission);
  };
  /** Fakes Shopify's stock write (set.json) per (location, item) and answers the readback
   * GET with the quantity it last accepted. Returns the stock writes it received. */
  const fakeShopify = (answers: Readonly<Record<string, ShopifyAnswer>>) => {
    const writes: string[] = [];
    const accepted = new Map<string, number>();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL(String(input));
      if (init?.method === "GET") {
        const key = `${target.searchParams.get("location_ids")}/${target.searchParams.get("inventory_item_ids")}`;
        const [location, item] = key.split("/");
        return Response.json({ inventory_levels: [{ inventory_item_id: Number(item), location_id: Number(location),
          available: accepted.get(key) ?? 0 }] });
      }
      expect(`${init?.method} ${target.href}`).toBe(`POST ${SET_PATH}`);
      const body = JSON.parse(String(init?.body)) as { location_id: number; inventory_item_id: number; available: number };
      const key = `${body.location_id}/${body.inventory_item_id}`;
      writes.push(key);
      const status = answers[key];
      if (status === undefined) throw new Error(`Unexpected Shopify stock write ${key}`);
      if (status !== 200) return new Response(`{"errors":"status ${status}"}`, { status });
      accepted.set(key, body.available);
      return Response.json({ inventory_level: { inventory_item_id: body.inventory_item_id, location_id: body.location_id, available: body.available } });
    }) as typeof globalThis.fetch;
    return writes;
  };
  /** The operator's audited attestation of an uncertain Shopify attempt (POST
   * /api/inventory-planning/admin/publication-recovery/attest, through its real service). */
  const attestUncertainAttempt = async (location: string) => {
    const attempts = (await database.pool.query<{ id: string }>(`SELECT id::text FROM inventory.quantity_publication_attempts
      WHERE owner_kind='outbox' AND state='uncertain' AND scope->>'externalScopeId'=$1`, [location])).rows;
    expect(attempts).toHaveLength(1);
    await new QuantityPublicationRecoveryService(new PostgresQuantityPublicationRecoveryRepository(database.pool), { now: () => now })
      .attest({ attemptId: attempts[0]!.id, idempotencyKey: `attest-${location}-${++attestations}`,
        reason: "Shopify answered 404 for this item; the write did not apply.", evidenceKind: "provider_terminal_request_record",
        terminalOutcome: "completed", evidenceReference: `Shopify set.json 404 at location ${location}`, evidenceHash: "c".repeat(64) },
      "operator-1");
  };
  /** One live Shopify location destination (numeric Shopify ids) with a sealed source binding. */
  const createLiveShopifyTarget = async (location: string): Promise<number> => {
    const id = (await database.pool.query<{ id: number }>(`INSERT INTO inventory.inventory_publication_targets(channel_id,channel_connection_id,
      fulfillment_node_id,provider_scope_type,external_scope_id,publication_authority,state,change_reason,created_by)
      VALUES($1,$2,1,'location',$3,'echelon','disabled','Shopify warehouse location','fixture') RETURNING id`,
    [SHOPIFY_CHANNEL, SHOPIFY_CONNECTION, location])).rows[0]!.id;
    // The binding head must be coherent at commit (deferred trigger): seal and activate it in one transaction.
    const client = await database.pool.connect();
    try {
      await client.query("BEGIN");
      const binding = (await client.query<{ id: string }>(`INSERT INTO inventory.publication_source_binding_versions
        (publication_target_id,version,definition_hash,change_reason,idempotency_key,request_hash,created_by)
        VALUES($1,1,repeat('b',64),'Shopify source',$2,repeat('b',64),'fixture') RETURNING id::text`,
      [id, `shopify-dead-letter-binding-${location}`])).rows[0]!;
      await client.query(`INSERT INTO inventory.publication_source_binding_heads(publication_target_id,draft_binding_id,revision,updated_by,update_reason)
        VALUES($1,$2,1,'fixture','Shopify source')`, [id, binding.id]);
      await client.query(`INSERT INTO inventory.publication_source_binding_members(binding_id,publication_target_id,fulfillment_node_id,priority)
        VALUES($1,$2,1,1)`, [binding.id, id]);
      await client.query("UPDATE inventory.publication_source_binding_versions SET lifecycle_status='sealed',sealed_by='fixture',sealed_at=transaction_timestamp() WHERE id=$1", [binding.id]);
      await client.query(`UPDATE inventory.publication_source_binding_heads SET active_binding_id=draft_binding_id,draft_binding_id=NULL,revision=revision+1
        WHERE publication_target_id=$1`, [id]);
      await client.query(`UPDATE inventory.inventory_publication_targets SET state='preview',revision=revision+1,activated_by='fixture',
        activated_at=transaction_timestamp() WHERE id=$1`, [id]);
      await client.query("UPDATE inventory.inventory_publication_targets SET state='live',revision=revision+1 WHERE id=$1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    return id;
  };

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool, { includeWalmartMapping: false, includeQuantityRecoveryMigrations: true });
    await activateWalmartPublicationInventoryFixture(database.pool);
    await installCutoverAdmissionFixturePrerequisites(database.pool);
    await database.pool.query(readFileSync(resolve("migrations/236_inventory_cutover_admission.sql"), "utf8"));
    await database.pool.query(readFileSync(resolve("migrations/0721_inventory_publication_direct_enable.sql"), "utf8"));
    await database.pool.query("UPDATE channels.channels SET status='active' WHERE id=$1", [SHOPIFY_CHANNEL]);
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
      VALUES($1,101,'P5',$2,1)`, [SHOPIFY_CHANNEL, SHOPIFY_ITEM]);
    targetId = await createLiveShopifyTarget(SHOPIFY_LOCATION);
    await sealDropshipMapping(database.pool, targetId, 101, SHOPIFY_ITEM);
    expect((await publish()).authority).toBe("canonical");
    originalFetch = globalThis.fetch;
  }, 60_000);
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await database?.close();
  });

  it("dead-letters a Shopify 404 on its first attempt, logs it, and keeps the store on Ops Health until a newer update reaches Shopify", async () => {
    const answers: Record<string, ShopifyAnswer> = { [`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]: 404 };
    const writes = fakeShopify(answers);
    const log = { error: vi.fn<(action: string, data?: object) => void>() };
    expect(await deadLetterHealth()).toEqual({ count: 0, sample: [] });
    await nextDue();

    expect(await worker(database.pool, log).processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });

    expect(writes).toEqual([`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]);
    const [refused] = await outbox();
    expect(refused).toMatchObject({ desired_revision: "1", desired_quantity: "17", state: "dead_letter",
      last_error_class: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", attempt_count: 1 });
    expect((await database.pool.query(`SELECT outcome,error_class FROM inventory.inventory_publication_attempts WHERE outbox_id=$1`,
      [refused.id])).rows).toEqual([{ outcome: "dead_letter", error_class: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND" }]);
    // Existing admission evidence, unchanged by PR1: the Shopify request is not journaled, so its
    // outcome stays "uncertain" (it now carries the precise code) until someone attests it.
    expect((await database.pool.query("SELECT state,error_code FROM inventory.quantity_publication_attempts WHERE owner_kind='outbox'")).rows)
      .toEqual([{ state: "uncertain", error_code: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND" }]);
    expect(log.error).toHaveBeenCalledExactlyOnceWith("inventory_publication.outbox.dead_lettered", expect.objectContaining({
      outcome: "dead_letter", error_code: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", error_class: "permanent",
      dead_letter_reason: "non_retryable", outbox_id: refused.id,
      publication_target_id: targetId, product_variant_id: 101, channel_connection_id: SHOPIFY_CONNECTION, provider_key: "shopify",
      external_scope_id: SHOPIFY_LOCATION, external_inventory_item_id: SHOPIFY_ITEM }));

    const shown = { count: 1, sample: [{ publication_target_id: targetId, channel_id: SHOPIFY_CHANNEL, channel_name: "Test Shopify",
      provider_key: "shopify", channel_connection_id: SHOPIFY_CONNECTION, external_scope_id: SHOPIFY_LOCATION, refused_sizes: 1,
      error_codes: ["SHOPIFY_INVENTORY_ITEM_NOT_FOUND"], product_variant_ids: [101], outbox_ids: [refused.id],
      last_refused_at: expect.any(Date) }] };
    expect(await deadLetterHealth()).toEqual(shown);

    // Stock moves: the planner never reuses a dead letter, so a newer revision is queued.
    // It has not reached Shopify, so the store stays on Ops Health.
    await sellFiveUnits();
    await publish();
    expect((await outbox()).map(row => [row.desired_revision, row.desired_quantity, row.state]))
      .toEqual([["1", "17", "dead_letter"], ["2", "12", "queued"]]);
    expect(await deadLetterHealth()).toEqual(shown);

    // Dispatching it changes nothing at the store: admission refuses it before any HTTP call
    // because the refused write's outcome is still unresolved. It is retried, not delivered.
    await nextDue();
    expect(await worker(database.pool, log).processDue()).toMatchObject({ claimed: 1, verified: 0, failed: 1 });
    expect(writes).toHaveLength(1);
    expect((await outbox())[1]).toMatchObject({ desired_revision: "2", state: "queued", last_error_class: "PUBLICATION_PRIOR_OUTCOME_UNRESOLVED" });
    expect(await deadLetterHealth()).toEqual(shown);
    expect(log.error).toHaveBeenCalledOnce();

    // A person reviews it: they fix the item in Shopify and attest the refused write. The
    // retry reaches Shopify, which accepts it, so the store leaves Ops Health.
    await attestUncertainAttempt(SHOPIFY_LOCATION);
    answers[`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`] = 200;
    await nextDue();
    expect(await worker(database.pool, log).processDue()).toMatchObject({ claimed: 1, verified: 1, failed: 0 });
    expect(writes).toEqual([`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`, `${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]);
    expect((await outbox()).map(row => [row.desired_revision, row.state])).toEqual([["1", "dead_letter"], ["2", "verified"]]);
    expect(await deadLetterHealth()).toEqual({ count: 0, sample: [] });
  });

  it("counts each store once, with each refused size once, its codes and the outbox ids of its log lines", async () => {
    // Store A (location 98765) sells 101 and 102; Shopify refuses both (404, 422).
    // Store B (location 98766) sells 101; Shopify refuses it twice (404, attested, 404 again).
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
      VALUES($1,102,'NEW',$2,1)`, [SHOPIFY_CHANNEL, SIBLING_ITEM]);
    await sealDropshipMapping(database.pool, targetId, 102, SIBLING_ITEM);
    const second = await createLiveShopifyTarget(SECOND_LOCATION);
    await sealDropshipMapping(database.pool, second, 101, SHOPIFY_ITEM);
    await publish(targetId, [102]);
    await publish(second, [101]);
    fakeShopify({ [`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]: 404, [`${SHOPIFY_LOCATION}/${SIBLING_ITEM}`]: 422,
      [`${SECOND_LOCATION}/${SHOPIFY_ITEM}`]: 404 });
    const log = { error: vi.fn<(action: string, data?: object) => void>() };
    await nextDue();
    expect(await worker(database.pool, log).processDue()).toMatchObject({ claimed: 3, failed: 3 });
    expect(log.error).toHaveBeenCalledTimes(3);
    const [a101] = await outbox(targetId, 101);
    const [a102] = await outbox(targetId, 102);
    const [b101] = await outbox(second, 101);

    await attestUncertainAttempt(SECOND_LOCATION);
    await sellFiveUnits();
    await publish(second, [101]);
    await nextDue();
    expect(await worker(database.pool, log).processDue()).toMatchObject({ claimed: 1, failed: 1 });
    const [, b101again] = await outbox(second, 101);
    expect(b101again).toMatchObject({ desired_revision: "2", state: "dead_letter", last_error_class: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND" });

    const health = await deadLetterHealth();
    expect(health.count).toBe(2);
    const store = (id: number) => health.sample.find(row => row.publication_target_id === id);
    expect(health.sample).toHaveLength(2);
    expect({ ...store(targetId), outbox_ids: [...store(targetId)!.outbox_ids].sort() }).toEqual({ publication_target_id: targetId,
      channel_id: SHOPIFY_CHANNEL, channel_name: "Test Shopify", provider_key: "shopify", channel_connection_id: SHOPIFY_CONNECTION,
      external_scope_id: SHOPIFY_LOCATION, refused_sizes: 2, error_codes: ["SHOPIFY_INVENTORY_ITEM_NOT_FOUND", "SHOPIFY_INVENTORY_REJECTED"],
      product_variant_ids: [101, 102], outbox_ids: [a101.id, a102.id].sort(), last_refused_at: expect.any(Date) });
    // The newest refusal comes first; the size refused twice is one refused size.
    expect(store(second)).toEqual({ publication_target_id: second, channel_id: SHOPIFY_CHANNEL, channel_name: "Test Shopify",
      provider_key: "shopify", channel_connection_id: SHOPIFY_CONNECTION, external_scope_id: SECOND_LOCATION, refused_sizes: 1,
      error_codes: ["SHOPIFY_INVENTORY_ITEM_NOT_FOUND"], product_variant_ids: [101], outbox_ids: [b101again.id, b101.id],
      last_refused_at: expect.any(Date) });
  });

  it("keeps a Shopify 400 retryable on its first attempt: no dead letter and nothing on Ops Health", async () => {
    fakeShopify({ [`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]: 400 });
    const log = { error: vi.fn<(action: string, data?: object) => void>() };
    await nextDue();
    expect(await worker(database.pool, log).processDue()).toMatchObject({ claimed: 1, failed: 1 });
    expect(await outbox()).toEqual([expect.objectContaining({ state: "queued", last_error_class: "PROVIDER_PUBLICATION_REJECTED", attempt_count: 1 })]);
    expect(log.error).not.toHaveBeenCalled();
    expect(await deadLetterHealth()).toEqual({ count: 0, sample: [] });
  });

  it("counts only live channel stores: pausing the store removes its refused updates from Ops Health", async () => {
    fakeShopify({ [`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]: 422 });
    await nextDue();
    await worker(database.pool, { error: vi.fn<(action: string, data?: object) => void>() }).processDue();
    expect(await outbox()).toEqual([expect.objectContaining({ state: "dead_letter", last_error_class: "SHOPIFY_INVENTORY_REJECTED" })]);
    expect((await deadLetterHealth()).sample).toEqual([expect.objectContaining({ publication_target_id: targetId,
      error_codes: ["SHOPIFY_INVENTORY_REJECTED"], refused_sizes: 1 })]);
    await database.pool.query(`UPDATE inventory.inventory_publication_targets SET state='disabled',activated_by=NULL,activated_at=NULL,
      revision=revision+1 WHERE id=$1`, [targetId]);
    expect(await deadLetterHealth()).toEqual({ count: 0, sample: [] });
  });

  it("leaves out a live Dropship store's dead letter: Dropship stock refusals have their own issue", async () => {
    fakeShopify({ [`${SHOPIFY_LOCATION}/${SHOPIFY_ITEM}`]: 422 });
    await nextDue();
    await worker(database.pool, { error: vi.fn<(action: string, data?: object) => void>() }).processDue();
    // A live Dropship eBay store whose stock update was also refused for good. Its dead letter is
    // seeded directly: this suite proves only which destinations the reader counts.
    await database.pool.query(`INSERT INTO channels.channels(id,name,provider,status) VALUES(40,'Dropship OMS','manual','active');
      INSERT INTO dropship.dropship_vendors(id,business_name) VALUES(10,'Stock link vendor');
      INSERT INTO dropship.dropship_store_connections(id,vendor_id,platform,status,external_account_id) VALUES(22,10,'ebay','connected','dropship-seller')`);
    const dropship = await createDropshipEbayTarget(database.pool);
    await database.pool.query(`INSERT INTO inventory.inventory_publication_outbox
      (publication_target_id,product_variant_id,desired_revision,desired_quantity,destination_kind_snapshot,dropship_store_connection_id_snapshot,
       external_scope_id_snapshot,external_inventory_item_id_snapshot,provider_scope_type_snapshot,external_sku_snapshot,
       publication_target_revision_snapshot,state,idempotency_key,payload_hash,available_at,last_error_class,attempt_count)
      SELECT id,101,1,17,'dropship_store_connection',22,external_scope_id,'P5','account','P5',revision,'dead_letter',
        'dropship-refused-fixture',repeat('d',64),transaction_timestamp(),'PUBLICATION_IDENTITY_INVALID',1
      FROM inventory.inventory_publication_targets WHERE id=$1`, [dropship]);
    expect((await database.pool.query(`SELECT o.state,t.destination_kind,t.state AS target_state FROM inventory.inventory_publication_outbox o
      JOIN inventory.inventory_publication_targets t ON t.id=o.publication_target_id WHERE t.id=$1`, [dropship])).rows)
      .toEqual([{ state: "dead_letter", destination_kind: "dropship_store_connection", target_state: "live" }]);
    const health = await deadLetterHealth();
    expect(health.count).toBe(1);
    expect(health.sample.map(row => row.publication_target_id)).toEqual([targetId]);
  });
});
