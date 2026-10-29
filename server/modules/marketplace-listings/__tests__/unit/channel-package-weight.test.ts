import { describe, expect, it } from "vitest";
import { prepareChannelPublicationWeight } from "../../domain/channel-package-weight";

describe("shared channel publication weight", () => {
  it.each([
    ["0.01", 1], [28, 1], ["28.349523125", 1],
    ["28.349523125000000001", 2], ["56.69904625", 2],
    ["56.699046250000000001", 3], ["120.25", 5], ["3175.25", 113],
  ] as const)("rounds %s catalog grams upward without losing a positive fraction", (value, ounces) => {
    expect(prepareChannelPublicationWeight({ value, unit: "GRAM" })).toEqual({ ounces, pounds: ounces / 16 });
  });
  it.each([
    [{ value: "28.349523125", unit: "GRAM" }, 1],
    [{ value: "0.028349523125", unit: "KILOGRAM" }, 1],
    [{ value: "0.0625", unit: "POUND" }, 1],
    [{ value: 1, unit: "OUNCE" }, 1],
    [{ value: "0.1", unit: "POUND" }, 2],
    [{ value: "16.000000000000000001", unit: "OUNCE" }, 17],
  ] as const)("uses one rule for equivalent source measurements (%j)", (input, ounces) => {
    expect(prepareChannelPublicationWeight(input).ounces).toBe(ounces);
  });
  it.each([0, -1, NaN, Infinity, -Infinity, "", " ", "-1", "0x10", "not a weight", "1e100"])(
    "refuses invalid/unrepresentable source weight %s", value => {
      expect(() => prepareChannelPublicationWeight({ value, unit: "GRAM" }))
        .toThrow(expect.objectContaining({ code: "CHANNEL_PACKAGE_WEIGHT_INVALID" }));
    });
  it("is deterministic, preserves the source and does not add another ounce on replay", () => {
    const source = Object.freeze({ value: "120.25", unit: "GRAM" as const });
    const first = prepareChannelPublicationWeight(source);
    expect(prepareChannelPublicationWeight(source)).toEqual(first);
    expect(prepareChannelPublicationWeight({ value: first.ounces, unit: "OUNCE" })).toEqual(first);
    expect(source.value).toBe("120.25");
  });
});
