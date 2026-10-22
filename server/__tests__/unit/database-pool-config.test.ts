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

  it("configures every pool before checkout without an async connect hook", () => {
    // Three pools, each built from createDatabasePoolConfig so each sends the
    // search_path in its startup packet: the shared pool, the side-channel pool
    // (createSideChannelPool, the dropship process heartbeat's own connection,
    // step 1 PR A verify V5) and the startup-migrations pool. The second count
    // pins that no pool is constructed without that config.
    expect(DATABASE_BOOT_SOURCE.match(/createDatabasePoolConfig\(\{/g)).toHaveLength(3);
    expect(DATABASE_BOOT_SOURCE.match(/new Pool\(/g)).toHaveLength(3);
    expect(DATABASE_BOOT_SOURCE).not.toMatch(/pool\.on\(["']connect["']/);
    expect(DATABASE_BOOT_SOURCE).not.toMatch(/client\.query\([^)]*SET search_path/i);
  });

  it("bounds the side-channel pool and keeps the shared search_path", async () => {
    const { createSideChannelPool } = await import("../../db");
    const pool = createSideChannelPool({
      max: 1,
      statementTimeoutMs: 5_000,
      queryTimeoutMs: 8_000,
      connectionTimeoutMs: 5_000,
      idleTimeoutMs: 60_000,
    });

    try {
      expect(pool.options.options).toBe(DATABASE_SESSION_OPTIONS);
      expect(pool.options).toMatchObject({
        statement_timeout: 5_000,
        query_timeout: 8_000,
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 60_000,
        keepAlive: true,
      });
      const client = new pool.Client(pool.options);
      expect(client.connectionParameters.options).toBe(DATABASE_SESSION_OPTIONS);
      expect(client.connectionParameters.statement_timeout).toBe(5_000);
    } finally {
      await pool.end();
    }
  });
});
