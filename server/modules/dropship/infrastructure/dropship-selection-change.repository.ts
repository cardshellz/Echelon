import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { pool as defaultPool } from "../../../db";
import { countSelectedVariants, offeredVariantIdsAmong } from "../application/dropship-selected-catalog";
import { selectedCountBeforeChange } from "../domain/vendor-selection-change";
import type {
  DropshipSelectionChangeReads,
  DropshipSelectionChangeRepository,
  DropshipSelectionChangeTransaction,
  SelectionChangePlanFacts,
  StoredSelectionChangeRevision,
  WrittenListingEnd,
} from "../application/dropship-selection-change-service";
import { LISTING_END_REASONS, LISTING_END_SUPERSEDED_BY_SELECTION, type PendingListingEnd } from "../domain/vendor-selection-ends";
import { readHeadSelectionRevisionId } from "./dropship-listing-push-run.repository";
import { catalogVersionAtLeastSettled, hasLiveOlderCatalogProcess } from "./dropship-process-heartbeat.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";
import { readDropshipSelectionEffectsFacts } from "./dropship-selection-effects.reader";
import { lockVendorSelection } from "./dropship-vendor-selection-lock";

/**
 * Step 1's picks save in PostgreSQL (PLAN-B v4.1 §8.2, §8.3). The service
 * decides; this module runs its statements in one transaction and reads the
 * facts a plan needs. Every statement is parameterized.
 *
 * The save's transaction begins with a short lock timeout and the vendor's
 * selection lock (the lock the run create and the frozen rules save take),
 * so two saves of one vendor never interleave and a run create never
 * snapshots half a save. The picks table carries 0743's statement gate
 * (`PICKS_SELECTION_TRIGGERS_SQL`): the first picks write takes the global
 * publication selection lock until COMMIT, or raises 55P03
 * PUBLICATION_SELECTION_BUSY while a stock publication holds it.
 */

/**
 * How long one statement of a save waits for a lock (the vendor lock, a size's
 * row) before it fails with 55P03 and the service tries the save again. Short,
 * so a busy save gives its pooled connection back quickly.
 */
export const SELECTION_CHANGE_LOCK_TIMEOUT = "2s";

type Queryable = Pick<PoolClient, "query">;

export class PgDropshipSelectionChangeRepository implements DropshipSelectionChangeRepository {
  constructor(private readonly dbPool: Pick<Pool, "connect"> = defaultPool) {}

  async runPreview<T>(work: (reads: DropshipSelectionChangeReads) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      // One snapshot for the head revision and every fact (V38); read only, so the preview can write nothing.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await work(selectionChangeReads(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async runChange<T>(input: { vendorId: number }, work: (tx: DropshipSelectionChangeTransaction) => Promise<T>): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SET LOCAL lock_timeout = '${SELECTION_CHANGE_LOCK_TIMEOUT}'`);
      // §8.3 step 1: the same lock as the run create (dropship-listing-push-run.repository.ts), until COMMIT.
      await lockVendorSelection(client, input.vendorId);
      const result = await work(selectionChangeTransaction(client));
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      // Unchanged: the service classifies it (a retryable SQLSTATE, a refusal, or a fault).
      throw error;
    } finally {
      client.release();
    }
  }
}

function selectionChangeReads(client: Queryable): DropshipSelectionChangeReads {
  return {
    readHeadRevisionId: ({ vendorId }) => readHeadSelectionRevisionId(client, vendorId),
    readPlanFacts: (input) => readSelectionChangePlanFacts(client, input),
  };
}

function selectionChangeTransaction(client: Queryable): DropshipSelectionChangeTransaction {
  return {
    ...selectionChangeReads(client),

    async findRevisionByKey({ vendorId, idempotencyKey }): Promise<StoredSelectionChangeRevision | null> {
      const found = await client.query<{ id: number; request_hash: string; request_kind: string; result: unknown }>(
        `SELECT id, request_hash, request_kind, result
         FROM dropship.dropship_vendor_selection_rule_set_revisions
         WHERE vendor_id = $1 AND idempotency_key = $2`,
        [vendorId, idempotencyKey]);
      const row = found.rows[0];
      return row ? { revisionId: row.id, requestHash: row.request_hash, requestKind: row.request_kind, result: row.result ?? null } : null;
    },

    async readWritesGate({ version, graceMs, settleMs }) {
      const olderVersionLive = await hasLiveOlderCatalogProcess(client, { belowVersion: version, graceMs });
      // This version or any later one (every later version writes picks too): a database that never ran version 2
      // settles on version 3's row (review SAV-1).
      const versionSettled = await catalogVersionAtLeastSettled(client, { minVersion: version, settleMs });
      return { olderVersionLive, versionSettled };
    },

    async insertRevision(input): Promise<number> {
      const inserted = await client.query<{ id: number }>(
        `INSERT INTO dropship.dropship_vendor_selection_rule_set_revisions
           (vendor_id, idempotency_key, request_hash, actor_type, actor_id, rule_count, request_kind, pick_count, result, created_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'picks_change', $6, $7::jsonb, $8)
         RETURNING id`,
        [input.vendorId, input.idempotencyKey, input.requestHash, input.actor.actorType, input.actor.actorId,
          input.pickCount, JSON.stringify(input.result), input.now]);
      const revisionId = inserted.rows[0]?.id;
      if (!revisionId) throw new Error("Dropship picks change revision insert did not return an id.");
      return revisionId;
    },

    async insertAudit(input): Promise<void> {
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
           (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, 'dropship_vendor_selection_ruleset', $2, 'vendor_selection_picks_changed', $3, $4, 'info', $5::jsonb, $6)`,
        [input.vendorId, String(input.revisionId), input.actor.actorType, input.actor.actorId,
          JSON.stringify(input.payload), input.now]);
    },

    async preLockVariants({ productVariantIds }): Promise<number[]> {
      // Ascending, so two saves lock shared sizes in one order; FOR KEY SHARE is what the picks' foreign key takes.
      const locked = await client.query<{ id: number }>(
        `SELECT id FROM catalog.product_variants WHERE id = ANY($1::integer[]) ORDER BY id FOR KEY SHARE`,
        [[...productVariantIds]]);
      return locked.rows.map((row) => row.id);
    },

    async deletePicks({ vendorId, productVariantIds }): Promise<number> {
      const deleted = await client.query(
        `DELETE FROM dropship.dropship_vendor_selected_variants
         WHERE vendor_id = $1 AND product_variant_id = ANY($2::integer[])`,
        [vendorId, [...productVariantIds]]);
      return deleted.rowCount ?? 0;
    },

    async insertPicks({ vendorId, revisionId, productVariantIds, now }): Promise<number> {
      const inserted = await client.query(
        `INSERT INTO dropship.dropship_vendor_selected_variants
           (vendor_id, product_variant_id, revision_id, source, selected_at)
         SELECT $1, chosen.id, $2, 'vendor', $4
         FROM unnest($3::integer[]) AS chosen(id)
         ON CONFLICT (vendor_id, product_variant_id) DO NOTHING`,
        [vendorId, revisionId, [...productVariantIds], now]);
      return inserted.rowCount ?? 0;
    },

    async supersedeListingEnds({ vendorId, endIds, now }): Promise<WrittenListingEnd[]> {
      // Guarded by the state: only a `pending` end is taken back (§4.4 rule 6); the claim and staff routes take the
      // vendor lock this save holds, and the remote work changes only `ending` rows, so nothing here can be waited on.
      const updated = await client.query(
        `UPDATE dropship.dropship_listing_end_requests
         SET state = 'superseded', code = $3, next_attempt_at = NULL, decided_at = $4, updated_at = $4, version = version + 1
         WHERE vendor_id = $1 AND id = ANY($2::bigint[]) AND state = 'pending'
         RETURNING ${WRITTEN_END_COLUMNS}`,
        [vendorId, endIds.map(String), LISTING_END_SUPERSEDED_BY_SELECTION, now]);
      return z.array(writtenEndSchema).parse(updated.rows);
    },

    async insertListingEnds({ vendorId, revisionId, ends, now }): Promise<WrittenListingEnd[]> {
      // The insert's foreign key takes each listing FOR KEY SHARE. The save already holds the products' publication
      // work rows (the picks writes re-planned them), and a sync adoption takes a listing FOR UPDATE before its own
      // re-plan of that product, so waiting here could close a lock cycle (review DB-1). The keys are taken first, in
      // listing order and without waiting: a held listing rolls the attempt back (55P03) and the service retries it,
      // so the adoption is never the one PostgreSQL rolls back.
      const listingIds = [...new Set(ends.map((end) => end.listingId))].sort((left, right) => left - right);
      if (listingIds.length > 0) {
        await client.query(`SELECT id FROM dropship.dropship_vendor_listings WHERE id = ANY($1::integer[]) ORDER BY id FOR KEY SHARE NOWAIT`,
          [listingIds]);
      }
      // One statement for every end (the consistency trigger proves them together); listing order, so two saves
      // could only ever lock listing keys in one order. A listing with an open end is left out by the one-open
      // index, and the service compares the count with its plan.
      const rows = ends.map((end) => ({
        store_connection_id: end.storeConnectionId, listing_id: end.listingId, product_id: end.productId,
        product_variant_id: end.productVariantId, reason: end.reason, requested_identity: end.requestedIdentity,
      }));
      const inserted = await client.query(
        `INSERT INTO dropship.dropship_listing_end_requests
           (vendor_id, store_connection_id, listing_id, product_id, product_variant_id, selection_revision_id, reason, state,
            requested_identity, next_attempt_at, created_at, updated_at)
         SELECT $1, e.store_connection_id, e.listing_id, e.product_id, e.product_variant_id, $2, e.reason, 'pending',
           e.requested_identity, $3, $3, $3
         FROM jsonb_to_recordset($4::jsonb) AS e(store_connection_id integer, listing_id integer, product_id integer,
           product_variant_id integer, reason varchar(30), requested_identity jsonb)
         ORDER BY e.listing_id
         ON CONFLICT (listing_id) WHERE state IN ('pending', 'ending', 'failed') DO NOTHING
         RETURNING ${WRITTEN_END_COLUMNS}`,
        [vendorId, revisionId, now, JSON.stringify(rows)]);
      return z.array(writtenEndSchema).parse(inserted.rows);
    },

    async insertListingEndAudits({ vendorId, actor, now, rows }): Promise<void> {
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
           (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         SELECT $1, a.store_connection_id, a.entity_type, a.entity_id, a.event_type, $2, $3, 'info', a.payload, $4
         FROM jsonb_to_recordset($5::jsonb) AS a(store_connection_id integer, entity_type varchar(80), entity_id varchar(255),
           event_type varchar(120), payload jsonb)`,
        [vendorId, actor.actorType, actor.actorId, now, JSON.stringify(rows.map((row) => ({
          store_connection_id: row.storeConnectionId, entity_type: row.entityType, entity_id: row.entityId,
          event_type: row.eventType, payload: row.payload,
        })))]);
    },
  };
}

const rowId = z.number().int().positive().max(2_147_483_647);
/** A bigint end request id as node-postgres returns it (text), read as a safe integer. */
const endRequestId = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number)
  .refine(Number.isSafeInteger, { message: "End request ids must be safe integers." });
const WRITTEN_END_COLUMNS = `id::text AS id, store_connection_id AS "storeConnectionId", listing_id AS "listingId",
  product_variant_id AS "productVariantId", reason`;
const writtenEndSchema = z.object({
  id: endRequestId, storeConnectionId: rowId, listingId: rowId, productVariantId: rowId, reason: z.enum(LISTING_END_REASONS),
});
const pendingEndSchema = z.object({
  id: endRequestId, listingId: rowId, productId: rowId, productVariantId: rowId, reason: z.enum(LISTING_END_REASONS),
});

/**
 * The vendor's `pending` ends of these products (§4.2 item 5; `dropship_end_vendor_product_open_idx`): the ends a
 * save that adds a size of one of them may take back. Under the vendor lock no `pending` row is created, claimed or
 * retried by anyone else, so this read stays true until the save commits.
 */
async function readPendingListingEnds(client: Queryable, vendorId: number, productIds: readonly number[]): Promise<PendingListingEnd[]> {
  if (productIds.length === 0) return [];
  const found = await client.query(
    `SELECT id::text AS id, listing_id AS "listingId", product_id AS "productId", product_variant_id AS "productVariantId", reason
     FROM dropship.dropship_listing_end_requests
     WHERE vendor_id = $1 AND product_id = ANY($2::integer[]) AND state = 'pending'
     ORDER BY id`,
    [vendorId, [...productIds]]);
  return z.array(pendingEndSchema).parse(found.rows);
}

/**
 * The facts a change is planned from, in the caller's transaction: the
 * touched sizes' stock facts on every store of the vendor (the effects
 * reader, SPR's own reads), which of them Card Shellz offers now, the
 * selected count over the vendor's whole selection (the keyset over its
 * picks, the count steps 2 and 3 cap on) and the vendor's pick rows. One
 * statement at a time: a transaction's client runs one query at a time.
 * The save runs at READ COMMITTED, so each statement has its own snapshot:
 * the selected count and the pick count take the touched sizes from the
 * plan's own reads and only the rest from their own statements
 * (selectedCountBeforeChange; SRV-1).
 *
 * PR C (PLAN-C v4.1 §4.2): the effects facts widen to every size of the
 * removed sizes' products (with the vendor's picks among them,
 * `siblingPicks`, which the untouched pick count already holds), and the
 * `pending` ends of the added sizes' products are read for the supersede.
 */
async function readSelectionChangePlanFacts(client: Queryable, input: {
  vendorId: number; touchedIds: readonly number[]; removedIds: readonly number[]; addedIds: readonly number[]; now: Date;
}): Promise<SelectionChangePlanFacts> {
  const effects = await readDropshipSelectionEffectsFacts(client, {
    vendorId: input.vendorId, productVariantIds: input.touchedIds, removedIds: input.removedIds,
  });
  const reader = selectedCatalogReaderForTransaction(client, input.vendorId);
  const offered = await offeredVariantIdsAmong(reader, input.touchedIds, input.now);
  const counts = await countSelectedVariants(reader, input.now, new Set(input.touchedIds));
  const selectedBefore = selectedCountBeforeChange({
    selected: counts.selected, selectedAmongTouched: counts.selectedAmong, touchedIds: input.touchedIds,
    pickedBefore: effects.pickedBefore, offered,
  });
  // The pick rows outside the change; the touched ones are `pickedBefore`'s (the same split as the selected count), so
  // a cascade delete between the reads never makes the revision's pick count disagree with the planned deletes. One
  // statement (one snapshot); the touched rows are counted by the primary key, not by testing every pick.
  const pickRows = await client.query<{ untouched_pick_count: number }>(
    `SELECT ((SELECT count(*) FROM dropship.dropship_vendor_selected_variants WHERE vendor_id = $1)
       - (SELECT count(*) FROM dropship.dropship_vendor_selected_variants
          WHERE vendor_id = $1 AND product_variant_id = ANY($2::integer[])))::integer AS untouched_pick_count`,
    [input.vendorId, [...input.touchedIds]]);
  const untouchedPickCount = pickRows.rows[0]?.untouched_pick_count;
  if (typeof untouchedPickCount !== "number") throw new Error("Dropship pick count read returned no row.");
  const pickCountBefore = untouchedPickCount + effects.pickedBefore.size;
  const added = new Set(input.addedIds);
  const addedProductIds = [...new Set(effects.candidates.filter((candidate) => added.has(candidate.productVariantId))
    .map((candidate) => candidate.productId))].sort((left, right) => left - right);
  const pendingEnds = await readPendingListingEnds(client, input.vendorId, addedProductIds);
  return {
    pickedBefore: effects.pickedBefore,
    offered,
    selectedBefore,
    pickCountBefore,
    siblingPicks: effects.siblingPicks,
    pendingEnds,
    effects: { candidates: effects.candidates, adminRules: effects.adminRules, overrides: effects.overrides, stores: effects.stores },
  };
}

async function rollbackQuietly(client: Queryable): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Deliberate: the original failure is the one rethrown; a broken connection's ROLLBACK error says nothing more.
  }
}
