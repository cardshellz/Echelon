import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { products, productVariants } from "@shared/schema/catalog.schema";
import {
  poEvents,
  purchaseOrderLines,
  purchaseOrders,
  purchasingRecommendationPoHandoffs,
  vendorProducts,
} from "@shared/schema/procurement.schema";
import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
  type PoLinePricingInput,
} from "@shared/utils/po-line-pricing";
import { createDrizzleFinancialCommandRepository } from "../../platform/commands/command-results.repository";
import {
  runTransactionalFinancialCommand,
  type FinancialCommandDescriptor,
  type FinancialCommandFailureDisposition,
} from "../../platform/commands/transactional-command.service";

const PG_INTEGER_MAX = 2_147_483_647;
const MAX_QUOTE_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const positivePgInteger = z.number().int().positive().max(PG_INTEGER_MAX);
const nonnegativeMoney = z.number().int().min(0).safe();
const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable().optional();

const versionDate = z.preprocess((value) => {
  if (value instanceof Date) return value;
  if (typeof value !== "string" || value.trim().length === 0) return value;
  return new Date(value);
}, z.date());

const quotedAtDate = z.preprocess((value) => {
  if (value === "" || value === null) return null;
  if (value instanceof Date) return value;
  if (typeof value !== "string") return value;
  return new Date(value);
}, z.date().nullable()).optional();

const isoDateOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year &&
      parsed.getUTCMonth() === month - 1 &&
      parsed.getUTCDate() === day;
  }, "must be a valid calendar date in YYYY-MM-DD format");

const quoteValidUntil = z.preprocess(
  (value) => value === "" ? null : value,
  isoDateOnly.nullable(),
).optional();

export const poLinePricingInputSchema = z.discriminatedUnion("basis", [
  z.object({
    basis: z.literal("per_piece"),
    quantityPieces: positivePgInteger,
    unitCostMills: nonnegativeMoney,
  }).strict(),
  z.object({
    basis: z.literal("per_purchase_uom"),
    purchaseUom: z.string().trim().min(1).max(50),
    uomQuantity: positivePgInteger,
    piecesPerUom: positivePgInteger,
    quotedCostMillsPerUom: nonnegativeMoney,
  }).strict(),
  z.object({
    basis: z.literal("extended_total"),
    quantityPieces: positivePgInteger,
    quotedTotalCents: nonnegativeMoney,
  }).strict(),
]).superRefine((pricing, context) => {
  if (
    pricing.basis === "per_purchase_uom" &&
    BigInt(pricing.uomQuantity) * BigInt(pricing.piecesPerUom) > BigInt(PG_INTEGER_MAX)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["uomQuantity"],
      message: `derived piece quantity must not exceed ${PG_INTEGER_MAX}`,
    });
  }
});

const quoteMetadataFields = {
  pricingSource: z.enum(["manual", "vendor_catalog"] as const).optional(),
  quoteReference: nullableText(255),
  quotedAt: quotedAtDate,
  quoteValidUntil,
};

const catalogWriteSchema = z.object({
  mode: z.literal("upsert"),
  setPreferred: z.boolean().optional(),
}).strict();

function validateQuoteDateOrder(
  input: { quotedAt?: Date | null; quoteValidUntil?: string | null },
  context: z.RefinementCtx,
): void {
  if (
    input.quotedAt &&
    input.quotedAt.getTime() > Date.now() + MAX_QUOTE_CLOCK_SKEW_MS
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quotedAt"],
      message: "quotedAt cannot be materially in the future",
    });
  }
  if (
    input.quotedAt &&
    input.quoteValidUntil &&
    input.quoteValidUntil < input.quotedAt.toISOString().slice(0, 10)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quoteValidUntil"],
      message: "quoteValidUntil must be on or after quotedAt",
    });
  }
}

function validateCatalogWrite(
  input: {
    pricing?: PoLinePricingInput;
    pricingSource?: "manual" | "vendor_catalog";
    quotedAt?: Date | null;
    catalogWrite?: { mode: "upsert"; setPreferred?: boolean };
  },
  context: z.RefinementCtx,
): void {
  if (!input.catalogWrite) return;
  if ((input.pricingSource ?? "manual") !== "manual") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalogWrite"],
      message: "is only valid when this PO consumes a manual quote",
    });
  }
  if (!input.pricing) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalogWrite"],
      message: "requires explicit quote pricing",
    });
  } else if (input.pricing.basis === "extended_total") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalogWrite"],
      message: "cannot reuse a quantity-specific extended total",
    });
  }
  if (!input.quotedAt) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["quotedAt"],
      message: "is required when saving reusable catalog pricing",
    });
  }
}

const addLineFields = {
  productId: positivePgInteger,
  expectedReceiveVariantId: positivePgInteger.nullable().optional(),
  expectedReceiveUnitsPerVariant: positivePgInteger.nullable().optional(),
  vendorProductId: positivePgInteger.nullable().optional(),
  vendorSku: nullableText(100),
  description: nullableText(20_000),
  notes: nullableText(20_000),
  pricing: poLinePricingInputSchema,
  packagingCostCents: nonnegativeMoney.optional(),
  catalogWrite: catalogWriteSchema.optional(),
  ...quoteMetadataFields,
};

const addLineBodySchema = z.object({
  expectedPoUpdatedAt: versionDate,
  ...addLineFields,
}).strict().superRefine((input, context) => {
  validateQuoteDateOrder(input, context);
  validateCatalogWrite(input, context);
});

const addLineValueSchema = z.object(addLineFields).strict().superRefine((input, context) => {
  validateQuoteDateOrder(input, context);
  validateCatalogWrite(input, context);
});

const addBulkLinesBodySchema = z.object({
  expectedPoUpdatedAt: versionDate,
  lines: z.array(addLineValueSchema).min(1).max(200),
}).strict();

const updateLineBodySchema = z.object({
  expectedPoUpdatedAt: versionDate,
  expectedLineUpdatedAt: versionDate,
  expectedReceiveVariantId: positivePgInteger.nullable().optional(),
  expectedReceiveUnitsPerVariant: positivePgInteger.nullable().optional(),
  vendorProductId: positivePgInteger.nullable().optional(),
  vendorSku: nullableText(100),
  description: nullableText(20_000),
  notes: nullableText(20_000),
  pricing: poLinePricingInputSchema.optional(),
  packagingCostCents: nonnegativeMoney.optional(),
  catalogWrite: catalogWriteSchema.optional(),
  ...quoteMetadataFields,
}).strict().superRefine((input, context) => {
  validateQuoteDateOrder(input, context);
  if (input.catalogWrite && input.pricingSource !== undefined && input.pricingSource !== "manual") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalogWrite"],
      message: "is only valid when this PO consumes a manual quote",
    });
  }
  if (input.catalogWrite && input.pricing?.basis === "extended_total") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["catalogWrite"],
      message: "cannot reuse a quantity-specific extended total",
    });
  }
  const editableKeys = Object.keys(input).filter(
    (key) => key !== "expectedPoUpdatedAt" && key !== "expectedLineUpdatedAt",
  );
  if (editableKeys.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one editable line field is required",
    });
  }
});

const cancelLineBodySchema = z.object({
  expectedPoUpdatedAt: versionDate,
  expectedLineUpdatedAt: versionDate,
  reason: z.string().trim().min(1).max(2_000),
}).strict();

export type AddPurchaseOrderLineCommand = z.infer<typeof addLineBodySchema>;
export type AddBulkPurchaseOrderLinesCommand = z.infer<typeof addBulkLinesBodySchema>;
export type UpdatePurchaseOrderLineCommand = z.infer<typeof updateLineBodySchema>;
export type CancelPurchaseOrderLineCommand = z.infer<typeof cancelLineBodySchema>;

export class PurchaseOrderLineCommandError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PurchaseOrderLineCommandError";
  }
}

function classifyLineCommandFailure(error: unknown): FinancialCommandFailureDisposition {
  if (
    error instanceof PurchaseOrderLineCommandError
    && error.statusCode >= 400
    && error.statusCode <= 499
  ) {
    return {
      kind: "rejected",
      httpStatus: error.statusCode,
      body: { error: error.message, details: error.details },
      errorCode: String(error.details?.code ?? "PO_LINE_COMMAND_REJECTED"),
      errorMessage: error.message,
    };
  }
  return {
    kind: "retryable",
    errorCode: "PO_LINE_COMMAND_TRANSIENT_FAILURE",
    errorMessage: "Purchase-order line command failed before its transaction committed.",
  };
}

type CommandDb = {
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  select: (...args: any[]) => any;
};

type AddLineValue = z.infer<typeof addLineValueSchema>;
type CatalogWritableLine = Pick<
  AddLineValue,
  | "productId"
  | "expectedReceiveVariantId"
  | "expectedReceiveUnitsPerVariant"
  | "vendorProductId"
  | "vendorSku"
  | "pricingSource"
  | "pricing"
  | "quoteReference"
  | "quotedAt"
  | "quoteValidUntil"
  | "catalogWrite"
>;
type PurchaseOrderLineCommandOptions = {
  persistCatalogWrites?: (
    tx: any,
    vendorId: number,
    lines: CatalogWritableLine[],
    userId?: string,
  ) => Promise<Array<number | null>>;
};
type LineContextInput = {
  productId: number;
  expectedReceiveVariantId?: number | null;
  expectedReceiveUnitsPerVariant?: number | null;
  vendorProductId?: number | null;
  pricingSource?: "legacy" | "manual" | "vendor_catalog" | "recommendation";
  pricing?: PoLinePricingInput;
};

function validationError(error: z.ZodError): PurchaseOrderLineCommandError {
  return new PurchaseOrderLineCommandError("Invalid purchase-order line command", 400, {
    code: "PO_LINE_COMMAND_INVALID",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

function parseCommand<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validationError(parsed.error);
  return parsed.data as z.output<Schema>;
}

function parsePurchaseOrderId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > PG_INTEGER_MAX) {
    throw new PurchaseOrderLineCommandError("Purchase order id must be a positive integer", 400);
  }
  return value;
}

function parsePurchaseOrderLineId(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > PG_INTEGER_MAX) {
    throw new PurchaseOrderLineCommandError("Purchase-order line id must be a positive integer", 400);
  }
  return value;
}

function sameInstant(actual: unknown, expected: Date): boolean {
  const actualDate = actual instanceof Date ? actual : new Date(String(actual));
  return !Number.isNaN(actualDate.getTime()) && actualDate.getTime() === expected.getTime();
}

function auditDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function quoteDateOnly(value: unknown): string | null {
  const audited = auditDate(value);
  return audited === null ? null : audited.slice(0, 10);
}

function storedInteger(value: unknown, field: string): number {
  const numberValue = Number(value ?? 0);
  if (!Number.isSafeInteger(numberValue)) {
    throw new PurchaseOrderLineCommandError(`${field} exceeds the safe integer range`, 409, {
      code: "PO_MONEY_OUT_OF_RANGE",
      field,
    });
  }
  return numberValue;
}

function requiredStoredInteger(value: unknown, field: string): number {
  if (value === null || value === undefined) {
    throw new PurchaseOrderLineCommandError(
      `Stored ${field} is missing from the line's quote provenance`,
      409,
      { code: "PO_LINE_STORED_PRICING_INVALID", field },
    );
  }
  return storedInteger(value, field);
}

export function vendorCatalogPricingMatches(
  vendorProduct: any,
  pricing: PoLinePricingInput,
): boolean {
  const catalogBasis = vendorProduct.pricingBasis ?? "legacy_unknown";
  const catalogUnitCostMills = storedInteger(
    vendorProduct.unitCostMills ?? Number(vendorProduct.unitCostCents ?? 0) * 100,
    "vendor_product.unit_cost_mills",
  );
  if (catalogBasis === "per_piece" && pricing.basis === "per_piece") {
    return pricing.unitCostMills === Number(
      vendorProduct.quotedUnitCostMills ?? catalogUnitCostMills,
    );
  }
  if (catalogBasis === "per_purchase_uom" && pricing.basis === "per_purchase_uom") {
    return (
      pricing.quotedCostMillsPerUom === Number(vendorProduct.quotedUnitCostMills) &&
      pricing.piecesPerUom === Number(vendorProduct.piecesPerPurchaseUom) &&
      pricing.purchaseUom.trim().toLowerCase() ===
        String(vendorProduct.purchaseUom ?? "").trim().toLowerCase()
    );
  }
  // Existing catalog rows were migrated as legacy_unknown because their
  // original vendor quote form is not provable. They may prefill a manual
  // review, but cannot claim automated vendor_catalog provenance.
  return false;
}

export function vendorCatalogQuoteUsability(
  vendorProduct: any,
  evaluatedAt: Date = new Date(),
): { usable: true } | { usable: false; code: string } {
  const quotedAt = vendorProduct?.quotedAt instanceof Date
    ? vendorProduct.quotedAt
    : new Date(String(vendorProduct?.quotedAt ?? ""));
  if (Number.isNaN(quotedAt.getTime())) {
    return { usable: false, code: "PO_LINE_VENDOR_CATALOG_QUOTE_UNVERIFIED" };
  }
  if (quotedAt.getTime() > evaluatedAt.getTime() + MAX_QUOTE_CLOCK_SKEW_MS) {
    return { usable: false, code: "PO_LINE_VENDOR_CATALOG_QUOTE_FUTURE" };
  }

  const today = evaluatedAt.toISOString().slice(0, 10);
  const validUntil = vendorProduct?.quoteValidUntil == null
    ? null
    : String(vendorProduct.quoteValidUntil).slice(0, 10);
  if (validUntil !== null && validUntil < today) {
    return { usable: false, code: "PO_LINE_VENDOR_CATALOG_QUOTE_EXPIRED" };
  }
  if (
    validUntil === null &&
    evaluatedAt.getTime() - quotedAt.getTime() > 365 * 24 * 60 * 60 * 1_000
  ) {
    return { usable: false, code: "PO_LINE_VENDOR_CATALOG_QUOTE_STALE" };
  }
  return { usable: true };
}

function pricingInputFromStoredLine(line: any): PoLinePricingInput | undefined {
  switch (line.pricingBasis) {
    case "per_piece":
      return {
        basis: "per_piece",
        quantityPieces: requiredStoredInteger(line.orderQty, "order_qty"),
        unitCostMills: requiredStoredInteger(
          line.quotedUnitCostMills,
          "quoted_unit_cost_mills",
        ),
      };
    case "per_purchase_uom":
      return {
        basis: "per_purchase_uom",
        purchaseUom: String(line.purchaseUom ?? ""),
        uomQuantity: requiredStoredInteger(
          line.purchaseUomQuantity,
          "purchase_uom_quantity",
        ),
        piecesPerUom: requiredStoredInteger(
          line.piecesPerPurchaseUom,
          "pieces_per_purchase_uom",
        ),
        quotedCostMillsPerUom: requiredStoredInteger(
          line.quotedUnitCostMills,
          "quoted_unit_cost_mills",
        ),
      };
    case "extended_total":
      return {
        basis: "extended_total",
        quantityPieces: requiredStoredInteger(line.orderQty, "order_qty"),
        quotedTotalCents: requiredStoredInteger(
          line.quotedTotalCents,
          "quoted_total_cents",
        ),
      };
    default:
      return undefined;
  }
}

function safeMoney(value: bigint, field: string): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PurchaseOrderLineCommandError(`${field} exceeds the safe integer range`, 400, {
      code: "PO_MONEY_OUT_OF_RANGE",
      field,
    });
  }
  return Number(value);
}

function snapshotLine(line: any): Record<string, unknown> {
  return {
    id: line.id,
    purchase_order_id: line.purchaseOrderId,
    line_number: line.lineNumber,
    line_type: line.lineType,
    status: line.status,
    product_id: line.productId,
    expected_receive_variant_id: line.expectedReceiveVariantId,
    expected_receive_units_per_variant: line.expectedReceiveUnitsPerVariant,
    vendor_product_id: line.vendorProductId,
    vendor_sku: line.vendorSku,
    description: line.description,
    notes: line.notes,
    order_qty: line.orderQty,
    pricing_basis: line.pricingBasis,
    pricing_source: line.pricingSource,
    purchase_uom: line.purchaseUom,
    purchase_uom_quantity: line.purchaseUomQuantity,
    pieces_per_purchase_uom: line.piecesPerPurchaseUom,
    quoted_unit_cost_mills: line.quotedUnitCostMills,
    quoted_total_cents: line.quotedTotalCents,
    pricing_remainder_mills: line.pricingRemainderMills,
    unit_cost_mills: line.unitCostMills,
    unit_cost_cents: line.unitCostCents,
    total_product_cost_cents: line.totalProductCostCents,
    packaging_cost_cents: line.packagingCostCents,
    line_total_cents: line.lineTotalCents,
    quote_reference: line.quoteReference,
    quoted_at: auditDate(line.quotedAt),
    quote_valid_until: line.quoteValidUntil,
    updated_at: auditDate(line.updatedAt),
  };
}

function actor(userId?: string): { actorType: "user" | "system"; actorId: string } {
  return userId
    ? { actorType: "user", actorId: userId }
    : { actorType: "system", actorId: "system:auto" };
}

function normalizePricing(pricing: PoLinePricingInput): NormalizedPoLinePricing {
  try {
    return normalizePoLinePricing(pricing);
  } catch (error: any) {
    throw new PurchaseOrderLineCommandError(error?.message || "Invalid line pricing", 400, {
      code: "PO_LINE_PRICING_INVALID",
    });
  }
}

function assertDraftHeader(header: any): void {
  const physicalStatus = header.physicalStatus ?? header.status;
  const financialStatus = header.financialStatus ?? "unbilled";
  if (
    header.status !== "draft" ||
    physicalStatus !== "draft" ||
    financialStatus !== "unbilled"
  ) {
    throw new PurchaseOrderLineCommandError("Purchase-order lines can only be changed in a clean draft", 409, {
      code: "PO_LINE_COMMAND_NOT_DRAFT",
      status: header.status,
      physicalStatus,
      financialStatus,
    });
  }
  if (
    storedInteger(header.invoicedTotalCents, "invoiced_total_cents") !== 0 ||
    storedInteger(header.paidTotalCents, "paid_total_cents") !== 0
  ) {
    throw new PurchaseOrderLineCommandError("Purchase-order lines cannot change after financial activity", 409, {
      code: "PO_LINE_COMMAND_FINANCIAL_ACTIVITY",
    });
  }
}

function assertExpectedVersion(
  entity: "purchase_order" | "purchase_order_line",
  actual: unknown,
  expected: Date,
): void {
  if (sameInstant(actual, expected)) return;
  throw new PurchaseOrderLineCommandError(
    entity === "purchase_order"
      ? "This purchase order changed after it was loaded"
      : "This purchase-order line changed after it was loaded",
    409,
    {
      code: entity === "purchase_order" ? "PO_LINE_COMMAND_PO_STALE" : "PO_LINE_COMMAND_LINE_STALE",
      expected_updated_at: expected.toISOString(),
      current_updated_at: auditDate(actual),
    },
  );
}

function assertEditableLine(line: any): void {
  const counters = {
    received_qty: storedInteger(line.receivedQty, "received_qty"),
    damaged_qty: storedInteger(line.damagedQty, "damaged_qty"),
    returned_qty: storedInteger(line.returnedQty, "returned_qty"),
    cancelled_qty: storedInteger(line.cancelledQty, "cancelled_qty"),
  };
  if (line.status !== "open" || Object.values(counters).some((value) => value !== 0)) {
    throw new PurchaseOrderLineCommandError("Line cannot change after operational activity", 409, {
      code: "PO_LINE_COMMAND_LINE_HAS_ACTIVITY",
      lineId: line.id,
      status: line.status,
      ...counters,
    });
  }
}

async function assertNoRecommendationOwnership(tx: any, purchaseOrderId: number): Promise<void> {
  const rows = await tx
    .select({ id: purchasingRecommendationPoHandoffs.id })
    .from(purchasingRecommendationPoHandoffs)
    .where(eq(purchasingRecommendationPoHandoffs.purchaseOrderId, purchaseOrderId))
    .limit(1);
  if (rows[0]) {
    throw new PurchaseOrderLineCommandError(
      "Recommendation-created purchase orders must be cancelled and regenerated instead of edited",
      409,
      { code: "RECOMMENDATION_PO_LINE_AMEND_BLOCKED", handoffId: rows[0].id },
    );
  }
}

async function assertNoDownstreamLinks(tx: any, lineId: number): Promise<void> {
  const result = await tx.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM procurement.inbound_shipment_lines WHERE purchase_order_line_id = ${lineId}) AS inbound_shipment_lines,
      (SELECT COUNT(*)::int FROM procurement.po_receipts WHERE purchase_order_line_id = ${lineId}) AS po_receipts,
      (SELECT COUNT(*)::int FROM procurement.vendor_invoice_lines WHERE purchase_order_line_id = ${lineId}) AS vendor_invoice_lines,
      (SELECT COUNT(*)::int FROM procurement.landed_cost_snapshots WHERE purchase_order_line_id = ${lineId}) AS landed_cost_snapshots,
      (SELECT COUNT(*)::int FROM procurement.landed_cost_adjustments WHERE purchase_order_line_id = ${lineId}) AS landed_cost_adjustments,
      (SELECT COUNT(*)::int FROM procurement.receiving_lines WHERE purchase_order_line_id = ${lineId}) AS receiving_lines,
      (SELECT COUNT(*)::int FROM inventory.inventory_lots WHERE po_line_id = ${lineId}) AS inventory_lots,
      (SELECT COUNT(*)::int FROM procurement.purchase_order_lines WHERE parent_line_id = ${lineId} AND status <> 'cancelled') AS active_child_lines
  `);
  const counts = result.rows?.[0] ?? {};
  const blockers = Object.fromEntries(
    Object.entries(counts)
      .map(([name, count]) => [name, Number(count)])
      .filter(([, count]) => Number(count) > 0),
  );
  if (Object.keys(blockers).length > 0) {
    throw new PurchaseOrderLineCommandError(
      "Line has downstream or dependent records and cannot be changed by the direct editor",
      409,
      { code: "PO_LINE_COMMAND_DOWNSTREAM_LINKS", lineId, blockers },
    );
  }
}

async function resolveLineContext(tx: any, header: any, input: LineContextInput) {
  const productRows = await tx
    .select()
    .from(products)
    .where(eq(products.id, input.productId))
    .limit(1)
    .for("share");
  const product = productRows[0];
  if (!product) {
    throw new PurchaseOrderLineCommandError("Product not found", 404, {
      code: "PO_LINE_PRODUCT_NOT_FOUND",
      productId: input.productId,
    });
  }
  if (product.isActive === false || product.status === "archived") {
    throw new PurchaseOrderLineCommandError("Product is inactive", 409, {
      code: "PO_LINE_PRODUCT_INACTIVE",
      productId: input.productId,
    });
  }

  const receiveVariantId = input.expectedReceiveVariantId ?? null;
  let receiveVariant: any = null;
  if (receiveVariantId !== null) {
    const rows = await tx
      .select()
      .from(productVariants)
      .where(and(
        eq(productVariants.id, receiveVariantId),
        eq(productVariants.productId, input.productId),
      ))
      .limit(1)
      .for("share");
    receiveVariant = rows[0];
    if (!receiveVariant) {
      throw new PurchaseOrderLineCommandError("Receive configuration does not belong to the product", 409, {
        code: "PO_LINE_RECEIVE_VARIANT_MISMATCH",
        productId: input.productId,
        expectedReceiveVariantId: receiveVariantId,
      });
    }
    if (receiveVariant.isActive === false) {
      throw new PurchaseOrderLineCommandError("Receive configuration is inactive", 409, {
        code: "PO_LINE_RECEIVE_VARIANT_INACTIVE",
        expectedReceiveVariantId: receiveVariantId,
      });
    }
    if (
      input.expectedReceiveUnitsPerVariant != null &&
      Number(receiveVariant.unitsPerVariant) !== input.expectedReceiveUnitsPerVariant
    ) {
      throw new PurchaseOrderLineCommandError(
        "Receive configuration quantity no longer matches the selected variant",
        409,
        {
          code: "PO_LINE_RECEIVE_UNITS_MISMATCH",
          expectedReceiveVariantId: receiveVariantId,
          submittedUnits: input.expectedReceiveUnitsPerVariant,
          actualUnits: receiveVariant.unitsPerVariant,
        },
      );
    }
  } else if (input.expectedReceiveUnitsPerVariant != null) {
    throw new PurchaseOrderLineCommandError(
      "expectedReceiveUnitsPerVariant requires expectedReceiveVariantId",
      400,
      { code: "PO_LINE_RECEIVE_UNITS_WITHOUT_VARIANT" },
    );
  }

  let vendorProduct: any = null;
  if (input.vendorProductId != null) {
    const rows = await tx
      .select()
      .from(vendorProducts)
      .where(eq(vendorProducts.id, input.vendorProductId))
      .limit(1)
      // Hold the catalog quote stable until the PO line commits. Without a
      // shared row lock, a concurrent catalog edit could land after this
      // validation and leave stale economics labeled vendor_catalog.
      .for("share");
    vendorProduct = rows[0];
    if (
      !vendorProduct ||
      Number(vendorProduct.vendorId) !== Number(header.vendorId) ||
      Number(vendorProduct.productId) !== input.productId ||
      (
        vendorProduct.productVariantId != null &&
        Number(vendorProduct.productVariantId) !== receiveVariantId
      ) ||
      Number(vendorProduct.isActive ?? 0) !== 1
    ) {
      throw new PurchaseOrderLineCommandError(
        "Vendor catalog item must be active and match the PO vendor and product",
        409,
        {
          code: "PO_LINE_VENDOR_PRODUCT_MISMATCH",
          vendorProductId: input.vendorProductId,
          vendorId: header.vendorId,
          productId: input.productId,
        },
      );
    }
  }
  if (
    (input.pricingSource ?? "manual") === "vendor_catalog" &&
    (!vendorProduct || !input.pricing)
  ) {
    throw new PurchaseOrderLineCommandError(
      "vendorProductId and explicit quote pricing are required when pricingSource is vendor_catalog",
      400,
      { code: "PO_LINE_VENDOR_CATALOG_SOURCE_REQUIRES_LINK" },
    );
  }
  if (vendorProduct && input.pricingSource === "vendor_catalog" && input.pricing) {
    const usability = vendorCatalogQuoteUsability(vendorProduct);
    if (!usability.usable) {
      throw new PurchaseOrderLineCommandError(
        "The vendor catalog quote is expired, stale, future-dated, or unverified; confirm it as a manual quote before using it",
        409,
        { code: usability.code, vendorProductId: vendorProduct.id },
      );
    }
    if (!vendorCatalogPricingMatches(vendorProduct, input.pricing)) {
      throw new PurchaseOrderLineCommandError(
        "Submitted vendor-catalog pricing no longer matches the active catalog row",
        409,
        {
          code: "PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH",
          vendorProductId: vendorProduct.id,
          catalogPricingBasis: vendorProduct.pricingBasis ?? "legacy_unknown",
        },
      );
    }
  }

  return { product, receiveVariant, vendorProduct };
}

function lineValues(
  purchaseOrderId: number,
  lineNumber: number,
  input: AddLineValue,
  normalized: NormalizedPoLinePricing,
  context: Awaited<ReturnType<typeof resolveLineContext>>,
) {
  const packagingCostCents = input.packagingCostCents ?? 0;
  const lineTotalCents = safeMoney(
    BigInt(normalized.totalProductCostCents) + BigInt(packagingCostCents),
    "line_total_cents",
  );
  const expectedReceiveUnits = input.expectedReceiveVariantId == null
    ? null
    : input.expectedReceiveUnitsPerVariant ?? context.receiveVariant?.unitsPerVariant ?? 1;
  const catalogQuote = (input.pricingSource ?? "manual") === "vendor_catalog"
    ? context.vendorProduct
    : null;

  return {
    purchaseOrderId,
    lineNumber,
    lineType: "product" as const,
    productId: input.productId,
    productVariantId: input.expectedReceiveVariantId ?? null,
    expectedReceiveVariantId: input.expectedReceiveVariantId ?? null,
    expectedReceiveUnitsPerVariant: expectedReceiveUnits,
    vendorProductId: input.vendorProductId ?? null,
    sku: context.product.sku ?? context.receiveVariant?.sku ?? null,
    productName: context.product.name,
    vendorSku: input.vendorSku ?? context.vendorProduct?.vendorSku ?? null,
    description: input.description ?? null,
    notes: input.notes ?? null,
    unitOfMeasure: context.receiveVariant?.name?.split(" ")?.[0]?.toLowerCase() ?? context.product.baseUnit,
    unitsPerUom: expectedReceiveUnits ?? 1,
    orderQty: normalized.orderQty,
    unitCostCents: normalized.unitCostCents,
    unitCostMills: normalized.unitCostMills,
    totalProductCostCents: normalized.totalProductCostCents,
    packagingCostCents,
    discountPercent: "0",
    discountCents: 0,
    taxRatePercent: "0",
    taxCents: 0,
    lineTotalCents,
    pricingBasis: normalized.pricingBasis,
    pricingSource: input.pricingSource ?? "manual",
    purchaseUom: normalized.purchaseUom,
    purchaseUomQuantity: normalized.purchaseUomQuantity,
    piecesPerPurchaseUom: normalized.piecesPerPurchaseUom,
    quotedUnitCostMills: normalized.quotedUnitCostMills,
    quotedTotalCents: normalized.quotedTotalCents,
    pricingRemainderMills: normalized.pricingRemainderMills,
    quoteReference: catalogQuote?.quoteReference ?? input.quoteReference ?? null,
    quotedAt: catalogQuote?.quotedAt ?? input.quotedAt ?? null,
    quoteValidUntil: catalogQuote?.quoteValidUntil ?? input.quoteValidUntil ?? null,
    status: "open" as const,
    createdAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
    updatedAt: sql`date_trunc('milliseconds', transaction_timestamp())`,
  };
}

async function lockHeader(tx: any, purchaseOrderId: number) {
  const rows = await tx
    .select()
    .from(purchaseOrders)
    .where(eq(purchaseOrders.id, purchaseOrderId))
    .limit(1)
    .for("update");
  const header = rows[0];
  if (!header) throw new PurchaseOrderLineCommandError("Purchase order not found", 404);
  return header;
}

async function updateHeaderTotals(tx: any, header: any, userId?: string) {
  const aggregateRows = await tx
    .select({
      subtotal: sql<string>`COALESCE(SUM(${purchaseOrderLines.lineTotalCents}), 0)::text`,
      lineCount: sql<number>`COUNT(*)::int`,
    })
    .from(purchaseOrderLines)
    .where(and(
      eq(purchaseOrderLines.purchaseOrderId, header.id),
      ne(purchaseOrderLines.status, "cancelled"),
    ));
  const subtotal = BigInt(aggregateRows[0]?.subtotal ?? "0");
  const total =
    subtotal -
    BigInt(storedInteger(header.discountCents, "discount_cents")) +
    BigInt(storedInteger(header.taxCents, "tax_cents")) +
    BigInt(storedInteger(header.shippingCostCents, "shipping_cost_cents"));
  const updatedRows = await tx
    .update(purchaseOrders)
    .set({
      subtotalCents: safeMoney(subtotal, "subtotal_cents"),
      totalCents: safeMoney(total, "total_cents"),
      lineCount: Number(aggregateRows[0]?.lineCount ?? 0),
      updatedBy: userId ?? null,
      updatedAt: sql`GREATEST(
        date_trunc('milliseconds', transaction_timestamp()),
        ${header.updatedAt}::timestamp + interval '1 millisecond'
      )`,
    })
    .where(and(
      eq(purchaseOrders.id, header.id),
      eq(purchaseOrders.status, "draft"),
      eq(purchaseOrders.physicalStatus, "draft"),
      eq(purchaseOrders.financialStatus, "unbilled"),
    ))
    .returning();
  if (!updatedRows[0]) {
    throw new PurchaseOrderLineCommandError("Purchase order changed while the line command was applied", 409, {
      code: "PO_LINE_COMMAND_PO_CONFLICT",
    });
  }
  return updatedRows[0];
}

async function emitEvent(
  tx: any,
  purchaseOrderId: number,
  eventType: string,
  userId: string | undefined,
  payload: Record<string, unknown>,
) {
  const resolvedActor = actor(userId);
  await tx.insert(poEvents).values({
    poId: purchaseOrderId,
    eventType,
    actorType: resolvedActor.actorType,
    actorId: resolvedActor.actorId,
    payloadJson: payload,
  });
}

export function createPurchaseOrderLineCommands(
  db: CommandDb,
  options: PurchaseOrderLineCommandOptions = {},
) {
  const commandRepository = createDrizzleFinancialCommandRepository(db as any);

  async function addLineInTransaction(
    tx: any,
    purchaseOrderId: number,
    input: AddPurchaseOrderLineCommand,
    userId?: string,
  ) {
    const header = await lockHeader(tx, purchaseOrderId);
    assertDraftHeader(header);
    assertExpectedVersion("purchase_order", header.updatedAt, input.expectedPoUpdatedAt);
    await assertNoRecommendationOwnership(tx, purchaseOrderId);

    let effectiveInput: AddLineValue = input;
    if (input.catalogWrite) {
      if (!options.persistCatalogWrites) {
        throw new PurchaseOrderLineCommandError("Catalog persistence is unavailable", 500, {
          code: "PO_LINE_CATALOG_WRITE_UNAVAILABLE",
        });
      }
      const [vendorProductId] = await options.persistCatalogWrites(
        tx,
        Number(header.vendorId),
        [input],
        userId,
      );
      if (!vendorProductId) {
        throw new PurchaseOrderLineCommandError("Catalog persistence did not return a mapping", 500, {
          code: "PO_LINE_CATALOG_WRITE_RESULT_MISSING",
        });
      }
      effectiveInput = { ...input, vendorProductId };
    }
    const context = await resolveLineContext(tx, header, effectiveInput);
    const normalized = normalizePricing(effectiveInput.pricing as PoLinePricingInput);
    const maxRows = await tx
      .select({ maximum: sql<number>`COALESCE(MAX(${purchaseOrderLines.lineNumber}), 0)::int` })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
    const values = lineValues(
      purchaseOrderId,
      Number(maxRows[0]?.maximum ?? 0) + 1,
      effectiveInput,
      normalized,
      context,
    );
    const insertedRows = await tx.insert(purchaseOrderLines).values(values).returning();
    const line = insertedRows[0];
    if (!line) throw new PurchaseOrderLineCommandError("Failed to insert PO line", 500);
    const updatedPo = await updateHeaderTotals(tx, header, userId);
    await emitEvent(tx, purchaseOrderId, "line_added", userId, {
      expected_po_updated_at: input.expectedPoUpdatedAt.toISOString(),
      after: snapshotLine(line),
      resulting_po_updated_at: auditDate(updatedPo.updatedAt),
    });
    return line;
  }

  async function addLine(purchaseOrderId: number, rawInput: unknown, userId?: string) {
    const parsedPurchaseOrderId = parsePurchaseOrderId(purchaseOrderId);
    const input = parseCommand(addLineBodySchema, rawInput);
    return db.transaction((tx) => addLineInTransaction(tx, parsedPurchaseOrderId, input, userId));
  }

  async function addBulkLinesInTransaction(
    tx: any,
    purchaseOrderId: number,
    input: AddBulkPurchaseOrderLinesCommand,
    userId?: string,
  ) {
    const header = await lockHeader(tx, purchaseOrderId);
    assertDraftHeader(header);
    assertExpectedVersion("purchase_order", header.updatedAt, input.expectedPoUpdatedAt);
    await assertNoRecommendationOwnership(tx, purchaseOrderId);
    const maxRows = await tx
      .select({ maximum: sql<number>`COALESCE(MAX(${purchaseOrderLines.lineNumber}), 0)::int` })
      .from(purchaseOrderLines)
      .where(eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId));
    let lineNumber = Number(maxRows[0]?.maximum ?? 0) + 1;
    let effectiveLines: AddLineValue[] = input.lines;
    if (input.lines.some((line) => line.catalogWrite)) {
      if (!options.persistCatalogWrites) {
        throw new PurchaseOrderLineCommandError("Catalog persistence is unavailable", 500, {
          code: "PO_LINE_CATALOG_WRITE_UNAVAILABLE",
        });
      }
      const vendorProductIds = await options.persistCatalogWrites(
        tx,
        Number(header.vendorId),
        input.lines,
        userId,
      );
      effectiveLines = input.lines.map((line, index) => ({
        ...line,
        ...(vendorProductIds[index] ? { vendorProductId: vendorProductIds[index] } : {}),
      }));
    }
    const values = [];
    for (const lineInput of effectiveLines) {
      const context = await resolveLineContext(tx, header, lineInput);
      const normalized = normalizePricing(lineInput.pricing as PoLinePricingInput);
      values.push(lineValues(purchaseOrderId, lineNumber++, lineInput, normalized, context));
    }
    const lines = await tx.insert(purchaseOrderLines).values(values).returning();
    if (lines.length !== values.length) {
      throw new PurchaseOrderLineCommandError("Failed to insert every PO line", 500);
    }
    const updatedPo = await updateHeaderTotals(tx, header, userId);
    await emitEvent(tx, purchaseOrderId, "lines_added", userId, {
      expected_po_updated_at: input.expectedPoUpdatedAt.toISOString(),
      after: lines.map(snapshotLine),
      resulting_po_updated_at: auditDate(updatedPo.updatedAt),
    });
    return lines;
  }

  async function addBulkLines(purchaseOrderId: number, rawInput: unknown, userId?: string) {
    const parsedPurchaseOrderId = parsePurchaseOrderId(purchaseOrderId);
    const input = parseCommand(addBulkLinesBodySchema, rawInput);
    return db.transaction((tx) => addBulkLinesInTransaction(tx, parsedPurchaseOrderId, input, userId));
  }

  async function updateLineInTransaction(
    tx: any,
    lineId: number,
    input: UpdatePurchaseOrderLineCommand,
    userId?: string,
  ) {
      const parentRows = await tx
        .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.id, lineId))
        .limit(1);
      if (!parentRows[0]) throw new PurchaseOrderLineCommandError("PO line not found", 404);
      const purchaseOrderId = parentRows[0].purchaseOrderId;
      const header = await lockHeader(tx, purchaseOrderId);
      assertDraftHeader(header);
      assertExpectedVersion("purchase_order", header.updatedAt, input.expectedPoUpdatedAt);
      await assertNoRecommendationOwnership(tx, purchaseOrderId);
      const lineRows = await tx
        .select()
        .from(purchaseOrderLines)
        .where(and(
          eq(purchaseOrderLines.id, lineId),
          eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
        ))
        .limit(1)
        .for("update");
      const line = lineRows[0];
      if (!line) {
        throw new PurchaseOrderLineCommandError("PO line changed ownership while it was being edited", 409, {
          code: "PO_LINE_COMMAND_OWNERSHIP_CONFLICT",
        });
      }
      if (line.lineType !== "product") {
        throw new PurchaseOrderLineCommandError("The direct editor only supports product lines", 409, {
          code: "PO_LINE_COMMAND_NON_PRODUCT",
        });
      }
      assertExpectedVersion("purchase_order_line", line.updatedAt, input.expectedLineUpdatedAt);
      assertEditableLine(line);
      await assertNoDownstreamLinks(tx, lineId);

      const resolvedReceiveVariantId = input.expectedReceiveVariantId === undefined
        ? line.expectedReceiveVariantId
        : input.expectedReceiveVariantId;
      const resolvedReceiveUnits = input.expectedReceiveUnitsPerVariant !== undefined
        ? input.expectedReceiveUnitsPerVariant
        : input.expectedReceiveVariantId === null
          ? null
          : line.expectedReceiveUnitsPerVariant;
      const resolvedPricingSource = input.pricingSource !== undefined
        ? input.pricingSource
        : input.pricing !== undefined
          ? "manual"
          : line.pricingSource;
      const effectivePricing = input.pricing ?? (
        resolvedPricingSource === "vendor_catalog" || input.catalogWrite
          ? pricingInputFromStoredLine(line)
          : undefined
      );
      const vendorSku = input.vendorSku === undefined ? line.vendorSku : input.vendorSku;
      const description = input.description === undefined ? line.description : input.description;
      const notes = input.notes === undefined ? line.notes : input.notes;
      const packagingCostCents = input.packagingCostCents === undefined
        ? storedInteger(line.packagingCostCents, "packaging_cost_cents")
        : input.packagingCostCents;
      let quoteReference = input.quoteReference === undefined
        ? line.quoteReference
        : input.quoteReference;
      let quotedAt = input.quotedAt === undefined ? line.quotedAt : input.quotedAt;
      let validUntil = input.quoteValidUntil === undefined
        ? line.quoteValidUntil
        : input.quoteValidUntil;
      let resolvedVendorProductId = input.vendorProductId === undefined
        ? line.vendorProductId
        : input.vendorProductId;

      if (input.catalogWrite) {
        if (resolvedPricingSource !== "manual") {
          throw new PurchaseOrderLineCommandError(
            "Catalog capture is only valid when this PO consumes a manual quote",
            400,
            { code: "PO_LINE_CATALOG_WRITE_SOURCE_INVALID" },
          );
        }
        if (!effectivePricing || effectivePricing.basis === "extended_total") {
          throw new PurchaseOrderLineCommandError(
            "Catalog capture requires reusable per-piece or purchase-UOM pricing",
            400,
            { code: "PO_LINE_CATALOG_WRITE_PRICING_REQUIRED" },
          );
        }
        if (!(quotedAt instanceof Date) || Number.isNaN(quotedAt.getTime())) {
          throw new PurchaseOrderLineCommandError(
            "A quote date is required when updating the supplier price",
            400,
            { code: "PO_LINE_CATALOG_WRITE_QUOTED_AT_REQUIRED" },
          );
        }
        if (!options.persistCatalogWrites) {
          throw new PurchaseOrderLineCommandError("Catalog persistence is unavailable", 500, {
            code: "PO_LINE_CATALOG_WRITE_UNAVAILABLE",
          });
        }
        const [vendorProductId] = await options.persistCatalogWrites(
          tx,
          Number(header.vendorId),
          [{
            productId: Number(line.productId),
            expectedReceiveVariantId: resolvedReceiveVariantId,
            expectedReceiveUnitsPerVariant: resolvedReceiveUnits,
            vendorProductId: resolvedVendorProductId,
            vendorSku,
            pricingSource: "manual",
            pricing: effectivePricing,
            quoteReference,
            quotedAt,
            quoteValidUntil: validUntil,
            catalogWrite: input.catalogWrite,
          }],
          userId,
        );
        if (!vendorProductId) {
          throw new PurchaseOrderLineCommandError(
            "Catalog persistence did not return a mapping",
            500,
            { code: "PO_LINE_CATALOG_WRITE_RESULT_MISSING" },
          );
        }
        resolvedVendorProductId = vendorProductId;
      }

      const contextInput = {
        productId: Number(line.productId),
        expectedReceiveVariantId: resolvedReceiveVariantId,
        expectedReceiveUnitsPerVariant: resolvedReceiveUnits,
        vendorProductId: resolvedVendorProductId,
        pricingSource: resolvedPricingSource,
        pricing: effectivePricing,
      };
      const context = await resolveLineContext(tx, header, contextInput);
      const catalogQuote = resolvedPricingSource === "vendor_catalog"
        ? context.vendorProduct
        : null;
      if (catalogQuote) {
        quoteReference = catalogQuote.quoteReference ?? null;
        quotedAt = catalogQuote.quotedAt ?? null;
        validUntil = catalogQuote.quoteValidUntil ?? null;
      }
      const quotedDate = quoteDateOnly(quotedAt);
      if (quotedDate && validUntil && String(validUntil) < quotedDate) {
        throw new PurchaseOrderLineCommandError(
          "quoteValidUntil must be on or after quotedAt",
          400,
          { code: "PO_LINE_QUOTE_DATE_ORDER_INVALID" },
        );
      }
      const patch: Record<string, unknown> = {
        productVariantId: contextInput.expectedReceiveVariantId ?? null,
        expectedReceiveVariantId: contextInput.expectedReceiveVariantId ?? null,
        expectedReceiveUnitsPerVariant: contextInput.expectedReceiveVariantId == null
          ? null
          : contextInput.expectedReceiveUnitsPerVariant ?? context.receiveVariant?.unitsPerVariant ?? 1,
        unitsPerUom: contextInput.expectedReceiveVariantId == null
          ? 1
          : contextInput.expectedReceiveUnitsPerVariant ?? context.receiveVariant?.unitsPerVariant ?? 1,
        unitOfMeasure: context.receiveVariant?.name?.split(" ")?.[0]?.toLowerCase() ?? context.product.baseUnit,
        vendorProductId: contextInput.vendorProductId ?? null,
        vendorSku: vendorSku ?? context.vendorProduct?.vendorSku ?? null,
        description: description ?? null,
        notes: notes ?? null,
        packagingCostCents,
        pricingSource: resolvedPricingSource,
        quoteReference: quoteReference ?? null,
        quotedAt: quotedAt ?? null,
        quoteValidUntil: validUntil ?? null,
        updatedAt: sql`GREATEST(
          date_trunc('milliseconds', transaction_timestamp()),
          ${line.updatedAt}::timestamp + interval '1 millisecond'
        )`,
      };
      if (input.pricing !== undefined) {
        const normalized = normalizePricing(input.pricing as PoLinePricingInput);
        Object.assign(patch, {
          orderQty: normalized.orderQty,
          pricingBasis: normalized.pricingBasis,
          purchaseUom: normalized.purchaseUom,
          purchaseUomQuantity: normalized.purchaseUomQuantity,
          piecesPerPurchaseUom: normalized.piecesPerPurchaseUom,
          quotedUnitCostMills: normalized.quotedUnitCostMills,
          quotedTotalCents: normalized.quotedTotalCents,
          pricingRemainderMills: normalized.pricingRemainderMills,
          unitCostMills: normalized.unitCostMills,
          unitCostCents: normalized.unitCostCents,
          totalProductCostCents: normalized.totalProductCostCents,
        });
      }
      const totalProductCostCents = input.pricing === undefined
        ? storedInteger(line.totalProductCostCents, "total_product_cost_cents")
        : Number(patch.totalProductCostCents);
      const resolvedPackagingCostCents = Number(patch.packagingCostCents);
      const discountCents = storedInteger(line.discountCents, "discount_cents");
      const taxCents = storedInteger(line.taxCents, "tax_cents");
      patch.lineTotalCents = safeMoney(
        BigInt(totalProductCostCents) + BigInt(resolvedPackagingCostCents) - BigInt(discountCents) + BigInt(taxCents),
        "line_total_cents",
      );

      const updatedRows = await tx
        .update(purchaseOrderLines)
        .set(patch)
        .where(and(
          eq(purchaseOrderLines.id, lineId),
          eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
          eq(purchaseOrderLines.status, "open"),
        ))
        .returning();
      const updatedLine = updatedRows[0];
      if (!updatedLine) {
        throw new PurchaseOrderLineCommandError("Line changed while the command was being applied", 409, {
          code: "PO_LINE_COMMAND_LINE_CONFLICT",
        });
      }
      const updatedPo = await updateHeaderTotals(tx, header, userId);
      await emitEvent(tx, purchaseOrderId, "line_updated", userId, {
        expected_po_updated_at: input.expectedPoUpdatedAt.toISOString(),
        expected_line_updated_at: input.expectedLineUpdatedAt.toISOString(),
        before: snapshotLine(line),
        after: snapshotLine(updatedLine),
        resulting_po_updated_at: auditDate(updatedPo.updatedAt),
      });
      return updatedLine;
  }

  async function updateLine(lineId: number, rawInput: unknown, userId?: string) {
    const parsedLineId = parsePurchaseOrderLineId(lineId);
    const input = parseCommand(updateLineBodySchema, rawInput);
    return db.transaction((tx) => updateLineInTransaction(tx, parsedLineId, input, userId));
  }

  async function cancelLineInTransaction(
    tx: any,
    lineId: number,
    input: CancelPurchaseOrderLineCommand,
    userId?: string,
  ) {
      const parentRows = await tx
        .select({ purchaseOrderId: purchaseOrderLines.purchaseOrderId })
        .from(purchaseOrderLines)
        .where(eq(purchaseOrderLines.id, lineId))
        .limit(1);
      if (!parentRows[0]) throw new PurchaseOrderLineCommandError("PO line not found", 404);
      const purchaseOrderId = parentRows[0].purchaseOrderId;
      const header = await lockHeader(tx, purchaseOrderId);
      assertDraftHeader(header);
      assertExpectedVersion("purchase_order", header.updatedAt, input.expectedPoUpdatedAt);
      await assertNoRecommendationOwnership(tx, purchaseOrderId);
      const lineRows = await tx
        .select()
        .from(purchaseOrderLines)
        .where(and(
          eq(purchaseOrderLines.id, lineId),
          eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
        ))
        .limit(1)
        .for("update");
      const line = lineRows[0];
      if (!line) {
        throw new PurchaseOrderLineCommandError("PO line changed ownership while it was being cancelled", 409, {
          code: "PO_LINE_COMMAND_OWNERSHIP_CONFLICT",
        });
      }
      assertExpectedVersion("purchase_order_line", line.updatedAt, input.expectedLineUpdatedAt);
      assertEditableLine(line);
      await assertNoDownstreamLinks(tx, lineId);
      const updatedRows = await tx
        .update(purchaseOrderLines)
        .set({
          status: "cancelled",
          cancelledQty: line.orderQty,
          parentLineId: null,
          updatedAt: sql`GREATEST(
            date_trunc('milliseconds', transaction_timestamp()),
            ${line.updatedAt}::timestamp + interval '1 millisecond'
          )`,
        })
        .where(and(
          eq(purchaseOrderLines.id, lineId),
          eq(purchaseOrderLines.purchaseOrderId, purchaseOrderId),
          eq(purchaseOrderLines.status, "open"),
        ))
        .returning();
      const cancelledLine = updatedRows[0];
      if (!cancelledLine) {
        throw new PurchaseOrderLineCommandError("Line changed while the command was being applied", 409, {
          code: "PO_LINE_COMMAND_LINE_CONFLICT",
        });
      }
      const updatedPo = await updateHeaderTotals(tx, header, userId);
      await emitEvent(tx, purchaseOrderId, "line_cancelled", userId, {
        reason: input.reason,
        expected_po_updated_at: input.expectedPoUpdatedAt.toISOString(),
        expected_line_updated_at: input.expectedLineUpdatedAt.toISOString(),
        before: snapshotLine(line),
        after: snapshotLine(cancelledLine),
        resulting_po_updated_at: auditDate(updatedPo.updatedAt),
      });
      return cancelledLine;
  }

  async function cancelLine(lineId: number, rawInput: unknown, userId?: string) {
    const parsedLineId = parsePurchaseOrderLineId(lineId);
    const input = parseCommand(cancelLineBodySchema, rawInput);
    return db.transaction((tx) => cancelLineInTransaction(tx, parsedLineId, input, userId));
  }

  async function addLineCommand(
    purchaseOrderId: number,
    rawInput: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) {
    return runTransactionalFinancialCommand({
      repository: commandRepository,
      descriptor,
      classifyFailure: classifyLineCommandFailure,
      work: async (tx) => {
        const parsedPurchaseOrderId = parsePurchaseOrderId(purchaseOrderId);
        const input = parseCommand(addLineBodySchema, rawInput);
        const line = await addLineInTransaction(tx, parsedPurchaseOrderId, input, userId);
        return {
          httpStatus: 201,
          body: line,
          resultType: "purchase_order_line",
          resultId: line.id,
        };
      },
    });
  }

  async function addBulkLinesCommand(
    purchaseOrderId: number,
    rawInput: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) {
    return runTransactionalFinancialCommand({
      repository: commandRepository,
      descriptor,
      classifyFailure: classifyLineCommandFailure,
      work: async (tx) => {
        const parsedPurchaseOrderId = parsePurchaseOrderId(purchaseOrderId);
        const input = parseCommand(addBulkLinesBodySchema, rawInput);
        const lines = await addBulkLinesInTransaction(tx, parsedPurchaseOrderId, input, userId);
        return {
          httpStatus: 201,
          body: { lines },
          resultType: "purchase_order",
          resultId: purchaseOrderId,
        };
      },
    });
  }

  async function updateLineCommand(
    lineId: number,
    rawInput: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) {
    return runTransactionalFinancialCommand({
      repository: commandRepository,
      descriptor,
      classifyFailure: classifyLineCommandFailure,
      work: async (tx) => {
        const parsedLineId = parsePurchaseOrderLineId(lineId);
        const input = parseCommand(updateLineBodySchema, rawInput);
        const line = await updateLineInTransaction(tx, parsedLineId, input, userId);
        return {
          httpStatus: 200,
          body: line,
          resultType: "purchase_order_line",
          resultId: line.id,
        };
      },
    });
  }

  async function cancelLineCommand(
    lineId: number,
    rawInput: unknown,
    userId: string | undefined,
    descriptor: FinancialCommandDescriptor,
  ) {
    return runTransactionalFinancialCommand({
      repository: commandRepository,
      descriptor,
      classifyFailure: classifyLineCommandFailure,
      work: async (tx) => {
        const parsedLineId = parsePurchaseOrderLineId(lineId);
        const input = parseCommand(cancelLineBodySchema, rawInput);
        const line = await cancelLineInTransaction(tx, parsedLineId, input, userId);
        return {
          httpStatus: 200,
          body: { success: true, line },
          resultType: "purchase_order_line",
          resultId: line.id,
        };
      },
    });
  }

  return {
    addLine,
    addBulkLines,
    updateLine,
    cancelLine,
    addLineCommand,
    addBulkLinesCommand,
    updateLineCommand,
    cancelLineCommand,
  };
}
