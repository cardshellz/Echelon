/**
 * Receive-configuration policy (pure domain rules).
 *
 * A purchase order buys product pieces: `purchase_order_lines.order_qty` is a
 * piece count regardless of which package the goods arrive in. The package the
 * shipment is expected to arrive and be counted in is a separate, deliberate
 * decision, recorded on the line as `expected_receive_variant_id`.
 *
 * That decision is financial. `planReceiptUnits`
 * (server/modules/procurement/receiving-unit-contract.ts) reads it to decide
 * whether a shipment is booked as whole packs on the sellable SKU or as loose
 * pieces, and receipt costing and AP value the receipt in those same units. A
 * wrong or absent answer books the wrong quantity of inventory at the wrong
 * unit cost.
 *
 * Therefore the answer is never inferred. The system does not fall back to the
 * legacy `product_variant_id`, to a product's only variant, or to any other
 * convenient guess: an unanswered question is refused, not filled in. Callers
 * must carry an operator's explicit choice.
 *
 * Scope of enforcement, deliberately narrow so existing orders keep working:
 *   - Creating a product line requires the choice (`assertReceiveVariantChosen`).
 *   - Updating a line may not clear the choice (`assertReceiveVariantNotCleared`),
 *     but an update that does not mention it — a running received-quantity
 *     tally, a cost correction — is untouched, so receipts against purchase
 *     orders written before this rule keep posting.
 *   - Leaving draft requires every product line to carry the choice
 *     (`findLinesMissingReceiveConfiguration`), which is what stops an older
 *     draft from reaching a vendor with the question still open.
 */

/** Namespaced structured error codes. Handlers branch on these, not on text. */
export const PO_RECEIVE_VARIANT_REQUIRED = "PO_RECEIVE_VARIANT_REQUIRED";
export const PO_RECEIVE_VARIANT_CLEAR_BLOCKED = "PO_RECEIVE_VARIANT_CLEAR_BLOCKED";
export const PO_RECEIVE_VARIANT_ARCHIVED = "PO_RECEIVE_VARIANT_ARCHIVED";
export const PO_RECEIVE_CONFIGURATION_REQUIRED = "PO_RECEIVE_CONFIGURATION_REQUIRED";

export const RECEIVE_VARIANT_REQUIRED_MESSAGE =
  "Choose how this line is received. The receive configuration decides whether a "
  + "shipment is counted as packs or as loose pieces, so it is never assumed.";

export const RECEIVE_VARIANT_CLEAR_BLOCKED_MESSAGE =
  "A purchase order line cannot have its receive configuration removed. Select the "
  + "configuration the goods will actually arrive in instead.";

export const RECEIVE_CONFIGURATION_REQUIRED_MESSAGE =
  "Every product line needs a receive configuration before this purchase order can "
  + "leave draft. Open the order and choose how each line is received.";

/**
 * Lines carry no `line_type` before migration 0564; those rows are all product
 * lines, so an absent type reads as "product" everywhere in this module.
 */
export const DEFAULT_PO_LINE_TYPE = "product";

export interface ReceiveConfigurationLine {
  id?: number | null;
  lineNumber?: number | null;
  lineType?: string | null;
  sku?: string | null;
  productName?: string | null;
  status?: string | null;
  expectedReceiveVariantId?: number | null;
}

export interface MissingReceiveConfigurationLine {
  lineId: number | null;
  lineNumber: number | null;
  sku: string | null;
  productName: string | null;
}

export function isProductPoLine(lineType: string | null | undefined): boolean {
  return (lineType ?? DEFAULT_PO_LINE_TYPE) === DEFAULT_PO_LINE_TYPE;
}

/**
 * A chosen receive variant is a real, positive catalog identifier. `null`,
 * `undefined`, `0` and non-integers all mean "not chosen" rather than any
 * particular default.
 */
export function hasChosenReceiveVariant(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function optionalSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function optionalText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * Cancelled lines are historical records, not pending obligations: nothing will
 * ever be received against them, so they cannot hold a purchase order in draft.
 */
export function isOpenPoLine(status: string | null | undefined): boolean {
  return (status ?? "open") !== "cancelled";
}

/**
 * Every open product line on the order that still has the question unanswered.
 *
 * Returned in input order so the caller can report the first offender without
 * re-sorting, and so an operator sees them in the order the order lists them.
 */
export function findLinesMissingReceiveConfiguration(
  lines: readonly ReceiveConfigurationLine[],
): MissingReceiveConfigurationLine[] {
  if (!Array.isArray(lines)) return [];
  return lines
    .filter((line) =>
      Boolean(line)
      && isProductPoLine(line.lineType)
      && isOpenPoLine(line.status)
      && !hasChosenReceiveVariant(line.expectedReceiveVariantId)
    )
    .map((line) => ({
      lineId: optionalSafeInteger(line.id),
      lineNumber: optionalSafeInteger(line.lineNumber),
      sku: optionalText(line.sku),
      productName: optionalText(line.productName),
    }));
}

export interface ReceiveConfigurationViolation {
  code: string;
  message: string;
  context: Record<string, unknown>;
  status: number;
}

/**
 * Creation rule. Returns the violation to raise, or `null` when the line may be
 * written. Returning rather than throwing keeps this module free of any host
 * error class, so both the command layer and the legacy service can raise their
 * own error type from one shared decision.
 */
export function checkReceiveVariantChosen(input: {
  lineType?: string | null;
  expectedReceiveVariantId?: unknown;
  label?: string | null;
  productId?: number | null;
}): ReceiveConfigurationViolation | null {
  if (!isProductPoLine(input.lineType)) return null;
  if (hasChosenReceiveVariant(input.expectedReceiveVariantId)) return null;
  return {
    code: PO_RECEIVE_VARIANT_REQUIRED,
    message: input.label
      ? `${input.label}: ${RECEIVE_VARIANT_REQUIRED_MESSAGE}`
      : RECEIVE_VARIANT_REQUIRED_MESSAGE,
    status: 400,
    context: {
      productId: optionalSafeInteger(input.productId),
      submittedExpectedReceiveVariantId:
        input.expectedReceiveVariantId === undefined
          ? null
          : (input.expectedReceiveVariantId as unknown),
    },
  };
}

/**
 * Update rule. Only an explicit attempt to clear the choice is refused; an
 * update that never mentions the field leaves the stored value alone.
 */
export function checkReceiveVariantNotCleared(input: {
  lineType?: string | null;
  submittedExpectedReceiveVariantId?: unknown;
  lineId?: number | null;
}): ReceiveConfigurationViolation | null {
  if (!isProductPoLine(input.lineType)) return null;
  if (input.submittedExpectedReceiveVariantId === undefined) return null;
  if (hasChosenReceiveVariant(input.submittedExpectedReceiveVariantId)) return null;
  return {
    code: PO_RECEIVE_VARIANT_CLEAR_BLOCKED,
    message: RECEIVE_VARIANT_CLEAR_BLOCKED_MESSAGE,
    status: 400,
    context: {
      lineId: optionalSafeInteger(input.lineId),
      submittedExpectedReceiveVariantId:
        input.submittedExpectedReceiveVariantId as unknown,
    },
  };
}

/**
 * Lifecycle rule for draft -> pending approval / sent.
 *
 * `status` is 409 rather than 400: the request was well formed, the order's
 * state is what blocks it.
 */
export function checkReceiveConfigurationReadyToLeaveDraft(
  lines: readonly ReceiveConfigurationLine[],
): ReceiveConfigurationViolation | null {
  const missing = findLinesMissingReceiveConfiguration(lines);
  if (missing.length === 0) return null;
  return {
    code: PO_RECEIVE_CONFIGURATION_REQUIRED,
    message: RECEIVE_CONFIGURATION_REQUIRED_MESSAGE,
    status: 409,
    context: {
      missingLineCount: missing.length,
      // Bounded so one badly configured order cannot produce an unbounded
      // error payload or log line.
      missingLines: missing.slice(0, 20),
    },
  };
}
