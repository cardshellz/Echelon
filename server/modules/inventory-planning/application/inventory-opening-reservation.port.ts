import type { PoolClient } from "pg";
import type { CutoverReconstructionCommit, OpeningReservationRebase } from "@shared/types/inventory-cutover-reconstruction";

/** Inventory owns counter mutation; planning supplies the reviewed immutable proof. */
export interface InventoryOpeningReservationPort {
  translate(input: { client: PoolClient; command: CutoverReconstructionCommit; snapshotId: string;
    sourceEvidenceHash: string; rebases: readonly OpeningReservationRebase[] }): Promise<number[]>;
}
