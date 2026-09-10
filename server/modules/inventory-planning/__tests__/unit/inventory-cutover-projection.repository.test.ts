import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectInventoryCutoverStateInsideTransaction } from "../../infrastructure/inventory-cutover-projection.repository";
import type { InventoryCutoverManifest } from "@shared/types/inventory-cutover-commit";

const ports = vi.hoisted(() => ({ reconstruct: vi.fn(), captureClaims: vi.fn(), planClaims: vi.fn(), opening: vi.fn() }));
vi.mock("../../infrastructure/inventory-cutover-opening.reader", () => ({ loadLatestCutoverOpening: ports.opening }));
// This suite tests orchestration and blocker propagation. Projection arithmetic
// and sealed DTO validation have dedicated unit and real-PostgreSQL coverage.
vi.mock("../../domain/inventory-opening-supply-projection", () => ({
  projectVerifiedOpeningClaimSupply: (snapshot: unknown) => snapshot,
  projectVerifiedOpeningSupply: (snapshot: unknown) => snapshot,
}));
vi.mock("../../infrastructure/inventory-cutover-reconstruction.repository", () => ({
  PostgresInventoryCutoverReconstructionRepository: class { preview = ports.reconstruct; },
}));
vi.mock("../../infrastructure/inventory-availability-shadow.repository", () => ({
  captureProposedClaimSupplySnapshotInsideTransaction: ports.captureClaims,
  captureProposedSupplySnapshotInsideTransaction: vi.fn(),
}));
vi.mock("../../domain/inventory-cutover-reconstruction-planning", () => ({ planFreshCutoverClaims: ports.planClaims }));

const manifest: InventoryCutoverManifest = { contractVersion: "inventory_cutover_selection_manifest_v1",
  productIds: [], publicationTargetIds: [], selections: [] };

beforeEach(() => {
  vi.resetAllMocks();
  ports.reconstruct.mockResolvedValue({ ready: true, evidenceHash: "a".repeat(64), blockers: [],
    openingBalance: { snapshotId: "1" },
    orders: [{ lines: [{ targetVariantId: 101 }] }] });
  ports.opening.mockResolvedValue({ saved: { id: "1" }, verification: { contractVersion: "inventory_cutover_opening_v1" } });
  ports.captureClaims.mockResolvedValue({ transformationModels: [], locations: [], safetyPolicies: [] });
  ports.planClaims.mockReturnValue({ impactHash: "b".repeat(64), freshReservationsByLevel: [] });
});

describe("post-reconstruction cutover projection", () => {
  it("requires the exact verified opening before a review can be ready", async () => {
    ports.opening.mockResolvedValue(null);
    const result = await projectInventoryCutoverStateInsideTransaction({} as never, manifest, "1", "1");
    expect(result.blockers).toContainEqual(expect.objectContaining({ code: "QUANTITY_VERIFIED_OPENING_REQUIRED" }));
  });
  it("checks demand-only graph definitions even without a publication product", async () => {
    ports.captureClaims.mockResolvedValue({
      transformationModels: [{ productId: 10, modelId: 90, definitionHash: "c".repeat(64) }],
      locations: [{ id: 7, promisePolicy: { policyId: 30, definitionHash: "d".repeat(64) } }],
      safetyPolicies: [{ scopeKey: "business", policyId: 40, definitionHash: "e".repeat(64) }],
    });
    const result = await projectInventoryCutoverStateInsideTransaction({} as never, manifest, "1", "1");
    expect(result.blockers.map((row) => row.subject)).toEqual(["model:10", "location_policy:7", "safety_policy:business"]);
    expect(result.blockers.every((row) => row.code === "CUTOVER_UNREVIEWED_DEFINITION")).toBe(true);
  });

  it("returns planner blockers as review findings instead of a generic server failure", async () => {
    ports.planClaims.mockImplementation(() => { throw Object.assign(new Error("Canonical planner blocked cutover demand."), {
      code: "CUTOVER_FRESH_DEMAND_BLOCKED",
    }); });
    const result = await projectInventoryCutoverStateInsideTransaction({} as never, manifest, "1", "1");
    expect(result.blockers).toEqual([{ code: "CUTOVER_FRESH_DEMAND_BLOCKED", subject: "accepted_demand",
      message: "Canonical planner blocked cutover demand." }]);
    expect(result.impactHash).not.toBe("b".repeat(64));
  });

  it("reports the bounded census explicitly without truncating or planning a subset", async () => {
    ports.captureClaims.mockRejectedValue(Object.assign(new Error("Claim simulation requires between 1 and 500 unique target variants."), {
      code: "INVALID_CLAIM_TARGETS",
    }));
    const result = await projectInventoryCutoverStateInsideTransaction({} as never, manifest, "1", "1");
    expect(result.blockers[0].code).toBe("CUTOVER_DEMAND_CENSUS_LIMIT");
    expect(ports.planClaims).not.toHaveBeenCalled();
  });

  it("does not disguise a database failure as a planner finding", async () => {
    const failure = Object.assign(new Error("snapshot connection failed"), { code: "08006" });
    ports.captureClaims.mockRejectedValue(failure);
    await expect(projectInventoryCutoverStateInsideTransaction({} as never, manifest, "1", "1")).rejects.toBe(failure);
  });

  it("retains reconstruction blockers and does not attempt a fresh promise", async () => {
    ports.reconstruct.mockResolvedValue({ ready: false, evidenceHash: "a".repeat(64), orders: [],
      blockers: [{ code: "CUSTODY_AMBIGUOUS", subject: "order:1", message: "Original custody cannot be proven." }] });
    const result = await projectInventoryCutoverStateInsideTransaction({} as never, manifest, "1", "1");
    expect(result.blockers[0].code).toBe("CUSTODY_AMBIGUOUS");
    expect(ports.captureClaims).not.toHaveBeenCalled();
    expect(ports.planClaims).not.toHaveBeenCalled();
  });
});
