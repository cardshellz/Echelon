import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("inventory availability runtime ATP routing contract", () => {
  it("constructs the authority-aware reader at every production ATP composition seam", () => {
    const compositionFiles = [
      "server/services/index.ts",
      "server/routes/ebay/ebay-utils.ts",
      "server/modules/channels/adapters/ebay/ebay-marketplace-registration-owner.pg-repository.ts",
      "server/modules/dropship/infrastructure/dropship-listing-preview.factory.ts",
      "server/modules/dropship/infrastructure/dropship-marketplace-registration.factory.ts",
      "server/modules/dropship/interfaces/http/dropship-vendor-catalog.routes.ts",
      "scripts/_ca-live-sync.ts",
      "scripts/run-live-sync-all.ts",
      "scripts/run-live-inventory-sync.ts",
      "scripts/run-dry-sync.ts",
      "mock-atp.js",
    ];

    for (const file of compositionFiles) {
      const contents = source(file);
      expect(contents, file).toContain("createAuthorityAwareInventoryAtpService");
      expect(contents, file).not.toContain("createLegacyInventoryAtpService(");
    }
  });

  it("removes product-base division from dropship and eBay registration quantity readers", () => {
    const exactVariantReaders = [
      "server/modules/dropship/application/dropship-selection-atp-service.ts",
      "server/modules/dropship/application/dropship-listing-preview-service.ts",
      "server/modules/dropship/infrastructure/dropship-marketplace-registration-owner.repository.ts",
      "server/modules/channels/adapters/ebay/ebay-marketplace-registration-owner.pg-repository.ts",
    ];

    for (const file of exactVariantReaders) {
      const contents = source(file);
      expect(contents, file).not.toContain("getBaseAtpByProductIds");
      expect(contents, file).not.toMatch(/Math\.floor\([^\n]*atpBase/i);
    }
  });

  it("keeps deployment inert and requires the separately controlled authority row", () => {
    const runtimeRepository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts",
    );
    expect(runtimeRepository).toContain("FROM inventory.availability_runtime_authority");
    expect(runtimeRepository).toContain("FOR SHARE");
    expect(runtimeRepository).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(runtimeRepository).not.toMatch(/INSERT\s+INTO\s+inventory\./i);
    expect(runtimeRepository).not.toMatch(/DELETE\s+FROM\s+inventory\./i);
  });
});

describe("inventory availability runtime claim routing contract", () => {
  it("constructs only the authority-aware reservation service at the production composition root", () => {
    const services = source("server/services/index.ts");
    expect(services).toContain(
      "const reservation = createAuthorityAwareReservationService({",
    );
    expect(services).toContain("canonical: inventoryAvailabilityClaims,");
    expect(services).not.toContain("const reservation = createReservationService(");
    expect(services).not.toContain("createLegacyInventoryAtpService(");
  });

  it("pins claim routing to the persisted authority without activating it", () => {
    const runtimeRepository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-claim.repository.ts",
    );
    expect(runtimeRepository).toContain("FROM inventory.availability_runtime_authority");
    expect(runtimeRepository).toContain("FOR SHARE");
    expect(runtimeRepository).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(runtimeRepository).not.toMatch(/DELETE\s+FROM\s+inventory\.availability_runtime_authority/i);
  });

  it("releases canonical routing locks only because the schema forbids rollback to legacy", () => {
    const runtimeRepository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-claim.repository.ts",
    );
    const cutoverMigration = source("migrations/0638_inventory_availability_cutover.sql");
    expect(runtimeRepository).toContain('if (authority.authority === "canonical")');
    expect(runtimeRepository).toMatch(/authority\.authority === "canonical"[\s\S]*?connectedClient\.query\("COMMIT"\)[\s\S]*?return work\(canonicalContext/);
    expect(cutoverMigration).toContain("OLD.authority = 'canonical' AND NEW.authority <> 'canonical'");
    expect(cutoverMigration).toContain("the first canonical cutover cannot return to legacy authority");
  });

  it("routes durable order-edit events through one demand-reconciliation contract", () => {
    const wmsSync = source("server/modules/oms/wms-sync.service.ts");
    const webhooks = source("server/modules/oms/oms-webhooks.ts");
    expect(wmsSync).toContain("this.services.reservation.reconcileOrderDemand({");
    expect(wmsSync).toContain("demandChanged,");
    expect(wmsSync).not.toContain("// Re-reserve inventory (release all then re-reserve for updated items)");
    expect(webhooks).toContain("orderData.sourceEventId,");
    expect(wmsSync).toContain('e?.code === "CANONICAL_DEMAND_RECONCILIATION_FAILED"');
    expect(webhooks).toContain('propErr?.code === "CANONICAL_DEMAND_RECONCILIATION_FAILED"');
    expect(wmsSync).not.toContain("CANONICAL_DEMAND_RECONCILIATION_NOT_ATOMIC");
    expect(webhooks).not.toContain("CANONICAL_DEMAND_RECONCILIATION_NOT_ATOMIC");
  });
});
