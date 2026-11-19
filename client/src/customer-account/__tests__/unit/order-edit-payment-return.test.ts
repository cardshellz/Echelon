import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearOrderEditPaymentReturn,
  loadOrderEditPaymentReturn,
  saveOrderEditPaymentReturn,
} from "../../order-edit-payment-return";

const now = Date.parse("2026-10-21T12:00:00Z");
const context = {
  owner: "100",
  connectionId: 4,
  omsOrderId: 20,
  operationId: "00000000-0000-4000-8000-000000000001",
  orderNumber: "#fixture",
};
function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
  };
}
afterEach(() => vi.restoreAllMocks());

describe("same-tab payment return navigation hint", () => {
  it("restores only the same customer and connection, then consumes the verified operation", () => {
    const storage = memoryStorage();
    saveOrderEditPaymentReturn(context, storage, () => now);
    expect(
      loadOrderEditPaymentReturn("100", 4, storage, () => now + 1000),
    ).toEqual({ ...context, savedAt: now });
    clearOrderEditPaymentReturn("100", "another-operation", storage);
    expect(storage.data.size).toBe(1);
    clearOrderEditPaymentReturn("200", context.operationId, storage);
    expect(storage.data.size).toBe(1);
    clearOrderEditPaymentReturn("100", context.operationId, storage);
    expect(storage.data.size).toBe(0);
  });

  it.each([
    ["another customer", "200", 4, now],
    ["another connection", "100", 5, now],
    ["expired context", "100", 4, now + 24 * 60 * 60 * 1000 + 1],
    ["future context", "100", 4, now - 1],
    ["invalid clock", "100", 4, Number.NaN],
  ] as const)("discards %s", (_name, owner, connection, time) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = memoryStorage();
    saveOrderEditPaymentReturn(context, storage, () => now);
    expect(
      loadOrderEditPaymentReturn(owner, connection, storage, () => time),
    ).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it.each([
    "{broken",
    JSON.stringify({ ...context, savedAt: now, paid: true }),
  ])(
    "removes malformed browser data rather than treating it as payment proof: %s",
    (raw) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const storage = memoryStorage();
      saveOrderEditPaymentReturn(context, storage, () => now);
      storage.setItem([...storage.data.keys()][0], raw);
      expect(
        loadOrderEditPaymentReturn("100", 4, storage, () => now),
      ).toBeNull();
      expect(storage.data.size).toBe(0);
    },
  );

  it("does not block payment or throw when browser storage is denied", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const denied = () => {
      throw new Error("storage denied");
    };
    const storage = { getItem: denied, setItem: denied, removeItem: denied };
    expect(() =>
      saveOrderEditPaymentReturn(context, storage, () => now),
    ).not.toThrow();
    expect(loadOrderEditPaymentReturn("100", 4, storage, () => now)).toBeNull();
    expect(() =>
      clearOrderEditPaymentReturn("100", context.operationId, storage),
    ).not.toThrow();
    expect(warning).toHaveBeenCalled();
    expect(warning.mock.calls.flat().join(" ")).not.toContain(
      context.operationId,
    );
  });
});
