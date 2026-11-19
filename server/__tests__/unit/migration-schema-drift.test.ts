import { describe, expect, it } from "vitest";
import {
  DATABASE_LEVEL_GROUP,
  DRIFT_ALERT_MAX_CHARACTERS,
  DRIFT_ALERT_MAX_LISTED_OBJECTS,
  DRIFT_KINDS,
  compareStructureDumps,
  countDifferencesBySchema,
  formatCheckFailureAlert,
  formatDriftAlert,
  parseStructureDump,
  type StructureDifference,
} from "../../../scripts/migrations/schema-drift.mjs";

const PREAMBLE = [
  "--",
  "-- PostgreSQL database dump",
  "--",
  "",
  "\\restrict abc123",
  "",
  "-- Dumped from database version 17.11",
  "SET statement_timeout = 0;",
  "",
];
const FOOTER = ["--", "-- PostgreSQL database dump complete", "--", "", "\\unrestrict abc123", ""];

function entry(name: string, type: string, schema: string, body: string[]): string[] {
  return ["--", `-- Name: ${name}; Type: ${type}; Schema: ${schema}; Owner: -`, "--", "", ...body, "", ""];
}

function dump(...entries: string[][]): string {
  return [...PREAMBLE, ...entries.flat(), ...FOOTER].join("\n");
}

const WMS_SCHEMA = entry("wms", "SCHEMA", "-", ["CREATE SCHEMA wms;"]);
const ORDERS = entry("orders", "TABLE", "wms", ["CREATE TABLE wms.orders (", "    id integer NOT NULL", ");"]);
const ORDERS_INDEX = entry("orders_id_idx", "INDEX", "wms", ["CREATE INDEX orders_id_idx ON wms.orders USING btree (id);"]);
const PLANS = entry("plans", "TABLE", "membership", ["CREATE TABLE membership.plans (", "    id integer NOT NULL", ");"]);
const EXTENSION = entry("pgcrypto", "EXTENSION", "-", ["CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;"]);

function difference(overrides: Partial<StructureDifference> = {}): StructureDifference {
  return { schema: "wms", type: "TABLE", name: "orders", kind: DRIFT_KINDS.different, repository: "a", production: "b", ...overrides };
}

describe("parseStructureDump", () => {
  it("splits a dump into objects and ignores the preamble, footer and psql guard lines", () => {
    const objects = [...parseStructureDump(dump(WMS_SCHEMA, ORDERS)).values()];

    expect(objects).toEqual([
      { type: "SCHEMA", schema: "-", name: "wms", definition: "CREATE SCHEMA wms;" },
      { type: "TABLE", schema: "wms", name: "orders", definition: "CREATE TABLE wms.orders (\n    id integer NOT NULL\n);" },
    ]);
  });

  it("keeps every entry that shares a type, schema and name, in a stable order", () => {
    const second = entry("orders", "COMMENT", "wms", ["COMMENT ON TABLE wms.orders IS 'b';"]);
    const first = entry("orders", "COMMENT", "wms", ["COMMENT ON TABLE wms.orders IS 'a';"]);

    const [forward] = [...parseStructureDump(dump(second, first)).values()];
    const [backward] = [...parseStructureDump(dump(first, second)).values()];

    expect(forward.definition).toBe("COMMENT ON TABLE wms.orders IS 'a';\n\nCOMMENT ON TABLE wms.orders IS 'b';");
    expect(backward.definition).toBe(forward.definition);
  });

  it.each([
    ["an empty dump", "   \n", "SCHEMA_DRIFT_DUMP_EMPTY"],
    ["a dump with no objects", PREAMBLE.join("\n"), "SCHEMA_DRIFT_DUMP_HAS_NO_OBJECTS"],
  ])("rejects %s", (_label, text, code) => {
    expect(() => parseStructureDump(text)).toThrowError(expect.objectContaining({ code }));
  });
});

describe("compareStructureDumps", () => {
  it("reports identical dumps as identical", () => {
    const text = dump(WMS_SCHEMA, ORDERS, ORDERS_INDEX);

    expect(compareStructureDumps({ repositoryDump: text, productionDump: text })).toEqual({
      identical: true,
      objects: { repository: 3, production: 3 },
      differences: [],
    });
  });

  it("does not depend on the order objects were dumped in", () => {
    const result = compareStructureDumps({
      repositoryDump: dump(WMS_SCHEMA, ORDERS, ORDERS_INDEX),
      productionDump: dump(ORDERS_INDEX, WMS_SCHEMA, ORDERS),
    });

    expect(result.identical).toBe(true);
  });

  it("ignores line endings, including a carriage return stored inside a definition", () => {
    const lf = dump(WMS_SCHEMA, ORDERS);

    expect(compareStructureDumps({ repositoryDump: lf, productionDump: lf.replace(/\n/g, "\r\n") }).identical).toBe(true);
    expect(compareStructureDumps({ repositoryDump: lf, productionDump: lf.replace(/\n/g, "\r\r\n") }).identical).toBe(true);
  });

  it("ignores the psql guard token and version comment, which differ on every dump", () => {
    const repositoryDump = dump(WMS_SCHEMA, ORDERS);
    const productionDump = repositoryDump
      .replaceAll("abc123", "zzz999")
      .replace("version 17.11", "version 17.11 (Ubuntu 17.11-1.pgdg20.04+heroku1)");

    expect(compareStructureDumps({ repositoryDump, productionDump }).identical).toBe(true);
  });

  it("reports an object that exists only in production", () => {
    const result = compareStructureDumps({
      repositoryDump: dump(WMS_SCHEMA, ORDERS),
      productionDump: dump(WMS_SCHEMA, ORDERS, ORDERS_INDEX),
    });

    expect(result.identical).toBe(false);
    expect(result.differences).toEqual([{
      schema: "wms", type: "INDEX", name: "orders_id_idx", kind: DRIFT_KINDS.onlyInProduction,
      repository: null, production: "CREATE INDEX orders_id_idx ON wms.orders USING btree (id);",
    }]);
  });

  it("reports an object that exists only in the repository", () => {
    const result = compareStructureDumps({
      repositoryDump: dump(WMS_SCHEMA, ORDERS, ORDERS_INDEX),
      productionDump: dump(WMS_SCHEMA, ORDERS),
    });

    expect(result.differences.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "orders_id_idx", kind: DRIFT_KINDS.onlyInRepository },
    ]);
  });

  it("reports an object whose definition differs, with both definitions", () => {
    const widened = entry("orders", "TABLE", "wms", ["CREATE TABLE wms.orders (", "    id bigint NOT NULL", ");"]);

    const result = compareStructureDumps({
      repositoryDump: dump(WMS_SCHEMA, ORDERS),
      productionDump: dump(WMS_SCHEMA, widened),
    });

    expect(result.differences).toEqual([{
      schema: "wms", type: "TABLE", name: "orders", kind: DRIFT_KINDS.different,
      repository: "CREATE TABLE wms.orders (\n    id integer NOT NULL\n);",
      production: "CREATE TABLE wms.orders (\n    id bigint NOT NULL\n);",
    }]);
  });

  it("treats a table and an index with the same name as different objects", () => {
    const clash = entry("orders", "INDEX", "wms", ["CREATE INDEX orders ON wms.orders USING btree (id);"]);

    const result = compareStructureDumps({
      repositoryDump: dump(WMS_SCHEMA, ORDERS),
      productionDump: dump(WMS_SCHEMA, ORDERS, clash),
    });

    expect(result.differences.map(({ type, kind }) => ({ type, kind }))).toEqual([
      { type: "INDEX", kind: DRIFT_KINDS.onlyInProduction },
    ]);
  });

  it("groups a schema under its own name and other schema-less objects at database level, sorted", () => {
    const result = compareStructureDumps({
      repositoryDump: dump(ORDERS),
      productionDump: dump(ORDERS, WMS_SCHEMA, PLANS, EXTENSION),
    });

    expect(result.differences.map(({ schema, type, name }) => `${schema}|${type}|${name}`)).toEqual([
      `${DATABASE_LEVEL_GROUP}|EXTENSION|pgcrypto`,
      "membership|TABLE|plans",
      "wms|SCHEMA|wms",
    ]);
  });

  it("does not change its inputs", () => {
    const repositoryDump = dump(WMS_SCHEMA, ORDERS);
    const productionDump = dump(WMS_SCHEMA, ORDERS, ORDERS_INDEX);
    const copies = { repositoryDump: `${repositoryDump}`, productionDump: `${productionDump}` };

    compareStructureDumps(copies);

    expect(copies).toEqual({ repositoryDump, productionDump });
  });
});

describe("countDifferencesBySchema", () => {
  it("counts per schema and marks the schemas another application owns", () => {
    expect(countDifferencesBySchema([
      difference({ schema: "wms" }),
      difference({ schema: "membership" }),
      difference({ schema: "wms", name: "items" }),
    ])).toEqual([
      { schema: "membership", count: 1, ownedByAnotherApplication: true },
      { schema: "wms", count: 2, ownedByAnotherApplication: false },
    ]);
  });

  it("returns nothing for no differences", () => {
    expect(countDifferencesBySchema([])).toEqual([]);
  });
});

describe("formatDriftAlert", () => {
  it("names the objects, counts per schema, and says an Echelon difference needs investigating", () => {
    const text = formatDriftAlert({
      differences: [
        difference({ schema: "membership", name: "plans", kind: DRIFT_KINDS.onlyInProduction }),
        difference(),
      ],
      runUrl: "https://example.invalid/run/1",
    });

    expect(text).toContain("differs from the Echelon repository (2 object(s))");
    expect(text).toContain("- membership: 1 (owned by another application)");
    expect(text).toContain("- wms: 1\n");
    expect(text).toContain("- membership TABLE plans: only in production");
    expect(text).toContain("- wms TABLE orders: differs");
    expect(text).toContain("Investigate before regenerating the baseline.");
    expect(text).toContain("Full comparison: https://example.invalid/run/1");
  });

  it("says to regenerate the baseline when every difference belongs to another application", () => {
    const text = formatDriftAlert({ differences: [difference({ schema: "membership", kind: DRIFT_KINDS.onlyInRepository })] });

    expect(text).toContain("- membership TABLE orders: missing in production");
    expect(text).toContain("Regenerate the baseline");
    expect(text).not.toContain("Investigate");
    expect(text).not.toContain("Full comparison");
  });

  it("lists a limited number of objects and counts the rest", () => {
    const differences = Array.from({ length: DRIFT_ALERT_MAX_LISTED_OBJECTS + 4 }, (_unused, index) =>
      difference({ name: `table_${String(index).padStart(2, "0")}` }));

    const text = formatDriftAlert({ differences });

    expect(text).toContain(`table_${DRIFT_ALERT_MAX_LISTED_OBJECTS - 1}`);
    expect(text).not.toContain(`table_${DRIFT_ALERT_MAX_LISTED_OBJECTS}:`);
    expect(text).toContain("...and 4 more.");
  });

  it("never exceeds the message limit", () => {
    const differences = Array.from({ length: 40 }, (_unused, index) =>
      difference({ schema: `schema_${index}`, name: "n".repeat(300) }));

    expect(formatDriftAlert({ differences }).length).toBeLessThanOrEqual(DRIFT_ALERT_MAX_CHARACTERS);
  });

  it("refuses to build a drift alert without differences", () => {
    expect(() => formatDriftAlert({ differences: [] }))
      .toThrowError(expect.objectContaining({ code: "SCHEMA_DRIFT_ALERT_WITHOUT_DIFFERENCES" }));
  });
});

describe("formatCheckFailureAlert", () => {
  it("says drift is not being checked and carries the error code", () => {
    const text = formatCheckFailureAlert({
      code: "SCHEMA_DRIFT_PRODUCTION_DUMP_FAILED", message: "pg_dump exited with 1", runUrl: "https://example.invalid/run/2",
    });

    expect(text).toContain("could not run, so drift is NOT being checked");
    expect(text).toContain("SCHEMA_DRIFT_PRODUCTION_DUMP_FAILED: pg_dump exited with 1");
    expect(text).toContain("Run: https://example.invalid/run/2");
  });

  it("never exceeds the message limit", () => {
    const text = formatCheckFailureAlert({ code: "X", message: "m".repeat(5_000) });

    expect(text.length).toBeLessThanOrEqual(DRIFT_ALERT_MAX_CHARACTERS);
  });
});
