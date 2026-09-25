import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every INSERT in the dropship infrastructure names each column once and
 * gives one value per column. The repository tests answer SQL from stubs, so
 * a column list Postgres would refuse passes them unnoticed: the wallet
 * ledger insert named rewards_balance_after_cents twice (42701 on every
 * funding credit, reversal and reinstatement) and only a real database said
 * so. This reads the source, so it needs no database.
 */

const INFRASTRUCTURE_DIR = resolve(process.cwd(), "server/modules/dropship/infrastructure");

interface InsertStatement {
  file: string;
  line: number;
  table: string;
  columns: string[];
  /** The first VALUES tuple split at top-level commas; null for INSERT … SELECT or a tuple built by interpolation. */
  values: string[] | null;
}

function readInsertStatements(): InsertStatement[] {
  const statements: InsertStatement[] = [];
  for (const file of readdirSync(INFRASTRUCTURE_DIR).filter((name) => name.endsWith(".ts")).sort()) {
    const source = readFileSync(resolve(INFRASTRUCTURE_DIR, file), "utf8");
    const pattern = /INSERT INTO\s+([a-z_][a-z0-9_.]*)(?:\s+AS\s+[a-z_][a-z0-9_]*)?\s*\(([^()]*)\)/gi;
    for (const match of source.matchAll(pattern)) {
      const columns = match[2].split(",").map((column) => column.trim()).filter(Boolean);
      // A list built with interpolation is not a static column list; it is left to the tests of its builder.
      if (!columns.every((column) => /^[a-z_][a-z0-9_]*$/i.test(column))) continue;
      const rest = source.slice((match.index ?? 0) + match[0].length);
      const values = firstValuesTuple(rest);
      statements.push({
        file,
        line: source.slice(0, match.index).split("\n").length,
        table: match[1],
        columns,
        // One interpolation can stand for several values ("'pending', 'pending'"), so such a tuple is not counted.
        values: values && values.some((value) => value.includes("${")) ? null : values,
      });
    }
  }
  return statements;
}

/** The first tuple after VALUES, split at commas outside parentheses and quotes; null when the insert has no VALUES. */
function firstValuesTuple(rest: string): string[] | null {
  const head = /^\s*VALUES\s*\(/i.exec(rest);
  if (!head) return null;
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const character of rest.slice(head[0].length)) {
    if (character === "'") quoted = !quoted;
    if (!quoted && character === "(") depth += 1;
    if (!quoted && character === ")") {
      if (depth === 0) {
        parts.push(current.trim());
        return parts;
      }
      depth -= 1;
    }
    if (!quoted && character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  return null;
}

describe("dropship INSERT statements", () => {
  const statements = readInsertStatements();

  it("finds the inserts it guards, including the wallet ledger's", () => {
    expect(statements.length).toBeGreaterThan(50);
    expect(statements.some((statement) => statement.file === "dropship-wallet.repository.ts" && statement.table === "dropship.dropship_wallet_ledger")).toBe(true);
  });

  it("names each column once", () => {
    const duplicated = statements
      .map((statement) => ({
        where: `${statement.file}:${statement.line} ${statement.table}`,
        columns: [...new Set(statement.columns.filter((column, index) => statement.columns.indexOf(column) !== index))],
      }))
      .filter((statement) => statement.columns.length > 0);
    expect(duplicated).toEqual([]);
  });

  it("gives one value per column", () => {
    const mismatched = statements
      .filter((statement) => statement.values !== null && statement.values.length !== statement.columns.length)
      .map((statement) => `${statement.file}:${statement.line} ${statement.table}: ${statement.columns.length} columns, ${statement.values?.length} values`);
    expect(mismatched).toEqual([]);
  });
});
