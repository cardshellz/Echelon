import type { SQL } from "drizzle-orm";
import type { db as defaultDatabase } from "../../db";
import { PurchaseWorkspaceError } from "./purchase-workspace.service";
export type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0];
export type Row = Record<string, unknown>;

// A single purchase workspace must remain bounded. Exceeding a limit fails
// explicitly rather than presenting silently truncated historical relationships.
export const PURCHASE_WORKSPACE_RECORD_LIMIT = 2_000;
export const PURCHASE_WORKSPACE_LINE_LIMIT = 10_000;

export async function readRows(tx: Transaction, query: SQL, section: string, limit: number): Promise<Row[]> {
  const result = await tx.execute(query);
  const rows = result.rows as Row[];
  if (rows.length > limit) {
    throw new PurchaseWorkspaceError(
      "PURCHASE_WORKSPACE_TOO_LARGE",
      `The ${section} section exceeds the workspace limit. Open the source records to inspect this purchase.`,
      422,
    );
  }
  return rows;
}

export function dateValues(row: Row, fields: readonly string[]): Row {
  const result = { ...row };
  for (const field of fields) {
    const value = result[field];
    if (value === null) continue;
    if (!(value instanceof Date) && typeof value !== "string") {
      throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_DATE_INVALID", `Invalid recorded date: ${field}.`, 500);
    }
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_DATE_INVALID", `Invalid recorded date: ${field}.`, 500);
    }
    result[field] = date.toISOString();
  }
  return result;
}

export function moneyValues(row: Row, fields: readonly string[]): Row {
  const result = { ...row };
  for (const field of fields) {
    const value = result[field];
    if (value === null) continue;
    // Raw PostgreSQL bigint results are strings. Never round an unsafe amount
    // into a JavaScript number before checking its exact integer range.
    if (typeof value === "string" && /^-?\d+$/.test(value)) {
      const exact = BigInt(value);
      if (exact >= BigInt(Number.MIN_SAFE_INTEGER) && exact <= BigInt(Number.MAX_SAFE_INTEGER)) {
        result[field] = Number(exact);
        continue;
      }
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      continue;
    }
    throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_MONEY_INVALID", `Unsafe or invalid recorded amount: ${field}.`, 500);
  }
  return result;
}

export function uniqueIds(values: unknown[]): number[] {
  const result = new Set<number>();
  for (const value of values) {
    if (value === null) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new PurchaseWorkspaceError("PURCHASE_WORKSPACE_REFERENCE_INVALID", "A recorded document reference is invalid.", 500);
    }
    result.add(value);
  }
  return [...result].sort((left, right) => left - right);
}
