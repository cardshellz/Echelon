import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProcurementScheduleDate, procurementScheduleDateInput } from "../procurement-schedule-date";
import { formatWorkspaceDate } from "../../features/purchasing/purchase-workspace-format";

afterEach(() => vi.unstubAllEnvs());

describe("purchase schedule calendar dates", () => {
  it.each(["America/New_York", "Pacific/Honolulu", "Asia/Tokyo"])("keeps date-only and serialized midnight dates stable in %s", (timezone) => {
    vi.stubEnv("TZ", timezone);
    for (const value of ["2026-10-31", "2026-10-31T00:00:00.000Z", new Date("2026-10-31T00:00:00Z")]) {
      expect(procurementScheduleDateInput(value)).toBe("2026-10-31");
      expect(formatProcurementScheduleDate(value)).toBe("Oct 31, 2026");
      expect(formatProcurementScheduleDate(value, { includeYear: false })).toBe("Oct 31");
    }
    expect(formatProcurementScheduleDate("2026-06-02T00:00:00Z")).toBe("Jun 2, 2026");
    expect(formatProcurementScheduleDate("2024-02-29")).toBe("Feb 29, 2024");
    expect(formatProcurementScheduleDate("2026-03-08")).toBe("Mar 8, 2026");
    expect(formatProcurementScheduleDate("2026-11-01")).toBe("Nov 1, 2026");
  });

  it("uses the existing UTC date convention for timestamp offsets and leaves audit instants local", () => {
    vi.stubEnv("TZ", "America/New_York");
    expect(procurementScheduleDateInput("2026-10-30T20:00:00-04:00")).toBe("2026-10-31");
    expect(formatProcurementScheduleDate("2026-10-31T00:00:00Z")).toBe("Oct 31, 2026");
    expect(formatWorkspaceDate("2026-10-31T00:00:00Z")).toBe("Oct 30, 2026");
  });

  it.each(["2026-02-29", "2026-02-30T00:00:00Z", "2026-13-01", "2026-01-00", "2026-10-31T25:00:00Z", "2026-10-31T00:00:00+99:00", "2026-10-31T00:00:00", "2026-10-31 garbage", "10/31/2026", "nonsense", 0, 42, {}, new Date(NaN)])("rejects invalid or ambiguous schedule input: %s", (value) => {
    expect(procurementScheduleDateInput(value)).toBe("");
    expect(formatProcurementScheduleDate(value)).toBe("Date unavailable");
  });

  it.each([null, undefined, ""])("keeps missing dates distinct from invalid dates: %s", (value) => {
    expect(procurementScheduleDateInput(value)).toBe("");
    expect(formatProcurementScheduleDate(value)).toBe("Not recorded");
    expect(formatProcurementScheduleDate(value, { empty: "Not set" })).toBe("Not set");
  });
});
