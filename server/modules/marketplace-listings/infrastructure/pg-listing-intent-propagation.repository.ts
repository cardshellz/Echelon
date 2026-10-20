import {
  listingIntentChangePageSchema,
  type ListingIntentChangePage,
} from "../../../../shared/listing-intent-propagation";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import type { ListingIntentPropagationStore } from "../application/listing-intent-propagation.service";
import {
  intentCommandKey,
  intentDestinationSchema,
  intentSelectors,
  type IntentChange,
  type IntentDelivery,
  type IntentHandoff,
  type IntentSelector,
} from "../domain/listing-intent-propagation";

const RETRY_ALLOWED = `state='blocked'
  AND destination->>'accountId' IS NOT NULL
  AND (destination->>'ambiguousConnection')::boolean=false
  AND last_error_code NOT IN ('LISTING_INTENT_ACCOUNT_UNRESOLVED','LISTING_INTENT_RECEIPT_SCOPE_CONFLICT',
    'EBAY_SYNC_IDENTITY_CHANGED','DROPSHIP_LISTING_ACCOUNT_CHANGED','DROPSHIP_LISTING_MANAGED_SCOPE_CHANGED','DROPSHIP_IDEMPOTENCY_CONFLICT')`;
const FANOUT_PAGE_SIZE = 100;
const LEASE_MS = 300_000;
interface ChangeRow {
  id: string;
  source_relation: string;
  source_kind: string;
  changed_fields: string[];
  operation: IntentChange["operation"];
  before_scope: Record<string, unknown> | null;
  after_scope: Record<string, unknown> | null;
  cursor_key: string;
  source_transaction: string;
}
function changeFrom(row: ChangeRow): IntentChange {
  return {
    id: row.id,
    sourceRelation: row.source_relation,
    sourceKind: row.source_kind,
    changedFields: row.changed_fields,
    operation: row.operation,
    beforeScope: row.before_scope,
    afterScope: row.after_scope,
  };
}
interface DeliveryRow extends ChangeRow {
  delivery_id: string;
  change_id: string;
  destination: unknown;
  product_id: number;
  variant_ids: number[];
  command_key: string;
  lease_token: string;
  changes: IntentChange[];
}
function deliveryFrom(row: DeliveryRow): IntentDelivery {
  return {
    id: row.delivery_id,
    changeId: row.change_id,
    destination: intentDestinationSchema.parse(row.destination),
    productId: z.number().int().positive().parse(row.product_id),
    variantIds: z
      .array(z.number().int().positive())
      .min(1)
      .parse(row.variant_ids),
    commandKey: z.string().uuid().parse(row.command_key),
    leaseToken: z.string().uuid().parse(row.lease_token),
    change: changeFrom({ ...row, id: row.change_id }),
    changes: row.changes,
  };
}

/** Reads existing publication identities only. Selection and intent resolution
 * remain with Catalog, Channels and Dropship when their existing job is prepared. */
export class PostgresListingIntentPropagationRepository implements ListingIntentPropagationStore {
  constructor(private readonly pool: Pick<Pool, "connect">) {}

  private async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        discard = true;
      }
      throw error;
    } finally {
      client.release(discard);
    }
  }

  async expand(limit: number, now: Date): Promise<number> {
    z.number().int().min(1).max(100).parse(limit);
    // Bound one transaction by source rows and recipient links. A large source
    // transaction resumes from each fact's cursor; no job can claim a partial
    // group while any fact from that source transaction remains unexpanded.
    const budget = Math.min(1_000, limit * 50);
    return this.transaction(async (client) => {
      const changes = await client.query<ChangeRow>(
        "SELECT id::text,source_relation,source_kind,changed_fields,operation,before_scope,after_scope,cursor_key,source_transaction::text FROM marketplace.listing_intent_changes WHERE expanded_at IS NULL ORDER BY marketplace.listing_intent_changes.id FOR UPDATE SKIP LOCKED LIMIT $1",
        [budget],
      );
      let inserted = 0;
      let examined = 0;
      for (const row of changes.rows) {
        if (examined >= budget) break;
        const owns = (
          await client.query<{ owned: boolean }>(
            "SELECT pg_try_advisory_xact_lock(hashtext('marketplace_listing_intent_transaction'),hashtext($1)) owned",
            [row.source_transaction],
          )
        ).rows[0].owned;
        if (!owns) continue;
        const selectors = intentSelectors(changeFrom(row));
        const pageLimit = Math.min(FANOUT_PAGE_SIZE, budget - examined);
        const members = selectors.length
          ? await managedTargets(client, selectors, row.cursor_key, pageLimit)
          : [];
        examined += Math.max(1, members.length);
        for (const member of members) {
          const destination = intentDestinationSchema.parse(member.destination);
          const key = intentCommandKey(
            "transaction:" + row.source_transaction,
            member.destination_key,
            member.product_id,
          );
          const added = await client.query<{ id: string }>(
            `INSERT INTO marketplace.listing_intent_deliveries
              (change_id,source_transaction,destination_key,destination,product_id,variant_ids,command_key,next_attempt_at,created_at,updated_at)
             VALUES($1,$2::xid8,$3,$4::jsonb,$5,$6::jsonb,$7,$8,$8,$8)
             ON CONFLICT(source_transaction,destination_key,product_id) DO NOTHING RETURNING id::text`,
            [
              row.id,
              row.source_transaction,
              member.destination_key,
              JSON.stringify(destination),
              member.product_id,
              JSON.stringify(member.variant_ids),
              key,
              now,
            ],
          );
          inserted += added.rowCount ?? 0;
          const deliveryId =
            added.rows[0]?.id ??
            (
              await client.query<{ id: string }>(
                "SELECT id::text FROM marketplace.listing_intent_deliveries WHERE source_transaction=$1::xid8 AND destination_key=$2 AND product_id=$3",
                [
                  row.source_transaction,
                  member.destination_key,
                  member.product_id,
                ],
              )
            ).rows[0].id;
          await client.query(
            "INSERT INTO marketplace.listing_intent_delivery_sources(delivery_id,change_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
            [deliveryId, row.id],
          );
        }
        const last = members.at(-1)?.cursor_key ?? row.cursor_key;
        await client.query(
          "UPDATE marketplace.listing_intent_changes SET cursor_key=$2,expanded_at=$3 WHERE id=$1",
          [row.id, last, members.length < pageLimit ? now : null],
        );
      }
      return inserted;
    });
  }

  async claim(token: string, now: Date): Promise<IntentDelivery | null> {
    z.string().uuid().parse(token);
    return this.transaction(async (client) => {
      const result = await client.query<DeliveryRow>(
        `WITH candidate AS (
           SELECT id FROM marketplace.listing_intent_deliveries d
           WHERE NOT EXISTS(SELECT 1 FROM marketplace.listing_intent_changes source
             WHERE source.source_transaction=d.source_transaction AND source.expanded_at IS NULL)
             AND state='pending' AND next_attempt_at <= $2 AND (lease_until IS NULL OR lease_until <= $2)
           ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1
         ), claimed AS (
           UPDATE marketplace.listing_intent_deliveries d SET lease_token=$1,lease_until=$3,
             attempt_count=attempt_count+1,updated_at=$2 FROM candidate c WHERE d.id=c.id RETURNING d.*
         )
         SELECT d.id::text delivery_id,d.change_id::text,d.destination,d.product_id,d.variant_ids,
           d.command_key::text,d.lease_token::text,c.source_relation,c.source_kind,c.changed_fields,c.operation,c.before_scope,c.after_scope,c.cursor_key,c.source_transaction::text,
           (SELECT jsonb_agg(jsonb_build_object('id',source.id::text,'sourceRelation',source.source_relation,'sourceKind',source.source_kind,
             'changedFields',source.changed_fields,'operation',source.operation,'beforeScope',source.before_scope,'afterScope',source.after_scope) ORDER BY source.id)
            FROM marketplace.listing_intent_delivery_sources link JOIN marketplace.listing_intent_changes source ON source.id=link.change_id WHERE link.delivery_id=d.id) changes
         FROM claimed d JOIN marketplace.listing_intent_changes c ON c.id=d.change_id`,
        [token, now, new Date(now.getTime() + LEASE_MS)],
      );
      return result.rows[0] ? deliveryFrom(result.rows[0]) : null;
    });
  }

  async finish(
    delivery: IntentDelivery,
    outcome: IntentHandoff,
    now: Date,
  ): Promise<void> {
    await this.transition(
      delivery,
      now,
      outcome.state,
      outcome.state === "delivered" ? outcome.receipt : null,
      outcome.state === "delivered" ? null : outcome.code,
      outcome.state === "delivered" ? null : outcome.message,
      outcome.state === "delivered" ? null : (outcome.resolution ?? null),
    );
  }

  async defer(
    delivery: IntentDelivery,
    code: string,
    now: Date,
  ): Promise<void> {
    await this.transition(
      delivery,
      now,
      "pending",
      null,
      code,
      "The change is saved. Its listing handoff will retry automatically; no provider completion has been confirmed.",
    );
  }

  private async transition(
    delivery: IntentDelivery,
    now: Date,
    state: string,
    receipt: unknown,
    code: string | null,
    message: string | null,
    resolution: string | null = null,
  ): Promise<void> {
    await this.transaction(async (client) => {
      const before = await client.query<{ snapshot: unknown }>(
        "SELECT to_jsonb(d) snapshot FROM marketplace.listing_intent_deliveries d WHERE id=$1 AND lease_token=$2 AND state='pending' FOR UPDATE",
        [delivery.id, delivery.leaseToken],
      );
      if (!before.rows[0]) return; // Another lease may have safely replayed the same immutable command.
      const result = await client.query<{ snapshot: unknown }>(
        `UPDATE marketplace.listing_intent_deliveries d SET state=$3,receipt=$4::jsonb,
          last_error_code=$5,last_error_message=$6,last_error_resolution=$8,lease_token=NULL,lease_until=NULL,
          next_attempt_at=$7::timestamptz + least(3600,30*greatest(1,attempt_count)) * interval '1 second',updated_at=$7
         WHERE id=$1 AND lease_token=$2 RETURNING to_jsonb(d) snapshot`,
        [
          delivery.id,
          delivery.leaseToken,
          state,
          receipt ? JSON.stringify(receipt) : null,
          code,
          message,
          now,
          resolution,
        ],
      );
      await client.query(
        `INSERT INTO marketplace.listing_intent_delivery_events(delivery_id,action,actor,before_state,after_state,occurred_at)
          VALUES ($1,$2,'system:listing-intent-propagation',$3::jsonb,$4::jsonb,$5)`,
        [
          delivery.id,
          state,
          JSON.stringify(before.rows[0].snapshot),
          JSON.stringify(result.rows[0].snapshot),
          now,
        ],
      );
    });
  }

  async vendorForMemberStore(
    memberId: string,
    storeConnectionId: number,
  ): Promise<number | null> {
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ vendor_id: number }>(
        "SELECT sc.vendor_id FROM dropship.dropship_store_connections sc JOIN dropship.dropship_vendors v ON v.id=sc.vendor_id WHERE sc.id=$1 AND v.member_id::text=$2",
        [storeConnectionId, memberId],
      );
      return result.rows[0]?.vendor_id ?? null;
    } finally {
      client.release();
    }
  }

  async list(
    input: {
      channelId?: number;
      vendorId?: number;
      storeConnectionId?: number;
    },
    limit = 100,
    offset = 0,
  ): Promise<ListingIntentChangePage> {
    z.number().int().min(1).max(100).parse(limit);
    z.number().int().min(0).max(1_000_000).parse(offset);
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ page: unknown }>(
        `WITH visible AS (
         SELECT d.id::text,d.change_id::text,d.destination,d.product_id,d.variant_ids,d.state,d.receipt,
          (${RETRY_ALLOWED}) can_retry,d.last_error_code,d.last_error_message,d.last_error_resolution,d.attempt_count,d.created_at,d.updated_at,
          c.source_relation,c.changed_fields,c.operation,c.before_scope,c.after_scope,c.actor_provenance,
          (SELECT jsonb_agg(jsonb_build_object('id',source.id::text,'source_relation',source.source_relation,
            'changed_fields',source.changed_fields,'operation',source.operation,'before_scope',source.before_scope,'after_scope',source.after_scope) ORDER BY source.id)
           FROM marketplace.listing_intent_delivery_sources link JOIN marketplace.listing_intent_changes source ON source.id=link.change_id WHERE link.delivery_id=d.id) source_changes,
          CASE WHEN d.state IN ('blocked','needs_review') THEN 0 WHEN d.state='pending' THEN 1 ELSE 2 END attention_order,d.id sequence_id
         FROM marketplace.listing_intent_deliveries d JOIN marketplace.listing_intent_changes c ON c.id=d.change_id
         WHERE ($1::int IS NULL OR d.destination->>'channelId'=$1::text)
           AND ($2::int IS NULL OR d.destination->>'vendorId'=$2::text)
           AND ($3::int IS NULL OR d.destination->>'connectionId'=$3::text)
        ), page_rows AS (SELECT * FROM visible ORDER BY attention_order,sequence_id DESC LIMIT $4 OFFSET $5)
        SELECT jsonb_build_object('items',COALESCE((SELECT jsonb_agg(to_jsonb(p)-'attention_order'-'sequence_id'
          ORDER BY p.attention_order,p.sequence_id DESC) FROM page_rows p),'[]'::jsonb),
          'total',(SELECT count(*) FROM visible),'limit',$4::int,'offset',$5::int) page`,
        [
          input.channelId ?? null,
          input.vendorId ?? null,
          input.storeConnectionId ?? null,
          limit,
          offset,
        ],
      );
      return listingIntentChangePageSchema.parse(result.rows[0].page);
    } finally {
      client.release();
    }
  }

  async retry(input: {
    id: string;
    channelId?: number;
    vendorId?: number;
    storeConnectionId?: number;
    actor: string;
    now: Date;
  }): Promise<boolean> {
    return this.transaction(async (client) => {
      const row = await client.query<{
        snapshot: {
          change_id: string;
          destination_key: string;
          product_id: number;
          retry_generation: number;
        };
      }>(
        `SELECT to_jsonb(d) snapshot FROM marketplace.listing_intent_deliveries d
         WHERE id=$1 AND (${RETRY_ALLOWED})
           AND ($2::int IS NULL OR destination->>'channelId'=$2::text)
           AND ($3::int IS NULL OR destination->>'vendorId'=$3::text)
           AND ($4::int IS NULL OR destination->>'connectionId'=$4::text) FOR UPDATE`,
        [
          input.id,
          input.channelId ?? null,
          input.vendorId ?? null,
          input.storeConnectionId ?? null,
        ],
      );
      if (!row.rows[0]) return false;
      const previous = row.rows[0].snapshot;
      const commandKey = intentCommandKey(
        String(previous.change_id) +
          ":retry:" +
          (previous.retry_generation + 1),
        previous.destination_key,
        previous.product_id,
      );
      const after = await client.query<{ snapshot: unknown }>(
        "UPDATE marketplace.listing_intent_deliveries d SET state='pending',command_key=$3,retry_generation=retry_generation+1,next_attempt_at=$2,updated_at=$2 WHERE id=$1 RETURNING to_jsonb(d) snapshot",
        [input.id, input.now, commandKey],
      );
      await client.query(
        `INSERT INTO marketplace.listing_intent_delivery_events(delivery_id,action,actor,before_state,after_state,occurred_at)
          VALUES ($1,'retry_requested',$2,$3::jsonb,$4::jsonb,$5)`,
        [
          input.id,
          input.actor,
          JSON.stringify(row.rows[0].snapshot),
          JSON.stringify(after.rows[0].snapshot),
          input.now,
        ],
      );
      return true;
    });
  }
}

interface ManagedTarget {
  destination_key: string;
  cursor_key: string;
  destination: unknown;
  product_id: number;
  variant_ids: number[];
}
async function managedTargets(
  client: PoolClient,
  selectors: IntentSelector[],
  cursor: string,
  pageLimit = FANOUT_PAGE_SIZE,
): Promise<ManagedTarget[]> {
  const result = await client.query<ManagedTarget>(
    `WITH selectors AS (SELECT value s FROM jsonb_array_elements($1::jsonb)), members AS (
       SELECT 'channel:'||c.id||':'||cc.id destination_key,
         jsonb_build_object('kind','channel','provider',c.provider,'connectionId',cc.id,'channelId',c.id,
           'vendorId',NULL,'accountId',CASE WHEN c.provider='ebay' AND et.external_account_verified_at IS NOT NULL
             THEN et.external_account_id WHEN c.provider='shopify' THEN cc.shop_domain WHEN c.provider='walmart' THEN wc.partner_id ELSE NULL END,
           'environment',CASE WHEN c.provider='ebay' THEN et.environment WHEN c.provider='walmart' THEN wc.environment ELSE 'production' END,
           'marketplaceId',CASE WHEN c.provider='walmart' THEN 'US' WHEN c.provider='ebay' THEN COALESCE(nullif(cc.metadata->>'marketplaceId',''),'EBAY_US') ELSE cc.metadata->>'marketplaceId' END,
           'ambiguousConnection',(SELECT count(*) FROM channels.channel_connections x WHERE x.channel_id=c.id)<>1) destination,
         c.id channel_id,NULL::int store_connection_id,c.provider,p.id product_id,p.product_type,p.category_id,
         v.id variant_id,v.sku,v.shopify_variant_id
       FROM channels.channel_listings l JOIN catalog.product_variants v ON v.id=l.product_variant_id
       JOIN catalog.products p ON p.id=v.product_id JOIN channels.channels c ON c.id=l.channel_id
       JOIN channels.channel_connections cc ON cc.channel_id=c.id
       LEFT JOIN channels.walmart_connections wc ON wc.channel_id=c.id AND wc.connection_id=cc.id
       LEFT JOIN ebay.ebay_oauth_tokens et ON et.channel_id=c.id
         AND et.environment=COALESCE(cc.metadata->>'environment','production')
       WHERE nullif(l.external_product_id,'') IS NOT NULL OR nullif(l.external_variant_id,'') IS NOT NULL
       UNION ALL
       SELECT 'dropship:'||sc.id,
         jsonb_build_object('kind','dropship','provider',sc.platform,'connectionId',sc.id,'channelId',NULL,
           'vendorId',sc.vendor_id,'accountId',CASE WHEN sc.external_account_verified_at IS NOT NULL THEN sc.external_account_id ELSE NULL END,
           'environment',sc.provider_environment,'marketplaceId',sc.config->>'marketplaceId','ambiguousConnection',false),
         NULL::int,sc.id,sc.platform,p.id,p.product_type,p.category_id,v.id,v.sku,v.shopify_variant_id
       FROM dropship.dropship_vendor_listings l JOIN dropship.dropship_store_connections sc ON sc.id=l.store_connection_id AND sc.vendor_id=l.vendor_id
       JOIN catalog.product_variants v ON v.id=l.product_variant_id JOIN catalog.products p ON p.id=v.product_id
       WHERE nullif(l.external_listing_id,'') IS NOT NULL OR nullif(l.external_offer_id,'') IS NOT NULL
     ), selected AS (
       SELECT DISTINCT m.destination_key,m.product_id FROM members m WHERE EXISTS (
         SELECT 1 FROM selectors WHERE
           (NOT s ? 'channelId' OR m.channel_id=(s->>'channelId')::int)
           AND (NOT s ? 'storeConnectionId' OR m.store_connection_id=(s->>'storeConnectionId')::int)
           AND (NOT s ? 'provider' OR m.provider=s->>'provider')
           AND (NOT s ? 'environment' OR m.destination->>'environment'=s->>'environment')
           AND (NOT s ? 'productId' OR m.product_id=(s->>'productId')::int)
           AND (NOT s ? 'variantId' OR s ? 'productId' OR m.variant_id=(s->>'variantId')::int)
           AND (NOT s ? 'assetId' OR EXISTS (SELECT 1 FROM catalog.product_assets a WHERE a.id=(s->>'assetId')::int AND a.product_id=m.product_id))
           AND (NOT s ? 'productType' OR m.product_type=s->>'productType')
           AND (NOT s ? 'categoryId' OR m.category_id=(s->>'categoryId')::int)
           AND (NOT s ? 'retailCacheId' AND NOT s ? 'retailSku'
             OR m.shopify_variant_id=s->>'retailCacheId' OR lower(m.sku)=lower(s->>'retailSku'))
       )
     )
     SELECT m.destination_key||':'||encode(sha256(convert_to(m.destination::text,'UTF8')),'hex') destination_key,
       m.destination,m.product_id,jsonb_agg(DISTINCT m.variant_id ORDER BY m.variant_id) variant_ids,
       m.destination_key||':'||encode(sha256(convert_to(m.destination::text,'UTF8')),'hex')||':'||lpad(m.product_id::text,10,'0') cursor_key
     FROM members m JOIN selected s USING(destination_key,product_id)
     WHERE m.destination_key||':'||encode(sha256(convert_to(m.destination::text,'UTF8')),'hex')||':'||lpad(m.product_id::text,10,'0')>$2
     GROUP BY m.destination_key,m.destination,m.product_id
     ORDER BY cursor_key LIMIT $3`,
    [JSON.stringify(selectors), cursor, pageLimit],
  );
  return result.rows;
}
