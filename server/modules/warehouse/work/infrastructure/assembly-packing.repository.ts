import type { PoolClient } from "pg";
import { assemblyPackingReceiptSchema, type AssemblyPackingReceipt } from "@shared/warehouse-assembly-packing";
import { WarehouseWorkError } from "../domain/work-configuration";

export class AssemblyPackingRepository {
  async replay(client: PoolClient, commandId: string, requestHash: string): Promise<AssemblyPackingReceipt | null> {
    const result = await client.query<{ request_hash: string; receipt: unknown }>(
      "SELECT request_hash, receipt FROM warehouse.assembly_packing_handoff_receipts WHERE command_id=$1", [commandId]);
    if (!result.rows[0]) return null;
    if (result.rows[0].request_hash !== requestHash) throw new WarehouseWorkError("WORK_COMMAND_REUSED", "Command ID belongs to another actor, job, or request", 409);
    return assemblyPackingReceiptSchema.parse(result.rows[0].receipt);
  }
  async insert(client: PoolClient, input: { receipt: AssemblyPackingReceipt; requestHash: string; reason: string; beforeStatus: string }): Promise<void> {
    const receipt = assemblyPackingReceiptSchema.parse(input.receipt);
    await client.query(`INSERT INTO warehouse.assembly_packing_handoff_receipts
      (command_id, work_item_id, order_id, actor_id, request_hash, reason, before_status, receipt, occurred_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
    [receipt.commandId, receipt.taskId, receipt.orderId, receipt.actorId, input.requestHash, input.reason,
      input.beforeStatus, JSON.stringify(receipt), receipt.readyAt]);
  }
}
