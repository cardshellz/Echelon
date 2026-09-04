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
      "const reservationRuntime = createAuthorityAwareReservationRuntime({",
    );
    expect(services).toContain("const reservation = reservationRuntime.reservation;");
    expect(services).toContain("reservationRuntime.executor");
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

  it("routes each Shopify refund through one grouped whole-order demand reconciliation", () => {
    const cascade = source("server/modules/oms/shopify-refund-cascade.service.ts");
    const webhooks = source("server/modules/oms/oms-webhooks.ts");

    expect(cascade).toContain("await helpers.reconcileRefundOrderDemand!");
    expect(cascade).toContain("releaseTargets: internal.releaseTargets");
    expect(cascade).not.toContain("helpers.releaseOrderItemReservation");
    expect(webhooks).toContain("wmsServices.reservation.reconcileRefundOrderDemand(args)");
    expect(webhooks).not.toContain("wmsServices.reservation.releaseOrderItemReservation(args)");
  });
});

describe("inventory availability runtime publication routing contract", () => {
  it("constructs the authority-aware publisher at every production orchestration seam", () => {
    const compositionFiles = [
      "server/services/index.ts",
      "scripts/_ca-live-sync.ts",
      "scripts/run-live-sync-all.ts",
      "scripts/run-live-inventory-sync.ts",
      "scripts/run-dry-sync.ts",
    ];

    for (const file of compositionFiles) {
      const contents = source(file);
      expect(contents, file).toContain("createAuthorityAwareInventoryPublicationService");
      expect(contents, file).toContain("inventoryPublication");
    }
  });

  it("makes the publication router mandatory for orchestrator and variant-availability composition", () => {
    const orchestrator = source("server/modules/channels/echelon-sync-orchestrator.service.ts");
    const availability = source("server/modules/channels/variant-availability-sync.service.ts");

    expect(orchestrator).toContain(
      "inventoryPublication: AuthorityAwareInventoryPublicationService",
    );
    expect(orchestrator).toContain("this.inventoryPublication.publishProduct(");
    expect(orchestrator).toContain("this.inventoryPublication.listProductIds(");
    expect(availability).toContain("inventoryPublication: AuthorityAwareInventoryPublicationService");
    expect(availability).toContain("dependencies.inventoryPublication.publishVariantAvailability({");
  });

  it("keeps direct provider writes behind legacy callbacks or the canonical outbox worker", () => {
    const orchestrator = source("server/modules/channels/echelon-sync-orchestrator.service.ts");
    const availability = source("server/modules/channels/variant-availability-sync.service.ts");
    const outbox = source(
      "server/modules/inventory-planning/application/inventory-publication-outbox.service.ts",
    );

    const orchestratorWrites = indexesOf(orchestrator, ".pushInventory(");
    expect(orchestratorWrites).toHaveLength(2);
    expect(orchestratorWrites.every((index) =>
      index > orchestrator.indexOf("private async syncInventoryForProductLegacy("))).toBe(true);
    const availabilityWrites = indexesOf(availability, ".pushInventory(");
    expect(availabilityWrites).toHaveLength(1);
    expect(availabilityWrites[0]).toBeGreaterThan(
      availability.indexOf("async function publishLegacyAvailability("),
    );
    expect(indexesOf(outbox, ".pushInventory(")).toHaveLength(1);
  });

  it("pins publication authority without activating or reverting it", () => {
    const runtimeRepository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-publication.repository.ts",
    );
    const authorityRepository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-runtime-atp.repository.ts",
    );
    expect(runtimeRepository).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(runtimeRepository).toContain("loadAndLockRuntimeAuthority(connectedClient)");
    expect(authorityRepository).toContain("FROM inventory.availability_runtime_authority");
    expect(authorityRepository).toContain("FOR SHARE");
    expect(runtimeRepository).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
    expect(runtimeRepository).not.toMatch(/INSERT\s+INTO\s+inventory\.availability_runtime_authority/i);
    expect(runtimeRepository).not.toMatch(/DELETE\s+FROM\s+inventory\.availability_runtime_authority/i);
  });
});

function indexesOf(value: string, pattern: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(pattern, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + pattern.length;
  }
  return indexes;
}
