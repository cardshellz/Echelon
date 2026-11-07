import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { cutoverCompositionBaseSql } from "../fixtures/inventory-cutover-composition-database.fixture";
import { activateWalmartPublicationInventoryFixture, installWalmartPublicationInventoryFixture } from "../fixtures/walmart-publication-inventory.fixture";
import { installPublicationSelectionWorkFixture } from "../fixtures/publication-selection-work.fixture";
import { SalesStatusService } from "../../application/inventory-sales-status.service";
import { InventoryPublicationTargetVariantHoldService } from "../../application/inventory-publication-target-variant-hold.service";
import { PostgresSalesStatusStore } from "../../infrastructure/inventory-sales-status.repository";
import { PostgresInventoryPublicationTargetVariantHoldStore } from "../../infrastructure/inventory-publication-target-variant-hold.repository";
import { PostgresInventoryAvailabilityRuntimePublicationExecutor } from "../../infrastructure/inventory-availability-runtime-publication.repository";
import { PostgresPublicationSelectionWork } from "../../infrastructure/publication-selection-work.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const NOW = new Date("2026-11-07T15:00:00.000Z");
const quiet = { info: () => {}, warn: () => {} };
const PRODUCT = 20;
const SKU = 101;
const WALMART = 36;
const productEverywhere = { channelId: null, productId: PRODUCT, productVariantId: null };
const productOnWalmart = { channelId: WALMART, productId: PRODUCT, productVariantId: null };
const skuEverywhere = { channelId: null, productId: PRODUCT, productVariantId: SKU };
const WALMART_DESTINATION = { destinationKind: "channel_connection" as const, connectionId: 8 };

/**
 * Real migrations, real canonical ATP (20 on hand less 3 reserved = 17 for SKU
 * P5 on the live Walmart destination, target 2), the real durable selection
 * worker and the real outbox. Catalog and channel rows are synthetic.
 */
(url && disposable ? describe : describe.skip).sequential("sales status through canonical ATP, holds and the durable outbox", () => {
  let database: InventoryCutoverTestDatabase;
  let workerNow: Date;

  beforeEach(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, cutoverCompositionBaseSql);
    await installWalmartPublicationInventoryFixture(database.pool);
    await activateWalmartPublicationInventoryFixture(database.pool);
    await installPublicationSelectionWorkFixture(database.pool);
    workerNow = new Date(Date.now() + 1_000);
    // The fixture's mapping activation leaves product 20 due; publish its real quantity first.
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
  }, 60_000);
  afterEach(async () => { await database?.close(); });

  const service = () => new SalesStatusService(new PostgresSalesStatusStore(database.pool), { now: () => NOW }, quiet);
  const worker = () => new PostgresPublicationSelectionWork(database.pool, () => workerNow);
  const holds = () => new InventoryPublicationTargetVariantHoldService(
    new PostgresInventoryPublicationTargetVariantHoldStore(database.pool), { now: () => NOW });
  const latest = async () => (await database.pool.query(`SELECT desired_revision::text, desired_quantity::text
    FROM inventory.inventory_publication_outbox WHERE publication_target_id = 2 AND product_variant_id = $1
    ORDER BY desired_revision DESC LIMIT 1`, [SKU])).rows[0];
  const planRow = async () => {
    const plan = await new PostgresInventoryAvailabilityRuntimePublicationExecutor(database.pool, quiet)
      .execute((context) => context.planProduct(PRODUCT, undefined, "publication"));
    return plan.targets.find((target) => target.publicationTargetId === 2)!.rows.find((row) => row.productVariantId === SKU)!;
  };
  const revisionOf = async (scopeKey: string) => (await service().readProduct(PRODUCT)).entries
    .find((entry) => entry.scopeKey === scopeKey)?.revision ?? null;
  const counts = async () => (await database.pool.query(`SELECT
    (SELECT count(*)::int FROM inventory.sales_statuses) AS settings,
    (SELECT count(*)::int FROM inventory.sales_status_events) AS events,
    (SELECT count(*)::int FROM inventory.inventory_publication_outbox) AS outbox`)).rows[0];

  it("stops a product on every channel at once: zero is queued, the listing and ATP lineage stay, the change is audited", async () => {
    const request = { changes: [{ scope: productEverywhere, status: "stopped", expectedRevision: null }],
      note: "Supplier recall", idempotencyKey: "stop-product-20" };

    const result = await service().change(request, "admin");

    expect(result).toMatchObject({ affectedProductIds: [PRODUCT], queued: [], alreadyApplied: false,
      changes: [{ scopeKey: "all:product:20", before: null, after: { status: "stopped" }, changed: true }],
      republished: [{ productId: PRODUCT, skippedDestinations: [] }] });
    expect(result.republished[0]!.publicationRows).toBeGreaterThan(0);
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
    expect(await planRow()).toMatchObject({ canonicalAtpUnits: "17", sharedUnits: "0", publishedUnits: "0",
      hold: { reason: "Sales status: stopped on all channels (product setting)", heldBy: "admin", heldAt: NOW.toISOString() } });
    // Stopped keeps the listing link; nothing is retired.
    expect((await database.pool.query(`SELECT active_mapping_id FROM inventory.publication_variant_mapping_heads
      WHERE publication_target_id = 2 AND product_variant_id = $1`, [SKU])).rows[0].active_mapping_id).not.toBeNull();
    expect((await database.pool.query(`SELECT idempotency_key, channel_id, product_id, product_variant_id, before_status,
      after_status, before_revision, after_revision::text, note, actor, occurred_at FROM inventory.sales_status_events`)).rows)
      .toEqual([{ idempotency_key: "stop-product-20", channel_id: null, product_id: PRODUCT, product_variant_id: null,
        before_status: null, after_status: "stopped", before_revision: null, after_revision: result.changes[0]!.after!.revision,
        note: "Supplier recall", actor: "admin", occurred_at: NOW }]);

    // A lost response retried with the same key replays; nothing is written twice.
    const before = await counts();
    await expect(service().change(request, "admin")).resolves.toEqual({ ...result, alreadyApplied: true });
    expect(await counts()).toEqual(before);
    // The same key with other inputs is refused.
    await expect(service().change({ ...request, note: "Different" }, "admin"))
      .rejects.toMatchObject({ status: 409, code: "SALES_STATUS_IDEMPOTENCY_CONFLICT" });
    // The next stock-update tick plans the same zero, not the old quantity.
    await database.pool.query("SELECT inventory.invalidate_publication_selection_product($1)", [PRODUCT]);
    workerNow = new Date(Date.now() + 1_000);
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
    expect((await service().list({ status: "stopped" })).entries.map((row) => row.entry.scopeKey)).toEqual(["all:product:20"]);
  });

  it("stops everywhere except one channel, then resumes, only from revisions the operator saw", async () => {
    await service().change({ changes: [{ scope: productEverywhere, status: "stopped", expectedRevision: null }],
      idempotencyKey: "stop-everywhere" }, "admin");
    expect(await latest()).toMatchObject({ desired_quantity: "0" });

    await service().change({ changes: [{ scope: productOnWalmart, status: "selling", expectedRevision: null }],
      idempotencyKey: "sell-on-walmart" }, "admin");
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
    expect((await planRow()).hold).toBeNull();

    // A view taken before someone else's change cannot overwrite it.
    const settingsBefore = await counts();
    await expect(service().change({ changes: [{ scope: productEverywhere, status: "inherit", expectedRevision: "999999" }],
      idempotencyKey: "stale-resume" }, "admin")).rejects.toMatchObject({ status: 409, code: "SALES_STATUS_CHANGED" });
    expect(await counts()).toEqual(settingsBefore);

    await service().change({ changes: [{ scope: productOnWalmart, status: "inherit",
      expectedRevision: await revisionOf("channel:36:product:20") }], idempotencyKey: "remove-walmart-exception" }, "admin");
    expect(await latest()).toMatchObject({ desired_quantity: "0" });

    const resumed = await service().change({ changes: [{ scope: productEverywhere, status: "inherit",
      expectedRevision: await revisionOf("all:product:20") }], idempotencyKey: "resume-everywhere" }, "admin");
    expect(resumed.changes[0]).toMatchObject({ before: { status: "stopped" }, after: null, changed: true });
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
    expect((await service().readProduct(PRODUCT)).entries).toEqual([]);
    expect((await database.pool.query(`SELECT before_status, after_status FROM inventory.sales_status_events ORDER BY id`)).rows)
      .toEqual([
        { before_status: null, after_status: "stopped" },
        { before_status: null, after_status: "selling" },
        { before_status: "selling", after_status: null },
        { before_status: "stopped", after_status: null },
      ]);
  });

  it("keeps the operator's stop and an automation SKU hold independent: neither release clears the other", async () => {
    await holds().holdVariants({ destination: WALMART_DESTINATION, productVariantIds: [SKU],
      reason: "Listing unpublished from Echelon", idempotencyKey: "walmart-hold-1" }, "walmart-lifecycle");
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
    expect((await service().readProduct(PRODUCT)).otherHolds).toEqual([expect.objectContaining({
      publicationTargetId: 2, channelId: WALMART, productVariantId: SKU, heldBy: "walmart-lifecycle" })]);

    await service().change({ changes: [{ scope: skuEverywhere, status: "stopped", expectedRevision: null }],
      idempotencyKey: "stop-sku" }, "admin");
    await holds().releaseVariants({ destination: WALMART_DESTINATION, productVariantIds: [SKU],
      reason: "Listing restored", idempotencyKey: "walmart-release-1" }, "walmart-lifecycle");
    // The automation release does not undo the operator's stop.
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
    expect((await planRow()).hold).toMatchObject({ reason: "Sales status: stopped on all channels (SKU setting)" });

    await holds().holdVariants({ destination: WALMART_DESTINATION, productVariantIds: [SKU],
      reason: "Listing unpublished from Echelon", idempotencyKey: "walmart-hold-2" }, "walmart-lifecycle");
    await service().change({ changes: [{ scope: skuEverywhere, status: "inherit",
      expectedRevision: await revisionOf("all:variant:101") }], idempotencyKey: "resume-sku" }, "admin");
    // The operator's resume does not release the automation hold.
    expect((await database.pool.query(`SELECT held_by FROM inventory.inventory_publication_target_variant_holds
      WHERE publication_target_id = 2 AND product_variant_id = $1`, [SKU])).rows).toEqual([{ held_by: "walmart-lifecycle" }]);
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
    expect((await planRow()).hold).toMatchObject({ reason: "Listing unpublished from Echelon" });

    await holds().releaseVariants({ destination: WALMART_DESTINATION, productVariantIds: [SKU],
      reason: "Listing restored", idempotencyKey: "walmart-release-2" }, "walmart-lifecycle");
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
  });

  it("hands a change too large to plan inline to the durable worker, which publishes the zero", async () => {
    const extraProducts = Array.from({ length: 10 }, (_, index) => 300 + index);
    await database.pool.query("INSERT INTO catalog.products(id, sku) SELECT id, 'EXTRA-' || id FROM unnest($1::integer[]) AS id", [extraProducts]);
    const productIds = [PRODUCT, ...extraProducts];

    const result = await service().change({ changes: productIds.map((productId) => ({
      scope: { channelId: null, productId, productVariantId: null }, status: "stopped", expectedRevision: null })),
    idempotencyKey: "stop-many" }, "admin");

    expect(result.republished).toEqual([]);
    expect(result.queued).toEqual([...productIds].sort((left, right) => left - right)
      .map((productId) => ({ productId, reason: "large_change", errorCode: null })));
    // Committed but not yet planned: the old quantity is still the latest until the worker runs.
    expect(await latest()).toMatchObject({ desired_quantity: "17" });
    workerNow = new Date(Date.now() + 1_000);
    expect(await worker().processDue()).toEqual({ planned: 1, blocked: 0, skipped: 0 });
    expect(await latest()).toMatchObject({ desired_quantity: "0" });
  });

  it("guards settings and history in the database", async () => {
    await service().change({ changes: [{ scope: skuEverywhere, status: "stopped", expectedRevision: null }],
      idempotencyKey: "stop-for-guards" }, "admin");
    const refuse = (sql: string) => expect(database.pool.query(sql)).rejects.toBeTruthy();
    await expect(database.pool.query("UPDATE inventory.sales_status_events SET note = 'edited'"))
      .rejects.toMatchObject({ message: "SALES_STATUS_HISTORY_IMMUTABLE" });
    await expect(database.pool.query("DELETE FROM inventory.sales_status_events"))
      .rejects.toMatchObject({ message: "SALES_STATUS_HISTORY_IMMUTABLE" });
    await expect(database.pool.query("TRUNCATE inventory.sales_status_events"))
      .rejects.toMatchObject({ message: "SALES_STATUS_HISTORY_IMMUTABLE" });
    await expect(database.pool.query("UPDATE inventory.sales_statuses SET status = 'selling'"))
      .rejects.toMatchObject({ message: "SALES_STATUS_REVISION_MUST_INCREASE" });
    await expect(database.pool.query("UPDATE inventory.sales_statuses SET channel_id = 36, revision = revision + 1000"))
      .rejects.toMatchObject({ message: "SALES_STATUS_SCOPE_IMMUTABLE" });
    // One setting per scope; a row names exactly one item.
    await expect(database.pool.query(`INSERT INTO inventory.sales_statuses(channel_id, product_variant_id, status, revision, updated_by, updated_at)
      VALUES (NULL, $1, 'selling', nextval('inventory.sales_status_revision_seq'), 'admin', now())`, [SKU])).rejects.toMatchObject({ code: "23505" });
    await refuse(`INSERT INTO inventory.sales_statuses(product_id, product_variant_id, status, revision, updated_by, updated_at)
      VALUES (20, 102, 'stopped', nextval('inventory.sales_status_revision_seq'), 'admin', now())`);
    await refuse(`INSERT INTO inventory.sales_statuses(product_id, status, revision, updated_by, updated_at)
      VALUES (20, 'paused', nextval('inventory.sales_status_revision_seq'), 'admin', now())`);
    // A product with a sales status cannot be deleted out from under it.
    await database.pool.query("INSERT INTO catalog.products(id, sku) VALUES (400, 'DOOMED')");
    await service().change({ changes: [{ scope: { channelId: null, productId: 400, productVariantId: null }, status: "stopped",
      expectedRevision: null }], idempotencyKey: "stop-doomed" }, "admin");
    await expect(database.pool.query("DELETE FROM catalog.products WHERE id = 400")).rejects.toMatchObject({ code: "23503" });
  });
});
