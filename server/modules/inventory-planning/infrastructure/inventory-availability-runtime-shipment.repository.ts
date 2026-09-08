import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { InventoryUseCases } from "../../inventory/application/inventory.use-cases";
import type { CanonicalClaimDispatchSourceCommandResolver } from "../application/inventory-availability-dispatch-source-command.port";
import {
  AuthorityAwareInventoryShipmentRecorder,
  type InventoryShipmentRuntimeContext,
  type InventoryShipmentRuntimeExecutor,
} from "../application/inventory-availability-runtime-shipment.service";
import type { PostgresCanonicalClaimDispatchRepository } from "./inventory-availability-dispatch.repository";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";

/**
 * Legacy authority and every legacy debit share one connection/transaction.
 * Canonical routing releases this connection before entering the dispatcher's
 * SERIALIZABLE transaction: migration0638 forbids canonical -> legacy. The
 * dispatcher checks authority again and never falls back on a canonical error.
 */
export class PostgresInventoryShipmentRuntimeExecutor implements InventoryShipmentRuntimeExecutor {
  constructor(
    private readonly connectionPool: Pick<Pool, "connect">,
    private readonly legacyOwner: Pick<InventoryUseCases, "recordShipmentInsideTransaction">,
    private readonly dispatcher: Pick<PostgresCanonicalClaimDispatchRepository, "dispatchPrepared">,
    private readonly sourceCommands: CanonicalClaimDispatchSourceCommandResolver,
  ) {}

  async execute<T>(work: (context: InventoryShipmentRuntimeContext) => Promise<T>): Promise<T> {
    const client = await this.connectionPool.connect();
    let began = false;
    let released = false;
    let releaseError: Error | undefined = new Error("Shipment routing BEGIN did not complete.");
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      began = true;
      releaseError = undefined;
      const authority = await loadAndLockRuntimeAuthority(client);
      if (authority.authority === "canonical") {
        await client.query("COMMIT");
        began = false;
        released = true;
        client.release();
        return await work({
          authority: "canonical",
          dispatchSource: async (request) => {
            await this.dispatcher.dispatchPrepared((transactionClient: PoolClient) =>
              this.sourceCommands.resolve(transactionClient, request));
          },
        });
      }
      const transactionDb = drizzle(client, { schema });
      const result = await work({
        authority: "legacy",
        recordLegacy: (input) => this.legacyOwner.recordShipmentInsideTransaction(input, transactionDb),
      });
      await client.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began) {
        try { await client.query("ROLLBACK"); }
        catch (rollbackError) {
          releaseError = rollbackError instanceof Error ? rollbackError : new Error("Shipment routing rollback failed.");
          throw new AggregateError([error, rollbackError], "Shipment routing and rollback both failed.");
        }
      }
      throw error;
    } finally {
      if (!released) client.release(releaseError);
    }
  }
}

export function createAuthorityAwareInventoryShipmentRecorder(input: {
  connectionPool: Pick<Pool, "connect">;
  legacyOwner: Pick<InventoryUseCases, "recordShipmentInsideTransaction">;
  dispatcher: Pick<PostgresCanonicalClaimDispatchRepository, "dispatchPrepared">;
  sourceCommands: CanonicalClaimDispatchSourceCommandResolver;
}): AuthorityAwareInventoryShipmentRecorder {
  return new AuthorityAwareInventoryShipmentRecorder(new PostgresInventoryShipmentRuntimeExecutor(
    input.connectionPool, input.legacyOwner, input.dispatcher, input.sourceCommands,
  ));
}
