import { describe, expect, it } from "vitest";

import { getPostgresPoolSnapshot } from "../postgres-pool-observability";

describe("getPostgresPoolSnapshot", () => {
  it("reports checked-out and waiting connection pressure", () => {
    expect(getPostgresPoolSnapshot({
      totalCount: 20,
      idleCount: 2,
      waitingCount: 7,
      options: { max: 20 },
    })).toEqual({
      totalConnections: 20,
      idleConnections: 2,
      checkedOutConnections: 18,
      waitingRequests: 7,
      maximumConnections: 20,
    });
  });

  it("fails closed to non-negative counters for malformed metrics", () => {
    expect(getPostgresPoolSnapshot({
      totalCount: -1,
      idleCount: 5,
      waitingCount: Number.NaN,
    })).toEqual({
      totalConnections: 0,
      idleConnections: 0,
      checkedOutConnections: 0,
      waitingRequests: 0,
      maximumConnections: null,
    });
  });
});
