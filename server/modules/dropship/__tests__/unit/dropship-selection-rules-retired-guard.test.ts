import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The vendor's selection is its one-time picks (PLAN-B v4.1 §9, V5): the
 * rules table is frozen by B's migration and no product code may read or write
 * it again, except the few files named here. The guard scans non-test source
 * under server/, scripts/ and shared/ (tests and fixtures may name the frozen
 * table on purpose) for the table's qualified name and its Drizzle symbol.
 * The advisory lock key `dropship_vendor_selection_rules` (no schema prefix,
 * dropship-vendor-selection-lock.ts) and the audit entity
 * `dropship_vendor_selection_ruleset` are other names and do not match.
 */

const SCANNED_ROOTS = ["server", "scripts", "shared"] as const;
/** Source files only: a data file (the writer ratchet's baseline.json) records writers, it does not run. */
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "build", ".git"]);
const RETIRED_RULES_REFERENCE = /\bdropship\.dropship_vendor_selection_rules\b|\bdropshipVendorSelectionRules\b/;

/** Where the frozen rules may still be named, and why. */
const ALLOWED_FILES: ReadonlyMap<string, string> = new Map([
  // The frozen rules GET (listSelectionRulesWithClient) for one release; the PUT's writers are gone (V10).
  ["server/modules/dropship/infrastructure/dropship-selection-atp.repository.ts", "frozen rules GET"],
  // B3's conversion follow-up re-reads the frozen rules to repair a TS/SQL matcher disagreement (§11.2).
  ["server/modules/dropship/infrastructure/dropship-selection-conversion-followup.repository.ts", "conversion follow-up (B3)"],
  // The conversion SQL the migration contains verbatim (§6 step 4; map-db D12).
  ["server/modules/dropship/infrastructure/dropship-selection-conversion.sql.ts", "conversion SQL"],
  // The Drizzle table itself (kept with its data; the drop needs an owner decision).
  ["shared/schema/dropship.schema.ts", "Drizzle schema"],
]);

interface SourceFile { path: string; text: string }
interface RetiredReference { path: string; line: number; text: string }

function isTestPath(path: string): boolean {
  return path.split("/").includes("__tests__") || /\.test\.[cm]?[jt]sx?$/.test(path);
}

/** Every reference to the frozen rules in non-test, non-allowed source (pure: the red case feeds it a fixture). */
function findRetiredRulesReferences(files: readonly SourceFile[]): RetiredReference[] {
  const found: RetiredReference[] = [];
  for (const file of files) {
    if (isTestPath(file.path) || ALLOWED_FILES.has(file.path) || !SOURCE_FILE.test(file.path)) continue;
    file.text.split("\n").forEach((text, index) => {
      if (RETIRED_RULES_REFERENCE.test(text)) found.push({ path: file.path, line: index + 1, text: text.trim() });
    });
  }
  return found;
}

/**
 * Every allowlist entry that no longer earns its place (pure: the red case feeds it a fixture): its file is gone, or
 * the file no longer names the table. Either way the entry must be dropped, so a later file at that path is reviewed.
 */
function staleAllowlistEntries(allowed: ReadonlyMap<string, string>, files: readonly SourceFile[]): string[] {
  const byPath = new Map(files.map((file) => [file.path, file.text]));
  const stale: string[] = [];
  for (const [path, why] of allowed) {
    const text = byPath.get(path);
    if (text === undefined) stale.push(`${path} (${why}) is allowlisted but missing: drop the entry`);
    else if (!RETIRED_RULES_REFERENCE.test(text)) stale.push(`${path} (${why}) is allowlisted but no longer names the table: drop the entry`);
  }
  return stale;
}

function walk(root: string, relativeDirectory: string, out: SourceFile[]): void {
  for (const entry of readdirSync(join(root, relativeDirectory), { withFileTypes: true })) {
    const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(root, path, out);
    } else if (entry.isFile() && SOURCE_FILE.test(entry.name)) {
      out.push({ path, text: readFileSync(join(root, path), "utf8") });
    }
  }
}

function repositorySources(): SourceFile[] {
  const root = resolve(process.cwd());
  const files: SourceFile[] = [];
  for (const scanned of SCANNED_ROOTS) walk(root, scanned, files);
  return files;
}

describe("the frozen vendor selection rules are named only where allowed (PLAN-B v4.1 §9, V5)", () => {
  const files = repositorySources();

  it("finds no reference outside the allowlist in non-test source of server/, scripts/ and shared/", () => {
    expect(files.length).toBeGreaterThan(1_000);
    expect(findRetiredRulesReferences(files)).toEqual([]);
  });

  it("finds no writer of the frozen table in any non-test source, allowed files included (V10: the rules save is gone)", () => {
    const writes = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+dropship\.dropship_vendor_selection_rules\b/i;
    const writers = files.filter((file) => !isTestPath(file.path) && writes.test(file.text)).map((file) => file.path);
    expect(writers).toEqual([]);
    // The guard's own pattern catches the deleted save's statements (red case).
    expect(writes.test("UPDATE dropship.dropship_vendor_selection_rules SET is_active = false")).toBe(true);
    expect(writes.test("INSERT INTO dropship.dropship_vendor_selection_rules (revision_id) VALUES ($1)")).toBe(true);
    expect(writes.test("SELECT id FROM dropship.dropship_vendor_selection_rules")).toBe(false);
  });

  it("keeps the allowlist honest: each allowed file exists and still names the table", () => {
    expect(staleAllowlistEntries(ALLOWED_FILES, files)).toEqual([]);
  });

  it("red case: an allowlisted file that is gone, or no longer names the table, is a stale entry", () => {
    const allowed = new Map([
      ["server/modules/dropship/infrastructure/dropship-gone.repository.ts", "deleted reader"],
      ["server/modules/dropship/infrastructure/dropship-quiet.repository.ts", "stopped reading"],
      ["server/modules/dropship/infrastructure/dropship-reader.repository.ts", "still reads"],
    ]);
    expect(staleAllowlistEntries(allowed, [
      { path: "server/modules/dropship/infrastructure/dropship-quiet.repository.ts", text: "export const nothing = 1;" },
      { path: "server/modules/dropship/infrastructure/dropship-reader.repository.ts",
        text: "SELECT id FROM dropship.dropship_vendor_selection_rules" },
    ])).toEqual([
      "server/modules/dropship/infrastructure/dropship-gone.repository.ts (deleted reader) is allowlisted but missing: drop the entry",
      "server/modules/dropship/infrastructure/dropship-quiet.repository.ts (stopped reading) is allowlisted but no longer names the table: drop the entry",
    ]);
  });

  it("red case: a reader that names the frozen table or its Drizzle symbol is caught; tests, the lock key and the audit entity are not", () => {
    const reader = [
      "export async function listRules(client: Client) {",
      "  return client.query(`SELECT id FROM dropship.dropship_vendor_selection_rules WHERE vendor_id = $1`, [1]);",
      "}",
    ].join("\n");
    expect(findRetiredRulesReferences([
      { path: "server/modules/dropship/infrastructure/dropship-example.repository.ts", text: reader },
      { path: "scripts/example.mjs", text: "import { dropshipVendorSelectionRules } from '../shared/schema';" },
    ])).toEqual([
      { path: "server/modules/dropship/infrastructure/dropship-example.repository.ts", line: 2,
        text: "return client.query(`SELECT id FROM dropship.dropship_vendor_selection_rules WHERE vendor_id = $1`, [1]);" },
      { path: "scripts/example.mjs", line: 1, text: "import { dropshipVendorSelectionRules } from '../shared/schema';" },
    ]);
    expect(findRetiredRulesReferences([
      { path: "server/modules/dropship/__tests__/unit/example.test.ts", text: reader },
      { path: "server/modules/dropship/__tests__/fixtures/example.fixture.ts", text: reader },
      { path: "server/modules/dropship/infrastructure/dropship-vendor-selection-lock.ts",
        text: "export const DROPSHIP_VENDOR_SELECTION_LOCK_KEY = \"dropship_vendor_selection_rules\";" },
      { path: "server/modules/dropship/infrastructure/dropship-example.ts",
        text: "entity_type = 'dropship_vendor_selection_ruleset'; dropshipVendorSelectionRuleSetRevisions" },
      { path: "scripts/writer-ratchet/baseline.json", text: "\"dropship.dropship_vendor_selection_rules\": [" },
    ])).toEqual([]);
  });
});

/**
 * PR C (PLAN-C v4.1 §3 FID-7, §4.4 rule 3, §13.1): only the step 1 save inserts end requests, so no other writer
 * (stock, cost, exposure, the conversion follow-up's pick deletes, the end worker) can ever ask Card Shellz to end
 * a listing, and the save's picks delete is what re-plans the product (the table has no insert invalidation).
 * Updates (the worker, staff) are allowed; inserts are not.
 */
describe("only the step 1 save inserts listing end requests (PR C)", () => {
  const ENDS_INSERT = /\bINSERT\s+INTO\s+dropship\.dropship_listing_end_requests\b|\.insert\(\s*dropshipListingEndRequests\b/i;
  const SAVE_REPOSITORY = "server/modules/dropship/infrastructure/dropship-selection-change.repository.ts";
  const files = repositorySources();

  it("finds exactly one inserter in non-test source of server/, scripts/ and shared/: the save's repository", () => {
    const inserters = files.filter((file) => !isTestPath(file.path) && SOURCE_FILE.test(file.path) && ENDS_INSERT.test(file.text))
      .map((file) => file.path);
    expect(inserters).toEqual([SAVE_REPOSITORY]);
  });

  it("red case: a raw or Drizzle insert is caught; an update, a read and a test fixture are not", () => {
    expect(ENDS_INSERT.test("INSERT INTO dropship.dropship_listing_end_requests (vendor_id) VALUES ($1)")).toBe(true);
    expect(ENDS_INSERT.test("await tx.insert(dropshipListingEndRequests).values(rows)")).toBe(true);
    expect(ENDS_INSERT.test("UPDATE dropship.dropship_listing_end_requests SET state = 'ending'")).toBe(false);
    expect(ENDS_INSERT.test("SELECT id FROM dropship.dropship_listing_end_requests")).toBe(false);
    expect(isTestPath("server/modules/dropship/__tests__/fixtures/listing-end.fixture.ts")).toBe(true);
  });
});
