import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StockPublicationSelection } from "@shared/types/stock-publication-selection";

// Channels PR2 (PLAN-CH2 v4.1 §4.5 N1, DV4-6): target enable builds its publisher with isolateMissingStockLinks only
// for a channel Shopify destination (the only kind the stock-link engine retires and relinks). A product whose every
// row waits for its link is skipped; a destination that publishes nothing while rows were withheld never goes live.
// Every other destination keeps today's enable (the PG suites pin Walmart; this pins the option per destination).
const mocks = vi.hoisted(() => ({ selection: vi.fn(), publish: vi.fn(), options: [] as unknown[] }));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/inventory-publication-selection.reader", async importOriginal => ({
  ...await importOriginal<typeof import("../../infrastructure/inventory-publication-selection.reader")>(), readPublicationStockSelection: mocks.selection,
}));
vi.mock("../../infrastructure/inventory-cutover-admission-fence.repository", () => ({ acquireInventoryCutoverFenceInsideTransaction: vi.fn() }));
vi.mock("../../infrastructure/inventory-cutover-definitions.repository", () => ({ promoteInventoryCutoverDefinitionsInsideTransaction: vi.fn(async () => 0) }));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  createTransactionScopedInventoryPublicationService: (_client: unknown, options?: unknown) => {
    mocks.options.push(options);
    return { publishProduct: mocks.publish };
  },
}));
vi.mock("../../infrastructure/inventory-publication-target-stop.repository", () => ({ loadPublicationTargetScopes: vi.fn(async () => []), PUBLICATION_TARGET_SCOPE_LOCK_SEED: 918420 }));

import { PostgresInventoryPublicationTargetEnableStore } from "../../infrastructure/inventory-publication-target-enable.repository";

const now = new Date("2026-10-27T12:00:00Z");
type Destination = { destination_kind: "channel_connection" | "dropship_store_connection"; provider_key: string };
const SHOPIFY: Destination = { destination_kind: "channel_connection", provider_key: "shopify" };

function harness(destination: Destination, products: Array<{ product_id: number; product_variant_id: number }>) {
  const query = vi.fn(async (text: string, _values?: unknown[]) => {
    if (text.includes("availability_runtime_authority")) return { rows: [{ ready: true }], rowCount: 1 };
    if (text.includes("SELECT t.id,t.channel_id")) return { rows: [{ id: 2, channel_id: 35, state: "disabled", revision: "3",
      publication_authority: "echelon", channel_status: "active", channel_connection_id: destination.destination_kind === "channel_connection" ? 7 : null,
      dropship_store_connection_id: destination.destination_kind === "dropship_store_connection" ? 22 : null,
      provider_scope_type: "location", external_scope_id: "location", ...destination }], rowCount: 1 };
    if (text.includes("FROM channels.walmart_connections")) return { rows: [{ ok: true }], rowCount: 1 };
    if (text.includes("SELECT b.id,b.definition_hash")) return { rows: [{ id: 1, definition_hash: "b".repeat(64), lifecycle_status: "sealed", active_binding_id: 1 }], rowCount: 1 };
    if (text.includes("SELECT n.lifecycle_status")) return { rows: [{ lifecycle_status: "active" }], rowCount: 1 };
    if (text.includes("SELECT p.id,p.definition_hash")) return { rows: [{ id: 1, definition_hash: "c".repeat(64), lifecycle_status: "sealed", active_policy_id: 1, scope_key: "channel:35", complete: true }], rowCount: 1 };
    if (text.includes("WITH history AS")) return { rows: [], rowCount: 0 };
    if (text.includes("SELECT v.product_id,v.id")) return { rows: products.map(row => ({ ...row, managed: true })), rowCount: products.length };
    if (text.includes("RETURNING revision::text")) return { rows: [{ revision: "4" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() };
  const store = new PostgresInventoryPublicationTargetEnableStore({ connect: async () => client } as never);
  const enable = () => store.enable({ publicationTargetId: 2, expectedRevision: "3", idempotencyKey: "enable", actorId: "operator", requestHash: "a".repeat(64), occurredAt: now });
  const audit = () => {
    const call = query.mock.calls.find(([text]) => text.includes("publication_target.enabled"));
    return call ? JSON.parse(String((call[1] as unknown[])[4])) as Record<string, unknown> : null;
  };
  return { enable, query, audit };
}

const selection = (productId: number, variantIds: number[]): StockPublicationSelection => ({
  productId, fingerprint: "a".repeat(64), variants: variantIds.map(productVariantId => ({ productVariantId, action: "publish", reason: "Owner decision", blockers: [] })),
});
const published = (rows: Array<{ productVariantId: number }>, withheld: number[] | null) => ({ authority: "canonical", publication: {
  rows: rows.map(row => ({ publicationTargetId: 2, productVariantId: row.productVariantId, blockerCodes: [] })),
  enqueuedRows: rows.length, coalescedRows: 0,
  ...(withheld === null ? {} : { blockedTargets: withheld.length === 0 ? [] : [{ publicationTargetId: 2, channelId: 35, channelName: "Shopify US",
    errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"], productVariantIds: withheld, isolation: "rows" }] }),
} });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.options.length = 0;
  mocks.selection.mockImplementation(async (_client: unknown, _destination: unknown, request: { productId: number; productVariantIds: number[] }) =>
    selection(request.productId, request.productVariantIds));
});

describe("target enable: N1 is scoped to channel Shopify destinations", () => {
  it("builds a channel Shopify destination's publisher with isolateMissingStockLinks", async () => {
    mocks.publish.mockResolvedValue(published([{ productVariantId: 101 }], []));
    expect(await harness(SHOPIFY, [{ product_id: 20, product_variant_id: 101 }]).enable()).toMatchObject({ state: "live", publicationRows: 1 });
    expect(mocks.options).toEqual([{ isolateMissingStockLinks: true }]);
  });

  it.each([
    { label: "channel Walmart", destination: { destination_kind: "channel_connection", provider_key: "walmart" } as Destination },
    { label: "channel eBay", destination: { destination_kind: "channel_connection", provider_key: "ebay" } as Destination },
    { label: "Dropship eBay", destination: { destination_kind: "dropship_store_connection", provider_key: "ebay" } as Destination },
    { label: "Dropship Shopify", destination: { destination_kind: "dropship_store_connection", provider_key: "shopify" } as Destination },
  ])("keeps a $label destination's publisher without the option (today's enable)", async ({ destination }) => {
    mocks.publish.mockResolvedValue(published([{ productVariantId: 101 }], null));
    expect(await harness(destination, [{ product_id: 20, product_variant_id: 101 }]).enable()).toMatchObject({ state: "live", publicationRows: 1 });
    expect(mocks.options).toEqual([{}]);
  });

  it("a non-Shopify destination's empty product is still PUBLICATION_INCOMPLETE, whatever the publisher reports", async () => {
    mocks.publish.mockResolvedValue(published([], [101]));
    const { enable, query } = harness({ destination_kind: "channel_connection", provider_key: "walmart" }, [{ product_id: 20, product_variant_id: 101 }]);
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_PUBLICATION_INCOMPLETE" });
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  });
});

describe("target enable: rows withheld for a missing stock link (channel Shopify)", () => {
  it("skips a product whose every row waits for its link and records the withheld sizes in the audit row", async () => {
    mocks.publish.mockImplementation(async (input: { productId: number }) => input.productId === 20
      ? published([{ productVariantId: 101 }], []) : published([], [201]));
    const { enable, audit } = harness(SHOPIFY, [{ product_id: 20, product_variant_id: 101 }, { product_id: 21, product_variant_id: 201 }]);
    expect(await enable()).toMatchObject({ state: "live", publicationRows: 1 });
    expect(audit()).toMatchObject({ publicationRows: 1, productIds: [20, 21], withheldUnlinkedVariantIds: [201] });
  });

  it("refuses STOCK_NOT_READY and rolls back when nothing is published while rows were withheld", async () => {
    mocks.publish.mockResolvedValue(published([], [101, 102]));
    const { enable, query } = harness(SHOPIFY, [{ product_id: 20, product_variant_id: 101 }]);
    await expect(enable()).rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_STOCK_NOT_READY",
      details: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING: 101, 102"] });
    expect(query).toHaveBeenLastCalledWith("ROLLBACK");
    expect(query.mock.calls.some(([text]) => text.includes("publication_target.enabled"))).toBe(false);
  });

  it("still refuses PUBLICATION_INCOMPLETE for an empty product with nothing withheld", async () => {
    mocks.publish.mockResolvedValue(published([], []));
    await expect(harness(SHOPIFY, [{ product_id: 20, product_variant_id: 101 }]).enable())
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_ENABLE_PUBLICATION_INCOMPLETE" });
  });

  it("writes no withheld key when every size is linked (the audit row is unchanged)", async () => {
    mocks.publish.mockResolvedValue(published([{ productVariantId: 101 }], []));
    const { enable, audit } = harness(SHOPIFY, [{ product_id: 20, product_variant_id: 101 }]);
    await enable();
    expect(audit()).not.toHaveProperty("withheldUnlinkedVariantIds");
  });
});
