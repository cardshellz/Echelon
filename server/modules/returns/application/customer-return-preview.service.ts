import { z } from "zod";
import {
  returnPortalPreviewStateSchema,
  returnPreviewLookupInputSchema,
  returnPreviewOrderSchema,
  returnPreviewReviewInputSchema,
  returnPreviewReviewSchema,
  type ReturnPortalPreviewState,
  type ReturnPreviewLookupInput,
  type ReturnPreviewOrder,
  type ReturnPreviewReview,
} from "../../../../shared/returns/customer-return-preview.contract";
import { evaluateCustomerReturnEligibility, type CustomerReturnEligibilityOutput } from "../domain/customer-return-eligibility";
import { CustomerReturnOrderReferenceError, normalizeCustomerReturnOrderReference } from "../domain/customer-return-order-reference";
import { listCustomerReturnPreviewScenarios, readCustomerReturnPreviewScenario } from "./customer-return-preview-scenarios";

type PreviewErrorCode = "RETURN_PREVIEW_INPUT_INVALID" | "RETURN_PREVIEW_ORDER_NOT_FOUND"
  | "RETURN_PREVIEW_SELECTION_INVALID" | "RETURN_PREVIEW_QUANTITY_UNAVAILABLE"
  | "RETURN_PREVIEW_PARCELS_INVALID" | "RETURN_PREVIEW_DATA_INVALID";

export class CustomerReturnPreviewError extends Error {
  constructor(readonly code: PreviewErrorCode, message: string, readonly status: number) {
    super(message);
    this.name = "CustomerReturnPreviewError";
  }
}

/**
 * Admin-only simulation over fictional fixtures. This service has no database,
 * provider, identity or authorization-store dependency. Review validates a box
 * plan; it never reserves quantities, creates an RMA, buys a label or refunds.
 * Authentication and administrator permission remain the HTTP boundary's job.
 */
export class CustomerReturnPreviewService {
  getState(): ReturnPortalPreviewState {
    return boundary(() => returnPortalPreviewStateSchema.parse({
      mode: "admin_preview", customerAccess: "disabled", dataSource: "sample_orders",
      scenarios: listCustomerReturnPreviewScenarios(),
    }));
  }

  lookup(raw: unknown): ReturnPreviewOrder {
    return boundary(() => loadSampleOrder(parseInput(returnPreviewLookupInputSchema, raw)));
  }

  review(raw: unknown): ReturnPreviewReview {
    return boundary(() => {
      const input = parseInput(returnPreviewReviewInputSchema, raw);
      // Never trust a previous lookup response or customer-supplied eligibility.
      const order = loadSampleOrder(input);
      const availableLines = new Map(order.lines.map(line => [line.id, line]));
      const selections = new Map<string, { title: string; quantity: number }>();
      let selectedQuantity = 0;
      for (const selection of input.selections) {
        const line = availableLines.get(selection.lineId);
        if (!line || selections.has(selection.lineId)) {
          throw new CustomerReturnPreviewError("RETURN_PREVIEW_SELECTION_INVALID", "Choose each available order line once.", 400);
        }
        if (selection.quantity > line.eligibleQuantity) {
          throw new CustomerReturnPreviewError("RETURN_PREVIEW_QUANTITY_UNAVAILABLE", "The selected quantity is not available to return.", 409);
        }
        selectedQuantity += selection.quantity;
        if (!Number.isSafeInteger(selectedQuantity)) {
          throw new CustomerReturnPreviewError("RETURN_PREVIEW_SELECTION_INVALID", "The selected quantity is too large.", 400);
        }
        selections.set(selection.lineId, { title: line.title, quantity: selection.quantity });
      }

      const packedQuantities = new Map<string, number>();
      const parcels = input.parcels.map((parcel, index) => {
        const linesInParcel = new Set<string>();
        const items = parcel.items.map(item => {
          const selection = selections.get(item.lineId);
          if (!selection || linesInParcel.has(item.lineId)) {
            throw parcelError("Each box must contain selected items, with each line listed once per box.");
          }
          linesInParcel.add(item.lineId);
          const packed = packedQuantities.get(item.lineId) ?? 0;
          // Subtract before adding so even malicious safe-integer inputs cannot
          // overflow the running total or borrow units from a different line.
          if (item.quantity > selection.quantity - packed) {
            throw parcelError("The boxes contain more items than the selected quantity.");
          }
          packedQuantities.set(item.lineId, packed + item.quantity);
          return { lineId: item.lineId, title: selection.title, quantity: item.quantity };
        });
        return { number: index + 1, items };
      });
      for (const [lineId, selection] of selections) {
        if (packedQuantities.get(lineId) !== selection.quantity) {
          throw parcelError("Place every selected item into a box before reviewing.");
        }
      }
      return returnPreviewReviewSchema.parse({
        mode: "admin_preview", effects: "none", orderReference: order.orderReference,
        selectedQuantity, parcels, refundMethod: "manual_shopify",
      });
    });
  }
}

function loadSampleOrder(input: ReturnPreviewLookupInput): ReturnPreviewOrder {
  const reference = normalizeCustomerReturnOrderReference(input.orderReference);
  const sample = readCustomerReturnPreviewScenario(input.scenarioId);
  if (reference !== sample.description.orderReference) {
    throw new CustomerReturnPreviewError("RETURN_PREVIEW_ORDER_NOT_FOUND", "Use the fictional order reference shown for this preview scenario.", 404);
  }
  const eligibility = evaluateCustomerReturnEligibility(sample.facts);
  return returnPreviewOrderSchema.parse({
    mode: "admin_preview", scenarioId: input.scenarioId, orderReference: sample.description.orderReference,
    purchasedAt: sample.facts.order.purchasedAt, evaluatedAt: eligibility.evaluatedAt,
    returnWindowEndsAt: eligibility.returnWindowEndsAt,
    message: "Simulation using a fictional order. Reviewing creates no return, shipping label or refund.",
    lines: eligibility.lines.map(line => {
      const display = sample.displayLines.find(candidate => candidate.id === line.lineId);
      if (!display) throw new Error("A fictional order line is missing its display data.");
      return {
        id: line.lineId, title: display.title, variant: display.variant, sku: line.sku,
        purchasedQuantity: line.purchasedQuantity, deliveredQuantity: line.deliveredQuantity,
        alreadyReturningQuantity: line.claimedQuantity, eligibleQuantity: line.eligibleQuantity,
        message: lineMessage(line),
      };
    }),
  });
}

function lineMessage(line: CustomerReturnEligibilityOutput["lines"][number]): string | null {
  if (line.reasons.includes("return_window_elapsed")) return "The 365-day return window has ended.";
  if (line.claimedQuantity > 0 && line.claimedQuantity === line.purchasedQuantity) return "These items are already included in a return.";
  if (line.deliveredQuantity === 0) return "These items have not been delivered yet.";
  if (line.deliveredQuantity < line.purchasedQuantity) return "Only the delivered quantity is available to return.";
  if (line.claimedQuantity > 0) return "Some of these items are already included in a return.";
  return null;
}

function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new CustomerReturnPreviewError("RETURN_PREVIEW_INPUT_INVALID", "The preview request is invalid.", 400);
  return parsed.data;
}

function parcelError(message: string): CustomerReturnPreviewError {
  return new CustomerReturnPreviewError("RETURN_PREVIEW_PARCELS_INVALID", message, 400);
}

function boundary<T>(work: () => T): T {
  try {
    return work();
  } catch (error) {
    if (error instanceof CustomerReturnPreviewError) throw error;
    if (error instanceof CustomerReturnOrderReferenceError) {
      throw new CustomerReturnPreviewError("RETURN_PREVIEW_INPUT_INVALID", "Enter a valid fictional order reference.", 400);
    }
    // Do not disclose internal fixture evidence in HTTP responses. The route can
    // log this classified failure without logging an incoming request payload.
    throw new CustomerReturnPreviewError("RETURN_PREVIEW_DATA_INVALID", "The return preview is unavailable.", 500);
  }
}
