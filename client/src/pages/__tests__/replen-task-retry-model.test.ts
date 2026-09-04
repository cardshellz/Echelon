/**
 * Retry rules for blocked replenishment tasks.
 *
 * 2026-09-04: three replenishment tasks blocked when their inventory move hit
 * the packaging_cost_cents type mismatch. A blocked task never retries itself
 * and still counts as the active task for its pick bin, so nothing created a
 * replacement either and those bins silently stopped being refilled. The API
 * had always allowed `blocked -> pending`, but the Replenishment page exposed
 * no control for it, so the only visible action was Cancel.
 *
 * Invariants protected:
 *   1. A genuinely failed task with work left to do can be re-queued.
 *   2. A task waiting on an upstream task is never re-queued by hand: it is
 *      released automatically when that task completes, and forcing it back to
 *      pending could run it out of order.
 *   3. A review-only sentinel with nothing to move is never offered a retry.
 *   4. The retry clears the failure reason but never the notes, which carry
 *      the recorded failure history.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  buildReplenTaskRetryRequest,
  canRetryReplenTask,
  isNoSourceReviewOnlyTask,
  type RetryableReplenTask,
} from "../replen-task-retry-model";

function task(overrides: Partial<RetryableReplenTask> = {}): RetryableReplenTask {
  return {
    status: "blocked",
    qtySourceUnits: 10,
    qtyTargetUnits: 500,
    exceptionReason: "execute_failed",
    dependsOnTaskId: null,
    ...overrides,
  };
}

describe("canRetryReplenTask", () => {
  it("offers a retry for a task that failed mid-execution with work left", () => {
    expect(canRetryReplenTask(task())).toBe(true);
  });

  it.each([500, 800, 10000])(
    "offers a retry for the production tasks blocked by the cost type mismatch (%i units)",
    (qtyTargetUnits) => {
      expect(canRetryReplenTask(task({ qtyTargetUnits }))).toBe(true);
    },
  );

  it.each(["pending", "assigned", "in_progress", "completed", "cancelled"])(
    "offers no retry for a %s task",
    (status) => {
      expect(canRetryReplenTask(task({ status }))).toBe(false);
    },
  );

  it("offers no retry while the task is waiting on an upstream task", () => {
    // Released automatically when the upstream task completes.
    expect(canRetryReplenTask(task({ dependsOnTaskId: 1601 }))).toBe(false);
  });

  it.each(["no_source_stock", "no_source_variant"])(
    "offers no retry for a %s review sentinel",
    (exceptionReason) => {
      expect(canRetryReplenTask(task({
        exceptionReason,
        qtySourceUnits: 0,
        qtyTargetUnits: 0,
      }))).toBe(false);
    },
  );

  it("offers a retry when the source is empty but the task still has units to put away", () => {
    // Not a sentinel: real target quantity, so a restocked source makes this
    // worth running again.
    expect(canRetryReplenTask(task({
      exceptionReason: "no_source_stock",
      qtySourceUnits: 0,
      qtyTargetUnits: 240,
    }))).toBe(true);
  });

  it("offers no retry when there is nothing to move", () => {
    expect(canRetryReplenTask(task({ qtyTargetUnits: 0 }))).toBe(false);
  });

  it("offers a retry when the failure reason was never recorded", () => {
    expect(canRetryReplenTask(task({ exceptionReason: null }))).toBe(true);
  });
});

describe("isNoSourceReviewOnlyTask", () => {
  it("matches only a zero-quantity blocked sentinel with a no-source reason", () => {
    const sentinel = task({ exceptionReason: "no_source_stock", qtySourceUnits: 0, qtyTargetUnits: 0 });
    expect(isNoSourceReviewOnlyTask(sentinel)).toBe(true);
    expect(isNoSourceReviewOnlyTask({ ...sentinel, status: "pending" })).toBe(false);
    expect(isNoSourceReviewOnlyTask({ ...sentinel, dependsOnTaskId: 12 })).toBe(false);
    expect(isNoSourceReviewOnlyTask({ ...sentinel, exceptionReason: "execute_failed" })).toBe(false);
    expect(isNoSourceReviewOnlyTask({ ...sentinel, qtyTargetUnits: 5 })).toBe(false);
  });
});

describe("buildReplenTaskRetryRequest", () => {
  it("re-queues the task and clears the recorded failure reason", () => {
    expect(buildReplenTaskRetryRequest()).toEqual({ status: "pending", exceptionReason: null });
  });

  it("never touches notes, which hold the failure history", () => {
    expect(Object.keys(buildReplenTaskRetryRequest())).toEqual(["status", "exceptionReason"]);
  });
});

describe("Replenishment page retry control", () => {
  const source = readFileSync("client/src/pages/Replenishment.tsx", "utf8");

  it("renders a retry action gated by the shared rule", () => {
    expect(source).toContain("canRetryReplenTask(task) && (");
    expect(source).toContain("button-retry-task-");
    expect(source).toContain("buildReplenTaskRetryRequest()");
  });

  it("routes the no-source check through the shared model instead of restating it", () => {
    expect(source).toContain("isNoSourceReviewOnlyTask(task)");
    expect(source).not.toContain('task.exceptionReason === "no_source_stock"');
  });

  it("surfaces a failed status change instead of failing silently", () => {
    const updateMutation = source.slice(
      source.indexOf("const updateTaskMutation"),
      source.indexOf("const executeTaskMutation"),
    );
    expect(updateMutation).toContain("onError:");
    expect(updateMutation).toContain('variant: "destructive"');
  });
});
