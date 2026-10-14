import type { Pool, PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import type { ListingPresence } from "@shared/types/channel-listing-presence";
import {
  assertListingSetupAdmission,
  type ListingSetupIntent,
} from "../../inventory-planning/application/listing-setup-intent";
import {
  readListingPresence,
  recordListingPresence,
} from "./listing-presence.repository";
import {
  listingAccountSchema,
  type ListingAccount,
} from "@shared/types/channel-listing-publication";
import {
  listingLifecycleViewSchema,
  listingLifecycleSkuSchema,
  type ListingLifecycleView,
  type ListingLifecycleCommand,
} from "@shared/types/channel-listing-lifecycle";
import type {
  ListingLifecycleStore,
  ListingLifecycleSession,
  StoredListingLifecycle,
} from "../application/listing-lifecycle-ports";
import {
  listingAccountKey,
  ListingPublicationError,
} from "../domain/listing-publication";

const LOCK_SEED = 2591012;
const RETRY_INTERVAL_MS = 60_000;
interface Row extends QueryResultRow {
  id: string;
  account: unknown;
  sku: string;
  title: string;
  action: string;
  state: string;
  message: string | null;
  requested_by: string;
  requested_at: Date;
  updated_at: Date;
  version: number;
}
function stored(row: Row): StoredListingLifecycle {
  return {
    account: listingAccountSchema.parse(row.account),
    actor: row.requested_by,
    view: listingLifecycleViewSchema.parse({
      id: row.id,
      sku: row.sku,
      title: row.title,
      action: row.action,
      state: row.state,
      message: row.message,
      requestedAt: row.requested_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    }),
  };
}
async function transaction<T>(
  client: PoolClient,
  work: () => Promise<T>,
): Promise<T> {
  await client.query("BEGIN");
  try {
    const result = await work();
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
async function audit(
  client: PoolClient,
  row: Row,
  before: ListingLifecycleView | null,
  actor: string,
  now: Date,
) {
  await client.query(
    `INSERT INTO marketplace.channel_listing_lifecycle_events(listing_id,version,actor,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6)`,
    [row.id, row.version, actor, before, stored(row).view, now],
  );
}

export class PostgresListingLifecycleRepository implements ListingLifecycleStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  private async read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  withListing<T>(
    account: ListingAccount,
    sku: string,
    work: (session: ListingLifecycleSession) => Promise<T>,
  ): Promise<T> {
    return this.withLocks(
      account,
      [listingLifecycleSkuSchema.parse(sku)],
      false,
      work,
    );
  }
  private async withLocks<T>(
    raw: ListingAccount,
    skus: readonly string[],
    shared: boolean,
    work: (session: ListingLifecycleSession, client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const account = listingAccountSchema.parse(raw);
    const key = listingAccountKey(account);
    const client = await this.pool.connect();
    const acquired: string[] = [];
    let discard: Error | undefined;
    try {
      // Shared admission preserves existing concurrency between stock/content
      // writes. An exclusive retirement only blocks this SKU, across connections
      // for the same seller. A feed holds all of its SKU locks until receipt.
      for (const sku of [...new Set(skus)].sort()) {
        const lockKey = JSON.stringify([key, sku]);
        const locked =
          (
            await client.query<{ acquired: boolean }>(
              shared
                ? "SELECT pg_try_advisory_lock_shared(hashtextextended($1,$2)) AS acquired"
                : "SELECT pg_try_advisory_lock(hashtextextended($1,$2)) AS acquired",
              [lockKey, LOCK_SEED],
            )
          ).rows[0]?.acquired === true;
        if (!locked)
          throw new ListingPublicationError(
            "LISTING_LIFECYCLE_BUSY",
            "Another request for this Walmart listing is finishing. Retry shortly.",
            503,
          );
        acquired.push(lockKey);
      }
      return await work(new LifecycleSession(client, account), client);
    } finally {
      for (const lockKey of acquired.reverse()) {
        try {
          const released = (
            await client.query<{ released: boolean }>(
              shared
                ? "SELECT pg_advisory_unlock_shared(hashtextextended($1,$2)) AS released"
                : "SELECT pg_advisory_unlock(hashtextextended($1,$2)) AS released",
              [lockKey, LOCK_SEED],
            )
          ).rows[0]?.released;
          if (!released)
            discard = new Error(
              "Listing lifecycle lock release was not confirmed.",
            );
        } catch (error) {
          discard =
            error instanceof Error
              ? error
              : new Error("Listing lifecycle lock release failed.");
        }
      }
      if (discard)
        console.error(
          JSON.stringify({
            operation: "listing_lifecycle_lock",
            code: "LISTING_LOCK_RELEASE_FAILED",
          }),
        );
      client.release(discard);
    }
  }
  assertNotStopped(account: ListingAccount, sku: string): Promise<void> {
    return this.withLocks(
      account,
      [listingLifecycleSkuSchema.parse(sku)],
      true,
      async (session) => {
        if (await session.find(sku))
          throw new ListingPublicationError(
            "LISTING_PUBLICATION_STOPPED",
            "This listing was unpublished or removed in Echelon.",
          );
      },
    );
  }
  withStockAllowed<T>(
    account: ListingAccount,
    sku: string,
    quantity: number,
    work: () => Promise<T>,
  ): Promise<T> {
    z.number().int().min(0).max(2_147_483_647).parse(quantity);
    if (quantity > 0) return this.withAllowed(account, [sku], work);
    return this.withLocks(
      account,
      [listingLifecycleSkuSchema.parse(sku)],
      true,
      async (_session, client) => {
        if (
          (
            await readListingPresence(client, listingAccountKey(account), [sku])
          ).some((item) => item.state === "missing")
        )
          throw new ListingPublicationError(
            "LISTING_MISSING_ON_PROVIDER",
            "This listing is missing on Walmart. No stock update was sent.",
          );
        // A zero still drains stock for an explicit Echelon unpublish command.
        return work();
      },
    );
  }
  async withAllowed<T>(
    account: ListingAccount,
    input: readonly string[],
    work: () => Promise<T>,
    initialStock?: Readonly<ListingSetupIntent>,
  ): Promise<T> {
    const skus = z.array(listingLifecycleSkuSchema).max(500).parse(input);
    return this.withLocks(account, skus, true, async (session, client) => {
      if (initialStock) {
        assertListingSetupAdmission(initialStock);
        if (
          initialStock.channelId !== account.channelId ||
          initialStock.channelConnectionId !== account.connectionId ||
          initialStock.partnerId !== account.accountId ||
          initialStock.environment !== account.environment ||
          initialStock.shipNodeId !== account.scopeId
        )
          throw new ListingPublicationError(
            "LISTING_STOCK_ACCOUNT_CHANGED",
            "The admitted inventory account changed.",
          );
      }
      for (const sku of new Set(skus))
        if (await session.find(sku)) {
          throw new ListingPublicationError(
            "LISTING_PUBLICATION_STOPPED",
            `Publication is stopped for ${sku}. This listing was unpublished or removed in Echelon.`,
          );
        }
      const missing = await readListingPresence(
        client,
        listingAccountKey(account),
        skus,
      );
      if (
        missing.some(
          (item) =>
            item.state === "missing" &&
            !initialStock?.items.some(
              (member) => member.sku === item.sku && member.recreation,
            ),
        )
      )
        throw new ListingPublicationError(
          "LISTING_MISSING_ON_PROVIDER",
          "This listing is missing on Walmart. Use Recreate on Walmart to publish it again.",
        );
      return work();
    });
  }
  presence(
    account: ListingAccount,
    skus: readonly string[],
  ): Promise<ListingPresence[]> {
    return this.read((client) =>
      readListingPresence(client, listingAccountKey(account), skus),
    );
  }
  observePresence(
    account: ListingAccount,
    sku: string,
    observe: () => Promise<ListingPresence>,
    completingOperationId?: string,
  ): Promise<ListingPresence | null> {
    listingLifecycleSkuSchema.parse(sku);
    return this.withLocks(account, [sku], false, async (session, client) => {
      if (await session.find(sku)) return null; // Explicit operator stops retain authority.
      const known = await client.query<{ channel_product_id: string | null }>(
        `SELECT channel_product_id FROM channels.channel_feeds
          WHERE channel_id=$1 AND channel_sku=$2 AND is_active=1 AND quarantined_at IS NULL`,
        [account.channelId, sku],
      );
      if (!known.rowCount) return null; // Unsubmitted drafts are not deleted listings.
      if (!completingOperationId) {
        if (await session.hasPendingFeed(sku)) return null;
        // A processed feed can still be waiting for first item activation.
        // Its temporary 404 is not evidence of a seller deletion.
        const pending = await client.query(
          `SELECT 1 FROM marketplace.channel_listing_operations o,
            jsonb_array_elements(o.progress->'items') i
            WHERE o.account_key=$1 AND o.state IN ('queued','submitting','processing','needs_reconciliation')
              AND i->>'sku'=$2 AND i->>'state' IN ('queued','processing','accepted','needs_reconciliation') LIMIT 1`,
          [listingAccountKey(account), sku],
        );
        if (pending.rowCount) return null;
      }
      if (completingOperationId) {
        const active = await client.query(
          `SELECT 1 FROM marketplace.channel_listing_operations o,
            jsonb_array_elements(o.progress->'items') i, jsonb_array_elements(o.progress->'batches') b
            WHERE b->>'correlationId'=$1 AND o.account_key=$2 AND o.state IN ('queued','submitting','processing')
              AND i->>'sku'=$3 AND b->'variantIds' @> jsonb_build_array((i->>'variantId')::integer)`,
          [
            z.string().uuid().parse(completingOperationId),
            listingAccountKey(account),
            sku,
          ],
        );
        if (!active.rowCount)
          throw new ListingPublicationError(
            "LISTING_PRESENCE_OPERATION_CHANGED",
            "The listing submission is no longer current.",
          );
      }
      const observed = await observe();
      if (observed.sku !== sku)
        throw new ListingPublicationError(
          "LISTING_PRESENCE_SKU_CHANGED",
          "Walmart returned a different SKU.",
        );
      if (
        observed.state === "present" &&
        known.rows.some(
          (row) =>
            row.channel_product_id &&
            row.channel_product_id !== observed.externalProductId,
        )
      )
        throw new ListingPublicationError(
          "LISTING_PRESENCE_IDENTITY_CHANGED",
          "Walmart returned a different item identity. Reconcile the listing before resuming updates.",
        );
      return recordListingPresence(
        client,
        listingAccountKey(account),
        observed,
      );
    });
  }
  list(
    account: ListingAccount,
    skus: readonly string[],
  ): Promise<ListingLifecycleView[]> {
    return this.read(async (client) =>
      (
        await client.query<Row>(
          `SELECT * FROM marketplace.channel_listing_lifecycle
      WHERE account_key=$1 AND sku=ANY($2::text[]) ORDER BY sku`,
          [listingAccountKey(account), skus],
        )
      ).rows.map((row) => stored(row).view),
    );
  }
  due(now: Date, limit: number): Promise<StoredListingLifecycle[]> {
    return this.read(async (client) =>
      (
        await client.query<Row>(
          `SELECT * FROM marketplace.channel_listing_lifecycle
      WHERE next_attempt_at<=$1 ORDER BY next_attempt_at,id LIMIT $2`,
          [now, limit],
        )
      ).rows.map(stored),
    );
  }
  history(
    account: ListingAccount,
    afterSku: string | null,
    sku: string | null,
    limit: number,
  ): Promise<ListingLifecycleView[]> {
    return this.read(async (client) =>
      (
        await client.query<Row>(
          `SELECT * FROM marketplace.channel_listing_lifecycle
      WHERE account_key=$1 AND ($2::text IS NULL OR sku>$2) AND ($3::text IS NULL OR sku=$3)
      ORDER BY sku LIMIT $4`,
          [listingAccountKey(account), afterSku, sku, limit],
        )
      ).rows.map((row) => stored(row).view),
    );
  }
}

class LifecycleSession implements ListingLifecycleSession {
  private readonly key: string;
  constructor(
    private readonly client: PoolClient,
    private readonly account: ListingAccount,
  ) {
    this.key = listingAccountKey(account);
  }
  async find(sku: string): Promise<StoredListingLifecycle | null> {
    const row = (
      await this.client.query<Row>(
        "SELECT * FROM marketplace.channel_listing_lifecycle WHERE account_key=$1 AND sku=$2",
        [this.key, sku],
      )
    ).rows[0];
    return row ? stored(row) : null;
  }
  async request(
    command: ListingLifecycleCommand,
    title: string,
    actor: string,
    id: string,
    now: Date,
  ) {
    return transaction(this.client, async () => {
      const before = await this.find(command.sku);
      if (
        before &&
        (before.view.action === "remove" ||
          before.view.action === command.action)
      )
        return before;
      const row = before
        ? (
            await this.client.query<Row>(
              `UPDATE marketplace.channel_listing_lifecycle SET action='remove',updated_at=$2,version=version+1 WHERE id=$1 RETURNING *`,
              [before.view.id, now],
            )
          ).rows[0]
        : (
            await this.client.query<Row>(
              `INSERT INTO marketplace.channel_listing_lifecycle
          (id,channel_id,account_key,account,sku,title,action,state,requested_by,requested_at,updated_at,next_attempt_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$9,$9) RETURNING *`,
              [
                id,
                this.account.channelId,
                this.key,
                this.account,
                command.sku,
                title,
                command.action,
                actor,
                now,
              ],
            )
          ).rows[0];
      await audit(this.client, row, before?.view ?? null, actor, now);
      return stored(row);
    });
  }
  async progress(
    record: StoredListingLifecycle,
    state: ListingLifecycleView["state"],
    message: string | null,
    now: Date,
  ) {
    return transaction(this.client, async () => {
      const row = (
        await this.client.query<Row>(
          `UPDATE marketplace.channel_listing_lifecycle SET state=$2,message=$3,updated_at=$4,
        next_attempt_at=$5,version=version+1 WHERE id=$1 AND account_key=$6 RETURNING *`,
          [
            record.view.id,
            state,
            message,
            now,
            state === "retired"
              ? null
              : new Date(now.getTime() + RETRY_INTERVAL_MS),
            this.key,
          ],
        )
      ).rows[0];
      if (!row)
        throw new ListingPublicationError(
          "LISTING_LIFECYCLE_MISSING",
          "Listing lifecycle request disappeared.",
          500,
        );
      await audit(
        this.client,
        row,
        record.view,
        "system:listing-lifecycle",
        now,
      );
      return stored(row);
    });
  }
  async hasPendingFeed(sku: string): Promise<boolean> {
    const result = await this.client.query<{ pending: boolean }>(
      `SELECT EXISTS (
      SELECT 1 FROM marketplace.channel_listing_updates WHERE account_key=$1 AND sku=$2 AND state IN ('sending','processing','uncertain')
      UNION ALL
      SELECT 1 FROM marketplace.channel_listing_operations o,
        jsonb_array_elements(o.progress->'items') i, jsonb_array_elements(o.progress->'batches') b
      WHERE o.account_key=$1 AND i->>'sku'=$2 AND b->>'state' IN ('submitting','processing','needs_reconciliation')
        AND b->'variantIds' @> jsonb_build_array((i->>'variantId')::integer)
    ) AS pending`,
      [this.key, sku],
    );
    return result.rows[0]?.pending === true;
  }
}
