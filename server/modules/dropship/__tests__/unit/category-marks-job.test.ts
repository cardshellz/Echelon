import { describe, expect, it } from "vitest";
import { categoryMarksJobKey } from "../../domain/category-marks-job";
import { DropshipError } from "../../domain/errors";

describe("categoryMarksJobKey (plan PR 9, 10.5)", () => {
  it.each([
    ["the last millisecond of an hour", "2026-10-12T21:59:59.999Z", "category-marks:2026-10-12T21"],
    ["the first millisecond of the next", "2026-10-12T22:00:00.000Z", "category-marks:2026-10-12T22"],
    ["midnight UTC, whatever the process time zone", "2026-10-13T00:00:00.000Z", "category-marks:2026-10-13T00"],
    ["a time given with an offset, named by its UTC hour", "2026-10-12T23:30:00.000-05:00", "category-marks:2026-10-13T04"],
    ["the first year with four digits", "0000-01-01T00:00:00.000Z", "category-marks:0000-01-01T00"],
    ["the last", "9999-12-31T23:59:59.999Z", "category-marks:9999-12-31T23"],
  ])("names %s", (_label, time, key) => {
    const now = new Date(time);
    expect(categoryMarksJobKey(now)).toBe(key);
    // The key fits the system actor's varchar(255) actor_id.
    expect(key.length).toBe(28);
  });

  it("gives every time in one UTC hour the same key, and never reads the system clock", () => {
    const keys = new Set([0, 1, 59 * 60_000, 3_599_999].map((offset) => categoryMarksJobKey(new Date(Date.UTC(2026, 9, 12, 9) + offset))));
    expect(keys).toEqual(new Set(["category-marks:2026-10-12T09"]));
  });

  it.each([
    ["an invalid Date", new Date(Number.NaN)],
    ["a year before 0 (printed with six digits)", new Date("-000001-01-01T00:00:00.000Z")],
    ["a year after 9999", new Date("+010000-01-01T00:00:00.000Z")],
    ["something that is not a Date", "2026-10-12T21:00:00.000Z" as unknown as Date],
  ])("refuses %s as a fatal broken contract", (_label, now) => {
    let thrown: unknown = null;
    try {
      categoryMarksJobKey(now);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DropshipError);
    expect(thrown).toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", context: { classification: "fatal", retryable: false } });
  });
});
