import { describe, expect, it } from "vitest";
import { isFullyHandedToAssembly } from "../../work/domain/assembly-picker-coverage";
import { task } from "../assembly-work.fixture";

const item = { id: 71, quantity: 2, pickedQuantity: 0, status: "pending", requiresShipping: 1, onHold: false };
const owner = { orderId: 70, orderItemId: 71, claimId: "9", operationId: "10", requestedQty: "2", committedQty: "2" };
describe("picker responsibility is not physical pick completion", () => {
  it.each(["queued", "in_progress", "blocked", "completed"] as const)("keeps wholly delegated %s work in assembly without rewriting quantities", (state) => {
    const before = structuredClone(item);
    expect(isFullyHandedToAssembly([item], [owner], [task({ state })])).toBe(true);
    expect(item).toEqual(before);
  });
  it("permits separately completed stock lines beside a wholly handed-off build line", () => {
    expect(isFullyHandedToAssembly([item, { ...item, id: 72, status: "completed", pickedQuantity: 2 }], [owner], [task()])).toBe(true);
  });
  it.each([
    { ...item, quantity: 3 }, { ...item, pickedQuantity: 1 }, { ...item, status: "short" },
    { ...item, status: "completed", pickedQuantity: 0 }, { ...item, requiresShipping: 0 }, { ...item, onHold: true },
  ])("does not hide unsupported, changed, nonphysical, or incomplete evidence: %j", (line) => {
    expect(isFullyHandedToAssembly([line], [owner], [task()])).toBe(false);
  });
  it("does not hide a remaining direct pick", () => {
    expect(isFullyHandedToAssembly([item, { ...item, id: 72 }], [owner], [task()])).toBe(false);
  });
  it("restores visibility when work is cancelled, claim is released, or claim is replaced", () => {
    expect(isFullyHandedToAssembly([item], [owner], [task({ state: "cancelled" })])).toBe(false);
    expect(isFullyHandedToAssembly([item], [], [task()])).toBe(false);
    expect(isFullyHandedToAssembly([item], [{ ...owner, claimId: "20" }], [task()])).toBe(false);
  });
  it("does not use excess output, multiple builds, or another order line as coverage", () => {
    expect(isFullyHandedToAssembly([item], [{ ...owner, committedQty: "3" }], [task({ outputQty: "3" })])).toBe(false);
    expect(isFullyHandedToAssembly([item], [owner, { ...owner, operationId: "11" }], [task()])).toBe(false);
    expect(isFullyHandedToAssembly([item], [owner], [task({ orderItemId: 72 })])).toBe(false);
  });
  it("never classifies a direct-stock-only or empty order as an assembly handoff", () => {
    expect(isFullyHandedToAssembly([], [], [])).toBe(false);
    expect(isFullyHandedToAssembly([{ ...item, status: "completed", pickedQuantity: 2 }], [], [])).toBe(false);
  });
});
