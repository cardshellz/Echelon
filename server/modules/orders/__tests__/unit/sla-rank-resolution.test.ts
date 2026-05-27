import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addBusinessDays,
  computeSortRank,
  invalidatePickPrioritySettingsCache,
  resolveSlaDueAt,
  type PickPrioritySettingsDb,
} from "../../sort-rank";

function mockDb(responses: Array<{ rows: any[] }>): PickPrioritySettingsDb {
  const execute = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error("unexpected query");
    return next;
  });
  return { execute };
}

describe("SLA rank resolution", () => {
  beforeEach(() => {
    invalidatePickPrioritySettingsCache();
  });

  it("uses a platform ship-by date before channel defaults", async () => {
    const shipBy = new Date("2026-05-28T12:30:00.000Z");
    const db = mockDb([]);

    const dueAt = await resolveSlaDueAt({
      channelId: 36,
      channelShipByDate: shipBy,
      orderPlacedAt: "2026-05-27T05:01:51.000Z",
    }, db);

    expect(dueAt?.toISOString()).toBe(shipBy.toISOString());
    expect(db.execute).not.toHaveBeenCalled();
  });

  it("uses channels.sla_days before partner profile and global fallback", async () => {
    const db = mockDb([
      { rows: [{ key: "priority.sla_default_days", value: "3" }] },
      { rows: [{ channel_sla_days: 2, partner_sla_days: 1 }] },
    ]);

    const placedAt = new Date("2026-05-27T05:01:51.000Z");
    const dueAt = await resolveSlaDueAt({
      channelId: 36,
      orderPlacedAt: placedAt,
    }, db);

    const expected = addBusinessDays(placedAt, 2);
    expect(dueAt?.getTime()).toBe(expected.getTime());
    expect(db.execute).toHaveBeenCalledTimes(2);
  });

  it("falls back to partner profile SLA when channel SLA is null", async () => {
    const db = mockDb([
      { rows: [{ key: "priority.sla_default_days", value: "3" }] },
      { rows: [{ channel_sla_days: null, partner_sla_days: 1 }] },
    ]);

    const placedAt = new Date("2026-05-27T05:01:51.000Z");
    const dueAt = await resolveSlaDueAt({
      channelId: 67,
      orderPlacedAt: placedAt,
    }, db);

    const expected = addBusinessDays(placedAt, 1);
    expect(dueAt?.getTime()).toBe(expected.getTime());
  });

  it("makes older orders outrank newer orders after the same SLA policy is applied", async () => {
    const now = new Date("2026-05-27T15:00:00.000Z");
    const olderPlacedAt = new Date("2026-05-24T14:52:21.000Z");
    const newerPlacedAt = new Date("2026-05-27T05:01:51.000Z");

    const olderRank = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: addBusinessDays(olderPlacedAt, 2),
      orderPlacedAt: olderPlacedAt,
      now,
    });
    const newerRank = computeSortRank({
      priority: 100,
      onHold: false,
      slaDueAt: addBusinessDays(newerPlacedAt, 2),
      orderPlacedAt: newerPlacedAt,
      now,
    });

    expect(olderRank > newerRank).toBe(true);
  });
});
