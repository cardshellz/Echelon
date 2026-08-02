import { and, gte, lt, sql, type SQL } from "drizzle-orm";
import { purchaseOrders } from "@shared/schema";

function requireValidTimestamp(value: Date, field: string): number {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new Error(`${field} must be a valid Date`);
  }
  return milliseconds;
}

/**
 * Drizzle maps PostgreSQL timestamps to JavaScript Date values, whose precision
 * is milliseconds. Match the complete database interval represented by that
 * Date so legacy rows with microsecond precision remain valid OCC versions.
 */
export function purchaseOrderUpdatedAtMatchesApplicationVersion(
  updatedAt: Date,
): SQL {
  const milliseconds = requireValidTimestamp(updatedAt, "updatedAt");
  const lowerBound = new Date(milliseconds);
  const upperBoundExclusive = new Date(milliseconds + 1);
  return and(
    gte(purchaseOrders.updatedAt, lowerBound),
    lt(purchaseOrders.updatedAt, upperBoundExclusive),
  )!;
}

export function millisecondTransactionTimestamp(): SQL {
  return sql`date_trunc('milliseconds', transaction_timestamp())`;
}

/** Advance the OCC token even when two mutations commit within one millisecond. */
export function nextPurchaseOrderUpdatedAt(previousUpdatedAt: Date): SQL {
  requireValidTimestamp(previousUpdatedAt, "previousUpdatedAt");
  return sql`GREATEST(
    date_trunc('milliseconds', transaction_timestamp()),
    ${previousUpdatedAt}::timestamp + interval '1 millisecond'
  )`;
}
