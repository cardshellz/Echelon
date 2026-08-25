import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../db", () => ({ pool: {} }));

import { PgDropshipStoreConnectionRepository } from "../../infrastructure/dropship-store-connection.repository";

describe("dropship admin setup-check severity", () => {
  it("counts both error and blocker checks as blocking readiness evidence", async () => {
    const pool = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    };
    const repository = new PgDropshipStoreConnectionRepository(pool as any);

    await repository.listForAdmin({
      page: 1,
      limit: 25,
      search: null,
      platform: null,
      status: null,
    });

    const sql = String(pool.query.mock.calls[0]?.[0]);
    expect(sql).toContain("COUNT(*) FILTER (WHERE severity IN ('error','blocker')) AS error_setup_check_count");
    expect(sql).toContain("COUNT(*) FILTER (WHERE severity = 'warning') AS warning_setup_check_count");
  });
});
