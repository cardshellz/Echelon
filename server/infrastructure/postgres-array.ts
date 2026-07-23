import { sql, type SQL } from "drizzle-orm";

function elements(values: readonly (number | string)[]): SQL {
  return sql.join(values.map((value) => sql`${value}`), sql`, `);
}

export function sqlTextArray(values: readonly string[]): SQL {
  return values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${elements(values)}]::text[]`;
}

export function sqlIntegerArray(values: readonly number[]): SQL {
  return values.length === 0
    ? sql`ARRAY[]::integer[]`
    : sql`ARRAY[${elements(values)}]::integer[]`;
}

export function sqlBigintArray(values: readonly number[]): SQL {
  return values.length === 0
    ? sql`ARRAY[]::bigint[]`
    : sql`ARRAY[${elements(values)}]::bigint[]`;
}
