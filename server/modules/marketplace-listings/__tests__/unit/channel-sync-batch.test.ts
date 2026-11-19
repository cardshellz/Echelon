import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  projectSyncBatch,
  savedSyncBatchSchema,
  type SyncCommandStatus,
} from "../../domain/channel-sync-batch";
import { channelSyncBatchSchema } from "@shared/types/channel-sync-batch";
const now = new Date("2026-10-21T12:00:00.000Z");
function batch(count: number) {
  return savedSyncBatchSchema.parse({
    id: randomUUID(),
    destination: {
      channelId: 1,
      provider: "any",
      connectionId: 2,
      accountId: "seller",
      environment: "production",
      marketplaceId: null,
    },
    actor: "user:operator",
    createdAt: now.toISOString(),
    admissionCompletedAt: null,
    admissionError: null,
    members: Array.from({ length: count }, (_, index) => ({
      productId: index + 1,
      name: `Product ${index + 1}`,
      sku: null,
      commandKey: randomUUID(),
    })),
  });
}
describe("channel-agnostic batch progress", () => {
  it("counts products, and leaves queued, retrying and uncertain provider work unfinished", () => {
    const saved = batch(7);
    const states = [
      "completed",
      "needs_attention",
      "queued",
      "running",
      "retrying",
      "verifying",
      "pending",
    ] as const;
    const rows: SyncCommandStatus[] = saved.members.map((member, index) => ({
      commandKey: member.commandKey,
      operationId: randomUUID(),
      state: states[index],
      code: null,
      message: null,
      updatedAt: now.toISOString(),
      nextAttemptAt: null,
    }));
    const result = projectSyncBatch(saved, rows, now);
    expect(result.state).toBe("working");
    expect(result.counts).toEqual({
      total: 7,
      finished: 2,
      completed: 1,
      needsAttention: 1,
      pending: 1,
      queued: 1,
      running: 1,
      retrying: 1,
      verifying: 1,
      unavailable: 0,
    });
  });
  it("distinguishes finished with issues from success, and empty selection from pending", () => {
    const saved = batch(1),
      member = saved.members[0];
    const status: SyncCommandStatus = {
      commandKey: member.commandKey,
      operationId: randomUUID(),
      state: "needs_attention",
      code: "REFUSED",
      message: "Correct listing",
      updatedAt: now.toISOString(),
      nextAttemptAt: null,
    };
    expect(projectSyncBatch(saved, [status], now).state).toBe(
      "needs_attention",
    );
    expect(
      projectSyncBatch(
        saved,
        [{ ...status, state: "completed", code: null, message: null }],
        now,
      ).state,
    ).toBe("completed");
    expect(projectSyncBatch(batch(0), [], now).counts.total).toBe(0);
  });
  it("never counts missing or malformed evidence as completion", () => {
    const saved = batch(1);
    expect(projectSyncBatch(saved, [], now).items[0].state).toBe("pending");
    expect(
      projectSyncBatch(
        { ...saved, admissionCompletedAt: now.toISOString() },
        [],
        now,
      ).state,
    ).toBe("unavailable");
    const foreign: SyncCommandStatus = {
      commandKey: randomUUID(),
      operationId: null,
      state: "completed",
      code: null,
      message: null,
      updatedAt: now.toISOString(),
      nextAttemptAt: null,
    };
    expect(() => projectSyncBatch(saved, [foreign], now)).toThrow(
      "did not match",
    );
    expect(() =>
      projectSyncBatch(
        saved,
        [
          { ...foreign, commandKey: saved.members[0].commandKey },
          { ...foreign, commandKey: saved.members[0].commandKey },
        ],
        now,
      ),
    ).toThrow("did not match");
    expect(
      channelSyncBatchSchema.safeParse({
        ...projectSyncBatch(saved, [], now),
        counts: { total: -1 },
      }).success,
    ).toBe(false);
  });
});
