import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  CatalogAcknowledgeTransaction,
  CatalogArrivalsLedgerSession,
  CatalogNewForVendorFacts,
  DropshipCatalogArrivalsRepository,
} from "../application/dropship-catalog-arrivals-service";
import { loadSelectedCategoryIds } from "../application/dropship-selected-catalog";
import {
  invariantFailed,
  type CatalogArrivalFact,
  type CatalogArrivalSubject,
  type CatalogNoticeMark,
} from "../domain/catalog-arrivals";
import { PgDropshipListingPreviewRepository } from "./dropship-listing-preview.repository";
import {
  listSellableVariantIdsAfter,
  SELLABLE_VARIANT_SQL,
  selectedCatalogReaderForTransaction,
} from "./dropship-selected-catalog.reader";

/**
 * The new-items notice's PostgreSQL side (PLAN-B v4.1 §6 step 9, §11.1,
 * §11.4): the arrivals ledger (append-only: a trigger refuses UPDATE and
 * DELETE), the vendors' category marks and the reads "new for a vendor" is
 * decided from. The service decides; this module runs parameterized
 * statements. Arrival ids are bigint, which node-postgres returns as text:
 * every one is parsed back to a safe integer or refused (fatal).
 */

type Queryable = Pick<PoolClient, "query">;

/** One snapshot, no lock, for every read-only read (the selection summary's precedent). */
const SNAPSHOT_BEGIN_SQL = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
/** Arrivals "new for V" reads at a time, in arrival id order. */
const NEW_FOR_VENDOR_BATCH_SIZE = 1_000;

/** The exposure facts and category of sizes that pass the sellable filter (the preview candidates' columns, CandidateRow). */
const ARRIVAL_SUBJECTS_SQL = `SELECT pv.id AS product_variant_id, p.id AS product_id,
       ARRAY_REMOVE(ARRAY_AGG(DISTINCT plp.product_line_id), NULL) AS product_line_ids,
       p.category, p.category_id, p.is_active AS product_is_active, pv.is_active AS variant_is_active
  FROM catalog.product_variants pv
  INNER JOIN catalog.products p ON p.id = pv.product_id
  LEFT JOIN catalog.product_line_products plp ON plp.product_id = p.id
  WHERE pv.id = ANY($1::int[]) AND ${SELLABLE_VARIANT_SQL}
  GROUP BY p.id, pv.id
  ORDER BY pv.id`;

interface SubjectRow {
  product_variant_id: number;
  product_id: number;
  product_line_ids: number[] | null;
  category: string | null;
  category_id: number | null;
  product_is_active: boolean;
  variant_is_active: boolean;
}

interface MarkRow {
  category_id: number;
  seen_through_arrival_id: string | number;
  notified_through_arrival_id: string | number;
}

interface ArrivalFactRow {
  arrival_id: string | number;
  product_variant_id: number;
  product_id: number;
  category_id: number;
  baseline: boolean;
  picked: boolean;
  turned_off: boolean;
}

export class PgDropshipCatalogArrivalsRepository implements DropshipCatalogArrivalsRepository {
  constructor(private readonly dbPool: Pick<Pool, "query" | "connect"> = defaultPool) {}

  async runLedgerTransaction<T>(input: { statementTimeoutMs: number }, work: (session: CatalogArrivalsLedgerSession) => Promise<T>): Promise<T> {
    if (!Number.isSafeInteger(input.statementTimeoutMs) || input.statementTimeoutMs <= 0) {
      throw invariantFailed("The arrivals ledger transaction was given no valid statement timeout.");
    }
    return this.inTransaction("BEGIN", async (client) => {
      // A whole number of milliseconds, inlined: SET takes no parameter.
      await client.query(`SET LOCAL statement_timeout = ${input.statementTimeoutMs}`);
      return work(ledgerSession(client));
    });
  }

  ledgerOnPool(): CatalogArrivalsLedgerSession {
    return ledgerSession(this.dbPool);
  }

  async readMaxArrivalId(): Promise<number> {
    return readMaxArrivalId(this.dbPool);
  }

  async listVendorsWithPicks(): Promise<Array<{ vendorId: number; status: string }>> {
    const result = await this.dbPool.query<{ id: number; status: unknown }>(
      `SELECT v.id, v.status FROM dropship.dropship_vendors v
       WHERE EXISTS (SELECT 1 FROM dropship.dropship_vendor_selected_variants s WHERE s.vendor_id = v.id)
       ORDER BY v.id`);
    return result.rows.map((row) => {
      if (typeof row.status !== "string" || row.status === "") {
        throw invariantFailed("A vendor status read by the arrivals job failed its contract.", { vendorId: String(row.id) });
      }
      return { vendorId: requiredId(row.id, "vendor"), status: row.status };
    });
  }

  async readSellFromCategoryIds(input: { vendorId: number; now: Date }): Promise<number[]> {
    return this.inTransaction(SNAPSHOT_BEGIN_SQL,
      (client) => loadSelectedCategoryIds(selectedCatalogReaderForTransaction(client, input.vendorId), input.now));
  }

  async listMarks(vendorId: number): Promise<CatalogNoticeMark[]> {
    const result = await this.dbPool.query<MarkRow>(
      `SELECT category_id, seen_through_arrival_id, notified_through_arrival_id
       FROM dropship.dropship_vendor_category_notice_marks
       WHERE vendor_id = $1
       ORDER BY category_id`, [vendorId]);
    return result.rows.map(mapMark);
  }

  async insertFirstMarks(input: {
    vendorId: number; marks: ReadonlyArray<{ categoryId: number; throughArrivalId: number }>; now: Date;
  }): Promise<number> {
    if (input.marks.length === 0) return 0;
    // Both watermarks at the ledger's highest arrival id (the first-mark rule); an existing mark is never changed.
    const inserted = await this.dbPool.query(
      `INSERT INTO dropship.dropship_vendor_category_notice_marks
         (vendor_id, category_id, seen_through_arrival_id, notified_through_arrival_id, updated_at)
       SELECT $1, m.category_id, m.through, m.through, $4
       FROM unnest($2::int[], $3::bigint[]) AS m(category_id, through)
       ORDER BY m.category_id
       ON CONFLICT (vendor_id, category_id) DO NOTHING`,
      [input.vendorId, input.marks.map((mark) => mark.categoryId), input.marks.map((mark) => mark.throughArrivalId), input.now]);
    return inserted.rowCount ?? 0;
  }

  async readNewForVendorFacts(input: {
    vendorId: number; categoryIds: readonly number[]; watermark: "notified" | "seen";
  }): Promise<CatalogNewForVendorFacts> {
    return this.inTransaction(SNAPSHOT_BEGIN_SQL, (client) => readNewForVendorFacts(client, input));
  }

  async advanceNotifiedMarks(input: {
    vendorId: number; marks: ReadonlyArray<{ categoryId: number; throughArrivalId: number }>; now: Date;
  }): Promise<number> {
    if (input.marks.length === 0) return 0;
    // One statement, so every named mark moves or none does; only forward (GREATEST).
    const moved = await this.dbPool.query(
      `UPDATE dropship.dropship_vendor_category_notice_marks m
       SET notified_through_arrival_id = GREATEST(m.notified_through_arrival_id, x.through), updated_at = $4
       FROM unnest($2::int[], $3::bigint[]) AS x(category_id, through)
       WHERE m.vendor_id = $1 AND m.category_id = x.category_id AND m.notified_through_arrival_id < x.through`,
      [input.vendorId, input.marks.map((mark) => mark.categoryId), input.marks.map((mark) => mark.throughArrivalId), input.now]);
    return moved.rowCount ?? 0;
  }

  async runAcknowledge<T>(work: (tx: CatalogAcknowledgeTransaction) => Promise<T>): Promise<T> {
    return this.inTransaction("BEGIN", (client) => work(acknowledgeTransaction(client)));
  }

  /** `begin`, `work`, COMMIT; ROLLBACK and rethrow the original error. A connection whose rollback failed is destroyed. */
  private async inTransaction<T>(begin: string, work: (client: Queryable) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    let rollbackFailure: Error | undefined;
    try {
      await client.query(begin);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      rollbackFailure = await rollbackQuietly(client);
      throw error;
    } finally {
      client.release(rollbackFailure);
    }
  }
}

function ledgerSession(client: Queryable): CatalogArrivalsLedgerSession {
  return {
    listSellableVariantIdsAfter: (afterId, limit) => listSellableVariantIdsAfter(client, afterId, limit),
    readArrivalSubjects: (productVariantIds) => readArrivalSubjects(client, productVariantIds),
    listCatalogExposureRules: () => PgDropshipListingPreviewRepository.readerForTransaction(client).listCatalogExposureRules(),
    async ledgerIsEmpty() {
      const result = await client.query<{ empty: boolean }>(
        "SELECT NOT EXISTS (SELECT 1 FROM dropship.dropship_catalog_arrivals) AS empty");
      return result.rows[0]?.empty === true;
    },
    async insertArrivals({ rows, baseline, now }) {
      if (rows.length === 0) return 0;
      // In size order, so the identity ids follow the catalog; a (size, category) already there is kept as it is.
      // The NOT EXISTS leaves known rows out before an id is drawn (an hourly run offers every size again, and
      // a conflicting row would still use up an identity value); ON CONFLICT stays as the backstop.
      const inserted = await client.query(
        `INSERT INTO dropship.dropship_catalog_arrivals (product_variant_id, product_id, category_id, first_seen_at, baseline)
         SELECT r.product_variant_id, r.product_id, r.category_id, $4, $5
         FROM unnest($1::int[], $2::int[], $3::int[]) AS r(product_variant_id, product_id, category_id)
         WHERE NOT EXISTS (SELECT 1 FROM dropship.dropship_catalog_arrivals a
                           WHERE a.product_variant_id = r.product_variant_id AND a.category_id = r.category_id)
         ORDER BY r.product_variant_id, r.category_id
         ON CONFLICT (product_variant_id, category_id) DO NOTHING`,
        [rows.map((row) => row.productVariantId), rows.map((row) => row.productId), rows.map((row) => row.categoryId), now, baseline]);
      return inserted.rowCount ?? 0;
    },
  };
}

async function readArrivalSubjects(client: Queryable, productVariantIds: readonly number[]): Promise<CatalogArrivalSubject[]> {
  if (productVariantIds.length === 0) return [];
  const result = await client.query<SubjectRow>(ARRIVAL_SUBJECTS_SQL, [[...new Set(productVariantIds)]]);
  return result.rows.map((row) => ({
    productVariantId: requiredId(row.product_variant_id, "size"),
    productId: requiredId(row.product_id, "product"),
    productLineIds: row.product_line_ids ?? [],
    category: row.category,
    categoryId: row.category_id === null ? null : requiredId(row.category_id, "category"),
    productIsActive: row.product_is_active === true,
    variantIsActive: row.variant_is_active === true,
  }));
}

async function readMaxArrivalId(client: Queryable): Promise<number> {
  const result = await client.query<{ max_id: string | number }>(
    "SELECT COALESCE(max(id), 0) AS max_id FROM dropship.dropship_catalog_arrivals");
  return arrivalId(result.rows[0]?.max_id);
}

/**
 * The facts "new for V" is decided from, in the caller's snapshot: the
 * vendor's marks of the asked categories, then the arrivals of those
 * categories past the asked watermark (keyset by arrival id), each with the
 * vendor's pick and override as columns of the same row, then their sizes
 * that are still sellable, the admin exposure rules and the category names.
 */
async function readNewForVendorFacts(client: Queryable, input: {
  vendorId: number; categoryIds: readonly number[]; watermark: "notified" | "seen";
}): Promise<CatalogNewForVendorFacts> {
  const categoryIds = [...new Set(input.categoryIds)].sort((left, right) => left - right);
  const marks = categoryIds.length === 0 ? [] : (await client.query<MarkRow>(
    `SELECT category_id, seen_through_arrival_id, notified_through_arrival_id
     FROM dropship.dropship_vendor_category_notice_marks
     WHERE vendor_id = $1 AND category_id = ANY($2::int[])
     ORDER BY category_id`, [input.vendorId, categoryIds])).rows.map(mapMark);
  // The column is chosen from a closed set, never from input text.
  const watermarkColumn = input.watermark === "notified" ? "m.notified_through_arrival_id" : "m.seen_through_arrival_id";
  const arrivals: CatalogArrivalFact[] = [];
  if (marks.length > 0) {
    let afterArrivalId = 0;
    for (;;) {
      const batch = (await client.query<ArrivalFactRow>(
        `SELECT a.id AS arrival_id, a.product_variant_id, a.product_id, a.category_id, a.baseline,
                EXISTS (SELECT 1 FROM dropship.dropship_vendor_selected_variants s
                        WHERE s.vendor_id = $1 AND s.product_variant_id = a.product_variant_id) AS picked,
                EXISTS (SELECT 1 FROM dropship.dropship_vendor_variant_overrides o
                        WHERE o.vendor_id = $1 AND o.product_variant_id = a.product_variant_id
                          AND o.enabled_override = false) AS turned_off
         FROM dropship.dropship_vendor_category_notice_marks m
         INNER JOIN dropship.dropship_catalog_arrivals a ON a.category_id = m.category_id AND a.id > ${watermarkColumn}
         WHERE m.vendor_id = $1 AND m.category_id = ANY($2::int[]) AND a.id > $3
         ORDER BY a.id
         LIMIT $4`,
        [input.vendorId, marks.map((mark) => mark.categoryId), afterArrivalId, NEW_FOR_VENDOR_BATCH_SIZE])).rows.map(mapArrivalFact);
      if (batch.length === 0) break;
      arrivals.push(...batch);
      afterArrivalId = batch[batch.length - 1].arrivalId;
      if (batch.length < NEW_FOR_VENDOR_BATCH_SIZE) break;
    }
  }
  const subjects = await readArrivalSubjects(client, arrivals.map((arrival) => arrival.productVariantId));
  const exposureRules = arrivals.length === 0 ? []
    : await PgDropshipListingPreviewRepository.readerForTransaction(client).listCatalogExposureRules();
  const namedCategoryIds = [...new Set(arrivals.map((arrival) => arrival.categoryId))];
  const categoryNames = namedCategoryIds.length === 0 ? [] : (await client.query<{ id: number; name: string }>(
    "SELECT id, name FROM catalog.product_categories WHERE id = ANY($1::int[]) ORDER BY id", [namedCategoryIds]))
    .rows.map((row) => ({ categoryId: requiredId(row.id, "category"), name: row.name }));
  return { marks, arrivals, subjects, exposureRules, categoryNames };
}

function acknowledgeTransaction(client: Queryable): CatalogAcknowledgeTransaction {
  return {
    readMaxArrivalId: () => readMaxArrivalId(client),
    async lockMark({ vendorId, categoryId }) {
      const result = await client.query<MarkRow>(
        `SELECT category_id, seen_through_arrival_id, notified_through_arrival_id
         FROM dropship.dropship_vendor_category_notice_marks
         WHERE vendor_id = $1 AND category_id = $2
         FOR UPDATE`, [vendorId, categoryId]);
      return result.rows[0] ? mapMark(result.rows[0]) : null;
    },
    async upsertMark(input) {
      // Only forward, and only when it moves something: a second press changes no row (idempotent by state).
      const result = await client.query(
        `INSERT INTO dropship.dropship_vendor_category_notice_marks AS m
           (vendor_id, category_id, seen_through_arrival_id, notified_through_arrival_id, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vendor_id, category_id) DO UPDATE
           SET seen_through_arrival_id = GREATEST(m.seen_through_arrival_id, EXCLUDED.seen_through_arrival_id),
               notified_through_arrival_id = GREATEST(m.notified_through_arrival_id, EXCLUDED.notified_through_arrival_id),
               updated_at = EXCLUDED.updated_at
           WHERE m.seen_through_arrival_id < EXCLUDED.seen_through_arrival_id
              OR m.notified_through_arrival_id < EXCLUDED.notified_through_arrival_id`,
        [input.vendorId, input.categoryId, input.seenThroughArrivalId, input.notifiedThroughArrivalId, input.now]);
      return (result.rowCount ?? 0) > 0;
    },
    async insertAudit(input) {
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
           (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, 'dropship_vendor_category_notice_marks', $2, 'catalog_new_items_acknowledged', $3, $4, 'info', $5::jsonb, $6)`,
        [input.vendorId, String(input.categoryId), input.actor.actorType, input.actor.actorId, JSON.stringify(input.payload), input.now]);
    },
  };
}

function mapMark(row: MarkRow): CatalogNoticeMark {
  return {
    categoryId: requiredId(row.category_id, "category"),
    seenThroughArrivalId: arrivalId(row.seen_through_arrival_id),
    notifiedThroughArrivalId: arrivalId(row.notified_through_arrival_id),
  };
}

function mapArrivalFact(row: ArrivalFactRow): CatalogArrivalFact {
  return {
    arrivalId: arrivalId(row.arrival_id),
    productVariantId: requiredId(row.product_variant_id, "size"),
    productId: requiredId(row.product_id, "product"),
    categoryId: requiredId(row.category_id, "category"),
    baseline: row.baseline === true,
    picked: row.picked === true,
    turnedOff: row.turned_off === true,
  };
}

/** A bigint arrival id (or watermark) as a safe whole number; anything else breaks the ledger's contract (fatal). */
function arrivalId(value: unknown): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw invariantFailed("An arrival id read from the ledger is not a safe whole number.", { value: String(value) });
  }
  return parsed;
}

function requiredId(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw invariantFailed(`A ${what} id read by the arrivals job failed its contract.`, { value: String(value) });
  }
  return value;
}

/** The work's own failure is what the caller rethrows; a failed rollback is returned so the connection is destroyed. */
async function rollbackQuietly(client: Queryable): Promise<Error | undefined> {
  try {
    await client.query("ROLLBACK");
    return undefined;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
