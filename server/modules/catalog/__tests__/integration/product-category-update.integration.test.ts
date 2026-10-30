import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import { createInventoryCutoverTestDatabase, type InventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { updateProductCategory } from "../../product-category-update.repository";

const url = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
// Reduced catalog fixture. The two trigger functions are copied from production
// so a held gate or fence refuses a catalog.products write the way it does live.
const fixture = `
  CREATE SCHEMA catalog;
  CREATE SCHEMA inventory;
  CREATE TABLE catalog.product_categories (
    id integer PRIMARY KEY, name varchar(100) NOT NULL, slug varchar(120) NOT NULL UNIQUE, description text,
    sort_order integer DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE catalog.products (
    id integer PRIMARY KEY, category_id integer REFERENCES catalog.product_categories(id), category varchar(100),
    updated_at timestamp NOT NULL DEFAULT now()
  );
  CREATE TABLE inventory.cutover_admission_fence (singleton_key boolean PRIMARY KEY, epoch bigint NOT NULL);
  INSERT INTO inventory.cutover_admission_fence VALUES (true, 1);
  CREATE FUNCTION inventory.pin_cutover_writer_admission() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$
  DECLARE current_epoch bigint;
  BEGIN
    SELECT epoch INTO current_epoch FROM inventory.cutover_admission_fence
      WHERE singleton_key=true FOR SHARE NOWAIT;
    IF NOT FOUND OR current_epoch <= 0 THEN
      RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='CUTOVER_ADMISSION_SINGLETON_MISSING';
    END IF;
    RETURN NULL;
  END;
  $function$;
  CREATE FUNCTION inventory.gate_publication_selection_change() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'pg_catalog' AS $function$
  BEGIN
    IF NOT pg_try_advisory_xact_lock(918419,0) THEN
      RAISE EXCEPTION USING ERRCODE='55P03', MESSAGE='PUBLICATION_SELECTION_BUSY';
    END IF;
    IF TG_LEVEL='ROW' THEN RETURN NEW; END IF;
    RETURN NULL;
  END;
  $function$;
  CREATE TRIGGER aa_cutover_writer_admission BEFORE INSERT OR DELETE OR UPDATE OR TRUNCATE ON catalog.products
    FOR EACH STATEMENT EXECUTE FUNCTION inventory.pin_cutover_writer_admission();
  CREATE TRIGGER ac_publication_selection_gate BEFORE INSERT OR DELETE OR UPDATE OF category ON catalog.products
    FOR EACH STATEMENT EXECUTE FUNCTION inventory.gate_publication_selection_change();
`;

const LOCKS = [
  ["publication selection gate", "SELECT pg_advisory_xact_lock(918419,0)", "PUBLICATION_SELECTION_BUSY"],
  ["cutover admission fence", "SELECT 1 FROM inventory.cutover_admission_fence WHERE singleton_key FOR UPDATE", "could not obtain lock"],
] as const;

(url && disposable ? describe : describe.skip)("product category update PostgreSQL guarantees", () => {
  let database: InventoryCutoverTestDatabase;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    database = await createInventoryCutoverTestDatabase(url, disposable, fixture);
    db = drizzle(database.pool, { schema });
  });
  afterAll(async () => { await database?.close(); });
  beforeEach(async () => {
    await database.pool.query(`
      TRUNCATE catalog.products, catalog.product_categories;
      INSERT INTO catalog.product_categories (id, name, slug) VALUES (3, 'Armalope', 'armalope'), (9, 'Armalopes', 'armalopes'), (10, 'Empty', 'empty');
      INSERT INTO catalog.products (id, category_id, category, updated_at) VALUES
        (1, 9, 'Armalopes', '2026-01-01'), (2, 9, 'Armalopes', '2026-01-01'), (3, 3, 'Armalope', '2026-01-01');`);
  });

  async function rows() {
    const categories = await database.pool.query("SELECT id, name, slug, is_active FROM catalog.product_categories ORDER BY id");
    const products = await database.pool.query("SELECT id, category_id, category, updated_at FROM catalog.products ORDER BY id");
    return { categories: categories.rows, products: products.rows };
  }

  /** Runs `body` while another connection holds `lockSql` in an open transaction. */
  async function whileHeld<T>(lockSql: string, body: (release: () => Promise<void>) => Promise<T>): Promise<T> {
    const holder: PoolClient = await database.pool.connect();
    let held = true;
    const release = async () => {
      if (!held) return;
      held = false;
      await holder.query("ROLLBACK");
      holder.release();
    };
    await holder.query("BEGIN");
    await holder.query(lockSql);
    try { return await body(release); } finally { await release(); }
  }

  it.each(LOCKS)("archives while the %s is held, without touching products", async (_name, lockSql) => {
    const before = await rows();

    const category = await whileHeld(lockSql, () => updateProductCategory(db, 9, { isActive: false }));

    expect(category).toMatchObject({ id: 9, name: "Armalopes", isActive: false });
    const after = await rows();
    expect(after.categories.find(row => row.id === 9)?.is_active).toBe(false);
    expect(after.products).toEqual(before.products);
  });

  it("archives a category with no products while the gate is held", async () => {
    await expect(whileHeld(LOCKS[0][1], () => updateProductCategory(db, 10, { isActive: false })))
      .resolves.toMatchObject({ isActive: false });
  });

  it("renames the category and its products together", async () => {
    await updateProductCategory(db, 9, { name: "Bubble Mailers", slug: "bubble-mailers" });

    const after = await rows();
    expect(after.categories.find(row => row.id === 9)).toMatchObject({ name: "Bubble Mailers", slug: "bubble-mailers" });
    expect(after.products.map(row => row.category)).toEqual(["Bubble Mailers", "Bubble Mailers", "Armalope"]);
  });

  it.each(LOCKS)("rolls back both tables when the %s stays held", async (_name, lockSql, message) => {
    const before = await rows();
    const sleep = vi.fn(async () => undefined);

    const attempt = whileHeld(lockSql, () => updateProductCategory(db, 9, { name: "Bubble Mailers", slug: "bubble-mailers" }, { sleep }));

    await expect(attempt).rejects.toMatchObject({ code: "55P03", message: expect.stringContaining(message) });
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(await rows()).toEqual(before);
  });

  it.each(LOCKS)("saves both tables on the retry after the %s is released", async (_name, lockSql) => {
    const sleep = vi.fn(async (): Promise<void> => undefined);

    const category = await whileHeld(lockSql, async (release) => {
      sleep.mockImplementationOnce(release);
      return updateProductCategory(db, 9, { name: "Bubble Mailers", slug: "bubble-mailers" }, { sleep });
    });

    expect(category).toMatchObject({ name: "Bubble Mailers" });
    expect(sleep).toHaveBeenCalledOnce();
    expect((await rows()).products.map(row => row.category)).toEqual(["Bubble Mailers", "Bubble Mailers", "Armalope"]);
  });

  it("compares the name against the locked row, not one read before a concurrent rename", async () => {
    const renamer = await database.pool.connect();
    await renamer.query("BEGIN");
    await renamer.query("UPDATE catalog.product_categories SET name='Renamed', slug='renamed' WHERE id=9");
    await renamer.query("UPDATE catalog.products SET category='Renamed' WHERE category_id=9");

    // Sent while the rename is uncommitted, so it waits on the category row and
    // repeats the name that any read taken before the lock would still see.
    const save = updateProductCategory(db, 9, { name: "Armalopes", slug: "armalopes" });
    await new Promise(resolve => setTimeout(resolve, 100));
    await renamer.query("COMMIT");
    renamer.release();

    await expect(save).resolves.toMatchObject({ name: "Armalopes" });
    expect((await rows()).products.map(row => row.category)).toEqual(["Armalopes", "Armalopes", "Armalope"]);
  });

  it("rolls back a duplicate slug without retrying it", async () => {
    const before = await rows();
    const sleep = vi.fn(async () => undefined);

    await expect(updateProductCategory(db, 9, { name: "Armalope", slug: "armalope" }, { sleep }))
      .rejects.toMatchObject({ code: "23505" });

    expect(sleep).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });

  it("returns null and writes nothing for a missing category", async () => {
    const before = await rows();

    await expect(updateProductCategory(db, 404, { isActive: false })).resolves.toBeNull();

    expect(await rows()).toEqual(before);
  });
});
