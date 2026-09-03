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
