import Papa from "papaparse";
import { receivingImportFailureSchema, receivingImportResultSchema, type ReceivingImportRowInput } from "@shared/procurement/receiving-import";

export function parseReceivingImportCsv(text: string): { lines: ReceivingImportRowInput[]; error?: undefined } | { error: string; lines?: undefined } {
  const parsed = Papa.parse<string[]>(text.trim(), { delimiter: ",", skipEmptyLines: "greedy" });
  if (parsed.errors.length) return { error: `CSV could not be read: ${parsed.errors[0].message}` };
  const [rawHeader = [], ...rows] = parsed.data;
  const header = rawHeader.map((value) => value.trim().toLowerCase());
  const columns = { sku: -1, qty: -1, location: -1, damaged_qty: -1, unit_cost: -1, barcode: -1, notes: -1 };
  const aliases: Record<keyof typeof columns, readonly string[]> = {
    sku: ["sku", "product_sku"],
    qty: ["qty", "quantity", "count"],
    location: ["location", "bin", "loc"],
    damaged_qty: ["damaged_qty", "damaged"],
    unit_cost: ["unit_cost", "cost", "price"],
    barcode: ["barcode", "upc", "ean"],
    notes: ["notes", "note", "comments"],
  };
  for (const field of Object.keys(columns) as Array<keyof typeof columns>) {
    const matches = header.flatMap((value, index) => aliases[field].includes(value) ? [index] : []);
    if (matches.length > 1) {
      const labels = matches.map((index) => `${index + 1} ('${header[index]}')`).join(", ");
      return { error: `CSV header repeats the '${field}' field in columns ${labels}. Keep only one column for this field.` };
    }
    columns[field] = matches[0] ?? -1;
  }
  const { sku, qty, location, damaged_qty: damaged, unit_cost: cost, barcode, notes } = columns;
  if (sku < 0 || qty < 0) return { error: "CSV must have 'sku' and 'qty' columns" };
  // Papa's array mode does not reject extra or missing cells. Validate shape
  // before mapping so unquoted commas cannot silently change received counts.
  const invalidRow = rows.findIndex((row) => row.length !== header.length);
  if (invalidRow >= 0) {
    const actual = rows[invalidRow].length;
    const correction = actual > header.length
      ? "Put values containing commas inside double quotes."
      : "Include an empty cell for each missing value.";
    return { error: `CSV data row ${invalidRow + 1} has ${actual} column${actual === 1 ? "" : "s"}; the header has ${header.length}. Every data row must match the header. ${correction}` };
  }
  const cell = (row: string[], index: number): string | null => index < 0 ? null : row[index]?.trim() ?? "";
  // Preserve original numeric text. The server validates whole receive units;
  // parseInt here would silently turn fractional/malformed counts into stock.
  return { lines: rows.map((row) => ({ sku: cell(row, sku) ?? "", qty: cell(row, qty),
    location: cell(row, location), damaged_qty: cell(row, damaged), unit_cost: cell(row, cost),
    barcode: cell(row, barcode), notes: cell(row, notes) })) };
}

export function receivingImportError(value: unknown): Error {
  const result = receivingImportFailureSchema.safeParse(value);
  if (!result.success) return new Error("Import was not confirmed. Your CSV is preserved; refresh the receipt before retrying.");
  return new Error([result.data.error, ...(result.data.rowErrors ?? []).map((issue) => issue.message)].join("\n"));
}

export function parseReceivingImportResult(value: unknown) {
  const result = receivingImportResultSchema.safeParse(value);
  if (!result.success) throw new Error("Import may have saved, but its result could not be verified. Your CSV is preserved; refresh the receipt before retrying.");
  return result.data;
}
