import type { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import {
  listingDraftSchema,
  type ListingAccount,
  type ListingDraft,
} from "@shared/types/channel-listing-publication";
import { VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE } from "@shared/catalog/variant-sales-eligibility";
import type { ListingPublicationStore } from "../application/listing-publication-store.port";
import {
  ListingPublicationError,
  listingAccountKey,
  listingProgressSchema,
  listingSnapshotSchema,
  summarizeListingProgress,
  type ListingProgress,
  type ListingSnapshot,
  type StoredListingOperation,
} from "../domain/listing-publication";

const LEASE_MILLISECONDS = 5 * 60_000;
interface OperationRow extends QueryResultRow {
  id: string;
  channel_id: number;
  version: number;
  lease_token: string | null;
  state: StoredListingOperation["state"];
  snapshot: unknown;
  progress: unknown;
  created_at: Date;
  updated_at: Date;
}
function operationRow(row: OperationRow): StoredListingOperation {
  return {
    id: row.id,
    channelId: row.channel_id,
    version: row.version,
    leaseToken: row.lease_token,
    state: row.state,
    snapshot: listingSnapshotSchema.parse(row.snapshot),
    progress: listingProgressSchema.parse(row.progress),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}
/** Owns only marketplace draft/operation/evidence persistence; external I/O stays outside transactions. */
export class PostgresListingPublicationRepository
  implements ListingPublicationStore
{
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  async draft(channelId: number): Promise<ListingDraft> {
    const row = (
      await this.query(
        "SELECT revision,items,updated_at FROM marketplace.channel_listing_drafts WHERE channel_id=$1",
        [channelId],
      )
    ).rows[0];
    return listingDraftSchema.parse({
      channelId,
      revision: row?.revision ?? 0,
      items: row?.items ?? [],
      updatedAt: row ? new Date(row.updated_at).toISOString() : null,
    });
  }
  async saveDraft(
    account: ListingAccount,
    draft: ListingDraft,
    actor: string,
    now: Date,
  ): Promise<ListingDraft> {
    return this.transaction(async (client) => {
      await lockAccount(client, account);
      const prior = (
        await client.query(
          "SELECT * FROM marketplace.channel_listing_drafts WHERE channel_id=$1 FOR UPDATE",
          [account.channelId],
        )
      ).rows[0];
      if (
        (prior?.revision ?? 0) !== draft.revision ||
        (prior && prior.account_key !== listingAccountKey(account))
      )
        stale();
      await lockVariants(
        client,
        draft.items.map((item) => item.variantId),
      );
      const next = {
        ...draft,
        revision: draft.revision + 1,
        updatedAt: now.toISOString(),
      };
      await client.query(
        `INSERT INTO marketplace.channel_listing_drafts(channel_id,account_key,revision,items,updated_by,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(channel_id) DO UPDATE SET revision=EXCLUDED.revision,items=EXCLUDED.items,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
        [
          account.channelId,
          listingAccountKey(account),
          next.revision,
          JSON.stringify(next.items),
          actor,
          now,
        ],
      );
      await event(
        client,
        account.channelId,
        null,
        null,
        "draft_saved",
        actor,
        prior?.items ?? null,
        next.items,
        now,
      );
      return next;
    });
  }
  async saveReview(
    snapshot: ListingSnapshot,
    actor: string,
    now: Date,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await lockAccount(client, snapshot.account);
      const draft = (
        await client.query(
          "SELECT revision FROM marketplace.channel_listing_drafts WHERE channel_id=$1 FOR SHARE",
          [snapshot.account.channelId],
        )
      ).rows[0];
      if (!draft || draft.revision !== snapshot.draft.revision) stale();
      await client.query(
        `INSERT INTO marketplace.channel_listing_reviews(id,channel_id,draft_revision,review_hash,snapshot,created_by,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          snapshot.review.id,
          snapshot.account.channelId,
          snapshot.draft.revision,
          snapshot.review.reviewHash,
          JSON.stringify(snapshot),
          actor,
          now,
          snapshot.review.expiresAt,
        ],
      );
      await event(
        client,
        snapshot.account.channelId,
        null,
        null,
        "review_created",
        actor,
        null,
        {
          reviewId: snapshot.review.id,
          hash: snapshot.review.reviewHash,
          canSubmit: snapshot.review.canSubmit,
        },
        now,
      );
    });
  }
  async review(channelId: number, reviewId: string): Promise<ListingSnapshot> {
    const row = (
      await this.query(
        "SELECT snapshot FROM marketplace.channel_listing_reviews WHERE id=$1 AND channel_id=$2",
        [reviewId, channelId],
      )
    ).rows[0];
    if (!row)
      throw new ListingPublicationError(
        "LISTING_REVIEW_MISSING",
        "Listing review not found",
        404,
      );
    return listingSnapshotSchema.parse(row.snapshot);
  }
  async replay(
    channelId: number,
    commandKey: string,
    requestHash: string,
  ): Promise<StoredListingOperation | null> {
    return this.read((client) =>
      replay(client, channelId, commandKey, requestHash),
    );
  }
  async createOperation(input: {
    id: string;
    snapshot: ListingSnapshot;
    progress: ListingProgress;
    commandKey: string;
    requestHash: string;
    actor: string;
    now: Date;
  }): Promise<StoredListingOperation> {
    return this.transaction(async (client) => {
      const { snapshot, now } = input;
      await lockAccount(client, snapshot.account);
      const repeated = await replay(
        client,
        snapshot.account.channelId,
        input.commandKey,
        input.requestHash,
      );
      if (repeated) return repeated;
      const reviewed = (
        await client.query(
          "SELECT * FROM marketplace.channel_listing_reviews WHERE id=$1 AND channel_id=$2 FOR SHARE",
          [snapshot.review.id, snapshot.account.channelId],
        )
      ).rows[0];
      const draft = (
        await client.query(
          "SELECT revision FROM marketplace.channel_listing_drafts WHERE channel_id=$1 FOR SHARE",
          [snapshot.account.channelId],
        )
      ).rows[0];
      if (
        !reviewed ||
        reviewed.review_hash !== snapshot.review.reviewHash ||
        new Date(reviewed.expires_at) <= now ||
        draft?.revision !== snapshot.draft.revision
      )
        stale();
      if (!snapshot.review.canSubmit || snapshot.prepared.length === 0)
        throw new ListingPublicationError(
          "LISTING_REVIEW_BLOCKED",
          "Resolve all review blockers before publishing",
        );
      await lockVariants(
        client,
        snapshot.prepared.map((item) => item.variantId),
      );
      const existing = (
        await client.query(
          "SELECT id FROM marketplace.channel_listing_operations WHERE review_id=$1",
          [snapshot.review.id],
        )
      ).rows[0];
      if (existing)
        throw new ListingPublicationError(
          "LISTING_REVIEW_USED",
          "This review already has a publication operation",
        );
      const row = (
        await client.query<OperationRow>(
          `INSERT INTO marketplace.channel_listing_operations(id,channel_id,account_key,command_key,request_hash,review_id,state,snapshot,progress,next_attempt_at,created_by,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,'queued',$7,$8,$9,$10,$9,$9) RETURNING *`,
          [
            input.id,
            snapshot.account.channelId,
            listingAccountKey(snapshot.account),
            input.commandKey,
            input.requestHash,
            snapshot.review.id,
            JSON.stringify(snapshot),
            JSON.stringify(input.progress),
            now,
            input.actor,
          ],
        )
      ).rows[0];
      for (const item of snapshot.prepared) {
        const claimed = await client.query(
          `INSERT INTO marketplace.channel_listing_item_claims(account_key,external_sku,channel_id,product_variant_id,operation_id,created_at)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING operation_id`,
          [
            listingAccountKey(snapshot.account),
            item.sku,
            snapshot.account.channelId,
            item.variantId,
            input.id,
            now,
          ],
        );
        if (claimed.rowCount !== 1) {
          const prior = (
            await client.query<
              OperationRow & {
                external_sku: string;
                product_variant_id: number;
              }
            >(
              `SELECT o.*,c.external_sku,c.product_variant_id
            FROM marketplace.channel_listing_item_claims c JOIN marketplace.channel_listing_operations o ON o.id=c.operation_id
            WHERE c.account_key=$1 AND c.external_sku=$2 AND c.channel_id=$3 AND c.product_variant_id=$4
              AND (o.lease_until IS NULL OR o.lease_until <= $5) FOR UPDATE OF c,o`,
              [
                listingAccountKey(snapshot.account),
                item.sku,
                snapshot.account.channelId,
                item.variantId,
                now,
              ],
            )
          ).rows[0];
          const previous = prior ? operationRow(prior) : null;
          if (
            !previous?.progress.items.some(
              (candidate) =>
                candidate.variantId === item.variantId &&
                candidate.sku === item.sku &&
                candidate.state === "needs_attention" &&
                candidate.canRetry,
            ) ||
            !previous.progress.batches.some(
              (batch) =>
                batch.variantIds.includes(item.variantId) &&
                batch.state === "processed",
            )
          ) {
            throw new ListingPublicationError(
              "LISTING_ITEM_ALREADY_MANAGED",
              "A selected SKU already belongs to a publication operation; open its activity instead",
            );
          }
          await client.query(
            `UPDATE marketplace.channel_listing_item_claims SET operation_id=$3 WHERE account_key=$1 AND external_sku=$2`,
            [listingAccountKey(snapshot.account), item.sku, input.id],
          );
          await event(
            client,
            snapshot.account.channelId,
            null,
            null,
            "rejected_item_reclaimed",
            input.actor,
            {
              operationId: previous.id,
              sku: item.sku,
              variantId: item.variantId,
            },
            { operationId: input.id, reviewId: snapshot.review.id },
            now,
          );
        }
      }
      // Consume the reviewed selection with the command, so a second batch never
      // depends on a browser cleanup request succeeding after publication starts.
      await client.query(
        "UPDATE marketplace.channel_listing_drafts SET revision=revision+1,items='[]'::jsonb,updated_by=$2,updated_at=$3 WHERE channel_id=$1",
        [snapshot.account.channelId, input.actor, now],
      );
      await event(
        client,
        snapshot.account.channelId,
        null,
        null,
        "draft_submitted",
        input.actor,
        snapshot.draft.items,
        {
          items: [],
          operationId: input.id,
          revision: snapshot.draft.revision + 1,
        },
        now,
      );
      await event(
        client,
        snapshot.account.channelId,
        input.id,
        1,
        "publication_queued",
        input.actor,
        null,
        input.progress,
        now,
      );
      return operationRow(row);
    });
  }
  async operations(channelId: number): Promise<StoredListingOperation[]> {
    return (
      await this.query<OperationRow>(
        "SELECT * FROM marketplace.channel_listing_operations WHERE channel_id=$1 ORDER BY created_at DESC,id LIMIT 50",
        [channelId],
      )
    ).rows.map(operationRow);
  }
  async operation(
    channelId: number,
    id: string,
  ): Promise<StoredListingOperation> {
    const row = (
      await this.query<OperationRow>(
        "SELECT * FROM marketplace.channel_listing_operations WHERE channel_id=$1 AND id=$2",
        [channelId, id],
      )
    ).rows[0];
    if (!row)
      throw new ListingPublicationError(
        "LISTING_OPERATION_MISSING",
        "Listing operation not found",
        404,
      );
    return operationRow(row);
  }
  async claim(
    now: Date,
    leaseToken: string,
  ): Promise<StoredListingOperation | null> {
    return this.transaction(async (client) => {
      const row = (
        await client.query<OperationRow>(
          `SELECT * FROM marketplace.channel_listing_operations
        WHERE state IN ('queued','submitting','processing') AND next_attempt_at <= $1 AND (lease_until IS NULL OR lease_until <= $1)
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [now],
        )
      ).rows[0];
      if (!row) return null;
      const operation = operationRow(row);
      const progress = structuredClone(operation.progress);
      // A lost worker may have sent the feed. Never reclaim it as an unsent job.
      for (const batch of progress.batches)
        if (batch.state === "submitting") {
          batch.state = "needs_reconciliation";
          for (const item of progress.items)
            if (batch.variantIds.includes(item.variantId)) {
              item.state = "needs_reconciliation";
              item.canRetry = false;
              item.error =
                "Submission outcome is uncertain; reconcile before another write.";
            }
        }
      if (
        progress.batches.some((batch) => batch.state === "needs_reconciliation")
      )
        progress.error =
          "Submission outcome is uncertain; reconcile provider state before another write.";
      const updated = (
        await client.query<OperationRow>(
          `UPDATE marketplace.channel_listing_operations SET state=$2,progress=$3,
        lease_token=$4,lease_until=$5,version=version+1,updated_at=$6 WHERE id=$1 RETURNING *`,
          [
            row.id,
            summarizeListingProgress(progress),
            JSON.stringify(progress),
            leaseToken,
            new Date(now.getTime() + LEASE_MILLISECONDS),
            now,
          ],
        )
      ).rows[0];
      await event(
        client,
        row.channel_id,
        row.id,
        updated.version,
        "worker_claimed",
        "listing-publication-worker",
        operation.progress,
        progress,
        now,
      );
      return operationRow(updated);
    });
  }
  /** Lease metadata is ephemeral coordination, not a publication state transition. */
  async renewLease(
    operation: StoredListingOperation,
    now: Date,
  ): Promise<void> {
    const result = await this.query(
      `UPDATE marketplace.channel_listing_operations SET lease_until=$5
      WHERE id=$1 AND version=$2 AND lease_token=$3 AND lease_until>$4`,
      [
        operation.id,
        operation.version,
        operation.leaseToken,
        now,
        new Date(now.getTime() + LEASE_MILLISECONDS),
      ],
    );
    if (result.rowCount !== 1)
      throw new ListingPublicationError(
        "LISTING_LEASE_LOST",
        "The listing worker no longer owns this operation",
      );
  }
  async saveProgress(
    operation: StoredListingOperation,
    progress: ListingProgress,
    input: {
      now: Date;
      nextAttemptAt: Date;
      releaseLease: boolean;
      actor: string;
    },
  ): Promise<StoredListingOperation> {
    return this.transaction(async (client) => {
      const row = (
        await client.query<OperationRow>(
          `UPDATE marketplace.channel_listing_operations SET progress=$4,state=$5,version=version+1,
        updated_at=$6,next_attempt_at=$7,lease_token=CASE WHEN $8 THEN NULL ELSE lease_token END,
        lease_until=CASE WHEN $8 THEN NULL ELSE $9::timestamptz END
        WHERE id=$1 AND version=$2 AND lease_token=$3 AND lease_until>$6 RETURNING *`,
          [
            operation.id,
            operation.version,
            operation.leaseToken,
            JSON.stringify(listingProgressSchema.parse(progress)),
            summarizeListingProgress(progress),
            input.now,
            input.nextAttemptAt,
            input.releaseLease,
            new Date(input.now.getTime() + LEASE_MILLISECONDS),
          ],
        )
      ).rows[0];
      if (!row)
        throw new ListingPublicationError(
          "LISTING_LEASE_LOST",
          "The listing worker no longer owns this operation",
        );
      await event(
        client,
        row.channel_id,
        row.id,
        row.version,
        "publication_progress",
        input.actor,
        operation.progress,
        progress,
        input.now,
      );
      return operationRow(row);
    });
  }
  async requestReconciliation(
    channelId: number,
    id: string,
    actor: string,
    now: Date,
  ): Promise<StoredListingOperation> {
    return this.transaction(async (client) => {
      const row = (
        await client.query<OperationRow>(
          "SELECT * FROM marketplace.channel_listing_operations WHERE id=$1 AND channel_id=$2 FOR UPDATE",
          [id, channelId],
        )
      ).rows[0];
      if (!row)
        throw new ListingPublicationError(
          "LISTING_OPERATION_MISSING",
          "Listing operation not found",
          404,
        );
      const lease = (
        await client.query(
          "SELECT lease_until FROM marketplace.channel_listing_operations WHERE id=$1",
          [id],
        )
      ).rows[0].lease_until;
      if (lease && new Date(lease) > now) return operationRow(row);
      // Reconciliation only schedules observations. It never changes a batch back to queued.
      const updated = (
        await client.query<OperationRow>(
          `UPDATE marketplace.channel_listing_operations SET state='processing',lease_token=NULL,lease_until=NULL,
        next_attempt_at=$2,updated_at=$2,version=version+1 WHERE id=$1 RETURNING *`,
          [id, now],
        )
      ).rows[0];
      await event(
        client,
        channelId,
        id,
        updated.version,
        "reconciliation_requested",
        actor,
        { state: row.state },
        { state: "processing" },
        now,
      );
      return operationRow(updated);
    });
  }
  private async read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  private query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>> {
    return this.read((client) => client.query<R>(text, values));
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
async function replay(
  client: Pick<Pool, "query"> | PoolClient,
  channelId: number,
  commandKey: string,
  hash: string,
): Promise<StoredListingOperation | null> {
  const row = (
    await client.query<OperationRow & { request_hash: string }>(
      "SELECT * FROM marketplace.channel_listing_operations WHERE channel_id=$1 AND command_key=$2",
      [channelId, commandKey],
    )
  ).rows[0];
  if (row && row.request_hash !== hash)
    throw new ListingPublicationError(
      "LISTING_COMMAND_CONFLICT",
      "This command key was already used for a different review",
    );
  return row ? operationRow(row) : null;
}
async function lockAccount(
  client: PoolClient,
  account: ListingAccount,
): Promise<void> {
  const channel = (
    await client.query(
      "SELECT id,provider FROM channels.channels WHERE id=$1 FOR UPDATE",
      [account.channelId],
    )
  ).rows[0];
  const connection = (
    await client.query(
      "SELECT id FROM channels.channel_connections WHERE id=$1 AND channel_id=$2 FOR SHARE",
      [account.connectionId, account.channelId],
    )
  ).rows[0];
  if (!channel || channel.provider !== account.provider || !connection)
    throw new ListingPublicationError(
      "LISTING_ACCOUNT_CHANGED",
      "The channel account changed; refresh and review again",
    );
}
async function lockVariants(client: PoolClient, ids: number[]): Promise<void> {
  for (const id of [...new Set(ids)].sort((a, b) => a - b))
    await client.query("SELECT pg_advisory_xact_lock($1::int,$2::int)", [
      VARIANT_SALES_ELIGIBILITY_LOCK_NAMESPACE,
      id,
    ]);
  const rows = (
    await client.query(
      `SELECT v.id FROM catalog.product_variants v JOIN catalog.products p ON p.id=v.product_id
    WHERE v.id=ANY($1::int[]) AND v.is_active AND p.is_active AND p.status='active' AND v.sales_eligibility='sellable' AND v.requires_shipping AND v.track_inventory IS TRUE FOR SHARE OF v,p`,
      [ids],
    )
  ).rows;
  if (rows.length !== ids.length)
    throw new ListingPublicationError(
      "LISTING_VARIANT_UNAVAILABLE",
      "A selected variant is no longer available for marketplace fulfillment",
    );
}
async function event(
  client: PoolClient,
  channelId: number,
  operationId: string | null,
  version: number | null,
  action: string,
  actor: string,
  before: unknown,
  after: unknown,
  now: Date,
): Promise<void> {
  await client.query(
    `INSERT INTO marketplace.channel_listing_publication_events(channel_id,operation_id,operation_version,action,actor,before_state,after_state,occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      channelId,
      operationId,
      version,
      action,
      actor,
      JSON.stringify(before),
      JSON.stringify(after),
      now,
    ],
  );
}
function stale(): never {
  throw new ListingPublicationError(
    "LISTING_REVIEW_STALE",
    "The saved draft or review changed; reload and review the exact selection again",
  );
}
