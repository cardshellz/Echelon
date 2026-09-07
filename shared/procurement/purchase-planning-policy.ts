import { purchaseReplacementForecastsSchema, type PurchaseReplacementForecast } from "./purchase-replacement-forecast";
import { z } from "zod";

const days = z.number().int().min(0).max(730);
export const purchaseLeadTimeStagesSchema = z.object({
  rfqDays: days,
  productionDays: days,
  transitDays: days,
  receivingDays: days,
}).strict().refine((value) => Object.values(value).reduce((sum, day) => sum + day, 0) > 0 && Object.values(value).reduce((sum, day) => sum + day, 0) <= 1460, {
  message: "Explicit staged lead time must total 1 to 1460 days",
});

export const purchaseProductPlanningPolicySchema = z.object({
  productId: z.number().int().positive().max(2_147_483_647),
  essential: z.boolean(),
  minimumStockPieces: z.number().int().min(0).max(2_147_483_647),
  targetCoverDays: days.nullable(),
  leadTimeStages: purchaseLeadTimeStagesSchema.nullable(),
}).strict();

export const purchasePlanningPolicySchema = z.object({
  version: z.literal(1),
  replacementForecasts: purchaseReplacementForecastsSchema.optional(),
  growthPercent: z.number().int().min(-100).max(1000),
  targetCoverDays: days.nullable(),
  products: z.array(purchaseProductPlanningPolicySchema).max(2000),
}).strict().superRefine((policy, context) => {
  const productIds = new Set<number>();
  policy.products.forEach((product, index) => {
    if (productIds.has(product.productId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["products", index, "productId"], message: "Each product can have only one planning policy" });
    }
    productIds.add(product.productId);
    if (product.essential && product.minimumStockPieces === 0 && !product.targetCoverDays) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["products", index], message: "Essential items require a minimum stock quantity or target cover" });
    }
  });
  for (const range of policy.replacementForecasts ?? []) {
    if (!productIds.has(range.productId)) context.addIssue({ code: "custom", path: ["replacementForecasts"], message: "Replacement forecasts require a visible product planning policy" });
  }
});

export type PurchaseLeadTimeStages = z.infer<typeof purchaseLeadTimeStagesSchema>;
export type PurchaseProductPlanningPolicy = z.infer<typeof purchaseProductPlanningPolicySchema>;
export type PurchasePlanningPolicy = z.infer<typeof purchasePlanningPolicySchema>;

export function defaultPurchasePlanningPolicy(): PurchasePlanningPolicy {
  return { version: 1, growthPercent: 0, targetCoverDays: null, products: [] };
}

/** Stored invalid policy must fail visibly; only an absent legacy setting is neutral. */
export function parsePurchasePlanningPolicy(value: unknown): PurchasePlanningPolicy {
  const policy = purchasePlanningPolicySchema.parse(value ?? defaultPurchasePlanningPolicy());
  return { ...policy, products: [...policy.products].sort((left, right) => left.productId - right.productId),
    ...(policy.replacementForecasts ? { replacementForecasts: [...policy.replacementForecasts].sort((a, b) => a.productId - b.productId || a.startDate.localeCompare(b.startDate)) } : {}) };

}

export interface PurchasePlanningBasis {
  policyVersion: 1;
  policyRevision: number | null;
  replacementForecasts?: PurchaseReplacementForecast[];
  growthPercent: number;
  historicalDailyPieces: number;
  adjustedDailyPieces: number;
  essential: boolean;
  excludedQuarantinePieces?: number;
  minimumStockPieces: number;
  targetCoverDays: number;
  targetStockPieces: number;
  leadTimeStages: PurchaseLeadTimeStages | null;
}

export interface PurchaseInboundScheduleEntry {
  purchaseOrderId: number;
  purchaseOrderNumber: string;
  purchaseOrderLineId: number;
  remainingPieces: number;
  expectedDate: string | null;
}

export interface PurchaseSupplyTiming {
  asOfDate: string;
  stockoutDateWithoutReceipts: string | null;
  orderByDateWithoutReceipts: string | null;
  newOrderArrivalDate: string;
  reviewRequired: boolean;
  signal: "no_open_supply" | "scheduled" | "arrival_gap" | "unverified_schedule" | "unverified_demand_events";
  detail: string;
  firstGapDate: string | null;
  scheduledWithinCyclePieces: number;
  undatedPieces: number;
  pastDuePieces: number;
  beyondCyclePieces: number;
  scheduleComplete: boolean;
  arrivals: PurchaseInboundScheduleEntry[];
}
