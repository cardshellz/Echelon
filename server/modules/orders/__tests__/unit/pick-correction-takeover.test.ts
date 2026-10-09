import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { PICK_CORRECTION_TAKEOVER_IDLE_MS, type PickCorrection } from "@shared/pick-corrections";
import { PickCorrectionService } from "../../pick-correction.service";

// #63936, #63938: a picker answered "No" on 2026-10-07 and never did the
// corrective scan. The correction stayed locked to them, so every other picker
// saw "Being resolved by another picker" with no way to finish it.

const answeredAt = new Date("2026-10-07T14:02:38Z");
const commandId = "5f0c3b2e-8a9d-4c1e-9b7a-2d4e6f8a0b1c";

function fixture(overrides: Partial<PickCorrection> = {}, now = new Date(answeredAt.getTime() + PICK_CORRECTION_TAKEOVER_IDLE_MS)) {
  const state: PickCorrection = { id: 168, orderId: 70, orderItemId: 71, orderNumber: "#63936",
    sku: "SHLZ-TOP-180PT-BLU-P10", name: "Toploaders", barcode: null, location: "A-06", declaredQuantity: 1,
    pickedQuantity: 0, revision: 3, state: "picking_required", answer: "no",
    assignedPickerId: "eba26187", reviewReason: null, updatedAt: answeredAt, ...overrides };
  const events: Array<{ commandId: string; hash: string; action: string }> = [];
  const tx = {
    execute: async (statement: any) => {
      const { sql: text, params } = new PgDialect().sqlToQuery(statement);
      if (text.includes('AS "orderNumber"')) return { rows: [{ ...state }] };
      if (text.includes("FROM wms.orders")) return { rows: [{ warehouse_status: "ready", on_hold: 0 }] };
      if (text.includes("FROM wms.pick_correction_events")) {
        return { rows: events.filter(event => event.commandId === params[0]).map(event => ({ request_hash: event.hash })) };
      }
      if (text.startsWith("UPDATE wms.pick_corrections SET assigned_picker_id")) {
        state.assignedPickerId = String(params[0]); state.revision += 1; state.updatedAt = params[1] as Date;
        return { rows: [] };
      }
      if (text.startsWith("INSERT INTO wms.pick_correction_events")) {
        events.push({ commandId: String(params[1]), hash: String(params[2]), action: String(params[4]) });
        return { rows: [] };
      }
      return { rows: [{ id: 1 }] };
    },
  };
  const db = { ...tx, transaction: async <T>(work: (executor: typeof tx) => Promise<T>) => work(tx) };
  const service = new PickCorrectionService(db as any, async () => undefined, () => now);
  return { service, state, events };
}

describe("taking over an idle corrective pick", () => {
  it("moves an idle No to the requesting picker and records who took it", async () => {
    const { service, state, events } = fixture();
    await expect(service.takeOver(168, { commandId, expectedRevision: 3 }, "picker-2"))
      .resolves.toMatchObject({ assignedPickerId: "picker-2", revision: 4 });
    expect(state.assignedPickerId).toBe("picker-2");
    expect(events).toEqual([expect.objectContaining({ commandId, action: "corrective_pick_taken_over" })]);
  });

  it("replays the same command without a second reassignment", async () => {
    const { service, events } = fixture();
    await service.takeOver(168, { commandId, expectedRevision: 3 }, "picker-2");
    await expect(service.takeOver(168, { commandId, expectedRevision: 3 }, "picker-2")).resolves.toMatchObject({ revision: 4 });
    expect(events).toHaveLength(1);
  });

  it("refuses before the correction has been idle long enough", async () => {
    const { service, state } = fixture({}, new Date(answeredAt.getTime() + PICK_CORRECTION_TAKEOVER_IDLE_MS - 1));
    await expect(service.takeOver(168, { commandId, expectedRevision: 3 }, "picker-2"))
      .rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
    expect(state.assignedPickerId).toBe("eba26187");
  });

  it.each([
    ["a Yes (only the books are waiting)", { answer: "yes" as const }],
    ["an unanswered correction", { state: "confirmation_required" as const, answer: null, assignedPickerId: null }],
    ["a correction the requester already holds", { assignedPickerId: "picker-2" }],
    ["a stale screen", { revision: 4 }],
  ])("refuses %s", async (_case, overrides) => {
    const { service } = fixture(overrides);
    await expect(service.takeOver(168, { commandId, expectedRevision: 3 }, "picker-2"))
      .rejects.toMatchObject({ code: "CORRECTION_CHANGED" });
  });
});
