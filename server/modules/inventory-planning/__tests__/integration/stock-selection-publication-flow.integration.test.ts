import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { PostgresPublicationSelectionWork } from "../../infrastructure/publication-selection-work.repository";
import { createAuthorityAwareInventoryPublicationService } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresInventoryPublicationOutboxRepository } from "../../infrastructure/inventory-publication-outbox.repository";
import { PostgresQuantityPublicationAdmission } from "../../infrastructure/quantity-publication-admission.repository";
import { installEbayPublicationInventoryFixture } from "../fixtures/ebay-publication-inventory.fixture";
import { ensureEbayPublicationReady } from "../../infrastructure/ebay-publication-readiness.repository";
import { InventoryPublicationOutboxService } from "../../application/inventory-publication-outbox.service";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
(url && disposable ? describe : describe.skip).sequential("channel selection through real ATP, durable outbox and request admission", () => {
  let database: InventoryCutoverTestDatabase;
  let now: Date;
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool);
    await activateWalmartPublicationInventoryFixture(database.pool);
    await installPublicationSelectionWorkFixture(database.pool);
    now = new Date(Date.now() + 1_000);
  }, 60_000);
  afterEach(async () => { await database?.close(); });
  const worker = () => new PostgresPublicationSelectionWork(database.pool, () => now);
  const latest = async () => (await database.pool.query(`SELECT id::text,desired_revision::text,desired_quantity::text,state
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=2 AND product_variant_id=101
    ORDER BY desired_revision DESC LIMIT 1`)).rows[0];
  const selected = (value: number) => database.pool.query(`INSERT INTO channels.channel_product_overrides(channel_id,product_id,is_listed)
    VALUES(36,20,$1)`, [value]);

  it("ignores historical membership=false, then plans positive→zero→positive from the same channel selection", async () => {
    await database.pool.query(`INSERT INTO inventory.publication_membership_versions(publication_target_id,product_variant_id,version,included,
      definition_hash,review_hash,created_by,created_at) VALUES(2,101,1,false,repeat('a',64),repeat('a',64),'operator',transaction_timestamp());
      INSERT INTO inventory.publication_membership_heads(publication_target_id,product_variant_id,active_version_id)
        SELECT 2,101,id FROM inventory.publication_membership_versions WHERE publication_target_id=2;`);
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
    const beforeStock = (await database.pool.query("SELECT id,variant_qty,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows;
    await selected(0);
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
    await database.pool.query("UPDATE channels.channel_product_overrides SET is_listed=1 WHERE channel_id=36 AND product_id=20");
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
    expect((await database.pool.query("SELECT id,variant_qty,reserved_qty FROM inventory.inventory_levels ORDER BY id")).rows).toEqual(beforeStock);
    const count = (await database.pool.query("SELECT count(*)::int FROM inventory.inventory_publication_outbox")).rows[0].count;
    expect(await worker().processDue()).toEqual({ planned: 0, blocked: 0, skipped: 0 });
    await createAuthorityAwareInventoryPublicationService(database.pool).publishProduct({ productId: 20, dryRun: false, triggeredBy: "replay_selection_plan" },
      async () => { throw new Error("Legacy is not this fixture's authority"); });
    expect((await database.pool.query("SELECT count(*)::int FROM inventory.inventory_publication_outbox")).rows[0].count).toBe(count);
  });

  it("blocks a claimed stale positive at actual admission before any provider callback", async () => {
    await worker().processDue();
    const outbox = new PostgresInventoryPublicationOutboxRepository(database.pool);
    const claims = await outbox.claimDue({ batchSize: 25, leaseSeconds: 120, leaseToken: "selection-stale-positive", now });
    const claim = claims.find(row => row.publicationTargetId === 2)!;
    expect(claim.desiredQuantity).toBe("17");
    await selected(0);
    const send = vi.fn(async () => undefined);
    const admission = new PostgresQuantityPublicationAdmission(database.pool, () => now);
    await expect(admission.runOutbox(claim, send)).rejects.toMatchObject({ code: "PUBLICATION_SELECTION_CHANGED" });
    expect(send).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT count(*)::int FROM inventory.quantity_publication_attempts")).rows[0].count).toBe(0);
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
  });

  it("rolls current desired quantities and queue acknowledgment back together, then completes after restart", async () => {
    await worker().processDue();
    const previous = await latest();
    await selected(0);
    await database.pool.query(`CREATE FUNCTION inventory.reject_selection_ack_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected selection ack failure'; END; $$;
      CREATE TRIGGER reject_selection_ack_for_test BEFORE INSERT ON inventory.publication_selection_attempts
        FOR EACH ROW EXECUTE FUNCTION inventory.reject_selection_ack_for_test();`);
    await expect(worker().processDue()).rejects.toThrow("injected selection ack failure");
    expect(await latest()).toEqual(previous);
    expect((await database.pool.query("SELECT revision>acknowledged_revision AS pending FROM inventory.publication_selection_work WHERE product_id=20")).rows[0].pending).toBe(true);
    await database.pool.query("DROP TRIGGER reject_selection_ack_for_test ON inventory.publication_selection_attempts");
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
  });

  it("hands archived removal to Listings without creating another quantity write, and blocks stale positive admission", async () => {
    await worker().processDue();
    await database.pool.query("UPDATE catalog.product_variants SET is_active=false WHERE id=101");
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
    now = (await database.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
    const outbox = new PostgresInventoryPublicationOutboxRepository(database.pool);
    const claim = (await outbox.claimDue({ batchSize: 25, leaseSeconds: 120, leaseToken: "archived-positive", now }))
      .find(row => row.publicationTargetId === 2)!;
    const send = vi.fn(async () => undefined);
    await expect(new PostgresQuantityPublicationAdmission(database.pool, () => now).runOutbox(claim, send))
      .rejects.toMatchObject({ code: "PUBLICATION_SELECTION_CHANGED" });
    expect(send).not.toHaveBeenCalled();
    expect(await outbox.runIfCurrent(claim, send)).toEqual({ status: "superseded" });
    expect(send).not.toHaveBeenCalled();
    expect((await database.pool.query(`SELECT state,last_error_class FROM inventory.inventory_publication_outbox WHERE id=$1`, [claim.outboxId])).rows[0])
      .toEqual({ state: "superseded", last_error_class: "SUPERSEDED_BY_CATALOG_ARCHIVE" });
    expect((await database.pool.query(`SELECT count(*)::int AS count FROM inventory.inventory_publication_readbacks WHERE outbox_id=$1`, [claim.outboxId])).rows[0].count).toBe(0);
  });

  it("does not silently authorize or omit a selected feed whose exact canonical mapping is missing", async () => {
    await worker().processDue();
    const previous = await latest();
    await database.pool.query(`INSERT INTO channels.channel_feeds(channel_id,product_variant_id,channel_sku,channel_inventory_item_id,is_active)
      VALUES(36,102,'NEW','NEW',1)`);
    expect(await worker().processDue()).toEqual({ planned: 0, blocked: 1, skipped: 0 });
    expect(await latest()).toEqual(previous);
    expect((await database.pool.query("SELECT last_error_code FROM inventory.publication_selection_work WHERE product_id=20")).rows[0].last_error_code)
      .toBe("CANONICAL_PUBLICATION_MAPPING_MISSING");
  });
});

(url && disposable ? describe : describe.skip).sequential("verified listing removal retires obsolete stock work", () => {
  let database: InventoryCutoverTestDatabase;
  let now: Date;
  const operationId = "00000000-0000-4000-8000-000000000001";
  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installEbayPublicationInventoryFixture(database.pool);
    now = new Date(Date.now() + 5_000);
    await ensureEbayPublicationReady(database.pool, { channelId: 67, connectionId: 9, accountId: "seller-36",
      environment: "production", productId: 20, variants: [{ productVariantId: 101, sku: "P5" }] },
    { commandKey: "00000000-0000-4000-8000-000000000009", actor: "test", now });
    await database.pool.query(`UPDATE channels.channel_listings SET external_product_id='listing-P5',external_sku='P5';
      UPDATE channels.ebay_listing_sync_jobs SET operation='withdraw',state='awaiting_evidence',identity=
        '{"channelId":67,"connectionId":9,"accountId":"seller-36","productId":20,"variants":[{"variantId":101,"sku":"P5","offerId":"offer-P5","listingId":"listing-P5"}]}';
      INSERT INTO channels.channel_product_overrides(channel_id,product_id,is_listed) VALUES(67,20,0)`);
    await createAuthorityAwareInventoryPublicationService(database.pool, { channelId: 67 })
      .publishProduct({ productId: 20, dryRun: false, triggeredBy: "withdrawal_selection" }, async () => null);
    now = (await database.pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0].now;
  }, 60_000);
  afterEach(async () => { await database?.close(); });
  const complete = async () => database.pool.query(`UPDATE channels.channel_listings SET sync_status='ended';
    UPDATE channels.ebay_listing_sync_jobs SET state='completed',provider_identity=identity`);
  const outbox = () => new PostgresInventoryPublicationOutboxRepository(database.pool);
  const claimZero = async () => {
    const claim = (await outbox().claimDue({ batchSize: 25, leaseSeconds: 120, leaseToken: "retirement-proof", now }))
      .find(row => row.publicationTargetId === 3)!;
    expect(claim.desiredQuantity).toBe("0");
    return claim;
  };
  const current = async () => (await database.pool.query(`SELECT state,last_error_class FROM inventory.inventory_publication_outbox
    WHERE publication_target_id=3 ORDER BY desired_revision DESC LIMIT 1`)).rows[0];

  it("supersedes the saved zero after exact verified removal without a provider write or a fake quantity ACK", async () => {
    await complete();
    const publish = vi.fn(async () => { throw new Error("Retired stock must not be published."); });
    const read = vi.fn(async () => { throw new Error("Retired stock must not fabricate a readback."); });
    const worker = new InventoryPublicationOutboxService(outbox(), { get: () => ({ destinationKind: "channel_connection",
      providerKey: "ebay", supportedScopeTypes: ["account"], publishAbsolute: publish, readAbsolute: read }) },
      { now: () => now }, () => "retirement-proof", new PostgresQuantityPublicationAdmission(database.pool, () => now));
    const outcome = await worker.processDue();
    const diagnostics = (await database.pool.query(`SELECT last_error_class,last_error_message
      FROM inventory.inventory_publication_outbox WHERE publication_target_id=3 ORDER BY desired_revision DESC LIMIT 1`)).rows[0];
    expect(outcome, JSON.stringify(diagnostics)).toMatchObject({ claimed: 1, superseded: 1, verified: 0, failed: 0 });
    expect(publish).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
    expect(await current()).toEqual({ state: "superseded", last_error_class: "SUPERSEDED_BY_VERIFIED_WITHDRAWAL" });
    expect((await database.pool.query(`SELECT outcome,error_message,response_hash FROM inventory.inventory_publication_attempts
      WHERE error_class='SUPERSEDED_BY_VERIFIED_WITHDRAWAL'`)).rows).toEqual([
      { outcome: "superseded", error_message: expect.stringContaining(operationId), response_hash: null },
    ]);
    expect((await database.pool.query("SELECT * FROM inventory.quantity_publication_attempts")).rows).toEqual([]);
    expect((await database.pool.query("SELECT * FROM inventory.inventory_publication_readbacks")).rows).toEqual([]);
    expect(await worker.processDue()).toMatchObject({ claimed: 0, verified: 0, failed: 0 });
  });

  it.each(["unverified", "different_account", "different_sku", "different_offer", "different_connection"])(
    "does not retire a saved quantity from %s evidence", async reason => {
      await complete();
      if (reason === "unverified") await database.pool.query("UPDATE channels.ebay_listing_sync_jobs SET state='awaiting_evidence'");
      if (reason === "different_account") await database.pool.query(`UPDATE channels.ebay_listing_sync_jobs
        SET identity=jsonb_set(identity,'{accountId}','"other-seller"'),provider_identity=jsonb_set(provider_identity,'{accountId}','"other-seller"')`);
      if (reason === "different_sku") await database.pool.query(`UPDATE channels.channel_listings SET external_sku='another-SKU';
        UPDATE channels.ebay_listing_sync_jobs SET identity=jsonb_set(identity,'{variants,0,sku}','"another-SKU"'),
          provider_identity=jsonb_set(provider_identity,'{variants,0,sku}','"another-SKU"')`);
      if (reason === "different_offer") await database.pool.query(`UPDATE channels.ebay_listing_sync_jobs
        SET provider_identity=jsonb_set(provider_identity,'{variants,0,offerId}','"another-offer"')`);
      if (reason === "different_connection") await database.pool.query("UPDATE channels.ebay_listing_sync_jobs SET connection_id=999");
      const claim = await claimZero(), callback = vi.fn(async () => "not retired");
      expect(await outbox().runIfCurrent(claim, callback)).toEqual({ status: "current", value: "not retired" });
      expect(callback).toHaveBeenCalledOnce();
      expect((await current()).state).toBe("leased");
      expect((await database.pool.query(`SELECT * FROM inventory.inventory_publication_attempts
        WHERE error_class='SUPERSEDED_BY_VERIFIED_WITHDRAWAL'`)).rows).toEqual([]);
    });

  it("preserves a prior uncertain quantity attempt when retiring obsolete work", async () => {
    const claim = await claimZero();
    const admission = new PostgresQuantityPublicationAdmission(database.pool, () => now);
    await expect(admission.runOutbox(claim, async () => { throw new Error("simulated lost provider response"); }))
      .rejects.toThrow("simulated lost provider response");
    const prior = (await database.pool.query("SELECT * FROM inventory.quantity_publication_attempts")).rows;
    expect(prior).toHaveLength(1); expect(prior[0].state).toBe("uncertain");
    await complete();
    const callback = vi.fn();
    expect(await outbox().runIfCurrent(claim, callback)).toEqual({ status: "superseded" });
    expect(callback).not.toHaveBeenCalled();
    expect((await database.pool.query("SELECT * FROM inventory.quantity_publication_attempts")).rows).toEqual(prior);
  });

  it("rolls retirement back if its immutable attempt cannot be saved, then recovers on the same claim", async () => {
    const claim = await claimZero(); await complete();
    await database.pool.query(`CREATE FUNCTION inventory.reject_retirement_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.error_class='SUPERSEDED_BY_VERIFIED_WITHDRAWAL' THEN RAISE EXCEPTION 'retirement audit unavailable'; END IF; RETURN NEW; END; $$;
      CREATE TRIGGER reject_retirement_for_test BEFORE INSERT ON inventory.inventory_publication_attempts
        FOR EACH ROW EXECUTE FUNCTION inventory.reject_retirement_for_test()`);
    const callback = vi.fn();
    await expect(outbox().runIfCurrent(claim, callback)).rejects.toThrow("retirement audit unavailable");
    expect((await current()).state).toBe("leased"); expect(callback).not.toHaveBeenCalled();
    await database.pool.query("DROP TRIGGER reject_retirement_for_test ON inventory.inventory_publication_attempts");
    expect(await outbox().runIfCurrent(claim, callback)).toEqual({ status: "superseded" });
    expect(callback).not.toHaveBeenCalled();
  });
});
