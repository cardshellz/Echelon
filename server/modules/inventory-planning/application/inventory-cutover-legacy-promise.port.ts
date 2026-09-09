import type { PoolClient } from "pg";
import type { CutoverLegacyPromiseRelease, CutoverReconstructionCommit } from "@shared/types/inventory-cutover-reconstruction";

/** Inventory owns counter/journal writes; the admitted caller owns all-or-nothing
 * demand replanning, receipt replay, and the transaction. No physical release. */
export interface InventoryCutoverLegacyPromisePort {
  releaseForReplanning(input: {
    client: PoolClient;
    command: CutoverReconstructionCommit;
    releases: readonly CutoverLegacyPromiseRelease[];
  }): Promise<number[]>;
}
