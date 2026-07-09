/**
 * Regression guard for the "could not determine data type of parameter $N"
 * pick crash (2026-07, orders #59825 / ESS-TOP).
 *
 * Root cause: jsonb_build_object(...) takes VARIADIC "any" arguments, so a
 * bound parameter inside it gives Postgres ZERO context to infer the type.
 * node-postgres sends parameters with unspecified type OIDs, so any raw
 * ${jsValue} placed inside jsonb_build_object fails at parse time — which
 * turned every out-of-stock pick RETRY (the exception-supersede path) into a
 * hard 500 loop: the first failure creates a blocking allocation exception,
 * every retry tries to supersede it and dies on the uncast ${now} at $3.
 *
 * The fix idiom (already used in shipment-rollup.ts) is an explicit cast:
 *   'supersededAt', ${now}::timestamptz
 *
 * This test scans every jsonb_build_object(...) call in the orders module and
 * fails if ANY interpolated parameter lacks a ::cast — so the class of bug
 * cannot be reintroduced.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ORDERS_DIR = join(__dirname, "..", "..");

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") return [];
      return listSourceFiles(join(dir, entry.name));
    }
    return entry.name.endsWith(".ts") ? [join(dir, entry.name)] : [];
  });
}

/** Extract the argument snippet of each jsonb_build_object(...) call. */
function jsonbCallSnippets(src: string): string[] {
  const snippets: string[] = [];
  let idx = 0;
  while ((idx = src.indexOf("jsonb_build_object(", idx)) !== -1) {
    const start = idx + "jsonb_build_object(".length;
    let depth = 1;
    let end = start;
    while (end < src.length && depth > 0) {
      const ch = src[end];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      end++;
    }
    snippets.push(src.slice(start, end - 1));
    idx = end;
  }
  return snippets;
}

describe("jsonb_build_object parameter casts (orders module)", () => {
  it("every interpolated ${param} inside jsonb_build_object carries an explicit ::cast", () => {
    const offenders: string[] = [];

    for (const file of listSourceFiles(ORDERS_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const snippet of jsonbCallSnippets(src)) {
        // A ${...} inside jsonb_build_object must be immediately followed by
        // a ::cast — Postgres cannot infer types for variadic "any" args.
        const uncast = snippet.match(/\$\{[^}]+\}(?!::)/g);
        if (uncast) {
          offenders.push(`${file}: ${uncast.join(", ")}`);
        }
      }
    }

    expect(
      offenders,
      "Uncast bound parameter(s) inside jsonb_build_object — Postgres cannot " +
        "infer a type there and the statement fails with 'could not determine " +
        "data type of parameter $N'. Add an explicit cast, e.g. ${value}::text " +
        "or ${when}::timestamptz:\n" + offenders.join("\n"),
    ).toEqual([]);
  });

  it("the exception-supersede UPDATE carries the specific casts (#59825)", () => {
    const src = readFileSync(join(ORDERS_DIR, "picking.use-cases.ts"), "utf8");
    expect(src).toContain("'supersededAt', ${now}::timestamptz");
    expect(src).toContain("'supersededExceptionType', ${params.exceptionType}::text");
  });
});
