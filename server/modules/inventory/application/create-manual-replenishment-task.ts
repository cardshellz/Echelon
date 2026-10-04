import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  replenTasks,
  productVariants,
  warehouseLocations,
  type WarehouseSettings,
} from "@shared/schema";
import { IntegrityError } from "@shared/errors";
import { planReplenishmentExecution } from "../domain/replenishment-execution.domain";
import type { TransformationExecutionAuthorityPort } from "./transformation-execution-authority.port";
import type { db } from "../../../db";
import { assertAuthorizedPackageConversionQuantity } from "../domain/transformation-execution-authority";
import type {
  PackageConversionAuthorization,
  PackageConversionAuthorizationRequest,
} from "../domain/transformation-execution-authority";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";

const id = z.number().int().positive().max(2_147_483_647);
export const manualReplenishmentTaskSchema = z
  .object({
    commandId: z.string().uuid(),
    fromLocationId: id,
    toLocationId: id,
    sourceVariantId: id,
    pickVariantId: id,
    qtySourceUnits: id,
    qtyTargetUnits: id.optional(),
    replenMethod: z.enum(["case_break", "full_case", "pallet_drop"]),
    priority: id.max(10).optional(),
    assignedTo: z.string().max(100).nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    replenRuleId: id.nullable().optional(),
    productId: id.nullable().optional(),
    triggeredBy: z.literal("manual").optional(),
  })
  .strict();
type Database = Pick<typeof db, "transaction" | "select">;
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function createManualReplenishmentTask(
  dependencies: {
    database: Database;
    authority: TransformationExecutionAuthorityPort;
    settings(
      warehouseId: number,
      tx: Transaction,
    ): Promise<WarehouseSettings | null>;
    decide(
      settings: WarehouseSettings | null,
      baseQuantity: number,
      method: string,
      variant: typeof productVariants.$inferSelect,
      locationId: number,
      tx: Transaction,
    ): Promise<{ shouldAutoExecute: boolean; executionMode: string }>;
  },
  rawInput: unknown,
  actor: string,
  clock: () => Date,
) {
  const input = manualReplenishmentTaskSchema.parse(rawInput);
  const operationKey = `manual-replen:${input.commandId.toLowerCase()}`;
  z.string().trim().min(1).max(100).parse(actor);
  const occurredAt = z.date().parse(clock());
  const requestHash = createHash("sha256")
    .update(canonicalJson({ actor, input }))
    .digest("hex");
  const [replay] = await dependencies.database
    .select()
    .from(replenTasks)
    .where(eq(replenTasks.operationKey, operationKey))
    .limit(1);
  if (replay) {
    if (replay.operationRequestHash !== requestHash)
      throw new IntegrityError(
        "Manual replenishment command was reused with different input",
        { operationKey },
      );
    return replay;
  }
  // Read authority without holding a connection needed by its repository.
  // The transaction below pins that exact evidence before admitting the plan.
  const runtime = await dependencies.authority.readRuntime();
  let conversion: {
    request: PackageConversionAuthorizationRequest;
    authorization: PackageConversionAuthorization;
  } | null = null;
  if (
    runtime.authority === "canonical" &&
    input.sourceVariantId !== input.pickVariantId
  ) {
    const [source] = await dependencies.database
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, input.sourceVariantId))
      .limit(1);
    const [destination] = await dependencies.database
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, input.pickVariantId))
      .limit(1);
    if (!source?.productId || !destination?.productId)
      throw new IntegrityError(
        "Manual replenishment has no exact catalog product identity",
      );
    const request: PackageConversionAuthorizationRequest = {
      productId: source.productId,
      operation: "break_pack",
      source: {
        variantId: source.id,
        productId: source.productId,
        unitsPerVariant: source.unitsPerVariant,
      },
      destination: {
        variantId: destination.id,
        productId: destination.productId,
        unitsPerVariant: destination.unitsPerVariant,
      },
    };
    conversion = {
      request,
      authorization: await dependencies.authority.authorizePackageConversion(
        request,
        runtime,
      ),
    };
  }
  return dependencies.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${operationKey},0))`,
    );
    const [existing] = await tx
      .select()
      .from(replenTasks)
      .where(eq(replenTasks.operationKey, operationKey))
      .limit(1);
    if (existing) {
      if (existing.operationRequestHash !== requestHash)
        throw new IntegrityError(
          "Manual replenishment command was reused with different input",
          { operationKey },
        );
      return existing;
    }
    await dependencies.authority.pinRuntime(tx, runtime);
    // Preserve the existing authority/model/catalog lock order.
    if (conversion)
      await dependencies.authority.pinPackageConversion(
        tx,
        conversion.request,
        conversion.authorization,
      );
    await tx.execute(
      sql`SELECT id FROM catalog.product_variants WHERE id IN (${input.sourceVariantId},${input.pickVariantId}) ORDER BY id FOR SHARE`,
    );
    await tx.execute(
      sql`SELECT id FROM warehouse.warehouse_locations WHERE id IN (${input.fromLocationId},${input.toLocationId}) ORDER BY id FOR SHARE`,
    );
    const [source] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, input.sourceVariantId))
      .limit(1);
    const [destination] = await tx
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, input.pickVariantId))
      .limit(1);
    const [from] = await tx
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, input.fromLocationId))
      .limit(1);
    const [to] = await tx
      .select()
      .from(warehouseLocations)
      .where(eq(warehouseLocations.id, input.toLocationId))
      .limit(1);
    if (
      !source ||
      !destination ||
      source.isActive !== true ||
      destination.isActive !== true ||
      !from ||
      !to ||
      !from.warehouseId ||
      from.warehouseId !== to.warehouseId ||
      from.id === to.id ||
      from.isActive !== 1 ||
      to.isActive !== 1 ||
      to.isPickable !== 1 ||
      from.cycleCountFreezeId ||
      to.cycleCountFreezeId
    ) {
      throw new IntegrityError(
        "Manual replenishment requires exact active source, destination and variant identities in one warehouse",
      );
    }
    const baseQuantity = input.qtySourceUnits * source.unitsPerVariant;
    id.parse(baseQuantity);
    const plan = planReplenishmentExecution({
      replenMethod: input.replenMethod,
      sourceVariantId: source.id,
      sourceProductId: source.productId,
      sourceUnitsPerVariant: source.unitsPerVariant,
      pickVariantId: destination.id,
      pickProductId: destination.productId,
      pickUnitsPerVariant: destination.unitsPerVariant,
      qtySourceUnits: input.qtySourceUnits,
      qtyTargetUnits: baseQuantity,
    });
    if (
      input.qtyTargetUnits !== undefined &&
      input.qtyTargetUnits !== plan.movedBaseUnits
    )
      throw new IntegrityError(
        "Submitted target quantity differs from the server's exact unit plan",
      );
    if (
      input.productId !== undefined &&
      input.productId !== null &&
      input.productId !== source.productId
    )
      throw new IntegrityError(
        "Manual replenishment product identity differs from its source SKU",
      );
    if (conversion) {
      if (
        source.unitsPerVariant !== conversion.request.source.unitsPerVariant ||
        destination.unitsPerVariant !==
          conversion.request.destination.unitsPerVariant ||
        source.productId !== conversion.request.source.productId ||
        destination.productId !== conversion.request.destination.productId
      ) {
        throw new IntegrityError(
          "Manual replenishment catalog units changed before its plan was pinned",
        );
      }
      assertAuthorizedPackageConversionQuantity(
        conversion.authorization,
        input.qtySourceUnits,
        plan.qtyPickUnits,
      );
    }
    const settings = await dependencies.settings(from.warehouseId, tx);
    const decision = await dependencies.decide(
      settings,
      plan.movedBaseUnits,
      input.replenMethod,
      destination,
      to.id,
      tx,
    );
    const executionMode = z
      .enum(["inline", "queue"])
      .parse(decision.executionMode);
    const [task] = await tx
      .insert(replenTasks)
      .values({
        operationKey,
        operationRequestHash: requestHash,
        fromLocationId: from.id,
        toLocationId: to.id,
        sourceProductVariantId: source.id,
        pickProductVariantId: destination.id,
        productId: source.productId,
        qtySourceUnits: input.qtySourceUnits,
        qtyTargetUnits: plan.movedBaseUnits,
        replenMethod: input.replenMethod,
        status: "pending",
        qtyCompleted: 0,
        executionMode,
        autoReplen: decision.shouldAutoExecute ? 1 : 0,
        priority: input.priority ?? 5,
        triggeredBy: "manual",
        assignedTo: input.assignedTo ?? null,
        notes: input.notes ?? null,
        warehouseId: from.warehouseId,
        createdBy: actor,
        createdAt: occurredAt,
      })
      .returning();
    if (!task)
      throw new IntegrityError(
        "Manual replenishment insertion returned no task",
      );
    await persistAuditEvent(
      tx,
      {
        actor,
        action: "inventory.replen_task_created",
        target: `inventory.replen_task:${task.id}`,
        changes: {
          before: null,
          after: {
            fromLocationId: from.id,
            toLocationId: to.id,
            sourceVariantId: source.id,
            pickVariantId: destination.id,
            qtySourceUnits: input.qtySourceUnits,
            qtyTargetUnits: plan.movedBaseUnits,
            replenMethod: input.replenMethod,
            executionMode,
          },
        },
        context: { operationKey, runtime },
      },
      { timestamp: occurredAt },
    );
    return task;
  });
}
