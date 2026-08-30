import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/0624_catalog_variant_fulfillment_identity.sql"),
  "utf8",
).replace(/\s+/g, " ").toLowerCase();

describe("catalog variant fulfillment identity migration", () => {
  it("adds a non-null shipping identity with a backward-compatible physical default", () => {
    expect(migration).toContain(
      "add column if not exists requires_shipping boolean not null default true",
    );
  });

  it("prevents digital variants from being inventory tracked", () => {
    expect(migration).toContain(
      "check (requires_shipping = true or track_inventory is false)",
    );
  });
});
