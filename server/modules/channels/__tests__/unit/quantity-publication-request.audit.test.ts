import { describe, expect, it } from "vitest";
import { executeAdmittedEbayQuantityRequest, type EbayQuantityHttpRequest, type EbayQuantityRequestAdmission } from "../../quantity-publication-request";

function fixture(options: { quantities?: ReadonlyMap<string, number> | null; blocked?: boolean;
  override?: (request: EbayQuantityHttpRequest) => unknown } = {}) {
  const quantities = options.quantities === undefined ? new Map([["SKU-A", 5], ["SKU-B", 2]]) : options.quantities;
  const calls: EbayQuantityHttpRequest[] = [];
  const owners: Array<{ kind: string; identity: string; members?: readonly string[] }> = [];
  const outcomes: Array<"succeeded" | "uncertain"> = [];
  const denied = Object.assign(new Error("Publication suppressed"), { code: "QUANTITY_PUBLICATION_SUPPRESSED" });
  const admission: EbayQuantityRequestAdmission = {
    async item<T>(sku: string, work: (quantity: number | null) => Promise<T>): Promise<T> {
      owners.push({ kind: "item", identity: sku }); if (options.blocked) throw denied;
      try {
        const result = await work(quantities?.get(sku) ?? null);
        outcomes.push("succeeded"); return result;
      } catch (error) { outcomes.push("uncertain"); throw error; }
    },
    async group<T>(groupKey: string, skus: readonly string[], work: (values: ReadonlyMap<string, number> | null) => Promise<T>): Promise<T> {
      owners.push({ kind: "group", identity: groupKey, members: skus }); if (options.blocked) throw denied;
      return work(quantities);
    },
    async reducing<T>(identity: string, work: () => Promise<T>, members?: readonly string[]): Promise<T> {
      owners.push({ kind: "reducing", identity, ...(members ? { members } : {}) }); if (options.blocked) throw denied;
      return work();
    },
  };
  async function request<T>(input: EbayQuantityHttpRequest): Promise<T> {
    calls.push(structuredClone(input));
    const overridden = options.override?.(input);
    if (overridden !== undefined) return overridden as T;
    if (input.method === "GET" && input.path.includes("inventory_item_group/")) return { variantSKUs: ["SKU-B", "SKU-A"] } as T;
    if (input.method === "GET" && input.path.includes("inventory_item/")) {
      return { sku: input.path.split("/").at(-1), condition: "NEW", product: { title: "Retained metadata" },
        availability: { shipToLocationAvailability: { quantity: 999 } } } as T;
    }
    if (input.method === "GET" && input.path.includes("/offer?")) {
      const sku = new URL(input.path, "https://example.invalid").searchParams.get("sku");
      return { offers: [{ offerId: `offer-${sku}`, sku }], total: 1 } as T;
    }
    if (input.method === "GET" && input.path.includes("/offer/")) return { sku: "SKU-A", marketplaceId: "EBAY_US", availableQuantity: 999 } as T;
    if (input.path.includes("bulk_update_price_quantity")) {
      const body = input.body as { requests: Array<{ sku: string; offers: Array<{ offerId: string }> }> };
      return { responses: body.requests.flatMap(row => row.offers.map(offer => ({ offerId: offer.offerId, statusCode: 200 }))) } as T;
    }
    return { listingId: "listing-1" } as T;
  }
  return { admission, request, calls, owners, outcomes, denied };
}
const offerPublish = { method: "POST", path: "/sell/inventory/v1/offer/offer-SKU-A/publish" };
const groupPublish = { method: "POST", path: "/sell/inventory/v1/offer/publish_by_inventory_item_group",
  body: { inventoryItemGroupKey: "GROUP", marketplaceId: "EBAY_US" } };
function writes(calls: EbayQuantityHttpRequest[]) { return calls.filter(row => row.method !== "GET"); }

describe("independent eBay publication owner protocol audit", () => {
  it.each([
    { method: "DELETE", path: "/sell/inventory/v1/offer/offer-SKU-A" },
    { method: "POST", path: "/sell/inventory/v1/offer/offer-SKU-A/withdraw" },
  ])("resolves reducing retained offer lifecycle to the actual member SKU: $path", async input => {
    const f = fixture(); await executeAdmittedEbayQuantityRequest(input, f.admission, f.request);
    expect(f.owners).toEqual([{ kind: "reducing", identity: "SKU-A" }]);
    expect(writes(f.calls)).toEqual([input]);
    expect(f.calls[0]).toEqual({ method: "GET", path: "/sell/inventory/v1/offer/offer-SKU-A" });
  });

  it.each([
    { method: "DELETE", path: "/sell/inventory/v1/inventory_item_group/GROUP" },
    { method: "POST", path: "/sell/inventory/v1/offer/withdraw_by_inventory_item_group", body: { inventoryItemGroupKey: "GROUP" } },
  ])("holds the complete sorted member identities for a reducing group lifecycle: $path", async input => {
    const f = fixture(); await executeAdmittedEbayQuantityRequest(input, f.admission, f.request);
    expect(f.owners).toEqual([{ kind: "reducing", identity: "group:GROUP", members: ["SKU-A", "SKU-B"] }]);
    expect(writes(f.calls)).toEqual([input]);
    expect(f.calls.filter(row => row.method === "GET" && row.path.includes("inventory_item_group/"))).toHaveLength(2);
  });

  it("blocks a reducing group whose provider membership changes after admission", async () => {
    let reads = 0;
    const f = fixture({ override: input => input.method === "GET" && input.path.includes("inventory_item_group/")
      ? { variantSKUs: ++reads === 1 ? ["SKU-A", "SKU-B"] : ["SKU-C"] } : undefined });
    await expect(executeAdmittedEbayQuantityRequest({ method: "DELETE", path: "/sell/inventory/v1/inventory_item_group/GROUP" }, f.admission, f.request))
      .rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls)).toEqual([]);
  });

  it.each([
    { method: "PUT", path: "/sell/inventory/v1/inventory_item/SKU-A", body: { condition: "NEW", product: { title: "Current metadata" } },
      expected: { availability: { shipToLocationAvailability: { quantity: 5 } } } },
    { method: "POST", path: "/sell/inventory/v1/offer", body: { sku: "SKU-A", marketplaceId: "EBAY_US" },
      expected: { availableQuantity: 5 } },
    { method: "PUT", path: "/sell/inventory/v1/offer/offer-SKU-A", body: { sku: "SKU-A", marketplaceId: "EBAY_US" },
      expected: { availableQuantity: 5 } },
  ])("injects absent canonical quantities into known quantity-free inventory/offer writes: $path", async ({ expected, ...input }) => {
    const before = structuredClone(input); const f = fixture();
    await executeAdmittedEbayQuantityRequest(input, f.admission, f.request);
    expect(input).toEqual(before);
    expect(f.owners).toEqual([{ kind: "item", identity: "SKU-A" }]);
    expect(writes(f.calls)).toHaveLength(1);
    expect(writes(f.calls)[0].body).toMatchObject({ ...input.body, ...expected });
    expect(f.outcomes).toEqual(["succeeded"]);
  });

  it("blocks unsupported alternate location quantities on direct item replacement without provider writes", async () => {
    const input = { method: "PUT", path: "/sell/inventory/v1/inventory_item/SKU-A", body: {
      availability: { shipToLocationAvailability: { quantity: 999, availabilityDistributions: [{ quantity: 900 }] } },
    } }; const f = fixture();
    await expect(executeAdmittedEbayQuantityRequest(input, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls)).toEqual([]);
  });

  it.each([
    { responses: [] },
    { responses: [{ offerId: "offer-SKU-A", statusCode: 200 }] },
    { responses: [{ offerId: "unrelated", statusCode: 200 }] },
    { responses: [{ offerId: "offer-SKU-A", statusCode: 200 }, { offerId: "second-offer", statusCode: 400 }] },
    { responses: [{ sku: "SKU-A", statusCode: 200, offers: [{ offerId: "offer-SKU-A", statusCode: 200 }] }] },
  ])("rejects incomplete direct bulk confirmations inside the admitted callback: %#", async response => {
    const input = { method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", body: { requests: [{
      sku: "SKU-A", shipToLocationAvailability: { quantity: 999 }, offers: [
        { offerId: "offer-SKU-A", availableQuantity: 999 }, { offerId: "second-offer", availableQuantity: 999 },
      ],
    }] } }; const f = fixture({ override: request => request.path.includes("bulk_update_price_quantity") ? response : undefined });
    await expect(executeAdmittedEbayQuantityRequest(input, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    // This is a fake admission observer, not a database proof. It demonstrates
    // that response validation occurs before the real owner's work() resolves.
    expect(f.outcomes).toEqual(["uncertain"]);
  });

  it("refreshes retained quantities before quantity-free offer publication under exact SKU admission", async () => {
    const f = fixture();
    await expect(executeAdmittedEbayQuantityRequest(offerPublish, f.admission, f.request)).resolves.toEqual({ listingId: "listing-1" });
    expect(f.owners).toEqual([{ kind: "item", identity: "SKU-A" }]);
    expect(writes(f.calls)).toEqual([
      { method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", body: {
        requests: [{ sku: "SKU-A", shipToLocationAvailability: { quantity: 5 }, offers: [{ offerId: "offer-SKU-A", availableQuantity: 5 }] }],
      } }, offerPublish,
    ]);
  });

  it("refreshes every sorted group member under one complete member admission before publishing", async () => {
    const f = fixture(); await executeAdmittedEbayQuantityRequest(groupPublish, f.admission, f.request);
    expect(f.owners).toEqual([{ kind: "group", identity: "GROUP", members: ["SKU-A", "SKU-B"] }]);
    const sent = writes(f.calls); expect(sent).toHaveLength(3); expect(sent.at(-1)).toEqual(groupPublish);
    expect(sent[0].body).toMatchObject({ requests: [{ sku: "SKU-A", shipToLocationAvailability: { quantity: 5 } }] });
    expect(sent[1].body).toMatchObject({ requests: [{ sku: "SKU-B", shipToLocationAvailability: { quantity: 2 } }] });
    expect(f.calls.filter(row => row.method === "GET" && row.path.includes("inventory_item_group/"))).toHaveLength(2);
  });

  it.each([offerPublish, groupPublish])("does not perform any provider mutation when quantity-free publication is suppressed: %#", async input => {
    const f = fixture({ blocked: true });
    await expect(executeAdmittedEbayQuantityRequest(input, f.admission, f.request)).rejects.toBe(f.denied);
    expect(writes(f.calls)).toEqual([]);
  });

  it("checks group membership again after admission and blocks changed membership before any write", async () => {
    let groupReads = 0;
    const f = fixture({ override: input => input.method === "GET" && input.path.includes("inventory_item_group/")
      ? { variantSKUs: ++groupReads === 1 ? ["SKU-A", "SKU-B"] : ["SKU-A"] } : undefined });
    await expect(executeAdmittedEbayQuantityRequest(groupPublish, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls)).toEqual([]);
  });

  it.each([
    { shipToLocationAvailability: { quantity: 999, availabilityDistributions: [{ quantity: 900 }] } },
    { shipToLocationAvailability: { quantity: 999 }, pickupAtLocationAvailability: [{ quantity: 900 }] },
  ])("does not replay unsupported retained location quantities: %#", async availability => {
    const f = fixture({ override: input => input.method === "GET" && input.path.includes("inventory_item/") ? { availability } : undefined });
    await expect(executeAdmittedEbayQuantityRequest(offerPublish, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls)).toEqual([]);
  });

  it("does not publish a group if canonical planning omits a member", async () => {
    const f = fixture({ quantities: new Map([["SKU-A", 5]]) });
    await expect(executeAdmittedEbayQuantityRequest(groupPublish, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls).some(row => row.path.includes("publish_by_inventory_item_group"))).toBe(false);
  });

  it.each([{ responses: [] }, { responses: [{ offerId: "offer-SKU-A", statusCode: 400 }] },
    { responses: [{ offerId: "wrong-offer", statusCode: 200 }] },
    { responses: [{ offerId: "offer-SKU-A", statusCode: 200, errors: [{ message: "Rejected" }] }] },
  ])("does not publish retained offer after partial/unrelated provider confirmation: %#", async response => {
    const f = fixture({ override: input => input.path.includes("bulk_update_price_quantity") ? response : undefined });
    await expect(executeAdmittedEbayQuantityRequest(offerPublish, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls).some(row => row.path.endsWith("/publish"))).toBe(false);
  });

  it("rejects truncated offer membership before refreshing or publishing", async () => {
    const f = fixture({ override: input => input.method === "GET" && input.path.includes("/offer?")
      ? { offers: [{ offerId: "offer-SKU-A", sku: "SKU-A" }], total: 2 } : undefined });
    await expect(executeAdmittedEbayQuantityRequest(offerPublish, f.admission, f.request)).rejects.toMatchObject({ code: "PUBLICATION_LISTING_MEMBERSHIP_UNPROVEN" });
    expect(writes(f.calls)).toEqual([]);
  });

  it("preserves input payloads and prices while replacing each bulk SKU's stale quantities independently", async () => {
    const input = { method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", body: { requests: [
      { sku: "SKU-A", shipToLocationAvailability: { quantity: 999 }, offers: [{ offerId: "offer-SKU-A", availableQuantity: 999, price: { value: "12.00", currency: "USD" } }] },
      { sku: "SKU-B", shipToLocationAvailability: { quantity: 888 }, offers: [{ offerId: "offer-SKU-B", availableQuantity: 888 }] },
    ] } }; const before = structuredClone(input); const f = fixture();
    const result = await executeAdmittedEbayQuantityRequest<{ responses: unknown[] }>(input, f.admission, f.request);
    expect(result.responses).toHaveLength(2); expect(input).toEqual(before);
    expect(f.owners).toEqual([{ kind: "item", identity: "SKU-A" }, { kind: "item", identity: "SKU-B" }]);
    expect(writes(f.calls)[0].body).toMatchObject({ requests: [{ sku: "SKU-A", shipToLocationAvailability: { quantity: 5 },
      offers: [{ availableQuantity: 5, price: { value: "12.00", currency: "USD" } }] }] });
    expect(writes(f.calls)[1].body).toMatchObject({ requests: [{ sku: "SKU-B", shipToLocationAvailability: { quantity: 2 }, offers: [{ availableQuantity: 2 }] }] });
  });

  it("does not rewrite or require quantity admission for truly price-only bulk updates", async () => {
    const input = { method: "POST", path: "/sell/inventory/v1/bulk_update_price_quantity", body: { requests: [
      { sku: "SKU-A", offers: [{ offerId: "offer-SKU-A", price: { value: "12.00", currency: "USD" } }] },
    ] } }; const f = fixture({ blocked: true });
    await executeAdmittedEbayQuantityRequest(input, f.admission, f.request);
    expect(f.owners).toEqual([]); expect(f.calls).toEqual([input]);
  });

  it("admits legacy retained publication without falsely replacing its quantity from absent canonical proof", async () => {
    const f = fixture({ quantities: null });
    await executeAdmittedEbayQuantityRequest(groupPublish, f.admission, f.request);
    expect(writes(f.calls)).toEqual([groupPublish]); expect(f.owners[0].kind).toBe("group");
  });
});
