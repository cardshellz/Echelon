import { createHash } from "node:crypto";
import pg, { type Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { executeMigrationWithRetry } from "../../../../../migrations/migration-executor";
import {
  DropshipCatalogArrivalsService,
  type CatalogArrivalsLedgerSession,
  type CatalogJobLog,
} from "../../application/dropship-catalog-arrivals-service";
import { DropshipNotificationService } from "../../application/dropship-notification-service";
import { DROPSHIP_NOTIFICATION_EVENTS } from "../../application/dropship-notification-events";
import { DropshipSelectionAtpService } from "../../application/dropship-selection-atp-service";
import { SELECTION_CHANGE_PLAN_MOVED, seededJitterSource } from "../../application/dropship-selection-change-service";
import { DropshipSelectionConversionFollowUp } from "../../application/dropship-selection-conversion-followup";
import type { DropshipVendorProvisioningService } from "../../application/dropship-vendor-provisioning-service";
import type { DropshipLogEvent } from "../../application/dropship-ports";
import { PgDropshipCatalogArrivalsRepository } from "../../infrastructure/dropship-catalog-arrivals.repository";
import { PgDropshipNotificationRepository } from "../../infrastructure/dropship-notification.repository";
import { PgDropshipSelectionAtpRepository } from "../../infrastructure/dropship-selection-atp.repository";
import { PgDropshipSelectionConversionFollowUpRepository } from "../../infrastructure/dropship-selection-conversion-followup.repository";
import { createInventoryCutoverTestDatabase } from "../../../inventory/__tests__/fixtures/inventory-cutover-database";
import { seedPicks } from "../fixtures/listing-push-runs.fixture";
import {
  PICKS_PRODUCTION_INDEXES_SQL,
  SELECTED_VARIANTS_MIGRATION_FILE,
  installPicksMigrationPrerequisites,
  picksMigrationSchemaSql,
  publicationSelectionGateHoldMs,
  samplePublicationSelectionGate,
  selectedVariantsMigrationSql,
} from "../fixtures/selection-picks-migration.fixture";
import { readSelectionOracleSnapshot } from "../fixtures/selection-oracle.fixture";
import { dropshipCatalogNewItemsAnswerSchema } from "../../../../../shared/dropship/vendor-catalog-reads";

/**
 * The new-items notice and the conversion follow-up against a real PostgreSQL (step 1 plan S2-5, PR B, B3;
 * PLAN-B v4.1 §11, §15.3): the picks migration's real B file through the release executor on the picks
 * suites' schema (the 0086/0091 shapes, the real 0743), then the real follow-up, arrivals and notification
 * services on their real repositories, and the real step 1 catalog read for `selection=new`. Only the
 * email transport, the stock provider and the clock are fakes.
 *
 * One database tells one story in order (each case builds on the last): the release, the first B tick's
 * follow-up (repairs only where the TypeScript matcher and the SQL twin disagree on the same row, here forced
 * by this cluster's own `lower()`; the tidy; the one conversion notice), the first ledger run failing part way
 * and then written whole as the baseline (CHK6), re-runs, the new items of day 1 and day 2 with their
 * emails, Got it, and the muted email. Cleanup is the database's drop (V7: after the freeze a row-by-row
 * cleanup would need TRUNCATE ... CASCADE).
 */
vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const databaseUrl = process.env.ECHELON_TEST_DATABASE_URL;
const disposable = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeDatabase = databaseUrl && disposable ? describe : describe.skip;

/** V1 sells Armalope by a category include; V2 one Toploaders size by a size include; V3 has the non-ASCII category includes. */
const V1 = 501;
const V2 = 502;
const V3 = 503;
/** No rules at the release; picks a Binders size later (FIDELITY-5). */
const V5 = 505;
const ARMALOPE = 50;
const TOPLOADERS = 51;
const SLEEVES = 52;
const BINDERS = 53;
const BULK = 59;
/** More sellable sizes than one ledger batch (1,000), so the baseline writes two batches in one transaction. */
const BULK_SIZES = 1_100;

const DAY1 = (time: string) => new Date(`2026-10-24T${time}:00.000Z`);
const DAY2 = (time: string) => new Date(`2026-10-25T${time}:00.000Z`);

/** The non-ASCII category pairs (rule text → product text) whose match the follow-up re-checks in TypeScript (A10). */
const NON_ASCII_PRODUCTS = [
  { size: 3101, product: 3100, category: "καρτες", categoryId: 61 },
  { size: 3201, product: 3200, category: "καρτεσ", categoryId: 62 },
  { size: 3301, product: 3300, category: "istanbul", categoryId: 63 },
  { size: 3401, product: 3400, category: "école", categoryId: 64 },
] as const;
const NON_ASCII_RULES = ["ΚΑΡΤΕΣ", "İSTANBUL", "ÉCOLE"] as const;

/** The tables and columns the notice and the step 1 read need beyond the picks schema (production shapes, reduced). */
const noticeSchemaSql = `
  CREATE TABLE catalog.product_categories (id integer PRIMARY KEY, name varchar(100) NOT NULL);
  ALTER TABLE catalog.product_variants ADD COLUMN position integer NOT NULL DEFAULT 0;
  ALTER TABLE dropship.dropship_vendor_variant_overrides ADD COLUMN notes text,
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(), ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
  ALTER TABLE dropship.dropship_vendors ADD COLUMN email varchar(255);
  -- 0086 and 0097: the notification events (the per-channel idempotency index) and preferences.
  CREATE TABLE dropship.dropship_notification_events (
    id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    event_type varchar(100) NOT NULL, channel varchar(30) NOT NULL, critical boolean NOT NULL DEFAULT false,
    title varchar(300) NOT NULL, message text, payload jsonb, status varchar(30) NOT NULL DEFAULT 'pending',
    delivered_at timestamptz, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
    idempotency_key varchar(200), request_hash varchar(64),
    CONSTRAINT dropship_notification_channel_chk CHECK (channel IN ('email','in_app','sms','webhook')));
  CREATE UNIQUE INDEX dropship_notification_idem_channel_idx
    ON dropship.dropship_notification_events(idempotency_key, channel) WHERE idempotency_key IS NOT NULL;
  CREATE TABLE dropship.dropship_notification_preferences (
    id integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    vendor_id integer NOT NULL REFERENCES dropship.dropship_vendors(id) ON DELETE CASCADE,
    event_type varchar(100) NOT NULL, critical boolean NOT NULL DEFAULT false,
    email_enabled boolean NOT NULL DEFAULT true, in_app_enabled boolean NOT NULL DEFAULT true,
    sms_enabled boolean NOT NULL DEFAULT false, webhook_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT dropship_notification_pref_critical_chk CHECK (critical = false OR (email_enabled = true AND in_app_enabled = true)));
  CREATE UNIQUE INDEX dropship_notification_pref_vendor_event_idx
    ON dropship.dropship_notification_preferences(vendor_id, event_type);
`;

/**
 * Card Shellz's catalog and the vendors' rules as they stand at the release (before the B file).
 * Admin rules: 1 includes everything; 2 hides product 1200 always.
 * Armalope (50): product 1100 (sizes 1101 listed by V1, 1102), 1200 hidden (1201 listed by V1, 1202), 1300 (1301 not
 * sellable), 1400 (1401; moved to Sleeves after the release). Toploaders (51): 2100 (2101). Binders (53): 5300 (5300).
 * The non-ASCII products 3100-3400 (61-64), and eleven Bulk products (59) of 100 sizes each.
 */
const releaseSeedSql = `
  INSERT INTO catalog.product_categories (id, name) VALUES
    (${ARMALOPE}, 'Armalope'), (${TOPLOADERS}, 'Toploaders'), (${SLEEVES}, 'Sleeves'), (${BINDERS}, 'Binders'),
    (61, 'Kartes 1'), (62, 'Kartes 2'), (63, 'Istanbul'), (64, 'Ecole'), (${BULK}, 'Bulk');
  INSERT INTO catalog.products (id, sku, name, category, category_id, is_active, status, product_type, ebay_listing_excluded) VALUES
    (1100, 'P-1100', 'Product 1100', 'Armalope', ${ARMALOPE}, true, 'active', 'sleeves', false),
    (1200, 'P-1200', 'Product 1200', 'Armalope', ${ARMALOPE}, true, 'active', 'sleeves', false),
    (1300, 'P-1300', 'Product 1300', 'Armalope', ${ARMALOPE}, true, 'active', 'sleeves', false),
    (1400, 'P-1400', 'Product 1400', 'Armalope', ${ARMALOPE}, true, 'active', 'sleeves', false),
    (2100, 'P-2100', 'Product 2100', 'Toploaders', ${TOPLOADERS}, true, 'active', 'toploaders', false),
    (5300, 'P-5300', 'Product 5300', 'Binders', ${BINDERS}, true, 'active', 'binders', false),
    ${NON_ASCII_PRODUCTS.map((row) => `(${row.product}, 'P-${row.product}', 'Product ${row.product}', '${row.category}', ${row.categoryId}, true, 'active', 'sleeves', false)`).join(",\n    ")};
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded) VALUES
    (1101, 1100, 'S-1101', 'Size 1101', 'pack', true, true, true, 'sellable', false),
    (1102, 1100, 'S-1102', 'Size 1102', 'case', true, true, true, 'sellable', false),
    (1201, 1200, 'S-1201', 'Size 1201', 'pack', true, true, true, 'sellable', false),
    (1202, 1200, 'S-1202', 'Size 1202', 'case', true, true, true, 'sellable', false),
    (1301, 1300, 'S-1301', 'Size 1301', 'pack', true, true, true, 'internal_only', false),
    (1401, 1400, 'S-1401', 'Size 1401', 'pack', true, true, true, 'sellable', false),
    (2101, 2100, 'S-2101', 'Size 2101', 'pack', true, true, true, 'sellable', false),
    (5300, 5300, 'S-5300', 'Size 5300', 'pack', true, true, true, 'sellable', false),
    ${NON_ASCII_PRODUCTS.map((row) => `(${row.size}, ${row.product}, 'S-${row.size}', 'Size ${row.size}', 'pack', true, true, true, 'sellable', false)`).join(",\n    ")};
  INSERT INTO catalog.products (id, sku, name, category, category_id, is_active, status, product_type, ebay_listing_excluded)
    SELECT 5900 + g, 'P-BULK-' || g, 'Bulk ' || g, 'Bulk', ${BULK}, true, 'active', 'sleeves', false FROM generate_series(1, 11) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT 600000 + g, 5901 + (g - 1) / 100, 'S-BULK-' || g, 'Bulk size ' || g, 'pack', true, true, true, 'sellable', false
    FROM generate_series(1, ${BULK_SIZES}) g;

  INSERT INTO dropship.dropship_catalog_rules (id, scope_type, action, product_id, is_active, priority) OVERRIDING SYSTEM VALUE VALUES
    (1, 'catalog', 'include', NULL, true, 0), (2, 'product', 'exclude', 1200, true, 10);

  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status, email) VALUES
    (${V1}, 'member-${V1}', 'active', 'active', 'v1@example.test'), (${V2}, 'member-${V2}', 'active', 'active', 'v2@example.test'),
    (${V3}, 'member-${V3}', 'active', 'active', 'v3@example.test'), (${V5}, 'member-${V5}', 'active', 'active', 'v5@example.test');
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment) VALUES
    (601, ${V1}, 'ebay', 'connected', 'seller-601', 'production'), (602, ${V2}, 'ebay', 'connected', 'seller-602', 'production'),
    (603, ${V3}, 'ebay', 'connected', 'seller-603', 'production');
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active) VALUES
    (601, 'ebay', 'live', 'managed_quantity_sync', true), (602, 'ebay', 'live', 'managed_quantity_sync', true),
    (603, 'ebay', 'live', 'managed_quantity_sync', true);
  INSERT INTO dropship.dropship_vendor_listings (id, vendor_id, store_connection_id, product_variant_id, platform, status,
    external_listing_id, external_offer_id, created_at, updated_at) OVERRIDING SYSTEM VALUE VALUES
    (901, ${V1}, 601, 1101, 'ebay', 'active', 'L-901', 'O-901', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (902, ${V1}, 601, 1201, 'ebay', 'active', 'L-902', 'O-902', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z'),
    (911, ${V2}, 602, 2101, 'ebay', 'active', 'L-911', 'O-911', '2026-10-23T08:00:00Z', '2026-10-23T08:00:00Z');

  INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, product_variant_id, category,
    auto_connect_new_skus, auto_list_new_skus, priority, is_active) OVERRIDING SYSTEM VALUE VALUES
    (11, ${V1}, 'category', 'include', NULL, 'Armalope', true, false, 0, true),
    (21, ${V2}, 'variant', 'include', 2101, NULL, true, false, 0, true),
    ${NON_ASCII_RULES.map((rule, index) => `(${31 + index}, ${V3}, 'category', 'include', NULL, '${rule}', true, false, 0, true)`).join(",\n    ")};
`;

interface LogLine { level: string; action: string; fields: Record<string, unknown> }
/** The lines a human would be shown or warned by. */
const loud = (from: readonly LogLine[]) => from.filter((line) => line.level === "warn" || line.level === "error");
type MarkKey = `${number}:${number}`;
type Marks = Map<MarkKey, { seen: number; notified: number }>;

describeDatabase.sequential("the new-items notice and the conversion follow-up (PostgreSQL)", () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let now = DAY1("09:00");
  const lines: LogLine[] = [];
  const emailsSent: Array<{ toEmail: string; eventType: string; title: string; message: string | null }> = [];
  let notifications: DropshipNotificationService;
  let followUp: DropshipSelectionConversionFollowUp;
  /** The arrivals service the stories run (its ledger hour and failed-tick streak live in it). */
  let service: DropshipCatalogArrivalsService;
  let catalog: DropshipSelectionAtpService;
  let lastMarks: Marks = new Map();
  /** The arrival id of each size, once the ledger holds it. */
  const arrivalOf = new Map<number, number>();
  /** The baseline's highest arrival id: the first marks' watermark. */
  let baselineMax = 0;

  const log: CatalogJobLog = {
    debug: (action, fields) => lines.push({ level: "debug", action, fields }),
    info: (action, fields) => lines.push({ level: "info", action, fields }),
    warn: (action, fields) => lines.push({ level: "warn", action, fields }),
    error: (action, fields) => lines.push({ level: "error", action, fields }),
  };
  const linesSince = (start: number) => lines.slice(start);

  function arrivalsService(repository = new PgDropshipCatalogArrivalsRepository(pool)): DropshipCatalogArrivalsService {
    return new DropshipCatalogArrivalsService({
      repository, notifications, followUp, clock: { now: () => now }, timer: () => 0, log,
      catalogUrl: "https://portal.example.test/catalog/choose",
    });
  }

  async function readMarks(): Promise<Marks> {
    const rows = (await pool.query<{ vendor_id: number; category_id: number; seen: string; notified: string }>(
      `SELECT vendor_id, category_id, seen_through_arrival_id::text AS seen, notified_through_arrival_id::text AS notified
       FROM dropship.dropship_vendor_category_notice_marks ORDER BY vendor_id, category_id`)).rows;
    return new Map(rows.map((row) => [`${row.vendor_id}:${row.category_id}` as MarkKey, { seen: Number(row.seen), notified: Number(row.notified) }]));
  }

  /** Watermarks move only forward: every mark seen before is still there, neither watermark lower (§11.4). */
  async function expectMarksForward(): Promise<Marks> {
    const marks = await readMarks();
    for (const [key, before] of lastMarks) {
      const after = marks.get(key);
      expect(after, key).toBeDefined();
      expect(after!.seen, `${key} seen`).toBeGreaterThanOrEqual(before.seen);
      expect(after!.notified, `${key} notified`).toBeGreaterThanOrEqual(before.notified);
    }
    lastMarks = marks;
    return marks;
  }

  async function picksOf(vendorId: number): Promise<Array<{ id: number; source: string }>> {
    return (await pool.query<{ id: number; source: string }>(
      `SELECT product_variant_id AS id, source FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1 ORDER BY 1`,
      [vendorId])).rows;
  }

  async function newItemsEvents(): Promise<Array<{ vendorId: number; channel: string; key: string; payload: Record<string, unknown> }>> {
    return (await pool.query<{ vendor_id: number; channel: string; idempotency_key: string; payload: Record<string, unknown> }>(
      `SELECT vendor_id, channel, idempotency_key, payload FROM dropship.dropship_notification_events
       WHERE event_type = $1 ORDER BY id`, [DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS])).rows
      .map((row) => ({ vendorId: row.vendor_id, channel: row.channel, key: row.idempotency_key, payload: row.payload }));
  }

  async function addSize(id: number, productId: number, options: { productCategory?: { text: string; id: number } } = {}): Promise<void> {
    if (options.productCategory) {
      await pool.query(`INSERT INTO catalog.products (id, sku, name, category, category_id, is_active, status, product_type, ebay_listing_excluded)
        VALUES ($1, $2, $3, $4, $5, true, 'active', 'sleeves', false)`,
      [productId, `P-${productId}`, `Product ${productId}`, options.productCategory.text, options.productCategory.id]);
    }
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
      sales_eligibility, ebay_listing_excluded) VALUES ($1, $2, $3, $4, 'pack', true, true, true, 'sellable', false)`,
    [id, productId, `S-${id}`, `Size ${id}`]);
  }

  async function recordArrivalIds(): Promise<void> {
    for (const row of (await pool.query<{ id: string; product_variant_id: number }>(
      "SELECT id::text, product_variant_id FROM dropship.dropship_catalog_arrivals")).rows) {
      arrivalOf.set(row.product_variant_id, Number(row.id));
    }
  }

  /** The catalog GET's `selection=new` rows (the real step 1 read), as size ids. */
  async function newRows(vendorId: number, categoryId?: number): Promise<number[]> {
    const page = await catalog.previewCatalog({ vendorId, selection: "new", ...(categoryId ? { categoryId } : {}), includeFacets: false, limit: 200 });
    return page.rows.map((row) => row.productVariantId);
  }

  async function readNewItems(vendorId: number) {
    return dropshipCatalogNewItemsAnswerSchema.parse(await service.readNewItems({ vendorId }));
  }

  beforeAll(async () => {
    const database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, `${picksMigrationSchemaSql}\n${noticeSchemaSql}`);
    try {
      await installPicksMigrationPrerequisites(database.pool);
      await database.pool.query(releaseSeedSql);
    } catch (error) {
      await database.close();
      throw error;
    }
    pool = new pg.Pool({ connectionString: database.connectionString, max: 6 });
    close = async () => { await pool.end(); await database.close(); };

    await releaseBFile(pool);

    const notificationLog = (level: string) => (event: DropshipLogEvent) => {
      lines.push({ level, action: event.code, fields: event.context ?? {} });
    };
    notifications = new DropshipNotificationService({
      // Neither send nor listEventsByKey reads the member's vendor (they are given the vendor id).
      vendorProvisioning: { provisionForMember: async () => { throw new Error("not used"); } } as unknown as DropshipVendorProvisioningService,
      repository: new PgDropshipNotificationRepository(pool),
      emailSender: { send: async (input) => { emailsSent.push(input); } },
      clock: { now: () => now },
      logger: { debug: notificationLog("debug"), info: notificationLog("info"), warn: notificationLog("warn"), error: notificationLog("error") },
    });
    followUp = new DropshipSelectionConversionFollowUp({
      repository: new PgDropshipSelectionConversionFollowUpRepository(pool),
      notifications, log, sleep: async () => undefined, random: seededJitterSource(7),
    });
    service = arrivalsService();
    catalog = new DropshipSelectionAtpService({
      clock: { now: () => now },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      repository: new PgDropshipSelectionAtpRepository(pool),
      atp: { getVariantAtp: async (targets) => ({ authority: "canonical", quantities: new Map(targets.map((target) => [target.productVariantId, 3])) }) },
      listingTiers: { resolveForVendor: async () => ({ eligibility: {
        pack: { tier: "pack", eligible: true, reason: null, policyMinimumCents: 0, minimumCents: 0, alreadyOn: true, reserveShortfallCents: 0,
          balanceShortfallCents: 0, upcoming: null },
        case: { tier: "case", eligible: true, reason: null, policyMinimumCents: 0, minimumCents: 0, alreadyOn: true, reserveShortfallCents: 0,
          balanceShortfallCents: 0, upcoming: null },
      } }) },
      newItems: service,
    });
  }, 180_000);

  afterAll(async () => {
    await close?.();
  });

  it("follows up the release on the real B file: repairs exactly where TypeScript and this cluster's SQL twin disagree, tidies, notices once", async () => {
    // What the conversion wrote for V3: its SQL twin (this cluster's lower()) decided the non-ASCII categories.
    const ruleLower = (await pool.query<{ value: string }>("SELECT lower(x) AS value FROM unnest($1::text[]) WITH ORDINALITY u(x, n) ORDER BY n",
      [[...NON_ASCII_RULES]])).rows.map((row) => row.value);
    const productLower = (await pool.query<{ value: string }>("SELECT lower(x) AS value FROM unnest($1::text[]) WITH ORDINALITY u(x, n) ORDER BY n",
      [NON_ASCII_PRODUCTS.map((row) => row.category)])).rows.map((row) => row.value);
    const sqlMatches = NON_ASCII_PRODUCTS.filter((_, index) => ruleLower.includes(productLower[index]!)).map((row) => row.size);
    const tsMatches = NON_ASCII_PRODUCTS.filter((row) => NON_ASCII_RULES.some((rule) => rule.trim().toLowerCase() === row.category.trim().toLowerCase()))
      .map((row) => row.size);
    expect((await picksOf(V3)).map((pick) => pick.id)).toEqual(sqlMatches);
    const expectedInserts = tsMatches.filter((size) => !sqlMatches.includes(size));
    const expectedDeletes = sqlMatches.filter((size) => !tsMatches.includes(size));
    const provider = (await pool.query<{ provider: string; collate: string }>(
      "SELECT datlocprovider AS provider, datcollate AS collate FROM pg_database WHERE datname = current_database()")).rows[0]!;
    if (provider.provider === "c") {
      // A libc cluster (this one, C.UTF-8; CI's postgres:16) lowers character by character: the Greek final sigma and the
      // dotted capital I disagree with JavaScript, so the follow-up's repair runs here on the real file (FIDELITY-1).
      expect(expectedInserts).toEqual([3101]);
      expect(expectedDeletes).toEqual([3201, 3301]);
    }

    // After the release and before the first B tick, Card Shellz adds a size to an included category and moves a product out.
    await addSize(1103, 1100);
    await pool.query(`UPDATE catalog.products SET category = 'Sleeves', category_id = ${SLEEVES} WHERE id = 1400`);
    const v1Before = await picksOf(V1);
    expect(v1Before).toEqual([1101, 1102, 1201, 1202, 1301, 1401].map((id) => ({ id, source: "legacy_broad_rule" })));
    const stockBefore = await readSelectionOracleSnapshot(pool);
    const revisionsBefore = await revisionCount(pool);
    const start = lines.length;

    const result = await followUp.runStage(now);
    // V1 and V3 have broad rules (a conversion record each); V2's size include converted with none.
    expect(result).toMatchObject({ conversionsRead: 2, followUpsDone: 2, noticesSent: 2, vendorsFailed: 0, requiresReview: 0 });
    const conversions = (await pool.query(`SELECT vendor_id, followup_state, notice_state, followup_failures, last_error_code,
      followup_at, notice_at FROM dropship.dropship_selection_conversions ORDER BY vendor_id`)).rows;
    expect(conversions).toEqual([V1, V3].map((vendorId) => ({ vendor_id: vendorId, followup_state: "done", notice_state: "sent",
      followup_failures: 0, last_error_code: null, followup_at: now, notice_at: now })));

    // V3: repaired exactly where the matchers disagree, with a WARN and the ids in the audit row; ÉCOLE/école agree here.
    const v3After = await picksOf(V3);
    expect(v3After.map((pick) => pick.id)).toEqual([...sqlMatches.filter((size) => !expectedDeletes.includes(size)), ...expectedInserts]
      .sort((left, right) => left - right));
    expect(v3After.filter((pick) => pick.source === "conversion_repair").map((pick) => pick.id)).toEqual(expectedInserts);
    expect(v3After.find((pick) => pick.id === 3401)?.source).toBe("legacy_broad_rule");
    const repaired = linesSince(start).filter((line) => line.action === "dropship.selection.conversion_repaired");
    expect(repaired).toEqual(expectedInserts.length + expectedDeletes.length === 0 ? [] : [expect.objectContaining({ level: "warn",
      fields: expect.objectContaining({ vendor_id: V3, inserted_variant_ids: expectedInserts, deleted_variant_ids: expectedDeletes }) })]);
    const audits = (await pool.query<{ vendor_id: number; payload: Record<string, unknown> }>(`SELECT vendor_id, payload FROM dropship.dropship_audit_events
      WHERE event_type = 'vendor_selection_conversion_followed_up' ORDER BY vendor_id`)).rows;
    expect(audits).toEqual([
      { vendor_id: V1, payload: expect.objectContaining({ outcome: "changed", repairedInsertedVariantIds: [], repairedDeletedVariantIds: [],
        tidiedVariantIds: [1202, 1301] }) },
      { vendor_id: V3, payload: expect.objectContaining({ repairedInsertedVariantIds: expectedInserts, repairedDeletedVariantIds: expectedDeletes,
        tidiedVariantIds: [] }) },
    ]);

    // V1: the tidy drops only broad picks Card Shellz does not offer now that no store of V1 lists (1202 hidden, 1301 not
    // sellable); the hidden 1201 with a listing stays, the moved 1401 stays (no repair: both sides read Sleeves), and the
    // size added after the release (1103) is not added (nothing is added without a save).
    expect(await picksOf(V1)).toEqual([1101, 1102, 1201, 1401].map((id) => ({ id, source: "legacy_broad_rule" })));
    expect((await picksOf(V2))).toEqual([{ id: 2101, source: "legacy_variant_rule" }]);
    const followUpRevisions = (await pool.query<{ vendor_id: number; idempotency_key: string; request_kind: string; pick_count: number; rule_count: number }>(
      `SELECT r.vendor_id, r.idempotency_key, r.request_kind, r.pick_count, r.rule_count
       FROM dropship.dropship_vendor_selection_rule_set_revisions r WHERE r.request_kind = 'picks_conversion_followup' ORDER BY r.vendor_id`)).rows;
    const backfills = new Map((await pool.query<{ vendor_id: number; backfill_revision_id: number }>(
      "SELECT vendor_id, backfill_revision_id FROM dropship.dropship_selection_conversions")).rows.map((row) => [row.vendor_id, row.backfill_revision_id]));
    expect(followUpRevisions).toEqual([V1, V3].map((vendorId) => ({ vendor_id: vendorId, request_kind: "picks_conversion_followup", rule_count: 0,
      idempotency_key: `legacy-picks-followup:${vendorId}:${backfills.get(vendorId)}`,
      pick_count: vendorId === V1 ? 4 : v3After.length })));
    expect(await revisionCount(pool)).toBe(revisionsBefore + 2);

    // Stock-neutral: the stock selection reader's action for every (time, store, product, size) is what it was, the
    // tidied sizes' included. Only V3's repaired sizes may differ (the frozen rules' TypeScript meaning, on V3's store).
    const stockAfter = await readSelectionOracleSnapshot(pool);
    expect(Object.keys(stockAfter)).toEqual(Object.keys(stockBefore));
    const changed = Object.keys(stockBefore).filter((key) => stockBefore[key]!.action !== stockAfter[key]!.action);
    const repairedOnV3Store = (key: string) => key.includes(" store 603 ")
      && [...expectedInserts, ...expectedDeletes].some((size) => key.endsWith(` size ${size}`));
    expect(changed.filter((key) => !repairedOnV3Store(key))).toEqual([]);
    const tidiedKeys = Object.keys(stockBefore).filter((key) => key.includes(" store 601 ") && /size (1202|1301)$/.test(key));
    expect(tidiedKeys.length).toBeGreaterThan(0);
    for (const key of tidiedKeys) expect(stockAfter[key], key).toEqual(stockBefore[key]);

    // The one conversion notice per vendor, stored under its key on both channels, the email sent once.
    const notices = (await pool.query<{ vendor_id: number; channel: string; idempotency_key: string; payload: Record<string, unknown> }>(
      `SELECT vendor_id, channel, idempotency_key, payload FROM dropship.dropship_notification_events
       WHERE event_type = $1 ORDER BY vendor_id, channel`, [DROPSHIP_NOTIFICATION_EVENTS.SELECTION_RULES_CONVERTED])).rows;
    expect(notices).toEqual([V1, V1, V3, V3].map((vendorId, index) => ({ vendor_id: vendorId, channel: index % 2 === 0 ? "email" : "in_app",
      idempotency_key: `selection-rules-converted:${vendorId}`,
      payload: { selectedCount: vendorId === V1 ? 3 : v3After.length, backfillRevisionId: backfills.get(vendorId) } })));
    expect(emailsSent.map((email) => [email.toEmail, email.eventType])).toEqual([
      ["v1@example.test", "dropship_selection_rules_converted"], ["v3@example.test", "dropship_selection_rules_converted"],
    ]);
    // V1 keeps 1101, 1102 (offered) and 1401 (offered in Sleeves) selected; 1201 is picked but hidden.
    expect(emailsSent[0]!.message).toContain("The 3 items it covered today stay chosen.");
    expect(loud(linesSince(start)).filter((line) => line.action !== "dropship.selection.conversion_repaired")).toEqual([]);
  }, 120_000);

  it("writes nothing on a re-run after done, and a done row with a pending notice sends the notice only, once (SAFETY-6)", async () => {
    now = DAY1("09:01");
    const before = await tableCounts(pool);
    const quiet = await followUp.runStage(now);
    expect(quiet).toMatchObject({ conversionsRead: 0, followUpsDone: 0, noticesSent: 0 });
    expect(await tableCounts(pool)).toEqual(before);

    // A process that committed V1's follow-up and died before its notice: only the notice runs, and the stored event replays.
    await pool.query(`UPDATE dropship.dropship_selection_conversions SET notice_state = 'pending', notice_at = NULL WHERE vendor_id = ${V1}`);
    const emailsBefore = emailsSent.length;
    const replayed = await followUp.runStage(now);
    expect(replayed).toMatchObject({ conversionsRead: 1, followUpsDone: 0, noticesSent: 1, vendorsFailed: 0 });
    expect(await tableCounts(pool)).toEqual(before);
    expect(emailsSent).toHaveLength(emailsBefore);
    expect(lines.filter((line) => line.action === "dropship.selection.conversion_notice_sent").at(-1))
      .toMatchObject({ level: "info", fields: { outcome: "replayed", vendor_id: V1 } });
    expect((await pool.query(`SELECT notice_state FROM dropship.dropship_selection_conversions WHERE vendor_id = ${V1}`)).rows)
      .toEqual([{ notice_state: "sent" }]);
  }, 60_000);

  it("rolls the first ledger run back whole when a statement fails in its second batch; the next tick writes every row as baseline (CHK6)", async () => {
    now = DAY1("09:05");
    const failing = new FailingSecondInsertRepository(pool);
    const start = lines.length;
    const failed = await arrivalsService(failing).runTick();
    expect(failed.outcome).toBe("failed");
    expect(failing.insertCalls).toBe(2);
    expect(failing.firstBatchInserted).toBeGreaterThan(0);
    expect(await arrivalCount(pool)).toBe(0);
    expect(await readMarks()).toEqual(new Map());
    expect(linesSince(start).filter((line) => line.action === "dropship.catalog_arrivals.tick_failed")).toEqual([
      expect.objectContaining({ level: "error", fields: expect.objectContaining({ error_code: "23502", failed_ticks_in_a_row: 1 }) }),
    ]);

    now = DAY1("09:06");
    const first = await service.runTick();
    expect(first.outcome).toBe("completed");
    // Sellable, exposed and in a category: the hidden product, the unsellable size and nothing else are left out.
    const expected = [1101, 1102, 1103, 1401, 2101, 3101, 3201, 3301, 3401, 5300].length + BULK_SIZES;
    expect(first.ledger).toEqual({ baseline: true, insertedCount: expected, ledgerEmpty: false });
    const rows = (await pool.query<{ baseline: boolean; count: number }>(
      "SELECT baseline, count(*)::integer AS count FROM dropship.dropship_catalog_arrivals GROUP BY baseline")).rows;
    expect(rows).toEqual([{ baseline: true, count: expected }]);
    expect((await pool.query("SELECT 1 FROM dropship.dropship_catalog_arrivals WHERE product_variant_id IN (1201, 1202, 1301)")).rows).toEqual([]);
    await recordArrivalIds();
    const maxId = Math.max(...arrivalOf.values());
    baselineMax = maxId;
    // The failed run's identity values are not given back (PG SEMANTICS); arrival ids only need to increase.
    expect(Math.min(...arrivalOf.values())).toBeGreaterThan(failing.firstBatchInserted);

    // First marks, silently, at the newest arrival, for every category each vendor sells from; no email.
    const marks = await expectMarksForward();
    expect([...marks.keys()].sort()).toEqual([`${V1}:${ARMALOPE}`, `${V1}:${SLEEVES}`, `${V2}:${TOPLOADERS}`,
      ...(await picksOf(V3)).map((pick) => `${V3}:${NON_ASCII_PRODUCTS.find((row) => row.size === pick.id)!.categoryId}`)].sort());
    for (const mark of marks.values()) expect(mark).toEqual({ seen: maxId, notified: maxId });
    expect(await newItemsEvents()).toEqual([]);
    expect(lines.find((line) => line.action === "dropship.catalog_arrivals.baseline_written"))
      .toMatchObject({ level: "info", fields: { outcome: "written", inserted_count: expected } });
    for (const vendorId of [V1, V2, V3]) expect(await readNewItems(vendorId)).toEqual({ categories: [] });
  }, 120_000);

  it("re-runs safely: an hour later nothing is inserted and no arrival id is used up; the ledger is unique and append-only", async () => {
    const maxBefore = Math.max(...arrivalOf.values());
    now = DAY1("10:06");
    const rerun = await service.runTick();
    expect(rerun.ledger).toEqual({ baseline: false, insertedCount: 0, ledgerEmpty: false });
    expect(await arrivalCount(pool)).toBe(arrivalOf.size);
    await expectMarksForward();

    await expect(pool.query("UPDATE dropship.dropship_catalog_arrivals SET baseline = false WHERE product_variant_id = 1101"))
      .rejects.toMatchObject({ message: "DROPSHIP_CATALOG_ARRIVALS_APPEND_ONLY" });
    await expect(pool.query("DELETE FROM dropship.dropship_catalog_arrivals WHERE product_variant_id = 1101"))
      .rejects.toMatchObject({ message: "DROPSHIP_CATALOG_ARRIVALS_APPEND_ONLY" });

    // Day 1's new items. 1104: a new size of V1's picked product; 1105: a new product in Armalope; 1106: new, then picked
    // by V1 before the job runs; 1107: new, turned off by V1's override; 2102: new in V2's Toploaders; 5301: new in
    // Binders, which nobody sells from yet.
    await addSize(1104, 1100);
    await addSize(1105, 1500, { productCategory: { text: "Armalope", id: ARMALOPE } });
    await addSize(1106, 1600, { productCategory: { text: "Armalope", id: ARMALOPE } });
    await addSize(1107, 1700, { productCategory: { text: "Armalope", id: ARMALOPE } });
    await addSize(2102, 2100);
    await addSize(5301, 5300);
    await seedPicks(pool, V1, [1106]);
    await pool.query(`INSERT INTO dropship.dropship_vendor_variant_overrides (vendor_id, product_variant_id, enabled_override)
      VALUES (${V1}, 1107, false)`);
    now = DAY1("11:06");
    const tick = await service.runTick();
    expect(tick.ledger).toEqual({ baseline: false, insertedCount: 6, ledgerEmpty: false });
    await recordArrivalIds();
    // The hourly re-offers of known sizes used up no identity value: the six follow the baseline's last id, in size order.
    expect([1104, 1105, 1106, 1107, 2102, 5301].map((size) => arrivalOf.get(size)))
      .toEqual([1, 2, 3, 4, 5, 6].map((step) => maxBefore + step));
    // One arrival per (size, category): a second row is refused by the key (this draws an identity value; later ids are not counted).
    await expect(pool.query(`INSERT INTO dropship.dropship_catalog_arrivals (product_variant_id, product_id, category_id, first_seen_at, baseline)
      VALUES (1101, 1100, ${ARMALOPE}, now(), false)`)).rejects.toMatchObject({ code: "23505" });
  }, 60_000);

  it("emails day 1's new items once per vendor; the notice GET and selection=new show exactly what was emailed (TESTS-8)", async () => {
    const events = await newItemsEvents();
    const emailOf = (vendorId: number) => events.find((event) => event.vendorId === vendorId && event.channel === "email")!;
    // Stored on both channels under today's key; V3 and V5 had nothing new.
    expect(events.map((event) => [event.vendorId, event.channel, event.key])).toEqual([
      [V1, "email", "catalog-new-items:501:2026-10-24"], [V1, "in_app", "catalog-new-items:501:2026-10-24"],
      [V2, "email", "catalog-new-items:502:2026-10-24"], [V2, "in_app", "catalog-new-items:502:2026-10-24"],
    ]);
    // A picked size (1106) and a turned-off size (1107) are never new; a new size of a picked product (1104) is.
    expect(emailOf(V1).payload).toEqual({ throughArrivalId: arrivalOf.get(1105), categories: [
      { categoryId: ARMALOPE, categoryName: "Armalope", productCount: 2, sizeCount: 2, throughArrivalId: arrivalOf.get(1105) },
    ] });
    expect(emailOf(V2).payload).toEqual({ throughArrivalId: arrivalOf.get(2102), categories: [
      { categoryId: TOPLOADERS, categoryName: "Toploaders", productCount: 1, sizeCount: 1, throughArrivalId: arrivalOf.get(2102) },
    ] });
    expect(emailsSent.filter((email) => email.eventType === DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS).map((email) => [email.toEmail, email.message]))
      .toEqual([
        ["v1@example.test", "Card Shellz added new items in categories you sell from: Armalope (2). Nothing is added until you choose them in "
          + "Catalog, step 1 (Choose what to sell), and publish them in step 3: https://portal.example.test/catalog/choose"],
        ["v2@example.test", expect.stringContaining("Toploaders (1)")],
      ]);

    // The same tick's step 1 reads: the notice counts equal the email's (no Got it yet, so seen = notified before it),
    // and the catalog GET's selection=new rows are exactly those sizes.
    for (const vendorId of [V1, V2]) expect((await readNewItems(vendorId)).categories).toEqual(emailOf(vendorId).payload.categories);
    expect(await newRows(V1, ARMALOPE)).toEqual([1104, 1105]);
    expect(await newRows(V1)).toEqual([1104, 1105]);
    expect(await newRows(V2, TOPLOADERS)).toEqual([2102]);
    expect(await newRows(V1, TOPLOADERS)).toEqual([]);
    expect(await newRows(V3)).toEqual([]);
    const ids = await catalog.listCatalogIds({ vendorId: V1, selection: "new", categoryId: ARMALOPE, purpose: "add" });
    expect(ids).toEqual({ selectedIds: [], notSelectedIds: [1104, 1105], total: 2 });

    // The email moved notified_through only; two vendors' marks move apart.
    const marks = await expectMarksForward();
    expect(marks.get(`${V1}:${ARMALOPE}`)).toEqual({ seen: baselineMax, notified: arrivalOf.get(1105) });
    expect(marks.get(`${V2}:${TOPLOADERS}`)).toEqual({ seen: baselineMax, notified: arrivalOf.get(2102) });
    expect(marks.get(`${V1}:${SLEEVES}`)).toEqual({ seen: baselineMax, notified: baselineMax });
  }, 60_000);

  it("reads a missing mark as nothing new: V5's first pick in Binders shows no notice before or after the next tick, whose first mark is silent (FIDELITY-5)", async () => {
    await seedPicks(pool, V5, [5300]);
    // 5301 arrived in Binders after the baseline; V5 has no mark there yet.
    expect(await readNewItems(V5)).toEqual({ categories: [] });
    expect(await newRows(V5, BINDERS)).toEqual([]);

    // Later the same day another Armalope size arrives; V1 was emailed today already.
    await addSize(1108, 1500);
    now = DAY1("12:06");
    const tick = await service.runTick();
    expect(tick.notices).toMatchObject({ vendorsEmailed: 0, vendorsAlreadyEmailedToday: 2, firstMarksInserted: 1 });
    await recordArrivalIds();
    const marks = await expectMarksForward();
    expect(marks.get(`${V5}:${BINDERS}`)).toEqual({ seen: arrivalOf.get(1108), notified: arrivalOf.get(1108) });
    expect(await readNewItems(V5)).toEqual({ categories: [] });
    expect(await newRows(V5, BINDERS)).toEqual([]);
    // Today's key is stored: nothing is sent again; V1's watermark stays at what was emailed, below 1108 (FIDELITY-2).
    expect((await newItemsEvents()).length).toBe(4);
    expect(marks.get(`${V1}:${ARMALOPE}`)?.notified).toBe(arrivalOf.get(1105));
    expect(lines.filter((line) => line.action === "dropship.catalog_arrivals.already_emailed_today").map((line) => line.fields.vendor_id))
      .toEqual([V1, V2]);
    // Step 1 shows every item since the vendor's last Got it.
    expect((await readNewItems(V1)).categories).toEqual([{ categoryId: ARMALOPE, categoryName: "Armalope", productCount: 2, sizeCount: 3,
      throughArrivalId: arrivalOf.get(1108) }]);
    expect(await newRows(V1, ARMALOPE)).toEqual([1104, 1105, 1108]);
  }, 60_000);

  it("emails the later same-day arrival on the next UTC day only; a muted vendor stores nothing and its marks still move", async () => {
    now = DAY2("09:00");
    await service.runTick();
    const day2 = (await newItemsEvents()).filter((event) => event.key.endsWith(":2026-10-25"));
    expect(day2.map((event) => [event.vendorId, event.channel, event.key])).toEqual([
      [V1, "email", "catalog-new-items:501:2026-10-25"], [V1, "in_app", "catalog-new-items:501:2026-10-25"],
    ]);
    expect(day2[0]!.payload).toEqual({ throughArrivalId: arrivalOf.get(1108), categories: [
      { categoryId: ARMALOPE, categoryName: "Armalope", productCount: 1, sizeCount: 1, throughArrivalId: arrivalOf.get(1108) },
    ] });
    await expectMarksForward();

    // V2 mutes the new-items email; a new Toploaders size, and a new Binders size for V5.
    await pool.query(`INSERT INTO dropship.dropship_notification_preferences (vendor_id, event_type, critical, email_enabled, in_app_enabled)
      VALUES (${V2}, $1, false, false, false)`, [DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS]);
    await addSize(2103, 2100);
    await addSize(5302, 5300);
    now = DAY2("10:00");
    const start = lines.length;
    await service.runTick();
    await recordArrivalIds();
    const marks = await expectMarksForward();
    const events = await newItemsEvents();
    expect(events.filter((event) => event.vendorId === V2 && event.key.endsWith(":2026-10-25"))).toEqual([]);
    expect(marks.get(`${V2}:${TOPLOADERS}`)?.notified).toBe(arrivalOf.get(2103));
    expect(linesSince(start).find((line) => line.action === "dropship.catalog_arrivals.new_items_emailed" && line.fields.vendor_id === V2))
      .toMatchObject({ level: "info", fields: { outcome: "muted" } });
    // V5's first new item since its silent first mark.
    expect(events.filter((event) => event.vendorId === V5).map((event) => [event.channel, event.payload])).toEqual([
      ["email", { throughArrivalId: arrivalOf.get(5302), categories: [{ categoryId: BINDERS, categoryName: "Binders", productCount: 1, sizeCount: 1,
        throughArrivalId: arrivalOf.get(5302) }] }],
      ["in_app", expect.any(Object)],
    ]);
    // Step 1 still shows V2's new items: the email is a side channel; Got it is what clears them.
    expect((await readNewItems(V2)).categories).toEqual([{ categoryId: TOPLOADERS, categoryName: "Toploaders", productCount: 1, sizeCount: 2,
      throughArrivalId: arrivalOf.get(2103) }]);

    // The muted vendor's next tick finds nothing stored under today's key and nothing past its watermark: nothing sent.
    now = DAY2("11:00");
    const quietStart = lines.length;
    await service.runTick();
    expect((await newItemsEvents()).length).toBe(events.length);
    expect(linesSince(quietStart).filter((line) => line.action === "dropship.catalog_arrivals.new_items_emailed")).toEqual([]);
    expect(loud(linesSince(start))).toEqual([]);
  }, 60_000);

  it("Got it moves both watermarks forward with one audit row; a second or lower press is already_seen; another vendor's marks never move", async () => {
    const actor = { actorType: "vendor" as const, actorId: `member-${V1}` };
    const others = new Map([...(await readMarks())].filter(([key]) => !key.startsWith(`${V1}:`)));
    const acknowledged = await service.acknowledge({ vendorId: V1, actor, categoryId: ARMALOPE, throughArrivalId: arrivalOf.get(1108) });
    expect(acknowledged).toEqual({ outcome: "acknowledged", categoryId: ARMALOPE, seenThroughArrivalId: arrivalOf.get(1108) });
    expect(await readNewItems(V1)).toEqual({ categories: [] });
    expect(await newRows(V1, ARMALOPE)).toEqual([]);

    for (const through of [arrivalOf.get(1108)!, arrivalOf.get(1104)!]) {
      expect(await service.acknowledge({ vendorId: V1, actor, categoryId: ARMALOPE, throughArrivalId: through }))
        .toEqual({ outcome: "already_seen", categoryId: ARMALOPE, seenThroughArrivalId: arrivalOf.get(1108) });
    }
    await expect(service.acknowledge({ vendorId: V1, actor, categoryId: ARMALOPE, throughArrivalId: Math.max(...arrivalOf.values()) + 1 }))
      .rejects.toMatchObject({ code: "DROPSHIP_CATALOG_NOTICE_ACK_INVALID" });
    const audits = (await pool.query<{ vendor_id: number; entity_type: string; entity_id: string; actor_id: string; payload: Record<string, unknown> }>(
      `SELECT vendor_id, entity_type, entity_id, actor_id, payload FROM dropship.dropship_audit_events
       WHERE event_type = 'catalog_new_items_acknowledged'`)).rows;
    expect(audits).toEqual([{ vendor_id: V1, entity_type: "dropship_vendor_category_notice_marks", entity_id: String(ARMALOPE),
      actor_id: `member-${V1}`, payload: { categoryId: ARMALOPE, throughArrivalId: arrivalOf.get(1108),
        before: { seenThroughArrivalId: baselineMax, notifiedThroughArrivalId: arrivalOf.get(1108) },
        after: { seenThroughArrivalId: arrivalOf.get(1108), notifiedThroughArrivalId: arrivalOf.get(1108) } } }]);
    const marks = await expectMarksForward();
    expect(new Map([...marks].filter(([key]) => !key.startsWith(`${V1}:`)))).toEqual(others);
    // Nothing anywhere added a pick by itself: the picks are the release's, the follow-up's and the two saves of this story.
    expect((await picksOf(V1)).map((pick) => pick.id)).toEqual([1101, 1102, 1106, 1201, 1401]);
    expect((await picksOf(V5)).map((pick) => pick.id)).toEqual([5300]);
  }, 60_000);

  it("Got it on a missing mark, raced by a press that commits between its lock and its upsert: already_seen, no second audit row", async () => {
    const actor = { actorType: "vendor" as const, actorId: `member-${V1}` };
    // V1 does not sell from Binders, so it has no mark there: its lock finds no row to wait on.
    expect((await readMarks()).has(`${V1}:${BINDERS}`)).toBe(false);
    const through = arrivalOf.get(5302)!;
    const auditsBefore = await acknowledgeAuditCount(pool);
    const other = await pool.connect();
    try {
      // The other press: its mark is written, not yet committed.
      await other.query("BEGIN");
      await other.query(`INSERT INTO dropship.dropship_vendor_category_notice_marks
        (vendor_id, category_id, seen_through_arrival_id, notified_through_arrival_id, updated_at) VALUES ($1, $2, $3, $3, $4)`,
      [V1, BINDERS, through, now]);
      const pressed = service.acknowledge({ vendorId: V1, actor, categoryId: BINDERS, throughArrivalId: through });
      // This press's upsert waits on the other press's row (the unique key), after its lock read found nothing.
      await waitUntil("the upsert waiting on the other press", async () => (await pool.query<{ waiting: number }>(
        `SELECT count(*)::integer AS waiting FROM pg_stat_activity WHERE state = 'active' AND wait_event_type = 'Lock'
           AND ltrim(query) LIKE 'INSERT INTO dropship.dropship_vendor_category_notice_marks AS m%'`)).rows[0]!.waiting === 1);
      await other.query("COMMIT");
      // The upsert moves a mark only forward, so it changes nothing here: already_seen, and no audit row of its own.
      expect(await pressed).toEqual({ outcome: "already_seen", categoryId: BINDERS, seenThroughArrivalId: through });
    } finally {
      other.release();
    }
    expect(await acknowledgeAuditCount(pool)).toBe(auditsBefore);
    expect((await expectMarksForward()).get(`${V1}:${BINDERS}`)).toEqual({ seen: through, notified: through });
  }, 60_000);
});

/**
 * The release with three more vendors, each with a Toploaders category include (a broad rule: a conversion record and a
 * pending notice): V6 closed, V7 suspended, V8 paused; and V9 with a product include of 1300, whose only size (1301) is
 * not sellable, so its follow-up tidies its only pick (B3 review).
 */
const V6 = 506;
const V7 = 507;
const V8 = 508;
const V9 = 509;
const reviewSeedSql = `
  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status, email) VALUES
    (${V6}, 'member-${V6}', 'closed', 'lapsed', 'v6@example.test'), (${V7}, 'member-${V7}', 'suspended', 'suspended', 'v7@example.test'),
    (${V8}, 'member-${V8}', 'paused', 'active', 'v8@example.test'), (${V9}, 'member-${V9}', 'active', 'active', 'v9@example.test');
  INSERT INTO dropship.dropship_vendor_selection_rules (id, vendor_id, scope_type, action, product_id, category,
    auto_connect_new_skus, auto_list_new_skus, priority, is_active) OVERRIDING SYSTEM VALUE VALUES
    (61, ${V6}, 'category', 'include', NULL, 'Toploaders', true, false, 0, true),
    (71, ${V7}, 'category', 'include', NULL, 'Toploaders', true, false, 0, true),
    (81, ${V8}, 'category', 'include', NULL, 'Toploaders', true, false, 0, true),
    (91, ${V9}, 'product', 'include', 1300, NULL, true, false, 0, true);
`;

/** The follow-up's pick count statement, in HEAD's shape and in the split one (both count the vendor's picks by `vendor_id = $1`). */
const PICK_COUNT_STATEMENT = /SELECT \(*\(?SELECT count\(\*\)|SELECT count\(\*\)::integer AS pick_count/;

/**
 * A pool whose transaction clients await `before` ahead of every statement matching `statement` (its parameters given),
 * so a test commits a catalog write on another connection between two statements of one follow-up apply (SRV-1's
 * proxy, plus the pool's own `query` for the detection reads).
 */
function poolRunningBefore(pool: Pool, statement: RegExp, before: (values: unknown[]) => Promise<void>): Pick<Pool, "query" | "connect"> {
  return {
    query: pool.query.bind(pool) as Pool["query"],
    connect: async () => {
      const client = await pool.connect();
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      return new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return async (...args: unknown[]) => {
              if (typeof args[0] === "string" && statement.test(args[0])) await before(Array.isArray(args[1]) ? args[1] : []);
              return query(...args);
            };
          }
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  } as unknown as Pick<Pool, "query" | "connect">;
}

describeDatabase.sequential("the B3 review cases on the real B file: release-window edits, blocked vendors, a racing size delete (PostgreSQL)", () => {
  let pool: Pool;
  let close: () => Promise<void>;
  let now = DAY1("09:00");
  const lines: LogLine[] = [];
  const emailsSent: Array<{ toEmail: string; eventType: string }> = [];
  let notifications: DropshipNotificationService;
  let service: DropshipCatalogArrivalsService;
  let raced = 0;
  const log: CatalogJobLog = {
    debug: (action, fields) => lines.push({ level: "debug", action, fields }),
    info: (action, fields) => lines.push({ level: "info", action, fields }),
    warn: (action, fields) => lines.push({ level: "warn", action, fields }),
    error: (action, fields) => lines.push({ level: "error", action, fields }),
  };

  async function picksOf(vendorId: number): Promise<Array<{ id: number; source: string }>> {
    return (await pool.query<{ id: number; source: string }>(
      `SELECT product_variant_id AS id, source FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1 ORDER BY 1`,
      [vendorId])).rows;
  }

  async function eventsOf(eventType: string): Promise<Array<{ vendorId: number; channel: string }>> {
    return (await pool.query<{ vendor_id: number; channel: string }>(
      "SELECT vendor_id, channel FROM dropship.dropship_notification_events WHERE event_type = $1 ORDER BY id", [eventType])).rows
      .map((row) => ({ vendorId: row.vendor_id, channel: row.channel }));
  }

  async function markedVendors(): Promise<number[]> {
    return (await pool.query<{ vendor_id: number }>(
      "SELECT DISTINCT vendor_id FROM dropship.dropship_vendor_category_notice_marks ORDER BY vendor_id")).rows.map((row) => row.vendor_id);
  }

  async function addSize(id: number, productId: number): Promise<void> {
    await pool.query(`INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
      sales_eligibility, ebay_listing_excluded) VALUES ($1, $2, $3, $4, 'pack', true, true, true, 'sellable', false)`,
    [id, productId, `S-${id}`, `Size ${id}`]);
  }

  beforeAll(async () => {
    const database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, `${picksMigrationSchemaSql}\n${noticeSchemaSql}`);
    try {
      await installPicksMigrationPrerequisites(database.pool);
      await database.pool.query(releaseSeedSql);
      await database.pool.query(reviewSeedSql);
    } catch (error) {
      await database.close();
      throw error;
    }
    pool = new pg.Pool({ connectionString: database.connectionString, max: 6 });
    close = async () => { await pool.end(); await database.close(); };
    await releaseBFile(pool);
    notifications = new DropshipNotificationService({
      vendorProvisioning: { provisionForMember: async () => { throw new Error("not used"); } } as unknown as DropshipVendorProvisioningService,
      repository: new PgDropshipNotificationRepository(pool),
      emailSender: { send: async (input) => { emailsSent.push(input); } },
      clock: { now: () => now },
      logger: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    // The catalog hard-deletes size 1301 (its picks cascade; no vendor lock stops it) right before V9's pick count statement.
    const racedPool = poolRunningBefore(pool, PICK_COUNT_STATEMENT, async (values) => {
      if (raced > 0 || values[0] !== V9) return;
      raced += 1;
      await pool.query("DELETE FROM catalog.product_variants WHERE id = 1301");
    });
    const followUp = new DropshipSelectionConversionFollowUp({
      repository: new PgDropshipSelectionConversionFollowUpRepository(racedPool),
      notifications, log, sleep: async () => undefined, random: seededJitterSource(13),
    });
    service = new DropshipCatalogArrivalsService({
      repository: new PgDropshipCatalogArrivalsRepository(pool), notifications, followUp, clock: { now: () => now }, timer: () => 0, log,
      catalogUrl: "https://portal.example.test/catalog/choose",
    });
  }, 180_000);

  afterAll(async () => {
    await close?.();
  });

  it("repairs only sizes the conversion read as they stand: a size created, or a product moved, in the window is never repaired (FUP-1)", async () => {
    const provider = (await pool.query<{ provider: string }>(
      "SELECT datlocprovider AS provider FROM pg_database WHERE datname = current_database()")).rows[0]!.provider;
    const lowered = async (values: readonly string[]) => (await pool.query<{ value: string }>(
      "SELECT lower(x) AS value FROM unnest($1::text[]) WITH ORDINALITY u(x, n) ORDER BY n", [[...values]])).rows.map((row) => row.value);
    if (provider === "c") {
      // This cluster's lower() disagrees with JavaScript on the pairs used below (A10), so the window edits would be repaired.
      expect(await lowered(["ΚΑΡΤΕΣ", "İSTANBUL"])).toEqual(["καρτεσ", "istanbul"]);
      expect(["ΚΑΡΤΕΣ".toLowerCase(), "İSTANBUL".toLowerCase()]).toEqual(["καρτες", "i\u0307stanbul"]);
    }
    expect((await picksOf(V3)).find((pick) => pick.id === 3401)).toEqual({ id: 3401, source: "legacy_broad_rule" });

    // After the release and before the first B tick: a new size of the καρτες product (TS true, SQL false, no pick), the
    // picked école product moved to istanbul (TS false, SQL true, a legacy pick), and Armalope product 1100 moved to
    // καρτες (TS true, SQL false, unpicked by V3, listed by V1).
    await addSize(3102, 3100);
    await pool.query("UPDATE catalog.products SET category = 'istanbul', category_id = 63 WHERE id = 3400");
    await pool.query("UPDATE catalog.products SET category = 'καρτες', category_id = 61 WHERE id = 1100");
    const result = await service.runTick();
    expect(result.outcome).toBe("completed");
    expect(result.followUp).toMatchObject({ conversionsRead: 6, followUpsDone: 6, vendorsFailed: 0, requiresReview: 0 });

    // V3: only the conversion's own disagreements are repaired (3101 in; 3201, 3301 out on this cluster); the window's
    // edits keep the picks the conversion wrote, and nothing is added to sizes it never decided.
    const v3 = await picksOf(V3);
    expect(v3.filter((pick) => [3102, 1101, 1102].includes(pick.id))).toEqual([]);
    expect(v3.find((pick) => pick.id === 3401)).toEqual({ id: 3401, source: "legacy_broad_rule" });
    if (provider === "c") {
      expect(v3).toEqual([{ id: 3101, source: "conversion_repair" }, { id: 3401, source: "legacy_broad_rule" }]);
    }
    const audit = (await pool.query<{ payload: { repairedInsertedVariantIds: number[]; repairedDeletedVariantIds: number[] } }>(
      `SELECT payload FROM dropship.dropship_audit_events WHERE event_type = 'vendor_selection_conversion_followed_up' AND vendor_id = ${V3}`)).rows;
    expect(audit).toHaveLength(1);
    for (const id of [3102, 1101, 1102]) expect(audit[0]!.payload.repairedInsertedVariantIds).not.toContain(id);
    expect(audit[0]!.payload.repairedDeletedVariantIds).not.toContain(3401);
    // V1 keeps its moved Armalope picks (no repair, offered, listed or not).
    expect((await picksOf(V1)).filter((pick) => pick.id === 1101 || pick.id === 1102))
      .toEqual([{ id: 1101, source: "legacy_broad_rule" }, { id: 1102, source: "legacy_broad_rule" }]);
  }, 120_000);

  it("re-plans V9's tidy when the catalog deletes its size before the pick count, with no fatal negative count", async () => {
    expect(raced).toBe(1);
    expect((await pool.query("SELECT 1 FROM catalog.product_variants WHERE id = 1301")).rows).toEqual([]);
    const conversion = (await pool.query(`SELECT followup_state, followup_failures, last_error_code FROM dropship.dropship_selection_conversions
      WHERE vendor_id = ${V9}`)).rows;
    expect(conversion).toEqual([{ followup_state: "done", followup_failures: 0, last_error_code: null }]);
    expect(await picksOf(V9)).toEqual([]);
    // The first attempt's revision (pick count 0, never -1) rolled back with it; the second found nothing left to tidy.
    expect((await pool.query(`SELECT 1 FROM dropship.dropship_vendor_selection_rule_set_revisions
      WHERE vendor_id = ${V9} AND request_kind = 'picks_conversion_followup'`)).rows).toEqual([]);
    expect((await pool.query<{ payload: { outcome: string; tidiedVariantIds: number[] } }>(`SELECT payload FROM dropship.dropship_audit_events
      WHERE event_type = 'vendor_selection_conversion_followed_up' AND vendor_id = ${V9}`)).rows.map((row) => row.payload))
      .toEqual([expect.objectContaining({ outcome: "nothing_to_change", tidiedVariantIds: [] })]);
    expect(lines.filter((line) => line.action === "dropship.selection.conversion_followup_retry" && line.fields.vendor_id === V9))
      .toEqual([expect.objectContaining({ level: "debug", fields: expect.objectContaining({ error_code: SELECTION_CHANGE_PLAN_MOVED }) })]);
    expect(loud(lines).filter((line) => line.action !== "dropship.selection.conversion_repaired")).toEqual([]);
  }, 60_000);

  it("tells only the vendors step 1 lets in: no conversion notice, first mark or new-items email for closed or suspended vendors; a paused one gets them (JOB-1)", async () => {
    // The conversion notice: V8 (paused) and V9 now; V6 (closed) and V7 (suspended) wait, their follow-up done.
    const converted = await eventsOf(DROPSHIP_NOTIFICATION_EVENTS.SELECTION_RULES_CONVERTED);
    expect([...new Set(converted.map((event) => event.vendorId))]).toEqual([V1, V3, V8, V9]);
    const states = (await pool.query(`SELECT vendor_id, followup_state, notice_state FROM dropship.dropship_selection_conversions
      WHERE vendor_id IN (${V6}, ${V7}, ${V8}) ORDER BY vendor_id`)).rows;
    expect(states).toEqual([
      { vendor_id: V6, followup_state: "done", notice_state: "pending" }, { vendor_id: V7, followup_state: "done", notice_state: "pending" },
      { vendor_id: V8, followup_state: "done", notice_state: "sent" },
    ]);
    expect(lines.filter((line) => line.action === "dropship.selection.conversion_notice_deferred").map((line) => [line.fields.vendor_id,
      line.fields.vendor_status])).toEqual([[V6, "closed"], [V7, "suspended"]]);

    // The same tick wrote the baseline and first-marked only the vendors that may open the catalog.
    expect(await markedVendors()).toEqual([V1, V2, V3, V8]);
    await addSize(2102, 2100);
    now = DAY1("10:00");
    const tick = await service.runTick();
    expect(tick.notices).toMatchObject({ vendorsBlocked: 2, vendorsFailed: 0 });
    const newItems = await eventsOf(DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS);
    expect([...new Set(newItems.map((event) => event.vendorId))]).toEqual([V2, V8]);
    expect(emailsSent.filter((email) => ["v6@example.test", "v7@example.test"].includes(email.toEmail))).toEqual([]);

    // V7 is active again: its conversion notice goes out on the next tick, and it is first-marked silently, so the next
    // email names only what arrives after.
    await pool.query(`UPDATE dropship.dropship_vendors SET status = 'active', entitlement_status = 'active' WHERE id = ${V7}`);
    now = DAY1("11:00");
    await service.runTick();
    expect((await eventsOf(DROPSHIP_NOTIFICATION_EVENTS.SELECTION_RULES_CONVERTED)).filter((event) => event.vendorId === V7)).toHaveLength(2);
    expect(await markedVendors()).toEqual([V1, V2, V3, V7, V8]);
    expect((await eventsOf(DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS)).filter((event) => event.vendorId === V7)).toEqual([]);
    await addSize(2103, 2100);
    now = DAY1("12:00");
    await service.runTick();
    expect((await eventsOf(DROPSHIP_NOTIFICATION_EVENTS.CATALOG_NEW_ITEMS)).filter((event) => event.vendorId === V7)).toHaveLength(2);
    expect(emailsSent.filter((email) => email.toEmail === "v6@example.test")).toEqual([]);
    expect((await pool.query(`SELECT notice_state FROM dropship.dropship_selection_conversions WHERE vendor_id = ${V6}`)).rows)
      .toEqual([{ notice_state: "pending" }]);
    expect(loud(lines).filter((line) => line.action !== "dropship.selection.conversion_repaired")).toEqual([]);
  }, 120_000);
});

/** A large tidy (B3a risk note): sizes per product, the unoffered never-listed picks, and its budgets (TESTS-15). */
const TIDY_VENDOR = 70;
const TIDY_STORE = 701;
const TIDY_UNOFFERED_SIZES = 10_000;
const TIDY_LISTED_UNOFFERED_SIZES = 100;
const TIDY_OFFERED_SIZES = 500;
const TIDY_CASE_TIMEOUT_MS = 180_000;
/**
 * The tidy's budgets (the plan names none): the picks save's own (§15.3), the whole stage within 20 s and the gate
 * within 5 s, since the tidy's gated delete is the save's delete. Other gate takers (catalog edits, stock sends) answer
 * BUSY meanwhile and retry. The picks re-plan each product a statement touched once (R4), so the hold grows with the
 * products tidied, not the sizes: the per-row invalidation held this gate 5.3-5.5 s here (B3b).
 */
const TIDY_STAGE_BUDGET_MS = 20_000;
const TIDY_GATE_HOLD_BUDGET_MS = 5_000;

/**
 * A catalog-include vendor at the release whose rule matched 10,000 sizes Card Shellz does not offer now (internal
 * only, 2,000 products of 5), 100 of them listed on its store, and 500 offered sizes (100 products). Every size has an
 * active mapping head (10,500 heads, the change suite's scale), so each product's invalidation costs what it does there.
 */
const tidySeedSql = `
  INSERT INTO catalog.products (id, sku, name, category, is_active, status, product_type, ebay_listing_excluded)
    SELECT g, 'P-' || g, 'Product ' || g, 'Supplies', true, 'active', 'sleeves', false FROM generate_series(20001, 22100) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 20001 + (g - 200001) / 5, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'internal_only', false
    FROM generate_series(200001, ${200_000 + TIDY_UNOFFERED_SIZES}) g;
  INSERT INTO catalog.product_variants (id, product_id, sku, name, uom_type, is_active, requires_shipping, track_inventory,
    sales_eligibility, ebay_listing_excluded)
    SELECT g, 22001 + (g - 210001) / 5, 'S-' || g, 'Size ' || g, 'pack', true, true, true, 'sellable', false
    FROM generate_series(210001, ${210_000 + TIDY_OFFERED_SIZES}) g;
  INSERT INTO dropship.dropship_catalog_rules (scope_type, action, is_active, priority) VALUES ('catalog', 'include', true, 0);
  INSERT INTO inventory.publication_variant_mapping_heads (publication_target_id, product_variant_id, active_mapping_id)
    SELECT 1, id, id FROM catalog.product_variants;
  INSERT INTO dropship.dropship_vendors (id, member_id, status, entitlement_status, email)
    VALUES (${TIDY_VENDOR}, 'member-${TIDY_VENDOR}', 'active', 'active', 'v70@example.test');
  INSERT INTO dropship.dropship_store_connections (id, vendor_id, platform, status, external_account_id, provider_environment)
    VALUES (${TIDY_STORE}, ${TIDY_VENDOR}, 'ebay', 'connected', 'seller-${TIDY_STORE}', 'production');
  INSERT INTO dropship.dropship_store_listing_configs (store_connection_id, platform, listing_mode, inventory_mode, is_active)
    VALUES (${TIDY_STORE}, 'ebay', 'live', 'managed_quantity_sync', true);
  INSERT INTO dropship.dropship_vendor_listings (vendor_id, store_connection_id, product_variant_id, platform, status,
    external_listing_id, external_offer_id)
    SELECT ${TIDY_VENDOR}, ${TIDY_STORE}, g, 'ebay', 'active', 'L-' || g, 'O-' || g
    FROM generate_series(200001, ${200_000 + TIDY_LISTED_UNOFFERED_SIZES}) g;
  INSERT INTO dropship.dropship_vendor_selection_rules (vendor_id, scope_type, action, auto_connect_new_skus,
    auto_list_new_skus, priority, is_active) VALUES (${TIDY_VENDOR}, 'catalog', 'include', true, false, 0, true);
`;

describeDatabase.sequential("a large tidy on the real B file (PostgreSQL, measured)", () => {
  let pool: Pool;
  let close: () => Promise<void>;
  const lines: LogLine[] = [];
  const noticesSent: Array<{ vendorId: number; idempotencyKey: string }> = [];

  beforeAll(async () => {
    const database = await createInventoryCutoverTestDatabase(databaseUrl, disposable, `${picksMigrationSchemaSql}\n${noticeSchemaSql}`);
    try {
      await installPicksMigrationPrerequisites(database.pool);
      await database.pool.query(PICKS_PRODUCTION_INDEXES_SQL);
      await database.pool.query(tidySeedSql);
    } catch (error) {
      await database.close();
      throw error;
    }
    pool = new pg.Pool({ connectionString: database.connectionString, max: 6 });
    close = async () => { await pool.end(); await database.close(); };
    await releaseBFile(pool);
    await pool.query("ANALYZE");
  }, TIDY_CASE_TIMEOUT_MS);

  afterAll(async () => {
    await close?.();
  });

  it(`tidies ${TIDY_UNOFFERED_SIZES - TIDY_LISTED_UNOFFERED_SIZES} unoffered never-listed broad picks in one gated delete within ${TIDY_GATE_HOLD_BUDGET_MS} ms of gate`, async () => {
    const tidied = TIDY_UNOFFERED_SIZES - TIDY_LISTED_UNOFFERED_SIZES;
    expect((await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM dropship.dropship_vendor_selected_variants
      WHERE vendor_id = ${TIDY_VENDOR} AND source = 'legacy_broad_rule'`)).rows[0]!.count).toBe(TIDY_UNOFFERED_SIZES + TIDY_OFFERED_SIZES);
    const workBefore = await workRevisions(pool);
    const log: CatalogJobLog = {
      debug: (action, fields) => lines.push({ level: "debug", action, fields }),
      info: (action, fields) => lines.push({ level: "info", action, fields }),
      warn: (action, fields) => lines.push({ level: "warn", action, fields }),
      error: (action, fields) => lines.push({ level: "error", action, fields }),
    };
    const followUp = new DropshipSelectionConversionFollowUp({
      repository: new PgDropshipSelectionConversionFollowUpRepository(pool),
      // The notice's delivery is the story's (above); here only that it is asked for once.
      notifications: { send: async (input) => { noticesSent.push(input); return { events: [{}], idempotentReplay: false }; } },
      log, sleep: async () => undefined, random: seededJitterSource(11),
    });

    const sampler = samplePublicationSelectionGate(pool);
    const started = performance.now();
    const result = await followUp.runStage(DAY1("09:00"));
    const stageMs = performance.now() - started;
    const gateHoldMs = publicationSelectionGateHoldMs(await sampler.stop());

    expect(result).toMatchObject({ conversionsRead: 1, followUpsDone: 1, followUpsBusy: 0, noticesSent: 1, vendorsFailed: 0 });
    // Kept: the offered sizes and the listed unoffered ones (they sell again when offered).
    const kept = (await pool.query<{ id: number }>(`SELECT product_variant_id AS id FROM dropship.dropship_vendor_selected_variants
      WHERE vendor_id = ${TIDY_VENDOR} ORDER BY 1`)).rows.map((row) => row.id);
    expect(kept).toEqual([
      ...Array.from({ length: TIDY_LISTED_UNOFFERED_SIZES }, (_, index) => 200_001 + index),
      ...Array.from({ length: TIDY_OFFERED_SIZES }, (_, index) => 210_001 + index),
    ]);
    const audit = (await pool.query<{ payload: { tidiedVariantIds: number[]; counts: { tidied: number } } }>(`SELECT payload
      FROM dropship.dropship_audit_events WHERE event_type = 'vendor_selection_conversion_followed_up' AND vendor_id = ${TIDY_VENDOR}`)).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.payload.counts.tidied).toBe(tidied);
    expect(audit[0]!.payload.tidiedVariantIds).toEqual(Array.from({ length: tidied }, (_, index) => 200_001 + TIDY_LISTED_UNOFFERED_SIZES + index));
    // Only the products whose picks went were invalidated (sizes 200101-210000: products 20021-22000).
    const workAfter = await workRevisions(pool);
    const bumped = [...workAfter].filter(([productId, revision]) => workBefore.get(productId) !== revision).map(([productId]) => productId);
    expect({ low: Math.min(...bumped), high: Math.max(...bumped), n: bumped.length }).toEqual({ low: 20_021, high: 22_000, n: 1_980 });
    expect(noticesSent.map((notice) => notice.idempotencyKey)).toEqual([`selection-rules-converted:${TIDY_VENDOR}`]);
    expect(loud(lines)).toEqual([]);

    // Recorded for BUILD-NOTES (§15.3), as the change suite records the save at 10,000 picks.
    process.stdout.write(`[pg-record] large tidy: ${JSON.stringify({ tidied, stageMs: Math.round(stageMs), gateHoldMs: Math.round(gateHoldMs) })}\n`);
    expect(gateHoldMs).toBeGreaterThan(0);
    expect(stageMs).toBeLessThan(TIDY_STAGE_BUDGET_MS);
    expect(gateHoldMs).toBeLessThan(TIDY_GATE_HOLD_BUDGET_MS);
  }, TIDY_CASE_TIMEOUT_MS);
});

/** The release: the real B file through the release executor. */
async function releaseBFile(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const sql = selectedVariantsMigrationSql();
    await executeMigrationWithRetry({
      client, file: SELECTED_VARIANTS_MIGRATION_FILE, sql, contentHash: createHash("sha256").update(sql).digest("hex"),
      options: { maxAttempts: 5, retryBaseDelayMs: 1, retryMaxDelayMs: 1, lockTimeoutMs: 15_000 },
      onRetry: () => undefined, sleep: async () => undefined,
    });
  } finally {
    client.release();
  }
}

/** Each product's publication selection work revision (0743), as text. */
async function workRevisions(pool: Pool): Promise<Map<number, string>> {
  return new Map((await pool.query<{ product_id: number; revision: string }>(
    "SELECT product_id, revision::text AS revision FROM inventory.publication_selection_work")).rows.map((row) => [row.product_id, row.revision]));
}

/**
 * The real repository whose baseline fails part way: the second batch's insert carries a row the ledger's NOT NULL
 * refuses, so a real statement fails inside the baseline's one transaction after the first batch was written.
 */
class FailingSecondInsertRepository extends PgDropshipCatalogArrivalsRepository {
  insertCalls = 0;
  firstBatchInserted = 0;

  override async runLedgerTransaction<T>(input: { statementTimeoutMs: number }, work: (session: CatalogArrivalsLedgerSession) => Promise<T>): Promise<T> {
    return super.runLedgerTransaction(input, (session) => work({
      ...session,
      insertArrivals: async (args) => {
        this.insertCalls += 1;
        if (this.insertCalls === 1) {
          this.firstBatchInserted = await session.insertArrivals(args);
          return this.firstBatchInserted;
        }
        return session.insertArrivals({ ...args, rows: [...args.rows, { productVariantId: null as unknown as number, productId: 1, categoryId: 1 }] });
      },
    }));
  }
}

async function acknowledgeAuditCount(pool: Pool): Promise<number> {
  return (await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM dropship.dropship_audit_events
    WHERE event_type = 'catalog_new_items_acknowledged'`)).rows[0]!.count;
}

/** Polls `condition` every 5 ms until it holds, or fails after 10 s naming what it waited for. */
async function waitUntil(what: string, condition: () => Promise<boolean>): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!(await condition())) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise<void>((resolve) => { setTimeout(resolve, 5); });
  }
}

async function revisionCount(pool: Pool): Promise<number> {
  return (await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM dropship.dropship_vendor_selection_rule_set_revisions")).rows[0]!.count;
}

async function arrivalCount(pool: Pool): Promise<number> {
  return (await pool.query<{ count: number }>("SELECT count(*)::integer AS count FROM dropship.dropship_catalog_arrivals")).rows[0]!.count;
}

/** Every table a follow-up re-run could write. */
async function tableCounts(pool: Pool): Promise<Record<string, number>> {
  const tables = ["dropship.dropship_vendor_selection_rule_set_revisions", "dropship.dropship_vendor_selected_variants",
    "dropship.dropship_audit_events", "dropship.dropship_notification_events", "dropship.dropship_selection_conversions"];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    counts[table] = (await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM ${table}`)).rows[0]!.count;
  }
  return counts;
}
