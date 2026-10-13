import { z } from "zod";

const locationId = z.number().int().positive().max(2_147_483_647).nullable();
const headerResultSchema = z.object({
  id: z.number().int().positive(),
  warehouseId: locationId,
  receivingLocationId: locationId,
});

const closeResultSchema = z.object({
  success: z.literal(true),
  unitsReceived: z.number().int().nonnegative().safe(),
  linesProcessed: z.number().int().nonnegative().safe(),
  order: z.object({ id: z.number().int().positive(), status: z.literal("closed") }).optional(),
  costReconciliation: z.object({ state: z.enum(["applied", "review_required", "retry_required", "not_applicable"]) }).optional(),
});

export function parseReceivingCloseResult(value: unknown, expectedId: number) {
  const result = closeResultSchema.safeParse(value);
  if (!result.success || (result.data.order && result.data.order.id !== expectedId)) {
    throw new Error("The receipt close outcome could not be verified. Load the latest receipt before retrying.");
  }
  return result.data;
}

export function parseReceivingHeaderResult(value: unknown, expectedId: number) {
  const parsed = headerResultSchema.safeParse(value);
  if (!parsed.success || parsed.data.id !== expectedId) {
    throw new Error("The saved receipt settings could not be verified. Load the latest receipt before continuing.");
  }
  return parsed.data;
}

const issueSchema = z.object({
  message: z.string().trim().min(1).optional(),
  receivingLineId: z.number().int().positive().optional(),
  sku: z.string().nullable().optional(),
  missingVariant: z.boolean().optional(),
  missingLocation: z.boolean().optional(),
});

export function receivingIssueMessages(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue: unknown): string[] => {
    const parsed = issueSchema.safeParse(issue);
    if (!parsed.success) return [];
    const row = parsed.data;
    const prefix = row.sku ? `${row.sku}: ` : row.receivingLineId ? `Line ${row.receivingLineId}: ` : "";
    if (row.message) return [prefix + row.message];
    const missing = [row.missingVariant ? "product link" : null, row.missingLocation ? "location" : null].filter(Boolean);
    return missing.length ? [`${prefix}Select the missing ${missing.join(" and ")}.`] : [];
  });
}

/** Presentation uses the owner's result; it never infers financial completion
 * from a successful physical receipt or an absent cost response. */
export function receivingCostOutcomeMessage(value: unknown): string | null {
  const result = z.object({ state: z.enum(["applied", "review_required", "retry_required", "not_applicable"]) }).safeParse(value);
  if (!result.success) return null;
  if (result.data.state === "review_required") return "Inventory is received. Costs require review on the purchase order.";
  if (result.data.state === "retry_required") return "Inventory is received. Cost processing is pending; review or retry it on the purchase order.";
  return null;
}
