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
export type ManualReplenishmentIdentityRejection = {
  code: string;
  message: string;
};

/**
 * Returns the first reason a manual replenishment's locations or variants are
 * not usable, or null when they are. Each reason has its own code and message
 * so the operator sees what to fix instead of one catch-all error.
 *
 * Source and destination may be the same location only for a case break: the
 * output is a different SKU, so it lands in its own inventory row and lot at
 * that location (the break/assembly flow already breaks in place this way).
 * A transfer or pallet drop into its own location would move nothing, and the
 * transfer path rejects it.
 */
export function manualReplenishmentIdentityRejection(input: {
  replenMethod: "case_break" | "full_case" | "pallet_drop";
  source: { isActive: boolean | null } | undefined;
  destination: { isActive: boolean | null } | undefined;
  from:
    | {
        id: number;
        warehouseId: number | null;
        isActive: number;
        cycleCountFreezeId: number | null;
      }
    | undefined;
  to:
    | {
        id: number;
        warehouseId: number | null;
        isActive: number;
        isPickable: number;
        cycleCountFreezeId: number | null;
      }
    | undefined;
}): ManualReplenishmentIdentityRejection | null {
  const { source, destination, from, to } = input;
  if (!source || !destination)
    return {
      code: "MANUAL_REPLEN_VARIANT_NOT_FOUND",
      message: "Manual replenishment SKU was not found",
    };
  if (source.isActive !== true || destination.isActive !== true)
    return {
      code: "MANUAL_REPLEN_VARIANT_INACTIVE",
      message: "Manual replenishment SKUs must both be active",
    };
  if (!from || !to)
    return {
      code: "MANUAL_REPLEN_LOCATION_NOT_FOUND",
      message: "Manual replenishment location was not found",
    };
  if (!from.warehouseId || from.warehouseId !== to.warehouseId)
    return {
      code: "MANUAL_REPLEN_CROSS_WAREHOUSE",
      message: "Source and destination must be in the same warehouse",
    };
  if (from.id === to.id && input.replenMethod !== "case_break")
    return {
      code: "MANUAL_REPLEN_SAME_LOCATION",
      message:
        "Source and destination must be different locations (only a case break can stay in one location)",
    };
  if (from.isActive !== 1 || to.isActive !== 1)
    return {
      code: "MANUAL_REPLEN_LOCATION_INACTIVE",
      message: "Source and destination locations must both be active",
    };
  if (to.isPickable !== 1)
    return {
      code: "MANUAL_REPLEN_DESTINATION_NOT_PICKABLE",
      message: "Destination location must be pickable",
    };
  if (from.cycleCountFreezeId || to.cycleCountFreezeId)
    return {
      code: "MANUAL_REPLEN_LOCATION_FROZEN",
      message: "A location in this task is frozen for a cycle count",
    };
  return null;
}

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
    const rejection = manualReplenishmentIdentityRejection({
      replenMethod: input.replenMethod,
      source,
      destination,
      from,
      to,
    });
    if (rejection) {
      throw new IntegrityError(rejection.message, {
        code: rejection.code,
        fromLocationId: input.fromLocationId,
        toLocationId: input.toLocationId,
        sourceVariantId: input.sourceVariantId,
        pickVariantId: input.pickVariantId,
        replenMethod: input.replenMethod,
      });
    }
    if (!source || !destination || !from?.warehouseId || !to) {
      // Unreachable: the rejection check above covers every missing identity.
      // Kept so the compiler narrows the types for the code below.
      throw new IntegrityError("Manual replenishment identities are missing");
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
