import { expect, it } from "vitest";
import { formatIntegerCents } from "../../format-integer-cents";
it("formats cents exactly, including large and negative sub-dollar values", () => {
  expect(formatIntegerCents(1, "USD")).toBe("$0.01");
  expect(formatIntegerCents(-1, "USD")).toBe("-$0.01");
  expect(formatIntegerCents(0, "USD")).toBe("$0.00");
  expect(formatIntegerCents(Number.MAX_SAFE_INTEGER, "USD")).toBe(
    "$90,071,992,547,409.91",
  );
  expect(() => formatIntegerCents(0.1, "USD")).toThrow();
});
