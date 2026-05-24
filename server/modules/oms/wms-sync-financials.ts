/**
 * Pure financial-snapshot helpers for the OMS→WMS sync.
 *
 * Extracted from wms-sync.service.ts so unit tests can import them
 * WITHOUT triggering the db module (which requires DATABASE_URL at
 * import time). Rule #5 / #8: validation logic is unit-testable.
 *
 * Called unconditionally by wms-sync.service.ts during OMS→WMS sync.
 */

import {
  ensureCents,
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
 *   - `totalCents` may be 0 for fully discounted/free orders.
 *   - `currency` is a valid 3-letter ISO 4217 code (ensureCurrencyCode).
 *   - Every line must have `paidPriceCents` present and valid; zero is
 *     valid for promotional/free-gift lines.
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

  const check = (field: string, value: unknown) => {
    try {
      ensureCents(field, value);
    } catch (err) {
      console.error(
        `[WmsSync] Financial validation failed for OMS order ${omsOrderId}: field=${field} value=${JSON.stringify(value)}`,
      );
      throw new WmsSyncValidationError(omsOrderId, field, value);
    }
  };

  // Header cents. Subtotal / shipping / tax / discount may be 0
  // legitimately (tax-exempt, free shipping, no discount, fully comped
  // products, or true zero-dollar orders) so we only require
  // non-negative integer cents.
  check("omsOrder.subtotalCents", omsOrder.subtotalCents);
  check("omsOrder.shippingCents", omsOrder.shippingCents);
  check("omsOrder.taxCents", omsOrder.taxCents);
  check("omsOrder.discountCents", omsOrder.discountCents);
  check("omsOrder.totalCents", omsOrder.totalCents);

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
    // for wms.order_items.unit_price_cents and SS unitPrice. Zero is
    // valid for free gifts and 100%-discounted shippable lines.
    check(`${lineTag}.paidPriceCents`, line.paidPriceCents);
    // totalPriceCents is extended line total. Non-negative integer is
    // the right boundary rule here too.
    check(`${lineTag}.totalPriceCents`, line.totalPriceCents);
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
