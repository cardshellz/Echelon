import { z } from "zod";
import { resolveRecommendationPoCost } from "./recommendation-po-cost";

const recommendationKinds = ["skipped", "held_by_policy", "quality_review_required"] as const;
const operatorDecisionValues = ["reviewed", "accepted_for_po", "deferred", "dismissed"] as const;

const positiveSafeInteger = z.number().int().positive().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});
const nonnegativeSafeInteger = z.number().int().nonnegative().refine(Number.isSafeInteger, {
  message: "must be a safe integer",
});

const nullableBoundedString = (maximum: number) => z.string().trim().max(maximum).nullable();

const handoffItemSchema = z.object({
  acceptedDecisionId: positiveSafeInteger,
  recommendationId: z.string().trim().min(1).max(160),
  kind: z.enum(recommendationKinds),
  productId: positiveSafeInteger,
  productVariantId: positiveSafeInteger,
  suggestedPieces: positiveSafeInteger,
  orderUomUnits: positiveSafeInteger,
  orderUomLabel: z.string().trim().min(1).max(100),
  vendorId: positiveSafeInteger,
  vendorProductId: positiveSafeInteger,
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

const acceptedRecommendationEconomicBasisSchema = z.object({
  productId: positiveSafeInteger,
  productVariantId: positiveSafeInteger,
  preferredVendorId: positiveSafeInteger,
  vendorProductId: positiveSafeInteger,
  suggestedOrderQty: positiveSafeInteger,
  suggestedOrderPieces: positiveSafeInteger,
  orderUomUnits: positiveSafeInteger,
  estimatedCostMills: positiveSafeInteger.nullable(),
  estimatedCostCents: nonnegativeSafeInteger.nullable(),
}).passthrough().superRefine((value, context) => {
  if (value.estimatedCostMills === null && value.estimatedCostCents === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "accepted recommendation supplier cost is required",
      path: ["estimatedCostMills"],
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
  autoDraftRunId: positiveSafeInteger.nullable().optional(),
  productId: positiveSafeInteger.nullable(),
  productVariantId: positiveSafeInteger.nullable(),
  vendorId: positiveSafeInteger.nullable(),
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

export interface RecommendationVendorProductRecord {
  id: number;
  vendorId: number;
  productId: number;
  productVariantId: number | null;
  vendorSku: string | null;
  unitCostCents: number | null;
  unitCostMills: number | null;
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
  source: "reorder";
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
  getDecisionsForUpdate(ids: readonly number[]): Promise<RecommendationDecisionRecord[]>;
  getLatestActiveDecisions(
    keys: ReadonlyArray<{ recommendationId: string; kind: RecommendationKind }>,
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
  vendorProduct: RecommendationVendorProductRecord;
  vendor: RecommendationVendorRecord;
  product: RecommendationProductRecord;
  variant: RecommendationProductVariantRecord;
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

function parseInput<T>(schema: z.ZodType<T>, input: unknown, code: string): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new RecommendationPoHandoffError(
      parsed.error.issues[0]?.message ?? "Invalid recommendation handoff input",
      400,
      code,
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
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
  return typeof candidate.constraint === "string" && candidate.constraint.startsWith("purch_rec_po_handoff_");
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

function resolveCatalogRows(
  items: readonly AcceptedRecommendationPoHandoffItem[],
  acceptedById: ReadonlyMap<number, AcceptedDecisionBinding>,
  vendorProducts: readonly RecommendationVendorProductRecord[],
  vendors: readonly RecommendationVendorRecord[],
  products: readonly RecommendationProductRecord[],
  variants: readonly RecommendationProductVariantRecord[],
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
    if (variant.unitsPerVariant !== item.orderUomUnits) {
      throw new RecommendationPoHandoffError(
        "The receive configuration quantity changed after recommendation review",
        409,
        "RECOMMENDATION_RECEIVE_UNITS_CHANGED",
        {
          productVariantId: variant.id,
          expectedUnits: item.orderUomUnits,
          actualUnits: variant.unitsPerVariant,
        },
      );
    }
    if (item.suggestedPieces % item.orderUomUnits !== 0) {
      throw new RecommendationPoHandoffError(
        "Recommended pieces must be divisible by the receive configuration quantity",
        409,
        "RECOMMENDATION_PIECES_NOT_RECEIVABLE",
        { suggestedPieces: item.suggestedPieces, orderUomUnits: item.orderUomUnits },
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

    let liveCost: ReturnType<typeof resolveRecommendationPoCost>;
    let acceptedCost: ReturnType<typeof resolveRecommendationPoCost>;
    try {
      liveCost = resolveRecommendationPoCost({
        estimatedCostMills: vendorProduct.unitCostMills,
        estimatedCostCents: vendorProduct.unitCostCents,
        orderQtyPieces: item.suggestedPieces,
      });
      acceptedCost = resolveRecommendationPoCost({
        estimatedCostMills: acceptedBasis.estimatedCostMills,
        estimatedCostCents: acceptedBasis.estimatedCostCents,
        orderQtyPieces: acceptedBasis.suggestedOrderPieces,
      });
    } catch (error) {
      throw new RecommendationPoHandoffError(
        `The supplier cost is invalid: ${(error as Error).message}`,
        409,
        "RECOMMENDATION_VENDOR_COST_INVALID",
        { vendorProductId: vendorProduct.id },
      );
    }
    if (
      liveCost.unitCostMills !== acceptedCost.unitCostMills ||
      liveCost.unitCostCents !== acceptedCost.unitCostCents
    ) {
      throw new RecommendationPoHandoffError(
        "The supplier cost changed after the recommendation was accepted",
        409,
        "RECOMMENDATION_VENDOR_COST_CHANGED",
        {
          vendorProductId: vendorProduct.id,
          acceptedUnitCostMills: acceptedCost.unitCostMills,
          currentUnitCostMills: liveCost.unitCostMills,
        },
      );
    }

    return {
      ...item,
      acceptedDecision,
      acceptedBasis,
      vendorProduct,
      vendor,
      product,
      variant,
      ...acceptedCost,
    };
  });
}

export function createRecommendationPoHandoffService(
  repository: RecommendationPoHandoffRepository,
  clock: () => Date = () => new Date(),
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

    return repository.transaction(async (unitOfWork) => {
      await unitOfWork.lockRecommendationKeys([lockKey]);
      const now = clock();
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
    const uniqueKeys = new Set(keys);
    if (uniqueAcceptedIds.size !== parsed.items.length || uniqueKeys.size !== parsed.items.length) {
      throw new RecommendationPoHandoffError(
        "Each accepted recommendation may appear only once per handoff",
        400,
        "DUPLICATE_ACCEPTED_RECOMMENDATION",
      );
    }

    const auditActor = resolveAuditActor(parsed.actorId);
    try {
      return await repository.transaction(async (unitOfWork) => {
        await unitOfWork.lockRecommendationKeys([...uniqueKeys].sort());
        const now = clock();

        const acceptedDecisions = await unitOfWork.getDecisionsForUpdate(acceptedDecisionIds);
        const latestDecisions = await unitOfWork.getLatestActiveDecisions(
          parsed.items.map((item) => ({ recommendationId: item.recommendationId, kind: item.kind })),
        );
        const existingHandoffs = await unitOfWork.getHandoffsByAcceptedDecisionIds(acceptedDecisionIds);
        const acceptedById = assertAcceptedDecisions(
          parsed.items,
          acceptedDecisions,
          latestDecisions,
          existingHandoffs,
        );

        const vendorProductIds = [...new Set(parsed.items.map((item) => item.vendorProductId))];
        const vendorIds = [...new Set(parsed.items.map((item) => item.vendorId))];
        const productIds = [...new Set(parsed.items.map((item) => item.productId))];
        const variantIds = [...new Set(parsed.items.map((item) => item.productVariantId))];
        const vendorProducts = await unitOfWork.getVendorProducts(vendorProductIds);
        const vendors = await unitOfWork.getVendors(vendorIds);
        const products = await unitOfWork.getProducts(productIds);
        const variants = await unitOfWork.getProductVariants(variantIds);
        assertCompleteLookup(vendorProductIds, vendorProducts, "vendor product");
        assertCompleteLookup(vendorIds, vendors, "vendor");
        assertCompleteLookup(productIds, products, "product");
        assertCompleteLookup(variantIds, variants, "product variant");

        const resolvedItems = resolveCatalogRows(
          parsed.items,
          acceptedById,
          vendorProducts,
          vendors,
          products,
          variants,
        );
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
            source: "reorder",
            createdBy: auditActor.databaseUserId,
            updatedBy: auditActor.databaseUserId,
            metadata: {
              source: "accepted_recommendation_handoff",
              acceptedDecisionIds: group.map((item) => item.acceptedDecisionId),
              createdAt: now.toISOString(),
            },
            createdAt: now,
            updatedAt: now,
          }, now);
          pos.push(po);

          await unitOfWork.createStatusHistory({
            purchaseOrderId: po.id,
            fromStatus: null,
            toStatus: "draft",
            changedBy: auditActor.databaseUserId,
            notes: "PO created from accepted purchasing recommendations",
            changedAt: now,
          });
          await unitOfWork.createPoEvent({
            poId: po.id,
            eventType: "created",
            actorType: auditActor.eventActorType,
            actorId: auditActor.eventActorId,
            payloadJson: {
              source: "accepted_recommendation_handoff",
              line_count: group.length,
              subtotal_cents: subtotalCents,
              accepted_decision_ids: group.map((item) => item.acceptedDecisionId),
              recommendation_ids: group.map((item) => item.recommendationId),
            },
            createdAt: now,
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
              discountCents: 0,
              taxCents: 0,
              lineTotalCents: item.lineTotalCents,
              lineType: "product",
              status: "open",
              createdAt: now,
              updatedAt: now,
            });
            const decision = await unitOfWork.createDecision({
              recommendationId: item.recommendationId,
              kind: item.kind,
              decision: "po_handoff_created",
              status: "active",
              decisionReason: "accepted_recommendation_po_handoff",
              note: null,
              source: "operator",
              autoDraftRunId: null,
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
              decidedBy: parsed.actorId,
              decidedAt: now,
              createdAt: now,
            });
            await unitOfWork.createHandoff({
              acceptedDecisionId: item.acceptedDecisionId,
              handoffDecisionId: decision.id,
              purchaseOrderId: po.id,
              purchaseOrderLineId: line.id,
              recommendationId: item.recommendationId,
              kind: item.kind,
              createdBy: auditActor.databaseUserId,
              createdAt: now,
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

  return {
    recordDecision,
    createAcceptedHandoff,
  };
}

export type RecommendationPoHandoffService = ReturnType<typeof createRecommendationPoHandoffService>;
