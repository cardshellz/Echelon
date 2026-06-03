import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBusinessDays,
  coerceTimeZone,
  computeSortRank,
  effectiveFulfillmentDate,
  invalidatePickPrioritySettingsCache,
  parseCutoffMinutes,
  resolveSlaDueAt,
  type PickPrioritySettingsDb,
} from "../../sort-rank";

const NY = "America/New_York";

function mockDb(responses: Array<{ rows: any[] }>): PickPrioritySettingsDb {
  const queue = [...responses];
  const execute = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected query");
    return next;
  });
  return { execute };
}

/** Read back the wall-clock calendar day of an instant in a timezone. */
function localYMD(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

/** Read back the wall-clock HH:MM of an instant in a timezone. */
function localHM(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

// The two real orders that started this whole investigation:
//   #58374 — placed Mon Jun 1, 10:51 PM ET (after a 2 PM cutoff)
//   #58386 — placed Tue Jun 2, 03:02 AM ET (before the cutoff)
// In your store's flat UTC-8 clock both read as "6/1 evening", and both
// genuinely miss Monday's truck → both make Tuesday's wave.
const ORDER_58374_PLACED = "2026-06-02T02:51:55.000Z"; // Mon 22:51 ET
const ORDER_58386_PLACED = "2026-06-02T07:02:22.000Z"; // Tue 03:02 ET

describe("parseCutoffMinutes", () => {
  it("parses valid HH:MM 24h values", () => {
    expect(parseCutoffMinutes("14:00")).toBe(840);
    expect(parseCutoffMinutes("00:00")).toBe(0);
    expect(parseCutoffMinutes("09:30")).toBe(570);
    expect(parseCutoffMinutes("23:59")).toBe(1439);
  });

  it("rejects malformed / out-of-range / unset values (null = no cutoff)", () => {
    expect(parseCutoffMinutes(null)).toBeNull();
    expect(parseCutoffMinutes(undefined)).toBeNull();
    expect(parseCutoffMinutes("")).toBeNull();
    expect(parseCutoffMinutes("24:00")).toBeNull(); // hour out of range
    expect(parseCutoffMinutes("2:00")).toBeNull();  // needs 2-digit hour
    expect(parseCutoffMinutes("14:60")).toBeNull(); // minute out of range
    expect(parseCutoffMinutes("2pm")).toBeNull();
  });
});

describe("coerceTimeZone", () => {
  it("accepts real IANA zones, rejects garbage so it can't poison SLA math", () => {
    expect(coerceTimeZone("America/New_York")).toBe("America/New_York");
    expect(coerceTimeZone("America/Los_Angeles")).toBe("America/Los_Angeles");
    expect(coerceTimeZone("Not/AZone")).toBeNull();
    expect(coerceTimeZone("America/New York")).toBeNull(); // space, not underscore
    expect(coerceTimeZone(null)).toBeNull();
    expect(coerceTimeZone("")).toBeNull();
  });
});

describe("effectiveFulfillmentDate", () => {
  it("unifies the #58374 / #58386 pair onto the same fulfillment day", () => {
    const a = effectiveFulfillmentDate(new Date(ORDER_58374_PLACED), NY, 840); // after cutoff
    const b = effectiveFulfillmentDate(new Date(ORDER_58386_PLACED), NY, 840); // before cutoff
    // Mon-after-cutoff rolls to Tue; Tue-before-cutoff stays Tue → SAME day.
    expect(localYMD(a, NY)).toBe("2026-06-02");
    expect(localYMD(b, NY)).toBe("2026-06-02");
  });

  it("WITHOUT a cutoff, the same pair splits across two days (the original bug)", () => {
    const a = effectiveFulfillmentDate(new Date(ORDER_58374_PLACED), NY, null);
    const b = effectiveFulfillmentDate(new Date(ORDER_58386_PLACED), NY, null);
    expect(localYMD(a, NY)).toBe("2026-06-01"); // Mon stays Mon
    expect(localYMD(b, NY)).toBe("2026-06-02"); // Tue stays Tue
  });

  it("treats the cutoff minute as an exclusive boundary (>= rolls)", () => {
    // 13:59 ET = 17:59Z (EDT) — before 14:00 → same day
    const before = effectiveFulfillmentDate(new Date("2026-06-02T17:59:00.000Z"), NY, 840);
    // 14:01 ET = 18:01Z — at/after 14:00 → rolls to next business day
    const after = effectiveFulfillmentDate(new Date("2026-06-02T18:01:00.000Z"), NY, 840);
    expect(localYMD(before, NY)).toBe("2026-06-02"); // Tue
    expect(localYMD(after, NY)).toBe("2026-06-03");  // Wed
  });

  it("rolls a Friday-after-cutoff order to Monday (skips the weekend)", () => {
    // Fri Jun 5 2026, 15:00 ET = 19:00Z, after cutoff
    const fri = effectiveFulfillmentDate(new Date("2026-06-05T19:00:00.000Z"), NY, 840);
    expect(localYMD(fri, NY)).toBe("2026-06-08"); // Mon
  });

  it("rolls weekend orders to Monday regardless of cutoff", () => {
    const sat = effectiveFulfillmentDate(new Date("2026-06-06T14:00:00.000Z"), NY, 840);
    const sun = effectiveFulfillmentDate(new Date("2026-06-07T14:00:00.000Z"), NY, 840);
    expect(localYMD(sat, NY)).toBe("2026-06-08"); // Mon
    expect(localYMD(sun, NY)).toBe("2026-06-08"); // Mon
  });
});

describe("addBusinessDays (timezone-explicit)", () => {
  it("advances business days and anchors to 17:00 in the given zone", () => {
    // Mon Jun 1 2026 noon ET + 2 business days → Wed Jun 3, 17:00 ET (EDT = UTC-4)
    const due = addBusinessDays(new Date("2026-06-01T16:00:00.000Z"), 2, NY);
    expect(localYMD(due, NY)).toBe("2026-06-03");
    expect(localHM(due, NY)).toBe("17:00");
    expect(due.toISOString()).toBe("2026-06-03T21:00:00.000Z");
  });

  it("skips weekends when advancing", () => {
    // Fri Jun 5 2026 + 1 business day → Mon Jun 8
    const due = addBusinessDays(new Date("2026-06-05T16:00:00.000Z"), 1, NY);
    expect(localYMD(due, NY)).toBe("2026-06-08");
  });

  it("holds 17:00 LOCAL across a DST boundary (EDT → EST)", () => {
    // US DST ends Sun Nov 1 2026. Fri Oct 30 + 1 biz day → Mon Nov 2 (EST = UTC-5).
    const due = addBusinessDays(new Date("2026-10-30T16:00:00.000Z"), 1, NY);
    expect(localYMD(due, NY)).toBe("2026-11-02");
    expect(localHM(due, NY)).toBe("17:00"); // still 5 PM local, not shifted by DST
    expect(due.toISOString()).toBe("2026-11-02T22:00:00.000Z"); // 17:00 EST = 22:00Z
  });

  it("does not depend on the server's ambient timezone (explicit zones differ)", () => {
    const placed = new Date("2026-06-01T16:00:00.000Z");
    const ny = addBusinessDays(placed, 1, "America/New_York");
    const la = addBusinessDays(placed, 1, "America/Los_Angeles");
    // Same local 17:00 anchor, different absolute instants (3h apart).
    expect(localHM(ny, "America/New_York")).toBe("17:00");
    expect(localHM(la, "America/Los_Angeles")).toBe("17:00");
    expect(ny.toISOString()).not.toBe(la.toISOString());
  });

  it("falls back to a safe default for an invalid timezone", () => {
    const placed = new Date("2026-06-01T16:00:00.000Z");
    const bad = addBusinessDays(placed, 1, "Not/AZone");
    const good = addBusinessDays(placed, 1, NY);
    expect(bad.toISOString()).toBe(good.toISOString());
  });
});

describe("resolveSlaDueAt with cutoff (end-to-end)", () => {
  beforeEach(() => {
    invalidatePickPrioritySettingsCache();
  });

  it("gives the Hobby and core orders the SAME SLA day so tier breaks the tie", async () => {
    const db = mockDb([{ rows: [{ key: "priority.sla_default_days", value: "2" }] }]);

    const dueCore = await resolveSlaDueAt(
      { orderPlacedAt: ORDER_58374_PLACED, timezone: NY, cutoffLocal: "14:00" }, db,
    );
    const dueHobby = await resolveSlaDueAt(
      { orderPlacedAt: ORDER_58386_PLACED, timezone: NY, cutoffLocal: "14:00" }, db,
    );

    // Both make Tuesday's wave → identical SLA deadline.
    expect(dueCore?.toISOString()).toBe(dueHobby?.toISOString());
    expect(localYMD(dueCore!, NY)).toBe("2026-06-04"); // Tue + 2 biz = Thu

    // And with equal SLA, the Hobby modifier (priority 105 vs 100) now wins,
    // because priority sits behind SLA in the sort_rank.
    const coreRank = computeSortRank({ priority: 100, onHold: false, slaDueAt: dueCore, orderPlacedAt: ORDER_58374_PLACED });
    const hobbyRank = computeSortRank({ priority: 105, onHold: false, slaDueAt: dueHobby, orderPlacedAt: ORDER_58386_PLACED });
    expect(hobbyRank > coreRank).toBe(true);
  });

  it("WITHOUT a cutoff, the same pair splits SLA days and the core order wins on SLA (the bug)", async () => {
    const db = mockDb([{ rows: [{ key: "priority.sla_default_days", value: "2" }] }]);

    const dueCore = await resolveSlaDueAt({ orderPlacedAt: ORDER_58374_PLACED, timezone: NY }, db);
    const dueHobby = await resolveSlaDueAt({ orderPlacedAt: ORDER_58386_PLACED, timezone: NY }, db);

    expect(dueCore?.toISOString()).not.toBe(dueHobby?.toISOString());
    const coreRank = computeSortRank({ priority: 100, onHold: false, slaDueAt: dueCore, orderPlacedAt: ORDER_58374_PLACED });
    const hobbyRank = computeSortRank({ priority: 105, onHold: false, slaDueAt: dueHobby, orderPlacedAt: ORDER_58386_PLACED });
    // Earlier SLA day beats the Hobby tier — reproducing the reported behavior.
    expect(coreRank > hobbyRank).toBe(true);
  });

  it("falls back to the global default_timezone when the warehouse tz is invalid", async () => {
    const db = mockDb([{
      rows: [
        { key: "default_timezone", value: "America/Chicago" },
        { key: "priority.sla_default_days", value: "2" },
      ],
    }]);

    const due = await resolveSlaDueAt(
      { orderPlacedAt: "2026-06-01T16:00:00.000Z", timezone: "Not/AZone", cutoffLocal: "14:00" }, db,
    );
    // Resolved in Chicago (CT), not Eastern: 17:00 CT anchor.
    expect(localHM(due!, "America/Chicago")).toBe("17:00");
    expect(due?.toISOString()).toBe("2026-06-03T22:00:00.000Z"); // 17:00 CDT = 22:00Z
  });

  it("still honors an explicit platform ship-by date (cutoff does not override it)", async () => {
    const shipBy = new Date("2026-05-28T12:30:00.000Z");
    const db = mockDb([]);
    const due = await resolveSlaDueAt(
      { channelShipByDate: shipBy, orderPlacedAt: ORDER_58374_PLACED, timezone: NY, cutoffLocal: "14:00" }, db,
    );
    expect(due?.toISOString()).toBe(shipBy.toISOString());
    expect(db.execute).not.toHaveBeenCalled();
  });
});
