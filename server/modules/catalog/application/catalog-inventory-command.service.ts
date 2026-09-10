import { createHash } from "node:crypto";
import { z } from "zod";
import type { QuantityCommand } from "../../inventory/domain/quantity-ledger";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identity = z.object({ id: z.number().int().positive(), sku: z.string().nullable(), name: z.string() });
const archiveCounts = {
  inventoryCleared: count, inventoryPreserved: count, inventoryTransferred: count,
  binAssignmentsCleared: count, channelFeedsDeactivated: count,
};
export const catalogInventoryResponseSchema = z.union([
  z.object({ success: z.literal(true), archived: z.object({ ...archiveCounts, product: identity,
    variants: count, replenDeactivated: count, replenTasksCancelled: count }) }),
  z.object({ success: z.literal(true), archived: z.object({ ...archiveCounts, variant: identity }) }),
  z.object({ ok: z.literal(true), movedInventoryCount: count, movedLocationCount: count, deactivatedVariantId: z.number().int().positive() }),
]);
const receiptSchema = z.object({ contractVersion: z.literal("catalog_inventory_v1"),
  sourceVariantIds: z.array(z.number().int().positive()), response: catalogInventoryResponseSchema });
const commandSchema = z.object({
  commandKey: z.string().min(1).max(120).refine(key => key.trim() === key).optional(),
  operation: z.enum(["product_archive", "variant_archive", "variant_merge"]),
  sourceId: z.number().int().positive(), targetVariantId: z.number().int().positive().nullable(),
  actor: z.string().trim().min(1),
}).strict();
export type CatalogInventoryCommand = z.infer<typeof commandSchema>;
export type CatalogInventoryResponse = z.infer<typeof catalogInventoryResponseSchema>;
export type CatalogInventorySnapshot = { source: z.infer<typeof identity>; sourceVariantIds: number[] };
type MetadataResult = { inventoryCleared: number; binAssignmentsCleared: number; channelFeedsDeactivated: number;
  replenDeactivated: number; replenTasksCancelled: number; movedLocationCount: number };

export class CatalogInventoryCommandError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 409) { super(message); }
}

export interface CatalogInventoryPosting {
  beginOperation(key: string | undefined, intent: Record<string, unknown>): Promise<{ result: Record<string, unknown> } | null>;
  post(command: Omit<QuantityCommand, "contractVersion" | "movements" | "reversesCommandId">): Promise<void>;
  finishOperation(result: Record<string, unknown>): Promise<void>;
  finishNoMovement(result: Record<string, unknown>): Promise<void>;
}

export interface CatalogInventoryUnitOfWork {
  posting: CatalogInventoryPosting | null;
  loadSource(command: CatalogInventoryCommand): Promise<CatalogInventorySnapshot>;
  lockQuantities(variantIds: number[]): Promise<Array<{ productVariantId: number; onHand: number; reserved: number; picked: number; packed: number }>>;
  convert(sourceId: number, targetId: number, childKey: string | undefined, actor: string,
    defer: (effect: () => Promise<void>) => void): Promise<{ totalConverted: number; conversions: Array<{ locationCode: string; qty: number }> }>;
  applyMetadata(command: CatalogInventoryCommand, sourceVariantIds: number[], now: Date): Promise<MetadataResult>;
  recordAudit(command: CatalogInventoryCommand, evidence: Record<string, unknown>, now: Date): Promise<void>;
}
export interface CatalogInventoryCommandRepository {
  transaction<T>(work: (unit: CatalogInventoryUnitOfWork) => Promise<T>): Promise<T>;
}

/** One user command owns all source SKUs, exact lot/cost moves, catalog changes,
 * and replay evidence. Never resume an archive by enumerating a new source set.
 */
export class CatalogInventoryCommandService {
  constructor(private readonly repository: CatalogInventoryCommandRepository,
    private readonly clock: () => Date, private readonly reportEffectFailure: (error: unknown) => void) {}

  async execute(input: CatalogInventoryCommand): Promise<CatalogInventoryResponse> {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw new CatalogInventoryCommandError("CATALOG_INVENTORY_INVALID", "Invalid catalog inventory command", 400);
    const command = parsed.data;
    if (command.operation === "variant_merge" && command.targetVariantId === null) {
      throw new CatalogInventoryCommandError("CATALOG_TARGET_REQUIRED", "A merge requires its target variant", 400);
    }
    const effects: Array<() => Promise<void>> = [];
    const response = await this.repository.transaction(async unit => {
      const { commandKey, ...intent } = command;
      // Identity includes the authenticated actor and requested target, but the
      // key does not: reusing it with changed intent must conflict, not move more.
      const replay = await unit.posting?.beginOperation(commandKey, { contractVersion: "catalog_inventory_v1", ...intent });
      if (replay) return receiptSchema.parse(replay.result).response;
      const snapshot = z.object({ source: identity, sourceVariantIds: z.array(z.number().int().positive()) })
        .parse(await unit.loadSource(command));
      if (new Set(snapshot.sourceVariantIds).size !== snapshot.sourceVariantIds.length) {
        throw new CatalogInventoryCommandError("CATALOG_SOURCE_AMBIGUOUS", "Source variants must have unique identities");
      }
      const sources = [...snapshot.sourceVariantIds].sort((a, b) => a - b);
      if (command.targetVariantId !== null && sources.includes(command.targetVariantId)) {
        throw new CatalogInventoryCommandError("CATALOG_TARGET_IS_SOURCE", "The destination cannot be one of the source variants", 400);
      }
      const cells = z.array(z.object({ productVariantId: z.number().int().positive(), onHand: count,
        reserved: count, picked: count, packed: count })).parse(await unit.lockQuantities([
        ...sources, ...(command.targetVariantId === null ? [] : [command.targetVariantId]),
      ]));
      const sourceCells = cells.filter(cell => sources.includes(cell.productVariantId));
      const initialOnHand = count.parse(sourceCells.reduce((sum, cell) => sum + cell.onHand, 0));
      if (command.targetVariantId !== null && sourceCells.some(cell => cell.reserved || cell.picked || cell.packed)) {
        throw new CatalogInventoryCommandError("CATALOG_STOCK_IN_USE", "Release or complete existing inventory claims before transferring this SKU");
      }
      let transferred = 0;
      let movedInventoryCount = 0;
      if (command.targetVariantId !== null) {
        for (const sourceId of sources) {
          if (!sourceCells.some(cell => cell.productVariantId === sourceId && cell.onHand > 0)) continue;
          const childKey = commandKey === undefined ? undefined : `catalog-child:${createHash("sha256")
            .update(JSON.stringify([commandKey, sourceId])).digest("hex")}`;
          const moved = z.object({ totalConverted: count, conversions: z.array(z.object({ locationCode: z.string(), qty: count })) })
            .parse(await unit.convert(sourceId, command.targetVariantId, childKey, command.actor, effect => effects.push(effect)));
          transferred = count.parse(transferred + moved.totalConverted);
          movedInventoryCount += moved.conversions.length;
        }
        if (transferred !== initialOnHand) throw new CatalogInventoryCommandError("CATALOG_TRANSFER_INCOMPLETE", "The complete source quantity must transfer before archiving");
      }
      const now = this.clock();
      if (unit.posting && transferred > 0) await unit.posting.post({ idempotencyKey: commandKey!, kind: "transform",
        actor: command.actor, reason: `Catalog ${command.operation}: ${command.sourceId}`,
        reference: { type: "catalog_inventory", id: `${command.operation}:${command.sourceId}` }, occurredAt: now.toISOString() });
      // These catalog writes and their publication triggers share the quantity
      // transaction. A failure rolls back every source, not only the last child.
      const metadata = await unit.applyMetadata(command, sources, now);
      const common = { inventoryCleared: metadata.inventoryCleared, inventoryPreserved: command.targetVariantId === null ? initialOnHand : 0,
        inventoryTransferred: transferred, binAssignmentsCleared: metadata.binAssignmentsCleared,
        channelFeedsDeactivated: metadata.channelFeedsDeactivated };
      const result = catalogInventoryResponseSchema.parse(command.operation === "variant_merge"
        ? { ok: true, movedInventoryCount, movedLocationCount: metadata.movedLocationCount, deactivatedVariantId: command.sourceId }
        : { success: true, archived: command.operation === "product_archive"
          ? { ...common, product: snapshot.source, variants: sources.length,
            replenDeactivated: metadata.replenDeactivated, replenTasksCancelled: metadata.replenTasksCancelled }
          : { ...common, variant: snapshot.source } });
      const receipt = receiptSchema.parse({ contractVersion: "catalog_inventory_v1", sourceVariantIds: sources, response: result });
      await unit.recordAudit(command, { source: snapshot.source, sourceVariantIds: sources, sourceCells, response: result }, now);
      if (unit.posting) {
        if (transferred > 0) await unit.posting.finishOperation(receipt);
        else await unit.posting.finishNoMovement(receipt);
      }
      return result;
    });
    for (const effect of effects) {
      try { await effect(); } catch (error) { this.reportEffectFailure(error); }
    }
    return response;
  }
}
