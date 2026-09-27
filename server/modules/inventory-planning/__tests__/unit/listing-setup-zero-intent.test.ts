import { describe, expect, it } from "vitest";
import {
  assertListingSetupZeroAdmission,
  runWithListingSetupZeroAdmission,
  validateListingSetupZeroIntent,
} from "../../application/listing-setup-zero-intent";
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
describe("initial listing zero intent", () => {
  it("requires exact runtime owner proof; a correctly typed object is insufficient", async () => {
    expect(() => assertListingSetupZeroAdmission(intent())).toThrow(
      /inventory-owned/,
    );
    await runWithListingSetupZeroAdmission(
      validateListingSetupZeroIntent(intent()),
      async () => {
        expect(() => assertListingSetupZeroAdmission(intent())).not.toThrow();
        expect(() =>
          assertListingSetupZeroAdmission({
            ...intent(),
            shipNodeId: "another-node",
          }),
        ).toThrow();
        expect(() =>
          assertListingSetupZeroAdmission({
            ...intent(),
            operationId: "another-operation",
          }),
        ).toThrow();
        expect(() =>
          assertListingSetupZeroAdmission({
            ...intent(),
            items: [{ productVariantId: 102, sku: "PACK", quantity: 0 }],
          }),
        ).toThrow();
      },
    );
    expect(() => assertListingSetupZeroAdmission(intent())).toThrow();
  });
  it("rejects positive quantities, duplicates, unexpected fields and invalid identifiers", () => {
    for (const bad of [
      {
        ...intent(),
        items: [{ productVariantId: 101, sku: "PACK", quantity: 1 }],
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
      expect(() => validateListingSetupZeroIntent(bad)).toThrow();
  });
  it("sorts a detached immutable intent without mutating caller data", () => {
    const input = {
      ...intent(),
      items: [
        { productVariantId: 102, sku: "B", quantity: 0 as const },
        ...intent().items,
      ],
    };
    const validated = validateListingSetupZeroIntent(input);
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
        runWithListingSetupZeroAdmission(input, async () => {
          await Promise.resolve();
          expect(() => assertListingSetupZeroAdmission(input)).not.toThrow();
          expect(() =>
            runWithListingSetupZeroAdmission(input, async () => undefined),
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
