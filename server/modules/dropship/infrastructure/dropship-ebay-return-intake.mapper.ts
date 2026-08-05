import { DropshipError } from "../domain/errors";
import type {
  DropshipReturnIntakeDraft,
  DropshipReturnIntakeItemDraft,
  DropshipReturnIntakeTrackingDraft,
} from "../application/dropship-return-intake-provider";
import { parseEbayMoneyCents } from "./dropship-ebay-order-intake.mapper";

/**
 * eBay Post-Order API return case → normalized RMA draft (design spec D2a).
 *
 * The Post-Order return search/detail payloads expose:
 *   - returnId (dedupe key), orderId (orderRef back to the intake order)
 *   - lineItems with lineItemId / returnQuantity
 *   - returnReason / comments (fault hint, preserved verbatim in evidence)
 *   - returnLabelCost when eBay generated the label (actual label cost, D2a)
 *   - returnShipment tracking (carrier, tracking number, expected delivery)
 *
 * All field reads are defensive: the eBay payload shape varies by case state,
 * and a missing optional field must never crash the mapper — the draft
 * schema validates the final shape.
 */

export interface EbayReturnLineItem {
  lineItemId?: unknown;
  itemId?: unknown;
  returnQuantity?: unknown;
  quantity?: unknown;
  sku?: unknown;
  title?: unknown;
}

export interface EbayReturnCase {
  returnId?: unknown;
  orderId?: unknown;
  legacyOrderId?: unknown;
  creationDate?: unknown;
  state?: unknown;
  status?: unknown;
  returnReason?: unknown;
  comments?: unknown;
  lineItems?: unknown;
  returnLabelCost?: unknown;
  returnShipment?: unknown;
  [key: string]: unknown;
}

/** eBay return states that mean the case is closed without a return leg. */
const EBAY_SKIPPED_RETURN_STATES = new Set([
  "CLOSED_NO_REFUND",
  "RETURN_REJECTED",
]);

export function shouldRecordEbayReturnCase(input: {
  returnCase: EbayReturnCase;
}): { record: true } | { record: false; reason: string } {
  const state = readOptionalString(input.returnCase.state)?.toUpperCase();
  if (state && EBAY_SKIPPED_RETURN_STATES.has(state)) {
    return { record: false, reason: `ebay_return_state_${state.toLowerCase()}` };
  }
  return { record: true };
}

export function buildEbayReturnIntakeDraft(input: {
  returnCase: EbayReturnCase;
}): DropshipReturnIntakeDraft {
  const channelReturnId = readRequiredString(input.returnCase.returnId, "returnId");
  const orderRef = readOptionalString(input.returnCase.orderId)
    ?? readOptionalString(input.returnCase.legacyOrderId);
  if (!orderRef) {
    throw new DropshipError(
      "DROPSHIP_EBAY_RETURN_ORDER_REF_MISSING",
      "eBay return case is missing its order reference.",
      { returnId: channelReturnId, retryable: false },
    );
  }

  const items = buildEbayReturnItems(input.returnCase.lineItems);
  if (items.length === 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_RETURN_ITEMS_MISSING",
      "eBay return case has no mappable line items.",
      { returnId: channelReturnId, retryable: false },
    );
  }

  const labelCostCents = parseOptionalEbayMoneyCents(
    input.returnCase.returnLabelCost,
    "returnLabelCost",
  );
  const reasonText = readReasonText(input.returnCase);
  const returnTracking = buildEbayReturnTracking(input.returnCase.returnShipment);

  return {
    channelReturnId,
    orderRef,
    items,
    labelCostCents,
    faultHint: mapEbayReturnReasonToFaultHint(reasonText),
    reasonText,
    evidence: {
      channel: "ebay",
      returnId: channelReturnId,
      orderRef,
      state: readOptionalString(input.returnCase.state) ?? null,
      status: readOptionalString(input.returnCase.status) ?? null,
      creationDate: readOptionalString(input.returnCase.creationDate) ?? null,
      labelCostCents,
      raw: input.returnCase as Record<string, unknown>,
    },
    returnTracking,
  };
}

function buildEbayReturnItems(lineItems: unknown): DropshipReturnIntakeItemDraft[] {
  if (!Array.isArray(lineItems)) return [];
  const items: DropshipReturnIntakeItemDraft[] = [];
  for (const [index, raw] of lineItems.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const line = raw as EbayReturnLineItem;
    const channelLineId = readOptionalString(line.lineItemId)
      ?? readOptionalString(line.itemId);
    if (!channelLineId) continue;
    const quantity = readPositiveInteger(line.returnQuantity)
      ?? readPositiveInteger(line.quantity);
    if (!quantity) {
      throw new DropshipError(
        "DROPSHIP_EBAY_RETURN_ITEM_QTY_INVALID",
        "eBay return line item has no positive return quantity.",
        { lineIndex: index, channelLineId, retryable: false },
      );
    }
    items.push({
      channelLineId,
      externalLineItemId: readOptionalString(line.lineItemId) ?? null,
      sku: readOptionalString(line.sku) ?? null,
      quantity,
    });
  }
  return items;
}

function buildEbayReturnTracking(returnShipment: unknown): DropshipReturnIntakeTrackingDraft | null {
  if (!returnShipment || typeof returnShipment !== "object") return null;
  const shipment = returnShipment as Record<string, unknown>;
  const trackingNumber = readOptionalString(shipment.trackingNumber);
  if (!trackingNumber) return null;
  return {
    carrier: readOptionalString(shipment.carrierEnum)
      ?? readOptionalString(shipment.carrier)
      ?? null,
    trackingNumber,
    expectedDeliveryAt: readOptionalDate(shipment.expectedDeliveryDate)
      ?? readOptionalDate(shipment.maxEstimatedDeliveryDate)
      ?? null,
    status: readOptionalString(shipment.status) ?? null,
  };
}

function readReasonText(returnCase: EbayReturnCase): string | null {
  const reason = readOptionalString(returnCase.returnReason);
  const comments = readOptionalString(returnCase.comments);
  if (reason && comments) return `${reason}: ${comments}`.slice(0, 1000);
  return (reason ?? comments)?.slice(0, 1000) ?? null;
}

/**
 * Fault hint from the eBay return reason. Best-effort: buyer-remorse reasons
 * hint customer fault; defect/not-as-described hint vendor; everything else
 * stays null and the inspection decides. Never authoritative (D2b: human
 * disposes).
 */
export function mapEbayReturnReasonToFaultHint(
  reasonText: string | null,
): DropshipReturnIntakeDraft["faultHint"] {
  if (!reasonText) return null;
  const normalized = reasonText.toUpperCase();
  if (
    normalized.includes("DEFECTIVE")
    || normalized.includes("NOT_AS_DESCRIBED")
    || normalized.includes("WRONG_ITEM")
    || normalized.includes("DAMAGED")
  ) {
    return "vendor";
  }
  if (
    normalized.includes("REMORSE")
    || normalized.includes("NO_LONGER_NEED")
    || normalized.includes("ORDERED_BY_MISTAKE")
    || normalized.includes("FOUND_BETTER_PRICE")
  ) {
    return "customer";
  }
  if (normalized.includes("LOST") || normalized.includes("CARRIER")) {
    return "carrier";
  }
  return null;
}

function parseOptionalEbayMoneyCents(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") return null;
  return parseEbayMoneyCents(value, field);
}

function readOptionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readRequiredString(value: unknown, field: string): string {
  const text = readOptionalString(value);
  if (!text) {
    throw new DropshipError(
      "DROPSHIP_EBAY_RETURN_FIELD_MISSING",
      `eBay return case is missing required field ${field}.`,
      { field, retryable: false },
    );
  }
  return text;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return Number.isInteger(parsed) && (parsed as number) > 0 ? (parsed as number) : null;
}

function readOptionalDate(value: unknown): Date | null {
  const text = readOptionalString(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
