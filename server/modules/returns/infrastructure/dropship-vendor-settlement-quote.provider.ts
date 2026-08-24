import { pool } from "../../../db";
import {
  createDropshipReturnPolicyServiceFromEnv,
} from "../../dropship/infrastructure/dropship-return-policy.factory";
import type { DropshipReturnPolicyService } from "../../dropship/application/dropship-return-policy-service";
import {
  computeDropshipReturnSettlement,
  type DropshipReturnAcceptedLine,
  type DropshipReturnEngineFaultCategory,
  type DropshipReturnFeeScheduleRow,
} from "../../dropship/domain/return-fee-engine";
import {
  ReturnCaseFinancialError,
  type ReturnFinancialCaseSource,
  type VendorSettlementQuote,
  type VendorSettlementQuoteProvider,
} from "../application/return-case-financial.service";

interface EconomicsRow {
  vendor_id: unknown;
  store_connection_id: unknown;
  currency: unknown;
  shipping_cents: unknown;
  pricing_snapshot: unknown;
}

interface WholesaleSnapshotLine {
  productVariantId: number;
  quantity: number;
  wholesaleUnitCostCents: number;
}

export class DropshipVendorSettlementQuoteProvider implements VendorSettlementQuoteProvider {
  constructor(
    private readonly returnPolicyService: DropshipReturnPolicyService = createDropshipReturnPolicyServiceFromEnv(),
  ) {}

  async quote(input: {
    source: ReturnFinancialCaseSource;
    faultCategory: DropshipReturnEngineFaultCategory;
    at: Date;
  }): Promise<VendorSettlementQuote> {
    const vendorId = input.source.vendorId;
    if (vendorId === null) throw financialError("RETURN_VENDOR_ID_MISSING", "The return case has no dropship vendor identity.");
    const result = await pool.query<EconomicsRow>(
      `SELECT vendor_id, store_connection_id, currency, shipping_cents, pricing_snapshot
       FROM dropship.dropship_order_economics_snapshots
       WHERE oms_order_id = $1
       ORDER BY id DESC
       LIMIT 2`,
      [input.source.omsOrderId],
    );
    if (result.rows.length !== 1) {
      throw financialError(
        "RETURN_VENDOR_SETTLEMENT_ECONOMICS_NOT_FOUND",
        result.rows.length === 0
          ? "The dropship order economics snapshot was not found."
          : "More than one dropship economics snapshot matched the source order.",
        { caseId: input.source.caseId, omsOrderId: input.source.omsOrderId, matches: result.rows.length },
      );
    }
    const row = result.rows[0];
    const snapshotVendorId = positiveInteger(row.vendor_id, "economics vendor id");
    const snapshotStoreConnectionId = positiveInteger(row.store_connection_id, "economics store connection id");
    const currency = currencyCode(row.currency, "economics currency");
    if (snapshotVendorId !== vendorId
      || input.source.storeConnectionId === null
      || snapshotStoreConnectionId !== input.source.storeConnectionId) {
      throw financialError(
        "RETURN_VENDOR_SETTLEMENT_ECONOMICS_MISMATCH",
        "The dropship economics snapshot does not belong to this return case vendor and store.",
        { caseId: input.source.caseId },
      );
    }
    if (currency !== input.source.currency) {
      throw financialError(
        "RETURN_VENDOR_SETTLEMENT_CURRENCY_MISMATCH",
        "The dropship economics currency does not match the source order.",
        { caseId: input.source.caseId, sourceCurrency: input.source.currency, economicsCurrency: currency },
      );
    }
    const acceptedLines = buildAcceptedLines(input.source, parseWholesaleLines(row.pricing_snapshot));
    const fees = await this.returnPolicyService.resolveReturnFees({
      vendorId,
      storeConnectionId: snapshotStoreConnectionId,
      faultCategory: input.faultCategory,
      at: input.at,
    });
    const settlement = computeDropshipReturnSettlement({
      faultCategory: input.faultCategory,
      acceptedLines,
      originalShippingCents: nonNegativeInteger(row.shipping_cents, "economics shipping cents"),
      // Return-label cost becomes chargeable only when canonical label evidence
      // is added. Null prevents an unproven estimate from changing vendor money.
      returnShippingActualCents: null,
      fees: {
        restockingFee: mapFee(fees.restockingFee, "restocking_fee", input.faultCategory),
        processingFee: mapFee(fees.processingFee, "processing_fee", input.faultCategory),
        returnShippingFee: mapFee(fees.returnShippingFee, "return_shipping_fee", input.faultCategory),
      },
    });
    return {
      currency,
      faultCategory: input.faultCategory,
      returnShippingActualCents: null,
      settlement,
      policyFeeIds: {
        restockingFeeId: fees.restockingFee?.feeId ?? null,
        processingFeeId: fees.processingFee?.feeId ?? null,
        returnShippingFeeId: fees.returnShippingFee?.feeId ?? null,
      },
    };
  }
}

function buildAcceptedLines(
  source: ReturnFinancialCaseSource,
  snapshotLines: readonly WholesaleSnapshotLine[],
): DropshipReturnAcceptedLine[] {
  const byVariant = new Map<number, { quantity: number; wholesaleUnitCostCents: number }>();
  for (const line of snapshotLines) {
    const existing = byVariant.get(line.productVariantId);
    if (existing && existing.wholesaleUnitCostCents !== line.wholesaleUnitCostCents) {
      throw financialError(
        "RETURN_VENDOR_SETTLEMENT_ECONOMICS_INVALID",
        "The economics snapshot contains conflicting wholesale costs for one variant.",
        { productVariantId: line.productVariantId },
      );
    }
    byVariant.set(line.productVariantId, {
      quantity: checkedAdd(existing?.quantity ?? 0, line.quantity, "economics variant quantity"),
      wholesaleUnitCostCents: line.wholesaleUnitCostCents,
    });
  }
  const requestedByVariant = new Map<number, number>();
  for (const item of source.items) {
    if (item.productVariantId === null) {
      throw financialError(
        "RETURN_VENDOR_SETTLEMENT_ITEM_VARIANT_MISSING",
        "A returned dropship item has no catalog variant identity.",
        { caseId: source.caseId, returnCaseItemId: item.returnCaseItemId },
      );
    }
    requestedByVariant.set(
      item.productVariantId,
      checkedAdd(requestedByVariant.get(item.productVariantId) ?? 0, item.quantity, "return variant quantity"),
    );
  }
  const accepted: DropshipReturnAcceptedLine[] = [];
  for (const [productVariantId, acceptedQuantity] of requestedByVariant) {
    const economics = byVariant.get(productVariantId);
    if (!economics || acceptedQuantity > economics.quantity) {
      throw financialError(
        "RETURN_VENDOR_SETTLEMENT_ECONOMICS_NOT_FOUND",
        "The economics snapshot does not contain enough wholesale quantity for a returned variant.",
        { caseId: source.caseId, productVariantId, acceptedQuantity, economicsQuantity: economics?.quantity ?? 0 },
      );
    }
    accepted.push({
      productVariantId,
      acceptedQuantity,
      wholesaleUnitCostCents: economics.wholesaleUnitCostCents,
    });
  }
  return accepted.sort((left, right) => (left.productVariantId ?? 0) - (right.productVariantId ?? 0));
}

function parseWholesaleLines(value: unknown): WholesaleSnapshotLine[] {
  if (!isObject(value) || !isObject(value.wholesale) || !Array.isArray(value.wholesale.lines)) {
    throw financialError("RETURN_VENDOR_SETTLEMENT_ECONOMICS_INVALID", "The dropship pricing snapshot has no wholesale line evidence.");
  }
  if (value.wholesale.lines.length === 0) {
    throw financialError("RETURN_VENDOR_SETTLEMENT_ECONOMICS_INVALID", "The dropship pricing snapshot contains no wholesale lines.");
  }
  return value.wholesale.lines.map((line, index) => {
    if (!isObject(line)) throw financialError("RETURN_VENDOR_SETTLEMENT_ECONOMICS_INVALID", "A wholesale pricing line is invalid.", { index });
    return {
      productVariantId: positiveInteger(line.productVariantId, "wholesale product variant id"),
      quantity: positiveInteger(line.quantity, "wholesale quantity"),
      wholesaleUnitCostCents: nonNegativeInteger(line.wholesaleUnitCostCents, "wholesale unit cost cents"),
    };
  });
}

function mapFee(
  record: { amountType: "flat_cents" | "percent"; amount: number } | null,
  feeType: DropshipReturnFeeScheduleRow["feeType"],
  responsibility: DropshipReturnEngineFaultCategory,
): DropshipReturnFeeScheduleRow | null {
  if (!record) return null;
  return {
    feeType,
    amountType: record.amountType,
    amount: nonNegativeInteger(record.amount, "return fee amount"),
    responsibility,
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw financialError("RETURN_VENDOR_SETTLEMENT_EVIDENCE_INVALID", `${field} is invalid.`);
  return parsed;
}

function nonNegativeInteger(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw financialError("RETURN_VENDOR_SETTLEMENT_EVIDENCE_INVALID", `${field} is invalid.`);
  return parsed;
}

function currencyCode(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Z]{3}$/.test(value)) throw financialError("RETURN_VENDOR_SETTLEMENT_EVIDENCE_INVALID", `${field} is invalid.`);
  return value;
}

function checkedAdd(left: number, right: number, field: string): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) throw financialError("RETURN_VENDOR_SETTLEMENT_EVIDENCE_INVALID", `${field} exceeds the safe integer range.`);
  return value;
}

function financialError(code: string, message: string, context?: Record<string, unknown>): ReturnCaseFinancialError {
  return new ReturnCaseFinancialError(code, message, 409, context);
}
