import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { dropshipStoreListingConfigs } from "../../../../../shared/schema/dropship.schema";
import { dropshipListingConfigIdempotencyKeySchema } from "../../application/dropship-listing-config-dtos";
import type {
  DropshipListingConfigActor,
  DropshipListingConfigKeyedRequestRecord,
  DropshipListingConfigRequestOperation,
} from "../../application/dropship-listing-config-service";

const MIGRATION_FILE = "0728_dropship_listing_config_revision.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
const schemaSource = readFileSync(resolve(process.cwd(), "shared/schema/dropship.schema.ts"), "utf8");
/** The migration that created the listing config table; its column list is the table before 0728. */
const createTableSql = readFileSync(
  resolve(process.cwd(), "migrations/0094_dropship_listing_connection_config.sql"),
  "utf8",
);

const CONFIG_TABLE = "dropship.dropship_store_listing_configs";
const LEDGER_TABLE = "dropship.dropship_listing_config_requests";

/**
 * Columns whose change is not a change to what the config says (migration
 * 0728 header): identity, owner, timestamps, and the revision itself, which an
 * application may send but never decides.
 */
const NON_CONTENT_COLUMNS: ReadonlySet<string> = new Set([
  "id",
  "store_connection_id",
  "created_at",
  "updated_at",
  "revision",
]);

/** What the config says. Any change to one of these is a new revision. */
const CONTENT_COLUMNS = [
  "platform",
  "listing_mode",
  "inventory_mode",
  "price_mode",
  "marketplace_config",
  "required_config_keys",
  "required_product_fields",
  "is_active",
] as const;

// The ledger CHECKs list these values; the application types must not drift
// from them. Each tuple is checked both ways at compile time
// (`npm run check:tests`) and against the SQL at run time.
const LEDGER_OPERATIONS = ["ebay_listing_setup_save", "ebay_ship_from_repair"] as const;
const LEDGER_ACTOR_TYPES = ["vendor", "admin", "system"] as const;
const LEDGER_OUTCOMES = ["changed", "unchanged"] as const;
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const operationsMatchTheService: Exact<typeof LEDGER_OPERATIONS[number], DropshipListingConfigRequestOperation> = true;
const actorTypesMatchTheService: Exact<typeof LEDGER_ACTOR_TYPES[number], DropshipListingConfigActor["actorType"]> = true;
const outcomesMatchTheService: Exact<typeof LEDGER_OUTCOMES[number], DropshipListingConfigKeyedRequestRecord["outcome"]> = true;

describe("0728 dropship listing config revision migration", () => {
  it("is the only migration with its number", () => {
    const sameNumber = readdirSync(resolve(process.cwd(), "migrations"))
      .filter((file) => file.startsWith("0728_"));
    expect(sameNumber).toEqual([MIGRATION_FILE]);
  });

  it("leaves the transaction to the release executor: no BEGIN, COMMIT or ROLLBACK of its own", () => {
    // BEGIN inside a plpgsql body opens a block, not a transaction; statements() collapses the bodies.
    for (const statement of statements()) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END|SAVEPOINT)\b/i);
    }
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
  });

  describe("lock order", () => {
    const ledger = () => createTableBody(migrationSql, LEDGER_TABLE);
    const touchesConfigTable = (statement: string) => /\bdropship\.dropship_store_listing_configs\b/.test(statement);
    const touchesLedger = (statement: string) => /\bdropship\.dropship_listing_config_requests\b/.test(statement)
      || statement.includes("dropship.dropship_listing_config_requests_guard()");

    it("creates the ledger, its indexes and its guard before any statement touches the listing configs", () => {
      const all = statements();
      const firstConfigStatement = all.findIndex(touchesConfigTable);
      const ledgerStatements = all.flatMap((statement, index) => touchesLedger(statement) ? [index] : []);

      // The first listing-config statement is the ALTER TABLE that adds the revision.
      expect(all[firstConfigStatement]).toMatch(
        new RegExp(`^ALTER TABLE ${CONFIG_TABLE.replace(/\./g, "\\.")}\\s+ADD COLUMN IF NOT EXISTS revision\\b`),
      );
      expect(all[ledgerStatements[0]!]).toMatch(new RegExp(`^CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE.replace(/\./g, "\\.")} \\(`));
      // CREATE TABLE, the two indexes, the guard function, DROP TRIGGER, CREATE TRIGGER.
      expect(ledgerStatements).toHaveLength(6);
      expect(Math.max(...ledgerStatements)).toBeLessThan(firstConfigStatement);
      // No statement touches both tables, so none can take their locks in the other order.
      expect(all.filter((statement) => touchesConfigTable(statement) && touchesLedger(statement))).toEqual([]);
      expect(migrationSql.indexOf(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}`))
        .toBeLessThan(migrationSql.indexOf(`ALTER TABLE ${CONFIG_TABLE}`));
    });

    it("says why: the ledger's foreign keys lock the store tables first, as connecting a store does", () => {
      const header = normalize(migrationSql.slice(0, migrationSql.indexOf("CREATE TABLE")).replace(/^--\s?/gm, ""));
      expect(header).toContain("Lock order: the ledger is created first.");
      expect(header).toContain(
        "Its foreign keys lock the vendor and store connection tables before anything here locks the listing configs, "
        + "the same order connecting a store takes them (store connection write, then the default listing config insert).",
      );
      expect(header).toContain("The other order can deadlock with a store connect running on an old dyno during the release.");
      // The ledger points at the vendor and store tables, never at the listing configs.
      expect(ledger()).toContain("REFERENCES dropship.dropship_vendors(id)");
      expect(ledger()).toContain("REFERENCES dropship.dropship_store_connections(id, vendor_id)");
      expect(ledger()).not.toContain("dropship_store_listing_configs");
    });

    it("matches connectStore, which writes the store connection before it inserts the default listing config", () => {
      const repositorySource = readFileSync(
        resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-store-connection.repository.ts"),
        "utf8",
      );
      const start = repositorySource.indexOf("async connectStore(");
      expect(start).toBeGreaterThan(0);
      const connectStore = repositorySource.slice(start, repositorySource.indexOf("\n  async ", start + 1));

      const storeWrite = connectStore.indexOf("? await updateConnection(client, existing.id, input)");
      const storeInsert = connectStore.indexOf(": await insertConnection(client, input)");
      const configInsert = connectStore.indexOf("await ensureDefaultListingConfigWithClient(client,");
      expect(storeWrite).toBeGreaterThan(0);
      expect(storeInsert).toBeGreaterThan(storeWrite);
      expect(configInsert).toBeGreaterThan(storeInsert);
    });
  });

  describe("the revision column", () => {
    it("is added NOT NULL with DEFAULT 1, so every existing config starts at revision 1", () => {
      expect(migrationSql).toContain(
        `ALTER TABLE ${CONFIG_TABLE}\n  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;`,
      );
    });

    it("can never be zero or negative, and the CHECK lands after the column it reads", () => {
      const drop = migrationSql.indexOf("DROP CONSTRAINT IF EXISTS dropship_store_listing_config_revision_chk;");
      const add = migrationSql.indexOf(
        "ADD CONSTRAINT dropship_store_listing_config_revision_chk CHECK (revision > 0);",
      );
      const column = migrationSql.indexOf("ADD COLUMN IF NOT EXISTS revision");
      expect(column).toBeGreaterThan(0);
      expect(drop).toBeGreaterThan(column);
      expect(add).toBeGreaterThan(drop);
    });

    it("says in the catalog who owns it", () => {
      expect(migrationSql).toContain(`COMMENT ON COLUMN ${CONFIG_TABLE}.revision IS`);
      expect(migrationSql).toContain("Set by trigger: 1 on insert, +1 on every update that changes the config");
    });
  });

  describe("the revision trigger", () => {
    const body = () => functionBody("dropship.dropship_store_listing_config_revision");

    it("starts an inserted row at 1 whatever revision the application sent", () => {
      expect(normalize(body())).toContain("IF TG_OP = 'INSERT' THEN NEW.revision := 1; RETURN NEW; END IF;");
    });

    it("only ever sets the revision to 1, OLD + 1 or OLD: a value sent by the application is never kept", () => {
      const assignments = [...body().matchAll(/NEW\.revision\s*:=\s*([^;]+);/g)].map((match) => match[1]!.trim());
      expect(assignments).toEqual(["1", "OLD.revision + 1", "OLD.revision"]);
      // NEW.revision is only ever written, never read.
      expect(body().replace(/NEW\.revision\s*:=/g, "")).not.toContain("NEW.revision");
    });

    it("adds exactly 1 when any content column IS DISTINCT FROM its old value, and keeps the revision otherwise", () => {
      const compared = [...body().matchAll(/NEW\.(\w+) IS DISTINCT FROM OLD\.(\w+)/g)].map((match) => {
        expect(match[2], `NEW.${match[1]} is compared with OLD.${match[2]}`).toBe(match[1]);
        return match[1]!;
      });
      expect(compared).toEqual([...CONTENT_COLUMNS]);
      // One OR chain: a change to any single column is enough.
      expect(normalize(body())).toContain(
        `IF ${CONTENT_COLUMNS.map((column) => `NEW.${column} IS DISTINCT FROM OLD.${column}`).join(" OR ")} THEN `
        + "NEW.revision := OLD.revision + 1; ELSE NEW.revision := OLD.revision; END IF; RETURN NEW;",
      );
      expect(body()).not.toMatch(/\bAND\b/);
    });

    it("compares every column of the table except identity, owner, timestamps and the revision", () => {
      const drizzleColumns = getTableConfig(dropshipStoreListingConfigs).columns.map((column) => column.name);
      expect(drizzleColumns.filter((column) => !NON_CONTENT_COLUMNS.has(column)).sort())
        .toEqual([...CONTENT_COLUMNS].sort());
      // The Drizzle declaration is the whole table: the columns migration 0094 created, plus the revision.
      expect([...createTableColumns(createTableSql, CONFIG_TABLE), "revision"].sort()).toEqual([...drizzleColumns].sort());
      // An update that changes only updated_at (or sends a revision) is not a change.
      expect(body()).not.toMatch(/NEW\.(updated_at|created_at|id|store_connection_id|revision) IS DISTINCT FROM/);
    });

    it("runs BEFORE INSERT OR UPDATE on every row, with no WHEN or column list that a writer could slip past", () => {
      const trigger = statements().find((statement) => statement.startsWith("CREATE TRIGGER dropship_store_listing_config_revision_trg"));
      expect(normalize(trigger ?? "")).toBe(
        "CREATE TRIGGER dropship_store_listing_config_revision_trg "
        + `BEFORE INSERT OR UPDATE ON ${CONFIG_TABLE} `
        + "FOR EACH ROW EXECUTE FUNCTION dropship.dropship_store_listing_config_revision()",
      );
      expect(migrationSql.indexOf("CREATE OR REPLACE FUNCTION dropship.dropship_store_listing_config_revision()"))
        .toBeLessThan(migrationSql.indexOf("CREATE TRIGGER dropship_store_listing_config_revision_trg"));
      expect(normalize(functionDefinition("dropship.dropship_store_listing_config_revision"))).toMatch(
        /^CREATE OR REPLACE FUNCTION dropship\.dropship_store_listing_config_revision\(\) RETURNS trigger AS <<plpgsql body>> LANGUAGE plpgsql$/,
      );
    });
  });

  describe("the keyed request ledger", () => {
    const ledger = () => createTableBody(migrationSql, LEDGER_TABLE);

    it("keeps who asked, for which store, against which revision, and what came of it", () => {
      expect(ledgerColumns()).toEqual([
        "id bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY",
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        // The store is referenced together with its vendor (the owner FK below), never alone.
        "store_connection_id integer NOT NULL",
        "operation varchar(60) NOT NULL",
        "idempotency_key varchar(200) NOT NULL",
        "request_hash varchar(64) NOT NULL",
        "actor_type varchar(40) NOT NULL",
        // Keyed requests always name who made them (the repository refuses one without).
        "actor_id varchar(255) NOT NULL",
        "revision_before integer NOT NULL",
        "revision_after integer NOT NULL",
        "outcome varchar(20) NOT NULL",
        // The application's injected clock stamps the row; there is no DEFAULT now().
        "created_at timestamptz NOT NULL",
      ]);
      expect(ledger()).not.toMatch(/DEFAULT\s+now\(\)/i);
      // A ledger row outlives nothing it points at: no cascade can erase it.
      expect(ledger()).not.toMatch(/ON DELETE/i);
    });

    it("ties each request to a store of the same vendor through the composite owner FK, with no single-column store FK", () => {
      expect(ledger()).toContain(
        "CONSTRAINT dropship_listing_config_requests_owner_fk FOREIGN KEY (store_connection_id, vendor_id)\n"
        + "    REFERENCES dropship.dropship_store_connections(id, vendor_id)",
      );
      // The only reference to the store table is the owner FK: a request can
      // never name another vendor's store.
      expect(ledger().match(/REFERENCES dropship\.dropship_store_connections\s*\([^)]*\)/g)).toEqual([
        "REFERENCES dropship.dropship_store_connections(id, vendor_id)",
      ]);
      expect(ledger()).not.toMatch(/REFERENCES dropship\.dropship_store_connections\s*\(\s*id\s*\)/);
      expect(ledger().match(/\bFOREIGN KEY\b/g)).toHaveLength(1);
    });

    it("can reference (id, vendor_id) because an earlier migration made that pair unique on the store table", () => {
      // A composite FK needs a unique index on exactly the referenced columns.
      const ownerIdentity = readFileSync(
        resolve(process.cwd(), "migrations/0657_dropship_listing_price_settings.sql"),
        "utf8",
      );
      expect(ownerIdentity).toContain(
        "CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_conn_owner_identity_idx\n"
        + "  ON dropship.dropship_store_connections (id, vendor_id);",
      );
      expect("0657_dropship_listing_price_settings.sql" < MIGRATION_FILE).toBe(true);
    });

    it("requires a non-blank actor id", () => {
      expect(ledgerColumns()).toContain("actor_id varchar(255) NOT NULL");
      expect(ledger()).toContain(
        "CONSTRAINT dropship_listing_config_requests_actor_id_chk\n    CHECK (btrim(actor_id) <> '')",
      );
      // The repository refuses a keyed request without an actor id before it
      // connects, so the CHECK is the backstop, not the first refusal.
      expect(readFileSync(
        resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-listing-config.repository.ts"),
        "utf8",
      )).toContain('"DROPSHIP_LISTING_CONFIG_REQUEST_ACTOR_REQUIRED"');
    });

    it("pins the operation and actor values to the application's types", () => {
      expect(operationsMatchTheService && actorTypesMatchTheService && outcomesMatchTheService).toBe(true);
      expect(ledger()).toContain(
        `CONSTRAINT dropship_listing_config_requests_operation_chk\n    CHECK (operation IN (${sqlList(LEDGER_OPERATIONS)}))`,
      );
      expect(ledger()).toContain(
        `CONSTRAINT dropship_listing_config_requests_actor_chk\n    CHECK (actor_type IN (${sqlList(LEDGER_ACTOR_TYPES)}))`,
      );
    });

    it("accepts exactly the request keys and hashes the application produces", () => {
      expect(ledger()).toContain(
        "CONSTRAINT dropship_listing_config_requests_key_chk\n    CHECK (idempotency_key ~ '^[A-Za-z0-9:_-]{8,200}$')",
      );
      expect(ledger()).toContain(
        "CONSTRAINT dropship_listing_config_requests_hash_chk\n    CHECK (request_hash ~ '^[a-f0-9]{64}$')",
      );
      // The CHECK's POSIX regex is plain ERE here, so it reads the same in JavaScript.
      const keyCheck = new RegExp(/idempotency_key ~ '([^']+)'/.exec(ledger())![1]!);
      for (const key of [
        "abcdefgh",
        "a".repeat(200),
        "setup:22:2026-10-08T00_00",
        "  padded-key-1234  ",
        "short",
        "abcdefg",
        "a".repeat(201),
        "has.dots.in.it",
        "has spaces in it",
        "ключ-не-ascii",
        "",
      ]) {
        const parsed = dropshipListingConfigIdempotencyKeySchema.safeParse(key);
        // Whatever the API accepts, the ledger stores; whatever the ledger refuses, the API refused first.
        expect(parsed.success, JSON.stringify(key)).toBe(keyCheck.test(key.trim()));
        if (parsed.success) expect(keyCheck.test(parsed.data)).toBe(true);
      }
    });

    it("lets a save move the config by exactly one revision, or not at all", () => {
      expect(normalize(ledger())).toContain(
        "CONSTRAINT dropship_listing_config_requests_outcome_chk CHECK ( revision_before > 0 AND ( "
        + "(outcome = 'changed' AND revision_after = revision_before + 1) "
        + "OR (outcome = 'unchanged' AND revision_after = revision_before) ) )",
      );
    });

    it("names one request per vendor key, whatever store it was for, and indexes a store's history", () => {
      expect(migrationSql).toContain(
        `CREATE UNIQUE INDEX IF NOT EXISTS dropship_listing_config_requests_key_idx\n  ON ${LEDGER_TABLE}(vendor_id, idempotency_key);`,
      );
      expect(migrationSql).toContain(
        `CREATE INDEX IF NOT EXISTS dropship_listing_config_requests_store_idx\n  ON ${LEDGER_TABLE}(store_connection_id, created_at);`,
      );
      // The repository maps a race on this exact index name to IDEMPOTENCY_CONFLICT.
      expect(readFileSync(
        resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-listing-config.repository.ts"),
        "utf8",
      )).toContain('pgError.constraint === "dropship_listing_config_requests_key_idx"');
    });

    it("references the vendor row, which the repository share-locks with the store row before the listing-config lock and any ledger write", () => {
      // The ledger's (and the audit row's) foreign key takes a share lock on
      // the vendor row at INSERT. Order acceptance locks the vendor row, then
      // the store row; taking the vendor row only at INSERT, after the store
      // row, would wait on it in the opposite order (deadlock).
      expect(ledger()).toContain("vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)");
      const repositorySource = readFileSync(
        resolve(process.cwd(), "server/modules/dropship/infrastructure/dropship-listing-config.repository.ts"),
        "utf8",
      );
      const start = repositorySource.indexOf("async replaceConfig(");
      const end = repositorySource.indexOf("async function selectConfigForUpdate(");
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(start);
      const replaceConfig = repositorySource.slice(start, end);

      const pushJobLock = replaceConfig.indexOf("hashtext('dropship_listing_push_job')");
      const rowLock = replaceConfig.indexOf("FOR SHARE OF v, sc");
      const configLock = replaceConfig.indexOf("hashtext('dropship_listing_config')");
      const ledgerWrite = replaceConfig.indexOf("recordKeyedRequest(");
      const auditWrite = replaceConfig.indexOf("recordListingConfigAuditEvent(");
      expect(normalize(replaceConfig)).toContain(
        "FROM dropship.dropship_vendors v JOIN dropship.dropship_store_connections sc ON sc.vendor_id = v.id",
      );
      expect(pushJobLock).toBeGreaterThan(0);
      expect(rowLock).toBeGreaterThan(pushJobLock);
      expect(configLock).toBeGreaterThan(rowLock);
      expect(ledgerWrite).toBeGreaterThan(configLock);
      expect(auditWrite).toBeGreaterThan(configLock);
      // The rows are locked once, together: no later lock on either row alone.
      expect(replaceConfig.match(/FOR (SHARE|UPDATE|NO KEY UPDATE|KEY SHARE) OF/g)).toEqual(["FOR SHARE OF"]);
    });

    it("is append-only: every UPDATE and DELETE raises", () => {
      expect(normalize(functionBody("dropship.dropship_listing_config_requests_guard"))).toBe(
        "BEGIN RAISE EXCEPTION 'dropship_listing_config_requests is append-only: rows cannot be updated or deleted'; END;",
      );
      const trigger = statements().find((statement) => statement.startsWith("CREATE TRIGGER dropship_listing_config_requests_guard_trg"));
      expect(normalize(trigger ?? "")).toBe(
        "CREATE TRIGGER dropship_listing_config_requests_guard_trg "
        + `BEFORE UPDATE OR DELETE ON ${LEDGER_TABLE} `
        + "FOR EACH ROW EXECUTE FUNCTION dropship.dropship_listing_config_requests_guard()",
      );
      expect(migrationSql.indexOf(`CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE}`))
        .toBeLessThan(migrationSql.indexOf("CREATE TRIGGER dropship_listing_config_requests_guard_trg"));
    });
  });

  it("is additive: no data change, no dropped column or table, no type change", () => {
    for (const statement of statements()) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE)\b/i);
      expect(statement, statement.slice(0, 80)).not.toMatch(/\bDROP\s+(COLUMN|TABLE|INDEX|SCHEMA|FUNCTION)\b/i);
      expect(statement, statement.slice(0, 80)).not.toMatch(/\bALTER\s+COLUMN\b/i);
    }
  });

  it("is re-runnable: every statement is guarded", () => {
    const droppedConstraints = new Set<string>();
    const droppedTriggers = new Set<string>();
    const all = statements();
    expect(all.length).toBeGreaterThanOrEqual(13);
    for (const statement of all) {
      const droppedConstraint = /^ALTER TABLE [\w.]+\s+DROP CONSTRAINT IF EXISTS (\w+)$/i.exec(statement)?.[1];
      if (droppedConstraint) droppedConstraints.add(droppedConstraint);
      const droppedTrigger = /^DROP TRIGGER IF EXISTS (\w+)\s+ON ([\w.]+)$/i.exec(statement);
      if (droppedTrigger) droppedTriggers.add(`${droppedTrigger[1]} ON ${droppedTrigger[2]}`);
      const addedConstraint = /^ALTER TABLE [\w.]+\s+ADD CONSTRAINT (\w+)\b/i.exec(statement)?.[1];
      const createdTrigger = /^CREATE TRIGGER (\w+)\s+BEFORE [\w\s]+? ON ([\w.]+)\s/i.exec(statement);
      const guarded =
        /^ALTER TABLE [\w.]+\s+ADD COLUMN IF NOT EXISTS\b/i.test(statement)
        || droppedConstraint !== undefined
        // An ADD CONSTRAINT is safe only because the same constraint was dropped IF EXISTS before it.
        || (addedConstraint !== undefined && droppedConstraints.has(addedConstraint))
        || /^COMMENT ON\b/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION\b/i.test(statement)
        || droppedTrigger !== null
        // A CREATE TRIGGER is safe only because the same trigger was dropped IF EXISTS on the same table before it.
        || (createdTrigger !== null && droppedTriggers.has(`${createdTrigger[1]} ON ${createdTrigger[2]}`))
        || /^CREATE TABLE IF NOT EXISTS\b/i.test(statement)
        || /^CREATE (UNIQUE )?INDEX IF NOT EXISTS\b/i.test(statement);
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

describe("dropship_store_listing_configs Drizzle declaration (migration 0728)", () => {
  it("declares the revision as a NOT NULL integer that defaults to 1", () => {
    expect(schemaSource).toContain('revision: integer("revision").notNull().default(1),');
    const revision = getTableConfig(dropshipStoreListingConfigs).columns.find((column) => column.name === "revision");
    expect(revision).toMatchObject({ columnType: "PgInteger", notNull: true, default: 1 });
  });

  it("declares the revision CHECK under the migration's constraint name", () => {
    expect(normalize(schemaSource)).toContain(
      'check( "dropship_store_listing_config_revision_chk", sql`${table.revision} > 0`, ),',
    );
    expect(getTableConfig(dropshipStoreListingConfigs).checks.map((check) => check.name))
      .toContain("dropship_store_listing_config_revision_chk");
  });
});

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function withoutComments(sql: string): string {
  // No string literal in these files contains "--", so a line comment is everything after it.
  return sql.replace(/--[^\n]*/g, "");
}

/** The migration's statements: comments removed, dollar-quoted function bodies collapsed, split on ";". */
function statements(): string[] {
  return withoutComments(migrationSql)
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** The statement that creates the named function, with its body collapsed. */
function functionDefinition(name: string): string {
  const definition = statements().find((statement) => statement.startsWith(`CREATE OR REPLACE FUNCTION ${name}()`));
  if (!definition) throw new Error(`function ${name} not found`);
  return definition;
}

/** The plpgsql body (between the $$ quotes) of the named function. */
function functionBody(name: string): string {
  const escaped = name.replace(/\./g, "\\.");
  const match = new RegExp(`CREATE OR REPLACE FUNCTION ${escaped}\\(\\)\\s+RETURNS trigger AS \\$\\$([\\s\\S]*?)\\$\\$`).exec(migrationSql);
  if (!match) throw new Error(`function body for ${name} not found`);
  return withoutComments(match[1]!);
}

/** The text between the parentheses of CREATE TABLE [IF NOT EXISTS] <table> ( ... );. */
function createTableBody(sql: string, table: string): string {
  const escaped = table.replace(/\./g, "\\.");
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!match) throw new Error(`CREATE TABLE ${table} not found`);
  return withoutComments(match[1]!);
}

/** Column definitions of a CREATE TABLE body (a name, then a type), one per line; constraints left out. */
function columnDefinitions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => /^[a-z_]+ (bigint|integer|varchar\(\d+\)|text|jsonb|boolean|timestamptz)(?=\s|$)/.test(line));
}

function ledgerColumns(): string[] {
  return columnDefinitions(createTableBody(migrationSql, LEDGER_TABLE));
}

function createTableColumns(sql: string, table: string): string[] {
  return columnDefinitions(createTableBody(sql, table)).map((definition) => definition.split(/\s+/)[0]!);
}
