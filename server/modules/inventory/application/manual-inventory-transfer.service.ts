import { sql } from "drizzle-orm";
import { z } from "zod";
import { inventoryTransferRequestSchema } from "@shared/types/inventory-transfer";
import { AppError, IntegrityError } from "@shared/errors";
import { createDrizzleFinancialCommandRepository } from "../../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../../platform/commands/http-command";
import { runTransactionalFinancialCommand } from "../../../platform/commands/transactional-command.service";
import type { db } from "../../../db";
import type { InventoryUseCases } from "./inventory.use-cases";

type Database = Pick<typeof db, "transaction" | "execute">;
type TransferFollowup = {
  transferId: number;
  productVariantId: number;
  fromLocationId: number;
  actor: string;
};
const transferResultSchema = z.object({
  reservedMoved: z.number().int().nonnegative(),
  orderItemsRepointed: z.number().int().nonnegative(),
  transferReceiptId: z.number().int().positive(),
});

/** The quantity owner commits the move; this application owner records and resumes the required follow-up. */
export class ManualInventoryTransferService {
  constructor(
    private readonly database: Database,
    private readonly inventory: InventoryUseCases,
    private readonly effects: {
      deliver(transfer: TransferFollowup): Promise<void>;
    },
    private readonly clock: () => Date,
  ) {}

  async transfer(rawInput: unknown, actor: string) {
    const input = inventoryTransferRequestSchema.parse(rawInput);
    z.string().trim().min(1).max(100).parse(actor);
    const commandKey = z
      .string()
      .trim()
      .min(1)
      .max(120)
      .parse(input.commandKey);
    const occurredAt = z.date().parse(this.clock());
    const routeTemplate = "/api/inventory/transfer";
    const resourceKey = `inventory.variant:${input.variantId}`;
    const command = await runTransactionalFinancialCommand({
      repository: createDrizzleFinancialCommandRepository(this.database),
      descriptor: {
        actorType: "user",
        actorId: actor,
        method: "POST",
        routeTemplate,
        resourceKey,
        idempotencyKey: commandKey,
        commandName: "inventory.transfer",
        contractVersion: 1,
        requestHash: hashHttpFinancialCommand({
          method: "POST",
          routeTemplate,
          resourceKey,
          body: input,
        }),
      },
      work: async (tx) => {
        const result = await this.inventory.withTx(tx).transfer({
          productVariantId: input.variantId,
          fromLocationId: input.fromLocationId,
          toLocationId: input.toLocationId,
          qty: input.quantity,
          commandKey: input.commandKey,
          userId: actor,
          notes: input.notes,
          moveReserved: input.moveReserved,
          crossWarehouseArrivalConfirmed: input.crossWarehouseArrivalConfirmed,
          deferUntilCommit: () => {
            /* The receipt outbox below owns publication and task credit. */
          },
        });
        if (!result.transferReceiptId)
          throw new IntegrityError(
            "The transfer command has no replayable physical receipt",
            { commandKey: input.commandKey },
          );
        await tx.execute(sql`INSERT INTO inventory.transfer_followups(transfer_id,actor,created_at)
        VALUES (${result.transferReceiptId},${actor},${occurredAt}) ON CONFLICT(transfer_id) DO NOTHING`);
        return {
          httpStatus: 200,
          body: transferResultSchema.parse(result),
          resultType: "inventory_transfer",
          resultId: result.transferReceiptId,
        };
      },
      classifyFailure: (error) =>
        error instanceof AppError
          ? {
              kind: "rejected",
              httpStatus: error.statusCode,
              errorCode: error.code,
              errorMessage: error.message,
              body: {
                error: error.message,
                code: error.code,
                context: error.context,
              },
            }
          : {
              kind: "retryable",
              errorCode: "INVENTORY_TRANSFER_FAILED",
              errorMessage:
                error instanceof Error ? error.message : String(error),
            },
    });
    if (command.terminalState === "rejected") {
      const rejection = z
        .object({
          error: z.string(),
          code: z.string(),
          context: z.record(z.unknown()).optional(),
        })
        .parse(command.body);
      throw new AppError(
        rejection.error,
        rejection.code,
        command.httpStatus,
        rejection.context,
      );
    }
    const result = transferResultSchema.parse(command.body);
    const delivered = await this.recover(result.transferReceiptId);
    return { success: true as const, ...result, followupPending: !delivered };
  }

  async recoverPending(): Promise<void> {
    const result = await this.database
      .execute(sql`SELECT transfer_id FROM inventory.transfer_followups
      WHERE completed_at IS NULL ORDER BY created_at,transfer_id LIMIT 20`);
    for (const row of result.rows)
      await this.recover(z.number().int().positive().parse(row.transfer_id));
  }

  async recover(transferId: number): Promise<boolean> {
    try {
      const result = await this.database
        .execute(sql`SELECT f.actor,f.completed_at,t.product_variant_id,t.from_location_id,t.voided_at
        FROM inventory.transfer_followups f JOIN inventory.inventory_transactions t ON t.id=f.transfer_id WHERE f.transfer_id=${transferId}`);
      if (!result.rows[0])
        throw new IntegrityError("Transfer follow-up intent is missing", {
          transferId,
        });
      const row = result.rows[0];
      if (row.completed_at) return true;
      if (row.voided_at)
        throw new IntegrityError(
          "A voided transfer requires review before follow-up",
          { transferId },
        );
      await this.effects.deliver({
        transferId,
        productVariantId: z
          .number()
          .int()
          .positive()
          .parse(row.product_variant_id),
        fromLocationId: z.number().int().positive().parse(row.from_location_id),
        actor: z.string().min(1).parse(row.actor),
      });
      return this.database.transaction(async (tx) => {
        const current =
          await tx.execute(sql`SELECT f.completed_at,t.voided_at FROM inventory.transfer_followups f
          JOIN inventory.inventory_transactions t ON t.id=f.transfer_id WHERE f.transfer_id=${transferId} FOR UPDATE OF f`);
        if (!current.rows[0] || current.rows[0].voided_at)
          throw new IntegrityError(
            "Transfer evidence changed before follow-up completed",
            { transferId },
          );
        if (!current.rows[0].completed_at)
          await tx.execute(
            sql`UPDATE inventory.transfer_followups SET completed_at=${z.date().parse(this.clock())},last_error=NULL WHERE transfer_id=${transferId}`,
          );
        return true;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.execute(
        sql`UPDATE inventory.transfer_followups SET last_error=${message.slice(0, 2000)} WHERE transfer_id=${transferId} AND completed_at IS NULL`,
      );
      console.error(
        JSON.stringify({
          event: "inventory_transfer_followup_pending",
          transferId,
          message,
        }),
      );
      return false;
    }
  }
}
