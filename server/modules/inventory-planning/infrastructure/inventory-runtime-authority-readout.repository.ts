import type { Pool } from "pg";
import { pool } from "../../../db";
import type { InventoryRuntimeAuthorityReadoutStore } from "../application/inventory-runtime-authority-readout.service";
import {
  InventoryRuntimeAuthorityReadoutError,
  type InventoryRuntimeAuthorityRecord,
} from "../domain/inventory-runtime-authority-readout";

interface RuntimeAuthorityRow {
  authority: unknown;
  revision: unknown;
  activation_run_id: unknown;
  changed_by: unknown;
  change_reason: unknown;
  changed_at: unknown;
}

/**
 * Read-only view of the runtime authority singleton for operator screens.
 * Deliberately lock-free: a display read must never queue behind a cutover
 * commit, and the revision in the readout tells the operator exactly which
 * decision they saw. Mutating paths keep using their own FOR SHARE readers.
 */
export class PostgresInventoryRuntimeAuthorityReadoutRepository implements InventoryRuntimeAuthorityReadoutStore {
  constructor(private readonly connectionPool: Pick<Pool, "query"> = pool) {}

  async read(): Promise<InventoryRuntimeAuthorityRecord[]> {
    let rows: RuntimeAuthorityRow[];
    try {
      const result = await this.connectionPool.query<RuntimeAuthorityRow>(
        `SELECT authority, revision::text AS revision, activation_run_id::text AS activation_run_id,
                changed_by, change_reason, changed_at
         FROM inventory.availability_runtime_authority
         WHERE singleton_key = true`,
      );
      rows = result.rows;
    } catch (error) {
      throw new InventoryRuntimeAuthorityReadoutError(
        503,
        "INVENTORY_RUNTIME_AUTHORITY_READ_FAILED",
        "The inventory runtime authority could not be read.",
        "transient",
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    return rows.map((row) => ({
      authority: row.authority,
      revision: row.revision,
      activationRunId: row.activation_run_id,
      changedBy: row.changed_by,
      changeReason: row.change_reason,
      // pg hands TIMESTAMPTZ back as a Date; the contract carries ISO-8601 text.
      changedAt: row.changed_at instanceof Date ? row.changed_at.toISOString() : row.changed_at,
    }));
  }
}
