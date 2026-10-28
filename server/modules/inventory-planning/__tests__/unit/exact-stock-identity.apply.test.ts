import { beforeEach, describe, expect, it, vi } from "vitest";

// Channels PR2 (PLAN-CH2 v4.1 §4.1, §4.3 steps 7-8): the generalised exact-identity core, its eBay wrapper (the keys
// and calls of the shared exact eBay SKU core stay as they were), and the retire-then-link order of one engine
// command. The writers themselves are mocked; their real behaviour is pinned by the Dropship and channel eBay PG
// suites, PG 29 and stock-link.integration.test.ts.
const calls = vi.hoisted(() => [] as Array<[string, unknown]>);
const mocks = vi.hoisted(() => ({
  save: vi.fn(), promote: vi.fn(), review: vi.fn(), apply: vi.fn(), retire: vi.fn(),
}));
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
vi.mock("../../infrastructure/inventory-channel-exposure-admin.repository", () => ({
  PostgresInventoryChannelExposureAdminStore: class { saveVariantMappingDraftInsideTransaction = mocks.save; },
}));
vi.mock("../../infrastructure/inventory-cutover-definitions.repository", () => ({ promoteInventoryCutoverDefinitionsInsideTransaction: mocks.promote }));
vi.mock("../../infrastructure/publication-mapping-preparation.repository", () => ({
  reviewMappingPreparation: mocks.review, applyMappingPreparation: mocks.apply,
}));
vi.mock("../../infrastructure/stock-link-retire", () => ({ retireStockLinkMappingsInsideTransaction: mocks.retire }));

import { applyExactEbaySkuMappingsInsideTransaction } from "../../infrastructure/exact-ebay-sku-mapping.apply";
import {
  applyExactStockIdentityInsideTransaction, applyStockIdentityChangeInsideTransaction, type ExactStockIdentityApplyInput,
} from "../../infrastructure/exact-stock-identity.apply";

const NOW = new Date("2026-10-27T12:00:00.000Z");
const target = { id: 9, channel_id: 35, channel_connection_id: 7, dropship_store_connection_id: null, destination_kind: "channel_connection",
  provider_key: "shopify", provider_scope_type: "location", external_scope_id: "98765", revision: "4", state: "live",
  publication_authority: "echelon", hold_reason: null, held_at: null, source_ready: true } as const;
const client = { query: vi.fn() } as never;
const receipt = { publicationTargetId: 9, revision: "4", reviewHash: "r".repeat(64), changedProductVariantIds: [101], publicationRows: 1,
  appliedAt: NOW.toISOString(), appliedBy: "system:stock-link", alreadyApplied: false };

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  let definitionId = 70;
  mocks.save.mockImplementation(async (_tx: unknown, command: { productVariantId: number }) => {
    calls.push(["save", command]);
    definitionId += 1;
    return { definitionId, version: 2, definitionHash: `${definitionId}`.padStart(64, "d"), headRevision: "5", alreadyApplied: false,
      runtimeAuthorityChanged: false, providerWriteAttempted: false };
  });
  mocks.promote.mockImplementation(async (_client: unknown, manifest: unknown) => { calls.push(["promote", manifest]); return 1; });
  mocks.review.mockImplementation(async (_client: unknown, command: unknown) => { calls.push(["review", command]);
    return { review: { reviewHash: "r".repeat(64), ready: true } }; });
  mocks.apply.mockImplementation(async (...args: unknown[]) => { calls.push(["apply", args]); return receipt; });
  mocks.retire.mockImplementation(async (_client: unknown, input: { members: Array<{ productVariantId: number; expectedHeadRevision: string }> }) => {
    calls.push(["retire", input]);
    return input.members.map(member => ({ productVariantId: member.productVariantId, mappingId: 50 + member.productVariantId,
      externalInventoryItemId: "222", externalSku: "P5", sealedAt: "2026-10-01T00:00:00.000Z", retiredAt: NOW.toISOString(),
      headRevision: String(Number(member.expectedHeadRevision) + 1), supersededOutboxIds: [] }));
  });
});

function linkInput(overrides: Partial<ExactStockIdentityApplyInput> = {}): ExactStockIdentityApplyInput {
  return { target, members: [], productId: 20, allowRetainedZero: false, exactVariantScope: true, idempotencyPrefix: "stock-link",
    commandKey: "0b5f2c1e-8d1a-5a3e-9f00-000000000001", requestHash: "h".repeat(64), actor: "system:stock-link", now: NOW,
    changeReason: "Linked by store SKU.", afterPromotion: vi.fn(async () => { calls.push(["afterPromotion", null]); }), ...overrides };
}

describe("exact eBay SKU mapping wrapper (unchanged keys and calls)", () => {
  it("saves a created member with its SKU as the item, seals the drafts, reviews every member and applies under the prefix key", async () => {
    const rows = [
      { id: 101, head_revision: null, mapping_id: null, mapping_hash: null },
      { id: 102, head_revision: "3", mapping_id: 61, mapping_hash: "f".repeat(64) },
      { id: 103, head_revision: "2", mapping_id: 62, mapping_hash: "e".repeat(64) },
    ];
    const result = await applyExactEbaySkuMappingsInsideTransaction(client, ["scope"], {
      target, rows: rows as never, productId: 20, allowRetainedZero: true, exactVariantScope: false, verifiedListingScopeHash: "v".repeat(64),
      idempotencyPrefix: "ebay-stock", commandKey: "cmd-1", requestHash: "h".repeat(64), actor: "operator", now: NOW,
      changeReason: "Reviewed exact eBay SKU stock enrollment before publication.", afterPromotion: async () => { calls.push(["afterPromotion", null]); },
      variants: [{ productVariantId: 101, sku: "SKU-101", mappingAction: "create" }, { productVariantId: 102, sku: "SKU-102", mappingAction: "promote_draft" },
        { productVariantId: 103, sku: "SKU-103", mappingAction: "none" }],
    });
    expect(result).toBe(receipt);
    expect(calls.map(([name]) => name)).toEqual(["save", "promote", "afterPromotion", "review", "apply"]);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith(expect.anything(), {
      publicationTargetId: 9, productVariantId: 101, externalInventoryItemId: "SKU-101", externalSku: "SKU-101",
      expectedHeadRevision: "0", expectedDraftMappingId: null, expectedDraftDefinitionHash: null,
      changeReason: "Reviewed exact eBay SKU stock enrollment before publication.", idempotencyKey: "ebay-stock:cmd-1:101",
      requestHash: "h".repeat(64), actorId: "operator", occurredAt: NOW,
    }, { allowRetainedZero: true });
    expect(mocks.promote).toHaveBeenCalledWith(client, { contractVersion: "inventory_cutover_selection_manifest_v1", productIds: [], publicationTargetIds: [9],
      selections: [{ kind: "variant_mapping", key: "9:101", definitionId: 71, definitionHash: "71".padStart(64, "d") },
        { kind: "variant_mapping", key: "9:102", definitionId: 61, definitionHash: "f".repeat(64) }] },
    { actor: "operator", reason: "Reviewed exact eBay SKU stock enrollment before publication.", occurredAt: NOW });
    const command = { publicationTargetId: 9, expectedTargetRevision: "4", productId: 20, productVariantIds: [101, 102, 103],
      allowRetainedZero: true, verifiedListingScopeHash: "v".repeat(64) };
    expect(mocks.review).toHaveBeenCalledWith(client, command, true);
    expect(mocks.apply).toHaveBeenCalledWith(client, ["scope"], { ...command, exactVariantScope: false, expectedReviewHash: "r".repeat(64),
      idempotencyKey: "ebay-stock:cmd-1" }, "operator", "h".repeat(64), NOW, [101, 102]);
  });

  it("uses the head revision the capture read for a created member and skips promotion when nothing changes", async () => {
    await applyExactEbaySkuMappingsInsideTransaction(client, [], { target, productId: 20, allowRetainedZero: false, exactVariantScope: true,
      idempotencyPrefix: "dropship-ebay-stock", commandKey: "cmd-2", requestHash: "h".repeat(64), actor: "system", now: NOW, changeReason: "Link",
      afterPromotion: async () => undefined, rows: [{ id: 101, head_revision: "6", mapping_id: null, mapping_hash: null }] as never,
      variants: [{ productVariantId: 101, sku: "P5", mappingAction: "create" }] });
    expect(mocks.save.mock.calls[0]![1]).toMatchObject({ expectedHeadRevision: "6", idempotencyKey: "dropship-ebay-stock:cmd-2:101" });
    mocks.save.mockClear(); mocks.promote.mockClear();
    await applyExactEbaySkuMappingsInsideTransaction(client, [], { target, productId: 20, allowRetainedZero: false, exactVariantScope: true,
      idempotencyPrefix: "dropship-ebay-stock", commandKey: "cmd-3", requestHash: "h".repeat(64), actor: "system", now: NOW, changeReason: "Link",
      afterPromotion: async () => undefined, rows: [] as never, variants: [{ productVariantId: 101, sku: "P5", mappingAction: "none" }] });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.promote).not.toHaveBeenCalled();
    expect(mocks.apply.mock.calls.at(-1)!.at(-1)).toEqual([]);
  });
});

describe("generalised exact-identity core", () => {
  it("saves the exact item and store SKU it is given and replaces a pending draft in place behind its hash", async () => {
    await applyExactStockIdentityInsideTransaction(client, [], linkInput({ members: [
      { productVariantId: 101, mappingAction: "create", externalInventoryItemId: "333", externalSku: "P5", expectedHeadRevision: "3" },
      { productVariantId: 102, mappingAction: "replace_draft", externalInventoryItemId: "444", externalSku: "NEW", expectedHeadRevision: "5",
        draft: { mappingId: 66, definitionHash: "c".repeat(64) } },
    ] }));
    expect(mocks.save.mock.calls.map(([, command]) => command)).toEqual([
      expect.objectContaining({ productVariantId: 101, externalInventoryItemId: "333", externalSku: "P5", expectedHeadRevision: "3",
        expectedDraftMappingId: null, expectedDraftDefinitionHash: null, idempotencyKey: "stock-link:0b5f2c1e-8d1a-5a3e-9f00-000000000001:101" }),
      expect.objectContaining({ productVariantId: 102, externalInventoryItemId: "444", externalSku: "NEW", expectedHeadRevision: "5",
        expectedDraftMappingId: 66, expectedDraftDefinitionHash: "c".repeat(64) }),
    ]);
    expect(mocks.apply.mock.calls[0]!.at(-1)).toEqual([101, 102]);
  });
});

describe("one engine command: retire first, then link (§4.3 steps 7-8)", () => {
  it("retires before any draft is written and relinks a retired size on the head revision the retire left", async () => {
    const result = await applyStockIdentityChangeInsideTransaction(client, ["scope"], { publicationTargetId: 9, actor: "system:stock-link", now: NOW,
      retireReason: "Store item moved.", retire: [{ productVariantId: 101, mappingId: 151, expectedHeadRevision: "3" }],
      link: linkInput({ members: [{ productVariantId: 101, mappingAction: "create", externalInventoryItemId: "333", externalSku: "P5", expectedHeadRevision: "3" }] }) });
    expect(calls.map(([name]) => name)).toEqual(["retire", "save", "promote", "afterPromotion", "review", "apply"]);
    expect(mocks.retire).toHaveBeenCalledWith(client, { publicationTargetId: 9, members: [{ productVariantId: 101, mappingId: 151, expectedHeadRevision: "3" }],
      actor: "system:stock-link", reason: "Store item moved.", now: NOW });
    expect(mocks.save.mock.calls[0]![1]).toMatchObject({ expectedHeadRevision: "4" });
    expect(result).toEqual({ retired: [expect.objectContaining({ productVariantId: 101, headRevision: "4" })], preparation: receipt });
  });

  it("retires only, with no review and no enqueue, for a retire-only command", async () => {
    const result = await applyStockIdentityChangeInsideTransaction(client, [], { publicationTargetId: 9, actor: "system:stock-link", now: NOW,
      retireReason: "Store item is gone.", retire: [{ productVariantId: 101, mappingId: 151, expectedHeadRevision: "3" }], link: null });
    expect(calls.map(([name]) => name)).toEqual(["retire"]);
    expect(result.preparation).toBeNull();
  });

  it("keeps a promoted draft and an untouched size as given", async () => {
    await applyStockIdentityChangeInsideTransaction(client, [], { publicationTargetId: 9, actor: "system:stock-link", now: NOW, retireReason: "Moved.",
      retire: [{ productVariantId: 101, mappingId: 151, expectedHeadRevision: "3" }],
      link: linkInput({ members: [{ productVariantId: 101, mappingAction: "promote_draft", draft: { mappingId: 77, definitionHash: "b".repeat(64) } },
        { productVariantId: 102, mappingAction: "create", externalInventoryItemId: "222", externalSku: "NEW", expectedHeadRevision: "8" }] }) });
    expect(mocks.save.mock.calls.map(([, command]) => [command.productVariantId, command.expectedHeadRevision])).toEqual([[102, "8"]]);
    expect(mocks.promote.mock.calls[0]![1]).toMatchObject({ selections: [
      { kind: "variant_mapping", key: "9:101", definitionId: 77, definitionHash: "b".repeat(64) },
      { kind: "variant_mapping", key: "9:102", definitionId: 71 }] });
  });

  it.each([
    { label: "nothing to retire or link", input: { retire: [], link: null } },
    { label: "a link for another destination", input: { retire: [], link: linkInput({ target: { ...target, id: 10 } }) } },
    { label: "a link by another actor", input: { retire: [], link: linkInput({ actor: "operator" }) } },
    { label: "a link at another time", input: { retire: [], link: linkInput({ now: new Date(NOW.getTime() + 1) }) } },
    { label: "a retired size left unlinked in the link step", input: { retire: [{ productVariantId: 101, mappingId: 151, expectedHeadRevision: "3" }],
      link: linkInput({ members: [{ productVariantId: 101, mappingAction: "none" }] }) } },
    { label: "a relinked size decided on two head revisions", input: { retire: [{ productVariantId: 101, mappingId: 151, expectedHeadRevision: "3" }],
      link: linkInput({ members: [{ productVariantId: 101, mappingAction: "create", externalInventoryItemId: "333", externalSku: "P5", expectedHeadRevision: "2" }] }) } },
  ])("refuses $label as STOCK_LINK_STATE_INVALID before writing anything", async ({ input }) => {
    await expect(applyStockIdentityChangeInsideTransaction(client, [], { publicationTargetId: 9, actor: "system:stock-link", now: NOW,
      retireReason: "Moved.", ...input })).rejects.toMatchObject({ code: "STOCK_LINK_STATE_INVALID", errorClass: "fatal" });
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
