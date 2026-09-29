import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * PostgreSQL deduces one type per query parameter. A parameter that is
 * assigned to a varchar or timestamp column and also compared with a text
 * literal ("CASE WHEN $2 = 'failed'") is deduced twice, and the whole
 * statement is refused: "inconsistent types deduced for parameter $2". That
 * left every listing push job "processing" for good and never revoked a
 * store's grant. Decide such branches in TypeScript and pass the value.
 */
const ROOTS = ["server/modules/dropship", "server/modules/procurement"].map((dir) => resolve(process.cwd(), dir));
const PATTERN = /CASE\s+WHEN\s+\$\d+\s*(?:=|<>|IN\s*\()/g;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return entry.endsWith(".ts") ? [path] : [];
  });
}

describe("dropship and procurement SQL never compare a query parameter with a literal", () => {
  it("finds no CASE WHEN $n = 'literal' branch in the modules' source", () => {
    const offenders = ROOTS.flatMap((root) => sourceFiles(root).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return [...source.matchAll(PATTERN)].map((match) => `${file.slice(process.cwd().length + 1)}: ${match[0]}`);
    }));
    expect(offenders).toEqual([]);
  });
});
