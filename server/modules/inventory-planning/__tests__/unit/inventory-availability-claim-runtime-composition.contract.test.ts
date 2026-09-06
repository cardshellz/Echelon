import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("canonical claim runtime composition", () => {
  it("constructs the complete claim dependency graph once in the service container", () => {
    const services = source("server/services/index.ts");

    expect(services).toContain(
      "const canonicalClaimInventory = new PostgresCanonicalClaimInventoryRepository()",
    );
    expect(services).toContain(
      "new PostgresCanonicalClaimBuildRepository(canonicalClaimInventory)",
    );
    expect(services).toContain(
      "new PostgresCanonicalClaimPickerObservationReviewRepository()",
    );
    expect(services).toMatch(
      /new PostgresInventoryAvailabilityClaimRepository\(\s*canonicalClaimInventory,\s*databasePool,\s*systemCanonicalClaimClock,\s*canonicalClaimBuild,\s*canonicalClaimObservationReview,\s*assemblyWorkOwner,\s*\)/,
    );
    expect(services).toContain(
      "const inventoryAvailabilityClaims = new InventoryAvailabilityClaimService(",
    );
    expect(services).toContain("inventoryAvailabilityClaims,");
    expect(services.match(/new AssemblyWorkOwner\(/g)).toHaveLength(1);
    expect(services).toContain("new AssemblyWorkService(assemblyWorkOwner, systemCanonicalClaimClock, inventoryAvailabilityClaims)");
  });

  it("exposes only guarded assembly commands, not raw claim routes or runtime authority changes", () => {
    const routeRegistry = source("server/routes.ts");
    const services = source("server/services/index.ts");

    expect(routeRegistry).not.toContain("inventoryAvailabilityClaims");
    expect(routeRegistry).not.toContain("registerInventoryAvailabilityClaimRoutes");
    expect(routeRegistry).toContain("registerAssemblyWorkRoutes(app)");
    expect(services).not.toMatch(/UPDATE\s+inventory\.availability_runtime_authority/i);
  });
});
