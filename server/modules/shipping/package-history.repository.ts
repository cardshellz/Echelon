import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { type PackageHistoryDocument } from "@shared/shipping/package-history";
import {
  packageHistoryHash,
  verifyPackageHistoryDocument,
  PackageHistoryError,
} from "./package-history.domain";
import type {
  PackageHistoryClaim,
  PackageHistoryStore,
  PackageHistoryFilter,
} from "./package-history.ports";

const id = z.number().int().positive().safe();
const claimSchema = z
  .object({
    omsOrderId: z.coerce.number().int().positive().safe(),
    generation: z.string().regex(/^[1-9][0-9]*$/),
    leaseId: z.string().uuid(),
    attempts: z.number().int().min(0).max(8),
  })
  .strict();
const MAX_ATTEMPTS = 8;
const LEASE_MS = 5 * 60_000;
const filterSchema = z
  .object({
    channelId: id.optional(),
    orderIds: z.array(id).min(1).max(200).optional(),
  })
  .strict();
function knownLabelConflictSql(document: "j.document" | "$1::jsonb"): string {
  // Only fixed internal expressions are accepted; provider values remain binds.
  return `SELECT 1 FROM jsonb_array_elements((${document})->'packages') p JOIN wms.shipping_provider_labels l
    ON l.provider='shipstation' AND l.provider_label_id=p->>'providerShipmentId'
    LEFT JOIN LATERAL(SELECT event.sanitized_payload->>'sourceObservationHash' AS contents_hash
      FROM wms.shipping_provider_label_events event WHERE event.shipping_provider_label_id=l.id
      ORDER BY event.received_at DESC,event.id DESC LIMIT 1) latest ON true
    WHERE l.label_status<>'active' OR l.label_direction<>'outbound' OR l.tracking_number<>p->>'trackingNumber'
      OR (latest.contents_hash IS NOT NULL AND latest.contents_hash<>p->>'providerObservationHash')
      OR (p->>'measurementStatus'='verified' AND l.metadata ? 'packageDimensions' AND
        ((l.metadata #>> '{packageDimensions,observation,status}') IS DISTINCT FROM 'verified'
          OR (l.metadata #> '{packageDimensions,observation,dimensions}') IS DISTINCT FROM p->'dimensions'))`;
}
export class PostgresPackageHistoryStore implements PackageHistoryStore {
  private readonly actor: string;
  constructor(
    private readonly pool: Pick<Pool, "query" | "connect">,
    private readonly now: () => Date,
    actor = "system:shipping-package-history",
  ) {
    this.actor = z.string().trim().min(1).max(200).parse(actor);
  }

  async drain(
    limit: number,
    rawFilter: PackageHistoryFilter = {},
  ): Promise<number> {
    z.number().int().min(1).max(1_000).parse(limit);
    const filter = filterSchema.parse(rawFilter);
    const result = await this.pool.query(
      `WITH pending AS MATERIALIZED (
      SELECT d.id,d.oms_order_id FROM wms.shipping_package_history_invalidations d LEFT JOIN oms.oms_orders source ON source.id=d.oms_order_id
      WHERE ($2::int IS NULL OR source.channel_id=$2) AND ($3::bigint[] IS NULL OR d.oms_order_id=ANY($3::bigint[]))
      ORDER BY d.id LIMIT $1 FOR UPDATE OF d SKIP LOCKED
    ), refreshed AS (
      INSERT INTO wms.shipping_package_history_jobs(oms_order_id,priority,next_attempt_at)
      SELECT DISTINCT o.id,1,$4::timestamptz FROM pending d JOIN oms.oms_orders o ON o.id=d.oms_order_id ORDER BY o.id
      ON CONFLICT(oms_order_id) DO UPDATE SET generation=wms.shipping_package_history_jobs.generation+1,
        priority=1,next_attempt_at=CASE WHEN wms.shipping_package_history_jobs.state='pending'
          THEN LEAST(wms.shipping_package_history_jobs.next_attempt_at,$4::timestamptz) ELSE $4::timestamptz END,
        attempts=0,last_error_code=NULL,state='pending'
      RETURNING oms_order_id
    ) DELETE FROM wms.shipping_package_history_invalidations WHERE id IN(SELECT id FROM pending) AND (SELECT count(*) FROM refreshed)>=0`,
      [
        limit,
        filter.channelId ?? null,
        filter.orderIds ?? null,
        z.date().parse(this.now()),
      ],
    );
    return result.rowCount ?? 0;
  }
  async claim(
    limit: number,
    now: Date,
    leaseId: string,
    rawFilter: PackageHistoryFilter = {},
  ): Promise<PackageHistoryClaim[]> {
    z.number().int().min(1).max(10).parse(limit);
    z.date().parse(now);
    z.string().uuid().parse(leaseId);
    const filter = filterSchema.parse(rawFilter);
    const result = await this.pool.query(
      `WITH eligible AS MATERIALIZED (
      SELECT j.oms_order_id FROM wms.shipping_package_history_jobs j JOIN oms.oms_orders o ON o.id=j.oms_order_id
      JOIN channels.channels c ON c.id=o.channel_id WHERE c.provider='shopify' AND c.type='internal' AND c.status='active'
      AND j.next_attempt_at<=$2 AND (j.lease_until IS NULL OR j.lease_until<=$2)
      AND ($5::bigint[] IS NULL OR j.oms_order_id=ANY($5::bigint[]))
      AND ($6::int IS NULL OR o.channel_id=$6)
      AND NOT EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations d WHERE d.oms_order_id=j.oms_order_id)
    ), first_slot AS MATERIALIZED (
      SELECT j.oms_order_id FROM eligible e JOIN wms.shipping_package_history_jobs j ON j.oms_order_id=e.oms_order_id
      WHERE j.next_attempt_at<=$2 AND (j.lease_until IS NULL OR j.lease_until<=$2)
      ORDER BY j.priority DESC,j.next_attempt_at,j.oms_order_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED
    ), remaining_slots AS MATERIALIZED (
      SELECT j.oms_order_id FROM eligible e JOIN wms.shipping_package_history_jobs j ON j.oms_order_id=e.oms_order_id
      WHERE j.oms_order_id NOT IN(SELECT oms_order_id FROM first_slot)
      AND j.next_attempt_at<=$2 AND (j.lease_until IS NULL OR j.lease_until<=$2)
      ORDER BY j.priority,j.next_attempt_at,j.oms_order_id LIMIT ($1-(SELECT count(*) FROM first_slot)) FOR UPDATE OF j SKIP LOCKED
    ), pending AS (
      SELECT * FROM first_slot UNION ALL SELECT * FROM remaining_slots
    ) UPDATE wms.shipping_package_history_jobs j SET lease_id=$3,lease_until=$4 FROM pending p WHERE j.oms_order_id=p.oms_order_id
    RETURNING j.oms_order_id AS "omsOrderId",j.generation::text,j.lease_id::text AS "leaseId",j.attempts`,
      [
        limit,
        now,
        leaseId,
        new Date(now.getTime() + LEASE_MS),
        filter.orderIds ?? null,
        filter.channelId ?? null,
      ],
    );
    return z.array(claimSchema).max(limit).parse(result.rows);
  }
  async complete(
    rawClaim: PackageHistoryClaim,
    rawDocument: PackageHistoryDocument,
    now: Date,
  ): Promise<boolean> {
    const claim = claimSchema.parse(rawClaim),
      document = verifyPackageHistoryDocument(rawDocument);
    z.date().parse(now);
    if (document.omsOrderId !== claim.omsOrderId)
      throw new Error("PACKAGE_HISTORY_CLAIM_MISMATCH");
    const hash = packageHistoryHash(document);
    return this.transaction(async (client) => {
      const previous = (
        await client.query(
          `SELECT evidence_hash FROM wms.shipping_package_history_jobs
        WHERE oms_order_id=$1 AND generation=$2::bigint AND lease_id=$3 AND lease_until>$4
        AND NOT EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations d WHERE d.oms_order_id=$1) FOR UPDATE`,
          [claim.omsOrderId, claim.generation, claim.leaseId, now],
        )
      ).rows;
      if (!previous.length) {
        await client.query(
          `UPDATE wms.shipping_package_history_jobs SET lease_id=NULL,lease_until=NULL WHERE oms_order_id=$1 AND lease_id=$2`,
          [claim.omsOrderId, claim.leaseId],
        );
        return false;
      }
      const owned = await client.query(
        `SELECT id FROM oms.oms_orders WHERE id=$1 AND channel_id=$2 AND external_order_id=ANY($3::text[]) FOR SHARE`,
        [
          document.omsOrderId,
          document.channelId,
          [
            document.externalOrderId,
            `gid://shopify/Order/${document.externalOrderId}`,
          ],
        ],
      );
      if (owned.rows.length !== 1)
        throw new Error("PACKAGE_HISTORY_OWNER_CHANGED");
      const conflict = await client.query(
        `SELECT EXISTS(${knownLabelConflictSql("$1::jsonb")}) AS conflict`,
        [JSON.stringify(document)],
      );
      if (conflict.rows[0].conflict)
        throw new PackageHistoryError(
          "PACKAGE_HISTORY_LABEL_STATE_CHANGED",
          "transient",
        );
      await client.query(
        `INSERT INTO wms.shipping_package_history_events(oms_order_id,evidence_hash,document,actor,observed_at)
        VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT(oms_order_id,evidence_hash) DO NOTHING`,
        [claim.omsOrderId, hash, JSON.stringify(document), this.actor, now],
      );
      await client.query(
        `UPDATE wms.shipping_package_history_jobs SET state='ready',document=$2::jsonb,evidence_hash=$3,verified_at=$4,
        computed_generation=generation,next_attempt_at='infinity',priority=0,attempts=0,lease_id=NULL,lease_until=NULL,last_error_code=NULL WHERE oms_order_id=$1`,
        [claim.omsOrderId, JSON.stringify(document), hash, now],
      );
      if (previous[0].evidence_hash !== hash)
        await client.query(
          `INSERT INTO oms.customer_order_action_invalidations(oms_order_id) VALUES($1)`,
          [claim.omsOrderId],
        );
      return true;
    });
  }
  async renew(rawClaim: PackageHistoryClaim, now: Date): Promise<boolean> {
    const claim = claimSchema.parse(rawClaim);
    z.date().parse(now);
    const result = await this.pool.query(
      `UPDATE wms.shipping_package_history_jobs j SET lease_until=$4
      WHERE oms_order_id=$1 AND generation=$2::bigint AND lease_id=$3 AND lease_until>$5
      AND NOT EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations d WHERE d.oms_order_id=j.oms_order_id)`,
      [
        claim.omsOrderId,
        claim.generation,
        claim.leaseId,
        new Date(now.getTime() + LEASE_MS),
        now,
      ],
    );
    return result.rowCount === 1;
  }
  async fail(
    rawClaim: PackageHistoryClaim,
    code: string,
    classification: "review" | "transient",
    now: Date,
  ): Promise<void> {
    const claim = claimSchema.parse(rawClaim);
    z.string()
      .regex(/^PACKAGE_HISTORY_[A-Z_]{1,75}$/)
      .parse(code);
    z.enum(["review", "transient"]).parse(classification);
    z.date().parse(now);
    const exhausted =
      classification === "review" || claim.attempts + 1 >= MAX_ATTEMPTS;
    const retryAt = new Date(
      now.getTime() +
        Math.min(60 * 60_000, 60_000 * 2 ** Math.min(claim.attempts, 6)),
    );
    await this.pool.query(
      `UPDATE wms.shipping_package_history_jobs SET lease_id=NULL,lease_until=NULL,
      state=CASE WHEN generation<>$2::bigint THEN 'pending' ELSE $4 END,
      attempts=CASE WHEN generation<>$2::bigint THEN 0 ELSE LEAST(attempts+1,8) END,
      last_error_code=CASE WHEN generation<>$2::bigint THEN NULL ELSE $5 END,
      next_attempt_at=CASE WHEN generation<>$2::bigint THEN next_attempt_at WHEN $6 THEN 'infinity'::timestamptz ELSE $7 END
      WHERE oms_order_id=$1 AND lease_id=$3`,
      [
        claim.omsOrderId,
        claim.generation,
        claim.leaseId,
        exhausted ? "review" : "retry",
        code,
        exhausted,
        retryAt,
      ],
    );
  }
  async read(raw: {
    omsOrderId: number;
    channelId: number;
    externalOrderId: string;
  }): Promise<PackageHistoryDocument | null> {
    const input = z
      .object({
        omsOrderId: id,
        channelId: id,
        externalOrderId: z
          .string()
          .regex(/^(?:gid:\/\/shopify\/Order\/)?[1-9][0-9]*$/),
      })
      .strict()
      .parse(raw);
    const external = input.externalOrderId.replace(
      /^gid:\/\/shopify\/Order\//,
      "",
    );
    const instant = z.date().parse(this.now());
    const result = await this.pool.query(
      `SELECT j.document,j.evidence_hash FROM wms.shipping_package_history_jobs j JOIN oms.oms_orders o ON o.id=j.oms_order_id
      JOIN wms.shipping_package_history_events saved ON saved.oms_order_id=j.oms_order_id AND saved.evidence_hash=j.evidence_hash AND saved.document=j.document
      WHERE o.id=$1 AND o.channel_id=$2 AND o.external_order_id=ANY($3::text[]) AND j.state='ready'
      AND j.computed_generation=j.generation AND j.verified_at<=$4
      AND NOT EXISTS(SELECT 1 FROM wms.shipping_package_history_invalidations d WHERE d.oms_order_id=o.id)
      AND NOT EXISTS(${knownLabelConflictSql("j.document")})`,
      [
        input.omsOrderId,
        input.channelId,
        [external, `gid://shopify/Order/${external}`],
        instant,
      ],
    );
    if (!result.rows.length) return null;
    const document = verifyPackageHistoryDocument(result.rows[0].document);
    if (packageHistoryHash(document) !== result.rows[0].evidence_hash)
      throw new Error("PACKAGE_HISTORY_EVIDENCE_INVALID");
    if (
      document.omsOrderId !== input.omsOrderId ||
      document.channelId !== input.channelId ||
      document.externalOrderId !== external
    )
      throw new Error("PACKAGE_HISTORY_OWNER_CHANGED");
    return document;
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      await client.query(
        "SET LOCAL lock_timeout='2s'; SET LOCAL statement_timeout='15s'",
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        broken = true;
      }
      throw error;
    } finally {
      client.release(broken);
    }
  }
}
