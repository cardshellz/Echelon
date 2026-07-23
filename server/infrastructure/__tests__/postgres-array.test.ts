import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  sqlBigintArray,
  sqlIntegerArray,
  sqlTextArray,
} from "../postgres-array";

const dialect = new PgDialect();

function render(fragment: ReturnType<typeof sqlTextArray>) {
  return dialect.sqlToQuery(sql`SELECT ${fragment}`);
}

describe("PostgreSQL array SQL", () => {
  it("renders multiple text values as an ARRAY expression instead of a row cast", () => {
    const query = render(sqlTextArray(["line-1", "line-2"]));

    expect(query.sql).toBe("SELECT ARRAY[$1, $2]::text[]");
    expect(query.params).toEqual(["line-1", "line-2"]);
  });

  it("renders single and empty arrays with an explicit PostgreSQL type", () => {
    expect(render(sqlIntegerArray([41]))).toEqual(expect.objectContaining({
      sql: "SELECT ARRAY[$1]::integer[]",
      params: [41],
    }));
    expect(render(sqlBigintArray([]))).toEqual(expect.objectContaining({
      sql: "SELECT ARRAY[]::bigint[]",
      params: [],
    }));
  });
});
