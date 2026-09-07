import type { Pool } from "pg";
import type { AssemblyWorkService } from "./assembly-work.service";
import { readOrderPackingSources } from "../../../wms/packing-source-reader";
import { readObservedPackagesForSources } from "../../../shipping/package-allocation-ledger.repository";
import { buildAssemblyPackageReview } from "../domain/assembly-package-review";
import { WarehouseWorkError } from "../domain/work-configuration";

export class AssemblyPackageReviewService {
  constructor(private readonly work: Pick<AssemblyWorkService, "get">, private readonly pool: Pick<Pool, "connect">) {}

  async review(actorId: string, taskId: unknown) {
    // Existing owner enforces active identity, assembly permission, and warehouse/station scope.
    // Complete authorization before accessing provider evidence, including empty results.
    const task = await this.work.get(actorId, taskId);
    if (task.assignedTo !== actorId) throw new WarehouseWorkError("WORK_PACKAGE_REVIEW_NOT_ASSIGNED", "The assigned assembler must review this package", 403);
    const client = await this.pool.connect();
    let discard: Error | undefined;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      const sources = await readOrderPackingSources(client, task.orderId, task.warehouseId);
      const packages = await readObservedPackagesForSources(client, sources.map((source) => source.id));
      const result = buildAssemblyPackageReview({ taskId: task.id, orderId: task.orderId, warehouseId: task.warehouseId, sources, packages });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) {
        discard = new AggregateError([error, rollbackError], "Package evidence read rollback failed");
        throw discard;
      }
      throw error;
    } finally { client.release(discard); }
  }
}
