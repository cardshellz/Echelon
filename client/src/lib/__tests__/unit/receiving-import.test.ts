import { describe, expect, it } from "vitest";
import { parseReceivingImportCsv, parseReceivingImportResult, receivingImportError } from "../../receiving-import";
import { receivingImportRowSchema } from "@shared/procurement/receiving-import";

describe("receiving CSV boundary", () => {
  it.each(["1.5", "12junk", "-1", "2147483648", "9007199254740993", "1e3"])("preserves and rejects unsafe count %s without truncation", (value) => {
    const parsed = parseReceivingImportCsv(`sku,qty,damaged_qty\nTEST,${value},${value}`);
    expect(parsed.lines?.[0]).toMatchObject({ qty: value, damaged_qty: value });
    expect(receivingImportRowSchema.safeParse(parsed.lines?.[0]).success).toBe(false);
  });
  it.each(["0", "", "2147483647"])("accepts supported whole count %s", (value) => {
    const row = receivingImportRowSchema.parse(parseReceivingImportCsv(`sku,qty\nTEST,${value}`).lines?.[0]);
    expect(row.qty).toBe(Number(value));
  });
  it("preserves escaped quotes, comma notes and multiline CSV fields", () => {
    expect(parseReceivingImportCsv('sku,qty,notes\r\nTEST,2,"Physical count, ""confirmed""\nsecond line"').lines?.[0])
      .toMatchObject({ sku: "TEST", qty: "2", notes: 'Physical count, "confirmed"\nsecond line' });
  });
  it("returns malformed quoting and required column errors", () => {
    expect(parseReceivingImportCsv('sku,qty\nTEST,"2').error).toMatch(/could not be read/);
    expect(parseReceivingImportCsv('sku,total\nTEST,2').error).toContain("'qty'");
  });
  it.each([
    { csv: "sku,qty\nTEST,1,000", error: "CSV data row 1 has 3 columns; the header has 2", correction: "double quotes" },
    { csv: "sku,qty\nVALID,2\nTEST,1,000", error: "CSV data row 2 has 3 columns; the header has 2", correction: "double quotes" },
    { csv: "qty,sku\n2", error: "CSV data row 1 has 1 column; the header has 2", correction: "empty cell" },
  ])("rejects mismatched CSV row widths before returning any import rows: $csv", ({ csv, error, correction }) => {
    const result = parseReceivingImportCsv(csv);
    expect(result.error).toContain(error);
    expect(result.error).toContain(correction);
    expect(result.lines).toBeUndefined();
  });
  it.each([
    ["sku", "sku,product_sku,qty"],
    ["qty", "sku,qty,quantity"],
    ["qty", "sku,qty,count"],
    ["qty", "sku, QTY ,qty"],
    ["location", "sku,qty,location,bin,loc"],
    ["damaged_qty", "sku,qty,damaged_qty,damaged"],
    ["unit_cost", "sku,qty,unit_cost,cost,price"],
    ["barcode", "sku,qty,barcode,upc,ean"],
    ["notes", "sku,qty,notes,note,comments"],
  ])("rejects ambiguous %s aliases before returning any import rows", (field, header) => {
    const cells = header.split(",").map((_, index) => index === 0 ? "TEST" : "1");
    const result = parseReceivingImportCsv(`${header}\n${cells.join(",")}`);
    expect(result.error).toContain(`CSV header repeats the '${field}' field in columns`);
    expect(result.error).toContain("Keep only one column");
    expect(result.lines).toBeUndefined();
  });
  it("maps unique normalized aliases and preserves explicit empty cells and unknown columns", () => {
    expect(parseReceivingImportCsv(' PRODUCT_SKU ,Count,Bin,Damaged,Price,UPC,Comments,source\nTEST,2,,,1.00,,"Counted, verified",paper').lines)
      .toEqual([{ sku: "TEST", qty: "2", location: "", damaged_qty: "", unit_cost: "1.00", barcode: "", notes: "Counted, verified" }]);
  });
  it("surfaces indexed identity errors without losing retry guidance", () => {
    expect(receivingImportError({ error: "No lines were imported.", rowErrors: [{ row: 2,
      code: "RECEIVING_IMPORT_DUPLICATE_IDENTITY", message: "Data row 2 repeats data row 1; use one total count." }] }).message)
      .toContain("Data row 2 repeats data row 1");
  });
  it("does not accept malformed successful results or silently clear the CSV", () => {
    expect(() => parseReceivingImportResult({ success: true, created: -1, updated: 0 })).toThrow(/may have saved/);
    expect(receivingImportError(null).message).toContain("CSV is preserved");
    expect(parseReceivingImportResult({ success: true, created: 0, updated: 1 })).toEqual({ success: true, created: 0, updated: 1 });
  });
});
