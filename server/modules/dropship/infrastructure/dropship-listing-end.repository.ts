import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import {
  readCatalogStockProductVariantIds,
  readCatalogStockSelectionFactsForVariants,
} from "../../catalog/catalog-stock-selection.reader";
import {
  isArchivedCatalogMember,
  readProviderAccountDestinations,
  tryLockListingMemberRemote,
} from "../../marketplace-listings/listing-member-lifecycle";
import type {
  DropshipListingEndRepository,
  ListingEndClaimResult,
  ListingEndDueEntry,
  ListingEndFinishResult,
  ListingEndRow,
  ListingEndTickFacts,
} from "../application/dropship-listing-end-service";
import { OLDER_PROCESS_GRACE_MS, NEW_VERSION_SETTLE_MS } from "../domain/catalog-code-version";
import {
  decideListingEndClaim,
  LISTING_END_CAP_WINDOW_MS,
  LISTING_END_DUE_BATCH,
  LISTING_END_DUE_PER_STORE,
  LISTING_END_GLOBAL_BREAKER_WINDOW_MS,
  listingEndRequestedIdentitySchema,
  type ListingEndClaimDecision,
  type ListingEndClaimFacts,
  type ListingEndResolvedIdentity,
  type ListingEndStoreFacts,
} from "../domain/listing-end-claims";
import {
  deferralDueAt,
  LISTING_END_CODES,
  LISTING_END_MESSAGES,
  type ListingEndCode,
  type ListingEndDeferralCode,
} from "../domain/listing-end-errors";
import { hasUnsettledPushAttempt, storedIntentSku } from "../domain/marketplace-sync-history";
import { isVisibleInStep1, LISTING_END_REASONS } from "../domain/vendor-selection-ends";
import { catalogVersionSettled, hasLiveOlderCatalogProcess } from "./dropship-process-heartbeat.repository";
import {
  readMarketplaceSyncEventsWithClient,
  readNewestCompletedListingIntentWithClient,
} from "./dropship-marketplace-listing-sync-state.repository";
import {
  dropshipStockSelectionCandidate,
  readDropshipStockExposureRules,
  readDropshipStockPickedVariantIds,
} from "./dropship-stock-publication-selection.reader";
import { lockVendorSelection } from "./dropship-vendor-selection-lock";
import { DROPSHIP_CATALOG_CODE_VERSION } from "../domain/catalog-code-version";

/**
 * The listing end worker's SQL (PR C, PLAN-C v4.1 §5.3-§5.5): the tick's reads, the claim, the worker's short side
 * writes and the finish. Every write is one short transaction guarded by the row's id, state and version, with
 * `lock_timeout` 2 s and `statement_timeout` 10 s, and writes its `dropship.dropship_audit_events` row (before →
 * after) in the same transaction (CLAUDE.md §8, §10). The version moves only with a state change (§3), so the
 * worker's side writes (withdraw fields, deferrals, retries) never break its own guard (SAF-11 d). No row lock is
 * ever held across an eBay call: the remote work holds only the shared remote-member advisory lock, on a pinned
 * transaction of its own (withRemoteMemberLock). Business rules are the domain's (decideListingEndClaim).
 */

const AUDIT_ENTITY = "dropship_listing_end_request";
const AUDIT_ACTOR_TYPE = "system";
const AUDIT_ACTOR_ID = "dropship-listing-end-worker";
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";
const STATEMENT_TIMEOUT_SQL = "SET LOCAL statement_timeout = '10s'";
/** A lock wait past the timeout, or a deadlock: the row waits LOCK_BUSY (§5.4, SAF-10 c). */
const LOCK_BUSY_SQLSTATES: ReadonlySet<string> = new Set(["55P03", "40P01"]);

const rowId = z.number().int().positive().max(2_147_483_647);
const bigintId = z.string().regex(/^[1-9][0-9]{0,15}$/).transform(Number).refine(Number.isSafeInteger);
const count = z.number().int().nonnegative();
const jsonObject = z.record(z.unknown());

const REQUEST_COLUMNS = `r.id::text AS id, r.vendor_id AS "vendorId", r.store_connection_id AS "storeConnectionId",
  r.listing_id AS "listingId", r.product_id AS "productId", r.product_variant_id AS "productVariantId", r.reason, r.state,
  r.version, r.code, r.context, r.requested_identity AS "requestedIdentity", r.resolved_identity AS "resolvedIdentity",
  r.attempt_count AS "attemptCount", r.deferral_count AS "deferralCount", r.withdraw_call_count AS "withdrawCallCount",
  r.withdraw_requested_at AS "withdrawRequestedAt", r.withdraw_returned_at AS "withdrawReturnedAt",
  r.withdraw_outcome AS "withdrawOutcome", r.created_at AS "createdAt"`;

const requestRowSchema = z.object({
  id: bigintId, vendorId: rowId, storeConnectionId: rowId, listingId: rowId, productId: rowId, productVariantId: rowId,
  reason: z.enum(LISTING_END_REASONS), state: z.enum(["pending", "ending"]), version: z.number().int().positive(),
  code: z.string().nullable(), context: jsonObject, requestedIdentity: listingEndRequestedIdentitySchema,
  resolvedIdentity: z.unknown(), attemptCount: count, deferralCount: count, withdrawCallCount: count,
  withdrawRequestedAt: z.date().nullable(), withdrawReturnedAt: z.date().nullable(), withdrawOutcome: z.string().nullable(),
  createdAt: z.date(),
}).strict();

function parseRequestRow(raw: unknown): ListingEndRow {
  return requestRowSchema.parse(raw) as ListingEndRow;
}

/** A due row that does not parse becomes poison with whatever ids are readable (SAF-11 c). */
function dueEntry(raw: Record<string, unknown>): ListingEndDueEntry {
  const parsed = requestRowSchema.safeParse(raw);
  if (parsed.success) return { kind: "row", row: parsed.data as ListingEndRow };
  const id = bigintId.safeParse(raw.id);
  const state = z.enum(["pending", "ending"]).safeParse(raw.state);
  if (!id.success || !state.success) throw new Error("A due end request has no readable id or state.");
  const vendorId = rowId.safeParse(raw.vendorId);
  const storeConnectionId = rowId.safeParse(raw.storeConnectionId);
  return { kind: "poison", id: id.data, state: state.data, vendorId: vendorId.success ? vendorId.data : null,
    storeConnectionId: storeConnectionId.success ? storeConnectionId.data : null,
    error: parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ").slice(0, 500) };
}

const storeFactsSchema = z.object({
  storeConnectionId: rowId,
  storeName: z.string().nullable(),
  decidedStates: z.array(z.enum(["ended", "failed"])),
  decidedAts: z.array(z.date()),
  hasVerifiedEnd: z.boolean(),
  endingCount: count,
  callsInWindow: count,
  oldestCallInWindowAt: z.date().nullable(),
});
const globalFactsSchema = z.object({
  failuresInWindow: count, failuresInTwoWindows: count, newestFailureAt: z.date().nullable(),
  verifiedEndSinceNewestFailure: z.boolean(), callsInWindow: count, oldestCallInWindowAt: z.date().nullable(),
});

/**
 * A row whose newest call started in the window and reached eBay (§5.3 caps): not refused by the admission
 * (`admission_*`) nor failed on the offer read before the send (`unsent_*`, review WRK-4). $2 is the window's start.
 */
function callInWindow(alias: string): string {
  return `${alias}.withdraw_requested_at > $2 AND (${alias}.withdraw_outcome IS NULL
    OR (${alias}.withdraw_outcome NOT LIKE 'admission\\_%' AND ${alias}.withdraw_outcome NOT LIKE 'unsent\\_%'))`;
}
/** A verified end (§5.3 canary): withdrawn by this worker and read back unpublished; NOT_PUBLISHED and staff ends have a code. */
function verifiedEnd(alias: string): string {
  return `${alias}.state = 'ended' AND ${alias}.withdraw_outcome = 'ok' AND ${alias}.code IS NULL`;
}

export class PgDropshipListingEndRepository implements DropshipListingEndRepository {
  constructor(private readonly pool: Pick<Pool, "connect" | "query">) {}

  async hasLiveOlderCatalogProcess(): Promise<boolean> {
    return hasLiveOlderCatalogProcess(this.pool, { belowVersion: DROPSHIP_CATALOG_CODE_VERSION, graceMs: OLDER_PROCESS_GRACE_MS });
  }

  async catalogVersionSettled(): Promise<boolean> {
    return catalogVersionSettled(this.pool, { version: DROPSHIP_CATALOG_CODE_VERSION, settleMs: NEW_VERSION_SETTLE_MS });
  }

  /**
   * The tick's reads (§5.3), each a plain statement: the due rows (at most LISTING_END_DUE_PER_STORE per store, so one
   * store's long queue never hides another's, D-C4-2), their stores' breaker, canary and cap facts, and the global ones.
   * `ending` rows rank ahead of `pending` ones, per store and in all: a pending row a half-open store or canary skips is
   * never written, so it keeps its due time, and older pending rows would otherwise push a deferred `ending` row out of
   * the read for good, and with it every other end of its store (review WRK-1).
   */
  async readTickFacts(now: Date): Promise<ListingEndTickFacts> {
    const due = (await this.pool.query<Record<string, unknown>>(`SELECT ${REQUEST_COLUMNS}
      FROM (SELECT d.*, row_number() OVER (PARTITION BY d.store_connection_id
                ORDER BY (d.state = 'ending') DESC, d.next_attempt_at, d.id) AS store_rank
            FROM dropship.dropship_listing_end_requests d
            WHERE d.state IN ('pending', 'ending') AND d.next_attempt_at <= $1) r
      WHERE r.store_rank <= $2
      ORDER BY (r.state = 'ending') DESC, r.next_attempt_at, r.id
      LIMIT $3`, [now, LISTING_END_DUE_PER_STORE, LISTING_END_DUE_BATCH])).rows.map(dueEntry);
    const storeIds = [...new Set(due.map((entry) => entry.kind === "row" ? entry.row.storeConnectionId : entry.storeConnectionId)
      .filter((id): id is number => id !== null))].sort((left, right) => left - right);
    const windowStart = new Date(now.getTime() - LISTING_END_CAP_WINDOW_MS);
    // The breaker's newest decided rows are failures and verified ends only: an end that withdrew nothing or that staff
    // marked ended neither trips nor closes it (§5.3 "until a verified end"; review WRK-6).
    const stores = storeIds.length === 0 ? [] : z.array(storeFactsSchema).parse((await this.pool.query(`SELECT s.id AS "storeConnectionId",
        NULLIF(btrim(s.external_display_name), '') AS "storeName",
        ARRAY(SELECT d.state FROM dropship.dropship_listing_end_requests d WHERE d.store_connection_id = s.id
          AND d.state IN ('ended', 'failed') AND (d.state = 'failed' OR (${verifiedEnd("d")}))
          ORDER BY d.decided_at DESC, d.id DESC LIMIT 3)::text[] AS "decidedStates",
        ARRAY(SELECT d.decided_at FROM dropship.dropship_listing_end_requests d WHERE d.store_connection_id = s.id
          AND d.state IN ('ended', 'failed') AND (d.state = 'failed' OR (${verifiedEnd("d")}))
          ORDER BY d.decided_at DESC, d.id DESC LIMIT 3) AS "decidedAts",
        EXISTS (SELECT 1 FROM dropship.dropship_listing_end_requests d WHERE d.store_connection_id = s.id AND ${verifiedEnd("d")}) AS "hasVerifiedEnd",
        (SELECT count(*)::int FROM dropship.dropship_listing_end_requests d WHERE d.store_connection_id = s.id AND d.state = 'ending') AS "endingCount",
        (SELECT count(*)::int FROM dropship.dropship_listing_end_requests d WHERE d.store_connection_id = s.id AND ${callInWindow("d")}) AS "callsInWindow",
        (SELECT min(d.withdraw_requested_at) FROM dropship.dropship_listing_end_requests d WHERE d.store_connection_id = s.id
          AND ${callInWindow("d")}) AS "oldestCallInWindowAt"
      FROM dropship.dropship_store_connections s WHERE s.id = ANY($1::integer[]) ORDER BY s.id`, [storeIds, windowStart])).rows);
    const global = globalFactsSchema.parse((await this.pool.query(`WITH newest AS (
        SELECT max(decided_at) AS at FROM dropship.dropship_listing_end_requests WHERE state = 'failed' AND decided_at > $3)
      SELECT
        (SELECT count(*)::int FROM dropship.dropship_listing_end_requests WHERE state = 'failed' AND decided_at > $1) AS "failuresInWindow",
        (SELECT count(*)::int FROM dropship.dropship_listing_end_requests WHERE state = 'failed' AND decided_at > $3) AS "failuresInTwoWindows",
        (SELECT at FROM newest) AS "newestFailureAt",
        EXISTS (SELECT 1 FROM dropship.dropship_listing_end_requests v, newest WHERE ${verifiedEnd("v")} AND v.decided_at > newest.at)
          AS "verifiedEndSinceNewestFailure",
        (SELECT count(*)::int FROM dropship.dropship_listing_end_requests c WHERE ${callInWindow("c")}) AS "callsInWindow",
        (SELECT min(c.withdraw_requested_at) FROM dropship.dropship_listing_end_requests c WHERE ${callInWindow("c")}) AS "oldestCallInWindowAt"`,
    [new Date(now.getTime() - LISTING_END_GLOBAL_BREAKER_WINDOW_MS), windowStart,
      new Date(now.getTime() - 2 * LISTING_END_GLOBAL_BREAKER_WINDOW_MS)])).rows[0]);
    return {
      due,
      stores: stores.map((store): ListingEndStoreFacts => ({
        storeConnectionId: store.storeConnectionId,
        newestDecided: store.decidedStates.map((state, index) => ({ state, decidedAt: store.decidedAts[index]! })),
        hasVerifiedEnd: store.hasVerifiedEnd, endingCount: store.endingCount, callsInWindow: store.callsInWindow,
        oldestCallInWindowAt: store.oldestCallInWindowAt,
      })),
      storeNames: new Map(stores.map((store) => [store.storeConnectionId, store.storeName])),
      global,
    };
  }

  /**
   * The claim (§5.4): one short transaction. The vendor's selection lock (the save's key: claim and save serialize),
   * the request `FOR UPDATE` at its version, check (a) with plain reads, then the listing `FOR UPDATE` (job → item →
   * listing writers already hold their listing lock before reading ends, §6.2) and a plain read of the store (no
   * row lock: sync adoption takes the store's advisory lock → picks SHARE → listing FOR UPDATE, SAF-10 a). A lock
   * wait past 2 s rolls back and answers `lock_busy`; the service defers the row in its own transaction.
   */
  async claim(input: { row: ListingEndRow; now: Date }): Promise<ListingEndClaimResult> {
    const { row, now } = input;
    try {
      return await this.transaction(async (client): Promise<ListingEndClaimResult> => {
        await lockVendorSelection(client, row.vendorId);
        const locked = (await client.query<Record<string, unknown>>(`SELECT ${REQUEST_COLUMNS}
          FROM dropship.dropship_listing_end_requests r WHERE r.id = $1 AND r.state = 'pending' AND r.version = $2 FOR UPDATE`,
        [row.id, row.version])).rows[0];
        if (!locked) return { kind: "moved" };
        const current = parseRequestRow(locked);
        const facts = await this.readClaimFacts(client, current, now);
        const decision = decideListingEndClaim(facts);
        const after = await this.writeClaimDecision(client, current, decision, now);
        if (after === null) return { kind: "moved" };
        return { kind: "decided", decision, row: decision.outcome === "ending" ? after : null };
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (sqlState !== null && LOCK_BUSY_SQLSTATES.has(sqlState)) return { kind: "lock_busy", causeCode: sqlState };
      throw error;
    }
  }

  private async readClaimFacts(client: PoolClient, row: ListingEndRow, now: Date): Promise<ListingEndClaimFacts> {
    // (a) before the listing lock: an archived size never waits on retirement's locks (SAF-10 b).
    const catalog = await readCatalogStockSelectionFactsForVariants(client, [row.productVariantId]);
    const member = catalog[0];
    if (member && isArchivedCatalogMember({ productActive: member.product.isActive, variantActive: member.variant.isActive,
      productStatus: member.product.status })) {
      return { archived: true };
    }
    const listing = z.object({
      status: z.string(), marketplaceEndedAt: z.date().nullable(), externalOfferId: z.string().nullable(),
      externalListingId: z.string().nullable(), marketplaceIssueCodes: z.array(z.string()),
    }).parse((await client.query(`SELECT status, marketplace_ended_at AS "marketplaceEndedAt", external_offer_id AS "externalOfferId",
        external_listing_id AS "externalListingId", COALESCE(marketplace_issue_codes, '{}'::text[]) AS "marketplaceIssueCodes"
      FROM dropship.dropship_vendor_listings WHERE id = $1 AND vendor_id = $2 AND store_connection_id = $3 AND product_variant_id = $4
      FOR UPDATE`, [row.listingId, row.vendorId, row.storeConnectionId, row.productVariantId])).rows[0]);
    const store = z.object({
      platform: z.string(), status: z.string(), externalAccountId: z.string().nullable(),
      externalAccountVerifiedAt: z.date().nullable(), providerEnvironment: z.string().nullable(),
    }).parse((await client.query(`SELECT lower(platform) AS platform, status, external_account_id AS "externalAccountId",
        external_account_verified_at AS "externalAccountVerifiedAt", provider_environment AS "providerEnvironment"
      FROM dropship.dropship_store_connections WHERE id = $1 AND vendor_id = $2`, [row.storeConnectionId, row.vendorId])).rows[0]);
    const rePicked = await this.readRePicked(client, row, now);
    const items = z.object({ processing: z.boolean(), staleRecovered: z.boolean() }).parse((await client.query(`SELECT
        EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items fi
          INNER JOIN dropship.dropship_listing_push_jobs fj ON fj.id = fi.job_id
          WHERE fj.vendor_id = $1 AND fj.store_connection_id = $2 AND fi.product_variant_id = $3 AND fi.listing_id = $4
            AND fi.status = 'processing') AS processing,
        EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items fi
          INNER JOIN dropship.dropship_listing_push_jobs fj ON fj.id = fi.job_id
          WHERE fj.vendor_id = $1 AND fj.store_connection_id = $2 AND fi.product_variant_id = $3 AND fi.listing_id = $4
            AND fi.status = 'queued' AND fi.result ? 'staleRecovery') AS "staleRecovered"`,
    [row.vendorId, row.storeConnectionId, row.productVariantId, row.listingId])).rows[0]);
    const hasIds = isPresent(listing.externalOfferId) || isPresent(listing.externalListingId);
    // Read only when the listing has no ids (§5.4 e): a send may have reached eBay unrecorded (SAF-7).
    const unsettledPushAttempt = hasIds ? false : hasUnsettledPushAttempt(await readMarketplaceSyncEventsWithClient(client, row.listingId));
    const intent = intentFacts(await readNewestCompletedListingIntentWithClient(client, row.listingId));
    const accountId = isPresent(store.externalAccountId) ? store.externalAccountId!.trim() : null;
    const environment = store.providerEnvironment ?? "production";
    const offerId = isPresent(listing.externalOfferId) ? listing.externalOfferId!.trim() : null;
    // Read only when the offer, SKU and account are known (§5.4 j; SAF-4).
    const sharedWith = offerId !== null && intent.sku !== null && accountId !== null
      && (environment === "production" || environment === "sandbox")
      ? await this.readSharedWithClient(client, { listingId: row.listingId, accountId, environment, offerId,
        listingExternalId: isPresent(listing.externalListingId) ? listing.externalListingId!.trim() : null, sku: intent.sku })
      : null;
    return {
      archived: false, reason: row.reason,
      ids: { vendorId: row.vendorId, storeConnectionId: row.storeConnectionId, productId: row.productId, productVariantId: row.productVariantId },
      rePicked, listing, pushProcessing: items.processing, unsettledPushAttempt, staleRecoveredItem: hasIds ? false : items.staleRecovered,
      store, intent, requested: row.requestedIdentity, sharedWith,
    };
  }

  /**
   * (b) The vendor chose it again (§5.4 b), under the vendor lock every picks writer takes: a removed size is
   * picked again; a wholly removed product has a visible pick again (§4.3, the save's own rule).
   */
  private async readRePicked(client: PoolClient, row: ListingEndRow, now: Date): Promise<boolean> {
    if (row.reason === "size_removed") {
      return (await readDropshipStockPickedVariantIds(client, row.vendorId, [row.productVariantId])).has(row.productVariantId);
    }
    const sizes = await readCatalogStockProductVariantIds(client, row.productId);
    const picked = [...await readDropshipStockPickedVariantIds(client, row.vendorId, sizes)];
    if (picked.length === 0) return false;
    const rules = await readDropshipStockExposureRules(client);
    return (await readCatalogStockSelectionFactsForVariants(client, picked)).some(({ product, variant }) => {
      const candidate = dropshipStockSelectionCandidate(product, variant, variant.id);
      return candidate !== null && isVisibleInStep1(candidate, rules, now);
    });
  }

  /**
   * The claim's check (j) again, right before a withdraw (review WRK-3): the same read on the resolved identity, in a
   * short read-only transaction of its own (no row lock; the remote work holds none across eBay calls).
   */
  async readSharedWith(input: { row: ListingEndRow; identity: ListingEndResolvedIdentity }): Promise<"dropship_listing" | "card_shellz_channel" | null> {
    const { row, identity } = input;
    return this.transaction((client) => this.readSharedWithClient(client, { listingId: row.listingId, accountId: identity.accountId,
      environment: identity.environment === "sandbox" ? "sandbox" : "production", offerId: identity.externalVariantId,
      listingExternalId: identity.externalProductId, sku: identity.externalSku }));
  }

  /**
   * (j) A shared listing (SAF-4; QC2 default a): another listing row on any Dropship eBay store of the same account
   * and environment (this store included; stores without an identity scheme included) that has something on eBay
   * (§4.4) with the same offer id, the same listing id or the same push SKU (the push's rule `variant sku ?? product
   * sku`, trimmed; compared case-folded, stricter); or a Card Shellz eBay channel on the same account
   * (marketplace-listings' published readProviderAccountDestinations).
   */
  private async readSharedWithClient(client: PoolClient, input: { listingId: number; accountId: string; environment: "production" | "sandbox";
    offerId: string; listingExternalId: string | null; sku: string }): Promise<"dropship_listing" | "card_shellz_channel" | null> {
    const dropship = (await client.query<{ shared: boolean }>(`SELECT EXISTS (
        SELECT 1 FROM dropship.dropship_vendor_listings ol
        INNER JOIN dropship.dropship_store_connections os ON os.id = ol.store_connection_id AND os.vendor_id = ol.vendor_id
        LEFT JOIN catalog.product_variants opv ON opv.id = ol.product_variant_id
        LEFT JOIN catalog.products op ON op.id = opv.product_id
        WHERE ol.id <> $1 AND lower(os.platform) = 'ebay'
          AND btrim(os.external_account_id) = $2 AND COALESCE(os.provider_environment, 'production') = $3
          AND ol.status <> 'ended' AND ol.marketplace_ended_at IS NULL
          AND (NULLIF(btrim(ol.external_offer_id), '') IS NOT NULL OR NULLIF(btrim(ol.external_listing_id), '') IS NOT NULL
            OR EXISTS (SELECT 1 FROM dropship.dropship_listing_push_job_items fi
              INNER JOIN dropship.dropship_listing_push_jobs fj ON fj.id = fi.job_id
              WHERE fj.vendor_id = ol.vendor_id AND fj.store_connection_id = ol.store_connection_id
                AND fi.product_variant_id = ol.product_variant_id AND fi.listing_id = ol.id
                AND (fi.status = 'processing' OR (fi.status = 'queued' AND fi.result ? 'staleRecovery'))))
          AND (btrim(ol.external_offer_id) = $4
            OR ($5::text IS NOT NULL AND btrim(ol.external_listing_id) = $5)
            OR upper(btrim(COALESCE(opv.sku, op.sku))) = upper($6))
      ) AS shared`, [input.listingId, input.accountId, input.environment, input.offerId, input.listingExternalId, input.sku])).rows[0]?.shared;
    if (dropship === true) return "dropship_listing";
    const channels = await readProviderAccountDestinations(client, { provider: "ebay", accountId: input.accountId, environment: input.environment });
    return channels.length > 0 ? "card_shellz_channel" : null;
  }

  private async writeClaimDecision(client: PoolClient, row: ListingEndRow, decision: ListingEndClaimDecision, now: Date): Promise<ListingEndRow | null> {
    switch (decision.outcome) {
      case "deferred": {
        const ok = await this.writeDeferral(client, row, decision.code, deferralDueAt(decision.code, now), now);
        return ok ? row : null;
      }
      case "superseded":
        return this.writeTerminal(client, row, { state: "superseded", code: decision.code, context: row.context, now });
      case "failed":
        return this.writeTerminal(client, row, { state: "failed", code: decision.code,
          context: { ...row.context, ...decision.context, lastCode: decision.code, requiresReview: true }, now });
      case "ending": {
        const updated = (await client.query<Record<string, unknown>>(`UPDATE dropship.dropship_listing_end_requests r
          SET state = 'ending', resolved_identity = $3::jsonb, attempt_count = attempt_count + 1, next_attempt_at = $4,
            code = NULL, message = NULL, context = context || $5::jsonb, updated_at = $4, version = version + 1
          WHERE id = $1 AND state = 'pending' AND version = $2
          RETURNING ${REQUEST_COLUMNS}`, [row.id, row.version, JSON.stringify(decision.resolvedIdentity), now,
          JSON.stringify(decision.context)])).rows[0];
        if (!updated) return null;
        const after = parseRequestRow(updated);
        await this.audit(client, row, "listing_end_started", "info", now, { state: row.state, version: row.version },
          { state: "ending", version: after.version, resolvedIdentity: decision.resolvedIdentity, attemptCount: after.attemptCount });
        return after;
      }
    }
  }

  async defer(input: { row: ListingEndRow; code: ListingEndDeferralCode; dueAt: Date; now: Date }): Promise<boolean> {
    return this.transaction((client) => this.writeDeferral(client, input.row, input.code, input.dueAt, input.now));
  }

  /** A deferral (§5.6): state and version kept, no attempt; one audit row only when the code changes. */
  private async writeDeferral(client: PoolClient, row: ListingEndRow, code: ListingEndDeferralCode, dueAt: Date, now: Date): Promise<boolean> {
    const updated = await client.query(`UPDATE dropship.dropship_listing_end_requests
      SET next_attempt_at = $4, deferral_count = deferral_count + 1, code = $5, message = $6, updated_at = $7
      WHERE id = $1 AND state = $2 AND version = $3`, [row.id, row.state, row.version, dueAt, code, LISTING_END_MESSAGES[code], now]);
    if (updated.rowCount !== 1) return false;
    if (row.code !== code) {
      await this.audit(client, row, "listing_end_deferred", "info", now, { state: row.state, code: row.code },
        { state: row.state, code, nextAttemptAt: dueAt.toISOString() });
    }
    return true;
  }

  async retry(input: { row: ListingEndRow; code: ListingEndCode; attemptCount: number; nextAttemptAt: Date;
    context: Record<string, unknown>; now: Date }): Promise<boolean> {
    const { row } = input;
    return this.transaction(async (client) => {
      const updated = await client.query(`UPDATE dropship.dropship_listing_end_requests
        SET attempt_count = $4, next_attempt_at = $5, code = $6, message = $7, context = $8::jsonb, updated_at = $9
        WHERE id = $1 AND state = $2 AND version = $3`, [row.id, row.state, row.version, input.attemptCount, input.nextAttemptAt,
        input.code, LISTING_END_MESSAGES[input.code], JSON.stringify(input.context), input.now]);
      if (updated.rowCount !== 1) return false;
      await this.audit(client, row, "listing_end_attempt_failed", "warning", input.now,
        { state: row.state, code: row.code, attemptCount: row.attemptCount },
        { state: row.state, code: input.code, attemptCount: input.attemptCount, nextAttemptAt: input.nextAttemptAt.toISOString() });
      return true;
    });
  }

  async fail(input: { row: ListingEndRow; code: ListingEndCode; context: Record<string, unknown>; now: Date }): Promise<boolean> {
    return this.transaction(async (client) =>
      (await this.writeTerminal(client, input.row, { state: "failed", code: input.code, context: input.context, now: input.now })) !== null);
  }

  /** A state change to `failed` or `superseded` (version + 1, decided, never due again), with its audit row. */
  private async writeTerminal(client: PoolClient, row: ListingEndRow, input: { state: "failed" | "superseded"; code: ListingEndCode;
    context: Record<string, unknown>; now: Date }): Promise<ListingEndRow | null> {
    const updated = (await client.query<Record<string, unknown>>(`UPDATE dropship.dropship_listing_end_requests r
      SET state = $4, code = $5, message = $6, context = $7::jsonb, next_attempt_at = NULL, decided_at = $8, updated_at = $8,
        version = version + 1
      WHERE id = $1 AND state = $2 AND version = $3
      RETURNING r.id::text AS id, r.version`, [row.id, row.state, row.version, input.state, input.code, LISTING_END_MESSAGES[input.code],
      JSON.stringify(input.context), input.now])).rows[0];
    if (!updated) return null;
    await this.audit(client, row, input.state === "failed" ? "listing_end_failed" : "listing_end_superseded",
      input.state === "failed" ? "error" : "info", input.now, { state: row.state, code: row.code, version: row.version },
      { state: input.state, code: input.code, version: row.version + 1, ...(input.state === "failed" ? { context: input.context } : {}) });
    return row;
  }

  async markWithdrawSent(input: { row: ListingEndRow; now: Date }): Promise<boolean> {
    const { row, now } = input;
    return this.transaction(async (client) => {
      // A new call resets the previous call's result, so "requested, not returned" always means this newest call (§3).
      // Side writes keep the version, so the guard also compares the withdraw fields the worker read: a stale copy of
      // the row (another tick that read it before this row's last withdraw) never sends again (review WRK-7).
      const updated = (await client.query<{ withdraw_call_count: number }>(`UPDATE dropship.dropship_listing_end_requests
        SET withdraw_requested_at = $4, withdraw_returned_at = NULL, withdraw_outcome = NULL,
          withdraw_call_count = withdraw_call_count + 1, updated_at = $4
        WHERE id = $1 AND state = $2 AND version = $3 AND withdraw_call_count < 3
          AND withdraw_call_count = $5 AND withdraw_requested_at IS NOT DISTINCT FROM $6
          AND withdraw_outcome IS DISTINCT FROM 'ok'
        RETURNING withdraw_call_count`, [row.id, row.state, row.version, now, row.withdrawCallCount, row.withdrawRequestedAt])).rows[0];
      if (!updated) return false;
      await this.audit(client, row, "listing_end_withdraw_sent", "info", now,
        { withdrawCallCount: row.withdrawCallCount, withdrawOutcome: row.withdrawOutcome },
        { withdrawCallCount: updated.withdraw_call_count, withdrawRequestedAt: now.toISOString() });
      return true;
    });
  }

  async markWithdrawReturned(input: { row: ListingEndRow; outcome: string; sentNothing: boolean; now: Date }): Promise<boolean> {
    const { row, now } = input;
    return this.transaction(async (client) => {
      // Only for this call: the request time this worker wrote (review WRK-7).
      const updated = (await client.query<{ withdraw_call_count: number }>(`UPDATE dropship.dropship_listing_end_requests
        SET withdraw_returned_at = $4, withdraw_outcome = $5,
          withdraw_call_count = withdraw_call_count - CASE WHEN $6::boolean THEN 1 ELSE 0 END, updated_at = $4
        WHERE id = $1 AND state = $2 AND version = $3 AND withdraw_requested_at IS NOT NULL AND withdraw_returned_at IS NULL
          AND withdraw_requested_at = $7
        RETURNING withdraw_call_count`, [row.id, row.state, row.version, now, input.outcome.slice(0, 60), input.sentNothing,
        row.withdrawRequestedAt])).rows[0];
      if (!updated) return false;
      await this.audit(client, row, "listing_end_withdraw_returned", input.outcome === "ok" ? "info" : "warning", now,
        { withdrawOutcome: null }, { withdrawOutcome: input.outcome, withdrawCallCount: updated.withdraw_call_count,
          sentNothing: input.sentNothing });
      return true;
    });
  }

  /**
   * The finish (§5.5 step 8): request `FOR UPDATE` at its version → listing `FOR UPDATE` → the listing becomes
   * `ended` only while it still carries the resolved ids (SAF-1), compared as the claim resolved them (trimmed, a
   * blank listing id as none; review DB-4); its ids are kept and `marketplace_ended_at` is never written (it means
   * "the vendor ended it", SST). Then the request `ended` with `ended_at` (read by the push fence under the listing
   * lock, §6.2) and both audits. Ids that moved fail IDENTITY_MISMATCH in the same transaction.
   *
   * The time is read from `clock` after the listing lock (review DB-2, FEN-1): every writer that held the listing
   * before (a push queued meanwhile) committed first, so `ended_at` is later than such a push's creation (the fence's
   * `ended_since_queued`) and than the withdraw (orders before it are accepted). The listing's `updated_at` never
   * moves back (SPR's newer-push rule compares it).
   */
  async finish(input: { row: ListingEndRow; identity: ListingEndResolvedIdentity; verified: boolean; clock: () => Date }): Promise<ListingEndFinishResult> {
    const { row, identity } = input;
    const code = input.verified ? null : LISTING_END_CODES.notPublishedOnEbay;
    try {
      return await this.transaction(async (client): Promise<ListingEndFinishResult> => {
        const locked = (await client.query(`SELECT id FROM dropship.dropship_listing_end_requests
          WHERE id = $1 AND state = 'ending' AND version = $2 FOR UPDATE`, [row.id, row.version])).rows[0];
        if (!locked) return { kind: "moved" };
        const listing = z.object({ status: z.string() }).parse((await client.query(`SELECT status FROM dropship.dropship_vendor_listings
          WHERE id = $1 FOR UPDATE`, [row.listingId])).rows[0]);
        const now = input.clock();
        const written = await client.query(`UPDATE dropship.dropship_vendor_listings SET status = 'ended', updated_at = GREATEST(updated_at, $2)
          WHERE id = $1 AND status <> 'ended' AND btrim(external_offer_id) = $3
            AND NULLIF(btrim(external_listing_id), '') IS NOT DISTINCT FROM $4`,
        [row.listingId, now, identity.externalVariantId, identity.externalProductId]);
        if (written.rowCount !== 1 && listing.status !== "ended") {
          const failed = await this.writeTerminal(client, row, { state: "failed", code: LISTING_END_CODES.identityMismatch,
            context: { ...row.context, reason: "listing_ids_moved_before_finish", lastCode: LISTING_END_CODES.identityMismatch,
              requiresReview: true }, now });
          return failed ? { kind: "identity_moved" } : { kind: "moved" };
        }
        const ended = await client.query(`UPDATE dropship.dropship_listing_end_requests
          SET state = 'ended', ended_at = $3, decided_at = $3, next_attempt_at = NULL, code = $4, message = $5, updated_at = $3,
            version = version + 1
          WHERE id = $1 AND state = 'ending' AND version = $2`, [row.id, row.version, now, code,
          code === null ? null : LISTING_END_MESSAGES[code]]);
        if (ended.rowCount !== 1) throw new Error("The locked end request could not be finished.");
        if (written.rowCount === 1) {
          await this.insertAudit(client, { vendorId: row.vendorId, storeConnectionId: row.storeConnectionId,
            entityType: "dropship_vendor_listing", entityId: String(row.listingId), eventType: "listing_ended_by_card_shellz",
            severity: "info", now, payload: { listingId: row.listingId, endRequestId: row.id, productVariantId: row.productVariantId,
              externalOfferId: identity.externalVariantId, externalListingId: identity.externalProductId,
              before: { status: listing.status }, after: { status: "ended" } } });
        }
        await this.audit(client, row, "listing_end_ended", "info", now, { state: "ending", version: row.version },
          { state: "ended", code, version: row.version + 1, verified: input.verified, listingWritten: written.rowCount === 1 });
        return { kind: "ended", listingWritten: written.rowCount === 1 };
      });
    } catch (error) {
      const sqlState = sqlStateOf(error);
      if (sqlState !== null && LOCK_BUSY_SQLSTATES.has(sqlState)) return { kind: "lock_busy", causeCode: sqlState };
      throw error;
    }
  }

  async markInvariantBroken(input: { id: number; state: "pending" | "ending"; error: string; now: Date }): Promise<number | null> {
    return this.transaction(async (client) => {
      const updated = (await client.query<{ vendor_id: number; store_connection_id: number; version: number }>(`UPDATE
          dropship.dropship_listing_end_requests
        SET state = 'failed', code = $3, message = $4,
          context = context || jsonb_build_object('parseError', $5::text, 'requiresReview', true, 'lastCode', $3::text),
          next_attempt_at = NULL, decided_at = $6, updated_at = $6, version = version + 1
        WHERE id = $1 AND state = $2
        RETURNING vendor_id, store_connection_id, version`, [input.id, input.state, LISTING_END_CODES.invariantBroken,
        LISTING_END_MESSAGES[LISTING_END_CODES.invariantBroken], input.error, input.now])).rows[0];
      if (!updated) return null;
      await this.insertAudit(client, { vendorId: updated.vendor_id, storeConnectionId: updated.store_connection_id, entityType: AUDIT_ENTITY,
        entityId: String(input.id), eventType: "listing_end_failed", severity: "error", now: input.now,
        payload: { endRequestId: input.id, before: { state: input.state }, after: { state: "failed", code: LISTING_END_CODES.invariantBroken,
          version: updated.version }, parseError: input.error } });
      return updated.version;
    });
  }

  /**
   * The remote work's one lock (§5.5): a pinned transaction whose only job is retirement's remote-member lock, taken
   * without waiting through marketplace-listings' published export. It holds no row lock, so saves, quantity
   * admissions and the worker's own short writes (other connections) never wait on an eBay call.
   */
  async withRemoteMemberLock<T>(identity: ListingEndResolvedIdentity, work: () => Promise<T>):
    Promise<{ acquired: true; value: T } | { acquired: false }> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      if (!(await tryLockListingMemberRemote(client, identity))) {
        await client.query("ROLLBACK");
        return { acquired: false };
      }
      const value = await work();
      await client.query("COMMIT");
      return { acquired: true, value };
    } catch (error) {
      if (!(await rollbackQuietly(client))) releaseError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  /** BEGIN with the worker's timeouts, `work`, COMMIT; ROLLBACK and rethrow on any error. */
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let releaseError: Error | undefined;
    try {
      await client.query("BEGIN");
      await client.query(LOCK_TIMEOUT_SQL);
      await client.query(STATEMENT_TIMEOUT_SQL);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      if (!(await rollbackQuietly(client))) releaseError = error instanceof Error ? error : new Error(String(error));
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  private async audit(client: PoolClient, row: ListingEndRow, eventType: string, severity: "info" | "warning" | "error", now: Date,
    before: Record<string, unknown>, after: Record<string, unknown>): Promise<void> {
    await this.insertAudit(client, { vendorId: row.vendorId, storeConnectionId: row.storeConnectionId, entityType: AUDIT_ENTITY,
      entityId: String(row.id), eventType, severity, now, payload: { endRequestId: row.id, listingId: row.listingId,
        productVariantId: row.productVariantId, reason: row.reason, before, after } });
  }

  private async insertAudit(client: PoolClient, input: { vendorId: number; storeConnectionId: number; entityType: string; entityId: string;
    eventType: string; severity: "info" | "warning" | "error"; now: Date; payload: Record<string, unknown> }): Promise<void> {
    await client.query(`INSERT INTO dropship.dropship_audit_events
        (vendor_id, store_connection_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`, [input.vendorId, input.storeConnectionId, input.entityType, input.entityId,
      input.eventType, AUDIT_ACTOR_TYPE, AUDIT_ACTOR_ID, input.severity, JSON.stringify(input.payload), input.now]);
  }
}

function intentFacts(intent: unknown): { sku: string | null; marketplaceId: string | null } {
  const parsed = z.object({ marketplaceConfig: z.object({ marketplaceId: z.string().max(100).optional() }).passthrough().optional() })
    .passthrough().safeParse(intent);
  const marketplaceId = parsed.success ? parsed.data.marketplaceConfig?.marketplaceId?.trim() ?? "" : "";
  return { sku: storedIntentSku(intent), marketplaceId: marketplaceId === "" ? null : marketplaceId };
}

function isPresent(value: string | null): boolean {
  return value !== null && value.trim() !== "";
}

function sqlStateOf(error: unknown): string | null {
  return error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
    && /^[0-9A-Z]{5}$/.test((error as { code: string }).code) ? (error as { code: string }).code : null;
}

async function rollbackQuietly(client: PoolClient): Promise<boolean> {
  try {
    await client.query("ROLLBACK");
    return true;
  } catch {
    // The original error is rethrown; a session whose rollback failed is discarded, never reused.
    return false;
  }
}
