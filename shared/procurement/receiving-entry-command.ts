import { z } from "zod";
import { centsToMills, millsToCents } from "../utils/money";

export const receivingEntryIdSchema = z.number().int().positive().max(2_147_483_647);
const count = z.number().int().min(0).max(2_147_483_647);
const millsPerCent = BigInt(centsToMills(1));
const optionalId = receivingEntryIdSchema.nullish();
const optionalText = (length: number) => z.string().trim().max(length).transform(value => value || null).nullish();
const cost = z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)).nullish();

export const receivingEntryCreateSchema = z.object({
  sourceType: z.enum(["po", "asn", "blind", "initial_load"]).optional(),
  vendorId: optionalId,
  warehouseId: optionalId,
  poNumber: optionalText(100),
  asnNumber: optionalText(100),
  expectedDate: z.string().refine(value => value === "" || Number.isFinite(Date.parse(value)), "Expected date must be valid").nullish(),
  notes: optionalText(10_000),
}).strict();

export const receivingEntryAddLineSchema = z.object({
  sku: optionalText(100), productName: optionalText(500), barcode: optionalText(100),
  expectedQty: count.optional(), receivedQty: count.optional(),
  productVariantId: optionalId, productId: optionalId,
  expectedUnitsPerVariant: receivingEntryIdSchema.optional(),
  putawayLocationId: optionalId,
  unitCost: cost, unitCostMills: cost, unit_cost_mills: cost,
}).strict().superRefine((input, context) => {
  if (input.unitCostMills != null && input.unit_cost_mills != null && input.unitCostMills !== input.unit_cost_mills) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unitCostMills"], message: "Both mills values must match" });
  }
  const mills = input.unit_cost_mills ?? input.unitCostMills;
  if (mills != null && input.unitCost != null && millsToCents(mills) !== input.unitCost) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unitCost"], message: "Cents and mills must describe the same cost" });
  }
  if (mills == null && input.unitCost != null && Number.isSafeInteger(input.unitCost) && BigInt(input.unitCost) * millsPerCent > BigInt(Number.MAX_SAFE_INTEGER)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["unitCost"], message: "Unit cost exceeds the supported mills range" });
  }
});

export const receivingEntryCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), targetId: z.null(), payload: receivingEntryCreateSchema }).strict(),
  z.object({ action: z.literal("add-line"), targetId: receivingEntryIdSchema, payload: receivingEntryAddLineSchema }).strict(),
]);
export type ReceivingEntryCommand = z.infer<typeof receivingEntryCommandSchema>;
export type ReceivingEntryAction = ReceivingEntryCommand["action"];

export function receivingEntryLineFields(input: z.infer<typeof receivingEntryAddLineSchema>): Record<string, unknown> {
  const { unit_cost_mills, unitCostMills, unitCost, ...fields } = input;
  const mills = unit_cost_mills ?? unitCostMills ?? (unitCost == null ? null : centsToMills(unitCost));
  return { ...fields, expectedQty: input.expectedQty ?? 0, receivedQty: input.receivedQty ?? 0, damagedQty: 0,
    unitCost: mills == null ? null : millsToCents(mills), unitCostMills: mills };
}

const entryIdentity = z.object({
  action: z.enum(["create", "add-line"]), targetId: receivingEntryIdSchema.nullable(),
  actorId: z.string().min(1).max(100), idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/),
  receivingOrderId: receivingEntryIdSchema, receivingLineId: receivingEntryIdSchema.nullable(),
}).strict();

// Only the mutation receipt is recovery authority. Clients refresh the current
// order after success; replay may legitimately contain an older order snapshot.
export const receivingEntryCommandResultSchema = z.object({
  id: receivingEntryIdSchema, receiptNumber: z.string().min(1), status: z.string().min(1),
  entryCommand: entryIdentity,
  lines: z.array(z.object({
    id: receivingEntryIdSchema, receivingOrderId: receivingEntryIdSchema,
    productVariantId: receivingEntryIdSchema.nullable(), productId: receivingEntryIdSchema.nullable(),
    sku: z.string().nullable(), productName: z.string().nullable(), barcode: z.string().nullable(),
    expectedQty: count, receivedQty: count, damagedQty: count,
    unitsPerVariantSnapshot: receivingEntryIdSchema.nullable(), putawayLocationId: receivingEntryIdSchema.nullable(),
    unitCost: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
    unitCostMills: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  }).passthrough()).optional(),
}).passthrough().superRefine((result, context) => {
  const identity = result.entryCommand;
  if (result.id !== identity.receivingOrderId || (identity.action === "create"
    ? identity.targetId !== null || identity.receivingLineId !== null
    : identity.targetId !== result.id || identity.receivingLineId === null
      || result.lines?.filter(line => line.id === identity.receivingLineId && line.receivingOrderId === result.id).length !== 1)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["entryCommand"], message: "Receiving result identity is inconsistent" });
  }
});
export type ReceivingEntryCommandResult = z.infer<typeof receivingEntryCommandResultSchema>;

/** The command owner checks this before commit and on replay; the client uses
 * the same evidence before releasing its saved intent. Current receipt state
 * is a separate read and must not replace this immutable command result. */
export function receivingEntryResultMatchesRequest(result: ReceivingEntryCommandResult, requested: ReceivingEntryCommand, actorId: string): boolean {
  if (requested.action === "create") {
    if (result.createdBy !== actorId || result.status !== "draft" || result.sourceType !== (requested.payload.sourceType ?? "blind")) return false;
    for (const field of ["vendorId", "warehouseId", "poNumber", "asnNumber", "notes"] as const) {
      if ((result[field] ?? null) !== (requested.payload[field] ?? null)) return false;
    }
    const expectedDate = requested.payload.expectedDate ? new Date(requested.payload.expectedDate).toISOString() : null;
    return (result.expectedDate ?? null) === expectedDate;
  }
  const line = result.lines?.find(value => value.id === result.entryCommand.receivingLineId);
  if (!line) return false;
  const expected = receivingEntryLineFields(requested.payload);
  for (const [field, value] of Object.entries(expected)) {
    if (field === "expectedUnitsPerVariant") continue;
    // The locked catalog variant resolves product identity when the caller
    // selected a variant without supplying its product ID separately.
    if (field === "productId" && value == null && requested.payload.productVariantId) {
      if (line.productId === null) return false;
      continue;
    }
    if ((line[field] ?? null) !== (value ?? null)) return false;
  }
  for (const field of ["sku", "productName", "barcode", "putawayLocationId", "productVariantId"] as const) {
    if (line[field] !== (requested.payload[field] ?? null)) return false;
  }
  if (requested.payload.productVariantId && line.productId === null) return false;
  if (!requested.payload.productVariantId && line.productId !== (requested.payload.productId ?? null)) return false;
  return line.unitsPerVariantSnapshot === (requested.payload.productVariantId ? requested.payload.expectedUnitsPerVariant : null);
}
