import { describe, expect, it, vi } from "vitest";

import { captureOpenBuildCutoverEvidence } from "../../infrastructure/inventory-cutover-review.repository";

describe("open build cutover evidence", () => {
  it("returns one actionable blocker for every executable legacy build", async () => {
    const query = vi.fn(async () => ({ rows: [
      { id: 17, status: "released" },
      { id: 23, status: "in_progress" },
      { id: 41, status: "failed" },
    ] }));

    await expect(captureOpenBuildCutoverEvidence({ query } as any)).resolves.toEqual({
      orders: [
        { id: 17, status: "released" },
        { id: 23, status: "in_progress" },
        { id: 41, status: "failed" },
      ],
      blockers: [
        expect.objectContaining({ code: "CUTOVER_OPEN_BUILD_REQUIRES_RESOLUTION", subject: "build-order:17" }),
        expect.objectContaining({ code: "CUTOVER_OPEN_BUILD_REQUIRES_RESOLUTION", subject: "build-order:23" }),
        expect.objectContaining({ code: "CUTOVER_OPEN_BUILD_REQUIRES_RESOLUTION", subject: "build-order:41" }),
      ],
    });

    const [statement, parameters] = query.mock.calls[0]!;
    expect(statement).toContain("status IN ('released', 'in_progress', 'failed')");
    expect(statement).toContain("ORDER BY id");
    expect(parameters).toEqual([1_001]);
    expect(statement).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
  });

  it("fails the review closed instead of truncating an oversized census", async () => {
    const query = vi.fn(async () => ({
      rows: Array.from({ length: 1_001 }, (_, index) => ({ id: index + 1, status: "released" })),
    }));

    const result = await captureOpenBuildCutoverEvidence({ query } as any);

    expect(result.orders).toEqual([]);
    expect(result.blockers).toEqual([expect.objectContaining({
      code: "CUTOVER_OPEN_BUILD_CENSUS_LIMIT_EXCEEDED",
      subject: "build-orders",
    })]);
  });
});
