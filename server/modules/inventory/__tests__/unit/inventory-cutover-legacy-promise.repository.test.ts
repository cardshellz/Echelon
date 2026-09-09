import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import { PostgresInventoryCutoverLegacyPromiseRepository } from "../../infrastructure/inventory-cutover-legacy-promise.repository";
import { emptyBinPromiseEvidence } from "../../../inventory-planning/__tests__/fixtures/inventory-cutover-reconstruction.fixture";
import { planCutoverReconstruction } from "../../../inventory-planning/domain/inventory-cutover-reconstruction";
import { cutoverReconstructionReceiptSchema } from "@shared/types/inventory-cutover-reconstruction";

function handoff() {
  const plan = planCutoverReconstruction(emptyBinPromiseEvidence());
  return { command: { expectedEvidenceHash: plan.evidenceHash, activationRunId: "1", runtimeAuthorityRevision: "2",
    actor: "operator", reason: "Reviewed exact demand handoff", occurredAt: "2026-09-08T00:00:00.000Z" },
    releases: plan.legacyPromiseReleases };
}

describe("legacy promise owner input and audit receipt contracts", () => {
  it.each(["negative quantity", "incomplete owners", "duplicate owner", "duplicate level", "invalid evidence", "invalid clock"])(
    "rejects %s before any database call", async (kind) => {
      const input = handoff();
      if (kind === "negative quantity") input.releases[0].reservedQty = "-6";
      if (kind === "incomplete owners") input.releases[0].owners[0].reservedQty = "5";
      if (kind === "duplicate owner") input.releases[0].owners.push({ ...input.releases[0].owners[0] });
      if (kind === "duplicate level") input.releases.push(structuredClone(input.releases[0]));
      if (kind === "invalid evidence") input.command.expectedEvidenceHash = "not-a-hash";
      if (kind === "invalid clock") input.command.occurredAt = "not-a-time";
      const query = vi.fn();
      await expect(new PostgresInventoryCutoverLegacyPromiseRepository().releaseForReplanning({ ...input,
        client: { query } as unknown as PoolClient })).rejects.toMatchObject({ code: "CUTOVER_PROMISE_INPUT_INVALID" });
      expect(query).not.toHaveBeenCalled();
    });
  it("requires a valid exclusive-fence receipt before locking inventory", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ epoch: "0" }] });
    await expect(new PostgresInventoryCutoverLegacyPromiseRepository().releaseForReplanning({ ...handoff(),
      client: { query } as unknown as PoolClient })).rejects.toMatchObject({ code: "CUTOVER_PROMISE_FENCE_REQUIRED" });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("assert_cutover_admission_fence_owner");
  });
  it("retains PostgreSQL failure classification and cause without swallowing it", async () => {
    const cause = Object.assign(new Error("serialization failure"), { code: "40001" });
    const query = vi.fn().mockRejectedValue(cause);
    await expect(new PostgresInventoryCutoverLegacyPromiseRepository().releaseForReplanning({ ...handoff(),
      client: { query } as unknown as PoolClient })).rejects.toMatchObject({
      code: "CUTOVER_PROMISE_DATABASE_ERROR", context: { postgresCode: "40001" }, cause,
    });
  });
  it("requires exactly one distinct audit transaction for each handed-off owner", () => {
    const { command, releases } = handoff();
    const receipt = { evidenceHash: command.expectedEvidenceHash, claimIds: ["1"], orderIds: [1], retainedIndependentBuildReservationIds: [],
      legacyPromiseReleases: releases, legacyPromiseReleaseTransactionIds: [10] };
    expect(cutoverReconstructionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(cutoverReconstructionReceiptSchema.safeParse({ ...receipt, legacyPromiseReleaseTransactionIds: [] }).success).toBe(false);
    expect(cutoverReconstructionReceiptSchema.safeParse({ ...receipt, legacyPromiseReleaseTransactionIds: [10, 10] }).success).toBe(false);
    const { legacyPromiseReleaseTransactionIds: _ids, legacyPromiseReleases: _releases, ...oldReceipt } = receipt;
    expect(cutoverReconstructionReceiptSchema.parse(oldReceipt)).toEqual(oldReceipt);
  });
});
