import { describe, expect, it, vi } from "vitest";

import {
  acknowledgeControlTowerV2Item,
  snoozeControlTowerV2Item,
} from "../../control-tower-v2.triage";

function fakePool(workItem: Record<string, unknown>) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, " ").trim(), values });
      if (sql.includes("FOR UPDATE")) return { rows: [workItem] };
      if (sql.includes("UPDATE operations.control_tower_work_items")) {
        return {
          rows: [{
            id: workItem.id,
            triage_status: sql.includes("'waiting'") ? "waiting" : "in_progress",
            assigned_user_id: workItem.assigned_user_id ?? values[1],
            owner_team: workItem.owner_team,
            next_review_at: sql.includes("'waiting'") ? values[1] : null,
            row_version: Number(workItem.row_version) + 1,
          }],
        };
      }
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return {
    pool: { connect: vi.fn(async () => client) } as any,
    client,
    statements,
  };
}

const openItem = {
  id: 10,
  row_version: 4,
  source_status: "open",
  triage_status: "needs_attention",
  assigned_user_id: null,
  owner_team: "Warehouse",
  next_review_at: null,
};

describe("Control Tower V2 triage", () => {
  it("locks the row, assigns the session actor, and records an immutable acknowledgement", async () => {
    const db = fakePool(openItem);
    await acknowledgeControlTowerV2Item({
      pool: db.pool,
      id: 10,
      version: 4,
      actorUserId: "user-1",
    });

    expect(db.statements.map(({ sql }) => sql)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    const update = db.statements.find(({ sql }) => sql.startsWith("UPDATE operations.control_tower_work_items"));
    expect(update?.values).toEqual([10, "user-1"]);
    const observation = db.statements.find(({ sql }) => sql.startsWith("INSERT INTO operations.control_tower_observations"));
    expect(observation?.values[5]).toBe("user-1");
    expect(observation?.values[1]).toBe("acknowledged");
  });

  it("rejects a stale optimistic version and rolls back", async () => {
    const db = fakePool(openItem);
    await expect(acknowledgeControlTowerV2Item({
      pool: db.pool,
      id: 10,
      version: 3,
      actorUserId: "user-1",
    })).rejects.toThrow("changed");

    expect(db.statements.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(db.statements.some(({ sql }) => sql.startsWith("UPDATE operations.control_tower_work_items"))).toBe(false);
  });

  it("rejects ownership takeover when another user is already assigned", async () => {
    const db = fakePool({ ...openItem, assigned_user_id: "user-2" });

    await expect(acknowledgeControlTowerV2Item({
      pool: db.pool,
      id: 10,
      version: 4,
      actorUserId: "user-1",
    })).rejects.toThrow("assigned to another user");

    expect(db.statements.some(({ sql }) => sql === "ROLLBACK")).toBe(true);
    expect(db.statements.some(({ sql }) => sql.startsWith("UPDATE operations.control_tower_work_items"))).toBe(false);
  });

  it("uses the injected clock to enforce bounded snooze deadlines", async () => {
    const db = fakePool(openItem);
    const clock = () => new Date("2026-07-10T12:00:00.000Z");

    await expect(snoozeControlTowerV2Item({
      pool: db.pool,
      id: 10,
      version: 4,
      actorUserId: "user-1",
      until: "2026-07-10T12:00:30.000Z",
      reason: "Waiting",
      clock,
    })).rejects.toThrow("at least one minute");

    await expect(snoozeControlTowerV2Item({
      pool: db.pool,
      id: 10,
      version: 4,
      actorUserId: "user-1",
      until: "2026-08-20T12:00:00.000Z",
      reason: "Waiting",
      clock,
    })).rejects.toThrow("cannot exceed 30 days");
  });
});
