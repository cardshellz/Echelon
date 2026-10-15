import { describe, expect, it } from "vitest";
import { createInvoiceReplacementRecovery } from "../../invoice-replacement-recovery";

const key = "bb83b14f-0a74-4c24-8a84-9c66d5f51fa3";
const body = { expectedVersion: "a".repeat(64), reason: "Correct carrier invoice" };
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (name: string) => values.get(name) ?? null, setItem: (name: string, value: string) => { values.set(name, value); }, removeItem: (name: string) => { values.delete(name); } };
}
describe("invoice replacement recovery", () => {
  it("retains the exact key and request across reload and refuses another unresolved intent", () => {
    const storage = memoryStorage();
    const first = createInvoiceReplacementRecovery(() => storage, "user", 71).acquire(body, () => key);
    const reloaded = createInvoiceReplacementRecovery(() => storage, "user", 71);
    expect(reloaded.read()).toEqual(first);
    expect(reloaded.acquire(body, () => { throw new Error("must reuse key"); })).toEqual(first);
    expect(() => reloaded.acquire({ ...body, reason: "Another correction" }, () => key)).toThrow("unresolved");
  });
  it("isolates account/document commands and clears only the matching confirmed key", () => {
    const storage = memoryStorage();
    const current = createInvoiceReplacementRecovery(() => storage, "user", 71);
    current.acquire(body, () => key);
    expect(createInvoiceReplacementRecovery(() => storage, "other", 71).read()).toBeNull();
    expect(createInvoiceReplacementRecovery(() => storage, "user", 72).read()).toBeNull();
    current.complete("wrong-key"); expect(current.read()?.key).toBe(key);
    current.complete(key); expect(current.read()).toBeNull();
  });
  it("fails before dispatch when session storage cannot retain a key", () => {
    const storage = { ...memoryStorage(), setItem: () => { throw new Error("quota"); } };
    expect(() => createInvoiceReplacementRecovery(() => storage, "user", 71).acquire(body, () => key)).toThrow("not sent");
  });
  it("retains unreadable evidence rather than silently replacing it", () => {
    const storage = memoryStorage(); storage.setItem("echelon:invoice-replacement:v1:user:71", "invalid");
    const current = createInvoiceReplacementRecovery(() => storage, "user", 71);
    expect(() => current.read()).toThrow("could not be read");
    expect(() => current.acquire(body, () => key)).toThrow("could not be read");
    expect(storage.getItem("echelon:invoice-replacement:v1:user:71")).toBe("invalid");
  });
  it("retains the same key when confirmed-result cleanup fails", () => {
    const base = memoryStorage();
    let blocked = true;
    const storage = { ...base, removeItem: (name: string) => { if (blocked) throw new Error("storage denied"); base.removeItem(name); } };
    const current = createInvoiceReplacementRecovery(() => storage, "user", 71);
    current.acquire(body, () => key);
    expect(() => current.complete(key)).toThrow("confirmed");
    expect(current.read()?.key).toBe(key);
    blocked = false;
    current.complete(key);
    expect(current.read()).toBeNull();
  });
});
