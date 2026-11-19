import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { DocumentNumberError, captureDocumentNumberTime, documentNumberPrefix, nextDocumentNumber } from "../document-number";
import { allocateDocumentNumber, readSuggestedInvoiceNumber } from "../document-number.repository";

describe("daily document number arithmetic", () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([[null, "001"], ["0", "001"], ["009", "010"], ["999", "1000"], ["1000", "1001"],
    ["0001000", "1001"], ["9007199254740992", "9007199254740993"]])("increments %s exactly", (largest, expected) => {
    expect(nextDocumentNumber("PO-20261025-", largest, 30)).toBe(`PO-20261025-${expected}`);
  });
  it("owns the clock snapshot independently of caller mutation", () => {
    const value = new Date("2026-10-25T00:30:00Z");
    const captured = captureDocumentNumberTime(value);
    value.setUTCFullYear(2030);
    expect(captured.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(() => captureDocumentNumberTime(new Date(NaN))).toThrow(TypeError);
  });
  it("accepts the final representable number and rejects the next without truncating", () => {
    expect(nextDocumentNumber("PO-20261025-", "999999999999999998", 30)).toBe("PO-20261025-999999999999999999");
    expect(() => nextDocumentNumber("PO-20261025-", "999999999999999999", 30)).toThrow(DocumentNumberError);
    try { nextDocumentNumber("PO-20261025-", "999999999999999999", 30); }
    catch (error) { expect(error).toMatchObject({ code: "DOCUMENT_NUMBER_EXHAUSTED", statusCode: 409 }); }
  });
  it.each(["", "-1", "1.5", "1e3", "123suffix", " 999", "NaN"])("rejects malformed numeric query evidence %j", value => {
    expect(() => nextDocumentNumber("RCV-20261025-", value, 50)).toThrow(TypeError);
  });
  it.each([new Date(NaN), new Date("+010000-01-01T00:00:00Z"), new Date("-000001-01-01T00:00:00Z")])("rejects clocks outside the date contract", value => {
    expect(() => documentNumberPrefix("PO", value, "utc")).toThrow(TypeError);
  });
  it("preserves the explicitly selected local payment day across midnight and DST", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(documentNumberPrefix("PAY", new Date("2026-10-25T00:30:00Z"), "local")).toBe("PAY-20261024-");
    expect(documentNumberPrefix("PO", new Date("2026-10-25T00:30:00Z"), "utc")).toBe("PO-20261025-");
    expect(documentNumberPrefix("PAY", new Date("2026-11-01T05:30:00Z"), "local")).toBe("PAY-20261101-");
    expect(documentNumberPrefix("PAY", new Date("2026-11-01T06:30:00Z"), "local")).toBe("PAY-20261101-");
  });
  it("rejects untrusted labels and mismatched sources before issuing SQL", async () => {
    const tx = { execute: vi.fn() };
    expect(() => documentNumberPrefix("PO.*", new Date(), "utc")).toThrow(TypeError);
    await expect(allocateDocumentNumber(tx, { kind: "purchase_order", prefix: "LOT-20261025-" })).rejects.toThrow(TypeError);
    expect(tx.execute).not.toHaveBeenCalled();
  });
});

describe("document number persistence boundary", () => {
  const dialect = new PgDialect();
  it("locks before numeric evidence is read and keeps source identifiers static", async () => {
    const tx = { execute: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ suffix: "1000" }] }) };
    expect(await allocateDocumentNumber(tx, { kind: "receipt", prefix: "RCV-20261025-" })).toBe("RCV-20261025-1001");
    const [lock, query] = tx.execute.mock.calls.map(([value]) => dialect.sqlToQuery(value));
    expect(lock.sql).toContain("pg_advisory_xact_lock");
    expect(lock.sql).toContain("hashtext('procurement.generate_receipt_number')");
    expect(lock.params).toEqual([]);
    expect(query.sql).toContain("procurement.receiving_orders");
    expect(query.sql).toContain("MAX(CASE WHEN");
    expect(query.params).toEqual(["^RCV-20261025-[0-9]+$", 14, "RCV-20261025-%"]);
  });
  it("never reads evidence after failure to acquire the transaction lock", async () => {
    const tx = { execute: vi.fn().mockRejectedValue(new Error("lock timeout")) };
    await expect(allocateDocumentNumber(tx, { kind: "lot", prefix: "LOT-20261025-" })).rejects.toThrow("lock timeout");
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });
  it.each([[], [{}], [{ suffix: 10 }], [{ suffix: "bad" }], [{ suffix: null }, { suffix: "1" }]].map(rows => ({ rows })))("fails closed on invalid SQL evidence $rows", async ({ rows }) => {
    const executor = { execute: vi.fn().mockResolvedValue({ rows }) };
    await expect(readSuggestedInvoiceNumber(executor, "INV-20261025-")).rejects.toThrow(TypeError);
  });
  it("keeps invoice suggestions read-only and non-reserving", async () => {
    const executor = { execute: vi.fn().mockResolvedValue({ rows: [{ suffix: "999" }] }) };
    expect(await readSuggestedInvoiceNumber(executor, "INV-20261025-")).toBe("INV-20261025-1000");
    expect(await readSuggestedInvoiceNumber(executor, "INV-20261025-")).toBe("INV-20261025-1000");
    for (const [query] of executor.execute.mock.calls) {
      expect(dialect.sqlToQuery(query).sql).not.toMatch(/pg_advisory|INSERT|UPDATE|DELETE/);
    }
  });
});
