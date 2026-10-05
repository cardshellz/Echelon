import type { Pool, PoolClient, QueryResultRow } from "pg";
import {
  publicationMoneySchema,
  type ListingAccount,
} from "@shared/types/channel-listing-publication";
import {
  listingUpdateChangesSchema,
  type ListingUpdateState,
} from "@shared/types/channel-listing-update";
import type {
  ListingUpdateStore,
  StoredListingUpdate,
} from "../application/listing-update-ports";
import {
  listingUpdateIntentSchema,
  storedListingUpdateSchema,
  assertUpdateReview,
} from "../domain/listing-update";
import {
  ListingPublicationError,
  listingAccountKey,
} from "../domain/listing-publication";

const LEASE_MS = 120_000;
const POLL_MS = 60_000;
interface Row extends QueryResultRow {
  id: string;
  channel_id: number;
  intent: unknown;
  state: string;
  review_hash: string;
  command_key: string | null;
  submission_id: string | null;
  message: string | null;
  version: number;
  lease_token: string | null;
  lease_until: Date | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date;
}
function record(row: Row): StoredListingUpdate {
  const intent = listingUpdateIntentSchema.parse(row.intent);
  return storedListingUpdateSchema.parse({
    intent,
    version: row.version,
    leaseToken: row.lease_token,
    commandKey: row.command_key,
    view: {
      id: row.id,
      sku: intent.source.sku,
      title: intent.command.changes.title ?? intent.source.title,
      state: row.state,
      reviewHash: row.review_hash,
      productType: intent.command.productType,
      changes: intent.command.changes,
      issues: intent.prepared.issues,
      submissionId: row.submission_id,
      message: row.message,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    },
  });
}
function missing(): never {
  throw new ListingPublicationError(
    "LISTING_UPDATE_MISSING",
    "Listing update not found",
    404,
  );
}
function leaseLost(): never {
  throw new ListingPublicationError(
    "LISTING_UPDATE_LEASE_LOST",
    "Another worker owns this listing update",
  );
}
async function event(
  client: PoolClient,
  row: Row,
  actor: string,
  action: string,
  before: unknown,
  now: Date,
) {
  await client.query(
    `INSERT INTO marketplace.channel_listing_update_events(update_id,version,actor,action,before_state,after_state,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [
      row.id,
      row.version,
      actor,
      action,
      before === null ? null : JSON.stringify(before),
      JSON.stringify(record(row).view),
      now,
    ],
  );
}

export class PostgresListingUpdateRepository implements ListingUpdateStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}
  private async read<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }
  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.read(async (client) => {
      await client.query("BEGIN");
      try {
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    });
  }
  async insert(input: StoredListingUpdate, actor: string): Promise<void> {
    const value = storedListingUpdateSchema.parse(input);
    await this.transaction(async (client) => {
      const row = (
        await client.query<Row>(
          `INSERT INTO marketplace.channel_listing_updates
        (id,channel_id,account_key,sku,review_hash,intent,state,created_by,created_at,updated_at,expires_at,next_attempt_at)
        VALUES($1,$2,$3,$4,$5,$6,'reviewed',$7,$8,$8,$9,$8) RETURNING *`,
          [
            value.view.id,
            value.intent.account.channelId,
            listingAccountKey(value.intent.account),
            value.view.sku,
            value.view.reviewHash,
            JSON.stringify(value.intent),
            actor,
            value.view.createdAt,
            value.view.expiresAt,
          ],
        )
      ).rows[0];
      await event(
        client,
        row,
        actor,
        "reviewed",
        null,
        new Date(value.view.createdAt),
      );
    });
  }
  async get(channelId: number, id: string) {
    return this.read(async (client) => {
      const row = (
        await client.query<Row>(
          "SELECT * FROM marketplace.channel_listing_updates WHERE channel_id=$1 AND id=$2",
          [channelId, id],
        )
      ).rows[0];
      return row ? record(row) : missing();
    });
  }
  async list(channelId: number, sku?: string, accountKey?: string) {
    return this.read(async (client) =>
      (
        await client.query<Row>(
          `SELECT * FROM marketplace.channel_listing_updates
      WHERE channel_id=$1 AND ($2::text IS NULL OR sku=$2) AND ($3::text IS NULL OR account_key=$3)
        AND state<>'reviewed' ORDER BY created_at DESC,id DESC LIMIT 50`,
          [channelId, sku ?? null, accountKey ?? null],
        )
      ).rows.map(record),
    );
  }
  async lastSubmitted(
    account: ListingAccount,
    sku: string,
    externalProductId: string,
  ) {
    return this.read(async (client) => {
      // A receipt and matching product identity distinguish submitted values from abandoned reviews.
      const row = (
        await client.query<{ payload: Record<string, unknown> }>(
          `SELECT p->'payload' AS payload
        FROM marketplace.channel_listing_operations o CROSS JOIN LATERAL jsonb_array_elements(o.snapshot->'prepared') p
        WHERE o.channel_id=$1 AND o.account_key=$4 AND p->>'sku'=$2 AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(o.progress->'items') i WHERE i->>'sku'=$2 AND i->>'externalProductId'=$3
          AND i->>'state' IN ('accepted','verified'))
        ORDER BY o.created_at DESC,o.id DESC LIMIT 1`,
          [
            account.channelId,
            sku,
            externalProductId,
            listingAccountKey(account),
          ],
        )
      ).rows[0];
      let productType = "";
      let base: Record<string, unknown> = {};
      if (row?.payload) {
        const visible = asObject(row.payload.Visible);
        productType = Object.keys(visible)[0] ?? "";
        const fields = asObject(visible[productType]);
        const orderable = asObject(row.payload.Orderable);
        const {
          productName,
          shortDescription,
          brand,
          mainImageUrl,
          productSecondaryImageURL,
          ...attributes
        } = fields;
        const {
          sku: _sku,
          specProductType: _type,
          inventory: _inventory,
          price: _price,
          productIdentifiers: _ids,
          ...offer
        } = orderable;
        base = {
          ...(typeof productName === "string" ? { title: productName } : {}),
          ...(typeof shortDescription === "string"
            ? { description: shortDescription }
            : {}),
          ...(typeof brand === "string" ? { brand } : {}),
          ...(typeof mainImageUrl === "string"
            ? {
                images: [
                  mainImageUrl,
                  ...(Array.isArray(productSecondaryImageURL)
                    ? productSecondaryImageURL
                    : []),
                ],
              }
            : {}),
          attributes: { Orderable: offer, Visible: attributes },
        };
      }
      const updates = (
        await client.query<Row>(
          `SELECT * FROM marketplace.channel_listing_updates
        WHERE channel_id=$1 AND sku=$2 AND intent->'source'->>'externalProductId'=$3 AND state='accepted' AND account_key=$4
        ORDER BY updated_at DESC,id DESC LIMIT 101`,
          [
            account.channelId,
            sku,
            externalProductId,
            listingAccountKey(account),
          ],
        )
      ).rows;
      // Bound history reads. Do not use creation values as a fallback when an older
      // edit may have replaced them outside this retained window.
      if (updates.length > 100) base = {};
      for (const update of updates.slice(0, 100).reverse()) {
        const item = record(update);
        const priorAttributes = asObject(base.attributes);
        const changes = item.intent.command.changes;
        if (productType !== item.view.productType) priorAttributes.Visible = {};
        productType = item.view.productType;
        base = {
          ...base,
          ...changes,
          attributes: {
            Orderable: {
              ...asObject(priorAttributes.Orderable),
              ...changes.attributes?.Orderable,
            },
            Visible: {
              ...asObject(priorAttributes.Visible),
              ...changes.attributes?.Visible,
            },
          },
        };
      }
      const parsed = listingUpdateChangesSchema.safeParse(base);
      return productType && parsed.success
        ? { productType, changes: parsed.data }
        : null;
    });
  }
  async acceptedPrice(
    account: ListingAccount,
    sku: string,
    externalProductId: string,
    since: Date,
  ): Promise<number | null> {
    return this.read(async (client) => {
      const row = (
        await client.query<{ price: unknown }>(
          `SELECT intent->'command'->'changes'->'priceCents' AS price
        FROM marketplace.channel_listing_updates WHERE account_key=$1 AND sku=$2
          AND intent->'source'->>'externalProductId'=$3 AND created_at >= $4 AND state='accepted'
          AND intent->'command'->'changes' ? 'priceCents'
        ORDER BY updated_at DESC,id DESC LIMIT 1`,
          [listingAccountKey(account), sku, externalProductId, since],
        )
      ).rows[0];
      return row ? publicationMoneySchema.parse(row.price) : null;
    });
  }
  async queue(
    expected: StoredListingUpdate,
    commandKey: string,
    actor: string,
    now: Date,
  ) {
    try {
      return await this.transaction(async (client) => {
        const row = (
          await client.query<Row>(
            "SELECT * FROM marketplace.channel_listing_updates WHERE id=$1 AND channel_id=$2 FOR UPDATE",
            [expected.view.id, expected.intent.account.channelId],
          )
        ).rows[0];
        if (!row) missing();
        const current = record(row);
        if (current.commandKey === commandKey) return current;
        assertUpdateReview(current, now);
        if (
          current.version !== expected.version ||
          current.view.reviewHash !== expected.view.reviewHash
        )
          throw new ListingPublicationError(
            "LISTING_UPDATE_STALE",
            "These changes were updated. Review again.",
          );
        const next = (
          await client.query<Row>(
            `UPDATE marketplace.channel_listing_updates SET state='queued',command_key=$2,
          version=version+1,updated_at=$3,next_attempt_at=$3 WHERE id=$1 RETURNING *`,
            [row.id, commandKey, now],
          )
        ).rows[0];
        await event(client, next, actor, "queued", current.view, now);
        return record(next);
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      )
        throw new ListingPublicationError(
          "LISTING_UPDATE_PENDING",
          "Another update for this listing is already in progress. Check its status before sending more changes.",
        );
      throw error;
    }
  }
  async claim(leaseToken: string, now: Date, id?: string) {
    return this.transaction(async (client) => {
      const row = (
        await client.query<Row>(
          `SELECT * FROM marketplace.channel_listing_updates
        WHERE state IN ('queued','sending','processing') AND next_attempt_at<=$1 AND (lease_until IS NULL OR lease_until<=$1)
          AND ($2::uuid IS NULL OR id=$2)
        ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1`,
          [now, id ?? null],
        )
      ).rows[0];
      if (!row) return null;
      const uncertain = row.state === "sending";
      const next = (
        await client.query<Row>(
          `UPDATE marketplace.channel_listing_updates SET state=$2,lease_token=$3,lease_until=$4,
        message=CASE WHEN $5 THEN 'The previous attempt may have reached Walmart. Check Seller Center before sending more changes.' ELSE message END,
        version=version+1,updated_at=$6 WHERE id=$1 RETURNING *`,
          [
            row.id,
            uncertain ? "uncertain" : row.state,
            uncertain ? null : leaseToken,
            uncertain ? null : new Date(now.getTime() + LEASE_MS),
            uncertain,
            now,
          ],
        )
      ).rows[0];
      await event(
        client,
        next,
        "listing-update-worker",
        "claimed",
        record(row).view,
        now,
      );
      return record(next);
    });
  }
  async renew(value: StoredListingUpdate, now: Date) {
    await this.read(async (client) => {
      const result = await client.query(
        `UPDATE marketplace.channel_listing_updates SET lease_until=$5
        WHERE id=$1 AND version=$2 AND lease_token=$3 AND lease_until>$4`,
        [
          value.view.id,
          value.version,
          value.leaseToken,
          now,
          new Date(now.getTime() + LEASE_MS),
        ],
      );
      if (result.rowCount !== 1) leaseLost();
    });
  }
  async progress(
    value: StoredListingUpdate,
    state: ListingUpdateState,
    submissionId: string | null,
    message: string | null,
    now: Date,
    release: boolean,
  ) {
    return this.transaction(async (client) => {
      const row = (
        await client.query<Row>(
          `UPDATE marketplace.channel_listing_updates SET state=$4,submission_id=$5,message=$6,
        version=version+1,updated_at=$7,next_attempt_at=$8,lease_token=CASE WHEN $9 THEN NULL ELSE lease_token END,
        lease_until=CASE WHEN $9 THEN NULL ELSE $10::timestamptz END
        WHERE id=$1 AND version=$2 AND lease_token=$3 AND lease_until>$7 RETURNING *`,
          [
            value.view.id,
            value.version,
            value.leaseToken,
            state,
            submissionId,
            message?.slice(0, 2_000) ?? null,
            now,
            new Date(now.getTime() + POLL_MS),
            release,
            new Date(now.getTime() + LEASE_MS),
          ],
        )
      ).rows[0];
      if (!row) leaseLost();
      await event(
        client,
        row,
        "listing-update-worker",
        "progress",
        value.view,
        now,
      );
      return record(row);
    });
  }
  async refresh(channelId: number, id: string, actor: string, now: Date) {
    return this.transaction(async (client) => {
      const row = (
        await client.query<Row>(
          "SELECT * FROM marketplace.channel_listing_updates WHERE id=$1 AND channel_id=$2 FOR UPDATE",
          [id, channelId],
        )
      ).rows[0];
      if (!row) missing();
      if (
        row.state !== "processing" ||
        (row.lease_until && row.lease_until > now)
      )
        return record(row);
      const next = (
        await client.query<Row>(
          `UPDATE marketplace.channel_listing_updates SET next_attempt_at=$2,updated_at=$2,version=version+1 WHERE id=$1 RETURNING *`,
          [id, now],
        )
      ).rows[0];
      await event(
        client,
        next,
        actor,
        "status_check_requested",
        record(row).view,
        now,
      );
      return record(next);
    });
  }
}
function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
