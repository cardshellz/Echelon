import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATION = readFileSync(
  resolve(
    process.cwd(),
    "migrations/900000012000018360001_inventory_transaction_reference_length.sql",
  ),
  "utf8",
);

const SCHEMA = readFileSync(
  resolve(process.cwd(), "shared/schema/inventory.schema.ts"),
  "utf8",
);

describe("inventory transaction reference capacity", () => {
  it("fits canonical picker-observation references in both schema and migration", () => {
    const postgresIntegerMax = 2_147_483_647;
    const observationHash = "f".repeat(64);
    const reference =
      `claim:${postgresIntegerMax}:resource:${postgresIntegerMax}:` +
      `observation:${observationHash}:reserved-to-lot:${postgresIntegerMax}`;

    expect(reference.length).toBeGreaterThan(100);
    expect(reference.length).toBeLessThanOrEqual(500);
    expect(SCHEMA).toMatch(/referenceId:\s*varchar\("reference_id",\s*\{\s*length:\s*500\s*\}\)/);
    expect(MIGRATION).toMatch(
      /ALTER\s+COLUMN\s+reference_id\s+TYPE\s+varchar\(500\)/i,
    );
  });
});
