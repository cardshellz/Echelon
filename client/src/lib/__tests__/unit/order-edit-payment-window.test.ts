import { describe, expect, it } from "vitest";
import { MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES } from "@shared/order-edits/order-edit.contract";
import {
  parseOrderEditPaymentWindowHours,
  orderEditPaymentWindowHoursInput,
  formatOrderEditPaymentWindowHours,
} from "../../order-edit-payment-window";

describe("admin payment window in hours", () => {
  it.each([
    ["0.5", 30],
    [".5", 30],
    ["1", 60],
    ["1.25", 75],
    ["1.15", 69],
    ["0.1", 6],
    ["24", 1440],
    ["168", 10080],
    [" 2.5 ", 150],
  ])("converts %s hours into exactly %i minutes", (hours, minutes) => {
    expect(parseOrderEditPaymentWindowHours(hours)).toBe(minutes);
  });

  it.each([
    "",
    " ",
    "0",
    "-1",
    "169",
    "0.01",
    "1.001",
    "NaN",
    "Infinity",
    "1e2",
    "1,5",
    "hours",
  ])("rejects invalid or fractional-minute duration %s", (hours) => {
    expect(parseOrderEditPaymentWindowHours(hours)).toBeNull();
  });

  it("preserves every previously supported stored duration through display and save", () => {
    for (
      let minutes = 1;
      minutes <= MAX_ORDER_EDIT_PAYMENT_WINDOW_MINUTES;
      minutes++
    ) {
      expect(
        parseOrderEditPaymentWindowHours(
          orderEditPaymentWindowHoursInput(minutes),
        ),
      ).toBe(minutes);
    }
  });

  it("formats saved hours and leaves an unconfigured setting blank", () => {
    expect(orderEditPaymentWindowHoursInput(null)).toBe("");
    expect(formatOrderEditPaymentWindowHours(30)).toBe("0.5 hours");
    expect(formatOrderEditPaymentWindowHours(60)).toBe("1 hour");
    expect(formatOrderEditPaymentWindowHours(75)).toBe("1.25 hours");
  });

  it.each([0, -1, 1.5, 10081, Infinity, NaN])(
    "rejects unsupported stored duration %s",
    (minutes) => {
      expect(() => orderEditPaymentWindowHoursInput(minutes)).toThrow(
        RangeError,
      );
    },
  );
});
