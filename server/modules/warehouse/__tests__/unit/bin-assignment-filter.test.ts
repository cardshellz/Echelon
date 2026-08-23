import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  BinAssignmentFilterError,
  MAX_BIN_ASSIGNMENT_VARIANT_IDS,
  parseBinAssignmentVariantIdsQuery,
} from "../../bin-assignment-filter";
import { BinAssignmentService } from "../../bin-assignment.service";

const dialect = new PgDialect();

describe("bin assignment exact variant filtering", () => {
  it("parses, deduplicates, and sorts a bounded comma-separated query", () => {
    expect(parseBinAssignmentVariantIdsQuery(undefined)).toBeUndefined();
    expect(parseBinAssignmentVariantIdsQuery("33, 11,33,22")).toEqual([11, 22, 33]);
  });

  it.each([null, "", "1,two", "0", "-1", "1.5", ["1", "2"]])(
    "rejects malformed variantIds query value %j",
    (value) => {
      expect(() => parseBinAssignmentVariantIdsQuery(value)).toThrow(BinAssignmentFilterError);
    },
  );

  it("rejects an oversized request before database access", () => {
    const oversized = Array.from(
      { length: MAX_BIN_ASSIGNMENT_VARIANT_IDS + 1 },
      (_, index) => String(index + 1),
    ).join(",");
    expect(() => parseBinAssignmentVariantIdsQuery(oversized)).toThrow(
      `At most ${MAX_BIN_ASSIGNMENT_VARIANT_IDS} product variant IDs may be requested.`,
    );
  });

  it("binds only the exact normalized variant IDs in the slotting query", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    const service = new BinAssignmentService(
      { execute } as any,
      {} as any,
    );

    await expect(service.getAssignmentsView({ variantIds: [33, 11, 33] })).resolves.toEqual([]);

    expect(execute).toHaveBeenCalledTimes(1);
    const rendered = dialect.sqlToQuery(execute.mock.calls[0][0]);
    expect(rendered.sql.replace(/\s+/g, " ")).toContain("AND pv.id IN ($1, $2)");
    expect(rendered.params).toEqual([11, 33]);
  });

  it("returns immediately for an explicitly empty exact-ID filter", async () => {
    const execute = vi.fn();
    const service = new BinAssignmentService(
      { execute } as any,
      {} as any,
    );

    await expect(service.getAssignmentsView({ variantIds: [] })).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });
});
