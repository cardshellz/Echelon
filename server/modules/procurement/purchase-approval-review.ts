import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { purchaseOrderLines } from "@shared/schema";
import { canonicalJson } from "@shared/utils/canonical-json";

const persistedLineFields = Object.keys(getTableColumns(purchaseOrderLines));

/**
 * The detail DTO and locked approval owner use exactly the same persisted line
 * projection. Catalog SKU synchronization can change a line without advancing
 * its PO header, and equal totals do not imply equal supplier terms. Exclude
 * presentation-only joins and cancelled rows, but retain every persisted field
 * so a new line attribute cannot silently escape review protection.
 */
export function purchaseApprovalLinesFingerprint(lines: readonly Record<string, unknown>[]): string {
  const active = lines.filter(line => line.status !== "cancelled").map(line => {
    if (!Number.isSafeInteger(line.id) || Number(line.id) <= 0) throw new Error("Purchase approval line identity is invalid");
    return Object.fromEntries(persistedLineFields.map(field => [field, line[field] ?? null]));
  }).sort((left, right) => Number(left.id) - Number(right.id));
  return createHash("sha256").update(canonicalJson({ version: 1, lines: active })).digest("hex");
}
