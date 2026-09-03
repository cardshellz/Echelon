import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

function methodBody(file: string, start: string, end: string): string {
  const startIndex = file.indexOf(start);
  const endIndex = file.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return file.slice(startIndex, endIndex);
}

describe("canonical cycle-count reconciliation source contract", () => {
  it("keeps approval callers behind the authority boundary", () => {
    const cycleCount = source("server/modules/inventory/application/cycle-count.use-cases.ts");
    const approval = methodBody(cycleCount, "private async approveItemCore(", "private async firePostApprovalSideEffects(");

    expect(approval).toContain("this.reservation.reconcileCycleCountInventory");
    expect(approval).not.toContain("adjustInventory(");
    expect(approval).not.toContain("reallocateOrphaned(");
    const recordCount = methodBody(cycleCount, "async recordCount(", "async resetItem(");
    expect(recordCount).toContain("await this.approveItemCore(");
  });

  it("locks selected owners before sorted inventory resources and mutates only afterward", () => {
    const repository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts",
    );
    const reconciliation = methodBody(repository, "async reconcileCycleCount(", "async pickClaimLine(");
    const selectedClaimLock = reconciliation.indexOf("loadActiveClaimById(client, owner.claimId, true)");
    const resourceLock = reconciliation.indexOf("await lockSnapshotResources(client, preliminarySnapshot)");
    const levelVerification = reconciliation.lastIndexOf("const lockedLevel = rows(await client.query(");
    const claimRelease = reconciliation.indexOf("await releaseClaimResources(client, {");
    const physicalAdjustment = reconciliation.lastIndexOf("await this.inventoryWriter.applyCycleCountAdjustment({");
    const replan = reconciliation.indexOf("const plan = planCanonicalClaim(snapshot, request)");
    const approval = reconciliation.lastIndexOf("return approveAndCommit(");
    const approvalHelper = methodBody(reconciliation, "const approveAndCommit = async (", "if (levelRow == null)");

    expect(reconciliation).toContain("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(selectedClaimLock).toBeGreaterThanOrEqual(0);
    expect(selectedClaimLock).toBeLessThan(resourceLock);
    expect(resourceLock).toBeLessThan(levelVerification);
    expect(levelVerification).toBeLessThan(claimRelease);
    expect(claimRelease).toBeLessThan(physicalAdjustment);
    expect(physicalAdjustment).toBeLessThan(replan);
    expect(replan).toBeLessThan(approval);
    expect(approvalHelper.indexOf("await this.inventoryWriter.approveCycleCountItem({"))
      .toBeLessThan(approvalHelper.indexOf('await client.query("COMMIT")'));
    expect(reconciliation).toContain("loadOpenClaimsAtLevel(client, inventoryLevelId, false)");
    expect(reconciliation).not.toContain("loadOpenClaimsAtLevel(client, inventoryLevelId, true)");
  });

  it("derives exact open ownership and deterministically displaces newest claims first", () => {
    const repository = source(
      "server/modules/inventory-planning/infrastructure/inventory-availability-claim.repository.ts",
    );
    const selection = methodBody(
      repository,
      "export function selectCycleCountDisplacedClaims(",
      "async function loadOpenClaimsAtLevel(",
    );

    expect(repository).toContain("resource.claimed_qty - resource.released_qty");
    expect(repository).toContain("- resource.consumed_qty - resource.picked_qty AS open_qty");
    expect(selection).toContain("totalClaimed !== BigInt(reservedQty)");
    expect(selection).toContain("left.claimId > right.claimId ? -1");
    expect(selection).toContain("MAX_CYCLE_COUNT_DISPLACED_CLAIMS");
  });
});
