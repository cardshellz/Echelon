import { describe, expect, it } from "vitest";
import {
  loadCancellationRequest,
  saveCancellationRequest,
  clearCancellationRequest,
} from "../order-cancellation-request";
const scope = { customerId: "100", connectionId: 4, omsOrderId: 1 };
const input = {
  connectionId: 4,
  omsOrderId: 1,
  expectedRevision: "a".repeat(64),
  requestKey: "11111111-1111-4111-8111-111111111111",
};
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
describe("durable customer cancellation approval", () => {
  it("restores the same command after reload and clears only matching terminal requests", () => {
    const s = storage();
    saveCancellationRequest(s, scope, input);
    saveCancellationRequest(s, scope, input);
    expect(loadCancellationRequest(s, scope)).toEqual(input);
    clearCancellationRequest(s, scope, "other");
    expect(s.values.size).toBe(1);
    clearCancellationRequest(s, scope, input.requestKey);
    expect(s.values.size).toBe(0);
  });
  it("does not replace uncertain approval with another identity or another order", () => {
    const s = storage();
    saveCancellationRequest(s, scope, input);
    expect(() =>
      saveCancellationRequest(s, scope, {
        ...input,
        requestKey: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow();
    expect(() =>
      saveCancellationRequest(s, scope, { ...input, omsOrderId: 2 }),
    ).toThrow();
    expect(
      loadCancellationRequest(s, { ...scope, customerId: "200" }),
    ).toBeNull();
  });
  it.each([
    "garbage",
    "x".repeat(2049),
    JSON.stringify({ version: 1, customerId: "200", input }),
  ])("fails closed on invalid saved approval", (value) => {
    const s = storage();
    saveCancellationRequest(s, scope, input);
    s.values.set([...s.values.keys()][0], value);
    expect(() => loadCancellationRequest(s, scope)).toThrow();
  });
  it("does not silently swallow unavailable storage", () => {
    const s = storage();
    s.setItem = () => {
      throw new Error("Storage disabled");
    };
    expect(() => saveCancellationRequest(s, scope, input)).toThrow(
      "Storage disabled",
    );
  });
});
