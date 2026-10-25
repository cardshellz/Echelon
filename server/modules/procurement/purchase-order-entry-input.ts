import { readIntegerMills, readIntegerCents } from "@shared/money-read";
import { PurchasingError, type CreatePurchaseOrderWithLinesInput, type PurchaseOrderLineInput } from "./purchasing.service";
import type { PoLinePricingInput } from "@shared/utils/po-line-pricing";

export function parseNullableDateInput(value: unknown, fieldLabel: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (typeof value !== "string" && !(value instanceof Date)) {
    throw new PurchasingError(`${fieldLabel} must be a valid date`, 400, {
      code: "INVALID_DATE_INPUT",
      field: fieldLabel,
    });
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new PurchasingError(`${fieldLabel} must be a valid date`, 400, {
      code: "INVALID_DATE_INPUT",
      field: fieldLabel,
    });
  }
  return date;
}

function mapPoLinePricingInput(line: any): PoLinePricingInput | undefined {
  const pricing = line?.pricing;
  if (!pricing || typeof pricing !== "object") return undefined;
  const basis = pricing.basis ?? pricing.pricing_basis;
  if (basis === "per_piece") {
    return {
      basis,
      quantityPieces: Number(pricing.quantityPieces ?? pricing.quantity_pieces),
      unitCostMills: readIntegerMills(pricing.unitCostMills ?? pricing.unit_cost_mills, "unit cost", true),
    };
  }
  if (basis === "per_purchase_uom") {
    return {
      basis,
      purchaseUom: String(pricing.purchaseUom ?? pricing.purchase_uom ?? ""),
      uomQuantity: Number(pricing.uomQuantity ?? pricing.uom_quantity),
      piecesPerUom: Number(pricing.piecesPerUom ?? pricing.pieces_per_uom),
      quotedCostMillsPerUom: readIntegerMills(
        pricing.quotedCostMillsPerUom ?? pricing.quoted_cost_mills_per_uom,
      ),
    };
  }
  if (basis === "extended_total") {
    return {
      basis,
      quantityPieces: Number(pricing.quantityPieces ?? pricing.quantity_pieces),
      quotedTotalCents: readIntegerCents(pricing.quotedTotalCents ?? pricing.quoted_total_cents, "quoted total", true),
    };
  }
  return pricing as PoLinePricingInput;
}

function mapCatalogWriteDirective(line: any): PurchaseOrderLineInput["catalogWrite"] {
  const raw = line?.catalog_write ?? line?.catalogWrite;
  if (raw === undefined || raw === null) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PurchasingError("catalog_write must be an object", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  const keys = Object.keys(raw);
  if (keys.some((key) => key !== "mode" && key !== "set_preferred" && key !== "setPreferred")) {
    throw new PurchasingError("catalog_write contains unsupported fields", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  if (raw.mode !== "upsert") {
    throw new PurchasingError("catalog_write.mode must be 'upsert'", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  const setPreferred = raw.set_preferred ?? raw.setPreferred;
  if (
    raw.set_preferred !== undefined &&
    raw.setPreferred !== undefined &&
    raw.set_preferred !== raw.setPreferred
  ) {
    throw new PurchasingError("catalog_write preferred flags conflict", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  if (setPreferred !== undefined && typeof setPreferred !== "boolean") {
    throw new PurchasingError("catalog_write.set_preferred must be a boolean", 400, {
      code: "PO_LINE_CATALOG_WRITE_INVALID",
    });
  }
  return {
    mode: "upsert",
    ...(setPreferred === undefined ? {} : { setPreferred }),
  };
}

function mapPurchaseOrderLineInput(line: any, includeLineId: boolean): PurchaseOrderLineInput {
  const rawCents = line?.unit_cost_cents ?? line?.unitCostCents;
  const rawMills = line?.unit_cost_mills ?? line?.unitCostMills;
  const lineType = line?.line_type ?? line?.lineType ?? "product";
  const variantIdRaw = line?.product_variant_id ?? line?.productVariantId;
  const productIdRaw = line?.product_id ?? line?.productId;
  const expectedReceiveVariantIdRaw =
    line?.expected_receive_variant_id ?? line?.expectedReceiveVariantId ?? variantIdRaw;
  const expectedReceiveUnitsPerVariantRaw =
    line?.expected_receive_units_per_variant ?? line?.expectedReceiveUnitsPerVariant;
  const pricing = mapPoLinePricingInput(line);
  const pricingSource = line?.pricing_source ?? line?.pricingSource;
  if (
    !includeLineId &&
    pricingSource !== undefined &&
    pricingSource !== "manual" &&
    pricingSource !== "vendor_catalog"
  ) {
    throw new PurchasingError("New PO lines may only use manual or vendor_catalog pricing", 400, {
      code: "PO_LINE_PRICING_SOURCE_FORBIDDEN",
    });
  }
  const rawOrderQty = line?.quantity_ordered ?? line?.orderQty;
  const pricingOrderQty = pricing?.basis === "per_purchase_uom"
    ? pricing.uomQuantity * pricing.piecesPerUom
    : pricing?.quantityPieces;
  const mapped: PurchaseOrderLineInput = {
    lineType,
    clientId: line?.client_id ?? line?.clientId ?? undefined,
    parentClientId: line?.parent_client_id ?? line?.parentClientId ?? null,
    description: line?.description ?? null,
    productId: lineType === "product" ? Number(productIdRaw) : null,
    productVariantId:
      lineType === "product" && variantIdRaw != null ? Number(variantIdRaw) : null,
    expectedReceiveVariantId:
      lineType === "product" && expectedReceiveVariantIdRaw != null
        ? Number(expectedReceiveVariantIdRaw)
        : null,
    expectedReceiveUnitsPerVariant:
      lineType === "product" && expectedReceiveUnitsPerVariantRaw != null
        ? Number(expectedReceiveUnitsPerVariantRaw)
        : null,
    orderQty: Number(rawOrderQty ?? pricingOrderQty),
    vendorProductId: line?.vendor_product_id ?? line?.vendorProductId ?? undefined,
    vendorSku: line?.vendor_sku ?? line?.vendorSku ?? null,
    notes: line?.notes ?? null,
    pricing,
    pricingSource,
    quoteReference: line?.quote_reference ?? line?.quoteReference ?? null,
    quotedAt: parseNullableDateInput(
      line?.quoted_at ?? line?.quotedAt,
      "quotedAt",
    ) ?? null,
    quoteValidUntil: line?.quote_valid_until ?? line?.quoteValidUntil ?? null,
    catalogWrite: mapCatalogWriteDirective(line),
  };

  if (includeLineId) {
    const rawLineId = line?.line_id ?? line?.lineId;
    if (rawLineId !== undefined && rawLineId !== null) mapped.lineId = Number(rawLineId);
  }
  if (rawCents !== undefined && rawCents !== null) mapped.unitCostCents = readIntegerCents(rawCents, "rawCents", true);
  if (rawMills !== undefined && rawMills !== null) mapped.unitCostMills = readIntegerMills(rawMills, "rawMills", true);

  const rawTotalProduct = line?.total_product_cost_cents ?? line?.totalProductCostCents;
  const rawPackaging = line?.packaging_cost_cents ?? line?.packagingCostCents;
  if (rawTotalProduct !== undefined && rawTotalProduct !== null) {
    mapped.totalProductCostCents = Number(rawTotalProduct);
  }
  if (rawPackaging !== undefined && rawPackaging !== null) {
    mapped.packagingCostCents = Number(rawPackaging);
  }
  return mapped;
}

export function mapPurchaseOrderWithLinesInput(
  body: any,
  includeLineIds: boolean,
): CreatePurchaseOrderWithLinesInput {
  const expectedDeliveryRaw = body?.expected_delivery_date ?? body?.expectedDeliveryDate;
  const hasWarehouseId = body?.warehouse_id !== undefined || body?.warehouseId !== undefined;
  const warehouseIdRaw = body?.warehouse_id !== undefined
    ? body.warehouse_id
    : body?.warehouseId;
  return {
    vendorId: Number(body?.vendor_id ?? body?.vendorId),
    warehouseId: !hasWarehouseId
      ? undefined
      : warehouseIdRaw === null
        ? null
        : Number(warehouseIdRaw),
    poType: body?.po_type ?? body?.poType,
    priority: body?.priority,
    expectedDeliveryDate:
      parseNullableDateInput(expectedDeliveryRaw, "expectedDeliveryDate") ?? null,
    incoterms: body?.incoterms ?? null,
    vendorNotes: body?.vendor_notes ?? body?.vendorNotes ?? null,
    internalNotes: body?.internal_notes ?? body?.internalNotes ?? null,
    lines: Array.isArray(body?.lines)
      ? body.lines.map((line: any) => mapPurchaseOrderLineInput(line, includeLineIds))
      : [],
  };
}
