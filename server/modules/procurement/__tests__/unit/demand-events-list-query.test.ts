import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
}));

vi.mock("../../../../db", () => ({
  db: {
    execute: mocks.execute,
  },
}));

import { listDemandEvents } from "../../demand-events.service";

const dialect = new PgDialect();

describe("demand event list query", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute
      .mockResolvedValueOnce({ rows: [{ total: 0 }] })
      .mockResolvedValueOnce({ rows: [] });
  });

  it("binds each requested status as a scalar SQL value", async () => {
    await listDemandEvents({ status: ["planned", "active"] });

    const countQuery = dialect.sqlToQuery(mocks.execute.mock.calls[0][0]);
    const listQuery = dialect.sqlToQuery(mocks.execute.mock.calls[1][0]);

    expect(countQuery.sql).toContain("de.status IN ($1, $2)");
    expect(countQuery.params).toEqual(["planned", "active"]);
    expect(listQuery.sql).toContain("de.status IN ($1, $2)");
    expect(listQuery.params.slice(0, 2)).toEqual(["planned", "active"]);
    expect(countQuery.sql).not.toContain("ANY(");
    expect(listQuery.sql).not.toContain("ANY(");
  });
});
