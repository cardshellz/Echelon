import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";

const mocks = vi.hoisted(() => ({ selection: vi.fn(), publish: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/inventory-publication-selection.reader", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/inventory-publication-selection.reader")>(), readPublicationStockSelection: mocks.selection,
}));
vi.mock("../../infrastructure/inventory-cutover-admission-fence.repository", () => ({ acquireInventoryCutoverFenceInsideTransaction: vi.fn() }));
vi.mock("../../infrastructure/inventory-cutover-definitions.repository", () => ({ promoteInventoryCutoverDefinitionsInsideTransaction: vi.fn(async () => 0) }));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({ createTransactionScopedInventoryPublicationService: () => ({ publishProduct: mocks.publish }) }));
vi.mock("../../infrastructure/inventory-publication-target-stop.repository", () => ({ loadPublicationTargetScopes: vi.fn(async () => []), PUBLICATION_TARGET_SCOPE_LOCK_SEED: 918420 }));

import { PostgresInventoryPublicationReadbackRepository } from "../../infrastructure/inventory-publication-readback.repository";
import { PostgresInventoryPublicationTargetEnableStore } from "../../infrastructure/inventory-publication-target-enable.repository";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";

const now = new Date("2026-10-12T12:00:00Z");
const selection = (...actions: StockPublicationSelection["variants"][number]["action"][]): StockPublicationSelection => ({
  productId: 20, fingerprint: "a".repeat(64), variants: actions.map((action, index) => ({ productVariantId: 101 + index, action, reason: "Owner decision", blockers: [] })),
});
beforeEach(() => { vi.clearAllMocks(); mocks.publish.mockResolvedValue({ authority: "canonical", publication: {
  rows: [{ publicationTargetId: 2, blockerCodes: [] }], enqueuedRows: 1, coalescedRows: 0,
} }); });

describe("readback follows the listing owner", () => {
  it("reads selected and zero-required mappings, excluding read-only and removed destinations", async () => {
    mocks.selection.mockResolvedValue(selection("publish", "zero", "read_only", "none"));
    const rows = [101,102,103,104].map(product_variant_id => ({ publication_target_id: 2, publication_target_revision: "3", product_id: 20,
      product_variant_id, destination_kind: "channel_connection", channel_id: 36, channel_connection_id: 8, dropship_store_connection_id: null,
      provider_key: "walmart", provider_scope_type: "location", external_scope_id: "location", external_inventory_item_id: `SKU-${product_variant_id}`, external_sku: `SKU-${product_variant_id}` }));
    const query = vi.fn(async (text: string) => ({ rows: text.includes("RETURNING id") ? [{ id: "1" }]
      : text.includes("FROM inventory.inventory_publication_targets AS target") ? rows : [], rowCount: 1 }));
    const client = { query, release: vi.fn() };
    const store = new PostgresInventoryPublicationReadbackRepository({ connect: async () => client } as never);
    const result = await store.begin({ idempotencyKey: "readback", requestHash: "b".repeat(64), requestedBy: "operator", reason: "Check stock", startedAt: now });
    expect(result.kind).toBe("started");
    if (result.kind !== "started") throw new Error("Expected a new readback");
    expect(result.targets.map(row => row.productVariantId)).toEqual([101,102]);
    expect(mocks.selection).toHaveBeenCalledWith(client, expect.objectContaining({ channelId: 36, channelConnectionId: 8 }),
      { productId: 20, productVariantIds: [101,102,103,104], now });
    expect(query.mock.calls.map(([text]) => text).join("\n")).not.toMatch(/membership_(heads|versions|mode)/);
    expect(query).toHaveBeenLastCalledWith("COMMIT");
  });
});

function enableHarness(orphan = false, managed = true) {
  const query = vi.fn(async (text: string) => {
    if (text.includes("availability_runtime_authority")) return { rows: [{ ready: true }], rowCount: 1 };
    if (text.includes("SELECT t.id,t.channel_id")) return { rows: [{ id: 2, channel_id: 36, state: "disabled", revision: "3", publication_authority: "echelon",
      channel_status: "active", destination_kind: "channel_connection", channel_connection_id: 8, dropship_store_connection_id: null,
      provider_key: "shopify", provider_scope_type: "location", external_scope_id: "location" }], rowCount: 1 };
    if (text.includes("SELECT b.id,b.definition_hash")) return { rows: [{ id: 1, definition_hash: "b".repeat(64), lifecycle_status: "sealed", active_binding_id: 1 }], rowCount: 1 };
    if (text.includes("SELECT n.lifecycle_status")) return { rows: [{ lifecycle_status: "active" }], rowCount: 1 };
    if (text.includes("SELECT p.id,p.definition_hash")) return { rows: [{ id: 1, definition_hash: "c".repeat(64), lifecycle_status: "sealed", active_policy_id: 1, scope_key: "channel:36", complete: true }], rowCount: 1 };
    if (text.includes("WITH history AS")) return { rows: orphan ? [{ missing: true }] : [], rowCount: orphan ? 1 : 0 };
    if (text.includes("SELECT v.product_id,v.id")) return { rows: [{ product_id: 20, product_variant_id: 101, managed }], rowCount: 1 };
    if (text.includes("RETURNING revision::text")) return { rows: [{ revision: "4" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const store = new PostgresInventoryPublicationTargetEnableStore({ connect: async () => client } as never);
  const enable = () => store.enable({ publicationTargetId: 2, expectedRevision: "3", idempotencyKey: "enable", actorId: "operator", requestHash: "a".repeat(64), occurredAt: now });
  return { enable, query, client };
}

describe("target enable retains channel selection and old identity obligations", () => {
  it.each(["publish", "zero"] as const)("enqueues the owner %s action without consulting retired membership", async action => {
    mocks.selection.mockResolvedValue(selection(action));
    const { enable, query, client } = enableHarness(false, action === "publish");
    expect(await enable()).toMatchObject({ publicationRows: 1, providerWriteAttempted: false });
    expect(mocks.selection).toHaveBeenCalledWith(client, expect.objectContaining({ channelId: 36 }), { productId: 20, productVariantIds: [101], now });
    expect(mocks.publish).toHaveBeenCalledWith({ productId: 20, publicationTargetId: 2, dryRun: false, triggeredBy: "stock_updates_enabled" }, expect.any(Function));
    expect(query.mock.calls.map(([text]) => text).join("\n")).not.toMatch(/membership_(heads|versions|mode)/);
  });
  it.each(["none", "read_only"] as const)("does not reactivate %s candidates", async action => {
    mocks.selection.mockResolvedValue(selection(action));
    expect(await enableHarness().enable()).toMatchObject({ publicationRows: 0 });
    expect(mocks.publish).not.toHaveBeenCalled();
  });
  it("refuses an orphaned prior identity before selection and rolls back enable", async () => {
    const { enable, query } = enableHarness(true);
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_LISTING_LINK_CHANGED" });
    expect(mocks.selection).not.toHaveBeenCalled(); expect(mocks.publish).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(query.mock.calls.map(([text]) => text).join("\n")).not.toContain("mv.included=false");
  });
  it("fails and rolls back when owner proof is blocked", async () => {
    const blocked = selection("publish"); blocked.variants[0].blockers = [{ code: "CHANNEL_SELECTION_MAPPING_QUARANTINED", message: "Review this exact mapping." }];
    mocks.selection.mockResolvedValue(blocked);
    const { enable, query } = enableHarness();
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_NOT_READY" });
    expect(mocks.publish).not.toHaveBeenCalled(); expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});

describe("channel inventory preview uses owner actions", () => {
  it("shows zero for removal, positive read-only candidates, and no removed SKU", async () => {
    mocks.selection.mockResolvedValue(selection("publish", "zero", "read_only", "none"));
    const dialect = new PgDialect();
    const statements: { sql: string; params: unknown[] }[] = [];
    const execute = vi.fn(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const parsed = dialect.sqlToQuery(query); statements.push(parsed);
      const text = parsed.sql;
      if (text.includes("FROM inventory.inventory_publication_targets")) return { rows: [{ id: 2, channel_id: 36, channel_connection_id: 8,
        dropship_store_connection_id: null, destination_kind: "channel_connection", provider_scope_type: "location", external_scope_id: "location",
        publication_authority: "echelon", state: "live", revision: "3", hold_reason: null, held_at: null, held_by: null }] };
      if (text.includes("FROM catalog.product_variants")) return { rows: [101,102,103,104].map(id => ({ id })) };
      if (text.includes("FROM inventory.publication_source_binding_heads")) return { rows: [{ active_binding_id: 1, draft_binding_id: null,
        selected_binding_id: 1, selected_binding_version: 1, selected_binding_definition_hash: "b".repeat(64), fulfillment_node_id: 1, warehouse_id: 1 }] };
      if (text.includes("FROM inventory.channel_exposure_policy_heads")) return { rows: [{ scope_key: "channel:36", pointer_type: "active", policy_id: 1,
        version: 1, definition_hash: "c".repeat(64), scope_type: "channel", allocation_semantics: "exposure", eligible: true, share_bps: 10000,
        holdback_sellable_units: "0", max_publish_mode: "unlimited", max_publish_sellable_units: null, min_publish_sellable_units: "0",
        source_fulfillment_node_ids: null, inherit_all: false }] };
      if (text.includes("FROM inventory.publication_variant_mapping_heads")) return { rows: [101,102].map(product_variant_id => ({ product_variant_id,
        pointer_type: "active", mapping_id: product_variant_id, version: 1, definition_hash: "d".repeat(64), external_inventory_item_id: `SKU-${product_variant_id}`, external_sku: `SKU-${product_variant_id}` })) };
      return { rows: [] };
    });
    const tx = { execute };
    const shadow = { runId: "1", productId: 20, status: "completed", snapshotFingerprint: "a".repeat(64), capturedAt: now.toISOString(),
      modelId: null, modelVersion: null, modelDefinitionHash: null, blockerCodes: [], results: [101,102,103,104].flatMap(productVariantId =>
        [null,1].map(warehouseId => ({ productVariantId, warehouseId, productVariantSkuSnapshot: `SKU-${productVariantId}`, productVariantUnitsPerVariantSnapshot: 5, proposedAtpUnits: "12" }))) };
    const store = new PostgresInventoryChannelExposureAdminStore({ transaction: async (work: (value: typeof tx) => unknown) => work(tx) } as never,
      { getLatestShadowRun: async () => shadow } as never);
    const result = await store.preview(2,20);
    expect(result.rows.map(row => [row.productVariantId,row.publishedUnits])).toEqual([[101,"12"],[102,"0"],[103,"12"]]);
    expect(result.membership).toEqual({ mode: "explicit", includedVariantIds: [101,102] });
    expect(result.blockers).toEqual([]);
    expect(statements.map(statement => statement.sql).join("\n")).not.toMatch(/publication_membership|publication_initial_scope_receipts/);
    const adapter = mocks.selection.mock.calls[0][0];
    const value = "SKU'); DELETE FROM channels.channels; --";
    await adapter.query("SELECT $1::text AS sku,$2::integer[] AS ids,$1::text AS again", [value,[101,102]]);
    expect(statements.at(-1)).toMatchObject({ sql: "SELECT $1::text AS sku,$2::integer[] AS ids,$3::text AS again", params: [value,[101,102],value] });
  });
});
