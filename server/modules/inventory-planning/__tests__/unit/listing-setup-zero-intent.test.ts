import { describe, expect, it } from "vitest";
import {
  assertListingSetupAdmission,
  runWithListingSetupAdmission,
  validateListingSetupIntent,
  listingSetupRequestSchema,
} from "../../application/listing-setup-intent";
import { isQuantityProviderRequestPath } from "../../application/quantity-provider-request-evidence";

const intent = () => ({
  operationId: "operation-1",
  publicationTargetId: 4,
  expectedTargetRevision: "2",
  channelId: 104,
  channelConnectionId: 67,
  partnerId: "10002558022",
  environment: "production" as const,
  shipNodeId: "10002558022",
  items: [{ productVariantId: 101, sku: "PACK", quantity: 0 as const }],
});
describe("initial listing inventory intent", () => {
  it("requires immutable recreation evidence and prevents callers selecting their own quantity", () => {
    const recreation = { sourceOperationId: "00000000-0000-4000-8000-000000000001", sourceHash: "a".repeat(64), previousExternalProductId: "WPID-OLD" };
    const input = { ...intent(), items: [{ ...intent().items[0], recreation }] };
    const validated = validateListingSetupIntent(input);
    expect(Object.isFrozen(validated.items[0].recreation)).toBe(true);
    recreation.previousExternalProductId = "CHANGED";
    expect(validated.items[0].recreation?.previousExternalProductId).toBe("WPID-OLD");
    expect(() => listingSetupRequestSchema.parse({ ...input, items: [{ ...input.items[0], quantity: 1 }] })).toThrow();
    expect(() => validateListingSetupIntent({ ...intent(), items: [{ ...intent().items[0], recreation: true }] })).toThrow();
    expect(() => validateListingSetupIntent({ ...input, items: [{ ...input.items[0], recreation: { ...recreation, sourceHash: "not-proof" } }] })).toThrow();
  });
  it("requires exact runtime owner proof; a correctly typed object is insufficient", async () => {
    expect(() => assertListingSetupAdmission(intent())).toThrow(
      /inventory-owned/,
    );
    await runWithListingSetupAdmission(
      validateListingSetupIntent(intent()),
      async () => {
        expect(() => assertListingSetupAdmission(intent())).not.toThrow();
        expect(() =>
          assertListingSetupAdmission({
            ...intent(),
            shipNodeId: "another-node",
          }),
        ).toThrow();
        expect(() =>
          assertListingSetupAdmission({
            ...intent(),
            operationId: "another-operation",
          }),
        ).toThrow();
        expect(() =>
          assertListingSetupAdmission({
            ...intent(),
            items: [{ productVariantId: 102, sku: "PACK", quantity: 0 }],
          }),
        ).toThrow();
      },
    );
    expect(() => assertListingSetupAdmission(intent())).toThrow();
  });
  it("rejects invalid quantities, duplicates, unexpected fields and invalid identifiers", () => {
    for (const bad of [
      {
        ...intent(),
        items: [{ productVariantId: 101, sku: "PACK", quantity: -1 }],
      },
      { ...intent(), items: [...intent().items, ...intent().items] },
      {
        ...intent(),
        items: [
          ...intent().items,
          { productVariantId: 102, sku: "PACK", quantity: 0 },
        ],
      },
      { ...intent(), expectedTargetRevision: "0" },
      { ...intent(), quantity: 0 },
    ])
      expect(() => validateListingSetupIntent(bad)).toThrow();
  });
  it.each([0, 1, 2_147_483_647])("binds the exact inventory-owned quantity %s to transport admission", async quantity => {
    const approved = validateListingSetupIntent({ ...intent(), items: [{ ...intent().items[0], quantity }] });
    await runWithListingSetupAdmission(approved, async () => {
      expect(() => assertListingSetupAdmission(approved)).not.toThrow();
      expect(() => assertListingSetupAdmission({ ...approved, items: [{ ...approved.items[0], quantity: quantity === 0 ? 1 : 0 }] })).toThrow();
    });
    for (const invalid of [-1, 1.5, 2_147_483_648, NaN, Infinity])
      expect(() => validateListingSetupIntent({ ...intent(), items: [{ ...intent().items[0], quantity: invalid }] })).toThrow();
  });
  it("sorts a detached immutable intent without mutating caller data", () => {
    const input = {
      ...intent(),
      items: [
        { productVariantId: 102, sku: "B", quantity: 0 as const },
        ...intent().items,
      ],
    };
    const validated = validateListingSetupIntent(input);
    expect(input.items.map((row) => row.productVariantId)).toEqual([102, 101]);
    expect(validated.items.map((row) => row.productVariantId)).toEqual([
      101, 102,
    ]);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.items)).toBe(true);
    expect(Object.isFrozen(validated.items[0])).toBe(true);
  });
  it("rejects nested owners and keeps concurrent scopes isolated", async () => {
    await Promise.all(
      [intent(), { ...intent(), operationId: "two" }].map((input) =>
        runWithListingSetupAdmission(input, async () => {
          await Promise.resolve();
          expect(() => assertListingSetupAdmission(input)).not.toThrow();
          expect(() =>
            runWithListingSetupAdmission(input, async () => undefined),
          ).toThrow(/nested/);
        }),
      ),
    );
  });
  it("records only exact Walmart quantity-bearing endpoints", () => {
    expect(
      isQuantityProviderRequestPath("POST", "/v3/feeds?feedType=MP_ITEM"),
    ).toBe(true);
    expect(
      isQuantityProviderRequestPath("POST", "/v3/feeds?feedType=MP_ITEM_MATCH"),
    ).toBe(true);
    expect(
      isQuantityProviderRequestPath(
        "PUT",
        "/v3/inventory?sku=A%20B&shipNode=100",
      ),
    ).toBe(true);
    for (const [method, path] of [
      ["POST", "/v3/feeds?feedType=PRICE_AND_PROMOTION"],
      ["POST", "/v3/feeds?feedType=MP_ITEM&bad=1"],
      ["GET", "/v3/feeds?feedType=MP_ITEM"],
      ["PUT", "/v3/inventory?sku=A&shipNode=100&bad=1"],
      ["PUT", "/v3/inventory?sku=A B&shipNode=100"],
    ]) {
      expect(isQuantityProviderRequestPath(method, path)).toBe(false);
    }
  });
});
