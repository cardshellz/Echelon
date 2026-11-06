import { readAccountNativeScan, ACCOUNT_NATIVE_CHECKPOINT_LIMIT } from "../domain/account-native-pagination";
import { accountNativeSourceFailureSchema } from "../application/account-native-summaries.ports";
import { AccountNativeLeaseLostError } from "../application/account-native-summaries.ports";
import type { Pool } from "pg";
import { z } from "zod";
import { customerAccountOrderSummariesInputSchema } from "@shared/customer-account/customer-account-orders";
import {
  accountNativeFactSchema,
  type AccountNativeObservation,
  type AccountNativeReader,
  type AccountNativeRetainer,
  type AccountNativeMaintenance,
  type AccountNativeCursor,
  type AccountNativeClaim,
  type AccountNativePage,
} from "../application/account-native-summaries.ports";

const id = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .max(30);
const channel = z.number().int().positive().safe();
const INFINITE = "infinity";
const DELTA_OVERLAP_MS = 5 * 60_000;
const DELTA_INTERVAL_MS = 15_000;
const HISTORY_PAGE_INTERVAL_MS = 30_000;
const RETRY_MS = 30_000;
const SOURCE_ERROR_RETRY_MS = 15 * 60_000;
const REFRESH_COOLDOWN_MS = 60_000;
export const NATIVE_LEASE_MS = 120_000;

/** Owns only a derived display cache; no order, balance or inventory commands. */
export class PostgresAccountNativeSummaries
  implements
    AccountNativeReader,
    AccountNativeRetainer,
    AccountNativeMaintenance
{
  constructor(
    private readonly pool: Pick<Pool, "query">,
    private readonly shopDomains: readonly string[] = [],
  ) {}

  async read(input: Parameters<AccountNativeReader["read"]>[0]) {
    const identities = customerAccountOrderSummariesInputSchema.parse({
      orders: input.orders,
    });
    const scope = z
      .object({
        channelId: channel,
        connectionId: channel,
        externalCustomerId: id,
        shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/),
      })
      .parse(input);
    const result = await this.pool.query(
      `SELECT p.fact,GREATEST(p.verified_at,cursor.delta_covered_until) AS "freshThrough" FROM oms.customer_account_native_summaries p
      JOIN channels.channel_connections cc ON cc.id=p.connection_id AND cc.channel_id=p.channel_id AND cc.shop_domain=p.shop_domain
      LEFT JOIN oms.customer_account_native_cursors cursor ON cursor.connection_id=p.connection_id
      WHERE p.channel_id=$1 AND p.external_customer_id=$2 AND p.connection_id=$3 AND p.shop_domain=$4
      AND p.external_order_id=ANY($5::text[]) AND p.fact IS NOT NULL AND p.source_error_code IS NULL`,
      [
        scope.channelId,
        scope.externalCustomerId,
        scope.connectionId,
        scope.shopDomain,
        identities.orders.map((item) => item.externalOrderId),
      ],
    );
    return result.rows
      .map((row) => ({
        ...accountNativeFactSchema.parse(row.fact),
        freshThrough: z.date().parse(row.freshThrough),
      }))
      .filter(
        (fact) =>
          fact.channelId === scope.channelId &&
          fact.externalCustomerId === scope.externalCustomerId &&
          fact.connectionId === scope.connectionId &&
          fact.shopDomain === scope.shopDomain &&
          identities.orders.some(
            (item) =>
              item.externalOrderId === fact.externalOrderId &&
              item.orderReference === fact.orderReference,
          ),
      );
  }

  async retain(raw: AccountNativeObservation) {
    const facts = z
      .array(accountNativeFactSchema)
      .max(100)
      .refine(
        (values) =>
          new Set(
            values.map(
              (value) => `${value.channelId}:${value.externalOrderId}`,
            ),
          ).size === values.length,
        "Duplicate purchase identities",
      )
      .parse(raw.facts);
    const failures = z
      .array(accountNativeSourceFailureSchema)
      .max(100)
      .parse(raw.failures ?? []);
    const identities = [...facts, ...failures].map(
      (value) => `${value.channelId}:${value.externalOrderId}`,
    );
    if (
      identities.length > 100 ||
      new Set(identities).size !== identities.length
    )
      throw new Error("ACCOUNT_NATIVE_OBSERVATION_INVALID");
    const started = z.date().parse(raw.startedAt),
      finished = z.date().parse(raw.finishedAt);
    if (started > finished)
      throw new Error("Native observation ends before it starts");

    // Source version wins over completion order. For Shopify's same-second
    // versions, a conflicting observation may replace a fact only if its read
    // started AFTER that fact was received. Overlapping older responses cannot
    // undo a newer edit/refund. A later reconciliation resolves equal versions.
    // Facts and isolated source errors commit atomically before a cursor can advance.
    await this.pool.query(
      `WITH retained_facts AS (INSERT INTO oms.customer_account_native_summaries AS existing
      (channel_id,external_order_id,external_customer_id,connection_id,shop_domain,fact,source_updated_at,verified_at,next_refresh_at)
      SELECT r."channelId",r."externalOrderId",r."externalCustomerId",r."connectionId",r."shopDomain",r.fact,r."sourceUpdatedAt",$2,$3
      FROM jsonb_to_recordset($1::jsonb) AS r("channelId" int,"externalOrderId" text,"externalCustomerId" text,"connectionId" int,"shopDomain" text,fact jsonb,"sourceUpdatedAt" timestamptz)
      ORDER BY r."channelId",r."externalOrderId"
      ON CONFLICT(channel_id,external_order_id) DO UPDATE SET
        external_customer_id=EXCLUDED.external_customer_id,connection_id=EXCLUDED.connection_id,shop_domain=EXCLUDED.shop_domain,
        fact=EXCLUDED.fact,source_updated_at=EXCLUDED.source_updated_at,verified_at=GREATEST(existing.verified_at,EXCLUDED.verified_at),
        next_refresh_at=CASE WHEN existing.lease_until IS NOT NULL THEN existing.next_refresh_at
          ELSE GREATEST(existing.next_refresh_at,EXCLUDED.verified_at) END,last_error_code=NULL,
        source_error_code=NULL,source_error_updated_at=NULL,source_error_observed_at=NULL
      WHERE (existing.source_updated_at IS NULL OR EXCLUDED.source_updated_at>existing.source_updated_at
        OR (EXCLUDED.source_updated_at=existing.source_updated_at AND (EXCLUDED.fact=existing.fact OR $4>existing.verified_at)))
        AND (existing.source_error_updated_at IS NULL OR EXCLUDED.source_updated_at>existing.source_error_updated_at
          OR (EXCLUDED.source_updated_at=existing.source_error_updated_at AND $4>existing.source_error_observed_at)) RETURNING channel_id,external_order_id)
INSERT INTO oms.customer_account_native_summaries AS existing
      (channel_id,external_order_id,external_customer_id,connection_id,shop_domain,source_error_code,source_error_updated_at,source_error_observed_at,next_refresh_at)
      SELECT r."channelId",r."externalOrderId",r."externalCustomerId",r."connectionId",r."shopDomain",r.code,r."sourceUpdatedAt",$2,$6
      FROM jsonb_to_recordset($5::jsonb) r("channelId" int,"externalOrderId" text,"externalCustomerId" text,"connectionId" int,"shopDomain" text,code text,"sourceUpdatedAt" timestamptz)
      ORDER BY r."channelId",r."externalOrderId"
      ON CONFLICT(channel_id,external_order_id) DO UPDATE SET source_error_code=EXCLUDED.source_error_code,external_customer_id=EXCLUDED.external_customer_id,
        source_error_updated_at=EXCLUDED.source_error_updated_at,source_error_observed_at=EXCLUDED.source_error_observed_at,
        next_refresh_at=LEAST(existing.next_refresh_at,EXCLUDED.next_refresh_at)
      WHERE (GREATEST(existing.source_updated_at,existing.source_error_updated_at) IS NULL
        OR EXCLUDED.source_error_updated_at>GREATEST(existing.source_updated_at,existing.source_error_updated_at)
        OR (EXCLUDED.source_error_updated_at=GREATEST(existing.source_updated_at,existing.source_error_updated_at)
          AND $4>GREATEST(existing.verified_at,existing.source_error_observed_at)))`,
      [
        JSON.stringify(facts.map((fact) => ({ ...fact, fact }))),
        finished,
        INFINITE,
        started,
        JSON.stringify(failures),
        new Date(finished.getTime() + SOURCE_ERROR_RETRY_MS),
      ],
    );
  }

  async request(raw: Parameters<AccountNativeReader["request"]>[0], now: Date) {
    const channelId = channel.parse(raw.channelId),
      externalCustomerId = id.parse(raw.externalCustomerId),
      ids = z.array(id).min(1).max(20).parse(raw.externalOrderIds);
    z.date().parse(now);
    await this.pool.query(
      `INSERT INTO oms.customer_account_native_summaries AS existing(channel_id,external_order_id)
      SELECT $1::integer,requested.id FROM unnest($2::text[]) AS requested(id)
      WHERE EXISTS(SELECT 1 FROM oms.oms_orders o WHERE o.channel_id=$1 AND o.external_customer_id=$5
        AND (o.external_order_id=requested.id OR o.external_order_id='gid://shopify/Order/'||requested.id))
      OR EXISTS(SELECT 1 FROM oms.customer_account_native_summaries known WHERE known.channel_id=$1
        AND known.external_order_id=requested.id AND known.external_customer_id=$5)
      ORDER BY 2 ON CONFLICT(channel_id,external_order_id) DO UPDATE
      SET next_refresh_at='-infinity',generation=existing.generation+1
      WHERE existing.next_refresh_at>$3 AND (existing.lease_until IS NULL OR existing.lease_until<=$3)
        AND (GREATEST(existing.verified_at,existing.source_error_observed_at) IS NULL OR GREATEST(existing.verified_at,existing.source_error_observed_at)<=$4)`,
      [
        channelId,
        [...new Set(ids)],
        now,
        new Date(now.getTime() - REFRESH_COOLDOWN_MS),
        externalCustomerId,
      ],
    );
  }

  async claim(now: Date, leaseId: string): Promise<AccountNativeCursor | null> {
    z.date().parse(now);
    z.string().uuid().parse(leaseId);
    for (const shop of this.shopDomains)
      z.string()
        .regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/)
        .parse(shop);
    // Seeding and claiming only enabled stores prevents unrelated tenants from
    // starting a historical API scan. Multiple dynos share the same SQL lease.
    // Connection expiry is legacy timestamp; cursor deadlines are timestamptz.
    // Type shared parameters explicitly so PostgreSQL does not infer both types.
    await this.pool.query(
      `INSERT INTO oms.customer_account_native_cursors(connection_id,delta_since,delta_started_at)
      SELECT cc.id,$2::timestamptz,$3::timestamptz FROM channels.channel_connections cc JOIN channels.channels c ON c.id=cc.channel_id
      WHERE c.provider='shopify' AND c.status='active' AND cc.shop_domain=ANY($1::text[])
        AND (cc.expires_at IS NULL OR cc.expires_at>$3::timestamptz)
      ON CONFLICT(connection_id) DO NOTHING`,
      [this.shopDomains, new Date(now.getTime() - DELTA_OVERLAP_MS), now],
    );
    const rows = (
      await this.pool.query(
        `WITH candidate AS (
      SELECT p.connection_id FROM oms.customer_account_native_cursors p
      JOIN channels.channel_connections cc ON cc.id=p.connection_id JOIN channels.channels c ON c.id=cc.channel_id
      WHERE cc.shop_domain=ANY($1::text[]) AND c.status='active' AND c.provider='shopify'
        AND (cc.expires_at IS NULL OR cc.expires_at>$2::timestamptz) AND p.next_attempt_at<=$2::timestamptz
        AND (p.lease_until IS NULL OR p.lease_until<=$2::timestamptz)
      ORDER BY p.next_attempt_at,p.connection_id FOR UPDATE OF p SKIP LOCKED LIMIT 1)
      UPDATE oms.customer_account_native_cursors p SET lease_id=$3,lease_until=$4
      FROM candidate,channels.channel_connections cc WHERE p.connection_id=candidate.connection_id AND cc.id=p.connection_id
      RETURNING p.connection_id AS "connectionId",cc.channel_id AS "channelId",cc.shop_domain AS "shopDomain",
        p.lease_id AS "leaseId",CASE WHEN p.backfill_checkpoint->>'kind'='complete' THEN NULL ELSE p.backfill_checkpoint::text END AS "backfillAfter",
        COALESCE(p.backfill_checkpoint->>'kind'='complete',false) AS "backfillComplete",(p.next_backfill_at<=$2::timestamptz) AS "backfillDue",
        COALESCE((p.delta_checkpoint->>'since')::timestamptz,p.delta_since) AS "deltaSince",p.delta_checkpoint::text AS "deltaAfter",
        COALESCE((p.delta_checkpoint->>'startedAt')::timestamptz,p.delta_started_at) AS "deltaStartedAt",
        (p.next_delta_at<=$2::timestamptz) AS "deltaDue"`,
        [
          this.shopDomains,
          now,
          leaseId,
          new Date(now.getTime() + NATIVE_LEASE_MS),
        ],
      )
    ).rows;
    if (!rows.length) return null;
    const cursor = z
      .object({
        connectionId: channel,
        channelId: channel,
        shopDomain: z.string(),
        leaseId: z.string().uuid(),
        backfillAfter: z.string().max(ACCOUNT_NATIVE_CHECKPOINT_LIMIT).nullable(),
        backfillComplete: z.boolean(),
        backfillDue: z.boolean(),
        deltaSince: z.date(),
        deltaAfter: z.string().max(ACCOUNT_NATIVE_CHECKPOINT_LIMIT).nullable(),
        deltaStartedAt: z.date(),
        deltaDue: z.boolean(),
      })
      .parse(rows[0]);
    if (cursor.backfillAfter !== null) readAccountNativeScan(cursor.connectionId, cursor.backfillAfter, null);
    if (cursor.deltaAfter !== null) readAccountNativeScan(cursor.connectionId, cursor.deltaAfter, cursor.deltaSince);
    return cursor;
  }

  async claimOrders(
    cursor: AccountNativeCursor,
    now: Date,
  ): Promise<AccountNativeClaim[]> {
    const rows = (
      await this.pool.query(
        `WITH due AS (SELECT external_order_id FROM oms.customer_account_native_summaries
      WHERE channel_id=$1 AND next_refresh_at<=$2 AND (lease_until IS NULL OR lease_until<=$2)
      ORDER BY next_refresh_at,external_order_id FOR UPDATE SKIP LOCKED LIMIT 20)
      UPDATE oms.customer_account_native_summaries p SET lease_id=$3,lease_until=$4,attempts=p.attempts+1
      FROM due WHERE p.channel_id=$1 AND p.external_order_id=due.external_order_id
      RETURNING p.external_order_id AS "externalOrderId",p.generation::text AS generation,p.lease_id AS "leaseId",p.attempts`,
        [
          cursor.channelId,
          now,
          cursor.leaseId,
          new Date(now.getTime() + NATIVE_LEASE_MS),
        ],
      )
    ).rows;
    return z
      .array(
        z.object({
          externalOrderId: id,
          generation: z.string().regex(/^[1-9][0-9]*$/),
          leaseId: z.string().uuid(),
          attempts: z.number().int().positive(),
        }),
      )
      .max(20)
      .parse(rows);
  }

  async completeOrders(
    cursor: AccountNativeCursor,
    claims: AccountNativeClaim[],
    observedSince: Date,
    now: Date,
  ): Promise<void> {
    if (!claims.length) return;
    const result = await this.pool.query(
      `UPDATE oms.customer_account_native_summaries p SET lease_id=NULL,lease_until=NULL,
      next_refresh_at=CASE WHEN p.source_error_code IS NOT NULL AND p.source_error_observed_at>=$4 THEN $7::timestamptz
        WHEN p.verified_at>=$4 THEN 'infinity'::timestamptz ELSE $5::timestamptz END,
      last_error_code=CASE WHEN p.source_error_code IS NOT NULL THEN p.source_error_code WHEN p.verified_at>=$4 THEN NULL ELSE 'ACCOUNT_NATIVE_NOT_FOUND' END
      FROM jsonb_to_recordset($1::jsonb) r("externalOrderId" text,generation bigint,"leaseId" uuid)
      WHERE p.channel_id=$2 AND p.external_order_id=r."externalOrderId" AND p.generation=r.generation AND p.lease_id=r."leaseId"
        AND p.lease_id=$3 AND p.lease_until>$6`,
      [
        JSON.stringify(claims),
        cursor.channelId,
        cursor.leaseId,
        observedSince,
        new Date(now.getTime() + REFRESH_COOLDOWN_MS),
        now,
        new Date(now.getTime() + SOURCE_ERROR_RETRY_MS),
      ],
    );
    if (result.rowCount !== claims.length)
      throw new AccountNativeLeaseLostError();
  }

  async completePage(
    cursor: AccountNativeCursor,
    kind: "delta" | "backfill",
    page: AccountNativePage,
    now: Date,
  ): Promise<void> {
    if (page.after !== null)
      readAccountNativeScan(cursor.connectionId, page.after, kind === "backfill" ? null : cursor.deltaSince);
    if (kind === "backfill") {
      const result = await this.pool.query(
        `UPDATE oms.customer_account_native_cursors SET backfill_checkpoint=CASE WHEN $3::jsonb IS NULL
          THEN '{"version":1,"kind":"complete"}'::jsonb ELSE $3::jsonb END,next_backfill_at=$4
        WHERE connection_id=$1 AND lease_id=$2 AND lease_until>$5`,
        [
          cursor.connectionId,
          cursor.leaseId,
          page.after,
          new Date(now.getTime() + HISTORY_PAGE_INTERVAL_MS),
          now,
        ],
      );
      if (result.rowCount !== 1) throw new AccountNativeLeaseLostError();
      return;
    }
    // Keep the lower bound fixed while paginating. On completion restart from
    // scan START minus overlap, so updates arriving during the scan are revisited.
    // A rolling older release can still update the legacy delta timestamps.
    // A multi-page scan owns its window/start in its independent checkpoint.
    const scanStartedAt = cursor.deltaAfter === null ? z.date().parse(page.observation.startedAt) : cursor.deltaStartedAt;
    const result = await this.pool.query(
      `UPDATE oms.customer_account_native_cursors SET delta_checkpoint=$3::jsonb,
      delta_since=CASE WHEN $3::jsonb IS NULL THEN $4 ELSE delta_since END,
      delta_covered_until=CASE WHEN $3::jsonb IS NULL THEN $7::timestamptz ELSE delta_covered_until END,
      delta_started_at=CASE WHEN $3::jsonb IS NULL THEN $5 ELSE delta_started_at END,
      next_delta_at=CASE WHEN $3::jsonb IS NULL THEN $6 ELSE $5 END
      WHERE connection_id=$1 AND lease_id=$2 AND lease_until>$5`,
      [
        cursor.connectionId,
        cursor.leaseId,
        page.after,
        new Date(scanStartedAt.getTime() - DELTA_OVERLAP_MS),
        now,
        new Date(now.getTime() + DELTA_INTERVAL_MS),
        scanStartedAt,
      ],
    );
    if (result.rowCount !== 1) throw new AccountNativeLeaseLostError();
  }

  async release(
    cursor: AccountNativeCursor,
    now: Date,
    failed: boolean,
  ): Promise<void> {
    // Failed claims stay durable; a bounded delay avoids hammering Shopify.
    await this.pool.query(
      `UPDATE oms.customer_account_native_summaries SET lease_id=NULL,lease_until=NULL,
      next_refresh_at=$3,last_error_code='ACCOUNT_NATIVE_REFRESH_FAILED' WHERE channel_id=$1 AND lease_id=$2`,
      [cursor.channelId, cursor.leaseId, new Date(now.getTime() + RETRY_MS)],
    );
    await this.pool.query(
      `UPDATE oms.customer_account_native_cursors SET lease_id=NULL,lease_until=NULL,next_attempt_at=$3,last_error_code=$4
      WHERE connection_id=$1 AND lease_id=$2`,
      [
        cursor.connectionId,
        cursor.leaseId,
        new Date(now.getTime() + (failed ? RETRY_MS : 0)),
        failed ? "ACCOUNT_NATIVE_REFRESH_FAILED" : null,
      ],
    );
  }
}
