import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  DATABASE_SEARCH_PATH,
  DATABASE_SESSION_OPTIONS,
  createDatabasePoolConfig,
} from "../../database-pool-config";

const { Pool } = pg;
const DATABASE_BOOT_SOURCE = readFileSync(
  fileURLToPath(new URL("../../db.ts", import.meta.url)),
  "utf8",
);

describe("database pool startup configuration", () => {
  it("preserves the authoritative schema resolution order", () => {
    expect(DATABASE_SEARCH_PATH).toEqual([
      '"$user"',
      "public",
      "catalog",
      "channels",
      "ebay",
      "identity",
      "inventory",
      "notifications",
      "operations",
      "orders",
      "procurement",
      "warehouse",
      "oms",
      "membership",
      "wms",
      "dropship",
    ]);
    expect(DATABASE_SESSION_OPTIONS).toBe(
      '-c search_path="$user",public,catalog,channels,ebay,identity,inventory,notifications,operations,orders,procurement,warehouse,oms,membership,wms,dropship',
    );
  });

  it("passes search_path as a PostgreSQL startup option", async () => {
    const config = createDatabasePoolConfig({
      connectionString: "postgresql://user:password@localhost:5432/echelon_test",
      max: 0,
    });
    const pool = new Pool(config);

    try {
      expect(pool.options.options).toBe(DATABASE_SESSION_OPTIONS);
      const client = new pool.Client(pool.options);
      expect(client.connectionParameters.options).toBe(DATABASE_SESSION_OPTIONS);
    } finally {
      await pool.end();
    }
  });

  it("configures both pools before checkout without an async connect hook", () => {
    expect(DATABASE_BOOT_SOURCE.match(/createDatabasePoolConfig\(\{/g)).toHaveLength(2);
    expect(DATABASE_BOOT_SOURCE).not.toMatch(/pool\.on\(["']connect["']/);
    expect(DATABASE_BOOT_SOURCE).not.toMatch(/client\.query\([^)]*SET search_path/i);
  });
});
