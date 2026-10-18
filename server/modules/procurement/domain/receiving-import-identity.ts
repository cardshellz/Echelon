import type { ReceivingImportRowIssue } from "@shared/procurement/receiving-import";

export interface ReceivingImportIdentity {
  sku: string;
  putawayLocationId: number | null;
}
interface ExistingImportIdentity {
  id: number;
  sku: string | null;
  putawayLocationId: number | null;
}

export function receivingImportIdentityKey(line: ReceivingImportIdentity): string {
  return JSON.stringify([line.sku.trim().toUpperCase(), line.putawayLocationId]);
}

/** CSV quantities replace one recorded line's counts. A key can select exactly
 * one line, never silently merge separately recorded physical custody. */
export function planReceivingImportIdentities(
  existing: readonly ExistingImportIdentity[],
  incoming: readonly (ReceivingImportIdentity & { row: number })[],
): { targets: ReadonlyMap<number, number | null>; issues: ReceivingImportRowIssue[] } {
  const existingByKey = new Map<string, number[]>();
  for (const line of existing) {
    if (!line.sku?.trim()) continue;
    const key = receivingImportIdentityKey({ ...line, sku: line.sku });
    const matches = existingByKey.get(key);
    if (matches) matches.push(line.id); else existingByKey.set(key, [line.id]);
  }
  const rowsByKey = new Map<string, number[]>();
  for (const line of incoming) {
    const key = receivingImportIdentityKey(line);
    const rows = rowsByKey.get(key);
    if (rows) rows.push(line.row); else rowsByKey.set(key, [line.row]);
  }
  const targets = new Map<number, number | null>();
  const issues: ReceivingImportRowIssue[] = [];
  for (const line of incoming) {
    const key = receivingImportIdentityKey(line);
    const repeated = rowsByKey.get(key)!;
    const matches = existingByKey.get(key) ?? [];
    if (repeated.length > 1) {
      issues.push({ row: line.row, code: "RECEIVING_IMPORT_DUPLICATE_IDENTITY",
        message: `Data row ${line.row}: SKU ${line.sku} repeats the same resolved location as data row ${repeated[0] === line.row ? repeated[1] : repeated[0]}. Enter one total count for this SKU/location; use the receipt line controls for separate physical lines.` });
    } else if (matches.length > 1) {
      issues.push({ row: line.row, code: "RECEIVING_IMPORT_AMBIGUOUS_EXISTING_LINE",
        message: `Data row ${line.row}: SKU ${line.sku} matches multiple receipt lines (${matches.join(", ")}) at this location. Update those lines individually; CSV cannot choose which physical line to replace.` });
    } else {
      targets.set(line.row, matches[0] ?? null);
    }
  }
  return { targets, issues };
}
