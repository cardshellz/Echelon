import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import * as schema from "@shared/schema";

import { pool as defaultPool } from "../../../db";
import { createLegacyInventoryAtpService } from "../../inventory/atp.service";
import {
  AuthorityAwareInventoryAtpService,
  InventoryAvailabilityRuntimeAtpError,
  type InventoryAvailabilityRuntimeAtpContext,
  type InventoryAvailabilityRuntimeAtpExecutor,
  type InventoryAvailabilityRuntimeAtpLogger,
} from "../application/inventory-availability-runtime-atp.service";
import { captureActiveSupplySnapshotInsideTransaction } from "./inventory-availability-shadow.repository";

type ClientPool = Pick<Pool, "connect">;

interface RuntimeAuthorityRow {
  authority: string;
  authority_revision: string;
  activation_run_id: string | null;
}

/**
 * Pins the singleton authority row with a shared lock until the selected ATP
 * read completes. The activation transaction therefore cannot switch to
 * canonical while an already-authorized legacy read is still in flight.
 */
export class PostgresInventoryAvailabilityRuntimeAtpExecutor
implements InventoryAvailabilityRuntimeAtpExecutor {
  constructor(private readonly connectionPool: ClientPool = defaultPool) {}

  async execute<T>(
    work: (context: InventoryAvailabilityRuntimeAtpContext) => Promise<T>,
  ): Promise<T> {
    const client = await this.connectionPool.connect();
    let began = false;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      began = true;
      const authority = await loadAndLockRuntimeAuthority(client);
      const transactionDb = drizzle(client, { schema });
      const legacy = createLegacyInventoryAtpService(transactionDb);
      const result = await work({
        authority: authority.authority,
        authorityRevision: authority.authorityRevision,
        activationRunId: authority.activationRunId,
        legacy,
        captureActiveSupplySnapshot: (productId) =>
          captureActiveSupplySnapshotInsideTransaction(client, productId),
        getProductIdsByVariantIds: (variantIds) =>
          getProductIdsByVariantIds(client, variantIds),
      });
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Inventory ATP runtime read and rollback both failed.",
          );
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createAuthorityAwareInventoryAtpService(
  connectionPool: ClientPool = defaultPool,
  logger?: InventoryAvailabilityRuntimeAtpLogger,
): AuthorityAwareInventoryAtpService {
  return new AuthorityAwareInventoryAtpService(
    new PostgresInventoryAvailabilityRuntimeAtpExecutor(connectionPool),
    logger,
  );
}

async function loadAndLockRuntimeAuthority(client: PoolClient): Promise<{
  authority: "legacy" | "canonical";
  authorityRevision: string;
  activationRunId: string | null;
}> {
  const result = await client.query<RuntimeAuthorityRow>(
    `SELECT authority,
            revision::text AS authority_revision,
            activation_run_id::text AS activation_run_id
     FROM inventory.availability_runtime_authority
     WHERE singleton_key = true
     FOR SHARE`,
  );
  const row = result.rows[0];
  if (!row || (row.authority !== "legacy" && row.authority !== "canonical")) {
    throw new InventoryAvailabilityRuntimeAtpError(
      "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
      "The inventory ATP runtime authority singleton is missing or invalid.",
      { authority: row?.authority ?? null },
    );
  }
  if (!/^[1-9][0-9]*$/.test(String(row.authority_revision))) {
    throw new InventoryAvailabilityRuntimeAtpError(
      "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
      "The inventory ATP runtime authority revision is invalid.",
      { authority: row.authority, authorityRevision: row.authority_revision },
    );
  }
  const activationRunId = row.activation_run_id == null ? null : String(row.activation_run_id);
  if ((row.authority === "legacy" && activationRunId !== null)
    || (row.authority === "canonical" && (activationRunId === null || !/^[1-9][0-9]*$/.test(activationRunId)))) {
    throw new InventoryAvailabilityRuntimeAtpError(
      "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
      "The inventory ATP runtime authority activation lineage is invalid.",
      { authority: row.authority, activationRunId },
    );
  }
  return {
    authority: row.authority,
    authorityRevision: String(row.authority_revision),
    activationRunId,
  };
}

async function getProductIdsByVariantIds(
  client: PoolClient,
  variantIds: readonly number[],
): Promise<Map<number, number>> {
  if (variantIds.length === 0) return new Map();
  const result = await client.query<{ id: number; product_id: number }>(
    `SELECT id, product_id
     FROM catalog.product_variants
     WHERE id = ANY($1::integer[])
     ORDER BY id`,
    [variantIds],
  );
  return new Map(result.rows.map((row) => [Number(row.id), Number(row.product_id)] as const));
}
