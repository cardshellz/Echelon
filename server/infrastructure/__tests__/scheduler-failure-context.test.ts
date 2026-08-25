import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabasePoolSnapshot: vi.fn(),
  getSchedulerLockPoolSnapshot: vi.fn(),
}));

vi.mock("../../db", () => ({
  getDatabasePoolSnapshot: mocks.getDatabasePoolSnapshot,
}));

vi.mock("../scheduler-lock", () => ({
  getSchedulerLockPoolSnapshot: mocks.getSchedulerLockPoolSnapshot,
}));

import { buildSchedulerFailureContext } from "../scheduler-failure-context";

describe("buildSchedulerFailureContext", () => {
  beforeEach(() => {
    mocks.getDatabasePoolSnapshot.mockReturnValue({
      totalConnections: 20,
      idleConnections: 0,
      checkedOutConnections: 20,
      waitingRequests: 8,
      maximumConnections: 20,
    });
    mocks.getSchedulerLockPoolSnapshot.mockReturnValue({
      totalConnections: 2,
      idleConnections: 0,
      checkedOutConnections: 2,
      waitingRequests: 4,
      maximumConnections: 2,
    });
  });

  it("includes safe error identity and both pool snapshots", () => {
    const error = Object.assign(new Error("timeout exceeded when trying to connect"), {
      code: "POOL_ACQUIRE_TIMEOUT",
    });

    expect(buildSchedulerFailureContext(error)).toEqual({
      error: "timeout exceeded when trying to connect",
      errorName: "Error",
      errorCode: "POOL_ACQUIRE_TIMEOUT",
      databasePool: {
        totalConnections: 20,
        idleConnections: 0,
        checkedOutConnections: 20,
        waitingRequests: 8,
        maximumConnections: 20,
      },
      schedulerLockPool: {
        totalConnections: 2,
        idleConnections: 0,
        checkedOutConnections: 2,
        waitingRequests: 4,
        maximumConnections: 2,
      },
    });
  });

  it("normalizes non-error values without exposing arbitrary fields", () => {
    expect(buildSchedulerFailureContext("failed")).toMatchObject({
      error: "failed",
      errorName: null,
      errorCode: null,
    });
  });
});
