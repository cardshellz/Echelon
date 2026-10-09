import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { config } from "dotenv";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
  DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
  type ReplaceDropshipStoreListingConfigRepositoryInput,
  type ReplaceDropshipStoreListingConfigRepositoryResult,
} from "../../application/dropship-listing-config-service";
import { DropshipError } from "../../domain/errors";
import {
  PgDropshipListingConfigRepository,
  ensureDefaultListingConfigWithClient,
} from "../../infrastructure/dropship-listing-config.repository";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));
config({ path: resolve(process.cwd(), ".env.test") });
const testUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = testUrl && disposable ? describe : describe.skip;
const NOW = new Date("2026-10-08T12:00:00.000Z");
const MIGRATION = "0728_dropship_listing_config_revision.sql";

/** Every object the migration, the fixture and the repository name; each maps into one isolated schema. */
const OBJECTS: ReadonlySet<string> = new Set([
  "dropship.dropship_vendors",
  "dropship.dropship_store_connections",
  "dropship.dropship_store_listing_configs",
  "dropship.dropship_audit_events",
  "dropship.dropship_listing_config_requests",
  "dropship.dropship_store_listing_config_revision",
  "dropship.dropship_listing_config_requests_guard",
]);

const STORE = 22;
const PAUSED_STORE = 24;
const VENDOR = 10;

const POLICIES = {
  fulfillmentPolicyId: "ship-a",
  returnPolicyId: "return-a",
  paymentPolicyId: "pay-a",
};

/**
 * Upper bound on every wait in the concurrency tests. PostgreSQL reports a
 * deadlock after deadlock_timeout (1 s by default) as SQLSTATE 40P01; a wait
 * that never ends (a lost wake-up, a lock held by the test itself) fails here
 * instead of hanging the suite.
 */
const WAIT_LIMIT_MS = 5_000;
const POLL_INTERVAL_MS = 10;
const DEADLOCK_DETECTED = "40P01";

type ReplaceSettled = PromiseSettledResult<ReplaceDropshipStoreListingConfigRepositoryResult>;

/**
 * The tables 0728 runs on, as earlier migrations made them: 0094 (store
 * listing configs), 0086 (audit events; the foreign keys matter, since the
 * audit insert takes a key-share lock on the vendor and store rows) and 0657
 * (the store's owner identity index the ledger's owner key references).
 */
const PRE_0728_TABLES = `
  CREATE TABLE dropship.dropship_vendors (id integer PRIMARY KEY);
  CREATE TABLE dropship.dropship_store_connections (id integer PRIMARY KEY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id),
    platform varchar(30) NOT NULL, status varchar(30) NOT NULL, setup_status varchar(30) NOT NULL DEFAULT 'ready');
  CREATE UNIQUE INDEX dropship_store_conn_owner_identity_idx ON dropship.dropship_store_connections (id, vendor_id);
  CREATE TABLE dropship.dropship_store_listing_configs (
    id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    store_connection_id integer NOT NULL REFERENCES dropship.dropship_store_connections(id) ON DELETE CASCADE,
    platform varchar(30) NOT NULL, listing_mode varchar(40) NOT NULL,
    inventory_mode varchar(40) NOT NULL DEFAULT 'managed_quantity_sync',
    price_mode varchar(40) NOT NULL DEFAULT 'vendor_defined',
    marketplace_config jsonb NOT NULL DEFAULT '{}'::jsonb,
    required_config_keys jsonb NOT NULL DEFAULT '[]'::jsonb,
    required_product_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  CREATE UNIQUE INDEX listing_config_store_idx ON dropship.dropship_store_listing_configs(store_connection_id);
  CREATE TABLE dropship.dropship_audit_events (id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    vendor_id integer REFERENCES dropship.dropship_vendors(id) ON DELETE SET NULL,
    store_connection_id integer REFERENCES dropship.dropship_store_connections(id) ON DELETE SET NULL,
    entity_type varchar(80) NOT NULL, entity_id varchar(255),
    event_type varchar(120) NOT NULL, actor_type varchar(40) NOT NULL, actor_id varchar(255),
    severity varchar(20) NOT NULL, payload jsonb, created_at timestamptz NOT NULL DEFAULT now());
`;

describeDatabase.sequential("listing config revision (migration 0728) on PostgreSQL", () => {
  const schema = `dropship_listing_config_revision_${process.pid}`;
  let pool: pg.Pool;
  let created = false;
  const migrationSql = () => readFileSync(resolve(process.cwd(), "migrations", MIGRATION), "utf8");
  /** Maps every `dropship.<object>` the SQL names into `target`, refusing any object not listed. */
  const qualifyIn = (target: string) => (sql: string) => sql.replace(/\bdropship\.([a-z_]+)\b/g, (name, object) => {
    if (!OBJECTS.has(name)) throw new Error(`Unexpected database object: ${name}`);
    return `"${target}"."${object}"`;
  });
  const qualify = qualifyIn(schema);
  const execute = (sql: string, values?: unknown[]) => pool.query(qualify(sql), values);

  /** The repository's own SQL against the isolated schema. */
  function scopedPool(): Pool {
    return {
      query: (sql: string, values?: unknown[]) => pool.query(qualify(sql), values),
      connect: async () => {
        const client = await pool.connect();
        return {
          query: (sql: string, values?: unknown[]) => client.query(qualify(sql), values),
          release: (destroy?: boolean | Error) => client.release(destroy),
        };
      },
    } as unknown as Pool;
  }

  const repository = () => new PgDropshipListingConfigRepository(scopedPool());

  function replaceInput(
    overrides: Partial<ReplaceDropshipStoreListingConfigRepositoryInput> = {},
  ): ReplaceDropshipStoreListingConfigRepositoryInput {
    return {
      vendorId: VENDOR,
      storeConnectionId: STORE,
      platform: "ebay",
      config: {
        listingMode: "live",
        inventoryMode: "managed_quantity_sync",
        priceMode: "vendor_defined",
        marketplaceConfig: {
          marketplaceId: "EBAY_US",
          merchantLocationKey: "cardshellz-dropship-wh-3",
          businessPolicies: { ...POLICIES, returnPolicyId: "return-b" },
          businessPolicyNames: { returnPolicyName: "30 days free" },
        },
        requiredConfigKeys: ["marketplaceId"],
        requiredProductFields: ["sku"],
        isActive: true,
      },
      expectedRevision: 1,
      allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_VENDOR_SETUP_WRITE_STATUSES,
      request: {
        operation: "ebay_listing_setup_save",
        idempotencyKey: "ebay-setup:first-save",
        requestHash: "a".repeat(64),
      },
      auditEventType: "listing_config_replaced",
      actor: { actorType: "vendor", actorId: "member-1" },
      now: NOW,
      ...overrides,
    };
  }

  async function storedConfig(storeConnectionId = STORE) {
    const result = await execute(
      `SELECT revision, marketplace_config, listing_mode FROM dropship.dropship_store_listing_configs WHERE store_connection_id = $1`,
      [storeConnectionId],
    );
    return result.rows[0] as { revision: number; marketplace_config: Record<string, unknown>; listing_mode: string };
  }

  async function auditRows() {
    const result = await execute(
      `SELECT event_type, actor_type, actor_id, payload FROM dropship.dropship_audit_events ORDER BY id`,
    );
    return result.rows as Array<{ event_type: string; actor_type: string; actor_id: string | null; payload: Record<string, unknown> }>;
  }

  async function ledgerRows() {
    const result = await execute(
      `SELECT operation, idempotency_key, revision_before, revision_after, outcome, actor_type
       FROM dropship.dropship_listing_config_requests ORDER BY id`,
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  async function expectDropshipError(promise: Promise<unknown>, code: string): Promise<DropshipError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(DropshipError);
      expect((error as DropshipError).code).toBe(code);
      return error as DropshipError;
    }
    throw new Error(`Expected ${code}`);
  }

  /** Resolves or rejects with `promise`, or rejects once WAIT_LIMIT_MS passes. */
  async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`${label} did not finish within ${WAIT_LIMIT_MS} ms`)), WAIT_LIMIT_MS);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Polls until `count` other backends of this database wait on a lock that
   * `holderPid` holds, and returns the statements they wait in.
   */
  async function waitUntilBlockedBy(holderPid: number, count: number): Promise<string[]> {
    const deadline = Date.now() + WAIT_LIMIT_MS;
    for (;;) {
      const result = await pool.query<{ query: string }>(
        `SELECT query FROM pg_stat_activity
         WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))`,
        [holderPid],
      );
      if (result.rows.length >= count) return result.rows.map((row) => row.query);
      if (Date.now() > deadline) {
        throw new Error(`Expected ${count} backend(s) waiting on backend ${holderPid}; saw ${result.rows.length}`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  /**
   * A second connection standing in for another writer: it holds its locks
   * until commit. lock_timeout is SET LOCAL so the setting ends with the
   * transaction and never leaks into the pooled connection.
   */
  async function otherWriter(qualifier: (sql: string) => string = qualify) {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    let open = false;
    return {
      pid,
      async begin() {
        await client.query("BEGIN");
        open = true;
        await client.query(`SET LOCAL lock_timeout = '${WAIT_LIMIT_MS}ms'`);
      },
      query: (sql: string, values?: unknown[]) => client.query(qualifier(sql), values),
      async commit() {
        await client.query("COMMIT");
        open = false;
      },
      /** Rolls back whatever is still open, so a failed test leaves no lock behind. */
      async end() {
        try {
          if (open) await client.query("ROLLBACK");
          client.release();
        } catch (error) {
          client.release(error as Error);
          throw error;
        }
      },
    };
  }

  function rejectionCodes(results: ReadonlyArray<PromiseSettledResult<unknown>>): unknown[] {
    return results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason as { code?: unknown } | null)?.code);
  }

  function keyedInput(
    idempotencyKey: string,
    requestHash: string,
    overrides: Partial<ReplaceDropshipStoreListingConfigRepositoryInput> = {},
  ): ReplaceDropshipStoreListingConfigRepositoryInput {
    return replaceInput({
      request: { operation: "ebay_listing_setup_save", idempotencyKey, requestHash },
      ...overrides,
    });
  }

  /** The listing config as stored, as a save input: saving it changes nothing. */
  function configAsStored(stored: { marketplace_config: Record<string, unknown> }) {
    return {
      listingMode: "live" as const,
      inventoryMode: "managed_quantity_sync" as const,
      priceMode: "vendor_defined" as const,
      marketplaceConfig: stored.marketplace_config,
      requiredConfigKeys: [],
      requiredProductFields: [],
      isActive: true,
    };
  }

  type LedgerColumns = {
    vendor_id: number | null;
    store_connection_id: number | null;
    actor_id: string | null;
    revision_before: number;
    revision_after: number;
    outcome: string;
  };

  /** A ledger row written straight to the table, valid unless `overrides` break it. */
  function insertLedgerRow(idempotencyKey: string, overrides: Partial<LedgerColumns> = {}) {
    const row: LedgerColumns = {
      vendor_id: VENDOR,
      store_connection_id: STORE,
      actor_id: "member-1",
      revision_before: 1,
      revision_after: 2,
      outcome: "changed",
      ...overrides,
    };
    return execute(
      `INSERT INTO dropship.dropship_listing_config_requests
        (vendor_id, store_connection_id, operation, idempotency_key, request_hash, actor_type, actor_id,
         revision_before, revision_after, outcome, created_at)
       VALUES ($1, $2, 'ebay_listing_setup_save', $3, $4, 'vendor', $5, $6, $7, $8, $9)`,
      [
        row.vendor_id,
        row.store_connection_id,
        idempotencyKey,
        "f".repeat(64),
        row.actor_id,
        row.revision_before,
        row.revision_after,
        row.outcome,
        NOW,
      ],
    );
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl, max: 6 });
    await pool.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    // 0728 runs on top of the tables as they were, twice, to prove it can be
    // re-applied.
    await execute(PRE_0728_TABLES);
    await execute(migrationSql());
    await execute(migrationSql());
  });

  afterAll(async () => {
    if (created) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool?.end();
  });

  beforeEach(async () => {
    // The ledger refuses DELETE by trigger; TRUNCATE is the test's reset, not
    // a code path (no application code truncates).
    await execute(`TRUNCATE dropship.dropship_listing_config_requests, dropship.dropship_audit_events,
      dropship.dropship_store_listing_configs, dropship.dropship_store_connections, dropship.dropship_vendors
      RESTART IDENTITY CASCADE`);
    await execute(`
      INSERT INTO dropship.dropship_vendors (id) VALUES (10), (11);
      INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status)
        VALUES (22, 10, 'ebay', 'connected'), (24, 10, 'ebay', 'paused'), (23, 11, 'ebay', 'connected');
      INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, marketplace_config)
        VALUES (22, 'ebay', 'live', '{"marketplaceId":"EBAY_US","merchantLocationKey":"cardshellz-dropship-wh-3",
          "businessPolicies":{"fulfillmentPolicyId":"ship-a","returnPolicyId":"return-a","paymentPolicyId":"pay-a"}}'),
               (24, 'ebay', 'live', '{}');
    `);
  });

  it("starts every config at revision 1 and ignores a revision the writer sends", async () => {
    await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status) VALUES (30, 10, 'ebay', 'connected')`);
    await execute(`INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, revision)
      VALUES (30, 'ebay', 'live', 99)`);
    expect((await storedConfig(30)).revision).toBe(1);
  });

  it("adds 1 only when the config changes, whoever writes it", async () => {
    await execute(`UPDATE dropship.dropship_store_listing_configs SET updated_at = now() + interval '1 hour' WHERE store_connection_id = 22`);
    expect((await storedConfig()).revision).toBe(1);
    // A writer deployed before 0728 (the old upsert) and a forged revision.
    await execute(`UPDATE dropship.dropship_store_listing_configs
      SET marketplace_config = jsonb_set(marketplace_config, '{businessPolicies,returnPolicyId}', '"return-z"'), revision = 50
      WHERE store_connection_id = 22`);
    expect((await storedConfig()).revision).toBe(2);
    await execute(`INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode)
      VALUES (22, 'ebay', 'draft_first')
      ON CONFLICT (store_connection_id) DO UPDATE SET listing_mode = EXCLUDED.listing_mode`);
    expect((await storedConfig()).revision).toBe(3);
    await execute(`INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode)
      VALUES (22, 'ebay', 'draft_first')
      ON CONFLICT (store_connection_id) DO UPDATE SET listing_mode = EXCLUDED.listing_mode`);
    expect((await storedConfig()).revision).toBe(3);
  });

  it("saves against the expected revision, audits before and after, and records the key", async () => {
    const result = await repository().replaceConfig(replaceInput());

    expect(result.outcome).toBe("changed");
    expect(result.revisionBefore).toBe(1);
    expect(result.revisionAfter).toBe(2);
    expect(result.config.revision).toBe(2);
    expect((await storedConfig()).marketplace_config).toMatchObject({
      businessPolicies: { returnPolicyId: "return-b" },
      businessPolicyNames: { returnPolicyName: "30 days free" },
    });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ event_type: "listing_config_replaced", actor_type: "vendor", actor_id: "member-1" });
    expect(audits[0].payload).toMatchObject({
      requestKey: "ebay-setup:first-save",
      revisionBefore: 1,
      revisionAfter: 2,
      changedFields: [
        "marketplaceConfig.businessPolicies.returnPolicyId",
        "marketplaceConfig.businessPolicyNames",
        "requiredConfigKeys",
        "requiredProductFields",
      ],
      before: { marketplaceConfig: { businessPolicies: POLICIES } },
      after: { marketplaceConfig: { businessPolicies: { returnPolicyId: "return-b" } } },
    });
    expect(await ledgerRows()).toEqual([{
      operation: "ebay_listing_setup_save",
      idempotency_key: "ebay-setup:first-save",
      revision_before: 1,
      revision_after: 2,
      outcome: "changed",
      actor_type: "vendor",
    }]);
  });

  it("refuses a save made against an older revision and writes nothing", async () => {
    await repository().replaceConfig(replaceInput());
    const error = await expectDropshipError(
      repository().replaceConfig(replaceInput({
        request: { operation: "ebay_listing_setup_save", idempotencyKey: "ebay-setup:second-save", requestHash: "b".repeat(64) },
      })),
      "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
    );
    expect(error.context).toMatchObject({ expectedRevision: 1, currentRevision: 2 });
    expect((await storedConfig()).revision).toBe(2);
    expect(await auditRows()).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("answers a retried key from its first save without writing again", async () => {
    await repository().replaceConfig(replaceInput());
    const replay = await repository().replaceConfig(replaceInput());

    expect(replay.outcome).toBe("replayed");
    expect(replay.revisionBefore).toBe(1);
    expect(replay.revisionAfter).toBe(2);
    expect(replay.config.revision).toBe(2);
    expect(await auditRows()).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("refuses the same key with a different request", async () => {
    await repository().replaceConfig(replaceInput());
    await expectDropshipError(
      repository().replaceConfig(replaceInput({
        expectedRevision: 2,
        request: { operation: "ebay_listing_setup_save", idempotencyKey: "ebay-setup:first-save", requestHash: "c".repeat(64) },
      })),
      "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
    );
    expect((await storedConfig()).revision).toBe(2);
  });

  it("refuses a vendor's key reused for another of their stores", async () => {
    await repository().replaceConfig(replaceInput());
    await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status) VALUES (31, 10, 'ebay', 'connected')`);
    await execute(`INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode) VALUES (31, 'ebay', 'live')`);
    await expectDropshipError(
      repository().replaceConfig(replaceInput({ storeConnectionId: 31 })),
      "DROPSHIP_LISTING_CONFIG_IDEMPOTENCY_CONFLICT",
    );
    expect((await storedConfig(31)).revision).toBe(1);
  });

  it("records an unchanged save without an audit row or a new revision", async () => {
    const result = await repository().replaceConfig(replaceInput({ config: configAsStored(await storedConfig()) }));
    expect(result).toMatchObject({ outcome: "unchanged", revisionBefore: 1, revisionAfter: 1, config: { revision: 1 } });
    expect(await auditRows()).toHaveLength(0);
    expect(await ledgerRows()).toEqual([expect.objectContaining({ outcome: "unchanged", revision_before: 1, revision_after: 1 })]);
  });

  it("re-checks the store status under its lock and refuses a paused store", async () => {
    await expectDropshipError(
      repository().replaceConfig(replaceInput({ storeConnectionId: PAUSED_STORE })),
      "DROPSHIP_LISTING_CONFIG_STORE_PAUSED",
    );
    expect((await storedConfig(PAUSED_STORE)).revision).toBe(1);
    expect(await auditRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("lets staff save on a paused store, without a request key", async () => {
    const result = await repository().replaceConfig(replaceInput({
      storeConnectionId: PAUSED_STORE,
      allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
      request: null,
      actor: { actorType: "admin", actorId: "staff-1" },
    }));
    expect(result).toMatchObject({ outcome: "changed", revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } });
    expect(await ledgerRows()).toHaveLength(0);
    expect((await auditRows())[0]).toMatchObject({ actor_type: "admin", actor_id: "staff-1" });
  });

  it("refuses a store of another vendor", async () => {
    await expectDropshipError(
      repository().replaceConfig(replaceInput({ storeConnectionId: 23 })),
      "DROPSHIP_STORE_CONNECTION_NOT_FOUND",
    );
  });

  it("lets exactly one of two concurrent saves from the same revision win", async () => {
    const results = await Promise.allSettled([
      repository().replaceConfig(replaceInput({
        request: { operation: "ebay_listing_setup_save", idempotencyKey: "ebay-setup:racer-one", requestHash: "d".repeat(64) },
      })),
      repository().replaceConfig(replaceInput({
        config: { ...replaceInput().config, listingMode: "draft_first" },
        request: { operation: "ebay_listing_setup_save", idempotencyKey: "ebay-setup:racer-two", requestHash: "e".repeat(64) },
      })),
    ]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0].reason as DropshipError).code).toBe("DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT");
    expect((await storedConfig()).revision).toBe(2);
    expect(await auditRows()).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("keeps the request ledger append-only", async () => {
    await repository().replaceConfig(replaceInput());
    await expect(execute(`UPDATE dropship.dropship_listing_config_requests SET outcome = 'unchanged'`))
      .rejects.toThrow(/append-only/);
    await expect(execute(`DELETE FROM dropship.dropship_listing_config_requests`))
      .rejects.toThrow(/append-only/);
  });

  it("refuses a ledger row whose revisions do not match its outcome", async () => {
    await expect(insertLedgerRow("ebay-setup:skip", { revision_before: 1, revision_after: 3, outcome: "changed" }))
      .rejects.toMatchObject({ code: "23514", constraint: "dropship_listing_config_requests_outcome_chk" });
    await expect(insertLedgerRow("ebay-setup:same", { revision_before: 2, revision_after: 2, outcome: "changed" }))
      .rejects.toMatchObject({ code: "23514", constraint: "dropship_listing_config_requests_outcome_chk" });
    await expect(insertLedgerRow("ebay-setup:moved", { revision_before: 2, revision_after: 3, outcome: "unchanged" }))
      .rejects.toMatchObject({ code: "23514", constraint: "dropship_listing_config_requests_outcome_chk" });
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("refuses a ledger row for a store the vendor does not own", async () => {
    // Store 23 and vendor 10 each exist; the pair does not (store 23 is vendor 11's).
    await expect(insertLedgerRow("ebay-setup:not-mine", { vendor_id: VENDOR, store_connection_id: 23 }))
      .rejects.toMatchObject({ code: "23503", constraint: "dropship_listing_config_requests_owner_fk" });
    await expect(insertLedgerRow("ebay-setup:no-store", { vendor_id: VENDOR, store_connection_id: 99 }))
      .rejects.toMatchObject({ code: "23503", constraint: "dropship_listing_config_requests_owner_fk" });
    expect(await ledgerRows()).toHaveLength(0);

    // The same row for a store the vendor owns is accepted.
    await insertLedgerRow("ebay-setup:mine", { vendor_id: VENDOR, store_connection_id: STORE });
    await insertLedgerRow("ebay-setup:theirs", { vendor_id: 11, store_connection_id: 23 });
    expect(await ledgerRows()).toHaveLength(2);
  });

  it("refuses a ledger row that does not name who made the request", async () => {
    await expect(insertLedgerRow("ebay-setup:no-actor", { actor_id: null }))
      .rejects.toMatchObject({ code: "23502", column: "actor_id" });
    await expect(insertLedgerRow("ebay-setup:empty-actor", { actor_id: "" }))
      .rejects.toMatchObject({ code: "23514", constraint: "dropship_listing_config_requests_actor_id_chk" });
    await expect(insertLedgerRow("ebay-setup:blank-actor", { actor_id: "   " }))
      .rejects.toMatchObject({ code: "23514", constraint: "dropship_listing_config_requests_actor_id_chk" });
    expect(await ledgerRows()).toHaveLength(0);
  });

  it.each([
    { label: "no actor id", actorId: null },
    { label: "an empty actor id", actorId: "" },
    { label: "a blank actor id", actorId: "   " },
  ])("refuses a keyed save with $label before it connects, and writes nothing", async ({ actorId }) => {
    const before = await storedConfig();
    let connects = 0;
    const scoped = scopedPool();
    const counting = {
      query: scoped.query.bind(scoped),
      connect: () => {
        connects += 1;
        return scoped.connect();
      },
    } as unknown as Pool;

    const error = await expectDropshipError(
      new PgDropshipListingConfigRepository(counting).replaceConfig(replaceInput({
        actor: { actorType: "vendor", actorId },
      })),
      "DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED",
    );

    expect(error.context).toMatchObject({ storeConnectionId: STORE, actorType: "vendor", retryable: false });
    expect(connects).toBe(0);
    expect(await storedConfig()).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("still lets an unkeyed save without an actor id through: it records no ledger row", async () => {
    const result = await repository().replaceConfig(replaceInput({
      allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
      request: null,
      actor: { actorType: "system", actorId: null },
    }));

    expect(result).toMatchObject({ outcome: "changed", revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } });
    expect(await auditRows()).toEqual([expect.objectContaining({ actor_type: "system", actor_id: null })]);
    expect(await ledgerRows()).toHaveLength(0);
  });

  it("reads a missing config as null without creating one, and creates the default at revision 1", async () => {
    await execute(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status) VALUES (32, 10, 'ebay', 'connected')`);
    expect(await repository().findConfig({ storeConnectionId: 32 })).toBeNull();
    expect((await execute(`SELECT count(*)::int AS n FROM dropship.dropship_store_listing_configs WHERE store_connection_id = 32`)).rows[0].n).toBe(0);

    const client = await scopedPool().connect();
    try {
      await client.query("BEGIN");
      const created = await ensureDefaultListingConfigWithClient(client, {
        vendorId: VENDOR,
        storeConnectionId: 32,
        platform: "ebay",
        actor: { actorType: "vendor", actorId: "member-1" },
        now: NOW,
      });
      await client.query("COMMIT");
      expect(created.revision).toBe(1);
    } finally {
      client.release();
    }
    expect((await repository().findConfig({ storeConnectionId: 32 }))?.revision).toBe(1);
  });

  it("answers a retried key from its first save even after the store was paused", async () => {
    await repository().replaceConfig(replaceInput());
    await execute(`UPDATE dropship.dropship_store_connections SET status = 'paused' WHERE id = $1`, [STORE]);

    const replay = await repository().replaceConfig(replaceInput());

    expect(replay).toMatchObject({ outcome: "replayed", revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } });
    expect(await auditRows()).toHaveLength(1);
    expect(await ledgerRows()).toHaveLength(1);
  });

  it("answers a retried key with the config as it is now, after a later save moved the revision on", async () => {
    await repository().replaceConfig(replaceInput());
    const later = await repository().replaceConfig(keyedInput("ebay-setup:later-save", "b".repeat(64), {
      expectedRevision: 2,
      config: { ...replaceInput().config, listingMode: "draft_first" },
    }));
    expect(later).toMatchObject({ outcome: "changed", revisionBefore: 2, revisionAfter: 3, config: { revision: 3 } });

    const replay = await repository().replaceConfig(replaceInput());

    // The revisions are the first save's, from the ledger; the config is the
    // later save's, so revisionAfter (2) is older than config.revision (3).
    expect(replay).toMatchObject({
      outcome: "replayed",
      revisionBefore: 1,
      revisionAfter: 2,
      config: { revision: 3, listingMode: "draft_first" },
    });
    expect((await storedConfig()).revision).toBe(3);
    expect(await auditRows()).toHaveLength(2);
    expect(await ledgerRows()).toEqual([
      expect.objectContaining({ idempotency_key: "ebay-setup:first-save", revision_before: 1, revision_after: 2 }),
      expect.objectContaining({ idempotency_key: "ebay-setup:later-save", revision_before: 2, revision_after: 3 }),
    ]);
  });

  it("answers a retried unchanged save with the revisions it recorded, after a staff save moved the config on", async () => {
    const asStored = configAsStored(await storedConfig());
    const first = await repository().replaceConfig(replaceInput({ config: asStored }));
    expect(first).toMatchObject({ outcome: "unchanged", revisionBefore: 1, revisionAfter: 1 });
    await repository().replaceConfig(replaceInput({
      config: { ...asStored, listingMode: "draft_first" },
      allowedStoreStatuses: DROPSHIP_LISTING_CONFIG_STAFF_WRITE_STATUSES,
      request: null,
      actor: { actorType: "admin", actorId: "staff-1" },
    }));

    const replay = await repository().replaceConfig(replaceInput({ config: asStored }));

    expect(replay).toMatchObject({
      outcome: "replayed",
      revisionBefore: 1,
      revisionAfter: 1,
      config: { revision: 2, listingMode: "draft_first" },
    });
    expect(await auditRows()).toEqual([expect.objectContaining({ actor_type: "admin", actor_id: "staff-1" })]);
    expect(await ledgerRows()).toEqual([
      expect.objectContaining({ outcome: "unchanged", revision_before: 1, revision_after: 1 }),
    ]);
  });

  it("waits behind a vendor row another writer locked FOR UPDATE and saves once it commits, without a deadlock", async () => {
    const writer = await otherWriter();
    let pending: Promise<ReplaceSettled[]> | undefined;
    try {
      await writer.begin();
      // What a vendor-status writer holds, and the first row order acceptance
      // locks (FOR UPDATE OF v, sc).
      await writer.query(`SELECT id FROM dropship.dropship_vendors WHERE id = $1 FOR UPDATE`, [VENDOR]);
      pending = Promise.allSettled([repository().replaceConfig(replaceInput())]);

      const waiting = await waitUntilBlockedBy(writer.pid, 1);
      expect(waiting).toHaveLength(1);
      expect(waiting[0]).toContain("FOR SHARE OF v, sc");
      // The writer goes on to lock the store row, as order acceptance does. The
      // save waits on the vendor row before it locks the store row, so this
      // lock is granted; were the store row locked first, this is the cycle.
      await within(
        writer.query(`SELECT id FROM dropship.dropship_store_connections WHERE id = $1 FOR UPDATE`, [STORE]),
        "the other writer's store row lock",
      );
      expect((await storedConfig()).revision).toBe(1);
      expect(await ledgerRows()).toHaveLength(0);
      await writer.commit();

      const [saved] = await within(pending, "the save after the other writer committed");
      expect(rejectionCodes([saved])).not.toContain(DEADLOCK_DETECTED);
      expect(saved).toMatchObject({
        status: "fulfilled",
        value: { outcome: "changed", revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } },
      });
      expect((await storedConfig()).revision).toBe(2);
      expect(await auditRows()).toHaveLength(1);
      expect(await ledgerRows()).toEqual([
        expect.objectContaining({ idempotency_key: "ebay-setup:first-save", outcome: "changed", revision_after: 2 }),
      ]);
    } finally {
      await writer.end();
      await pending;
    }
  });

  it("re-reads the store row after waiting for another writer and refuses the store that writer paused", async () => {
    const writer = await otherWriter();
    let pending: Promise<ReplaceSettled[]> | undefined;
    try {
      await writer.begin();
      await writer.query(`SELECT id FROM dropship.dropship_vendors WHERE id = $1 FOR UPDATE`, [VENDOR]);
      pending = Promise.allSettled([repository().replaceConfig(replaceInput())]);
      await waitUntilBlockedBy(writer.pid, 1);
      await within(
        writer.query(`UPDATE dropship.dropship_store_connections SET status = 'paused' WHERE id = $1`, [STORE]),
        "the other writer's store status change",
      );
      await writer.commit();

      const [saved] = await within(pending, "the save after the other writer committed");
      expect(rejectionCodes([saved])).toEqual(["DROPSHIP_LISTING_CONFIG_STORE_PAUSED"]);
      expect((saved as PromiseRejectedResult).reason).toBeInstanceOf(DropshipError);
      expect((await storedConfig()).revision).toBe(1);
      expect(await auditRows()).toHaveLength(0);
      expect(await ledgerRows()).toHaveLength(0);
    } finally {
      await writer.end();
      await pending;
    }
  });

  it("lets exactly one of two saves released together from one revision change it; the other is refused and records nothing", async () => {
    const gate = await otherWriter();
    const inputs = [
      keyedInput("ebay-setup:gate-one", "1".repeat(64)),
      keyedInput("ebay-setup:gate-two", "2".repeat(64), {
        config: { ...replaceInput().config, listingMode: "draft_first" },
      }),
    ];
    let racers: Promise<ReplaceSettled[]> | undefined;
    try {
      await gate.begin();
      // The first lock replaceConfig takes: holding it puts both calls in
      // flight, each with its own connection, before either can run.
      await gate.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [STORE]);
      racers = Promise.allSettled(inputs.map((input) => repository().replaceConfig(input)));
      expect(await waitUntilBlockedBy(gate.pid, 2)).toHaveLength(2);
      await gate.commit();

      const results = await within(racers, "both saves");
      expect(rejectionCodes(results)).not.toContain(DEADLOCK_DETECTED);
      const winners = inputs.filter((_, index) => results[index].status === "fulfilled");
      const refusals = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      expect(winners).toHaveLength(1);
      expect(refusals).toHaveLength(1);
      const winner = winners[0];
      expect(results[inputs.indexOf(winner)]).toMatchObject({
        status: "fulfilled",
        value: {
          outcome: "changed",
          revisionBefore: 1,
          revisionAfter: 2,
          config: { revision: 2, listingMode: winner.config.listingMode },
        },
      });
      expect(refusals[0]).toBeInstanceOf(DropshipError);
      expect(refusals[0]).toMatchObject({
        code: "DROPSHIP_LISTING_CONFIG_REVISION_CONFLICT",
        context: { expectedRevision: 1, currentRevision: 2 },
      });

      expect(await storedConfig()).toMatchObject({ revision: 2, listing_mode: winner.config.listingMode });
      const audits = await auditRows();
      expect(audits).toHaveLength(1);
      expect(audits[0].payload).toMatchObject({
        requestKey: winner.request?.idempotencyKey,
        revisionBefore: 1,
        revisionAfter: 2,
      });
      // The refused save throws before its ledger insert and rolls back, so
      // the ledger holds the winner's key only; the loser's key stays free.
      expect(await ledgerRows()).toEqual([{
        operation: "ebay_listing_setup_save",
        idempotency_key: winner.request?.idempotencyKey,
        revision_before: 1,
        revision_after: 2,
        outcome: "changed",
        actor_type: "vendor",
      }]);
    } finally {
      await gate.end();
      await racers;
    }
  });

  it("answers the second of two identical keyed saves released together as a replay and records the key once", async () => {
    const gate = await otherWriter();
    let racers: Promise<ReplaceSettled[]> | undefined;
    try {
      await gate.begin();
      await gate.query("SELECT pg_advisory_xact_lock(hashtext('dropship_listing_push_job'), $1::integer)", [STORE]);
      // A double-click: the same key and the same body, on two connections.
      racers = Promise.allSettled([
        repository().replaceConfig(keyedInput("ebay-setup:double-click", "3".repeat(64))),
        repository().replaceConfig(keyedInput("ebay-setup:double-click", "3".repeat(64))),
      ]);
      expect(await waitUntilBlockedBy(gate.pid, 2)).toHaveLength(2);
      await gate.commit();

      const results = await within(racers, "both saves");
      expect(rejectionCodes(results)).toEqual([]);
      const answers = results.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []));
      expect(answers.map((answer) => answer.outcome).sort()).toEqual(["changed", "replayed"]);
      for (const answer of answers) {
        expect(answer).toMatchObject({ revisionBefore: 1, revisionAfter: 2, config: { revision: 2 } });
      }
      expect(answers[0].config.marketplaceConfig).toEqual(answers[1].config.marketplaceConfig);

      expect((await storedConfig()).revision).toBe(2);
      expect(await auditRows()).toHaveLength(1);
      expect(await ledgerRows()).toEqual([
        expect.objectContaining({ idempotency_key: "ebay-setup:double-click", outcome: "changed", revision_before: 1, revision_after: 2 }),
      ]);
    } finally {
      await gate.end();
      await racers;
    }
  });

  it("applies behind a store connect in flight without a deadlock: it waits on the store table before it touches the listing configs", async () => {
    // A database 0728 has not run on yet, in a schema of its own.
    const fresh = `${schema}_fresh`;
    const qualifyFresh = qualifyIn(fresh);
    await pool.query(`CREATE SCHEMA "${fresh}"`);
    const connect = await otherWriter(qualifyFresh);
    const migrator = await otherWriter(qualifyFresh);
    let migrating: Promise<Array<PromiseSettledResult<unknown>>> | undefined;
    try {
      await pool.query(qualifyFresh(PRE_0728_TABLES));
      await pool.query(qualifyFresh(`INSERT INTO dropship.dropship_vendors (id) VALUES (10)`));

      // connectStore (an old dyno during the release): the store connection
      // write first, which holds the store table in ROW EXCLUSIVE until commit.
      await connect.begin();
      await connect.query(`INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status)
        VALUES (40, 10, 'ebay', 'connected')`);

      await migrator.begin();
      migrating = Promise.allSettled([migrator.query(migrationSql())]);
      await waitUntilBlockedBy(connect.pid, 1);

      // The ledger's owner key waits for the store table; nothing has locked
      // the listing configs yet.
      const locks = await pool.query<{ relname: string; mode: string; granted: boolean }>(
        `SELECT c.relname, l.mode, l.granted
         FROM pg_locks l
         JOIN pg_class c ON c.oid = l.relation
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE l.locktype = 'relation' AND l.pid = $1 AND n.nspname = $2`,
        [migrator.pid, fresh],
      );
      expect(locks.rows.filter((lock) => !lock.granted)).toEqual([
        { relname: "dropship_store_connections", mode: "ShareRowExclusiveLock", granted: false },
      ]);
      expect(locks.rows.map((lock) => lock.relname)).not.toContain("dropship_store_listing_configs");

      // connectStore goes on to the default listing config insert and its
      // audit row. Had the migration altered the listing configs first, this
      // insert would wait on it while it waits on the store table: a deadlock.
      await within(
        connect.query(`INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode)
          VALUES (40, 'ebay', 'live')`),
        "the store connect's default listing config insert",
      );
      await within(
        connect.query(`INSERT INTO dropship.dropship_audit_events
          (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity)
          VALUES (10, 40, 'dropship_store_listing_config', '40', 'listing_config_created', 'vendor', '10', 'info')`),
        "the store connect's audit insert",
      );
      await connect.commit();

      const [migrated] = await within(migrating, "the migration after the store connect committed");
      expect(rejectionCodes([migrated])).toEqual([]);
      expect(migrated.status).toBe("fulfilled");
      await migrator.commit();

      // The config the connect wrote while the migration waited is at revision 1.
      expect((await pool.query(qualifyFresh(
        `SELECT revision FROM dropship.dropship_store_listing_configs WHERE store_connection_id = 40`,
      ))).rows).toEqual([{ revision: 1 }]);
    } finally {
      await connect.end();
      await migrator.end();
      await migrating;
      await pool.query(`DROP SCHEMA IF EXISTS "${fresh}" CASCADE`);
    }
  });
});
