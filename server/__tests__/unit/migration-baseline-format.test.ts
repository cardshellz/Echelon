import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  baselineSha256,
  buildBaselineManifest,
  transformProductionDump,
  validateBaselineManifest,
} from "../../../scripts/migrations/baseline-format.mjs";
import { validateMigrationDirectory } from "../../../scripts/migrations/migration-policy.mjs";

const MIGRATIONS_DIR = resolve(__dirname, "../../../migrations");

const DUMP = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict abc123",
  "",
  "SET statement_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SELECT pg_catalog.set_config('search_path', '', false);",
  "SET check_function_bodies = false;",
  "",
  "CREATE SCHEMA heroku_ext;",
  "CREATE SCHEMA wms;",
  "SET default_tablespace = '';",
  "SET default_table_access_method = heap;",
  "CREATE TABLE wms.orders (",
  "    id integer NOT NULL",
  ");",
  "CREATE FUNCTION wms.touch() RETURNS trigger LANGUAGE plpgsql AS $$",
  "BEGIN",
  "SET search_path = 'wms';",
  "RETURN NEW;",
  "END $$;",
  "",
  "\\unrestrict abc123",
  "",
].join("\n");

const manifest = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  capturedAt: "2026-11-17",
  serverVersion: "17.10",
  schemaSha256: "a".repeat(64),
  covers: ["0001_first.sql", "900000001000017770001_second.sql"],
  ...overrides,
});

describe("schema baseline format", () => {
  describe("transformProductionDump", () => {
    const output = transformProductionDump(DUMP);

    it("makes every session setting transaction-local so the runner's connection is not left changed", () => {
      expect(output).toContain("SET LOCAL statement_timeout = 0;");
      expect(output).toContain("SET LOCAL client_encoding = 'UTF8';");
      expect(output).toContain("SELECT pg_catalog.set_config('search_path', '', true);");
      expect(output).toContain("SET LOCAL default_tablespace = '';");
      expect(output).toContain("SET LOCAL default_table_access_method = heap;");
      expect(output).not.toMatch(/^SET (?:statement_timeout|client_encoding|check_function_bodies|default_tablespace|default_table_access_method) = /m);
      expect(output).not.toContain("'search_path', '', false");
    });

    it("drops psql-only lines and keeps the objects", () => {
      expect(output).not.toMatch(/^\\/m);
      expect(output).toContain("CREATE SCHEMA wms;");
      expect(output).toContain("CREATE TABLE wms.orders (");
    });

    it("leaves statements inside function bodies untouched", () => {
      expect(output).toContain("\nSET search_path = 'wms';\n");
    });

    it("tolerates the schema Heroku pre-creates", () => {
      expect(output).toContain("CREATE SCHEMA IF NOT EXISTS heroku_ext;");
      expect(output).not.toContain("CREATE SCHEMA heroku_ext;");
    });

    it("is stable across CRLF input and ends with one newline", () => {
      expect(transformProductionDump(DUMP.replace(/\n/g, "\r\n"))).toBe(output);
      expect(output.endsWith("END $$;\n")).toBe(true);
      expect(output).not.toContain("\r");
    });

    it.each([
      ["an empty dump", "   ", "BASELINE_DUMP_EMPTY"],
      ["a dump that creates nothing", "SET statement_timeout = 0;\n", "BASELINE_DUMP_HAS_NO_OBJECTS"],
      ["an unknown psql command", DUMP.replace("CREATE SCHEMA wms;", "\\connect other\nCREATE SCHEMA wms;"), "BASELINE_DUMP_PSQL_COMMAND"],
      ["table rows", `${DUMP}COPY wms.orders (id) FROM stdin;\n1\n\\.\n`, "BASELINE_DUMP_HAS_DATA"],
      ["an unknown preamble statement", DUMP.replace("SET check_function_bodies = false;", "SET ROLE admin;"), "BASELINE_DUMP_UNKNOWN_PREAMBLE"],
      ["a missing search_path line", DUMP.replace("SELECT pg_catalog.set_config('search_path', '', false);\n", ""), "BASELINE_DUMP_SEARCH_PATH"],
    ])("rejects %s", (_label, dump, code) => {
      expect(() => transformProductionDump(dump)).toThrowError(expect.objectContaining({ code }));
    });
  });

  describe("validateBaselineManifest", () => {
    it("accepts a well-formed manifest", () => {
      expect(validateBaselineManifest(manifest())).toEqual(manifest());
    });

    it.each([
      ["a missing field", (() => { const { covers: _covers, ...rest } = manifest(); return rest; })()],
      ["an extra field", manifest({ note: "x" })],
      ["a wrong version", manifest({ version: 2 })],
      ["a malformed date", manifest({ capturedAt: "17 Nov 2026" })],
      ["a malformed hash", manifest({ schemaSha256: "abc" })],
      ["no covered migrations", manifest({ covers: [] })],
      ["unsorted covers", manifest({ covers: ["900000001000017770001_second.sql", "0001_first.sql"] })],
      ["duplicate covers", manifest({ covers: ["0001_first.sql", "0001_first.sql"] })],
      ["a non-SQL filename", manifest({ covers: ["0001_first.txt"] })],
      ["a non-object", null],
    ])("rejects %s", (_label, value) => {
      expect(() => validateBaselineManifest(value)).toThrowError(expect.objectContaining({ code: "INVALID_BASELINE_MANIFEST" }));
    });
  });

  describe("buildBaselineManifest", () => {
    const input = {
      schemaText: "CREATE SCHEMA wms;\n",
      repositoryMigrations: ["900000001000017770001_second.sql", "0001_first.sql"],
      appliedInProduction: ["0001_first.sql", "900000001000017770001_second.sql", "removed_long_ago.sql"],
      capturedAt: "2026-11-17",
      serverVersion: "17.10",
    };

    it("covers every repository migration, sorted, and hashes the LF-normalized schema", () => {
      const built = buildBaselineManifest(input);
      expect(built.covers).toEqual(["0001_first.sql", "900000001000017770001_second.sql"]);
      expect(built.schemaSha256).toBe(baselineSha256("CREATE SCHEMA wms;\r\n"));
    });

    it("refuses a snapshot taken before production applied every repository migration", () => {
      expect(() => buildBaselineManifest({ ...input, appliedInProduction: ["0001_first.sql"] }))
        .toThrowError(expect.objectContaining({
          code: "BASELINE_MIGRATION_NOT_APPLIED",
          context: { missing: ["900000001000017770001_second.sql"] },
        }));
    });
  });

  describe("the committed baseline", () => {
    const schema = readFileSync(resolve(MIGRATIONS_DIR, "baseline/schema.sql"), "utf8");
    const committed = validateBaselineManifest(JSON.parse(readFileSync(resolve(MIGRATIONS_DIR, "baseline/manifest.json"), "utf8")));

    it("matches the hash its manifest records", () => {
      expect(baselineSha256(schema)).toBe(committed.schemaSha256);
    });

    it("covers only migrations that are still in the repository", () => {
      const files = new Set(validateMigrationDirectory(MIGRATIONS_DIR));
      expect(committed.covers.filter((filename) => !files.has(filename))).toEqual([]);
    });

    it("holds structure only and nothing the runner cannot execute", () => {
      expect(schema).not.toMatch(/^\\/m);
      expect(schema).not.toMatch(/^COPY .* FROM stdin;$/m);
      // No session-level setting may survive: each must be SET LOCAL.
      expect(schema).not.toMatch(/^SET (?:statement_timeout|lock_timeout|client_encoding|row_security|default_tablespace) = /m);
      expect(schema).toContain("SELECT pg_catalog.set_config('search_path', '', true);");
      expect(schema).toContain("CREATE TABLE public._migrations (");
    });

    it("carries no database owner, grant or connection detail", () => {
      expect(schema).not.toMatch(/^(?:GRANT|REVOKE|ALTER .* OWNER TO) /m);
      expect(schema).not.toMatch(/postgres(?:ql)?:\/\//);
    });
  });
});
