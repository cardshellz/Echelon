import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  dropshipProductListingSettingRequests,
  dropshipProductListingSettingRevisions,
  dropshipProductListingSettings,
} from "../../../../../shared/schema/dropship.schema";
import { pricingRecipeSchema } from "../../../../../shared/dropship/pricing-rules";
import { MAX_LISTING_PRICE_CENTS } from "../../../../../shared/dropship/listing-price";
import {
  EBAY_CATEGORY_ID_PATTERN,
  MAX_EBAY_CATEGORY_NAME_LENGTH,
  MAX_EBAY_CATEGORY_PATH_DEPTH,
} from "../../../../../shared/dropship/ebay-category-rules";
import { MAX_DESCRIPTION_TEXT_LENGTH, MAX_TEMPLATE_TEXT_LENGTH } from "../../../../../shared/dropship/listing-content";
import type { PricingRecipe } from "../../../../../shared/dropship/pricing-rules";
import {
  LISTING_SETTING_ACTOR_TYPES,
  LISTING_SETTING_KEY_PATTERN,
  LISTING_SETTING_REQUEST_OPERATIONS,
  LISTING_SETTING_VALUE_MODES,
  MAX_LISTING_POLICY_ID_LENGTH,
  MAX_LISTING_POLICY_NAME_LENGTH,
  MAX_LISTING_SETTING_BULK_PRODUCTS,
  MAX_LISTING_STORE_SHELVES,
  type ListingSettingActorType,
  type ListingSettingRequestOperation,
  type ListingSettingStoreShelf,
  type ListingSettingTemplateText,
} from "../../../../../shared/dropship/listing-setting-values";
import type { ListingSettingActor, ProductListingSettingsBulkInput } from "../../application/dropship-listing-setting-writes";
import {
  LISTING_SETTING_VALUE_COLUMN_TYPES,
  MAX_LISTING_SETTING_ACTOR_ID_LENGTH,
  PRODUCT_LISTING_SETTING_VALUE_COLUMNS,
} from "../../infrastructure/dropship-listing-setting-shared.repository";

const MIGRATION_FILE = "0736_dropship_product_listing_settings.sql";
const migrationSql = readFileSync(resolve(process.cwd(), "migrations", MIGRATION_FILE), "utf8");

const LEDGER_TABLE = "dropship.dropship_product_listing_setting_requests";
const REVISIONS_TABLE = "dropship.dropship_product_listing_setting_revisions";
const SETTINGS_TABLE = "dropship.dropship_product_listing_settings";

// The CHECKs list these values; the shared contracts and the writers' port
// must not drift from them. Each tuple is checked both ways at compile time
// (`npm run check:tests`), and against the SQL and the contracts' runtime
// values (order included) by the tests below.
const REQUEST_OPERATIONS = ["product_settings_bulk", "category_settings_clear", "category_moves_acknowledge"] as const;
const ACTOR_TYPES = ["vendor", "admin", "system"] as const;
const PRICE_BASES = ["product_cost", "catalog_retail"] as const;
const PRICE_ROUNDINGS = ["cent", "up_99"] as const;
/** Shelf and text-part modes; "follow the default" is SQL NULL, not a mode. */
const VALUE_MODES = ["none", "own"] as const;
const REQUEST_KEY_PATTERN = "^[A-Za-z0-9:_-]{8,200}$";
const REQUEST_HASH_PATTERN = "^[a-f0-9]{64}$";
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const operationsMatchTheContract: Exact<typeof REQUEST_OPERATIONS[number], ListingSettingRequestOperation> = true;
// The bulk writer takes two operations and the acknowledge writer the third; together they are the ledger's.
const operationsMatchTheWriters: Exact<
  typeof REQUEST_OPERATIONS[number], ProductListingSettingsBulkInput["operation"] | "category_moves_acknowledge"
> = true;
const actorTypesMatchTheContract: Exact<typeof ACTOR_TYPES[number], ListingSettingActorType> = true;
const actorTypesMatchThePort: Exact<typeof ACTOR_TYPES[number], ListingSettingActor["actorType"]> = true;
const basesMatchTheRecipe: Exact<typeof PRICE_BASES[number], PricingRecipe["basis"]> = true;
const roundingsMatchTheRecipe: Exact<typeof PRICE_ROUNDINGS[number], PricingRecipe["rounding"]> = true;
const modesMatchTheContract: Exact<typeof VALUE_MODES[number], typeof LISTING_SETTING_VALUE_MODES[number]> = true;
const shelfModesMatchTheContract: Exact<typeof VALUE_MODES[number], ListingSettingStoreShelf["mode"]> = true;
const textModesMatchTheContract: Exact<typeof VALUE_MODES[number], ListingSettingTemplateText["mode"]> = true;

/** Every value column a revision carries; null means "follow the default". */
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
  "body_text text",
  "body_catalog_hash varchar(64)",
] as const;

const DRIZZLE_TABLES: ReadonlyArray<readonly [string, PgTable]> = [
  [LEDGER_TABLE, dropshipProductListingSettingRequests],
  [REVISIONS_TABLE, dropshipProductListingSettingRevisions],
  [SETTINGS_TABLE, dropshipProductListingSettings],
];

describe("0736 dropship product listing settings migration", () => {
  it("is the only migration with its number", () => {
    const sameNumber = readdirSync(resolve(process.cwd(), "migrations")).filter((file) => file.startsWith("0736_"));
    expect(sameNumber).toEqual([MIGRATION_FILE]);
  });

  it("leaves the transaction to the release executor: no BEGIN, COMMIT or ROLLBACK of its own", () => {
    // BEGIN inside a plpgsql body opens a block, not a transaction; statements() collapses the bodies.
    for (const statement of statements()) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION|END|SAVEPOINT)\b/i);
    }
    expect(migrationSql).not.toMatch(/^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
    expect(migrationSql).not.toMatch(/\bCONCURRENTLY\b/i);
  });

  it("says why, what changes for live data, the lock order and who owns the transaction", () => {
    const header = normalize(migrationSql.slice(0, migrationSql.indexOf("CREATE TABLE")).replace(/^--\s?/gm, ""));
    expect(header).toContain("Nothing changes for live data: the three tables are new and start empty, and no existing table is altered.");
    expect(header).toContain("Lock order: the ledger is created first, because revisions reference it.");
    expect(header).toContain(
      "In statement order the foreign keys take SHARE ROW EXCLUSIVE on the vendor table, then the store connection table, "
      + "then the Card Shellz products table, until commit.",
    );
    expect(header).toContain("The release executor owns the transaction, including its migration record. Additive and re-runnable.");
  });

  it("creates the ledger, then the revisions, then the current rows, each with its indexes", () => {
    const all = statements();
    const created = all.flatMap((statement, index) => {
      const table = /^CREATE TABLE IF NOT EXISTS ([\w.]+) \(/.exec(statement)?.[1];
      return table ? [{ table, index }] : [];
    });
    expect(created.map(({ table }) => table)).toEqual([LEDGER_TABLE, REVISIONS_TABLE, SETTINGS_TABLE]);
    // The foreign keys of each table point only at tables created before it (or at itself).
    expect(createTableBody(LEDGER_TABLE)).not.toContain("dropship_product_listing_setting_revisions");
    expect(createTableBody(REVISIONS_TABLE)).not.toContain("dropship.dropship_product_listing_settings(");
    expect(createTableBody(REVISIONS_TABLE)).toContain(`REFERENCES ${LEDGER_TABLE}(id, vendor_id, store_connection_id)`);
    expect(createTableBody(SETTINGS_TABLE)).toContain(`REFERENCES ${REVISIONS_TABLE}(id, vendor_id, store_connection_id, product_id)`);
    // Every trigger comes after the table it guards.
    for (const trigger of triggers()) {
      expect(all.indexOf(trigger.statement)).toBeGreaterThan(created.find(({ table }) => table === trigger.table)!.index);
    }
  });

  describe("the request ledger", () => {
    it("keeps who asked, for which store, with which key and hash, and how many rows it wrote", () => {
      expect(columnDefinitions(createTableBody(LEDGER_TABLE))).toEqual([
        "id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        "store_connection_id integer NOT NULL",
        "operation varchar(60) NOT NULL",
        "idempotency_key varchar(200) NOT NULL",
        "request_hash varchar(64) NOT NULL",
        "product_count integer NOT NULL",
        "actor_type varchar(40) NOT NULL",
        "actor_id varchar(255) NOT NULL",
        "created_at timestamptz NOT NULL",
      ]);
      // W7's review link is PR 9's migration (plan D5); nothing here names a review.
      expect(migrationSql).not.toMatch(/review_id|pricing_reviews|price_change_apply/);
    });

    it("lists exactly the PR 8 operations and allows a request that wrote nothing", () => {
      expect(inList(createTableBody(LEDGER_TABLE), "operation")).toEqual([...REQUEST_OPERATIONS]);
      expect(normalize(createTableBody(LEDGER_TABLE))).toContain(
        "CONSTRAINT dropship_product_listing_setting_requests_count_chk CHECK (product_count BETWEEN 0 AND 10000)",
      );
    });

    it("names one request per vendor key, whatever store it was for, and indexes a store's history", () => {
      expect(indexes()).toContainEqual({ name: "dropship_product_listing_setting_requests_key_idx", unique: true,
        table: LEDGER_TABLE, columns: ["vendor_id", "idempotency_key"], where: null });
      expect(indexes()).toContainEqual({ name: "dropship_product_listing_setting_requests_store_idx", unique: false,
        table: LEDGER_TABLE, columns: ["store_connection_id", "created_at"], where: null });
      // Revisions written by a request reference it through this triple.
      expect(uniques(LEDGER_TABLE)).toEqual([
        { name: "dropship_product_listing_setting_requests_identity_uk", columns: ["id", "vendor_id", "store_connection_id"] },
      ]);
    });

    it("is append-only: every UPDATE and DELETE raises 23514", () => {
      expect(normalize(functionBody("dropship.guard_product_listing_setting_request_append_only"))).toBe(
        "BEGIN RAISE EXCEPTION 'Product listing setting requests are append-only: rows cannot be updated or deleted' "
        + "USING ERRCODE = '23514'; END;",
      );
      expect(triggers()).toContainEqual(expect.objectContaining({
        name: "product_listing_setting_request_append_only", timing: "BEFORE UPDATE OR DELETE", table: LEDGER_TABLE,
        fn: "dropship.guard_product_listing_setting_request_append_only",
      }));
    });
  });

  describe("the revisions", () => {
    it("carry identity, chain and request links, every value column and the request columns, in that order", () => {
      expect(columnDefinitions(createTableBody(REVISIONS_TABLE))).toEqual([
        "id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY",
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        "store_connection_id integer NOT NULL",
        "product_id integer NOT NULL",
        "previous_revision_id integer",
        "request_id bigint",
        ...VALUE_COLUMNS,
        "idempotency_key varchar(200) NOT NULL",
        "request_hash varchar(64) NOT NULL",
        "actor_type varchar(40) NOT NULL",
        "actor_id varchar(255) NOT NULL",
        "created_at timestamptz NOT NULL",
      ]);
      // The main text needs no mode: a null text is the Card Shellz text (plan D9).
      expect(migrationSql).not.toContain("body_mode");
    });

    it("size their columns to the shared contracts' bounds", () => {
      expect(createTableBody(REVISIONS_TABLE)).toContain(`ebay_category_name varchar(${MAX_EBAY_CATEGORY_NAME_LENGTH})`);
      const checks = checkBodies(REVISIONS_TABLE);
      expect(checks.get("dropship_product_listing_setting_revision_price_chk"))
        .toContain(`price_flat_cents BETWEEN 0 AND ${MAX_LISTING_PRICE_CENTS}`);
      expect(checks.get("dropship_product_listing_setting_revision_price_chk")).toContain("price_markup_bps BETWEEN 0 AND 1000000");
      expect(pricingRecipeSchema.shape.markupBps.safeParse(1_000_000).success).toBe(true);
      expect(pricingRecipeSchema.shape.markupBps.safeParse(1_000_001).success).toBe(false);
      expect(checks.get("dropship_product_listing_setting_revision_ebay_category_chk"))
        .toContain(`ebay_category_id ~ '${EBAY_CATEGORY_ID_PATTERN.source}'`);
      expect(checks.get("dropship_product_listing_setting_revision_ebay_category_chk"))
        .toContain(`jsonb_array_length(ebay_category_path) BETWEEN 1 AND ${MAX_EBAY_CATEGORY_PATH_DEPTH}`);
      expect(checks.get("dropship_product_listing_setting_revision_text_chk"))
        .toContain(`length(text_above) <= ${MAX_TEMPLATE_TEXT_LENGTH}`);
      expect(checks.get("dropship_product_listing_setting_revision_text_chk"))
        .toContain(`length(text_below) <= ${MAX_TEMPLATE_TEXT_LENGTH}`);
      expect(checks.get("dropship_product_listing_setting_revision_body_chk"))
        .toContain(`length(body_text) <= ${MAX_DESCRIPTION_TEXT_LENGTH}`);
    });

    it("keep each value group all or none without relying on a NULL CHECK result", () => {
      const checks = checkBodies(REVISIONS_TABLE);
      expect(checks.get("dropship_product_listing_setting_revision_price_chk")).toMatch(
        /^num_nonnulls\(price_basis, price_markup_bps, price_flat_cents, price_rounding\) = 0 OR \(num_nonnulls\(price_basis, price_markup_bps, price_flat_cents, price_rounding\) = 4 AND /,
      );
      expect(checks.get("dropship_product_listing_setting_revision_ebay_category_chk")).toMatch(
        /^num_nonnulls\(ebay_category_id, ebay_category_name, ebay_category_path\) = 0 OR \(num_nonnulls\(ebay_category_id, ebay_category_name, ebay_category_path\) = 3 AND /,
      );
      // A comparison on a null mode is NULL, which a CHECK accepts: each "own" branch tests the mode IS NOT NULL first.
      expect(checks.get("dropship_product_listing_setting_revision_shelf_chk")).toContain(
        "OR (shelf_mode IS NOT NULL AND shelf_mode = 'own' AND shelf_ids IS NOT NULL AND shelf_names IS NOT NULL AND ",
      );
      for (const part of ["above", "below"]) {
        expect(checks.get("dropship_product_listing_setting_revision_text_chk")).toContain(
          `OR (text_${part}_mode IS NOT NULL AND text_${part}_mode = 'own' AND text_${part} IS NOT NULL AND `,
        );
      }
      expect(checks.get("dropship_product_listing_setting_revision_body_chk")).toBe(
        "(body_text IS NULL AND body_catalog_hash IS NULL) OR (body_text IS NOT NULL AND body_catalog_hash IS NOT NULL "
        + "AND length(btrim(body_text)) > 0 AND length(body_text) <= 20000 AND body_catalog_hash ~ '^[a-f0-9]{64}$')",
      );
      // Every equality on a nullable value column sits behind its own IS [NOT] NULL test.
      for (const [name, body] of checks) {
        for (const match of body.matchAll(/\b(shelf_mode|text_above_mode|text_below_mode) = '(\w+)'/g)) {
          const guard = match[2] === "none" ? `${match[1]} IS NULL OR ${match[0]}` : `${match[1]} IS NOT NULL AND ${match[0]}`;
          expect(body, name).toContain(guard);
        }
      }
    });

    it("pin the recipe, shelf and text values to the contracts", () => {
      const checks = checkBodies(REVISIONS_TABLE);
      const price = checks.get("dropship_product_listing_setting_revision_price_chk")!;
      expect(inList(price, "price_basis")).toEqual([...PRICE_BASES]);
      expect(inList(price, "price_rounding")).toEqual([...PRICE_ROUNDINGS]);
      expect(pricingRecipeSchema.shape.basis.options).toEqual([...PRICE_BASES]);
      expect(pricingRecipeSchema.shape.rounding.options).toEqual([...PRICE_ROUNDINGS]);
      expect([...checks.get("dropship_product_listing_setting_revision_shelf_chk")!.matchAll(/shelf_mode = '(\w+)'/g)]
        .map((match) => match[1])).toEqual([...VALUE_MODES]);
      for (const part of ["above", "below"]) {
        expect([...checks.get("dropship_product_listing_setting_revision_text_chk")!.matchAll(new RegExp(`text_${part}_mode = '(\\w+)'`, "g"))]
          .map((match) => match[1]), part).toEqual([...VALUE_MODES]);
      }
      expect([...LISTING_SETTING_VALUE_MODES]).toEqual([...VALUE_MODES]);
      expect(checks.get("dropship_product_listing_setting_revision_shelf_chk"))
        .toContain(`jsonb_array_length(shelf_ids) BETWEEN 1 AND ${MAX_LISTING_STORE_SHELVES}`);
      expect(checks.get("dropship_product_listing_setting_revision_shelf_chk"))
        .toContain("jsonb_array_length(shelf_names) = jsonb_array_length(shelf_ids)");
    });

    it("keep a policy name only with its id, and never a blank id or name", () => {
      const policy = checkBodies(REVISIONS_TABLE).get("dropship_product_listing_setting_revision_policy_chk")!;
      for (const kind of ["fulfillment", "return", "payment"]) {
        expect(policy).toContain(`(${kind}_policy_id IS NOT NULL OR ${kind}_policy_name IS NULL)`);
        expect(policy).toContain(`(${kind}_policy_id IS NULL OR btrim(${kind}_policy_id) <> '')`);
        expect(policy).toContain(`(${kind}_policy_name IS NULL OR btrim(${kind}_policy_name) <> '')`);
      }
    });

    it("chain inside one vendor, store and product, and link a bulk revision to its request", () => {
      expect(foreignKeys(REVISIONS_TABLE)).toEqual([
        { name: null, columns: ["vendor_id"], foreignTable: "dropship.dropship_vendors", foreignColumns: ["id"] },
        { name: "dropship_product_listing_setting_revision_owner_fk", columns: ["store_connection_id", "vendor_id"],
          foreignTable: "dropship.dropship_store_connections", foreignColumns: ["id", "vendor_id"] },
        { name: "dropship_product_listing_setting_revision_product_fk", columns: ["product_id"],
          foreignTable: "catalog.products", foreignColumns: ["id"] },
        { name: "dropship_product_listing_setting_revision_previous_fk",
          columns: ["previous_revision_id", "vendor_id", "store_connection_id", "product_id"],
          foreignTable: REVISIONS_TABLE, foreignColumns: ["id", "vendor_id", "store_connection_id", "product_id"] },
        { name: "dropship_product_listing_setting_revision_request_fk", columns: ["request_id", "vendor_id", "store_connection_id"],
          foreignTable: LEDGER_TABLE, foreignColumns: ["id", "vendor_id", "store_connection_id"] },
      ]);
      expect(uniques(REVISIONS_TABLE)).toEqual([
        { name: "dropship_product_listing_setting_revision_identity_uk", columns: ["id", "vendor_id", "store_connection_id", "product_id"] },
        { name: "dropship_product_listing_setting_revision_key_uk", columns: ["vendor_id", "idempotency_key"] },
      ]);
      expect(indexes()).toContainEqual({ name: "dropship_product_listing_setting_revision_target_idx", unique: false,
        table: REVISIONS_TABLE, columns: ["store_connection_id", "product_id", "id"], where: null });
      expect(indexes()).toContainEqual({ name: "dropship_product_listing_setting_revision_request_idx", unique: false,
        table: REVISIONS_TABLE, columns: ["request_id"], where: "request_id IS NOT NULL" });
    });

    it("are immutable: every UPDATE and DELETE raises 23514", () => {
      expect(normalize(functionBody("dropship.guard_product_listing_setting_revision_immutable"))).toBe(
        "BEGIN RAISE EXCEPTION 'Product listing setting revisions are immutable; create a new revision' USING ERRCODE = '23514'; END;",
      );
      expect(triggers()).toContainEqual(expect.objectContaining({
        name: "product_listing_setting_revision_immutable", timing: "BEFORE UPDATE OR DELETE", table: REVISIONS_TABLE,
        fn: "dropship.guard_product_listing_setting_revision_immutable",
      }));
    });
  });

  describe("the current rows", () => {
    it("only point at their revision", () => {
      expect(columnDefinitions(createTableBody(SETTINGS_TABLE))).toEqual([
        "vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id)",
        "store_connection_id integer NOT NULL",
        "product_id integer NOT NULL",
        "revision_id integer NOT NULL",
      ]);
      expect(primaryKey(SETTINGS_TABLE)).toEqual({ name: "dropship_product_listing_setting_pk", columns: ["store_connection_id", "product_id"] });
      expect(foreignKeys(SETTINGS_TABLE)).toEqual([
        { name: null, columns: ["vendor_id"], foreignTable: "dropship.dropship_vendors", foreignColumns: ["id"] },
        { name: "dropship_product_listing_setting_owner_fk", columns: ["store_connection_id", "vendor_id"],
          foreignTable: "dropship.dropship_store_connections", foreignColumns: ["id", "vendor_id"] },
        { name: "dropship_product_listing_setting_product_fk", columns: ["product_id"],
          foreignTable: "catalog.products", foreignColumns: ["id"] },
        { name: "dropship_product_listing_setting_revision_fk", columns: ["revision_id", "vendor_id", "store_connection_id", "product_id"],
          foreignTable: REVISIONS_TABLE, foreignColumns: ["id", "vendor_id", "store_connection_id", "product_id"] },
      ]);
      expect(indexes()).toContainEqual({ name: "dropship_product_listing_setting_vendor_idx", unique: false,
        table: SETTINGS_TABLE, columns: ["vendor_id", "store_connection_id"], where: null });
    });

    it("refuse deletes, identity changes and a revision whose predecessor is not the current one", () => {
      const body = normalize(functionBody("dropship.guard_product_listing_setting_coherence"));
      expect(body).toContain("IF TG_OP = 'DELETE' THEN RAISE EXCEPTION "
        + "'Reset product listing settings with a new revision, not deletion' USING ERRCODE = '23514'; END IF;");
      expect(body).toContain("IF TG_OP = 'UPDATE' AND (OLD.vendor_id <> NEW.vendor_id OR OLD.store_connection_id <> NEW.store_connection_id "
        + "OR OLD.product_id <> NEW.product_id) THEN RAISE EXCEPTION 'Product listing setting identity cannot change' USING ERRCODE = '23514';");
      expect(body).toContain("IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;");
      expect(body).toContain(`SELECT previous_revision_id INTO predecessor FROM ${REVISIONS_TABLE} WHERE id = NEW.revision_id;`);
      expect(body).toContain(`IF predecessor IS DISTINCT FROM (SELECT revision_id FROM ${SETTINGS_TABLE} `
        + "WHERE store_connection_id = NEW.store_connection_id AND product_id = NEW.product_id) THEN RAISE EXCEPTION "
        + "'Product listing setting predecessor does not match the current setting' USING ERRCODE = '23514';");
      expect(triggers()).toContainEqual(expect.objectContaining({
        name: "product_listing_setting_coherence", timing: "BEFORE INSERT OR UPDATE OR DELETE", table: SETTINGS_TABLE,
        fn: "dropship.guard_product_listing_setting_coherence",
      }));
    });
  });

  it("ties every table to a store of the same vendor through the composite owner FK, never a single-column store FK", () => {
    for (const table of [LEDGER_TABLE, REVISIONS_TABLE, SETTINGS_TABLE]) {
      const storeReferences = foreignKeys(table).filter((key) => key.foreignTable === "dropship.dropship_store_connections");
      expect(storeReferences, table).toEqual([expect.objectContaining({
        columns: ["store_connection_id", "vendor_id"], foreignColumns: ["id", "vendor_id"],
      })]);
      expect(columnDefinitions(createTableBody(table))).toContain("store_connection_id integer NOT NULL");
    }
    // The composite FK needs this unique index, which an earlier migration creates.
    const ownerIdentity = readFileSync(resolve(process.cwd(), "migrations/0657_dropship_listing_price_settings.sql"), "utf8");
    expect(ownerIdentity).toContain("CREATE UNIQUE INDEX IF NOT EXISTS dropship_store_conn_owner_identity_idx\n"
      + "  ON dropship.dropship_store_connections (id, vendor_id);");
    expect("0657_dropship_listing_price_settings.sql" < MIGRATION_FILE).toBe(true);
  });

  it("types every column as a whole number, varchar, text, jsonb or timestamptz: no floating-point or numeric money", () => {
    for (const table of [LEDGER_TABLE, REVISIONS_TABLE, SETTINGS_TABLE]) {
      for (const definition of columnDefinitions(createTableBody(table))) expect(definition, table).toMatch(COLUMN_TYPE);
    }
  });

  it("cascades nothing: no ON DELETE or ON UPDATE action anywhere", () => {
    expect(withoutComments(migrationSql)).not.toMatch(/\bON\s+(DELETE|UPDATE)\b/i);
  });

  it("lets the application's injected clock stamp every row: no DEFAULT anywhere", () => {
    expect(withoutComments(migrationSql)).not.toMatch(/\bDEFAULT\b/i);
  });

  it("accepts exactly the request keys and hashes the other listing ledgers accept", () => {
    expect(checkBodies(LEDGER_TABLE).get("dropship_product_listing_setting_requests_key_chk"))
      .toBe(`idempotency_key ~ '${REQUEST_KEY_PATTERN}'`);
    expect(checkBodies(REVISIONS_TABLE).get("dropship_product_listing_setting_revision_key_chk"))
      .toBe(`idempotency_key ~ '${REQUEST_KEY_PATTERN}'`);
    expect(checkBodies(LEDGER_TABLE).get("dropship_product_listing_setting_requests_hash_chk"))
      .toBe(`request_hash ~ '${REQUEST_HASH_PATTERN}'`);
    expect(checkBodies(REVISIONS_TABLE).get("dropship_product_listing_setting_revision_hash_chk"))
      .toBe(`request_hash ~ '${REQUEST_HASH_PATTERN}'`);
    // The same key CHECK as the listing config ledger (0728).
    expect(readFileSync(resolve(process.cwd(), "migrations/0728_dropship_listing_config_revision.sql"), "utf8"))
      .toContain(`CHECK (idempotency_key ~ '${REQUEST_KEY_PATTERN}')`);
    for (const table of [LEDGER_TABLE, REVISIONS_TABLE]) {
      const checks = [...checkBodies(table).values()];
      expect(checks, table).toContain(`actor_type IN (${sqlList(ACTOR_TYPES)})`);
      expect(checks, table).toContain("btrim(actor_id) <> ''");
    }
  });

  it("matches the shared listing-setting contracts and the writers' column map, value for value and in order", () => {
    // The tuples above are the contracts' runtime values (their types are pinned at compile time).
    expect([...LISTING_SETTING_REQUEST_OPERATIONS]).toEqual([...REQUEST_OPERATIONS]);
    expect([...LISTING_SETTING_ACTOR_TYPES]).toEqual([...ACTOR_TYPES]);
    expect(LISTING_SETTING_KEY_PATTERN.source).toBe(REQUEST_KEY_PATTERN);
    expect(LISTING_SETTING_KEY_PATTERN.flags).toBe("");
    // The writers' bounds are the columns' and CHECKs' bounds.
    expect(normalize(createTableBody(LEDGER_TABLE)))
      .toContain(`CHECK (product_count BETWEEN 0 AND ${MAX_LISTING_SETTING_BULK_PRODUCTS})`);
    for (const table of [LEDGER_TABLE, REVISIONS_TABLE]) {
      expect(columnDefinitions(createTableBody(table)), table).toContain(`actor_id varchar(${MAX_LISTING_SETTING_ACTOR_ID_LENGTH}) NOT NULL`);
    }
    for (const kind of ["fulfillment", "return", "payment"]) {
      expect(VALUE_COLUMNS).toContain(`${kind}_policy_id varchar(${MAX_LISTING_POLICY_ID_LENGTH})`);
      expect(VALUE_COLUMNS).toContain(`${kind}_policy_name varchar(${MAX_LISTING_POLICY_NAME_LENGTH})`);
    }
    // The column map the writers insert and read: the revision's value columns, in table order, each with its type.
    expect(VALUE_COLUMNS.map((definition) => definition.split(" ")[0])).toEqual([...PRODUCT_LISTING_SETTING_VALUE_COLUMNS]);
    for (const definition of VALUE_COLUMNS) {
      const [column, sqlType] = definition.split(" ") as [keyof typeof LISTING_SETTING_VALUE_COLUMN_TYPES, string];
      const recordsetType = sqlType === "jsonb" ? "jsonb" : sqlType === "integer" ? "integer" : "text";
      expect(LISTING_SETTING_VALUE_COLUMN_TYPES[column], column).toBe(recordsetType);
    }
  });

  it("names every constraint and object within PostgreSQL's 63 bytes, without digits, once", () => {
    const names = objectNames();
    expect(names.length).toBeGreaterThan(30);
    for (const name of names) {
      expect(Buffer.byteLength(name), name).toBeLessThanOrEqual(63);
      // The listing-settings suite's isolation maps only [a-z_] object names.
      expect(name, name).toMatch(/^[a-z_]+$/);
    }
    expect(new Set(names).size).toBe(names.length);
    // Every trigger function is a dropship.guard_* function.
    expect(triggers().map((trigger) => trigger.fn)).toEqual([
      "dropship.guard_product_listing_setting_revision_immutable",
      "dropship.guard_product_listing_setting_coherence",
      "dropship.guard_product_listing_setting_request_append_only",
    ]);
    for (const statement of statements().filter((statement) => statement.startsWith("CREATE OR REPLACE FUNCTION"))) {
      expect(statement).toMatch(/^CREATE OR REPLACE FUNCTION dropship\.guard_[a-z_]+\(\) RETURNS trigger LANGUAGE plpgsql AS <<plpgsql body>>$/);
    }
  });

  it("names no schema-qualified object in a comment, and nothing from the 215 or 217 migrations", () => {
    // Suites that map object names into an isolated schema rewrite comments too.
    const comments = migrationSql.match(/--[^\n]*/g) ?? [];
    expect(comments.length).toBeGreaterThan(10);
    for (const comment of comments) {
      expect(comment).not.toMatch(/\b(dropship|catalog|membership|channels|public|ebay)\.[a-z_]/);
    }
    // 215/217 sort after 07xx on a fresh database, so their objects may not exist yet.
    for (const file of ["215_dropship_ebay_product_category_scope.sql", "217_dropship_ebay_listing_policy_overrides.sql"]) {
      const later = readFileSync(resolve(process.cwd(), "migrations", file), "utf8");
      const laterObjects = [...later.matchAll(/CREATE (?:TABLE|UNIQUE INDEX|INDEX) IF NOT EXISTS (?:dropship\.)?(\w+)/g)].map((match) => match[1]!);
      expect(laterObjects.length).toBeGreaterThan(0);
      for (const object of laterObjects) expect(migrationSql, object).not.toContain(object);
    }
  });

  it("is additive: no data change, nothing dropped but its own triggers, nothing existing altered", () => {
    for (const statement of statements()) {
      expect(statement, statement.slice(0, 80)).not.toMatch(/^(UPDATE|DELETE|INSERT|TRUNCATE|ALTER)\b/i);
      expect(statement, statement.slice(0, 80)).not.toMatch(/\bDROP\s+(COLUMN|TABLE|INDEX|SCHEMA|FUNCTION|CONSTRAINT)\b/i);
    }
  });

  it("is re-runnable: every statement is guarded", () => {
    const droppedTriggers = new Set<string>();
    const all = statements();
    expect(all).toHaveLength(17);
    for (const statement of all) {
      const droppedTrigger = /^DROP TRIGGER IF EXISTS (\w+)\s+ON ([\w.]+)$/i.exec(statement);
      if (droppedTrigger) droppedTriggers.add(`${droppedTrigger[1]} ON ${droppedTrigger[2]}`);
      const createdTrigger = /^CREATE TRIGGER (\w+)\s+BEFORE [\w\s]+? ON ([\w.]+)\s/i.exec(statement);
      const guarded =
        /^CREATE TABLE IF NOT EXISTS\b/i.test(statement)
        || /^CREATE (UNIQUE )?INDEX IF NOT EXISTS\b/i.test(statement)
        || /^CREATE OR REPLACE FUNCTION\b/i.test(statement)
        || droppedTrigger !== null
        // A CREATE TRIGGER is safe only because the same trigger was dropped IF EXISTS on the same table before it.
        || (createdTrigger !== null && droppedTriggers.has(`${createdTrigger[1]} ON ${createdTrigger[2]}`));
      expect(guarded, `unguarded statement: ${statement.slice(0, 80)}`).toBe(true);
    }
  });
});

describe("Drizzle declarations of the 0736 tables", () => {
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
      .toEqual(table === SETTINGS_TABLE ? [] : [["id", "always"]]);
  });

  it.each(DRIZZLE_TABLES)("%s: the same primary key, foreign keys and unique constraints, by name and columns", (table, drizzle) => {
    const config = getTableConfig(drizzle);
    const sqlPrimaryKey = primaryKey(table);
    expect(config.primaryKeys.map((key) => ({ name: key.getName(), columns: key.columns.map((column) => column.name) })))
      .toEqual(sqlPrimaryKey ? [sqlPrimaryKey] : []);
    expect(drizzleForeignKeys(drizzle, foreignKeys(table))).toEqual(sortKeys(foreignKeys(table)));
    expect(config.uniqueConstraints.map((unique) => ({ name: unique.name, columns: unique.columns.map((column) => column.name) })))
      .toEqual(uniques(table));
  });

  it.each(DRIZZLE_TABLES)("%s: the same indexes, and every CHECK the migration names", (table, drizzle) => {
    const config = getTableConfig(drizzle);
    expect(config.indexes.map((index) => ({
      name: index.config.name, unique: index.config.unique, table,
      columns: index.config.columns.map((column) => (column as { name: string }).name),
      where: index.config.where === undefined ? null : "partial",
    }))).toEqual(indexes().filter((index) => index.table === table).map((index) => ({ ...index, where: index.where && "partial" })));
    // Names and shapes here (plan D20); what each CHECK refuses is proven in PostgreSQL.
    expect(config.checks.map((check) => check.name).sort()).toEqual([...checkBodies(table).keys()].sort());
  });
});

// ---------------------------------------------------------------------------
// SQL text helpers

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

function withoutComments(sql: string): string {
  // No string literal in this file contains "--", so a line comment is everything after it.
  return sql.replace(/--[^\n]*/g, "");
}

/** The migration's statements: comments removed, dollar-quoted function bodies collapsed, split on ";". */
function statements(): string[] {
  return withoutComments(migrationSql)
    .replace(/\$\$[\s\S]*?\$\$/g, () => "<<plpgsql body>>")
    .split(/;\s*$/m)
    .map((statement) => normalize(statement))
    .filter((statement) => statement.length > 0);
}

/** The plpgsql body (between the $$ quotes) of the named function. */
function functionBody(name: string): string {
  const escaped = name.replace(/\./g, "\\.");
  const match = new RegExp(`CREATE OR REPLACE FUNCTION ${escaped}\\(\\) RETURNS trigger LANGUAGE plpgsql AS \\$\\$([\\s\\S]*?)\\$\\$`)
    .exec(migrationSql);
  if (!match) throw new Error(`function body for ${name} not found`);
  return withoutComments(match[1]!);
}

/** The text between the parentheses of CREATE TABLE IF NOT EXISTS <table> ( ... );, comments removed. */
function createTableBody(table: string): string {
  const escaped = table.replace(/\./g, "\\.");
  const match = new RegExp(`CREATE TABLE IF NOT EXISTS ${escaped} \\(([\\s\\S]*?)\\n\\);`).exec(migrationSql);
  if (!match) throw new Error(`CREATE TABLE ${table} not found`);
  return withoutComments(match[1]!);
}

/** The column types these tables may use. Money is integer cents, so numeric, real and double precision are refused. */
const COLUMN_TYPE = /^[a-z_]+ (bigint|integer|varchar\(\d+\)|text|jsonb|timestamptz)(?=\s|$)/;

/**
 * Column definitions of a CREATE TABLE body (a name, then a type), one per line;
 * constraints left out. Any lower-case type is kept, so a column of an
 * unexpected type is caught by COLUMN_TYPE rather than skipped.
 */
function columnDefinitions(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => /^[a-z_]+ [a-z]/.test(line));
}

/** Every column with its SQL type and NOT NULL, in the drizzle getSQLType() spelling. */
function sqlColumns(table: string): Array<{ name: string; type: string; notNull: boolean }> {
  return columnDefinitions(createTableBody(table)).map((definition) => {
    const [name, type] = definition.split(/\s+/) as [string, string];
    return { name, type: type === "timestamptz" ? "timestamp with time zone" : type,
      notNull: /\bNOT NULL\b|\bPRIMARY KEY\b/.test(definition) || primaryKey(table)?.columns.includes(name) === true };
  });
}

interface ForeignKeyShape { name: string | null; columns: string[]; foreignTable: string; foreignColumns: string[] }

const list = (text: string) => text.split(",").map((part) => part.trim());

/** Named FOREIGN KEY constraints and inline REFERENCES (name null), in the order the table declares them. */
function foreignKeys(table: string): ForeignKeyShape[] {
  const body = createTableBody(table);
  const inline = columnDefinitions(body).flatMap((definition) => {
    const match = /^(\w+) .*\bREFERENCES ([\w.]+)\(([^)]*)\)/.exec(definition);
    return match ? [{ name: null, columns: [match[1]!], foreignTable: match[2]!, foreignColumns: list(match[3]!) }] : [];
  });
  const named = [...normalize(body).matchAll(/CONSTRAINT (\w+) FOREIGN KEY \(([^)]*)\) REFERENCES ([\w.]+)\(([^)]*)\)/g)]
    .map((match) => ({ name: match[1]!, columns: list(match[2]!), foreignTable: match[3]!, foreignColumns: list(match[4]!) }));
  return [...inline, ...named];
}

function uniques(table: string): Array<{ name: string; columns: string[] }> {
  return [...normalize(createTableBody(table)).matchAll(/CONSTRAINT (\w+) UNIQUE \(([^)]*)\)/g)]
    .map((match) => ({ name: match[1]!, columns: list(match[2]!) }));
}

function primaryKey(table: string): { name: string; columns: string[] } | null {
  const match = /CONSTRAINT (\w+) PRIMARY KEY \(([^)]*)\)/.exec(normalize(createTableBody(table)));
  return match ? { name: match[1]!, columns: list(match[2]!) } : null;
}

/** Each named CHECK of a table, its expression normalized (no CHECK here has a parenthesis inside a string literal). */
function checkBodies(table: string): Map<string, string> {
  const body = normalize(createTableBody(table));
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

/** The quoted values of `<column> IN (...)` in a SQL fragment. */
function inList(sql: string, column: string): string[] {
  const match = new RegExp(`\\b${column} IN \\(([^)]*)\\)`).exec(normalize(sql));
  if (!match) throw new Error(`${column} IN (...) not found`);
  return list(match[1]!).map((value) => value.replace(/^'|'$/g, ""));
}

function indexes(): Array<{ name: string; unique: boolean; table: string; columns: string[]; where: string | null }> {
  return statements().flatMap((statement) => {
    const match = /^CREATE (UNIQUE )?INDEX IF NOT EXISTS (\w+) ON ([\w.]+) \(([^)]*)\)(?: WHERE (.+))?$/.exec(statement);
    return match ? [{ name: match[2]!, unique: match[1] !== undefined, table: match[3]!, columns: list(match[4]!), where: match[5] ?? null }] : [];
  });
}

function triggers(): Array<{ name: string; timing: string; table: string; fn: string; statement: string }> {
  return statements().flatMap((statement) => {
    const match = /^CREATE TRIGGER (\w+) (BEFORE [A-Z ]+?) ON ([\w.]+) FOR EACH ROW EXECUTE FUNCTION ([\w.]+)\(\)$/.exec(statement);
    return match ? [{ name: match[1]!, timing: match[2]!, table: match[3]!, fn: match[4]!, statement }] : [];
  });
}

/** Every name this file gives an object: constraints, indexes, triggers and functions (tables are the three above). */
function objectNames(): string[] {
  const sql = withoutComments(migrationSql);
  return [
    ...[...sql.matchAll(/CONSTRAINT (\w+)/g)].map((match) => match[1]!),
    ...indexes().map((index) => index.name),
    ...triggers().map((trigger) => trigger.name),
    ...[...sql.matchAll(/CREATE OR REPLACE FUNCTION dropship\.(\w+)\(/g)].map((match) => match[1]!),
    ...[...sql.matchAll(/CREATE TABLE IF NOT EXISTS dropship\.(\w+)/g)].map((match) => match[1]!),
  ];
}

// ---------------------------------------------------------------------------
// Drizzle helpers

function drizzleColumns(table: PgTable): Array<{ name: string; type: string; notNull: boolean }> {
  return getTableConfig(table).columns.map((column) => ({ name: column.name, type: column.getSQLType(), notNull: column.notNull }));
}

/**
 * Drizzle's foreign keys in the migration's shape. An inline REFERENCES is
 * unnamed in the SQL (PostgreSQL names it), so a Drizzle key whose name the
 * migration does not use is compared by columns only.
 */
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
