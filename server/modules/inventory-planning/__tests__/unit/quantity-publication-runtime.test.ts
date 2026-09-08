import { beforeEach, describe, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ query: vi.fn(), publish: vi.fn() }));
vi.mock("../../../../db", () => ({ pool: { query: f.query } }));
vi.mock("../../infrastructure/inventory-availability-runtime-publication.repository", () => ({
  createAuthorityAwareInventoryPublicationService: () => ({ publishProduct: f.publish }),
}));
import { planCurrentCanonicalListingQuantity } from "../../infrastructure/quantity-publication-runtime";

const scope = { destinationKind: "channel_connection" as const, connectionId: 7, providerKey: "ebay" as const,
  providerScopeType: "account" as const, externalScopeId: "verified", externalInventoryItemId: "P5", productId: null, productVariantId: null };
const intent = { publicationTargetId: 1, publicationTargetRevision: "3", productVariantId: 101,
  destinationKind: scope.destinationKind, channelConnectionId: 7, dropshipStoreConnectionId: null,
  providerKey: "ebay", providerScopeType: "account", externalScopeId: "verified", externalInventoryItemId: "P5", desiredQuantity: "14" };
describe("current canonical listing quantity handoff", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    f.query.mockResolvedValueOnce({ rows: [{ product_id: 20, product_variant_id: 101, target_id: 1 }] });
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [intent] } });
  });
  it("requires the freshly returned exact intent before selecting matching durable desired state", async () => {
    f.query.mockResolvedValueOnce({ rows: [{ id: "9", desired_quantity: "14" }] });
    await expect(planCurrentCanonicalListingQuantity(scope)).resolves.toEqual({ outboxId: "9", quantity: 14 });
    expect(f.query.mock.calls[1][1]).toEqual([1, 101, "4", "3", "14", "channel_connection", 7, "ebay", "account", "verified", "P5"]);
  });
  it("cannot revive an old positive outbox when the current eligible plan omits the SKU", async () => {
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [] } });
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_PLAN_OMITTED" });
    expect(f.query).toHaveBeenCalledOnce();
  });
  it("rejects a changed destination identity even when product and target match", async () => {
    f.publish.mockResolvedValue({ authority: "canonical", publication: { activationRunId: "4", rows: [{ ...intent, externalScopeId: "different" }] } });
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_PLAN_OMITTED" });
  });
  it("rejects when no current desired row agrees with the fresh plan", async () => {
    f.query.mockResolvedValueOnce({ rows: [] });
    await expect(planCurrentCanonicalListingQuantity(scope)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_PLAN_MISSING" });
  });
});
