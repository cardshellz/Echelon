import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { EBAY_RECONCILIATION_INTERVAL_MS, EBAY_RECONCILIATION_LEASE_MS,
  type EbayPublicationReconciliationStore, type EbayPublicationReconciliationStatus, type EbayReconciliationClaim,
  type EbayReconciliationTarget, type EbayReconciliationObservation, type EbayReconciliationStockResult,
} from "../application/ebay-publication-reconciliation.service";
import { ebayReconciliationCommandKey } from "../domain/ebay-automatic-publication-recovery";
import { quantityPublicationScopeSchema } from "../domain/quantity-publication-admission";
import { createTransactionScopedInventoryPublicationService, LATEST_PUBLICATION_ROW_SQL } from "./inventory-availability-runtime-publication.repository";
import { reconciliationFailure, withReconciliationTransaction } from "./ebay-publication-reconciliation.persistence";

const BACKOFF_BASE_MS = 60_000;
// These conditions are retried by the saved watch; they require no user decision.
const RETRYABLE_RECONCILIATION_CODES = new Set([
  "PUBLICATION_RECONCILIATION_PLAN_CHANGED",
  "INVENTORY_PUBLICATION_TARGET_BUSY",
  "PUBLICATION_SCOPE_BUSY",
]);
type Failure = { code: string; message: string; commandConsumed: boolean; contentJobId?: string };
interface WatchRow {
  id: string; revision: string; cycle: string; attempts: number; lease_token: string;
  product_id: number; connection_id: number; external_scope_id: string; scopes: unknown;
}

export class PostgresEbayPublicationReconciliationRepository implements EbayPublicationReconciliationStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  claimDue(limit: number, now: Date, leaseToken: string): Promise<EbayReconciliationClaim[]> {
    z.number().int().min(1).max(100).parse(limit); z.string().uuid().parse(leaseToken); z.date().parse(now);
    return withReconciliationTransaction(this.pool, async client => {
      const rows = (await client.query<WatchRow>(`WITH due AS (
        SELECT id FROM inventory.ebay_publication_reconciliation_watches WHERE next_check_at<=$1
          AND (lease_token IS NULL OR lease_expires_at<=$1) ORDER BY next_check_at,id FOR UPDATE SKIP LOCKED LIMIT $2)
        UPDATE inventory.ebay_publication_reconciliation_watches watch SET lease_token=$3,lease_expires_at=$4,
          attempts=watch.attempts+1,updated_at=$1 FROM due WHERE watch.id=due.id
        RETURNING watch.id::text,watch.revision::text,watch.cycle::text,watch.attempts,watch.lease_token,
          watch.product_id,watch.connection_id,watch.external_scope_id,watch.scopes`,
      [now.toISOString(), limit, leaseToken, new Date(now.getTime() + EBAY_RECONCILIATION_LEASE_MS).toISOString()])).rows;
      return rows.map(row => ({ watchId: row.id, revision: row.revision, cycle: row.cycle, attempts: row.attempts,
        leaseToken: row.lease_token, productId: row.product_id, connectionId: row.connection_id, accountId: row.external_scope_id,
        scopes: z.array(quantityPublicationScopeSchema).min(1).max(251).parse(row.scopes) }));
    });
  }

  async renew(claim: EbayReconciliationClaim, now: Date): Promise<void> {
    await withReconciliationTransaction(this.pool, async client => {
      await this.lockClaim(client, claim, now);
      await client.query(`UPDATE inventory.ebay_publication_reconciliation_watches SET lease_expires_at=$2,updated_at=$3 WHERE id=$1`,
        [claim.watchId, new Date(now.getTime() + EBAY_RECONCILIATION_LEASE_MS).toISOString(), now.toISOString()]);
    });
  }

  plan(claim: EbayReconciliationClaim, now: Date): Promise<EbayReconciliationTarget[]> {
    return withReconciliationTransaction(this.pool, async client => {
      await this.lockClaim(client, claim, now);
      return this.currentPlan(client, claim);
    }, true);
  }

  recordStock(claim: EbayReconciliationClaim, observations: readonly EbayReconciliationObservation[], now: Date): Promise<EbayReconciliationStockResult> {
    return withReconciliationTransaction(this.pool, async client => {
      await this.lockClaim(client, claim, now);
      const current = await this.currentPlan(client, claim);
      if (observations.length !== current.length || new Set(observations.map(row => row.target.productVariantId)).size !== current.length)
        throw reconciliationFailure("PUBLICATION_RECONCILIATION_EVIDENCE_INCOMPLETE", "The current stock check is missing an exact listing member.");
      let stable = true;
      const driftIds: string[] = [];
      for (const observation of observations) {
        z.number().int().nonnegative().safe().parse(observation.observedQuantity);
        z.boolean().parse(observation.quantityConsistent);
        z.string().regex(/^[a-f0-9]{64}$/).parse(observation.providerResponseHash); z.date().parse(observation.observedAt);
        const expected = current.find(target => target.productVariantId === observation.target.productVariantId);
        const same = expected !== undefined && expected.outboxId === observation.target.outboxId
          && expected.desiredRevision === observation.target.desiredRevision
          && expected.externalInventoryItemId === observation.target.externalInventoryItemId
          && expected.externalScopeId === observation.target.externalScopeId;
        stable &&= same;
        const matches = observation.quantityConsistent && String(observation.observedQuantity) === observation.target.desiredQuantity;
        const row = (await client.query<{ id: string }>(`INSERT INTO inventory.ebay_publication_reconciliation_observations
          (watch_id,revision,cycle,outbox_id,observed_quantity,matches_desired,current_revision,provider_response_hash,observed_at,quantity_consistent)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id::text`,
        [claim.watchId, claim.revision, claim.cycle, observation.target.outboxId, String(observation.observedQuantity), matches, same,
          observation.providerResponseHash, observation.observedAt.toISOString(), observation.quantityConsistent])).rows[0]!;
        if (!matches && same) driftIds.push(row.id);
      }
      const checkedAt = new Date(Math.min(...observations.map(row => row.observedAt.getTime())));
      if (!stable) return { current: false, repaired: false, checkedAt, outboxIds: [] };
      // A read is never a quantity decision. Reuse the canonical planner/queue,
      // forcing only verified rows whose exact immutable observation proves drift.
      const handedOff = driftIds.length ? await this.currentPlan(client, claim, driftIds) : current;
      return { current: true, repaired: driftIds.length > 0, checkedAt, outboxIds: handedOff.map(row => row.outboxId) };
    }, true);
  }

  async finish(claim: EbayReconciliationClaim, stock: EbayReconciliationStockResult, contentJobId: string, now: Date): Promise<void> {
    z.string().uuid().parse(contentJobId);
    if (!stock.current || stock.outboxIds.length === 0) throw reconciliationFailure("PUBLICATION_RECONCILIATION_EVIDENCE_INCOMPLETE", "A current canonical stock check is required before completing this cycle.");
    await withReconciliationTransaction(this.pool, async client => {
      await this.lockClaim(client, claim, now);
      await client.query(`INSERT INTO inventory.ebay_publication_reconciliation_cycles
        (watch_id,revision,cycle,command_key,content_job_id,stock_state,completed_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [claim.watchId, claim.revision, claim.cycle, ebayReconciliationCommandKey(claim.watchId, claim.cycle), contentJobId,
        stock.repaired ? "repair_queued" : "verified", now.toISOString()]);
      await client.query(`UPDATE inventory.ebay_publication_reconciliation_watches SET cycle=cycle+1,attempts=0,
        state=$2,checked_at=$3,verified_outbox_ids=$4,next_check_at=$5,updated_at=$6,lease_token=NULL,lease_expires_at=NULL,
        last_error_code=$7,last_error_message=$8 WHERE id=$1`, [claim.watchId, stock.repaired ? "pending" : "verified",
        stock.checkedAt.toISOString(), stock.repaired ? [] : stock.outboxIds,
        new Date(now.getTime() + EBAY_RECONCILIATION_INTERVAL_MS).toISOString(), now.toISOString(),
        stock.repaired ? "PUBLICATION_RECONCILIATION_DRIFT" : null,
        stock.repaired ? "The stock check found a different quantity. A current canonical correction is queued; the next check will verify it." : null]);
    });
  }

  async fail(claim: EbayReconciliationClaim, failure: Failure, now: Date): Promise<void> {
    await withReconciliationTransaction(this.pool, async client => {
      // Superseded leases cannot change the newer watch. A stale read did no
      // provider mutation; its replacement cycle remains the durable obligation.
      if (!await this.lockClaim(client, claim, now, false)) return;
      if (failure.commandConsumed) {
        await client.query(`INSERT INTO inventory.ebay_publication_reconciliation_cycles
          (watch_id,revision,cycle,command_key,content_job_id,stock_state,error_code,error_message,completed_at)
          VALUES($1,$2,$3,$4,$5,'blocked',$6,$7,$8)`, [claim.watchId, claim.revision, claim.cycle,
          ebayReconciliationCommandKey(claim.watchId, claim.cycle), failure.contentJobId ?? null, failure.code, failure.message, now.toISOString()]);
      }
      const delay = Math.min(EBAY_RECONCILIATION_INTERVAL_MS, BACKOFF_BASE_MS * 2 ** Math.min(claim.attempts - 1, 4));
      await client.query(`UPDATE inventory.ebay_publication_reconciliation_watches SET cycle=cycle+$2,state=$7,
        next_check_at=$3,last_error_code=$4,last_error_message=$5,updated_at=$6,lease_token=NULL,lease_expires_at=NULL WHERE id=$1`,
      [claim.watchId, failure.commandConsumed ? 1 : 0, new Date(now.getTime() + delay).toISOString(), failure.code, failure.message, now.toISOString(),
        RETRYABLE_RECONCILIATION_CODES.has(failure.code) ? "pending" : "needs_attention"]);
    });
  }

  readStatuses(syncJobIds: readonly string[]): Promise<Record<string, EbayPublicationReconciliationStatus>> {
    const ids = z.array(z.string().uuid()).max(1000).parse(syncJobIds);
    if (ids.length === 0) return Promise.resolve({});
    return withReconciliationTransaction(this.pool, async client => {
      const rows = (await client.query<{ job_id: string; state: EbayPublicationReconciliationStatus["state"]; checked_at: Date | null;
        next_check_at: Date; last_error_code: string | null; last_error_message: string | null; still_current: boolean }>(
        `WITH associations AS (
           SELECT sync_job_id AS job_id,watch_id FROM inventory.ebay_automatic_publication_recoveries WHERE sync_job_id=ANY($1::uuid[])
           UNION SELECT content_job_id AS job_id,watch_id FROM inventory.ebay_publication_reconciliation_cycles WHERE content_job_id=ANY($1::uuid[])
         ) SELECT association.job_id::text,watch.state,watch.checked_at,watch.next_check_at,watch.last_error_code,watch.last_error_message,
          (cardinality(watch.verified_outbox_ids)>0 AND NOT EXISTS(
            SELECT 1 FROM unnest(watch.verified_outbox_ids) saved(outbox_id)
            LEFT JOIN inventory.inventory_publication_outbox o ON o.id=saved.outbox_id
            LEFT JOIN inventory.inventory_publication_targets target ON target.id=o.publication_target_id
            LEFT JOIN inventory.publication_variant_mapping_heads mapping_head
              ON mapping_head.publication_target_id=o.publication_target_id AND mapping_head.product_variant_id=o.product_variant_id
            LEFT JOIN inventory.publication_variant_mapping_versions mapping ON mapping.id=mapping_head.active_mapping_id
            LEFT JOIN inventory.availability_runtime_authority authority ON authority.singleton_key=true
            WHERE o.id IS NULL OR target.state IS DISTINCT FROM 'live' OR target.publication_authority IS DISTINCT FROM 'echelon'
              OR target.revision IS DISTINCT FROM o.publication_target_revision_snapshot OR target.external_scope_id IS DISTINCT FROM o.external_scope_id_snapshot
              OR target.channel_connection_id IS DISTINCT FROM o.channel_connection_id_snapshot
              OR mapping.lifecycle_status IS DISTINCT FROM 'sealed'
              OR mapping.external_inventory_item_id IS DISTINCT FROM o.external_inventory_item_id_snapshot
              OR mapping.external_sku IS DISTINCT FROM o.external_sku_snapshot
              OR authority.authority IS DISTINCT FROM 'canonical' OR authority.activation_run_id IS DISTINCT FROM o.activation_run_id
              OR EXISTS(SELECT 1 FROM inventory.inventory_publication_outbox newer WHERE newer.publication_target_id=o.publication_target_id
                AND newer.product_variant_id=o.product_variant_id AND newer.desired_revision>o.desired_revision))) AS still_current
         FROM associations association JOIN inventory.ebay_publication_reconciliation_watches watch ON watch.id=association.watch_id
         ORDER BY association.job_id,watch.id`, [ids])).rows;
      const statuses: Record<string, EbayPublicationReconciliationStatus> = {};
      const priority = { verified: 0, pending: 1, needs_attention: 2 } as const;
      for (const row of rows) {
        const stale = row.state === "verified" && !row.still_current;
        const retrying = row.state === "needs_attention" && row.last_error_code !== null && RETRYABLE_RECONCILIATION_CODES.has(row.last_error_code);
        const status: EbayPublicationReconciliationStatus = { state: stale || retrying ? "pending" : row.state, checkedAt: row.checked_at?.toISOString() ?? null,
          nextCheckAt: row.next_check_at.toISOString(), code: stale ? "PUBLICATION_RECONCILIATION_PLAN_CHANGED" : row.last_error_code,
          message: stale ? "Current inventory changed after the last stock check. The saved recurring check will verify its new quantity." : row.last_error_message };
        const previous = statuses[row.job_id];
        if (!previous) { statuses[row.job_id] = status; continue; }
        // One saved job may carry multiple exact membership revisions. Keep
        // every obligation visible; ties use the oldest watch's diagnostic.
        const decisive = priority[status.state] > priority[previous.state] ? status : previous;
        statuses[row.job_id] = { ...decisive,
          checkedAt: previous.checkedAt === null || status.checkedAt === null ? null
            : previous.checkedAt < status.checkedAt ? previous.checkedAt : status.checkedAt,
          nextCheckAt: previous.nextCheckAt < status.nextCheckAt ? previous.nextCheckAt : status.nextCheckAt };
      }
      return statuses;
    });
  }

  private async lockClaim(client: PoolClient, claim: EbayReconciliationClaim, now: Date, required = true): Promise<boolean> {
    const row = (await client.query(`SELECT id FROM inventory.ebay_publication_reconciliation_watches
      WHERE id=$1 AND revision=$2 AND cycle=$3 AND lease_token=$4 AND lease_expires_at>$5 FOR UPDATE`,
    [claim.watchId, claim.revision, claim.cycle, claim.leaseToken, now.toISOString()])).rows[0];
    if (!row && required) throw reconciliationFailure("PUBLICATION_RECONCILIATION_LEASE_LOST", "Another worker owns the current stock check. Its saved cycle will continue.");
    return row !== undefined;
  }

  private async currentPlan(client: PoolClient, claim: EbayReconciliationClaim, reconciliationObservationIds: readonly string[] = []): Promise<EbayReconciliationTarget[]> {
    const channels = (await client.query<{ channel_id: number; id: number }>(`SELECT channel_id,id
      FROM inventory.inventory_publication_targets WHERE channel_connection_id=$1 AND external_scope_id=$2
        AND provider_scope_type='account' AND state='live' AND publication_authority='echelon'`,
    [claim.connectionId, claim.accountId])).rows;
    if (channels.length !== 1) throw reconciliationFailure("PUBLICATION_RECONCILIATION_SCOPE_CHANGED",
      "The saved recovery's exact eBay connection is no longer an active canonical publication target.");
    const result = await createTransactionScopedInventoryPublicationService(client, {
      channelId: channels[0]!.channel_id, reconciliationObservationIds,
    }).publishProduct({
      productId: claim.productId, dryRun: false, triggeredBy: "ebay_unknown_request_reconciliation",
      publicationTargetId: channels[0]!.id,
      productVariantIds: [...new Set(claim.scopes.flatMap(scope => scope.productVariantId === null ? [] : [scope.productVariantId]))],
    }, async () => { throw reconciliationFailure("PUBLICATION_AUTHORITY_CHANGED", "This stock check requires the current canonical inventory owner."); });
    if (result.authority !== "canonical") throw reconciliationFailure("PUBLICATION_AUTHORITY_CHANGED", "This stock check requires the current canonical inventory owner.");
    const targets: EbayReconciliationTarget[] = [];
    for (const scope of claim.scopes.filter(scope => scope.productVariantId !== null)) {
      const candidates = result.publication.rows.filter(row => row.productVariantId === scope.productVariantId
        && row.destinationKind === "channel_connection" && row.channelConnectionId === claim.connectionId
        && row.providerKey === "ebay" && row.providerScopeType === "account" && row.externalScopeId === claim.accountId
        && row.externalInventoryItemId === scope.externalInventoryItemId);
      if (candidates.length !== 1) throw reconciliationFailure("PUBLICATION_RECONCILIATION_SCOPE_CHANGED",
        "The saved recovery's exact catalog, eBay account, or SKU mapping is no longer current. Review that listing's inventory connection.");
      const intent = candidates[0]!;
      // Use the publisher's numeric revision selection. A second query previously
      // sorted the text alias and selected revision 9 ahead of 10, stalling recovery.
      const row = (await client.query<{ id: string; desired_revision: string; desired_quantity: string }>(
        LATEST_PUBLICATION_ROW_SQL, [intent.publicationTargetId, intent.productVariantId])).rows[0];
      if (!row || row.desired_quantity !== intent.desiredQuantity) throw reconciliationFailure("PUBLICATION_RECONCILIATION_PLAN_CHANGED", "The canonical stock plan changed before its exact readback could be selected.");
      targets.push({ outboxId: row.id, desiredRevision: row.desired_revision, desiredQuantity: row.desired_quantity,
        publicationTargetId: intent.publicationTargetId, publicationTargetRevision: intent.publicationTargetRevision,
        destination: { kind: "channel_connection", channelConnectionId: claim.connectionId, dropshipStoreConnectionId: null },
        channelId: intent.channelId, providerScopeType: "account", externalScopeId: claim.accountId,
        productVariantId: intent.productVariantId, externalInventoryItemId: intent.externalInventoryItemId, externalSku: intent.externalSku });
    }
    if (targets.length === 0) throw reconciliationFailure("PUBLICATION_RECONCILIATION_SCOPE_CHANGED", "The saved stock check has no exact catalog member.");
    return targets;
  }
}
