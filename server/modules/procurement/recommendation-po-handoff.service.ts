import { z } from "zod";
import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
} from "@shared/utils/po-line-pricing";
import { autoDraftRunCompletionSchema } from "./auto-draft-run-lifecycle.service";
import {
  assessSupplierQuoteValidity,
  RECOMMENDATION_SUPPLIER_QUOTE_MAX_AGE_DAYS,
} from "./supplier-quote-validity";

const recommendationKinds = ["skipped", "held_by_policy", "quality_review_required", "auto_draft_eligible"] as const;
const operatorDecisionValues = ["reviewed", "accepted_for_po", "deferred", "dismissed"] as const;
const POSTGRES_INTEGER_MAX = 2_147_483_647;

const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});
const positivePostgresInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativePostgresInteger = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);

const nullableBoundedString = (maximum: number) => z.string().trim().max(maximum).nullable();
const nullableBoundedStoredString = (maximum: number) => z.string().max(maximum).nullable();
const supplierPricingBasisSchema = z.enum(["per_piece", "per_purchase_uom"]);
const isoDateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "must be a valid YYYY-MM-DD calendar date");
const quoteTimestampSchema = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value === "string" && value.trim()) return new Date(value);
  return value;
}, z.date());

type ExplicitSupplierQuote = {
  pricingBasis: "per_piece" | "per_purchase_uom";
  purchaseUom: string | null;
  quotedUnitCostMills: number;
  piecesPerPurchaseUom: number | null;
  quoteReference: string | null;
  quotedAt: Date;
  quoteValidUntil: string | null;
};

function validateExplicitSupplierQuote(
  value: ExplicitSupplierQuote,
  context: z.RefinementCtx,
): void {
  if (value.pricingBasis === "per_piece") {
    if (value.purchaseUom !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "per-piece pricing cannot include purchaseUom", path: ["purchaseUom"] });
    }
    if (value.piecesPerPurchaseUom !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "per-piece pricing cannot include piecesPerPurchaseUom", path: ["piecesPerPurchaseUom"] });
    }
  } else {
    if (!value.purchaseUom?.trim()) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "per-purchase-UOM pricing requires purchaseUom", path: ["purchaseUom"] });
    }
    if (value.piecesPerPurchaseUom === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "per-purchase-UOM pricing requires piecesPerPurchaseUom", path: ["piecesPerPurchaseUom"] });
    }
  }
  if (value.quoteValidUntil && value.quoteValidUntil < value.quotedAt.toISOString().slice(0, 10)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "quoteValidUntil cannot be earlier than quotedAt",
      path: ["quoteValidUntil"],
    });
  }
}

const handoffItemSchema = z.object({
  acceptedDecisionId: positivePostgresInteger,
  recommendationId: z.string().trim().min(1).max(160),
  kind: z.enum(recommendationKinds),
  productId: positivePostgresInteger,
  productVariantId: positivePostgresInteger,
  suggestedPieces: positivePostgresInteger,
  orderUomUnits: positivePostgresInteger,
  orderUomLabel: z.string().trim().min(1).max(100),
  vendorId: positivePostgresInteger,
  vendorProductId: positivePostgresInteger,
  sku: nullableBoundedString(100),
  productName: nullableBoundedString(2_000),
  candidateScore: z.number().int().min(0).max(100).nullable(),
  candidateBand: nullableBoundedString(40),
  recommendationSnapshot: z.record(z.unknown()),
}).strict();

const handoffCommandSchema = z.object({
  actorId: z.string().trim().min(1).max(100),
  items: z.array(handoffItemSchema).min(1).max(25),
}).strict();

const automaticHandoffItemSchema = z.object({
  recommendationId: z.string().trim().min(1).max(160),
  productId: positivePostgresInteger,
  productVariantId: positivePostgresInteger,
  suggestedOrderQty: positivePostgresInteger,
  suggestedOrderPieces: positivePostgresInteger,
  orderUomUnits: positivePostgresInteger,
  orderUomLabel: z.string().trim().min(1).max(100),
  vendorId: positivePostgresInteger,
  vendorProductId: positivePostgresInteger,
  sku: nullableBoundedString(100),
  productName: nullableBoundedString(2_000),
  estimatedCostMills: nonnegativeSafeInteger.nullable(),
  estimatedCostCents: nonnegativeSafeInteger.nullable(),
  pricingBasis: supplierPricingBasisSchema,
  purchaseUom: nullableBoundedString(50),
  quotedUnitCostMills: nonnegativeSafeInteger,
  piecesPerPurchaseUom: positivePostgresInteger.nullable(),
  quoteReference: nullableBoundedStoredString(255),
  quotedAt: quoteTimestampSchema,
  quoteValidUntil: isoDateOnlySchema.nullable(),
  candidateScore: z.number().int().min(0).max(100).nullable(),
  candidateBand: nullableBoundedString(40),
  recommendationSnapshot: z.record(z.unknown()),
}).strict().superRefine((value, context) => {
  if (value.estimatedCostMills === null && value.estimatedCostCents === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "automatic recommendation supplier cost is required",
      path: ["estimatedCostMills"],
    });
  }
  validateExplicitSupplierQuote(value, context);
  if (
    value.pricingBasis === "per_purchase_uom" &&
    value.piecesPerPurchaseUom !== null &&
    value.suggestedOrderPieces % value.piecesPerPurchaseUom !== 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestedOrderPieces must be divisible by piecesPerPurchaseUom",
      path: ["suggestedOrderPieces"],
    });
  }
});

const automaticHandoffCommandSchema = z.object({
  actorId: z.string().trim().min(1).max(100),
  autoDraftRunId: positivePostgresInteger,
  items: z.array(automaticHandoffItemSchema).max(2_000),
  completion: autoDraftRunCompletionSchema,
}).strict().superRefine((value, context) => {
  const counts = ["itemsAnalyzed", "skippedNoVendor", "skippedOnOrder", "skippedExcluded"] as const;
  for (const field of counts) {
    const parsed = nonnegativePostgresInteger.safeParse(value.completion[field]);
    if (!parsed.success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${field} must fit a PostgreSQL INTEGER`,
        path: ["completion", field],
      });
    }
  }
});

const acceptedRecommendationEconomicBasisSchema = z.object({
  productId: positivePostgresInteger,
  productVariantId: positivePostgresInteger,
  preferredVendorId: positivePostgresInteger,
  vendorProductId: positivePostgresInteger,
  suggestedOrderQty: positivePostgresInteger,
  suggestedOrderPieces: positivePostgresInteger,
  orderUomUnits: positivePostgresInteger,
  estimatedCostMills: nonnegativeSafeInteger.nullable(),
  estimatedCostCents: nonnegativeSafeInteger.nullable(),
  pricingBasis: supplierPricingBasisSchema,
  purchaseUom: nullableBoundedString(50),
  quotedUnitCostMills: nonnegativeSafeInteger,
  piecesPerPurchaseUom: positivePostgresInteger.nullable(),
  quoteReference: nullableBoundedStoredString(255),
  quotedAt: quoteTimestampSchema,
  quoteValidUntil: isoDateOnlySchema.nullable(),
  supplierBasis: z.object({
    // Vendor MOQ is expressed in base pieces, independently of both the
    // receive configuration and the vendor's quote UOM.
    minimumOrderPieces: positivePostgresInteger.nullable(),
  }).passthrough(),
}).passthrough().superRefine((value, context) => {
  if (value.estimatedCostMills === null && value.estimatedCostCents === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "accepted recommendation supplier cost is required",
      path: ["estimatedCostMills"],
    });
  }
  validateExplicitSupplierQuote(value, context);
  if (
    value.pricingBasis === "per_purchase_uom" &&
    value.piecesPerPurchaseUom !== null &&
    value.suggestedOrderPieces % value.piecesPerPurchaseUom !== 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestedOrderPieces must be divisible by piecesPerPurchaseUom",
      path: ["suggestedOrderPieces"],
    });
  }
  if (
    value.supplierBasis.minimumOrderPieces !== null &&
    value.suggestedOrderPieces < value.supplierBasis.minimumOrderPieces
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "suggestedOrderPieces must meet the accepted supplier minimum order",
      path: ["suggestedOrderPieces"],
    });
  }
});

const recordDecisionSchema = z.object({
  recommendationId: z.string().trim().min(1).max(160),
  kind: z.enum(recommendationKinds),
  decision: z.enum(operatorDecisionValues),
  status: z.literal("active"),
  decisionReason: nullableBoundedString(100),
  note: nullableBoundedString(2_000),
  source: z.literal("operator"),
  autoDraftRunId: positivePostgresInteger.nullable().optional(),
  productId: positivePostgresInteger.nullable(),
  productVariantId: positivePostgresInteger.nullable(),
  vendorId: positivePostgresInteger.nullable(),
  sku: nullableBoundedString(100),
  productName: nullableBoundedString(2_000),
  candidateScore: z.number().int().min(0).max(100).nullable(),
  candidateBand: nullableBoundedString(40),
  recommendationSnapshot: z.record(z.unknown()),
  decidedBy: z.string().trim().min(1).max(255),
}).strict();

export type RecommendationKind = typeof recommendationKinds[number];
export type OperatorRecommendationDecision = typeof operatorDecisionValues[number];
export type AcceptedRecommendationPoHandoffItem = z.infer<typeof handoffItemSchema>;
export type AcceptedRecommendationPoHandoffCommand = z.infer<typeof handoffCommandSchema>;
export type AutomaticRecommendationPoHandoffItem = z.infer<typeof automaticHandoffItemSchema>;
export type AutomaticRecommendationPoHandoffCommand = z.infer<typeof automaticHandoffCommandSchema>;
export type RecordRecommendationDecisionInput = z.infer<typeof recordDecisionSchema>;
type AcceptedRecommendationEconomicBasis = z.infer<typeof acceptedRecommendationEconomicBasisSchema>;

export interface RecommendationDecisionRecord {
  id: number;
  recommendationId: string;
  kind: string;
  decision: string;
  status: string;
  decisionReason: string | null;
  note: string | null;
  source: string;
  autoDraftRunId: number | null;
  productId: number | null;
  productVariantId: number | null;
  vendorId: number | null;
  sku: string | null;
  productName: string | null;
  candidateScore: number | null;
  candidateBand: string | null;
  recommendationSnapshot: unknown;
  decidedBy: string | null;
  decidedAt: Date;
  createdAt: Date;
}

export interface RecommendationPoHandoffRecord {
  id: number;
  acceptedDecisionId: number;
  handoffDecisionId: number;
  purchaseOrderId: number;
  purchaseOrderLineId: number;
  recommendationId: string;
  kind: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface RecommendationAutoDraftRunRecord {
  id: number;
  runAt: Date | string;
  status: string;
  triggeredBy: string;
  triggeredByUser: string | null;
}

export interface RecommendationVendorProductRecord {
  id: number;
  vendorId: number;
  productId: number;
  productVariantId: number | null;
  vendorSku: string | null;
  unitCostCents: number | null;
  unitCostMills: number | null;
  pricingBasis: "legacy_unknown" | "per_piece" | "per_purchase_uom";
  purchaseUom: string | null;
  quotedUnitCostMills: number | null;
  piecesPerPurchaseUom: number | null;
  moq: number | null;
  quoteReference: string | null;
  quotedAt: Date | null;
  quotedAtDate: string | null;
  quoteValidUntil: string | null;
  updatedAt: Date;
  isPreferred: number | null;
  isActive: number | null;
}

export interface RecommendationVendorRecord {
  id: number;
  active: number;
  currency: string | null;
  paymentTermsDays: number | null;
  paymentTermsType: string | null;
  shipFromAddress: string | null;
  defaultIncoterms: string | null;
}

export interface RecommendationProductRecord {
  id: number;
  sku: string | null;
  name: string;
  status: string | null;
  isActive: boolean;
}

export interface RecommendationProductVariantRecord {
  id: number;
  productId: number;
  sku: string | null;
  name: string;
  unitsPerVariant: number;
  isActive: boolean;
}

export interface NewRecommendationPurchaseOrder {
  vendorId: number;
  status: "draft";
  physicalStatus: "draft";
  financialStatus: "unbilled";
  poType: "standard";
  priority: "normal";
  currency: string;
  paymentTermsDays: number | null;
  paymentTermsType: string | null;
  shipFromAddress: string | null;
  incoterms: string | null;
  subtotalCents: number;
  totalCents: number;
  lineCount: number;
  source: "reorder" | "auto_draft";
  autoDraftDate: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatedRecommendationPurchaseOrder extends NewRecommendationPurchaseOrder {
  id: number;
  poNumber: string;
}

export interface NewRecommendationPurchaseOrderLine {
  purchaseOrderId: number;
  lineNumber: number;
  productId: number;
  productVariantId: number;
  expectedReceiveVariantId: number;
  vendorProductId: number;
  sku: string | null;
  productName: string;
  vendorSku: string | null;
  unitOfMeasure: string;
  unitsPerUom: number;
  expectedReceiveUnitsPerVariant: number;
  orderQty: number;
  unitCostCents: number;
  unitCostMills: number;
  totalProductCostCents: number;
  packagingCostCents: 0;
  pricingBasis: "per_piece" | "per_purchase_uom";
  pricingSource: "recommendation";
  purchaseUom: string | null;
  purchaseUomQuantity: number | null;
  piecesPerPurchaseUom: number | null;
  quotedUnitCostMills: number;
  quotedTotalCents: null;
  pricingRemainderMills: number;
  quoteReference: string | null;
  quotedAt: Date;
  quoteValidUntil: string | null;
  discountCents: 0;
  taxCents: 0;
  lineTotalCents: number;
  lineType: "product";
  status: "open";
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatedRecommendationPurchaseOrderLine extends NewRecommendationPurchaseOrderLine {
  id: number;
}

export interface NewRecommendationDecisionRecord extends Omit<RecommendationDecisionRecord, "id"> {}

export interface NewRecommendationPoHandoffRecord extends Omit<RecommendationPoHandoffRecord, "id"> {}

export interface RecommendationPoHandoffUnitOfWork {
  lockRecommendationKeys(keys: readonly string[]): Promise<void>;
  getTransactionClock(): Promise<{ timestamp: Date; date: string }>;
  getAutoDraftRunForUpdate(id: number): Promise<RecommendationAutoDraftRunRecord | null>;
  completeAutoDraftRun(id: number, values: {
    status: "success";
    heartbeatAt: Date;
    leaseExpiresAt: null;
    itemsAnalyzed: number;
    posCreated: number;
    posUpdated: 0;
    linesAdded: number;
    skippedNoVendor: number;
    skippedOnOrder: number;
    skippedExcluded: number;
    errorMessage: null;
    summaryJson: Record<string, unknown>;
    finishedAt: Date;
  }): Promise<boolean>;
  getDecisionsForUpdate(ids: readonly number[]): Promise<RecommendationDecisionRecord[]>;
  getLatestActiveDecisions(
    keys: ReadonlyArray<{ recommendationId: string; kind: RecommendationKind }>,
  ): Promise<RecommendationDecisionRecord[]>;
  getLatestActiveDecisionsByRecommendationIds(
    recommendationIds: readonly string[],
  ): Promise<RecommendationDecisionRecord[]>;
  getHandoffsByAcceptedDecisionIds(ids: readonly number[]): Promise<RecommendationPoHandoffRecord[]>;
  getVendorProducts(ids: readonly number[]): Promise<RecommendationVendorProductRecord[]>;
  getVendors(ids: readonly number[]): Promise<RecommendationVendorRecord[]>;
  getProducts(ids: readonly number[]): Promise<RecommendationProductRecord[]>;
  getProductVariants(ids: readonly number[]): Promise<RecommendationProductVariantRecord[]>;
  createPurchaseOrder(
    values: NewRecommendationPurchaseOrder,
    numberDate: Date,
  ): Promise<CreatedRecommendationPurchaseOrder>;
  createPurchaseOrderLine(
    values: NewRecommendationPurchaseOrderLine,
  ): Promise<CreatedRecommendationPurchaseOrderLine>;
  createStatusHistory(values: {
    purchaseOrderId: number;
    fromStatus: null;
    toStatus: "draft";
    changedBy: string | null;
    notes: string;
    changedAt: Date;
  }): Promise<void>;
  createPoEvent(values: {
    poId: number;
    eventType: "created";
    actorType: "user" | "system";
    actorId: string;
    payloadJson: Record<string, unknown>;
    createdAt: Date;
  }): Promise<void>;
  createDecision(values: NewRecommendationDecisionRecord): Promise<RecommendationDecisionRecord>;
  createHandoff(values: NewRecommendationPoHandoffRecord): Promise<RecommendationPoHandoffRecord>;
}

export interface RecommendationPoHandoffRepository {
  transaction<T>(work: (unitOfWork: RecommendationPoHandoffUnitOfWork) => Promise<T>): Promise<T>;
}

export interface AcceptedRecommendationPoHandoffResult {
  pos: CreatedRecommendationPurchaseOrder[];
  decisions: RecommendationDecisionRecord[];
  handedOff: Array<{
    acceptedDecisionId: number;
    handoffDecisionId: number;
    recommendationId: string;
    kind: RecommendationKind;
    sku: string | null;
    poId: number;
    poLineId: number;
    poIds: number[];
  }>;
}

export interface AutomaticRecommendationPoHandoffResult extends AcceptedRecommendationPoHandoffResult {
  skipped: Array<{
    recommendationId: string;
    kind: "auto_draft_eligible";
    reason: "changed_after_run_started";
    latestDecisionId: number;
  }>;
}

export class RecommendationPoHandoffError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "RecommendationPoHandoffError";
  }
}

type ResolvedHandoffItem = AcceptedRecommendationPoHandoffItem & {
  acceptedDecision: RecommendationDecisionRecord;
  acceptedBasis: AcceptedRecommendationEconomicBasis;
  liveQuote: ExplicitSupplierQuote;
  vendorProduct: RecommendationVendorProductRecord;
  vendor: RecommendationVendorRecord;
  product: RecommendationProductRecord;
  variant: RecommendationProductVariantRecord;
  normalizedPricing: NormalizedPoLinePricing;
  unitCostMills: number;
  unitCostCents: number;
  totalProductCostCents: number;
  lineTotalCents: number;
};

type AcceptedDecisionBinding = {
  decision: RecommendationDecisionRecord;
  basis: AcceptedRecommendationEconomicBasis;
};

function recommendationKey(recommendationId: string, kind: string): string {
  return JSON.stringify([recommendationId, kind]);
}

function recommendationMutationLockKey(recommendationId: string): string {
  return JSON.stringify([recommendationId, "po_mutation"]);
}

function parseInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  input: unknown,
  code: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new RecommendationPoHandoffError(
      parsed.error.issues[0]?.message ?? "Invalid recommendation handoff input",
      400,
      code,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data as z.output<TSchema>;
}

function mapById<T extends { id: number }>(rows: readonly T[]): Map<number, T> {
  return new Map(rows.map((row) => [row.id, row]));
}

function assertCompleteLookup(
  requestedIds: readonly number[],
  rows: readonly { id: number }[],
  entity: string,
): void {
  const found = new Set(rows.map((row) => row.id));
  const missingIds = requestedIds.filter((id) => !found.has(id));
  if (missingIds.length > 0) {
    throw new RecommendationPoHandoffError(
      `${entity} records changed or no longer exist`,
      409,
      "RECOMMENDATION_HANDOFF_REFERENCE_MISSING",
      { entity, missingIds },
    );
  }
}

function latestDecisionMap(rows: readonly RecommendationDecisionRecord[]): Map<string, RecommendationDecisionRecord> {
  const latest = new Map<string, RecommendationDecisionRecord>();
  for (const row of rows) {
    const key = recommendationKey(row.recommendationId, row.kind);
    const current = latest.get(key);
    if (!current) {
      latest.set(key, row);
      continue;
    }
    const timeDelta = row.decidedAt.getTime() - current.decidedAt.getTime();
    if (timeDelta > 0 || (timeDelta === 0 && row.id > current.id)) latest.set(key, row);
  }
  return latest;
}

function latestDecisionByRecommendationId(
  rows: readonly RecommendationDecisionRecord[],
): Map<string, RecommendationDecisionRecord> {
  const latest = new Map<string, RecommendationDecisionRecord>();
  for (const row of rows) {
    const current = latest.get(row.recommendationId);
    if (!current) {
      latest.set(row.recommendationId, row);
      continue;
    }
    const timeDelta = row.decidedAt.getTime() - current.decidedAt.getTime();
    if (timeDelta > 0 || (timeDelta === 0 && row.id > current.id)) {
      latest.set(row.recommendationId, row);
    }
  }
  return latest;
}

function safeMoneySum(values: readonly number[], field: string): number {
  const total = values.reduce((sum, value) => sum + BigInt(value), BigInt(0));
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RecommendationPoHandoffError(
      `${field} exceeds the supported integer range`,
      409,
      "RECOMMENDATION_HANDOFF_MONEY_OUT_OF_RANGE",
      { field },
    );
  }
  return Number(total);
}

function normalizeUnitOfMeasure(label: string): string {
  const token = label.trim().split(/\s+/)[0]?.toLowerCase() ?? "each";
  return token.slice(0, 20) || "each";
}

function resolveAuditActor(actorId: string): {
  databaseUserId: string | null;
  eventActorType: "user" | "system";
  eventActorId: string;
} {
  if (actorId === "SYSTEM" || actorId.startsWith("system:")) {
    return {
      databaseUserId: null,
      eventActorType: "system",
      eventActorId: actorId === "SYSTEM" ? "system:auto" : actorId,
    };
  }
  return { databaseUserId: actorId, eventActorType: "user", eventActorId: actorId };
}

function isHandoffUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== "23505") return false;
  return typeof candidate.constraint === "string" && (
    candidate.constraint.startsWith("purch_rec_po_handoff_") ||
    candidate.constraint.startsWith("purch_rec_decisions_auto_draft_")
  );
}

function assertAcceptedDecisions(
  items: readonly AcceptedRecommendationPoHandoffItem[],
  decisions: readonly RecommendationDecisionRecord[],
  latestDecisions: readonly RecommendationDecisionRecord[],
  existingHandoffs: readonly RecommendationPoHandoffRecord[],
): Map<number, AcceptedDecisionBinding> {
  const decisionById = mapById(decisions);
  const bindingById = new Map<number, AcceptedDecisionBinding>();
  const latestByKey = latestDecisionMap(latestDecisions);
  const handedOffIds = new Set(existingHandoffs.map((row) => row.acceptedDecisionId));

  for (const item of items) {
    const decision = decisionById.get(item.acceptedDecisionId);
    if (!decision) {
      throw new RecommendationPoHandoffError(
        `Accepted decision ${item.acceptedDecisionId} no longer exists`,
        409,
        "ACCEPTED_RECOMMENDATION_DECISION_MISSING",
        { acceptedDecisionId: item.acceptedDecisionId },
      );
    }
    if (
      decision.recommendationId !== item.recommendationId ||
      decision.kind !== item.kind ||
      decision.status !== "active" ||
      decision.decision !== "accepted_for_po"
    ) {
      throw new RecommendationPoHandoffError(
        "The selected decision is not an active acceptance for this recommendation",
        409,
        "ACCEPTED_RECOMMENDATION_DECISION_MISMATCH",
        { acceptedDecisionId: item.acceptedDecisionId },
      );
    }
    if (decision.productId !== null && decision.productId !== item.productId) {
      throw new RecommendationPoHandoffError(
        "The accepted recommendation product changed before PO creation",
        409,
        "ACCEPTED_RECOMMENDATION_PRODUCT_CHANGED",
        { acceptedDecisionId: item.acceptedDecisionId },
      );
    }
    if (decision.productVariantId !== null && decision.productVariantId !== item.productVariantId) {
      throw new RecommendationPoHandoffError(
        "The accepted recommendation receive configuration changed before PO creation",
        409,
        "ACCEPTED_RECOMMENDATION_VARIANT_CHANGED",
        { acceptedDecisionId: item.acceptedDecisionId },
      );
    }

    const latest = latestByKey.get(recommendationKey(item.recommendationId, item.kind));
    if (!latest || latest.id !== decision.id) {
      throw new RecommendationPoHandoffError(
        "The accepted recommendation decision is no longer current",
        409,
        "ACCEPTED_RECOMMENDATION_DECISION_STALE",
        { acceptedDecisionId: item.acceptedDecisionId, latestDecisionId: latest?.id ?? null },
      );
    }
    if (handedOffIds.has(item.acceptedDecisionId)) {
      throw new RecommendationPoHandoffError(
        "This accepted recommendation has already been handed off to a purchase order",
        409,
        "ACCEPTED_RECOMMENDATION_ALREADY_HANDED_OFF",
        { acceptedDecisionId: item.acceptedDecisionId },
      );
    }

    const snapshot = decision.recommendationSnapshot;
    const snapshotItem = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? (snapshot as Record<string, unknown>).item
      : null;
    const parsedBasis = acceptedRecommendationEconomicBasisSchema.safeParse(snapshotItem);
    if (!parsedBasis.success) {
      throw new RecommendationPoHandoffError(
        "The accepted recommendation does not contain a complete economic basis",
        409,
        "ACCEPTED_RECOMMENDATION_ECONOMIC_BASIS_MISSING",
        { acceptedDecisionId: item.acceptedDecisionId, issues: parsedBasis.error.issues },
      );
    }

    const comparisons: Array<{ field: string; accepted: number; requested: number }> = [
      { field: "productId", accepted: parsedBasis.data.productId, requested: item.productId },
      { field: "productVariantId", accepted: parsedBasis.data.productVariantId, requested: item.productVariantId },
      { field: "preferredVendorId", accepted: parsedBasis.data.preferredVendorId, requested: item.vendorId },
      { field: "vendorProductId", accepted: parsedBasis.data.vendorProductId, requested: item.vendorProductId },
      { field: "suggestedOrderPieces", accepted: parsedBasis.data.suggestedOrderPieces, requested: item.suggestedPieces },
      { field: "orderUomUnits", accepted: parsedBasis.data.orderUomUnits, requested: item.orderUomUnits },
    ];
    const changed = comparisons.find((comparison) => comparison.accepted !== comparison.requested);
    if (changed) {
      throw new RecommendationPoHandoffError(
        `The accepted recommendation ${changed.field} changed before PO creation`,
        409,
        "ACCEPTED_RECOMMENDATION_ECONOMICS_CHANGED",
        {
          acceptedDecisionId: item.acceptedDecisionId,
          field: changed.field,
          accepted: changed.accepted,
          requested: changed.requested,
        },
      );
    }
    bindingById.set(item.acceptedDecisionId, { decision, basis: parsedBasis.data });
  }

  return bindingById;
}

function assertNoNewerDecisionAcrossKinds(
  items: readonly AcceptedRecommendationPoHandoffItem[],
  acceptedById: ReadonlyMap<number, AcceptedDecisionBinding>,
  decisions: readonly RecommendationDecisionRecord[],
): void {
  const latestByRecommendation = latestDecisionByRecommendationId(decisions);
  for (const item of items) {
    const accepted = acceptedById.get(item.acceptedDecisionId)!.decision;
    const latest = latestByRecommendation.get(item.recommendationId);
    if (!latest || latest.id === accepted.id) continue;
    const timeDelta = latest.decidedAt.getTime() - accepted.decidedAt.getTime();
    if (timeDelta < 0 || (timeDelta === 0 && latest.id < accepted.id)) continue;
    throw new RecommendationPoHandoffError(
      "The recommendation has a newer decision in another review path",
      409,
      "ACCEPTED_RECOMMENDATION_CROSS_KIND_STALE",
      {
        acceptedDecisionId: accepted.id,
        latestDecisionId: latest.id,
        latestKind: latest.kind,
        latestDecision: latest.decision,
      },
    );
  }
}

function normalizeRecommendationSupplierQuote(
  quote: ExplicitSupplierQuote,
  suggestedPieces: number,
): NormalizedPoLinePricing {
  if (quote.pricingBasis === "per_piece") {
    return normalizePoLinePricing({
      basis: "per_piece",
      quantityPieces: suggestedPieces,
      unitCostMills: quote.quotedUnitCostMills,
    });
  }

  const piecesPerUom = quote.piecesPerPurchaseUom;
  if (piecesPerUom === null || suggestedPieces % piecesPerUom !== 0) {
    throw new RecommendationPoHandoffError(
      "Recommended pieces must be divisible by the vendor's quoted purchase-UOM quantity",
      409,
      "RECOMMENDATION_PURCHASE_UOM_QUANTITY_MISMATCH",
      { suggestedPieces, piecesPerPurchaseUom: piecesPerUom },
    );
  }
  const purchaseUomQuantity = suggestedPieces / piecesPerUom;
  if (!Number.isInteger(purchaseUomQuantity) || purchaseUomQuantity > POSTGRES_INTEGER_MAX) {
    throw new RecommendationPoHandoffError(
      "The derived purchase-UOM quantity exceeds the PostgreSQL INTEGER range",
      409,
      "RECOMMENDATION_PURCHASE_UOM_QUANTITY_OUT_OF_RANGE",
      { suggestedPieces, piecesPerPurchaseUom: piecesPerUom, purchaseUomQuantity },
    );
  }
  return normalizePoLinePricing({
    basis: "per_purchase_uom",
    purchaseUom: quote.purchaseUom ?? "",
    uomQuantity: purchaseUomQuantity,
    piecesPerUom,
    quotedCostMillsPerUom: quote.quotedUnitCostMills,
  });
}

function requireLiveExplicitSupplierQuote(
  vendorProduct: RecommendationVendorProductRecord,
): ExplicitSupplierQuote {
  if (vendorProduct.pricingBasis === "legacy_unknown") {
    throw new RecommendationPoHandoffError(
      "The supplier catalog price basis must be confirmed before recommendation PO handoff",
      409,
      "RECOMMENDATION_VENDOR_QUOTE_BASIS_REVIEW_REQUIRED",
      { vendorProductId: vendorProduct.id, pricingBasis: vendorProduct.pricingBasis },
    );
  }
  const parsed = z.object({
    pricingBasis: supplierPricingBasisSchema,
    purchaseUom: nullableBoundedString(50),
    quotedUnitCostMills: nonnegativeSafeInteger,
    piecesPerPurchaseUom: positivePostgresInteger.nullable(),
    quoteReference: nullableBoundedStoredString(255),
    quotedAt: z.date(),
    quoteValidUntil: isoDateOnlySchema.nullable(),
  }).superRefine(validateExplicitSupplierQuote).safeParse(vendorProduct);
  if (!parsed.success) {
    throw new RecommendationPoHandoffError(
      "The supplier catalog quote is incomplete and must be reviewed before PO handoff",
      409,
      "RECOMMENDATION_VENDOR_QUOTE_INVALID",
      { vendorProductId: vendorProduct.id, issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

function requireValidSupplierMinimumOrder(
  vendorProduct: RecommendationVendorProductRecord,
): number | null {
  if (vendorProduct.moq === null) return null;
  if (
    !Number.isSafeInteger(vendorProduct.moq) ||
    vendorProduct.moq <= 0 ||
    vendorProduct.moq > POSTGRES_INTEGER_MAX
  ) {
    throw new RecommendationPoHandoffError(
      "The supplier catalog MOQ must be a positive whole number of base pieces",
      409,
      "RECOMMENDATION_VENDOR_MOQ_INVALID",
      { vendorProductId: vendorProduct.id, minimumOrderPieces: vendorProduct.moq },
    );
  }
  return vendorProduct.moq;
}

function assertAcceptedMinimumOrderStillCurrent(
  acceptedMinimumOrderPieces: number | null,
  liveMinimumOrderPieces: number | null,
  suggestedPieces: number,
  vendorProductId: number,
): void {
  if (acceptedMinimumOrderPieces !== liveMinimumOrderPieces) {
    throw new RecommendationPoHandoffError(
      "The supplier minimum order changed after the recommendation was accepted",
      409,
      "RECOMMENDATION_VENDOR_MOQ_CHANGED",
      {
        vendorProductId,
        acceptedMinimumOrderPieces,
        currentMinimumOrderPieces: liveMinimumOrderPieces,
      },
    );
  }
  const effectiveMinimumOrderPieces = liveMinimumOrderPieces ?? 1;
  if (suggestedPieces < effectiveMinimumOrderPieces) {
    throw new RecommendationPoHandoffError(
      "The accepted recommendation no longer meets the supplier minimum order",
      409,
      "RECOMMENDATION_VENDOR_MOQ_NOT_MET",
      { vendorProductId, suggestedPieces, minimumOrderPieces: liveMinimumOrderPieces },
    );
  }
}

function assertLiveSupplierQuoteIsUsable(
  vendorProduct: RecommendationVendorProductRecord,
  liveQuote: ExplicitSupplierQuote,
  clock: { timestamp: Date; date: string },
): void {
  const validity = assessSupplierQuoteValidity({
    quotedAt: liveQuote.quotedAt,
    quotedAtDate: vendorProduct.quotedAtDate,
    quoteValidUntil: liveQuote.quoteValidUntil,
    asOf: clock.timestamp,
    currentDate: clock.date,
  });
  if (validity.status === "current") return;

  const codeByStatus: Record<string, string> = {
    future: "RECOMMENDATION_VENDOR_QUOTE_FUTURE_DATED",
    expired: "RECOMMENDATION_VENDOR_QUOTE_EXPIRED",
    stale: "RECOMMENDATION_VENDOR_QUOTE_STALE",
    missing: "RECOMMENDATION_VENDOR_QUOTE_INVALID",
    invalid: "RECOMMENDATION_VENDOR_QUOTE_INVALID",
  };
  const messageByStatus: Record<string, string> = {
    future: "The supplier quote is future-dated and cannot be used for PO handoff",
    expired: "The supplier quote expired before PO handoff",
    stale: `The supplier quote is older than the ${RECOMMENDATION_SUPPLIER_QUOTE_MAX_AGE_DAYS}-day automation limit`,
    missing: "The supplier quote has no verification timestamp",
    invalid: "The supplier quote validity metadata is invalid",
  };
  throw new RecommendationPoHandoffError(
    messageByStatus[validity.status] ?? "The supplier quote is not valid for PO handoff",
    409,
    codeByStatus[validity.status] ?? "RECOMMENDATION_VENDOR_QUOTE_INVALID",
    {
      vendorProductId: vendorProduct.id,
      quotedAt: liveQuote.quotedAt.toISOString(),
      quoteValidUntil: liveQuote.quoteValidUntil,
      transactionTimestamp: clock.timestamp.toISOString(),
      transactionDate: clock.date,
      quoteAgeDays: validity.ageDays,
      maxQuoteAgeDays: validity.maxAgeDays,
    },
  );
}

function comparableQuoteValue(value: ExplicitSupplierQuote[keyof ExplicitSupplierQuote]): string | number | null {
  return value instanceof Date ? value.toISOString() : value;
}

function assertAcceptedQuoteStillCurrent(
  accepted: ExplicitSupplierQuote,
  live: ExplicitSupplierQuote,
  vendorProductId: number,
): void {
  const fields: Array<keyof ExplicitSupplierQuote> = [
    "pricingBasis",
    "purchaseUom",
    "quotedUnitCostMills",
    "piecesPerPurchaseUom",
    "quoteReference",
    "quotedAt",
    "quoteValidUntil",
  ];
  const changedField = fields.find(
    (field) => comparableQuoteValue(accepted[field]) !== comparableQuoteValue(live[field]),
  );
  if (!changedField) return;
  throw new RecommendationPoHandoffError(
    "The supplier quote changed after the recommendation was accepted",
    409,
    "RECOMMENDATION_VENDOR_QUOTE_CHANGED",
    {
      vendorProductId,
      field: changedField,
      accepted: comparableQuoteValue(accepted[changedField]),
      current: comparableQuoteValue(live[changedField]),
    },
  );
}

function resolveCatalogRows(
  items: readonly AcceptedRecommendationPoHandoffItem[],
  acceptedById: ReadonlyMap<number, AcceptedDecisionBinding>,
  vendorProducts: readonly RecommendationVendorProductRecord[],
  vendors: readonly RecommendationVendorRecord[],
  products: readonly RecommendationProductRecord[],
  variants: readonly RecommendationProductVariantRecord[],
  clock: { timestamp: Date; date: string },
): ResolvedHandoffItem[] {
  const vendorProductById = mapById(vendorProducts);
  const vendorById = mapById(vendors);
  const productById = mapById(products);
  const variantById = mapById(variants);

  return items.map((item) => {
    const acceptedBinding = acceptedById.get(item.acceptedDecisionId)!;
    const acceptedDecision = acceptedBinding.decision;
    const acceptedBasis = acceptedBinding.basis;
    const vendorProduct = vendorProductById.get(item.vendorProductId)!;
    const vendor = vendorById.get(item.vendorId)!;
    const product = productById.get(item.productId)!;
    const variant = variantById.get(item.productVariantId)!;

    if (vendor.active !== 1) {
      throw new RecommendationPoHandoffError("The selected vendor is inactive", 409, "RECOMMENDATION_VENDOR_INACTIVE", {
        vendorId: vendor.id,
      });
    }
    if (!product.isActive || product.status === "archived") {
      throw new RecommendationPoHandoffError("The recommended product is inactive", 409, "RECOMMENDATION_PRODUCT_INACTIVE", {
        productId: product.id,
      });
    }
    if (!variant.isActive || variant.productId !== product.id) {
      throw new RecommendationPoHandoffError(
        "The receive configuration is inactive or belongs to another product",
        409,
        "RECOMMENDATION_VARIANT_INVALID",
        { productVariantId: variant.id, productId: product.id },
      );
    }
    if (
      vendorProduct.vendorId !== vendor.id ||
      vendorProduct.productId !== product.id ||
      (vendorProduct.productVariantId !== null && vendorProduct.productVariantId !== variant.id)
    ) {
      throw new RecommendationPoHandoffError(
        "The selected supplier catalog row no longer matches the vendor, product, and receive configuration",
        409,
        "RECOMMENDATION_VENDOR_PRODUCT_MISMATCH",
        { vendorProductId: vendorProduct.id },
      );
    }
    if (vendorProduct.isActive !== 1 || vendorProduct.isPreferred !== 1) {
      throw new RecommendationPoHandoffError(
        "The selected supplier catalog row is no longer active and preferred",
        409,
        "RECOMMENDATION_VENDOR_PRODUCT_INACTIVE",
        { vendorProductId: vendorProduct.id },
      );
    }

    const liveMinimumOrderPieces = requireValidSupplierMinimumOrder(vendorProduct);
    assertAcceptedMinimumOrderStillCurrent(
      acceptedBasis.supplierBasis.minimumOrderPieces,
      liveMinimumOrderPieces,
      item.suggestedPieces,
      vendorProduct.id,
    );

    const acceptedQuote: ExplicitSupplierQuote = {
      pricingBasis: acceptedBasis.pricingBasis,
      purchaseUom: acceptedBasis.purchaseUom,
      quotedUnitCostMills: acceptedBasis.quotedUnitCostMills,
      piecesPerPurchaseUom: acceptedBasis.piecesPerPurchaseUom,
      quoteReference: acceptedBasis.quoteReference,
      quotedAt: acceptedBasis.quotedAt,
      quoteValidUntil: acceptedBasis.quoteValidUntil,
    };
    const liveQuote = requireLiveExplicitSupplierQuote(vendorProduct);
    assertLiveSupplierQuoteIsUsable(vendorProduct, liveQuote, clock);
    assertAcceptedQuoteStillCurrent(acceptedQuote, liveQuote, vendorProduct.id);

    let normalizedPricing: NormalizedPoLinePricing;
    try {
      normalizedPricing = normalizeRecommendationSupplierQuote(liveQuote, item.suggestedPieces);
    } catch (error) {
      if (error instanceof RecommendationPoHandoffError) throw error;
      throw new RecommendationPoHandoffError(
        `The supplier quote is invalid: ${(error as Error).message}`,
        409,
        "RECOMMENDATION_VENDOR_QUOTE_INVALID",
        { vendorProductId: vendorProduct.id },
      );
    }

    if (
      vendorProduct.unitCostMills !== normalizedPricing.unitCostMills ||
      vendorProduct.unitCostCents !== normalizedPricing.unitCostCents
    ) {
      throw new RecommendationPoHandoffError(
        "The supplier catalog's normalized cost does not agree with its original quote",
        409,
        "RECOMMENDATION_VENDOR_QUOTE_NORMALIZATION_INVALID",
        {
          vendorProductId: vendorProduct.id,
          expectedUnitCostMills: normalizedPricing.unitCostMills,
          currentUnitCostMills: vendorProduct.unitCostMills,
        },
      );
    }
    if (
      (acceptedBasis.estimatedCostMills !== null && acceptedBasis.estimatedCostMills !== normalizedPricing.unitCostMills) ||
      (acceptedBasis.estimatedCostCents !== null && acceptedBasis.estimatedCostCents !== normalizedPricing.unitCostCents)
    ) {
      throw new RecommendationPoHandoffError(
        "The accepted recommendation's normalized cost does not agree with its supplier quote",
        409,
        "ACCEPTED_RECOMMENDATION_QUOTE_NORMALIZATION_INVALID",
        {
          acceptedDecisionId: acceptedDecision.id,
          expectedUnitCostMills: normalizedPricing.unitCostMills,
          acceptedUnitCostMills: acceptedBasis.estimatedCostMills,
        },
      );
    }

    return {
      ...item,
      acceptedDecision,
      acceptedBasis,
      liveQuote,
      vendorProduct,
      vendor,
      product,
      variant,
      normalizedPricing,
      unitCostMills: normalizedPricing.unitCostMills,
      unitCostCents: normalizedPricing.unitCostCents,
      totalProductCostCents: normalizedPricing.totalProductCostCents,
      lineTotalCents: normalizedPricing.totalProductCostCents,
    };
  });
}

async function loadResolvedHandoffItems(
  unitOfWork: RecommendationPoHandoffUnitOfWork,
  items: readonly AcceptedRecommendationPoHandoffItem[],
  acceptedById: ReadonlyMap<number, AcceptedDecisionBinding>,
  clock: { timestamp: Date; date: string },
): Promise<ResolvedHandoffItem[]> {
  const vendorProductIds = [...new Set(items.map((item) => item.vendorProductId))];
  const vendorIds = [...new Set(items.map((item) => item.vendorId))];
  const productIds = [...new Set(items.map((item) => item.productId))];
  const variantIds = [...new Set(items.map((item) => item.productVariantId))];
  const vendors = await unitOfWork.getVendors(vendorIds);
  const products = await unitOfWork.getProducts(productIds);
  const variants = await unitOfWork.getProductVariants(variantIds);
  const vendorProducts = await unitOfWork.getVendorProducts(vendorProductIds);
  assertCompleteLookup(vendorIds, vendors, "vendor");
  assertCompleteLookup(productIds, products, "product");
  assertCompleteLookup(variantIds, variants, "product variant");
  assertCompleteLookup(vendorProductIds, vendorProducts, "vendor product");

  return resolveCatalogRows(items, acceptedById, vendorProducts, vendors, products, variants, clock);
}

type HandoffPersistenceOptions = {
  actorId: string;
  now: Date;
  decisionSource: "operator" | "auto_draft";
  autoDraftRunId: number | null;
  poSource: "reorder" | "auto_draft";
  autoDraftDate: string | null;
  metadataSource: "accepted_recommendation_handoff" | "automatic_recommendation_handoff";
  statusHistoryNotes: string;
  handoffDecisionReason: string;
};

async function persistResolvedHandoffs(
  unitOfWork: RecommendationPoHandoffUnitOfWork,
  resolvedItems: readonly ResolvedHandoffItem[],
  options: HandoffPersistenceOptions,
): Promise<AcceptedRecommendationPoHandoffResult> {
  const auditActor = resolveAuditActor(options.actorId);
  const byVendor = new Map<number, ResolvedHandoffItem[]>();
  for (const item of resolvedItems) {
    const group = byVendor.get(item.vendorId) ?? [];
    group.push(item);
    byVendor.set(item.vendorId, group);
  }

  const pos: CreatedRecommendationPurchaseOrder[] = [];
  const decisions: RecommendationDecisionRecord[] = [];
  const handedOff: AcceptedRecommendationPoHandoffResult["handedOff"] = [];

  for (const vendorId of [...byVendor.keys()].sort((left, right) => left - right)) {
    const group = byVendor.get(vendorId)!;
    const vendor = group[0].vendor;
    const subtotalCents = safeMoneySum(
      group.map((item) => item.lineTotalCents),
      "purchase order subtotal",
    );
    const po = await unitOfWork.createPurchaseOrder({
      vendorId,
      status: "draft",
      physicalStatus: "draft",
      financialStatus: "unbilled",
      poType: "standard",
      priority: "normal",
      currency: vendor.currency || "USD",
      paymentTermsDays: vendor.paymentTermsDays,
      paymentTermsType: vendor.paymentTermsType,
      shipFromAddress: vendor.shipFromAddress,
      incoterms: vendor.defaultIncoterms,
      subtotalCents,
      totalCents: subtotalCents,
      lineCount: group.length,
      source: options.poSource,
      autoDraftDate: options.autoDraftDate,
      createdBy: auditActor.databaseUserId,
      updatedBy: auditActor.databaseUserId,
      metadata: {
        source: options.metadataSource,
        acceptedDecisionIds: group.map((item) => item.acceptedDecisionId),
        autoDraftRunId: options.autoDraftRunId,
        createdAt: options.now.toISOString(),
      },
      createdAt: options.now,
      updatedAt: options.now,
    }, options.now);
    pos.push(po);

    await unitOfWork.createStatusHistory({
      purchaseOrderId: po.id,
      fromStatus: null,
      toStatus: "draft",
      changedBy: auditActor.databaseUserId,
      notes: options.statusHistoryNotes,
      changedAt: options.now,
    });
    await unitOfWork.createPoEvent({
      poId: po.id,
      eventType: "created",
      actorType: auditActor.eventActorType,
      actorId: auditActor.eventActorId,
      payloadJson: {
        source: options.metadataSource,
        line_count: group.length,
        subtotal_cents: subtotalCents,
        accepted_decision_ids: group.map((item) => item.acceptedDecisionId),
        recommendation_ids: group.map((item) => item.recommendationId),
        auto_draft_run_id: options.autoDraftRunId,
      },
      createdAt: options.now,
    });

    for (let index = 0; index < group.length; index += 1) {
      const item = group[index];
      const line = await unitOfWork.createPurchaseOrderLine({
        purchaseOrderId: po.id,
        lineNumber: index + 1,
        productId: item.product.id,
        productVariantId: item.variant.id,
        expectedReceiveVariantId: item.variant.id,
        vendorProductId: item.vendorProduct.id,
        sku: item.product.sku || item.variant.sku || item.sku,
        productName: item.product.name,
        vendorSku: item.vendorProduct.vendorSku,
        unitOfMeasure: normalizeUnitOfMeasure(item.orderUomLabel),
        unitsPerUom: item.variant.unitsPerVariant,
        expectedReceiveUnitsPerVariant: item.variant.unitsPerVariant,
        orderQty: item.suggestedPieces,
        unitCostCents: item.unitCostCents,
        unitCostMills: item.unitCostMills,
        totalProductCostCents: item.totalProductCostCents,
        packagingCostCents: 0,
        pricingBasis: item.acceptedBasis.pricingBasis,
        pricingSource: "recommendation",
        purchaseUom: item.normalizedPricing.purchaseUom,
        purchaseUomQuantity: item.normalizedPricing.purchaseUomQuantity,
        piecesPerPurchaseUom: item.normalizedPricing.piecesPerPurchaseUom,
        quotedUnitCostMills: item.normalizedPricing.quotedUnitCostMills!,
        quotedTotalCents: null,
        pricingRemainderMills: item.normalizedPricing.pricingRemainderMills,
        quoteReference: item.liveQuote.quoteReference,
        quotedAt: item.liveQuote.quotedAt,
        quoteValidUntil: item.liveQuote.quoteValidUntil,
        discountCents: 0,
        taxCents: 0,
        lineTotalCents: item.lineTotalCents,
        lineType: "product",
        status: "open",
        createdAt: options.now,
        updatedAt: options.now,
      });
      const decision = await unitOfWork.createDecision({
        recommendationId: item.recommendationId,
        kind: item.kind,
        decision: "po_handoff_created",
        status: "active",
        decisionReason: options.handoffDecisionReason,
        note: null,
        source: options.decisionSource,
        autoDraftRunId: options.autoDraftRunId,
        productId: item.product.id,
        productVariantId: item.variant.id,
        vendorId: item.vendor.id,
        sku: item.sku,
        productName: item.productName,
        candidateScore: item.candidateScore,
        candidateBand: item.candidateBand,
        recommendationSnapshot: {
          ...item.recommendationSnapshot,
          poHandoff: {
            acceptedDecisionId: item.acceptedDecisionId,
            poId: po.id,
            poLineId: line.id,
            poNumber: po.poNumber,
          },
        },
        decidedBy: options.actorId,
        decidedAt: options.now,
        createdAt: options.now,
      });
      await unitOfWork.createHandoff({
        acceptedDecisionId: item.acceptedDecisionId,
        handoffDecisionId: decision.id,
        purchaseOrderId: po.id,
        purchaseOrderLineId: line.id,
        recommendationId: item.recommendationId,
        kind: item.kind,
        createdBy: auditActor.databaseUserId,
        createdAt: options.now,
      });

      decisions.push(decision);
      handedOff.push({
        acceptedDecisionId: item.acceptedDecisionId,
        handoffDecisionId: decision.id,
        recommendationId: item.recommendationId,
        kind: item.kind,
        sku: item.sku,
        poId: po.id,
        poLineId: line.id,
        poIds: [po.id],
      });
    }
  }

  return { pos, decisions, handedOff };
}

function buildAutomaticRunSummary(
  baseSummary: Record<string, unknown>,
  persisted: AcceptedRecommendationPoHandoffResult,
  skipped: AutomaticRecommendationPoHandoffResult["skipped"],
): Record<string, unknown> {
  return {
    ...baseSummary,
    poMutations: persisted.pos.map((po) => ({
      vendorId: po.vendorId,
      poId: po.id,
      action: "created",
      linesAdded: persisted.handedOff.filter((item) => item.poId === po.id).length,
    })),
    poMutationSkips: skipped,
  };
}

async function completeAutomaticRun(
  unitOfWork: RecommendationPoHandoffUnitOfWork,
  input: AutomaticRecommendationPoHandoffCommand,
  persisted: AcceptedRecommendationPoHandoffResult,
  skipped: AutomaticRecommendationPoHandoffResult["skipped"],
  now: Date,
): Promise<void> {
  const completed = await unitOfWork.completeAutoDraftRun(input.autoDraftRunId, {
    status: "success",
    heartbeatAt: now,
    leaseExpiresAt: null,
    itemsAnalyzed: input.completion.itemsAnalyzed,
    posCreated: persisted.pos.length,
    posUpdated: 0,
    linesAdded: persisted.handedOff.length,
    skippedNoVendor: input.completion.skippedNoVendor,
    skippedOnOrder: input.completion.skippedOnOrder,
    skippedExcluded: input.completion.skippedExcluded,
    errorMessage: null,
    summaryJson: buildAutomaticRunSummary(input.completion.summaryJson, persisted, skipped),
    finishedAt: now,
  });
  if (!completed) {
    throw new RecommendationPoHandoffError(
      "The auto-draft run changed before its PO transaction could complete",
      409,
      "AUTO_DRAFT_RUN_COMPLETION_CONFLICT",
      { autoDraftRunId: input.autoDraftRunId },
    );
  }
}

export function createRecommendationPoHandoffService(
  repository: RecommendationPoHandoffRepository,
) {
  async function recordDecision(input: unknown): Promise<RecommendationDecisionRecord> {
    const parsed = parseInput(recordDecisionSchema, input, "INVALID_RECOMMENDATION_DECISION");
    if (parsed.decision === "accepted_for_po") {
      const acceptedItem = parsed.recommendationSnapshot.item;
      const acceptedBasis = acceptedRecommendationEconomicBasisSchema.safeParse(acceptedItem);
      if (!acceptedBasis.success) {
        throw new RecommendationPoHandoffError(
          "A recommendation must have a complete quantity, supplier, and cost basis before acceptance",
          409,
          "ACCEPTED_RECOMMENDATION_ECONOMIC_BASIS_MISSING",
          { issues: acceptedBasis.error.issues },
        );
      }
    }
    const lockKey = recommendationKey(parsed.recommendationId, parsed.kind);
    const mutationLockKey = recommendationMutationLockKey(parsed.recommendationId);

    return repository.transaction(async (unitOfWork) => {
      await unitOfWork.lockRecommendationKeys([lockKey, mutationLockKey].sort());
      const { timestamp: now } = await unitOfWork.getTransactionClock();
      return unitOfWork.createDecision({
        ...parsed,
        autoDraftRunId: parsed.autoDraftRunId ?? null,
        decidedAt: now,
        createdAt: now,
      });
    });
  }

  async function createAcceptedHandoff(input: unknown): Promise<AcceptedRecommendationPoHandoffResult> {
    const parsed = parseInput(handoffCommandSchema, input, "INVALID_RECOMMENDATION_HANDOFF");
    const acceptedDecisionIds = parsed.items.map((item) => item.acceptedDecisionId);
    const uniqueAcceptedIds = new Set(acceptedDecisionIds);
    const keys = parsed.items.map((item) => recommendationKey(item.recommendationId, item.kind));
    const mutationKeys = parsed.items.map((item) => recommendationMutationLockKey(item.recommendationId));
    const uniqueKeys = new Set(keys);
    if (uniqueAcceptedIds.size !== parsed.items.length || uniqueKeys.size !== parsed.items.length) {
      throw new RecommendationPoHandoffError(
        "Each accepted recommendation may appear only once per handoff",
        400,
        "DUPLICATE_ACCEPTED_RECOMMENDATION",
      );
    }

    try {
      return await repository.transaction(async (unitOfWork) => {
        await unitOfWork.lockRecommendationKeys([...new Set([...uniqueKeys, ...mutationKeys])].sort());
        const clock = await unitOfWork.getTransactionClock();
        const now = clock.timestamp;

        const acceptedDecisions = await unitOfWork.getDecisionsForUpdate(acceptedDecisionIds);
        const latestDecisions = await unitOfWork.getLatestActiveDecisions(
          parsed.items.map((item) => ({ recommendationId: item.recommendationId, kind: item.kind })),
        );
        const latestAcrossKinds = await unitOfWork.getLatestActiveDecisionsByRecommendationIds(
          parsed.items.map((item) => item.recommendationId),
        );
        const existingHandoffs = await unitOfWork.getHandoffsByAcceptedDecisionIds(acceptedDecisionIds);
        const acceptedById = assertAcceptedDecisions(
          parsed.items,
          acceptedDecisions,
          latestDecisions,
          existingHandoffs,
        );
        assertNoNewerDecisionAcrossKinds(parsed.items, acceptedById, latestAcrossKinds);

        const resolvedItems = await loadResolvedHandoffItems(unitOfWork, parsed.items, acceptedById, clock);
        return persistResolvedHandoffs(unitOfWork, resolvedItems, {
          actorId: parsed.actorId,
          now,
          decisionSource: "operator",
          autoDraftRunId: null,
          poSource: "reorder",
          autoDraftDate: null,
          metadataSource: "accepted_recommendation_handoff",
          statusHistoryNotes: "PO created from accepted purchasing recommendations",
          handoffDecisionReason: "accepted_recommendation_po_handoff",
        });
      });
    } catch (error) {
      if (isHandoffUniqueViolation(error)) {
        throw new RecommendationPoHandoffError(
          "This accepted recommendation has already been handed off to a purchase order",
          409,
          "ACCEPTED_RECOMMENDATION_ALREADY_HANDED_OFF",
        );
      }
      throw error;
    }
  }

  async function createAutomaticHandoff(input: unknown): Promise<AutomaticRecommendationPoHandoffResult> {
    const parsed = parseInput(
      automaticHandoffCommandSchema,
      input,
      "INVALID_AUTOMATIC_RECOMMENDATION_HANDOFF",
    );
    const keys = parsed.items.map((item) => recommendationKey(item.recommendationId, "auto_draft_eligible"));
    const mutationKeys = parsed.items.map((item) => recommendationMutationLockKey(item.recommendationId));
    if (new Set(keys).size !== parsed.items.length) {
      throw new RecommendationPoHandoffError(
        "Each automatic recommendation may appear only once per run handoff",
        400,
        "DUPLICATE_AUTOMATIC_RECOMMENDATION",
      );
    }

    try {
      return await repository.transaction(async (unitOfWork) => {
        const run = await unitOfWork.getAutoDraftRunForUpdate(parsed.autoDraftRunId);
        if (!run) {
          throw new RecommendationPoHandoffError(
            "The auto-draft run no longer exists",
            409,
            "AUTO_DRAFT_RUN_MISSING",
            { autoDraftRunId: parsed.autoDraftRunId },
          );
        }
        if (run.status !== "running") {
          throw new RecommendationPoHandoffError(
            "The auto-draft run is not open for PO mutation",
            409,
            "AUTO_DRAFT_RUN_NOT_RUNNING",
            { autoDraftRunId: run.id, status: run.status },
          );
        }

        await unitOfWork.lockRecommendationKeys([...new Set([...keys, ...mutationKeys])].sort());
        const clock = await unitOfWork.getTransactionClock();
        const now = clock.timestamp;
        const runStartedAt = run.runAt instanceof Date ? run.runAt : new Date(run.runAt);
        if (Number.isNaN(runStartedAt.getTime())) {
          throw new RecommendationPoHandoffError(
            "The auto-draft run start time is invalid",
            409,
            "AUTO_DRAFT_RUN_TIMESTAMP_INVALID",
            { autoDraftRunId: run.id },
          );
        }

        const latestDecisions = await unitOfWork.getLatestActiveDecisionsByRecommendationIds(
          parsed.items.map((item) => item.recommendationId),
        );
        const latestById = latestDecisionByRecommendationId(latestDecisions);
        const skipped: AutomaticRecommendationPoHandoffResult["skipped"] = [];
        const currentItems = parsed.items.filter((item) => {
          const latest = latestById.get(item.recommendationId);
          if (!latest || latest.decidedAt.getTime() < runStartedAt.getTime()) return true;
          skipped.push({
            recommendationId: item.recommendationId,
            kind: "auto_draft_eligible",
            reason: "changed_after_run_started",
            latestDecisionId: latest.id,
          });
          return false;
        });

        const handoffItems: AcceptedRecommendationPoHandoffItem[] = [];
        const acceptedById = new Map<number, AcceptedDecisionBinding>();
        for (const item of currentItems) {
          const priorSnapshotItem = item.recommendationSnapshot.item;
          const snapshotItem = {
            ...(priorSnapshotItem && typeof priorSnapshotItem === "object" && !Array.isArray(priorSnapshotItem)
              ? priorSnapshotItem as Record<string, unknown>
              : {}),
            productId: item.productId,
            productVariantId: item.productVariantId,
            preferredVendorId: item.vendorId,
            vendorProductId: item.vendorProductId,
            suggestedOrderQty: item.suggestedOrderQty,
            suggestedOrderPieces: item.suggestedOrderPieces,
            orderUomUnits: item.orderUomUnits,
            estimatedCostMills: item.estimatedCostMills,
            estimatedCostCents: item.estimatedCostCents,
            pricingBasis: item.pricingBasis,
            purchaseUom: item.purchaseUom,
            quotedUnitCostMills: item.quotedUnitCostMills,
            piecesPerPurchaseUom: item.piecesPerPurchaseUom,
            quoteReference: item.quoteReference,
            quotedAt: item.quotedAt,
            quoteValidUntil: item.quoteValidUntil,
          };
          const parsedBasis = acceptedRecommendationEconomicBasisSchema.safeParse(snapshotItem);
          if (!parsedBasis.success) {
            throw new RecommendationPoHandoffError(
              "The automatic recommendation does not contain a complete economic basis",
              409,
              "AUTOMATIC_RECOMMENDATION_ECONOMIC_BASIS_MISSING",
              { recommendationId: item.recommendationId, issues: parsedBasis.error.issues },
            );
          }
          const recommendationSnapshot = {
            ...item.recommendationSnapshot,
            item: snapshotItem,
            autoDraft: {
              runId: run.id,
              runAt: runStartedAt.toISOString(),
              triggeredBy: run.triggeredBy,
            },
          };
          const acceptedDecision = await unitOfWork.createDecision({
            recommendationId: item.recommendationId,
            kind: "auto_draft_eligible",
            decision: "accepted_for_po",
            status: "active",
            decisionReason: "auto_draft_policy_approved",
            note: null,
            source: "auto_draft",
            autoDraftRunId: run.id,
            productId: item.productId,
            productVariantId: item.productVariantId,
            vendorId: item.vendorId,
            sku: item.sku,
            productName: item.productName,
            candidateScore: item.candidateScore,
            candidateBand: item.candidateBand,
            recommendationSnapshot,
            decidedBy: parsed.actorId,
            decidedAt: now,
            createdAt: now,
          });
          const handoffItem: AcceptedRecommendationPoHandoffItem = {
            acceptedDecisionId: acceptedDecision.id,
            recommendationId: item.recommendationId,
            kind: "auto_draft_eligible",
            productId: item.productId,
            productVariantId: item.productVariantId,
            suggestedPieces: item.suggestedOrderPieces,
            orderUomUnits: item.orderUomUnits,
            orderUomLabel: item.orderUomLabel,
            vendorId: item.vendorId,
            vendorProductId: item.vendorProductId,
            sku: item.sku,
            productName: item.productName,
            candidateScore: item.candidateScore,
            candidateBand: item.candidateBand,
            recommendationSnapshot,
          };
          handoffItems.push(handoffItem);
          acceptedById.set(acceptedDecision.id, {
            decision: acceptedDecision,
            basis: parsedBasis.data,
          });
        }

        let persisted: AcceptedRecommendationPoHandoffResult = {
          pos: [],
          decisions: [],
          handedOff: [],
        };
        if (handoffItems.length > 0) {
          const resolvedItems = await loadResolvedHandoffItems(unitOfWork, handoffItems, acceptedById, clock);
          persisted = await persistResolvedHandoffs(unitOfWork, resolvedItems, {
            actorId: parsed.actorId,
            now,
            decisionSource: "auto_draft",
            autoDraftRunId: run.id,
            poSource: "auto_draft",
            autoDraftDate: runStartedAt.toISOString().slice(0, 10),
            metadataSource: "automatic_recommendation_handoff",
            statusHistoryNotes: "PO created by the purchasing auto-draft policy",
            handoffDecisionReason: "automatic_recommendation_po_handoff",
          });
        }
        await completeAutomaticRun(unitOfWork, parsed, persisted, skipped, now);
        return { ...persisted, skipped };
      });
    } catch (error) {
      if (isHandoffUniqueViolation(error)) {
        throw new RecommendationPoHandoffError(
          "This automatic recommendation was already handled for the auto-draft run",
          409,
          "AUTOMATIC_RECOMMENDATION_ALREADY_HANDED_OFF",
          { autoDraftRunId: parsed.autoDraftRunId },
        );
      }
      throw error;
    }
  }

  return {
    recordDecision,
    createAcceptedHandoff,
    createAutomaticHandoff,
  };
}

export type RecommendationPoHandoffService = ReturnType<typeof createRecommendationPoHandoffService>;
