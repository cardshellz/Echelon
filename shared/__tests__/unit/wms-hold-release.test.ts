import { describe, expect, it } from "vitest";
import {
  decideLineHoldRelease,
  decideOrderHoldRelease,
  holdReleaseRefusalMessage,
  isOpenHeldLine,
  isOrderLevelHold,
  isTerminalOrder,
  parseWmsRecordId,
  type LineHoldReleaseInput,
} from "../../wms-hold-release";

const heldLine = { orderId: 7, onHold: true, status: "pending", quantity: 2 };
const readyOrder = { id: 7, onHold: 0, warehouseStatus: "ready" };

function lineInput(overrides: Partial<LineHoldReleaseInput> = {}): LineHoldReleaseInput {
  return { wmsOrderId: 7, order: readyOrder, line: heldLine, ...overrides };
}

describe("parseWmsRecordId", () => {
  it("accepts plain positive integers within the Postgres integer range", () => {
    expect(parseWmsRecordId("1")).toBe(1);
    expect(parseWmsRecordId("63570")).toBe(63570);
    expect(parseWmsRecordId("2147483647")).toBe(2147483647);
  });

  it.each(["0", "-1", "1.5", "1e3", "12abc", "", " 1", "0x10", "2147483648", "99999999999"])(
    "rejects %j so it becomes a 400 rather than a database error",
    (value) => {
      expect(parseWmsRecordId(value)).toBeNull();
    },
  );

  it("rejects non-string input", () => {
    expect(parseWmsRecordId(undefined)).toBeNull();
    expect(parseWmsRecordId(12)).toBeNull();
    expect(parseWmsRecordId(["1"])).toBeNull();
  });
});

describe("hold predicates", () => {
  it("treats the order flag (integer or boolean) and the legacy on_hold status as an order-level hold", () => {
    expect(isOrderLevelHold({ onHold: 1, warehouseStatus: "ready" })).toBe(true);
    expect(isOrderLevelHold({ onHold: true, warehouseStatus: "ready" })).toBe(true);
    expect(isOrderLevelHold({ onHold: 0, warehouseStatus: " ON_HOLD " })).toBe(true);
    expect(isOrderLevelHold({ onHold: 0, warehouseStatus: "ready" })).toBe(false);
    expect(isOrderLevelHold({ onHold: null, warehouseStatus: null })).toBe(false);
  });

  it("only shipped and cancelled orders are terminal", () => {
    expect(isTerminalOrder({ warehouseStatus: "shipped" })).toBe(true);
    expect(isTerminalOrder({ warehouseStatus: " Cancelled " })).toBe(true);
    for (const status of ["ready", "in_progress", "completed", "ready_to_ship", "partially_shipped", "exception"]) {
      expect(isTerminalOrder({ warehouseStatus: status })).toBe(false);
    }
  });

  it("an open held line is held, still has quantity, and has not been cancelled, completed or shorted", () => {
    expect(isOpenHeldLine({ onHold: true, status: "pending", quantity: 1 })).toBe(true);
    expect(isOpenHeldLine({ onHold: false, status: "pending", quantity: 1 })).toBe(false);
    expect(isOpenHeldLine({ onHold: null, status: "pending", quantity: 1 })).toBe(false);
    expect(isOpenHeldLine({ onHold: true, status: "pending", quantity: 0 })).toBe(false);
    expect(isOpenHeldLine({ onHold: true, status: "pending", quantity: null })).toBe(false);
    for (const status of ["cancelled", " COMPLETED ", "short"]) {
      expect(isOpenHeldLine({ onHold: true, status, quantity: 1 })).toBe(false);
    }
  });
});

describe("decideOrderHoldRelease", () => {
  it("releases a held open order", () => {
    expect(decideOrderHoldRelease({ onHold: 1, warehouseStatus: "ready" })).toBe("release");
    expect(decideOrderHoldRelease({ onHold: 1, warehouseStatus: "partially_shipped" })).toBe("release");
  });

  it("is a no-op for an order that is not held, whatever its status (replays and double clicks)", () => {
    expect(decideOrderHoldRelease({ onHold: 0, warehouseStatus: "ready" })).toBe("not_held");
    expect(decideOrderHoldRelease({ onHold: 0, warehouseStatus: "shipped" })).toBe("not_held");
    // The legacy status alone has no flag for release-hold to clear.
    expect(decideOrderHoldRelease({ onHold: 0, warehouseStatus: "on_hold" })).toBe("not_held");
  });

  it("refuses a held order that already shipped or was cancelled", () => {
    expect(decideOrderHoldRelease({ onHold: 1, warehouseStatus: "shipped" })).toBe("order_terminal");
    expect(decideOrderHoldRelease({ onHold: 1, warehouseStatus: "cancelled" })).toBe("order_terminal");
  });

  it("reports a missing order", () => {
    expect(decideOrderHoldRelease(null)).toBe("not_found");
    expect(decideOrderHoldRelease(undefined)).toBe("not_found");
  });
});

describe("decideLineHoldRelease", () => {
  it("releases a held line on an open, not-held order", () => {
    expect(decideLineHoldRelease(lineInput())).toBe("release");
    expect(decideLineHoldRelease(lineInput({ order: { ...readyOrder, warehouseStatus: "partially_shipped" } }))).toBe("release");
  });

  it("refuses while the whole order is held, by flag or by legacy status", () => {
    expect(decideLineHoldRelease(lineInput({ order: { ...readyOrder, onHold: 1 } }))).toBe("order_on_hold");
    expect(decideLineHoldRelease(lineInput({ order: { ...readyOrder, warehouseStatus: "on_hold" } }))).toBe("order_on_hold");
  });

  it("refuses on a shipped or cancelled order", () => {
    expect(decideLineHoldRelease(lineInput({ order: { ...readyOrder, warehouseStatus: "cancelled" } }))).toBe("order_terminal");
    // Terminal wins over the order hold: there is nothing left to release.
    expect(decideLineHoldRelease(lineInput({ order: { id: 7, onHold: 1, warehouseStatus: "shipped" } }))).toBe("order_terminal");
  });

  it("is a no-op for a line that is not held, even on a held or closed order", () => {
    const released = { ...heldLine, onHold: false };
    expect(decideLineHoldRelease(lineInput({ line: released }))).toBe("not_held");
    expect(decideLineHoldRelease(lineInput({ line: released, order: { ...readyOrder, onHold: 1 } }))).toBe("not_held");
    expect(decideLineHoldRelease(lineInput({ line: released, order: { ...readyOrder, warehouseStatus: "shipped" } }))).toBe("not_held");
  });

  it("reports a missing row, or a line or order that does not match the requested order", () => {
    expect(decideLineHoldRelease(lineInput({ order: null }))).toBe("not_found");
    expect(decideLineHoldRelease(lineInput({ line: null }))).toBe("not_found");
    expect(decideLineHoldRelease(lineInput({ line: { ...heldLine, orderId: 8 } }))).toBe("not_found");
    expect(decideLineHoldRelease(lineInput({ order: { ...readyOrder, id: 8 } }))).toBe("not_found");
  });
});

describe("holdReleaseRefusalMessage", () => {
  it("tells the operator what to do instead", () => {
    expect(holdReleaseRefusalMessage("order_on_hold")).toMatch(/Release the order hold first/);
    expect(holdReleaseRefusalMessage("order_terminal", " Shipped ")).toMatch(/This order is shipped/);
    expect(holdReleaseRefusalMessage("order_terminal", null)).toMatch(/This order is closed/);
    expect(holdReleaseRefusalMessage("not_found")).toMatch(/not found/);
  });
});
