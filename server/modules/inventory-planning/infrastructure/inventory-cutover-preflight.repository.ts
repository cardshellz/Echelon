import type { Pool } from "pg";
import { z } from "zod";
import { pool } from "../../../db";
import { readWmsCutoverDemand } from "../../wms/inventory-cutover-demand-reader";
import { captureInventoryCutoverEncumbranceInsideTransaction } from "../../inventory/infrastructure/inventory-cutover-encumbrance.repository";
import { inventoryCutoverVariantSchema } from "@shared/types/inventory-cutover-preflight";
import { plannerPositiveQuantitySchema } from "@shared/types/inventory-availability-planner";
import type { InventoryCutoverPreflightStore } from "../application/inventory-cutover-preflight.service";
import type { InventoryCutoverPreflightFacts } from "../domain/inventory-cutover-preflight";

const MAX_VARIANT_MATCHES = 50_000;
const authoritySchema = z.object({
  authority: z.enum(["legacy", "canonical"]), revision: plannerPositiveQuantitySchema,
}).strict();

/** All owner interfaces read one database snapshot. No writes, row locks or provider calls. */
export class PostgresInventoryCutoverPreflightRepository implements InventoryCutoverPreflightStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  async capture(): Promise<InventoryCutoverPreflightFacts> {
    const client = await this.connectionPool.connect();
    let began = false;
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      began = true;
      await client.query("SET LOCAL statement_timeout = '30s'");
      const authorityRows = (await client.query(
        `SELECT authority, revision::text AS revision FROM inventory.availability_runtime_authority WHERE singleton_key = true`,
      )).rows;
      const authorities = z.array(authoritySchema).max(1).parse(authorityRows);
      const authority = authorities[0] ?? null;
      const demand = await readWmsCutoverDemand(client);
      const encumbrance = await captureInventoryCutoverEncumbranceInsideTransaction(client);
      const skus = [...new Set(demand.items.filter((item) => item.requiresShipping !== 0).map((item) => item.sku.toUpperCase()))].sort();
      const variantRows = skus.length === 0 ? [] : (await client.query(
        `SELECT id, product_id AS "productId", sku, is_active AS "isActive",
                requires_shipping AS "requiresShipping", COALESCE(track_inventory, true) AS "trackInventory",
                sales_eligibility AS "salesEligibility"
         FROM catalog.product_variants WHERE upper(sku) = ANY($1::text[]) ORDER BY id LIMIT $2`,
        [skus, MAX_VARIANT_MATCHES + 1],
      )).rows;
      const variants = z.array(inventoryCutoverVariantSchema).max(MAX_VARIANT_MATCHES).parse(variantRows);
      const result: InventoryCutoverPreflightFacts = {
        capturedAt: demand.capturedAt, runtimeAuthority: authority?.authority ?? null,
        authorityRevision: authority?.revision ?? null, demand, encumbrance, variants,
      };
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (!began) {
        // BEGIN may have reached PostgreSQL even when its acknowledgement failed.
        // Do not return an acquired session with an unproven transaction state.
        releaseError = error instanceof Error ? error : new Error("Cutover snapshot start failed.", { cause: error });
      }
      if (began) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error("Cutover snapshot rollback failed.");
          throw new AggregateError([error, rollbackError], "Cutover evidence capture and rollback failed.");
        }
      }
      throw error;
    } finally {
      // Destroy an uncertain BEGIN/rollback session instead of returning it to the pool.
      client.release(releaseError);
    }
  }
}
