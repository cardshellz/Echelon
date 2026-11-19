import { desc, eq, inArray, sql } from "drizzle-orm";
import { readIntegerCents } from "@shared/money-read";
import {
  products as productsTable,
  productVariants as productVariantsTable,
  purchaseOrderLines as purchaseOrderLinesTable,
  vendorProducts as vendorProductsTable,
  vendors as vendorsTable,
} from "@shared/schema";
import {
  isPoLineType,
  PO_LINE_TYPES,
  poPriorityEnum,
  poTypeEnum,
  type PoLineType,
} from "@shared/schema/procurement.schema";
import {
  normalizePoLinePricing,
  type NormalizedPoLinePricing,
} from "@shared/utils/po-line-pricing";
import type { PurchaseOrderEntryTransaction } from "../purchase-order-entry.repository";
import {
  vendorCatalogPricingMatches,
  vendorCatalogQuoteUsability,
} from "../purchase-order-line-commands";
import { checkReceiveVariantChosen } from "../receive-configuration-policy";
import type { CalculatedLineCosts, PurchasingCosting } from "./purchasing-costing";
import {
  auditDate,
  isValidIsoDateOnly,
  MAX_INLINE_PO_LINES,
  MAX_QUOTE_CLOCK_SKEW_MS,
  PG_INTEGER_MAX,
  PurchasingError,
  requireUsdPurchaseOrderCurrency,
  signedMillsToCents,
  type CreatePurchaseOrderWithLinesInput,
  type PurchasingBaseContext,
} from "./purchasing.types";

export type ResolvedPurchaseOrderLine = {
  line: CreatePurchaseOrderWithLinesInput["lines"][number];
  lineType: PoLineType;
  variant: any;
  product: any;
  vendorProduct: any;
  costs: CalculatedLineCosts;
  pricing: NormalizedPoLinePricing | null;
  receiveConfigurationNormalization: {
    submittedVariantId: number;
    reason: "inactive";
  } | null;
};

export function createPurchasingEntryValidation(
  ctx: PurchasingBaseContext,
  costing: Pick<PurchasingCosting, "calculateLineCosts">,
) {
  const { storage, now } = ctx;
  const { calculateLineCosts } = costing;

  function validateCreateWithLinesInput(
    input: CreatePurchaseOrderWithLinesInput,
    options: { allowExistingLineIds?: boolean } = {},
  ): void {
    if (!input || typeof input !== "object") {
      throw new PurchasingError("Request body is required", 400);
    }
    if (
      !Number.isSafeInteger(input.vendorId) ||
      input.vendorId <= 0 ||
      input.vendorId > PG_INTEGER_MAX
    ) {
      throw new PurchasingError("vendor_id is required", 400);
    }
    if (
      input.warehouseId !== undefined &&
      input.warehouseId !== null &&
      (!Number.isSafeInteger(input.warehouseId) ||
        input.warehouseId <= 0 ||
        input.warehouseId > PG_INTEGER_MAX)
    ) {
      throw new PurchasingError("warehouse_id must be a positive integer or null", 400);
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0) {
      throw new PurchasingError("At least one line is required", 400);
    }
    if (input.lines.length > MAX_INLINE_PO_LINES) {
      throw new PurchasingError(
        `A purchase order may contain at most ${MAX_INLINE_PO_LINES} lines`,
        400,
      );
    }
    if (input.poType !== undefined && !poTypeEnum.includes(input.poType as any)) {
      throw new PurchasingError(`po_type must be one of ${poTypeEnum.join(", ")}`, 400);
    }
    if (input.priority !== undefined && !poPriorityEnum.includes(input.priority as any)) {
      throw new PurchasingError(`priority must be one of ${poPriorityEnum.join(", ")}`, 400);
    }
    if (
      input.expectedDeliveryDate !== undefined &&
      input.expectedDeliveryDate !== null &&
      (!(input.expectedDeliveryDate instanceof Date) || Number.isNaN(input.expectedDeliveryDate.getTime()))
    ) {
      throw new PurchasingError("expected_delivery_date must be a valid date", 400);
    }

    // First pass: per-line shape + type rules. Build clientId->index map
    // for the second pass (parent resolution).
    const clientIdToIndex = new Map<string, number>();
    const existingLineIds = new Set<number>();
    for (const [idx, line] of input.lines.entries()) {
      const label = `lines[${idx}]`;
      if (!line || typeof line !== "object") {
        throw new PurchasingError(`${label} is invalid`, 400);
      }
      if (line.lineId !== undefined && line.lineId !== null) {
        if (!options.allowExistingLineIds) {
          throw new PurchasingError(`${label}.line_id is not valid when creating a PO`, 400);
        }
        if (
          !Number.isSafeInteger(line.lineId) ||
          line.lineId <= 0 ||
          line.lineId > PG_INTEGER_MAX
        ) {
          throw new PurchasingError(`${label}.line_id must be a positive integer`, 400);
        }
        if (existingLineIds.has(line.lineId)) {
          throw new PurchasingError(`${label}.line_id ${line.lineId} is duplicated`, 400);
        }
        existingLineIds.add(line.lineId);
      }

      const lineType: PoLineType = line.lineType ?? "product";
      if (!isPoLineType(lineType)) {
        throw new PurchasingError(
          `${label}.line_type must be one of ${PO_LINE_TYPES.join(", ")}`,
          400,
        );
      }

      // Description rule: required on non-product lines, optional on product.
      if (lineType !== "product") {
        const desc = typeof line.description === "string" ? line.description.trim() : "";
        if (desc.length === 0) {
          throw new PurchasingError(
            `${label}.description is required for ${lineType} lines`,
            400,
          );
        }
      }

      // Product rule.
      if (lineType === "product") {
        if (
          !Number.isSafeInteger(line.productId) ||
          (line.productId as number) <= 0 ||
          (line.productId as number) > PG_INTEGER_MAX
        ) {
          throw new PurchasingError(`${label}.product_id is required`, 400);
        }
        for (const [field, value] of [
          ["product_variant_id", line.productVariantId],
          ["expected_receive_variant_id", line.expectedReceiveVariantId],
          ["vendor_product_id", line.vendorProductId],
        ] as const) {
          if (
            value !== undefined &&
            value !== null &&
            (!Number.isSafeInteger(value) || value <= 0 || value > PG_INTEGER_MAX)
          ) {
            throw new PurchasingError(`${label}.${field} must be a positive integer`, 400);
          }
        }
        if (
          line.expectedReceiveUnitsPerVariant !== undefined &&
          line.expectedReceiveUnitsPerVariant !== null &&
          (
            !Number.isSafeInteger(line.expectedReceiveUnitsPerVariant) ||
              line.expectedReceiveUnitsPerVariant <= 0 ||
              line.expectedReceiveUnitsPerVariant > PG_INTEGER_MAX
          )
        ) {
          throw new PurchasingError(
            `${label}.expected_receive_units_per_variant must be a positive integer`,
            400,
          );
        }
        // Which package the goods arrive in is an explicit decision on every
        // product line; there is no legacy-variant fallback and no default.
        const unchosenReceiveVariant = checkReceiveVariantChosen({
          lineType,
          expectedReceiveVariantId: line.expectedReceiveVariantId ?? null,
          productId: line.productId ?? null,
          label,
        });
        if (unchosenReceiveVariant) {
          throw new PurchasingError(
            unchosenReceiveVariant.message,
            unchosenReceiveVariant.status,
            { code: unchosenReceiveVariant.code, ...unchosenReceiveVariant.context },
          );
        }
      } else {
        if (
          line.productId !== undefined &&
          line.productId !== null
        ) {
          throw new PurchasingError(
            `${label}.product_id is only valid on product lines`,
            400,
          );
        }
        if (
          line.productVariantId !== undefined &&
          line.productVariantId !== null
        ) {
          throw new PurchasingError(
            `${label}.product_variant_id is only valid on product lines`,
            400,
          );
        }
        if (
          line.expectedReceiveVariantId !== undefined &&
          line.expectedReceiveVariantId !== null
        ) {
          throw new PurchasingError(
            `${label}.expected_receive_variant_id is only valid on product lines`,
            400,
          );
        }
        if (
          line.expectedReceiveUnitsPerVariant !== undefined &&
          line.expectedReceiveUnitsPerVariant !== null
        ) {
          throw new PurchasingError(
            `${label}.expected_receive_units_per_variant is only valid on product lines`,
            400,
          );
        }
      }

      let normalizedQuotePricing: NormalizedPoLinePricing | null = null;
      if (line.pricing !== undefined) {
        if (lineType !== "product") {
          throw new PurchasingError(`${label}.pricing is only valid on product lines`, 400);
        }
        try {
          normalizedQuotePricing = normalizePoLinePricing(line.pricing);
        } catch (error: any) {
          throw new PurchasingError(`${label}.pricing is invalid: ${error.message}`, 400, {
            code: "PO_LINE_PRICING_INVALID",
            lineIndex: idx,
          });
        }
        if (line.orderQty !== normalizedQuotePricing.orderQty) {
          throw new PurchasingError(
            `${label}.quantity_ordered must equal the piece quantity derived from pricing`,
            400,
            {
              code: "PO_LINE_PRICING_QUANTITY_MISMATCH",
              quantityOrdered: line.orderQty,
              pricingQuantityPieces: normalizedQuotePricing.orderQty,
            },
          );
        }
      }
      if (
        line.pricingSource !== undefined &&
        !["legacy", "manual", "vendor_catalog", "recommendation"].includes(line.pricingSource)
      ) {
        throw new PurchasingError(`${label}.pricing_source is invalid`, 400);
      }
      if (line.pricingSource === "vendor_catalog" && !line.vendorProductId) {
        throw new PurchasingError(
          `${label}.vendor_product_id is required for vendor_catalog pricing`,
          400,
        );
      }
      if (
        normalizedQuotePricing &&
        line.pricingSource !== undefined &&
        line.pricingSource !== "manual" &&
        line.pricingSource !== "vendor_catalog"
      ) {
        throw new PurchasingError(
          `${label}.pricing_source cannot claim trusted legacy or recommendation provenance`,
          400,
          { code: "PO_LINE_PRICING_SOURCE_FORBIDDEN" },
        );
      }
      if (
        !normalizedQuotePricing &&
        line.pricingSource !== undefined &&
        line.pricingSource !== "legacy"
      ) {
        throw new PurchasingError(
          `${label}.pricing_source must be legacy when no explicit quote basis is supplied`,
          400,
          { code: "PO_LINE_PRICING_SOURCE_INVALID_FOR_LEGACY" },
        );
      }
      if (
        line.vendorSku !== undefined &&
        line.vendorSku !== null &&
        (typeof line.vendorSku !== "string" || line.vendorSku.length > 100)
      ) {
        throw new PurchasingError(`${label}.vendor_sku must be at most 100 characters`, 400);
      }
      if (
        line.quoteReference !== undefined &&
        line.quoteReference !== null &&
        (typeof line.quoteReference !== "string" || line.quoteReference.length > 255)
      ) {
        throw new PurchasingError(`${label}.quote_reference must be at most 255 characters`, 400);
      }
      if (
        line.quotedAt !== undefined &&
        line.quotedAt !== null &&
        (!(line.quotedAt instanceof Date) || Number.isNaN(line.quotedAt.getTime()))
      ) {
        throw new PurchasingError(`${label}.quoted_at must be a valid date`, 400);
      }
      if (
        line.quotedAt instanceof Date &&
        line.quotedAt.getTime() > now().getTime() + MAX_QUOTE_CLOCK_SKEW_MS
      ) {
        throw new PurchasingError(`${label}.quoted_at cannot be materially in the future`, 400, {
          code: "PO_LINE_QUOTED_AT_IN_FUTURE",
          lineIndex: idx,
        });
      }
      if (
        line.quoteValidUntil !== undefined &&
        line.quoteValidUntil !== null &&
        (
          typeof line.quoteValidUntil !== "string" ||
          !isValidIsoDateOnly(line.quoteValidUntil)
        )
      ) {
        throw new PurchasingError(`${label}.quote_valid_until must be YYYY-MM-DD`, 400);
      }
      if (
        line.quotedAt instanceof Date &&
        line.quoteValidUntil &&
        line.quoteValidUntil < line.quotedAt.toISOString().slice(0, 10)
      ) {
        throw new PurchasingError(
          `${label}.quote_valid_until cannot be earlier than quoted_at`,
          400,
          { code: "PO_LINE_QUOTE_DATE_INVALID", lineIndex: idx },
        );
      }
      if (line.catalogWrite !== undefined) {
        if (
          !line.catalogWrite ||
          typeof line.catalogWrite !== "object" ||
          line.catalogWrite.mode !== "upsert" ||
          Object.keys(line.catalogWrite).some(
            (key) => key !== "mode" && key !== "setPreferred",
          ) ||
          (
            line.catalogWrite.setPreferred !== undefined &&
            typeof line.catalogWrite.setPreferred !== "boolean"
          )
        ) {
          throw new PurchasingError(`${label}.catalog_write is invalid`, 400, {
            code: "PO_LINE_CATALOG_WRITE_INVALID",
            lineIndex: idx,
          });
        }
        if (lineType !== "product" || !normalizedQuotePricing) {
          throw new PurchasingError(
            `${label}.catalog_write requires explicit product quote pricing`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_PRICING_REQUIRED", lineIndex: idx },
          );
        }
        if (normalizedQuotePricing.pricingBasis === "extended_total") {
          throw new PurchasingError(
            `${label}.catalog_write cannot reuse a quantity-specific extended total`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_EXTENDED_TOTAL", lineIndex: idx },
          );
        }
        if ((line.pricingSource ?? "manual") !== "manual") {
          throw new PurchasingError(
            `${label}.catalog_write is only valid when the PO line consumes a manual quote`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_SOURCE_INVALID", lineIndex: idx },
          );
        }
        if (!(line.quotedAt instanceof Date)) {
          throw new PurchasingError(
            `${label}.quoted_at is required when saving reusable catalog pricing`,
            400,
            { code: "PO_LINE_CATALOG_WRITE_QUOTED_AT_REQUIRED", lineIndex: idx },
          );
        }
      }

      // Qty rule.
      if (!Number.isSafeInteger(line.orderQty) || line.orderQty > PG_INTEGER_MAX) {
        throw new PurchasingError(
          `${label}.quantity_ordered must be an integer`,
          400,
        );
      }
      if (lineType === "product") {
        if (line.orderQty <= 0) {
          throw new PurchasingError(
            `${label}.quantity_ordered must be > 0 for product lines`,
            400,
          );
        }
      } else if (lineType === "fee") {
        if (line.orderQty < 1) {
          throw new PurchasingError(
            `${label}.quantity_ordered must be >= 1 for fee lines`,
            400,
          );
        }
      } else {
        if (line.orderQty !== 1) {
          throw new PurchasingError(
            `${label}.quantity_ordered must be 1 for ${lineType} lines`,
            400,
          );
        }
      }

      // Cost rule — integer; sign varies by type.
      // Spec F Phase 1: accept totalProductCostCents (new shape) OR
      // unitCostMills/unitCostCents (old shape). At least one must be provided.
      const hasCents =
        line.unitCostCents !== undefined && line.unitCostCents !== null;
      const hasMills =
        line.unitCostMills !== undefined && line.unitCostMills !== null;
      const hasTotals =
        line.totalProductCostCents !== undefined &&
        line.totalProductCostCents !== null;

      if (normalizedQuotePricing && (hasCents || hasMills || hasTotals)) {
        throw new PurchasingError(
          `${label}: pricing cannot be combined with legacy unit/total cost fields`,
          400,
          { code: "PO_LINE_PRICING_AMBIGUOUS" },
        );
      }
      if (!normalizedQuotePricing && !hasCents && !hasMills && !hasTotals) {
        throw new PurchasingError(
          `${label}.pricing or a legacy unit/total cost field is required`,
          400,
        );
      }
      if (hasMills && !Number.isSafeInteger(line.unitCostMills)) {
        throw new PurchasingError(
          `${label}.unit_cost_mills must be an integer`,
          400,
        );
      }
      if (hasCents && !Number.isSafeInteger(line.unitCostCents)) {
        throw new PurchasingError(
          `${label}.unit_cost_cents must be an integer`,
          400,
        );
      }
      if (hasTotals && !Number.isSafeInteger(line.totalProductCostCents)) {
        throw new PurchasingError(
          `${label}.total_product_cost_cents must be an integer`,
          400,
        );
      }
      if (
        line.packagingCostCents !== undefined &&
        line.packagingCostCents !== null &&
        (!Number.isSafeInteger(line.packagingCostCents) ||
          (lineType === "product" && line.packagingCostCents < 0))
      ) {
        throw new PurchasingError(
          `${label}.packaging_cost_cents must be a non-negative integer for product lines`,
          400,
        );
      }

      // Sign check (type-specific). Use totals if present, else mills, else cents.
      const primaryCost = normalizedQuotePricing
        ? normalizedQuotePricing.totalProductCostCents
        : hasTotals
          ? (line.totalProductCostCents as number)
          : hasMills
            ? (line.unitCostMills as number)
            : (line.unitCostCents as number);
      switch (lineType) {
        case "product":
        case "fee":
        case "tax":
          if (primaryCost < 0) {
            throw new PurchasingError(
              `${label}: ${lineType} lines require a non-negative cost`,
              400,
            );
          }
          break;
        case "discount":
        case "rebate":
          if (primaryCost > 0) {
            throw new PurchasingError(
              `${label}: ${lineType} lines require a non-positive cost`,
              400,
            );
          }
          break;
        case "adjustment":
          // signed; either sign allowed.
          break;
      }

      // Cents/mills agreement check (authoritative source is mills).
      // Only applies when old shape is used (no totals provided).
      // Signed-aware so discount/rebate/adjustment pairs validate too.
      if (hasMills && hasCents && !hasTotals) {
        const expectedCents = signedMillsToCents(line.unitCostMills as number);
        if (expectedCents !== (line.unitCostCents as number)) {
          throw new PurchasingError(
            `${label}: unit_cost_mills (${line.unitCostMills}) and unit_cost_cents (${line.unitCostCents}) disagree; expected cents=${expectedCents}`,
            400,
          );
        }
      }

      // Register clientId for parent resolution (second pass).
      if (typeof line.clientId === "string" && line.clientId.length > 0) {
        if (clientIdToIndex.has(line.clientId)) {
          throw new PurchasingError(
            `${label}.clientId "${line.clientId}" is duplicated in this request`,
            400,
          );
        }
        clientIdToIndex.set(line.clientId, idx);
      }
    }

    // Second pass: parentClientId resolution.
    for (const [idx, line] of input.lines.entries()) {
      const label = `lines[${idx}]`;
      const parentClientId = line.parentClientId;
      if (parentClientId === undefined || parentClientId === null || parentClientId === "") {
        continue;
      }
      const lineType: PoLineType = line.lineType ?? "product";
      if (lineType === "product") {
        throw new PurchasingError(
          `${label}.parent_client_id is only valid on non-product lines`,
          400,
        );
      }
      if (typeof parentClientId !== "string") {
        throw new PurchasingError(
          `${label}.parent_client_id must be a string`,
          400,
        );
      }
      if (parentClientId === line.clientId) {
        throw new PurchasingError(
          `${label}.parent_client_id cannot reference itself`,
          400,
        );
      }
      const parentIdx = clientIdToIndex.get(parentClientId);
      if (parentIdx === undefined) {
        throw new PurchasingError(
          `${label}.parent_client_id "${parentClientId}" does not match any line in this request`,
          400,
        );
      }
      const parent = input.lines[parentIdx];
      const parentType: PoLineType = parent.lineType ?? "product";
      if (parentType !== "product") {
        throw new PurchasingError(
          `${label}.parent_client_id must reference a product line (found '${parentType}')`,
          400,
        );
      }
    }
  }

  async function resolvePurchaseOrderLines(
    input: CreatePurchaseOrderWithLinesInput,
    transaction?: PurchaseOrderEntryTransaction,
  ): Promise<ResolvedPurchaseOrderLine[]> {
    return Promise.all(
      input.lines.map(async (line) => {
        const lineType: PoLineType = line.lineType ?? "product";
        let effectiveLine = line;
        let variant: any = null;
        let product: any = null;
        let vendorProduct: any = null;
        let receiveConfigurationNormalization: ResolvedPurchaseOrderLine["receiveConfigurationNormalization"] = null;
        if (lineType === "product") {
          product = await storage.getProductById(line.productId as number, transaction);
          if (!product) {
            throw new PurchasingError(`Product ${line.productId} not found`, 404);
          }
          if (product.isActive === false || product.status === "archived") {
            throw new PurchasingError(`Product ${line.productId} is inactive`, 409, {
              code: "PO_LINE_PRODUCT_INACTIVE",
              productId: line.productId,
            });
          }
          // validateCreateWithLinesInput has already refused any product line
          // without an explicit choice, so there is nothing to fall back to.
          const expectedReceiveVariantId = line.expectedReceiveVariantId ?? null;
          if (expectedReceiveVariantId) {
            variant = await storage.getProductVariantById(expectedReceiveVariantId, transaction);
            if (!variant) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} not found`,
                404,
              );
            }
            if (
              Number.isInteger(variant.productId) &&
              Number(variant.productId) !== Number(product.id)
            ) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} does not belong to product ${product.id}`,
                400,
              );
            }
            if (variant.isActive === false) {
              // A PO buys product pieces. Receive configuration is optional
              // operational metadata and must not invalidate the economic line
              // when a formerly selected package variant has been archived.
              variant = null;
              receiveConfigurationNormalization = {
                submittedVariantId: Number(expectedReceiveVariantId),
                reason: "inactive",
              };
              effectiveLine = {
                ...line,
                productVariantId: null,
                expectedReceiveVariantId: null,
                expectedReceiveUnitsPerVariant: 1,
              };
            } else if (
              line.expectedReceiveUnitsPerVariant != null &&
              Number(variant.unitsPerVariant) !== line.expectedReceiveUnitsPerVariant
            ) {
              throw new PurchasingError(
                `Expected receive variant ${expectedReceiveVariantId} quantity changed`,
                409,
                {
                  code: "PO_LINE_RECEIVE_UNITS_MISMATCH",
                  submittedUnits: line.expectedReceiveUnitsPerVariant,
                  actualUnits: variant.unitsPerVariant,
                },
              );
            }
          }

          if (effectiveLine.vendorProductId !== undefined && effectiveLine.vendorProductId !== null) {
            vendorProduct = await storage.getVendorProductById(effectiveLine.vendorProductId, transaction);
            if (
              !vendorProduct ||
              Number(vendorProduct.vendorId) !== input.vendorId ||
              Number(vendorProduct.productId) !== Number(product.id) ||
              Number(vendorProduct.isActive ?? 0) !== 1
            ) {
              throw new PurchasingError(
                `Vendor product ${effectiveLine.vendorProductId} does not match vendor ${input.vendorId} and product ${product.id}`,
                400,
              );
            }
          }
          if (effectiveLine.pricingSource === "vendor_catalog") {
            if (!vendorProduct || !effectiveLine.pricing) {
              throw new PurchasingError(
                "vendor_catalog pricing requires vendorProductId and explicit pricing",
                400,
                { code: "PO_LINE_VENDOR_CATALOG_SOURCE_REQUIRES_LINK" },
              );
            }
            if (!vendorCatalogPricingMatches(vendorProduct, effectiveLine.pricing)) {
              throw new PurchasingError(
                `Vendor product ${effectiveLine.vendorProductId} pricing no longer matches the submitted quote`,
                409,
                {
                  code: "PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH",
                  vendorProductId: effectiveLine.vendorProductId,
                  catalogPricingBasis: vendorProduct.pricingBasis ?? "legacy_unknown",
                },
              );
            }
          }
        }

        const pricing = effectiveLine.pricing ? normalizePoLinePricing(effectiveLine.pricing) : null;
        const packagingCostCents = readIntegerCents(effectiveLine.packagingCostCents ?? 0, "packaging cost", true);
        const costs = pricing
          ? {
              subtotalCents: pricing.totalProductCostCents + packagingCostCents,
              discountCents: 0,
              taxCents: 0,
              lineTotalCents: pricing.totalProductCostCents + packagingCostCents,
              totalProductCostCents: pricing.totalProductCostCents,
              packagingCostCents,
              unitCostMills: pricing.unitCostMills,
              unitCostCents: pricing.unitCostCents,
            }
          : calculateLineCosts({
              orderQty: effectiveLine.orderQty,
              unitCostCents: readIntegerCents(effectiveLine.unitCostCents ?? 0, "unit cost", true),
              unitCostMills: typeof effectiveLine.unitCostMills === "number" ? effectiveLine.unitCostMills : null,
              totalProductCostCents:
                typeof effectiveLine.totalProductCostCents === "number" ? effectiveLine.totalProductCostCents : null,
              packagingCostCents:
                typeof effectiveLine.packagingCostCents === "number" ? effectiveLine.packagingCostCents : null,
            });
        for (const [field, value] of Object.entries(costs)) {
          if (!Number.isSafeInteger(value)) {
            throw new PurchasingError(`Calculated ${field} exceeds the supported integer range`, 400, {
              code: "PO_LINE_MONEY_OUT_OF_RANGE",
              field,
            });
          }
        }
        return {
          line: effectiveLine,
          lineType,
          variant,
          product,
          vendorProduct,
          costs,
          pricing,
          receiveConfigurationNormalization,
        };
      }),
    );
  }

  async function lockAndValidatePurchaseOrderReferences(
    tx: any,
    vendorId: number,
    resolvedLines: readonly ResolvedPurchaseOrderLine[],
  ): Promise<any> {
    const vendorRows = await tx
      .select()
      .from(vendorsTable)
      .where(eq(vendorsTable.id, vendorId))
      .limit(1)
      .for("share");
    const vendor = vendorRows[0];
    if (!vendor) throw new PurchasingError("Vendor not found", 404);
    if (Number(vendor.active) !== 1) {
      throw new PurchasingError("Vendor is inactive", 409, {
        code: "PO_VENDOR_INACTIVE",
        vendorId,
      });
    }

    const productLines = resolvedLines.filter((resolved) => resolved.lineType === "product");
    const productIds = [...new Set(
      productLines.map((resolved) => Number(resolved.line.productId)),
    )].sort((a, b) => a - b);
    const liveProducts = productIds.length === 0
      ? []
      : await tx
          .select()
          .from(productsTable)
          .where(inArray(productsTable.id, productIds))
          .orderBy(productsTable.id)
          .for("share");
    const productsById = new Map<number, any>(
      liveProducts.map((row: any) => [Number(row.id), row]),
    );
    for (const resolved of productLines) {
      const productId = Number(resolved.line.productId);
      const live = productsById.get(productId);
      if (!live) throw new PurchasingError(`Product ${productId} not found`, 404);
      if (live.isActive === false || live.status === "archived") {
        throw new PurchasingError(`Product ${productId} is inactive`, 409, {
          code: "PO_LINE_PRODUCT_INACTIVE",
          productId,
        });
      }
      resolved.product = live;
    }

    const variantIds = [...new Set(
      productLines
        .map((resolved) => resolved.variant?.id ?? null)
        .filter((id): id is number => id !== null),
    )].sort((a, b) => a - b);
    const liveVariants = variantIds.length === 0
      ? []
      : await tx
          .select()
          .from(productVariantsTable)
          .where(inArray(productVariantsTable.id, variantIds))
          .orderBy(productVariantsTable.id)
          .for("share");
    const variantsById = new Map<number, any>(
      liveVariants.map((row: any) => [Number(row.id), row]),
    );
    for (const resolved of productLines) {
      const variantId = resolved.variant?.id ?? null;
      if (variantId === null) {
        resolved.variant = null;
        continue;
      }
      const live = variantsById.get(Number(variantId));
      if (!live) {
        throw new PurchasingError(`Expected receive variant ${variantId} not found`, 404);
      }
      if (Number(live.productId) !== Number(resolved.product.id)) {
        throw new PurchasingError(
          `Expected receive variant ${variantId} does not belong to product ${resolved.product.id}`,
          400,
        );
      }
      if (live.isActive === false) {
        resolved.receiveConfigurationNormalization = {
          submittedVariantId: Number(variantId),
          reason: "inactive",
        };
        resolved.variant = null;
        resolved.line = {
          ...resolved.line,
          productVariantId: null,
          expectedReceiveVariantId: null,
          expectedReceiveUnitsPerVariant: 1,
        };
        continue;
      }
      if (
        resolved.line.expectedReceiveUnitsPerVariant != null &&
        Number(live.unitsPerVariant) !== resolved.line.expectedReceiveUnitsPerVariant
      ) {
        throw new PurchasingError(`Expected receive variant ${variantId} quantity changed`, 409, {
          code: "PO_LINE_RECEIVE_UNITS_MISMATCH",
          submittedUnits: resolved.line.expectedReceiveUnitsPerVariant,
          actualUnits: live.unitsPerVariant,
        });
      }
      resolved.variant = live;
    }

    const linkedLines = productLines.filter(
      (resolved) => resolved.line.vendorProductId !== undefined && resolved.line.vendorProductId !== null,
    );
    const vendorProductIds = [...new Set(
      linkedLines.map((resolved) => Number(resolved.line.vendorProductId)),
    )].sort((a, b) => a - b);
    const liveVendorProducts = vendorProductIds.length === 0
      ? []
      : await tx
          .select()
          .from(vendorProductsTable)
          .where(inArray(vendorProductsTable.id, vendorProductIds))
          .orderBy(vendorProductsTable.id)
          .for("share");
    const liveById = new Map<number, any>(
      liveVendorProducts.map((row: any) => [Number(row.id), row]),
    );

    for (const resolved of productLines) {
      const vendorProductId = resolved.line.vendorProductId == null
        ? null
        : Number(resolved.line.vendorProductId);
      if (vendorProductId === null) {
        resolved.vendorProduct = null;
        continue;
      }
      const live = liveById.get(vendorProductId);
      if (
        !live ||
        Number(live.vendorId) !== vendorId ||
        Number(live.productId) !== Number(resolved.product.id) ||
        Number(live.isActive ?? 0) !== 1
      ) {
        throw new PurchasingError(
          `Vendor product ${vendorProductId} changed before the PO could be saved`,
          409,
          { code: "PO_LINE_VENDOR_PRODUCT_MISMATCH", vendorProductId },
        );
      }
      resolved.vendorProduct = live;

      if (resolved.line.pricingSource !== "vendor_catalog") continue;
      if (
        !resolved.line.pricing ||
        !vendorCatalogPricingMatches(live, resolved.line.pricing)
      ) {
        throw new PurchasingError(
          `Vendor product ${vendorProductId} pricing changed before the PO could be saved`,
          409,
          {
            code: "PO_LINE_VENDOR_CATALOG_PRICE_MISMATCH",
            vendorProductId,
            catalogPricingBasis: live.pricingBasis ?? "legacy_unknown",
          },
        );
      }
      const quoteUsability = vendorCatalogQuoteUsability(live, now());
      if (!quoteUsability.usable) {
        throw new PurchasingError(
          `Vendor product ${vendorProductId} has an expired, stale, future-dated, or unverified quote`,
          409,
          { code: quoteUsability.code, vendorProductId },
        );
      }
    }
    return vendor;
  }


  async function assertNoDraftLineDownstreamLinks(
    tx: any,
    lineIds: readonly number[],
  ): Promise<void> {
    if (lineIds.length === 0) return;
    const ids = sql.join(lineIds.map((id) => sql`${id}`), sql`, `);
    const result = await tx.execute(sql`
      SELECT blocked.line_id, blocked.blocker
      FROM (
        SELECT purchase_order_line_id AS line_id, 'inbound_shipment_lines'::text AS blocker
          FROM procurement.inbound_shipment_lines
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'po_receipts'::text
          FROM procurement.po_receipts
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'vendor_invoice_lines'::text
          FROM procurement.vendor_invoice_lines
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'landed_cost_snapshots'::text
          FROM procurement.landed_cost_snapshots
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'landed_cost_adjustments'::text
          FROM procurement.landed_cost_adjustments
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT purchase_order_line_id, 'receiving_lines'::text
          FROM procurement.receiving_lines
          WHERE purchase_order_line_id IN (${ids})
        UNION ALL
        SELECT po_line_id, 'inventory_lots'::text
          FROM inventory.inventory_lots
          WHERE po_line_id IN (${ids})
        UNION ALL
        SELECT parent_line_id, 'active_child_lines'::text
          FROM procurement.purchase_order_lines
          WHERE parent_line_id IN (${ids})
            AND id NOT IN (${ids})
            AND status <> 'cancelled'
      ) AS blocked
      LIMIT 100
    `);
    const blockers = (result.rows ?? []).map((row: any) => ({
      lineId: Number(row.line_id),
      blocker: String(row.blocker),
    }));
    if (blockers.length > 0) {
      throw new PurchasingError(
        "Draft lines have downstream or dependent records and cannot be replaced",
        409,
        { code: "PO_DRAFT_LINE_DOWNSTREAM_LINKS", blockers },
      );
    }
  }

  function buildPurchaseOrderLineValues(
    purchaseOrderId: number,
    resolved: ResolvedPurchaseOrderLine,
    lineNumber: number,
  ): Record<string, unknown> {
    const isProduct = resolved.lineType === "product";
    const trustedCatalog =
      isProduct && resolved.line.pricingSource === "vendor_catalog"
        ? resolved.vendorProduct
        : null;
    return {
      purchaseOrderId,
      lineNumber,
      productId: isProduct ? resolved.product.id : null,
      productVariantId: isProduct ? (resolved.variant?.id ?? null) : null,
      expectedReceiveVariantId: isProduct ? (resolved.variant?.id ?? null) : null,
      vendorProductId: isProduct ? (resolved.line.vendorProductId ?? null) : null,
      sku: isProduct ? (resolved.product.sku ?? resolved.variant?.sku ?? null) : null,
      productName: isProduct ? resolved.product.name : null,
      vendorSku: isProduct
        ? (trustedCatalog ? (trustedCatalog.vendorSku ?? null) : (resolved.line.vendorSku ?? null))
        : null,
      description: resolved.line.description ?? null,
      notes: resolved.line.notes ?? null,
      unitOfMeasure: isProduct
        ? (resolved.variant?.name?.split(" ")[0]?.toLowerCase() ?? "each")
        : null,
      unitsPerUom: isProduct ? (resolved.variant?.unitsPerVariant || 1) : 1,
      expectedReceiveUnitsPerVariant: isProduct && resolved.variant
        ? (resolved.line.expectedReceiveUnitsPerVariant || resolved.variant?.unitsPerVariant || 1)
        : 1,
      orderQty: resolved.pricing?.orderQty ?? resolved.line.orderQty,
      unitCostCents: resolved.costs.unitCostCents,
      unitCostMills: resolved.costs.unitCostMills,
      totalProductCostCents: isProduct ? resolved.costs.totalProductCostCents : 0,
      packagingCostCents: isProduct ? resolved.costs.packagingCostCents : 0,
      discountCents: resolved.costs.discountCents,
      taxCents: resolved.costs.taxCents,
      lineTotalCents: resolved.costs.lineTotalCents,
      pricingBasis: isProduct
        ? (resolved.pricing?.pricingBasis ?? "legacy_unknown")
        : "not_applicable",
      pricingSource: isProduct
        ? (resolved.pricing ? (resolved.line.pricingSource ?? "manual") : "legacy")
        : "manual",
      purchaseUom: resolved.pricing?.purchaseUom ?? null,
      purchaseUomQuantity: resolved.pricing?.purchaseUomQuantity ?? null,
      piecesPerPurchaseUom: resolved.pricing?.piecesPerPurchaseUom ?? null,
      quotedUnitCostMills: resolved.pricing?.quotedUnitCostMills ?? null,
      quotedTotalCents: resolved.pricing?.quotedTotalCents ?? null,
      pricingRemainderMills: resolved.pricing?.pricingRemainderMills ?? 0,
      quoteReference: isProduct
        ? (trustedCatalog ? (trustedCatalog.quoteReference ?? null) : (resolved.line.quoteReference ?? null))
        : null,
      quotedAt: isProduct
        ? (trustedCatalog ? (trustedCatalog.quotedAt ?? null) : (resolved.line.quotedAt ?? null))
        : null,
      quoteValidUntil: isProduct
        ? (trustedCatalog ? (trustedCatalog.quoteValidUntil ?? null) : (resolved.line.quoteValidUntil ?? null))
        : null,
      lineType: resolved.lineType,
      parentLineId: null,
      status: "open",
    };
  }

  function receiveConfigurationNormalizations(
    resolvedLines: readonly ResolvedPurchaseOrderLine[],
  ): Array<Record<string, unknown>> {
    return resolvedLines.flatMap((resolved, index) => {
      const normalization = resolved.receiveConfigurationNormalization;
      if (!normalization) return [];
      return [{
        line_number: index + 1,
        line_id: resolved.line.lineId ?? null,
        submitted_variant_id: normalization.submittedVariantId,
        reason: normalization.reason,
        normalized_receive_as: "pieces",
      }];
    });
  }

  async function applyPurchaseOrderParentLineLinks(
    tx: any,
    resolvedLines: ResolvedPurchaseOrderLine[],
    persistedLines: any[],
    updatedAt?: Date,
  ): Promise<void> {
    const clientIdToLineId = new Map<string, number>();
    resolvedLines.forEach((resolved, index) => {
      const clientId = resolved.line.clientId;
      const lineId = persistedLines[index]?.id;
      if (typeof clientId === "string" && clientId.length > 0 && Number.isInteger(lineId)) {
        clientIdToLineId.set(clientId, lineId);
      }
    });

    for (let index = 0; index < resolvedLines.length; index++) {
      const parentClientId = resolvedLines[index].line.parentClientId;
      if (!parentClientId) continue;
      const parentLineId = clientIdToLineId.get(parentClientId);
      const childLineId = persistedLines[index]?.id;
      if (!parentLineId || !Number.isInteger(childLineId)) {
        throw new PurchasingError("Unable to resolve draft line parent linkage", 409, {
          code: "PO_DRAFT_PARENT_LINK_CONFLICT",
          parentClientId,
        });
      }
      await tx
        .update(purchaseOrderLinesTable)
        .set({ parentLineId, ...(updatedAt ? { updatedAt } : {}) })
        .where(eq(purchaseOrderLinesTable.id, childLineId));
      persistedLines[index].parentLineId = parentLineId;
    }
  }

  function snapshotDraftHeader(po: any): Record<string, unknown> {
    return {
      vendor_id: po.vendorId,
      warehouse_id: po.warehouseId ?? null,
      po_type: po.poType ?? null,
      priority: po.priority ?? null,
      expected_delivery_date: auditDate(po.expectedDeliveryDate),
      incoterms: po.incoterms ?? null,
      vendor_notes: po.vendorNotes ?? null,
      internal_notes: po.internalNotes ?? null,
      currency: po.currency ?? null,
      payment_terms_days: po.paymentTermsDays ?? null,
      payment_terms_type: po.paymentTermsType ?? null,
      ship_from_address: po.shipFromAddress ?? null,
      subtotal_cents: po.subtotalCents ?? 0,
      discount_cents: po.discountCents ?? 0,
      tax_cents: po.taxCents ?? 0,
      shipping_cost_cents: po.shippingCostCents ?? 0,
      total_cents: po.totalCents ?? 0,
      line_count: po.lineCount ?? 0,
      updated_at: auditDate(po.updatedAt),
    };
  }

  function snapshotDraftLine(line: any): Record<string, unknown> {
    return {
      id: line.id,
      line_number: line.lineNumber,
      line_type: line.lineType ?? "product",
      parent_line_id: line.parentLineId ?? null,
      product_id: line.productId ?? null,
      product_variant_id: line.productVariantId ?? null,
      expected_receive_variant_id: line.expectedReceiveVariantId ?? null,
      expected_receive_units_per_variant: line.expectedReceiveUnitsPerVariant ?? 1,
      vendor_product_id: line.vendorProductId ?? null,
      sku: line.sku ?? null,
      product_name: line.productName ?? null,
      description: line.description ?? null,
      order_qty: line.orderQty,
      unit_cost_cents: line.unitCostCents ?? 0,
      unit_cost_mills: line.unitCostMills ?? null,
      total_product_cost_cents: line.totalProductCostCents ?? 0,
      packaging_cost_cents: line.packagingCostCents ?? 0,
      pricing_basis: line.pricingBasis ?? "legacy_unknown",
      pricing_source: line.pricingSource ?? "legacy",
      purchase_uom: line.purchaseUom ?? null,
      purchase_uom_quantity: line.purchaseUomQuantity ?? null,
      pieces_per_purchase_uom: line.piecesPerPurchaseUom ?? null,
      quoted_unit_cost_mills: line.quotedUnitCostMills ?? null,
      quoted_total_cents: line.quotedTotalCents ?? null,
      pricing_remainder_mills: line.pricingRemainderMills ?? 0,
      quote_reference: line.quoteReference ?? null,
      quoted_at: auditDate(line.quotedAt),
      quote_valid_until: line.quoteValidUntil ?? null,
      discount_cents: line.discountCents ?? 0,
      tax_cents: line.taxCents ?? 0,
      line_total_cents: line.lineTotalCents ?? 0,
      status: line.status ?? "open",
    };
  }

  return {
    validateCreateWithLinesInput,
    resolvePurchaseOrderLines,
    lockAndValidatePurchaseOrderReferences,
    assertNoDraftLineDownstreamLinks,
    buildPurchaseOrderLineValues,
    receiveConfigurationNormalizations,
    applyPurchaseOrderParentLineLinks,
    snapshotDraftHeader,
    snapshotDraftLine,
  };
}

export type PurchasingEntryValidation = ReturnType<typeof createPurchasingEntryValidation>;
