import { describe, expect, it, vi } from "vitest";
import { EbayListingFeedInventoryService } from "../../application/ebay-listing-feed-inventory.service";
import { InventoryChannelQuantityRuntimeError, InventoryPublicationSelectionError } from "../../../inventory-planning/channel-quantity";

const reference = "ea7e6ab5-5074-4fc1-a8b8-950a308dd725";
function setup(rows: readonly { productVariantId: number; atpUnits: number }[] = []) {
  const reader = { getAtpPerVariant: vi.fn(async () => rows) };
  const diagnostics = { createReference: () => reference, reportFailure: vi.fn() };
  return { reader, diagnostics, service: new EbayListingFeedInventoryService(reader, diagnostics) };
}

describe("eBay listing feed inventory read boundary", () => {
  it("projects exact requested variants, preserving genuine zero and the reader's immutable results", async () => {
    const rows = Object.freeze([Object.freeze({ productVariantId: 10, atpUnits: 0 }),
      Object.freeze({ productVariantId: 11, atpUnits: 9 }), Object.freeze({ productVariantId: 12, atpUnits: 4 })]);
    const { service, reader, diagnostics } = setup(rows);
    expect(await service.readProduct(1, [11, 10])).toEqual({ quantities: new Map([[11, 9], [10, 0]]), issue: null });
    expect(reader.getAtpPerVariant).toHaveBeenCalledExactlyOnceWith(1);
    expect(diagnostics.reportFailure).not.toHaveBeenCalled();
  });

  it.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("does not disguise invalid quantity %s as stock", async atpUnits => {
    const { service, diagnostics } = setup([{ productVariantId: 10, atpUnits }]);
    const result = await service.readProduct(1, [10]);
    expect(result.quantities.get(10)).toBeNull();
    expect(result.issue).toMatchObject({ code: "EBAY_FEED_QUANTITY_INVALID", reference });
    expect(diagnostics.reportFailure).toHaveBeenCalledOnce();
  });

  it("rejects duplicate quantity identities", async () => {
    const { service } = setup([{ productVariantId: 10, atpUnits: 4 }, { productVariantId: 10, atpUnits: 4 }]);
    expect((await service.readProduct(1, [10])).issue?.code).toBe("EBAY_FEED_QUANTITY_INVALID");
  });

  it("treats an absent destination row as unknown rather than zero", async () => {
    const { service } = setup();
    const result = await service.readProduct(1, [10]);
    expect(result.quantities.get(10)).toBeNull();
    expect(result.issue).toMatchObject({ code: "EBAY_FEED_QUANTITY_MISSING", action: { href: "/channels/inventory?product=1" } });
  });

  it("preserves a healthy sibling while reporting only an expected missing quantity", async () => {
    const { service } = setup([{ productVariantId: 10, atpUnits: 17 }]);
    const result = await service.readProduct(1, [10, 11]);
    expect(result.quantities).toEqual(new Map([[10, 17], [11, null]]));
    expect(result.issue?.code).toBe("EBAY_FEED_QUANTITY_MISSING");
    expect(result.issue?.details).toContainEqual({ label: "Variants without quantities", value: "11" });
  });

  it("allows the listing owner to omit excluded or nonmanaged variants without a false stock issue", async () => {
    const { service } = setup([{ productVariantId: 10, atpUnits: 17 }]);
    expect(await service.readProduct(1, [10, 11], [10])).toEqual({ quantities: new Map([[10, 17], [11, null]]), issue: null });
    const empty = setup();
    expect(await empty.service.readProduct(1, [11], [])).toEqual({ quantities: new Map([[11, null]]), issue: null });
  });

  it("preserves the known selection error's mapping review action without exposing private error text", async () => {
    const { service, reader } = setup();
    reader.getAtpPerVariant.mockRejectedValueOnce(new InventoryPublicationSelectionError("CHANNEL_SELECTION_AMBIGUOUS", "private database details"));
    const result = await service.readProduct(1, [10]);
    expect(result.issue).toMatchObject({ code: "CHANNEL_SELECTION_AMBIGUOUS", reference, action: { kind: "review_mapping" } });
    expect(JSON.stringify(result.issue)).not.toContain("private database details");
  });

  it("only exposes allowlisted runtime codes and validated context, never arbitrary diagnostic messages", async () => {
    const { service, reader } = setup();
    reader.getAtpPerVariant.mockRejectedValueOnce(new InventoryChannelQuantityRuntimeError("CANONICAL_CHANNEL_QUANTITY_BLOCKED",
      "SELECT private FROM private_table", { productVariantId: 10, publicationTargetId: 67, blockerCodes: ["CHANNEL_EXPOSURE_POLICY_INCOMPLETE", "Bearer secret"] }));
    const result = await service.readProduct(1, [10]);
    expect(result.issue).toMatchObject({ code: "CANONICAL_CHANNEL_QUANTITY_BLOCKED", reference });
    expect(result.issue?.message).toContain("eBay stock policy is missing settings");
    expect(result.issue?.details).toContainEqual({ label: "Inventory check", value: "CHANNEL_EXPOSURE_POLICY_INCOMPLETE" });
    expect(JSON.stringify(result.issue)).not.toMatch(/private|Bearer|secret/);
  });

  it("isolates unknown failures without treating an arbitrary code property as a trusted diagnosis", async () => {
    const { service, reader, diagnostics } = setup();
    const error = Object.assign(new Error("database credentials or SQL"), { code: "CANONICAL_CHANNEL_QUANTITY_BLOCKED" });
    reader.getAtpPerVariant.mockRejectedValueOnce(error);
    const result = await service.readProduct(1, [10]);
    expect(result.issue).toMatchObject({ code: "EBAY_FEED_QUANTITY_UNAVAILABLE", reference, action: { kind: "contact_support" } });
    expect(JSON.stringify(result.issue)).not.toContain(error.message);
    expect(diagnostics.reportFailure).toHaveBeenCalledWith({ productId: 1, reference, code: "EBAY_FEED_QUANTITY_UNAVAILABLE", error });
  });

  it.each([[0, [10]], [1, [10, 10]], [1, [-1]]] as const)("validates requested identities before reading %s", async (productId, variants) => {
    const { service, reader } = setup();
    await expect(service.readProduct(productId, variants)).rejects.toThrow("distinct positive variant identifiers");
    expect(reader.getAtpPerVariant).not.toHaveBeenCalled();
  });
});
