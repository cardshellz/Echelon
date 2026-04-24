/**
 * Pure financial-snapshot helpers for the OMS→WMS sync.
 *
 * Extracted from wms-sync.service.ts so unit tests can import them
 * WITHOUT triggering the db module (which requires DATABASE_URL at
 * import time). Rule #5 / #8: validation logic is unit-testable.
 *
 * These are called by wms-sync.service.ts when the
 * WMS_FINANCIAL_SNAPSHOT feature flag is on.
 *
 * Plan reference: shipstation-flow-refactor-plan.md §6 Commit 7.
 */

import {
  ensureCents,
  ensurePositiveCents,
  ensureCurrencyCode,
  CurrencyValidationError,
} from "@shared/validation/currency";
import { WmsSyncValidationError } from "@shared/errors/wms-sync-errors";

// Minimal structural types — match the shape of the OMS Drizzle rows
// this service reads without tying the helpers to the full row type
// (keeps unit tests independent of Drizzle internals).
export type OmsOrderFinancialFields = {
  id: number;
  subtotalCents: number;
  shippingCents: number;
  taxCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
};

export type OmsLineFinancialFields = {
  id: number;
  quantity: number;
  paidPriceCents: number;
  totalPriceCents: number;
};

/**
 * Pure validation of an OMS order's financial fields + each line's
 * price fields. Throws `WmsSyncValidationError` on the first issue.
 *
 * Rules enforced (per refactor plan invariant #9 + coding-standards #3):
 *   - All cents values are integer ≥ 0 (ensureCents).
 *   - `totalCents` is strictly > 0 on a paid order (ensurePositiveCents).
 *   - `currency` is a valid 3-letter ISO 4217 code (ensureCurrencyCode).
 *   - Every line must have `paidPriceCents` present and valid; zero is
 *     rejected because a billable line that reaches WMS with
 *     unit_price=0 would be pushed to ShipStation as $0 (the exact
 *     silent-failure class we are refactoring away).
 *   - Every line `totalPriceCents` must be valid cents (≥ 0).
 *
 * Non-USD currencies pass through unchanged — we only reject malformed
 * codes, not foreign ones.
 */
export function validateOmsOrderFinancials(
  omsOrder: OmsOrderFinancialFields,
  omsLines: readonly OmsLineFinancialFields[],
): void {
  const omsOrderId = omsOrder.id;

  const check = (field: string, value: unknown, positive: boolean) => {
    try {
      if (positive) ensurePositiveCents(field, value);
      else ensureCents(field, value);
    } catch (err) {
      console.error(
        `[WmsSync] Financial validation failed for OMS order ${omsOrderId}: field=${field} value=${JSON.stringify(value)}`,
      );
      throw new WmsSyncValidationError(omsOrderId, field, value);
    }
  };

  // Header cents. Subtotal / shipping / tax / discount may be 0
  // legitimately (tax-exempt, free shipping, no discount) so we only
  // require non-negative integer. `totalCents` must be > 0 — a paid
  // order with total=0 is always a data bug.
  check("omsOrder.subtotalCents", omsOrder.subtotalCents, false);
  check("omsOrder.shippingCents", omsOrder.shippingCents, false);
  check("omsOrder.taxCents", omsOrder.taxCents, false);
  check("omsOrder.discountCents", omsOrder.discountCents, false);
  check("omsOrder.totalCents", omsOrder.totalCents, true);

  // Currency — 3-letter ISO 4217. Non-USD is fine; malformed is not.
  try {
    ensureCurrencyCode("omsOrder.currency", omsOrder.currency);
  } catch (err) {
    console.error(
      `[WmsSync] Financial validation failed for OMS order ${omsOrderId}: field=omsOrder.currency value=${JSON.stringify(omsOrder.currency)}`,
    );
    throw new WmsSyncValidationError(
      omsOrderId,
      "omsOrder.currency",
      omsOrder.currency,
    );
  }

  // Per-line cents.
  for (const line of omsLines) {
    const lineTag = `omsOrderLines[${line.id}]`;
    // paidPriceCents is per-unit paid after discount — snapshot source
    // for wms.order_items.unit_price_cents and SS unitPrice. Zero here
    // is always a bug.
    check(`${lineTag}.paidPriceCents`, line.paidPriceCents, true);
    // totalPriceCents is extended line total — allowed to be 0 only for
    // free/gift lines. Non-negative integer is the right rule.
    check(`${lineTag}.totalPriceCents`, line.totalPriceCents, false);
  }
}

/**
 * Build the financial snapshot fields for `wms.orders` from an OMS
 * order. Caller must have already run `validateOmsOrderFinancials`.
 *
 * Mapping per §6 Commit 7:
 *   - `amount_paid_cents` ← OMS `totalCents` (what customer paid;
 *     matches SS `amountPaid` field on push).
 *   - `tax_cents`, `shipping_cents`, `discount_cents`, `total_cents`,
 *     `currency` ← passthrough from OMS.
 */
export function buildWmsOrderFinancialSnapshot(
  omsOrder: OmsOrderFinancialFields,
): {
  amountPaidCents: number;
  taxCents: number;
  shippingCents: number;
  discountCents: number;
  totalCents: number;
  currency: string;
} {
  return {
    amountPaidCents: omsOrder.totalCents,
    taxCents: omsOrder.taxCents,
    shippingCents: omsOrder.shippingCents,
    discountCents: omsOrder.discountCents,
    totalCents: omsOrder.totalCents,
    currency: omsOrder.currency,
  };
}

/**
 * Build the price snapshot fields for `wms.order_items` from one OMS
 * line. Caller must have already run `validateOmsOrderFinancials`.
 *
 * Mapping per §6 Commit 7:
 *   - `unit_price_cents` ← OMS `paidPriceCents` (per-unit paid after
 *     discount; direct SS unitPrice source).
 *   - `paid_price_cents` ← OMS `paidPriceCents` (same value, kept for
 *     name parity with OMS).
 *   - `total_price_cents` ← OMS `totalPriceCents` (extended total).
 */
export function buildWmsItemFinancialSnapshot(
  omsLine: OmsLineFinancialFields,
): {
  unitPriceCents: number;
  paidPriceCents: number;
  totalPriceCents: number;
} {
  return {
    unitPriceCents: omsLine.paidPriceCents,
    paidPriceCents: omsLine.paidPriceCents,
    totalPriceCents: omsLine.totalPriceCents,
  };
}

// Re-export CurrencyValidationError so callers that want to catch the
// underlying zod-guard error can import it from one place alongside
// WmsSyncValidationError.
export { CurrencyValidationError };
