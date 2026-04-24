/**
 * shared/errors/wms-sync-errors.ts
 *
 * Structured errors raised by the OMS→WMS sync path (§6 Commit 7 of
 * shipstation-flow-refactor-plan.md).
 *
 * Kept separate from shared/errors.ts so the sync-specific context
 * (omsOrderId, field, offending value) lives with the sync module's
 * domain without bloating the generic AppError surface. Extends
 * AppError so structured logging in server/index.ts treats it like
 * any other operational error (code + context JSON).
 *
 * Per coding-standards Rule #5 (no silent failures) and refactor plan
 * invariant #9 (currency in integer cents always).
 */

import { AppError } from "../errors";

/**
 * Thrown by `wms-sync.service` when OMS financial data fails boundary
 * validation before it is written into `wms.orders` / `wms.order_items`.
 *
 * Semantics:
 *   - The OMS order is NOT inserted into WMS when this fires.
 *   - The OMS row is left untouched; the hourly reconcile sweep (or a
 *     manual re-run) can retry once the underlying data is corrected.
 *   - The caller is expected to log and surface the error, not swallow
 *     it (invariant #2 + Rule #16 — no silent $0 reaching WMS).
 */
export class WmsSyncValidationError extends AppError {
  constructor(
    public readonly omsOrderId: number,
    public readonly field: string,
    public readonly value: unknown,
    message?: string,
  ) {
    super(
      message ??
        `WMS sync validation failed for OMS order ${omsOrderId}: field=${field} value=${JSON.stringify(value)}`,
      "WMS_SYNC_VALIDATION_FAILED",
      422,
      { omsOrderId, field, value },
    );
  }
}
