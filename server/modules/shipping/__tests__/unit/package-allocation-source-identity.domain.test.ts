import { describe, expect, it } from "vitest";

import {
  derivePackageAllocationSourceRegistration,
  PackageAllocationSourceIdentityError,
  type PackageAllocationSourceFacts,
} from "../../package-allocation-source-identity.domain";

function customerFacts(
  overrides: Partial<PackageAllocationSourceFacts> = {},
): PackageAllocationSourceFacts {
  return {
    sourceWmsShipmentItemId: 7001,
    shipmentRequestItemId: "90001",
    sourceQuantity: 2,
    shipmentItemPurpose: "customer_fulfillment",
    orderItemId: 8101,
    replacementForOrderItemId: null,
    correctionForShipmentItemId: null,
    productVariantId: 9101,
    orderItemSku: "  SKU-CUSTOMER  ",
    replacementOrderItemSku: null,
    productVariantSku: "SKU-VARIANT",
    ...overrides,
  };
}

function expectIdentityError(
  run: () => unknown,
  code: PackageAllocationSourceIdentityError["code"],
): void {
  try {
    run();
    throw new Error("Expected source identity derivation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PackageAllocationSourceIdentityError);
    expect((error as PackageAllocationSourceIdentityError).code).toBe(code);
  }
}

describe("derivePackageAllocationSourceRegistration", () => {
  it("derives a deterministic, frozen customer-fulfillment registration", () => {
    const facts = customerFacts();
    const original = structuredClone(facts);

    const first = derivePackageAllocationSourceRegistration(facts);
    const second = derivePackageAllocationSourceRegistration({ ...facts });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      contractVersion: 1,
      sourceWmsShipmentItemId: 7001,
      shipmentRequestItemId: "90001",
      sourceQuantity: 2,
      shipmentItemPurpose: "customer_fulfillment",
      orderItemId: 8101,
      sku: "SKU-CUSTOMER",
    });
    expect(first.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.isFrozen(first)).toBe(true);
    expect(facts).toEqual(original);
  });

  it("accepts the maximum PostgreSQL bigint request identity", () => {
    expect(derivePackageAllocationSourceRegistration(customerFacts({
      shipmentRequestItemId: "9223372036854775807",
    })).shipmentRequestItemId).toBe("9223372036854775807");
  });

  it.each([
    {
      purpose: "replacement" as const,
      facts: customerFacts({
        shipmentRequestItemId: null,
        shipmentItemPurpose: "replacement",
        orderItemId: null,
        replacementForOrderItemId: 8102,
        replacementOrderItemSku: "SKU-REPLACEMENT",
      }),
      sku: "SKU-REPLACEMENT",
    },
    {
      purpose: "concession" as const,
      facts: customerFacts({
        shipmentRequestItemId: null,
        shipmentItemPurpose: "concession",
        orderItemId: null,
        productVariantSku: "SKU-CONCESSION",
      }),
      sku: "SKU-CONCESSION",
    },
    {
      purpose: "omission_correction" as const,
      facts: customerFacts({
        shipmentRequestItemId: null,
        shipmentItemPurpose: "omission_correction",
        orderItemId: null,
        correctionForShipmentItemId: 7000,
        productVariantSku: "SKU-OMISSION",
      }),
      sku: "SKU-OMISSION",
    },
    {
      purpose: "unclassified" as const,
      facts: customerFacts({
        shipmentRequestItemId: null,
        shipmentItemPurpose: "unclassified",
        orderItemId: null,
        productVariantSku: "SKU-UNCLASSIFIED",
      }),
      sku: "SKU-UNCLASSIFIED",
    },
  ])("derives the authoritative SKU for $purpose lineage", ({ facts, sku }) => {
    expect(derivePackageAllocationSourceRegistration(facts)).toMatchObject({ sku });
  });

  it("changes the fingerprint when immutable source evidence changes", () => {
    const base = derivePackageAllocationSourceRegistration(customerFacts());
    const changed = derivePackageAllocationSourceRegistration(customerFacts({ sourceQuantity: 3 }));

    expect(changed.sourceFingerprint).not.toBe(base.sourceFingerprint);
  });

  it.each([
    ["replacement with a request item", customerFacts({
      shipmentItemPurpose: "replacement",
      orderItemId: null,
      replacementForOrderItemId: 8102,
      replacementOrderItemSku: "SKU-REPLACEMENT",
    })],
    ["customer fulfillment without an order item", customerFacts({ orderItemId: null })],
    ["replacement with a customer order item", customerFacts({
      shipmentRequestItemId: null,
      shipmentItemPurpose: "replacement",
      replacementForOrderItemId: 8102,
      replacementOrderItemSku: "SKU-REPLACEMENT",
    })],
    ["concession without a variant", customerFacts({
      shipmentRequestItemId: null,
      shipmentItemPurpose: "concession",
      orderItemId: null,
      productVariantId: null,
    })],
    ["omission without its correction source", customerFacts({
      shipmentRequestItemId: null,
      shipmentItemPurpose: "omission_correction",
      orderItemId: null,
      correctionForShipmentItemId: null,
    })],
  ])("rejects invalid purpose lineage: %s", (_label, facts) => {
    expectIdentityError(
      () => derivePackageAllocationSourceRegistration(facts),
      "SOURCE_LINEAGE_INVALID",
    );
  });

  it.each([
    customerFacts({ orderItemSku: null }),
    customerFacts({ orderItemSku: "   " }),
    customerFacts({
      shipmentRequestItemId: null,
      shipmentItemPurpose: "unclassified",
      orderItemId: null,
      productVariantSku: null,
    }),
  ])("rejects source evidence without an authoritative nonblank SKU", (facts) => {
    expectIdentityError(
      () => derivePackageAllocationSourceRegistration(facts),
      "SOURCE_SKU_UNPROVEN",
    );
  });

  it.each([
    customerFacts({ sourceWmsShipmentItemId: 2_147_483_648 }),
    customerFacts({ sourceQuantity: 2_147_483_648 }),
    customerFacts({ sourceQuantity: 0 }),
    customerFacts({ shipmentRequestItemId: "9223372036854775808" }),
    customerFacts({ shipmentRequestItemId: "not-a-number" }),
    customerFacts({ orderItemSku: "X".repeat(101) }),
    { ...customerFacts(), unexpected: true } as PackageAllocationSourceFacts,
  ])("rejects invalid boundary evidence", (facts) => {
    expectIdentityError(
      () => derivePackageAllocationSourceRegistration(facts),
      "INVALID_SOURCE_FACTS",
    );
  });
});
