import { z } from "zod";
import {
  plannerNonnegativeQuantitySchema,
  plannerSignedQuantitySchema,
} from "./inventory-availability-planner";

const id = z.number().int().positive().max(2_147_483_647);

export const inventoryCutoverVariantSchema = z.object({
  id,
  productId: id,
  sku: z.string(),
  isActive: z.boolean(),
  requiresShipping: z.boolean(),
  trackInventory: z.boolean(),
  salesEligibility: z.enum(["sellable", "internal_only"]),
}).strict();

export const inventoryCutoverFindingSchema = z.object({
  code: z.string().min(1).max(100),
  message: z.string().min(1).max(1_000),
  orderId: id.nullable(),
  orderItemId: id.nullable(),
  inventoryLevelId: id.nullable(),
}).strict();

export const inventoryCutoverLineSchema = z.object({
  orderId: id,
  orderItemId: id,
  warehouseId: id.nullable(),
  sku: z.string(),
  orderStatus: z.string().nullable(),
  itemStatus: z.string().nullable(),
  productVariantId: id.nullable(),
  orderedQty: plannerSignedQuantitySchema,
  recordedPickedQty: plannerSignedQuantitySchema,
  recordedFulfilledQty: plannerSignedQuantitySchema,
  // Only untouched, unfulfilled physical demand receives a candidate quantity.
  // Progress, dispatch, or custody evidence requires its own migration proof.
  candidateDemandQty: plannerNonnegativeQuantitySchema.nullable(),
  disposition: z.enum(["unstarted_demand", "no_inventory_demand", "review_required"]),
  findingCodes: z.array(z.string()),
}).strict().superRefine((line, context) => {
  const valid = line.disposition === "review_required"
    ? line.candidateDemandQty === null && line.findingCodes.length > 0
    : line.disposition === "no_inventory_demand"
      ? line.candidateDemandQty === "0" && line.findingCodes.length === 0
      : line.candidateDemandQty === line.orderedQty && BigInt(line.orderedQty) > BigInt(0)
        && line.recordedPickedQty === "0" && line.recordedFulfilledQty === "0" && line.findingCodes.length === 0;
  if (!valid) context.addIssue({ code: z.ZodIssueCode.custom, path: ["candidateDemandQty"], message: "Candidate demand must match the evidence disposition." });
});

export const inventoryCutoverLevelSchema = z.object({
  inventoryLevelId: id,
  productVariantId: id,
  warehouseLocationId: id,
  physicalQty: plannerSignedQuantitySchema,
  recordedReservedQty: plannerSignedQuantitySchema,
  canonicalOpenQty: plannerNonnegativeQuantitySchema,
  standaloneBuildOpenQty: plannerNonnegativeQuantitySchema,
  // A residual is unattributed evidence, NOT free stock or a repair instruction.
  unattributedReservedQty: plannerSignedQuantitySchema,
  pickedQty: plannerSignedQuantitySchema,
  packedQty: plannerSignedQuantitySchema,
}).strict();

export const inventoryCutoverPreflightSchema = z.object({
  contractVersion: z.literal("inventory_cutover_preflight_v1"),
  scope: z.literal("nonterminal_wms_demand_and_current_inventory_encumbrances"),
  capturedAt: z.string().datetime(),
  evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
  runtimeAuthority: z.enum(["legacy", "canonical"]).nullable(),
  authorityRevision: plannerNonnegativeQuantitySchema.nullable(),
  outcome: z.enum(["evidence_captured", "review_required"]),
  operationalWriteAttempted: z.literal(false),
  // This bounded evidence report is deliberately not an authority-switch gate.
  activationReadinessEvaluated: z.literal(false),
  excludedTerminalOrderCount: plannerNonnegativeQuantitySchema,
  summary: z.object({
    orders: z.number().int().nonnegative(),
    lines: z.number().int().nonnegative(),
    unstartedDemandLines: z.number().int().nonnegative(),
    noInventoryDemandLines: z.number().int().nonnegative(),
    reviewLines: z.number().int().nonnegative(),
    inventoryLevels: z.number().int().nonnegative(),
    unattributedReservationLevels: z.number().int().nonnegative(),
  }).strict(),
  lines: z.array(inventoryCutoverLineSchema),
  inventoryLevels: z.array(inventoryCutoverLevelSchema),
  findings: z.array(inventoryCutoverFindingSchema),
  notEvaluated: z.array(z.string().min(1)).min(1),
}).strict().superRefine((report, context) => {
  const expected = report.findings.length > 0 ? "review_required" : "evidence_captured";
  if (report.outcome !== expected) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["outcome"], message: "Outcome must match captured findings." });
  }
  if (report.summary.lines !== report.lines.length
    || report.summary.inventoryLevels !== report.inventoryLevels.length
    || report.summary.unstartedDemandLines !== report.lines.filter((line) => line.disposition === "unstarted_demand").length
    || report.summary.noInventoryDemandLines !== report.lines.filter((line) => line.disposition === "no_inventory_demand").length
    || report.summary.reviewLines !== report.lines.filter((line) => line.disposition === "review_required").length
    || report.summary.unattributedReservationLevels !== report.inventoryLevels.filter((level) => level.unattributedReservedQty !== "0").length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["summary"], message: "Summary must match captured rows." });
  }
});

export type InventoryCutoverVariant = z.infer<typeof inventoryCutoverVariantSchema>;
export type InventoryCutoverFinding = z.infer<typeof inventoryCutoverFindingSchema>;
export type InventoryCutoverLine = z.infer<typeof inventoryCutoverLineSchema>;
export type InventoryCutoverPreflight = z.infer<typeof inventoryCutoverPreflightSchema>;
