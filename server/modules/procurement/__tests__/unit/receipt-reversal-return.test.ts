import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readReceiptReturnCapabilities } from "../../receipt-reversal-return.repository";
import { receiptReversalCapabilitySchema } from "@shared/procurement/receipt-reversal-command";

describe("canonical receipt return history capabilities", () => {
  it("blocks whole receipt and returned line while preserving unrelated line correction", async () => {
    const result = await readReceiptReturnCapabilities({ execute: async () => ({ rows: [{ id: 11, has_return: true }, { id: 12, has_return: false }] }) }, 10);
    expect(result.order).toMatchObject({ allowed: false, code: "RECEIPT_REVERSAL_SUPPLIER_RETURN_HISTORY" });
    expect(result.lines.get(11)).toEqual(result.order);
    expect(result.lines.get(12)).toEqual({ allowed: true, code: null, reason: null });
  });
  it.each([null, "false", 0, undefined])("rejects ambiguous database return evidence %j", async has_return => {
    await expect(readReceiptReturnCapabilities({ execute: async () => ({ rows: [{ id: 11, has_return }] }) }, 10)).rejects.toBeInstanceOf(z.ZodError);
  });
  it("rejects duplicate source evidence", async () => {
    await expect(readReceiptReturnCapabilities({ execute: async () => ({ rows: [{ id: 11, has_return: false }, { id: 11, has_return: true }] }) }, 10)).rejects.toThrow("Duplicate");
  });
  it("does not swallow failed history reads", async () => {
    const unavailable = new Error("connection unavailable");
    await expect(readReceiptReturnCapabilities({ execute: async () => { throw unavailable; } }, 10)).rejects.toBe(unavailable);
  });
  it.each([{ allowed: true, code: "BLOCKED", reason: "Review" }, { allowed: false, code: null, reason: null }, {}])("rejects contradictory UI capabilities %j", capability => {
    expect(receiptReversalCapabilitySchema.safeParse(capability).success).toBe(false);
  });
});
