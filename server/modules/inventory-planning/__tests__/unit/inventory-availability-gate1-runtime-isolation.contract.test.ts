import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("inventory availability Phase 1 runtime isolation", () => {
  it("limits the draft repository to inactive master-data and audit writes", () => {
    const repository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-master-data.repository.ts",
    );
    const mutationTargets = [...repository.matchAll(
      /\.(?:insert|update|delete)\(\s*([A-Za-z][A-Za-z0-9]*)/g,
    )].map((match) => match[1]);

    expect([...new Set(mutationTargets)].sort()).toEqual([
      "idempotencyKeys",
      "locationPromisePolicyHeads",
      "locationPromisePolicyVersions",
      "promiseSafetyPolicyHeads",
      "promiseSafetyPolicyVersions",
      "transformationModelHeads",
      "transformationModelPaths",
      "transformationModelVersions",
      "transformationRecipeBindings",
      "transformationRecipeComponentSnapshots",
    ]);
    expect(repository).not.toMatch(/sql`\s*(?:INSERT|UPDATE|DELETE)\b/i);
    expect(repository).toContain("draftUpdateReceiptKey");
    expect(repository).toContain("persistAuditEvent(tx");
  });

  it("keeps every operational ATP and downstream consumer detached from draft authority", () => {
    const runtimeConsumers = [
      "server/modules/inventory/atp.service.ts",
      "server/modules/inventory/application/inventory-levels.query.ts",
      "server/modules/inventory/application/build.use-cases.ts",
      "server/modules/inventory/application/cycle-count.use-cases.ts",
      "server/modules/inventory/inventory.routes.ts",
      "server/modules/inventory/build.routes.ts",
      "server/modules/inventory/recipe-capacity.service.ts",
      "server/modules/channels/reservation.service.ts",
      "server/modules/wms/application/recipe-build-promise.service.ts",
      "server/modules/oms/oms-flow-reconciliation.service.ts",
      "server/modules/oms/oms.service.ts",
      "server/modules/oms/wms-sync.service.ts",
      "server/modules/oms/ebay-order-ingestion.ts",
      "server/modules/oms/oms-webhooks.ts",
      "server/modules/orders/cancel-wms-order.ts",
      "server/modules/channels/allocation-engine.service.ts",
      "server/modules/channels/echelon-sync-orchestrator.service.ts",
      "server/modules/channels/sync.service.ts",
      "server/modules/channels/variant-availability-sync.service.ts",
      "server/modules/channels/variant-availability-sync.repository.ts",
      "server/modules/channels/channels.routes.ts",
      "server/modules/channels/adapters/shopify.adapter.ts",
      "server/modules/channels/adapters/ebay.adapter.ts",
      "server/modules/channels/adapters/ebay/ebay-marketplace-registration-owner.pg-repository.ts",
      "server/modules/dropship/infrastructure/dropship-order-acceptance.repository.ts",
      "server/modules/dropship/infrastructure/dropship-atp.provider.ts",
      "server/modules/dropship/application/dropship-selection-atp-service.ts",
      "server/routes/ebay/ebay-listings.routes.ts",
      "server/routes/ebay/ebay-sync-helpers.ts",
      "server/routes/ebay-settings.routes.ts",
      "server/routes/shopify.routes.ts",
      "server/modules/catalog/catalog.routes.ts",
      "server/services/index.ts",
      "client/src/lib/inventory-availability.ts",
      "client/src/pages/ProductDetail.tsx",
      "client/src/pages/Reserves.tsx",
      "client/src/pages/ChannelAllocation.tsx",
      "client/src/pages/BuildRecipeCreate.tsx",
      "client/src/pages/Inventory.tsx",
    ];
    const forbiddenDraftDependencies = [
      "inventory-availability-master-data",
      "inventory-availability-admin",
      "locationPromisePolicyHeads",
      "locationPromisePolicyVersions",
      "promiseSafetyPolicyHeads",
      "promiseSafetyPolicyVersions",
      "transformationModelHeads",
      "transformationModelPaths",
      "transformationModelVersions",
      "transformationRecipeBindings",
    ];

    for (const runtimeConsumer of runtimeConsumers) {
      const runtimeSource = source(runtimeConsumer);
      for (const dependency of forbiddenDraftDependencies) {
        expect(runtimeSource, `${runtimeConsumer} must not consume ${dependency}`)
          .not.toContain(dependency);
      }
    }
  });
});
