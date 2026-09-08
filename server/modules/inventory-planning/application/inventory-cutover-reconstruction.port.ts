import type { PoolClient } from "pg";
import type { CutoverReconstructionCommit, CutoverReconstructionEvidence, CutoverReconstructionPlan,
  CutoverReconstructionReceipt } from "@shared/types/inventory-cutover-reconstruction";

export interface InventoryCutoverReconstructionStore {
  capture(client: PoolClient): Promise<CutoverReconstructionEvidence>;
  preview(client: PoolClient): Promise<CutoverReconstructionPlan>;
  persistReviewed(client: PoolClient, command: CutoverReconstructionCommit,
    expectedImpactHash: string): Promise<CutoverReconstructionReceipt>;
}
