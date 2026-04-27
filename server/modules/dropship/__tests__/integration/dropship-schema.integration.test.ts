import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import {
  getTestDb,
  runMigrations,
  truncateTestData,
  closeTestDb,
} from "../../../../../test/setup-integration";
import {
  dropshipVendors,
  dropshipStoreConnections,
  dropshipVendorProductSelections,
  dropshipVendorVariantOverrides,
  dropshipVendorPricingRules,
  dropshipVendorListings,
  dropshipWalletLedger,
  dropshipOrderIntake,
  channels,
  products,
  productVariants,
} from "@shared/schema";

describe("Dropship Schema Constraints (Integration)", () => {
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    db = getTestDb();
    await runMigrations();
  });

  afterAll(async () => {
    await closeTestDb();
  });

  beforeEach(async () => {
    await truncateTestData();
  });

  // Seed helpers
  async function seedVendor() {
    const [vendor] = await db.insert(dropshipVendors).values({
      name: "Test Vendor",
      email: "test@vendor.com",
      status: "active",
      availableBalanceCents: 1000,
      pendingBalanceCents: 0,
    }).returning();
    return vendor;
  }

  async function seedChannel() {
    const [channel] = await db.insert(channels).values({
      name: "Test Channel",
      type: "internal",
      provider: "shopify",
      status: "active",
      priority: 10,
    }).returning();
    return channel;
  }

  async function seedCatalog() {
    const [product] = await db.insert(products).values({
      name: "Test Product",
      sku: "TEST-PROD",
      status: "active",
    }).returning();

    const [variant] = await db.insert(productVariants).values({
      productId: product.id,
      name: "Test Variant",
      sku: "TEST-VAR",
      unitsPerVariant: 1,
      priceCents: 1000,
      isActive: true,
    }).returning();

    return { product, variant };
  }

  async function seedStoreConnection(vendorId: number) {
    const [connection] = await db.insert(dropshipStoreConnections).values({
      vendorId,
      sourcePlatform: "shopify",
      sourceAccountId: "test.myshopify.com",
      status: "connected",
    }).returning();
    return connection;
  }

  describe("Wallet Ledger Constraints", () => {
    it("should enforce unique (reference_type, reference_id) for non-null references", async () => {
      const vendor = await seedVendor();

      await db.insert(dropshipWalletLedger).values({
        vendorId: vendor.id,
        type: "charge",
        amountCents: -500,
        balanceAfterCents: 500,
        status: "settled",
        referenceType: "order",
        referenceId: "ORDER-123",
      });

      // Second insert with the same reference_type and reference_id should fail
      await expect(
        db.insert(dropshipWalletLedger).values({
          vendorId: vendor.id,
          type: "charge",
          amountCents: -500,
          balanceAfterCents: 0,
          status: "settled",
          referenceType: "order",
          referenceId: "ORDER-123",
        })
      ).rejects.toThrow(/idx_dwl_ref_type_id/);

      // But null references should be allowed to duplicate
      await db.insert(dropshipWalletLedger).values({
        vendorId: vendor.id,
        type: "deposit",
        amountCents: 1000,
        balanceAfterCents: 1500,
        status: "settled",
        referenceType: "manual",
        referenceId: null,
      });

      await db.insert(dropshipWalletLedger).values({
        vendorId: vendor.id,
        type: "deposit",
        amountCents: 1000,
        balanceAfterCents: 2500,
        status: "settled",
        referenceType: "manual",
        referenceId: null,
      });
    });
  });

  describe("Order Intake Constraints", () => {
    it("should enforce unique (channel_id, external_order_id)", async () => {
      const vendor = await seedVendor();
      const channel = await seedChannel();

      await db.insert(dropshipOrderIntake).values({
        channelId: channel.id,
        externalOrderId: "EXT-123",
        vendorId: vendor.id,
        sourcePlatform: "shopify",
        sourceAccountId: "test",
        status: "received",
      });

      await expect(
        db.insert(dropshipOrderIntake).values({
          channelId: channel.id,
          externalOrderId: "EXT-123",
          vendorId: vendor.id,
          sourcePlatform: "shopify",
          sourceAccountId: "test",
          status: "received",
        })
      ).rejects.toThrow(/idx_doi_channel_external/);
    });
  });

  describe("Vendor Product & Variant Constraints", () => {
    it("should enforce unique product selection per vendor", async () => {
      const vendor = await seedVendor();
      const { product } = await seedCatalog();

      await db.insert(dropshipVendorProductSelections).values({
        vendorId: vendor.id,
        productId: product.id,
        enabled: true,
      });

      await expect(
        db.insert(dropshipVendorProductSelections).values({
          vendorId: vendor.id,
          productId: product.id,
          enabled: false,
        })
      ).rejects.toThrow(/idx_dvps_vendor_product/);
    });

    it("should enforce unique variant override per vendor", async () => {
      const vendor = await seedVendor();
      const { variant } = await seedCatalog();

      await db.insert(dropshipVendorVariantOverrides).values({
        vendorId: vendor.id,
        productVariantId: variant.id,
        enabledOverride: false,
      });

      await expect(
        db.insert(dropshipVendorVariantOverrides).values({
          vendorId: vendor.id,
          productVariantId: variant.id,
          enabledOverride: true,
        })
      ).rejects.toThrow(/idx_dvvo_vendor_variant/);
    });
  });

  describe("Pricing Rule Constraints", () => {
    it("should allow fixed rules on variant scope", async () => {
      const vendor = await seedVendor();

      await expect(
        db.insert(dropshipVendorPricingRules).values({
          vendorId: vendor.id,
          scope: "variant",
          scopeId: 1,
          ruleType: "fixed",
          value: 1500, // cents
        })
      ).resolves.not.toThrow();
    });

    it("should allow percent rules on non-variant scopes", async () => {
      const vendor = await seedVendor();

      await expect(
        db.insert(dropshipVendorPricingRules).values({
          vendorId: vendor.id,
          scope: "global",
          ruleType: "percent",
          value: 15,
        })
      ).resolves.not.toThrow();
    });

    it("should reject fixed rules on non-variant scopes (global)", async () => {
      const vendor = await seedVendor();

      await expect(
        db.insert(dropshipVendorPricingRules).values({
          vendorId: vendor.id,
          scope: "global",
          ruleType: "fixed",
          value: 1500,
        })
      ).rejects.toThrow(/chk_dvpr_fixed_only_variant/);
    });
  });

  describe("Vendor Listing Constraints", () => {
    it("should enforce unique connection + variant for listings", async () => {
      const vendor = await seedVendor();
      const { variant } = await seedCatalog();
      const connection = await seedStoreConnection(vendor.id);

      await db.insert(dropshipVendorListings).values({
        vendorStoreConnectionId: connection.id,
        productVariantId: variant.id,
        status: "active",
      });

      await expect(
        db.insert(dropshipVendorListings).values({
          vendorStoreConnectionId: connection.id,
          productVariantId: variant.id,
          status: "inactive",
        })
      ).rejects.toThrow(/idx_dvl_connection_variant/);
    });
  });

  describe("Balance Fields Types", () => {
    it("should handle large integer values for balances (cents)", async () => {
      // 10 million dollars in cents = 1,000,000,000 cents
      const largeBalanceCents = 1_000_000_000;
      
      const [vendor] = await db.insert(dropshipVendors).values({
        name: "Rich Vendor",
        email: "rich@vendor.com",
        availableBalanceCents: largeBalanceCents,
        pendingBalanceCents: largeBalanceCents,
      }).returning();

      // Ensure that Drizzle mapped the Postgres bigint correctly to JS Number
      // (as specified by { mode: "number" })
      expect(typeof vendor.availableBalanceCents).toBe("number");
      expect(vendor.availableBalanceCents).toBe(largeBalanceCents);
    });
  });
});
