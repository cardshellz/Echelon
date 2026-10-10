import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  dropshipCategoryListingSettingRevisions,
  dropshipCategoryListingSettings,
  dropshipProductCategorySeen,
} from "../../../../../shared/schema/dropship.schema";
import { productCategories } from "../../../../../shared/schema/catalog.schema";
import {
  LISTING_SETTING_ACTOR_TYPES,
  LISTING_SETTING_KEY_PATTERN,
  type ListingSettingActorType,
} from "../../../../../shared/dropship/listing-setting-values";
import type { ListingSettingActor } from "../../application/dropship-listing-setting-writes";
import {
  CATEGORY_LISTING_SETTING_VALUE_COLUMNS,
  LISTING_SETTING_VALUE_COLUMN_TYPES,
  MAX_LISTING_SETTING_ACTOR_ID_LENGTH,
} from "../../infrastructure/dropship-listing-setting-shared.repository";

const MIGRATION_FILE = "0737_dropship_category_listing_settings.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");
/** The product settings migration, whose value CHECKs the category revisions repeat. */
const productMigrationSql = readFileSync(resolve(process.cwd(), "migrations/0736_dropship_product_listing_settings.sql"), "utf8");

const REVISIONS_TABLE = "dropship.dropship_category_listing_setting_revisions";
const SETTINGS_TABLE = "dropship.dropship_category_listing_settings";
const MARKS_TABLE = "dropship.dropship_product_category_seen";
const PRODUCT_REVISIONS_TABLE = "dropship.dropship_product_listing_setting_revisions";

// The CHECKs list these values; the shared contracts and the writers' port
// must not drift from them. The tuple is checked both ways at compile time
// (`npm run check:tests`), and against the SQL and the contracts' runtime
// values by the tests below.
const ACTOR_TYPES = ["vendor", "admin", "system"] as const;
const REQUEST_KEY_PATTERN = "^[A-Za-z0-9:_-]{8,200}$";
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const actorTypesMatchTheContract: Exact<typeof ACTOR_TYPES[number], ListingSettingActorType> = true;
const actorTypesMatchThePort: Exact<typeof ACTOR_TYPES[number], ListingSettingActor["actorType"]> = true;

/** Every value column a category revision carries: a product's, without the main text (product only). */
const VALUE_COLUMNS = [
  "price_basis varchar(20)",
  "price_markup_bps integer",
  "price_flat_cents integer",
  "price_rounding varchar(10)",
  "ebay_category_id varchar(20)",
  "ebay_category_name varchar(200)",
  "ebay_category_path jsonb",
  "shelf_mode varchar(10)",
  "shelf_ids jsonb",
  "shelf_names jsonb",
  "fulfillment_policy_id varchar(100)",
  "fulfillment_policy_name varchar(200)",
  "return_policy_id varchar(100)",
  "return_policy_name varchar(200)",
  "payment_policy_id varchar(100)",
  "payment_policy_name varchar(200)",
  "text_above_mode varchar(10)",
  "text_above text",
  "text_below_mode varchar(10)",
  "text_below text",
] as const;

/** CHECK purposes the category revisions share with the product revisions, expression for expression. */
const SHARED_CHECK_PURPOSES = ["price", "ebay_category", "shelf", "policy", "text", "key", "hash", "actor", "actor_id"] as const;

const DRIZZLE_TABLES: ReadonlyArray<readonly [string, PgTable]> = [
  [REVISIONS_TABLE, dropshipCategoryListingSettingRevisions],
  [SETTINGS_TABLE, dropshipCategoryListingSettings],
  [MARKS_TABLE, dropshipProductCategorySeen],
];

describe("0737 dropship category listing settings migration", () => {
  it("is the only migration with its number", () => {
    const sameNumber = readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0737_"));
    expect(sameNumber).toEqual([MIGRATION_FILE]);
  });

  it("leaves the transaction to the release executor: no BEGIN, COMMIT or ROLLBACK of its own", () => {
    for (const statement of statements(migrationSql)) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END|SAVEPOINT)\b/i);
    }
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(migrationSql).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("says why, what changes for live data, the lock order and who owns the transaction", () => {
    const header = normalize(migrationSql.slice(0, migrationSql.indexOf("CREATE TABLE")).replace(/^--\s?/gm, ""));
    expect(header).toContain("Category settings are keyed by the Card Shellz category id, never its name");
    expect(header).toContain("Nothing changes for live data: the three tables are new and start empty, and no existing table is altered.");
    expect(header).toContain(
      "Lock order: in statement order the foreign keys take SHARE ROW EXCLUSIVE on the vendor table, then the store connection table, "
      + "then the Card Shellz categories table, until commit. This file references the products table nowhere, so it takes no lock on it.",
    );
    expect(header).toContain("The release executor owns the transaction, including its migration record. Additive and re-runnable.");
  });

  it("creates the revisions, then the current rows, then the marks, and never touches the products table", () => {
    const created = statements(migrationSql).flatMap((statement) => {
      const table = /^CREATE TABLE IF NOT EXISTS ([\w.]+) \(/.exec(statement)?.[1];
      return table ? [table] : [];
    });
    expect(created).toEqual([REVISIONS_TABLE, SETTINGS_TABLE, MARKS_TABLE]);
    // Not in SQL and not in a comment: no lock on it, and no suite has to stub it for this file.
    expect(migrationSql).not.toMatch(/\bcatalog\.products\b/);
    expect(withoutComments(migrationSql)).not.toMatch(/\bproducts\(/);
  });

  describe("the category revisions", () => {
    it("carry identity, the category's name at save, the chain, every value column but the main text, and the request columns", () => {
      expect(columnDefinitions(createTableBody(migrationSql, REVISIONS_TABLE))).toEqual([
        "id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        "store_connection_id integer NOT NULL",
        "category_id integer NOT NULL",
        "category_name varchar(100) NOT NULL",
        "previous_revision_id integer",
        ...VALUE_COLUMNS,
        "idempotency_key varchar(200) NOT NULL",
        "request_hash varchar(64) NOT NULL",
        "actor_type varchar(40) NOT NULL",
        "actor_id varchar(255) NOT NULL",
        "created_at timestamptz NOT NULL",
      ]);
      // A category save is never part of a many-products request, and the main text is product only.
      expect(createTableBody(migrationSql, REVISIONS_TABLE)).not.toMatch(/\b(body_\w+|request_id)\b/);
      expect(checkBodies(migrationSql, REVISIONS_TABLE).get("dropship_category_listing_setting_revision_category_name_chk"))
        .toBe("btrim(category_name) <> ''");
    });

    it("match the shared listing-setting contracts and the category writer's column map, in order", () => {
      expect([...LISTING_SETTING_ACTOR_TYPES]).toEqual([...ACTOR_TYPES]);
      expect(LISTING_SETTING_KEY_PATTERN.source).toBe(REQUEST_KEY_PATTERN);
      expect(LISTING_SETTING_KEY_PATTERN.flags).toBe("");
      expect(columnDefinitions(createTableBody(migrationSql, REVISIONS_TABLE)))
        .toContain(`actor_id varchar(${MAX_LISTING_SETTING_ACTOR_ID_LENGTH}) NOT NULL`);
      // The value columns the writer inserts and reads, in table order, each with its type.
      expect(VALUE_COLUMNS.map((definition) => definition.split(" ")[0])).toEqual([...CATEGORY_LISTING_SETTING_VALUE_COLUMNS]);
      for (const definition of VALUE_COLUMNS) {
        const [column, sqlType] = definition.split(" ") as [keyof typeof LISTING_SETTING_VALUE_COLUMN_TYPES, string];
        const recordsetType = sqlType === "jsonb" ? "jsonb" : sqlType === "integer" ? "integer" : "text";
        expect(LISTING_SETTING_VALUE_COLUMN_TYPES[column], column).toBe(recordsetType);
      }
    });

    it("keep the category name as wide as the Card Shellz category name", () => {
      expect(getTableConfig(productCategories).columns.find((column) => column.name === "name")?.getSQLType()).toBe("varchar(100)");
      expect(readFileSync(resolve(process.cwd(), "migrations/0108_catalog_product_categories.sql"), "utf8"))
        .toContain("name varchar(100) NOT NULL,");
    });

    it("repeat the product revisions' value CHECKs exactly, under their own names", () => {
      const category = checkBodies(migrationSql, REVISIONS_TABLE);
      const product = checkBodies(productMigrationSql, PRODUCT_REVISIONS_TABLE);
      expect([...category.keys()].sort()).toEqual([
        ...SHARED_CHECK_PURPOSES.map((purpose) => `dropship_category_listing_setting_revision_${purpose}_chk`),
        "dropship_category_listing_setting_revision_category_name_chk",
      ].sort());
      for (const purpose of SHARED_CHECK_PURPOSES) {
        const expression = product.get(`dropship_product_listing_setting_revision_${purpose}_chk`);
        expect(expression, purpose).toBeDefined();
        expect(category.get(`dropship_category_listing_setting_revision_${purpose}_chk`), purpose).toBe(expression);
      }
      // The corrected forms (no NULL CHECK result), as 0736 pins them.
      expect(category.get("dropship_category_listing_setting_revision_price_chk")).toMatch(/^num_nonnulls\(/);
      expect(category.get("dropship_category_listing_setting_revision_ebay_category_chk")).toMatch(/^num_nonnulls\(/);
      expect(category.get("dropship_category_listing_setting_revision_shelf_chk")).toContain("shelf_mode IS NOT NULL AND shelf_mode = 'own'");
      expect(category.get("dropship_category_listing_setting_revision_key_chk")).toBe(`idempotency_key ~ '${REQUEST_KEY_PATTERN}'`);
      expect(category.get("dropship_category_listing_setting_revision_actor_chk")).toBe(`actor_type IN (${sqlList(ACTOR_TYPES)})`);
    });

    it("chain inside one vendor, store and category, keyed by the category id", () => {
      expect(foreignKeys(migrationSql, REVISIONS_TABLE)).toEqual([
        { name: null, columns: ["vendor_id"], foreignTable: "dropship.dropship_vendors", foreignColumns: ["id"] },
        { name: "dropship_category_listing_setting_revision_owner_fk", columns: ["store_connection_id", "vendor_id"],
          foreignTable: "dropship.dropship_store_connections", foreignColumns: ["id", "vendor_id"] },
        { name: "dropship_category_listing_setting_revision_category_fk", columns: ["category_id"],
          foreignTable: "catalog.product_categories", foreignColumns: ["id"] },
        { name: "dropship_category_listing_setting_revision_previous_fk",
          columns: ["previous_revision_id", "vendor_id", "store_connection_id", "category_id"],
          foreignTable: REVISIONS_TABLE, foreignColumns: ["id", "vendor_id", "store_connection_id", "category_id"] },
      ]);
      expect(uniques(migrationSql, REVISIONS_TABLE)).toEqual([
        { name: "dropship_category_listing_setting_revision_identity_uk", columns: ["id", "vendor_id", "store_connection_id", "category_id"] },
        { name: "dropship_category_listing_setting_revision_key_uk", columns: ["vendor_id", "idempotency_key"] },
      ]);
      expect(indexes(migrationSql)).toContainEqual({ name: "dropship_category_listing_setting_revision_target_idx", unique: false,
        table: REVISIONS_TABLE, columns: ["store_connection_id", "category_id", "id"], where: null });
    });

    it("are immutable: every UPDATE and DELETE raises 23514", () => {
      expect(normalize(functionBody(migrationSql, "dropship.guard_category_listing_setting_revision_immutable"))).toBe(
        "BEGIN RAISE EXCEPTION 'Category listing setting revisions are immutable; create a new revision' USING ERRCODE = '23514'; END;",
      );
      expect(triggers(migrationSql)).toContainEqual(expect.objectContaining({
        name: "category_listing_setting_revision_immutable", timing: "BEFORE UPDATE OR DELETE", table: REVISIONS_TABLE,
        fn: "dropship.guard_category_listing_setting_revision_immutable",
      }));
    });
  });

  describe("the current category rows", () => {
    it("only point at their revision, one per store and category", () => {
      expect(columnDefinitions(createTableBody(migrationSql, SETTINGS_TABLE))).toEqual([
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        "store_connection_id integer NOT NULL",
        "category_id integer NOT NULL",
        "revision_id integer NOT NULL",
      ]);
      // The owner FK already pins the vendor (plan D4).
      expect(primaryKey(migrationSql, SETTINGS_TABLE))
        .toEqual({ name: "dropship_category_listing_setting_pk", columns: ["store_connection_id", "category_id"] });
      expect(foreignKeys(migrationSql, SETTINGS_TABLE)).toEqual([
        { name: null, columns: ["vendor_id"], foreignTable: "dropship.dropship_vendors", foreignColumns: ["id"] },
        { name: "dropship_category_listing_setting_owner_fk", columns: ["store_connection_id", "vendor_id"],
          foreignTable: "dropship.dropship_store_connections", foreignColumns: ["id", "vendor_id"] },
        { name: "dropship_category_listing_setting_category_fk", columns: ["category_id"],
          foreignTable: "catalog.product_categories", foreignColumns: ["id"] },
        { name: "dropship_category_listing_setting_revision_fk", columns: ["revision_id", "vendor_id", "store_connection_id", "category_id"],
          foreignTable: REVISIONS_TABLE, foreignColumns: ["id", "vendor_id", "store_connection_id", "category_id"] },
      ]);
      expect(indexes(migrationSql)).toContainEqual({ name: "dropship_category_listing_setting_vendor_idx", unique: false,
        table: SETTINGS_TABLE, columns: ["vendor_id", "store_connection_id"], where: null });
    });

    it("refuse deletes, identity changes and a revision whose predecessor is not the current one", () => {
      const body = normalize(functionBody(migrationSql, "dropship.guard_category_listing_setting_coherence"));
      expect(body).toContain("IF TG_OP = 'DELETE' THEN RAISE EXCEPTION "
        + "'Reset category listing settings with a new revision, not deletion' USING ERRCODE = '23514'; END IF;");
      expect(body).toContain("IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id "
        + "OR OLD.category_id <> NEW.category_id) THEN RAISE EXCEPTION 'Category listing setting identity cannot change' USING ERRCODE = '23514';");
      expect(body).toContain("IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;");
      expect(body).toContain(`SELECT previous_revision_id INTO predecessor FROM ${REVISIONS_TABLE} WHERE id = NEW.revision_id;`);
      expect(body).toContain(`IF predecessor IS DISTINCT FROM (SELECT revision_id FROM ${SETTINGS_TABLE} `
        + "WHERE store_connection_id = NEW.store_connection_id AND category_id = NEW.category_id) THEN RAISE EXCEPTION "
        + "'Category listing setting predecessor does not match the current setting' USING ERRCODE = '23514';");
      expect(triggers(migrationSql)).toContainEqual(expect.objectContaining({
        name: "category_listing_setting_coherence", timing: "BEFORE INSERT OR UPDATE OR DELETE", table: SETTINGS_TABLE,
        fn: "dropship.guard_category_listing_setting_coherence",
      }));
    });
  });

  describe("the category marks", () => {
    it("keep one mark per store and product, with the category last confirmed (or none) and when", () => {
      expect(columnDefinitions(createTableBody(migrationSql, MARKS_TABLE))).toEqual([
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        "store_connection_id integer NOT NULL",
        "product_id integer NOT NULL",
        "category_id integer",
        "seen_at timestamptz NOT NULL",
      ]);
      expect(primaryKey(migrationSql, MARKS_TABLE)).toEqual({ name: "dropship_product_category_seen_pk", columns: ["store_connection_id", "product_id"] });
    });

    it("reference only their owner: no foreign key on the product or the category, so a catalog delete is never blocked or followed", () => {
      expect(foreignKeys(migrationSql, MARKS_TABLE)).toEqual([
        { name: null, columns: ["vendor_id"], foreignTable: "dropship.dropship_vendors", foreignColumns: ["id"] },
        { name: "dropship_product_category_seen_owner_fk", columns: ["store_connection_id", "vendor_id"],
          foreignTable: "dropship.dropship_store_connections", foreignColumns: ["id", "vendor_id"] },
      ]);
      expect(createTableBody(migrationSql, MARKS_TABLE)).not.toContain("catalog.");
    });

    it("are never deleted, never change identity and never move back in time", () => {
      expect(normalize(functionBody(migrationSql, "dropship.guard_product_category_seen"))).toBe(
        "BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Category marks are kept; acknowledge to move them forward' "
        + "USING ERRCODE = '23514'; END IF; "
        + "IF OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id OR OLD.product_id <> NEW.product_id THEN "
        + "RAISE EXCEPTION 'Category mark identity cannot change' USING ERRCODE = '23514'; END IF; "
        + "IF NEW.seen_at < OLD.seen_at THEN RAISE EXCEPTION 'A category mark cannot move back in time' USING ERRCODE = '23514'; END IF; "
        + "RETURN NEW; END;",
      );
      // Inserts need no guard: first marks never change an existing mark (ON CONFLICT DO NOTHING).
      expect(triggers(migrationSql)).toContainEqual(expect.objectContaining({
        name: "product_category_seen_guard", timing: "BEFORE UPDATE OR DELETE", table: MARKS_TABLE,
        fn: "dropship.guard_product_category_seen",
      }));
    });
  });

  it("ties every table to a store of the same vendor through the composite owner FK, never a single-column store FK", () => {
    for (const table of [REVISIONS_TABLE, SETTINGS_TABLE, MARKS_TABLE]) {
      const storeReferences = foreignKeys(migrationSql, table).filter((key) => key.foreignTable === "dropship.dropship_store_connections");
      expect(storeReferences, table).toEqual([expect.objectContaining({
        columns: ["store_connection_id", "vendor_id"], foreignColumns: ["id", "vendor_id"],
      })]);
      expect(columnDefinitions(createTableBody(migrationSql, table))).toContain("store_connection_id integer NOT NULL");
    }
    expect("0657_dropship_listing_price_settings.sql" < MIGRATION_FILE).toBe(true);
  });

  it("types every column as a whole number, varchar, text, jsonb or timestamptz: no floating-point or numeric money", () => {
    for (const table of [REVISIONS_TABLE, SETTINGS_TABLE, MARKS_TABLE]) {
      for (const definition of columnDefinitions(createTableBody(migrationSql, table))) expect(definition, table).toMatch(COLUMN_TYPE);
    }
  });

  it("cascades nothing and lets the injected clock stamp every row", () => {
    expect(withoutComments(migrationSql)).not.toMatch(/\bON\s+(DELETE|UPDATE)\b/i);
    expect(withoutComments(migrationSql)).not.toMatch(/\bDEFAULT\b/i);
  });

  it("names every constraint and object within PostgreSQL's 63 bytes, without digits, once", () => {
    const names = objectNames(migrationSql);
    expect(names.length).toBeGreaterThan(25);
    for (const name of names) {
      expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
      expect(name, name).toMatch(/^[a-z_]+$/);
    }
    expect(new Set(names).size).toBe(names.length);
    // Nothing collides with 0736's names either (constraint and index names share the schema).
    const productNames = new Set(objectNames(productMigrationSql));
    expect(names.filter((name) => productNames.has(name))).toEqual([]);
    expect(triggers(migrationSql).map((trigger) => trigger.fn)).toEqual([
      "dropship.guard_category_listing_setting_revision_immutable",
      "dropship.guard_category_listing_setting_coherence",
      "dropship.guard_product_category_seen",
    ]);
    for (const statement of statements(migrationSql).filter((statement) => statement.startsWith("CREATE OR REPLACE FUNCTION"))) {
      expect(statement).toMatch(/^CREATE OR REPLACE FUNCTION dropship\.guard_[a-z_]+\(\) RETURNS trigger LANGUAGE plpgsql AS <<plpgsql body>>$/);
    }
  });

  it("names no schema-qualified object in a comment, and nothing from the 215 or 217 migrations", () => {
    const comments = migrationSql.match(/--[^\n]*/g) ?? [];
    expect(comments.length).toBeGreaterThan(10);
    for (const comment of comments) {
      expect(comment).not.toMatch(/\b(dropship|catalog|membership|channels|public|ebay)\.[a-z_]/);
    }
    for (const file of ["215_dropship_ebay_product_category_scope.sql", "217_dropship_ebay_listing_policy_overrides.sql"]) {
      const later = readFileSync(resolve(process.cwd(), "migrations", file), "utf8");
      const laterObjects = [...later.matchAll(/CREATE (?:TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS (?:dropship\.)?(\w+)/g)].map((match) => match[1]!);
      expect(laterObjects.length).toBeGreaterThan(0);
      for (const object of laterObjects) expect(migrationSql, object).not.toContain(object);
    }
  });

  it("is additive: no data change, nothing dropped but its own triggers, nothing existing altered", () => {
    for (const statement of statements(migrationSql)) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE|ALTER)\b/i);
      expect(statement, statement.slice(0, 80)).not.toMatch(/\bDROP\s+(COLUMN|TABLE|INDEX|SCHEMA|FUNCTION|CONSTRAINT)\b/i);
    }
  });

  it("is re-runnable: every statement is guarded", () => {
    const droppedTriggers = new Set<string>();
    const all = statements(migrationSql);
    expect(all).toHaveLength(14);
    for (const statement of all) {
      const droppedTrigger = /^DROP TRIGGER IF EXISTS (\w+)\s+ON ([\w.]+)$/i.exec(statement);
      if (droppedTrigger) droppedTriggers.add(`${droppedTrigger[1]} ON ${droppedTrigger[2]}`);
      const createdTrigger = /^CREATE TRIGGER (\w+)\s+BEFORE [\w\s]+? ON ([\w.]+)\s/i.exec(statement);
      const guarded =
        /^CREATE TABLE IF NOT EXISTS\b/i.test(statement)
        || /^CREATE (UNIQUE )?INDEX IF NOT EXISTS\b/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION\b/i.test(statement)
        || droppedTrigger !== null
        || (createdTrigger !== null && droppedTriggers.has(`${createdTrigger[1]} ON ${createdTrigger[2]}`));
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

describe("Drizzle declarations of the 0737 tables", () => {
  it("declare each table on the dropship schema under the migration's name", () => {
    for (const [table, drizzle] of DRIZZLE_TABLES) {
      const config = getTableConfig(drizzle);
      expect(`${config.schema}.${config.name}`).toBe(table);
    }
  });

  it.each(DRIZZLE_TABLES)("%s: the same columns, types and NOT NULLs, in order", (table, drizzle) => {
    expect(drizzleColumns(drizzle)).toEqual(sqlColumns(table));
    const identity = getTableConfig(drizzle).columns.filter((column) => column.primary);
    expect(identity.map((column) => [column.name, column.generatedIdentity?.type]))
      .toEqual(table === REVISIONS_TABLE ? [["id", "always"]] : []);
  });

  it.each(DRIZZLE_TABLES)("%s: the same primary key, foreign keys and unique constraints, by name and columns", (table, drizzle) => {
    const config = getTableConfig(drizzle);
    const sqlPrimaryKey = primaryKey(migrationSql, table);
    expect(config.primaryKeys.map((key) => ({ name: key.getName(), columns: key.columns.map((column) => column.name) })))
      .toEqual(sqlPrimaryKey ? [sqlPrimaryKey] : []);
    const sqlKeys = foreignKeys(migrationSql, table);
    expect(drizzleForeignKeys(drizzle, sqlKeys)).toEqual(sortKeys(sqlKeys));
    expect(config.uniqueConstraints.map((unique) => ({ name: unique.name, columns: unique.columns.map((column) => column.name) })))
      .toEqual(uniques(migrationSql, table));
  });

  it.each(DRIZZLE_TABLES)("%s: the same indexes, and every CHECK the migration names", (table, drizzle) => {
    const config = getTableConfig(drizzle);
    expect(config.indexes.map((index) => ({
      name: index.config.name, unique: index.config.unique, table,
      columns: index.config.columns.map((column) => (column as { name: string }).name),
      where: index.config.where === undefined ? null : "partial",
    }))).toEqual(indexes(migrationSql).filter((index) => index.table === table).map((index) => ({ ...index, where: index.where && "partial" })));
    // Names and shapes here (plan D20); what each CHECK refuses is proven in PostgreSQL.
    expect(config.checks.map((check) => check.name).sort()).toEqual([...checkBodies(migrationSql, table).keys()].sort());
  });
});

// ---------------------------------------------------------------------------
// SQL text helpers (each takes the migration text, so 0736 can be read too)

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

function withoutComments(sql: string): string {
  // No string literal in these files contains "--", so a line comment is everything after it.
  return sql.replace(/--[^\n]*/g, "");
}

function statements(sql: string): string[] {
  return withoutComments(sql)
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => normalize(statement))
    .filter((statement) => statement.length > 0);
}

function functionBody(sql: string, name: string): string {
  const escaped = name.replace(/\./g, "\\.");
  const match = new RegExp(`CREATE OR REPLACE FUNCTION ${escaped}\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$`).exec(sql);
  if (!match) throw new Error(`function body for ${name} not found`);
  return withoutComments(match[1]!);
}

function createTableBody(sql: string, table: string): string {
  const escaped = table.replace(/\./g, "\\.");
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
  if (!match) throw new Error(`CREATE TABLE ${table} not found`);
  return withoutComments(match[1]!);
}

/** The column types these tables may use. Money is integer cents, so numeric, real and double precision are refused. */
const COLUMN_TYPE = /^[a-z_]+ (bigint|integer|varchar\(\d+\)|text|jsonb|timestamptz)(?=\s|$)/;

/** Every column line of a CREATE TABLE body, whatever its type, so COLUMN_TYPE sees an unexpected one. */
function columnDefinitions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => /^[a-z_]+ [a-z]/.test(line));
}

function sqlColumns(table: string): Array<{ name: string; type: string; notNull: boolean }> {
  return columnDefinitions(createTableBody(migrationSql, table)).map((definition) => {
    const [name, type] = definition.split(/\s+/) as [string, string];
    return { name, type: type === "timestamptz" ? "timestamp with time zone" : type,
      notNull: /\bNOT NULL\b|\bPRIMARY KEY\b/.test(definition) || primaryKey(migrationSql, table)?.columns.includes(name) === true };
  });
}

interface ForeignKeyShape { name: string | null; columns: string[]; foreignTable: string; foreignColumns: string[] }

const list = (text: string) => text.split(",").map((part) => part.trim());

function foreignKeys(sql: string, table: string): ForeignKeyShape[] {
  const body = createTableBody(sql, table);
  const inline = columnDefinitions(body).flatMap((definition) => {
    const match = /^(\w+) .*\bREFERENCES ([\w.]+)\(([^)]*)\)/.exec(definition);
    return match ? [{ name: null, columns: [match[1]!], foreignTable: match[2]!, foreignColumns: list(match[3]!) }] : [];
  });
  const named = [...normalize(body).matchAll(/CONSTRAINT (\w+) FOREIGN KEY \(([^)]*)\) REFERENCES ([\w.]+)\(([^)]*)\)/g)]
    .map((match) => ({ name: match[1]!, columns: list(match[2]!), foreignTable: match[3]!, foreignColumns: list(match[4]!) }));
  return [...inline, ...named];
}

function uniques(sql: string, table: string): Array<{ name: string; columns: string[] }> {
  return [...normalize(createTableBody(sql, table)).matchAll(/CONSTRAINT (\w+) UNIQUE \(([^)]*)\)/g)]
    .map((match) => ({ name: match[1]!, columns: list(match[2]!) }));
}

function primaryKey(sql: string, table: string): { name: string; columns: string[] } | null {
  const match = /CONSTRAINT (\w+) PRIMARY KEY \(([^)]*)\)/.exec(normalize(createTableBody(sql, table)));
  return match ? { name: match[1]!, columns: list(match[2]!) } : null;
}

function checkBodies(sql: string, table: string): Map<string, string> {
  const body = normalize(createTableBody(sql, table));
  const checks = new Map<string, string>();
  for (const match of body.matchAll(/CONSTRAINT (\w+) CHECK ?\(/g)) {
    let depth = 1;
    let index = match.index! + match[0].length;
    const start = index;
    while (depth > 0) {
      if (body[index] === "(") depth += 1;
      if (body[index] === ")") depth -= 1;
      index += 1;
    }
    checks.set(match[1]!, body.slice(start, index - 1).trim());
  }
  return checks;
}

function indexes(sql: string): Array<{ name: string; unique: boolean; table: string; columns: string[]; where: string | null }> {
  return statements(sql).flatMap((statement) => {
    const match = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON ([\w.]+) \(([^)]*)\)(?: WHERE (.+))?$/.exec(statement);
    return match ? [{ name: match[2]!, unique: match[1] !== undefined, table: match[3]!, columns: list(match[4]!), where: match[5] ?? null }] : [];
  });
}

function triggers(sql: string): Array<{ name: string; timing: string; table: string; fn: string }> {
  return statements(sql).flatMap((statement) => {
    const match = /^CREATE TRIGGER (\w+) (BEFORE [A-Z ]+?) ON ([\w.]+) FOR EACH ROW EXECUTE FUNCTION ([\w.]+)\(\)$/.exec(statement);
    return match ? [{ name: match[1]!, timing: match[2]!, table: match[3]!, fn: match[4]! }] : [];
  });
}

function objectNames(sql: string): string[] {
  const text = withoutComments(sql);
  return [
    ...[...text.matchAll(/CONSTRAINT (\w+)/g)].map((match) => match[1]!),
    ...indexes(sql).map((index) => index.name),
    ...triggers(sql).map((trigger) => trigger.name),
    ...[...text.matchAll(/CREATE OR REPLACE FUNCTION dropship\.(\w+)\(/g)].map((match) => match[1]!),
    ...[...text.matchAll(/CREATE TABLE IF NOT EXISTS dropship\.(\w+)/g)].map((match) => match[1]!),
  ];
}

// ---------------------------------------------------------------------------
// Drizzle helpers

function drizzleColumns(table: PgTable): Array<{ name: string; type: string; notNull: boolean }> {
  return getTableConfig(table).columns.map((column) => ({ name: column.name, type: column.getSQLType(), notNull: column.notNull }));
}

/** Drizzle's foreign keys in the migration's shape; a key the migration leaves unnamed (inline REFERENCES) is compared by columns. */
function drizzleForeignKeys(table: PgTable, sql: readonly ForeignKeyShape[]): ForeignKeyShape[] {
  const sqlNames = new Set(sql.map((key) => key.name).filter((name): name is string => name !== null));
  return sortKeys(getTableConfig(table).foreignKeys.map((key) => {
    const reference = key.reference();
    const foreign = getTableConfig(reference.foreignTable);
    return {
      name: sqlNames.has(key.getName()) ? key.getName() : null,
      columns: reference.columns.map((column) => column.name),
      foreignTable: `${foreign.schema}.${foreign.name}`,
      foreignColumns: reference.foreignColumns.map((column) => column.name),
    };
  }));
}

function sortKeys(keys: readonly ForeignKeyShape[]): ForeignKeyShape[] {
  return [...keys].sort((left, right) => `${left.name ?? ""}:${left.columns}`.localeCompare(`${right.name ?? ""}:${right.columns}`));
}
