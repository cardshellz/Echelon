import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS,
  DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES,
  DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS,
  dropshipFaultCategoryEnum,
  dropshipOrderIntake,
  dropshipSourcePlatformEnum,
  dropshipStoreConnections,
  dropshipVendorListings,
  dropshipWalletAccounts,
  dropshipWalletLedger,
} from "../schema/dropship.schema";

const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/0086_dropship_v2_foundation.sql"),
  "utf8",
);

describe("Dropship V2 schema contract", () => {
  it("uses the agreed launch defaults without floating point money", () => {
    expect(DROPSHIP_DEFAULT_PAYMENT_HOLD_TIMEOUT_MINUTES).toBe(2880);
    expect(DROPSHIP_DEFAULT_RETURN_WINDOW_DAYS).toBe(30);
    expect(DROPSHIP_DEFAULT_INSURANCE_POOL_FEE_BPS).toBe(200);
    expect(migrationSql).toContain("payment_hold_timeout_minutes integer NOT NULL DEFAULT 2880");
    expect(migrationSql).toContain("return_window_days integer NOT NULL DEFAULT 30");
    expect(migrationSql).toContain("fee_bps integer NOT NULL DEFAULT 200");
    expect(migrationSql).not.toMatch(/\b(double precision|real)\b/i);
    expect(migrationSql).toContain("amount_atomic_units numeric(78,0) NOT NULL");
  });

  it("models store connections instead of the discarded vendor-channel prototype", () => {
    expect(dropshipSourcePlatformEnum).toEqual([
      "ebay",
      "shopify",
      "tiktok",
      "instagram",
      "bigcommerce",
    ]);
    expect((dropshipStoreConnections as any).vendorId.name).toBe("vendor_id");
    expect((dropshipStoreConnections as any).platform.name).toBe("platform");
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS dropship.dropship_store_connections");
    expect(migrationSql).toContain("dropship_store_conn_active_vendor_idx");
    expect(migrationSql).not.toContain("dropship_vendor_channels");
  });

  it("keeps order intake idempotent by store connection and external order", () => {
    expect((dropshipOrderIntake as any).storeConnectionId.name).toBe("store_connection_id");
    expect((dropshipOrderIntake as any).externalOrderId.name).toBe("external_order_id");
    expect(migrationSql).toContain("dropship_order_intake_store_external_idx");
    expect(migrationSql).toContain("ON dropship.dropship_order_intake(store_connection_id, external_order_id)");
  });

  it("separates wallet account balance from idempotent ledger entries", () => {
    expect((dropshipWalletAccounts as any).availableBalanceCents.name).toBe("available_balance_cents");
    expect((dropshipWalletAccounts as any).pendingBalanceCents.name).toBe("pending_balance_cents");
    expect((dropshipWalletLedger as any).idempotencyKey.name).toBe("idempotency_key");
    expect(migrationSql).toContain("dropship_wallet_ref_idx");
    expect(migrationSql).toContain("WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL");
    expect(migrationSql).toContain("dropship_wallet_idem_idx");
    expect(migrationSql).toContain("CONSTRAINT dropship_wallet_ledger_amount_chk CHECK (amount_cents <> 0)");
  });

  it("captures listing, fault, return, notification, and insurance policy constraints", () => {
    expect((dropshipVendorListings as any).productVariantId.name).toBe("product_variant_id");
    expect(dropshipFaultCategoryEnum).toEqual([
      "card_shellz",
      "vendor",
      "customer",
      "marketplace",
      "carrier",
    ]);
    expect(migrationSql).toContain("dropship_listing_store_variant_idx");
    expect(migrationSql).toContain("dropship_rma_fault_chk");
    expect(migrationSql).toContain("dropship_notification_pref_critical_chk");
    expect(migrationSql).toContain("dropship_insurance_bps_chk");
  });
});

describe("Dropship V2 prototype retirement contract", () => {
  it("does not keep Phase 0 startup DDL or route registration live", () => {
    const dbBootstrap = readFileSync(resolve(process.cwd(), "server/db.ts"), "utf8");
    const routeRegistry = readFileSync(resolve(process.cwd(), "server/routes.ts"), "utf8");
    const appStartup = readFileSync(resolve(process.cwd(), "server/index.ts"), "utf8");

    expect(dbBootstrap).not.toContain("CREATE TABLE IF NOT EXISTS dropship_vendors");
    expect(dbBootstrap).not.toContain("CREATE TABLE IF NOT EXISTS dropship_vendor_products");
    expect(routeRegistry).not.toContain("registerVendorPortalRoutes(app)");
    expect(routeRegistry).not.toContain("registerVendorEbayRoutes(app)");
    expect(appStartup).not.toContain("startVendorOrderPolling()");
  });
});
