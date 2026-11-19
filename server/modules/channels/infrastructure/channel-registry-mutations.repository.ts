import type { PoolClient } from "pg";
import { sql } from "drizzle-orm";

export async function repairDropshipDefaultOmsChannelInTx(
  client: PoolClient,
  existingId: number,
  now: Date,
): Promise<number | undefined> {
  const updated = await client.query<{ id: number }>(
    `UPDATE channels.channels
     SET status = 'active',
         shipping_config = COALESCE(shipping_config, '{}'::jsonb),
         updated_at = $2
     WHERE id = $1
     RETURNING id`,
    [existingId, now],
  );
  return updated.rows[0]?.id;
}

export async function insertDropshipDefaultOmsChannelInTx(
  client: PoolClient,
  input: {
    name: string;
    type: string;
    provider: string;
    now: Date;
  },
): Promise<number | undefined> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO channels.channels
       (name, type, provider, status, shipping_config, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', '{}'::jsonb, $4, $4)
     RETURNING id`,
    [input.name, input.type, input.provider, input.now],
  );
  return inserted.rows[0]?.id;
}

export async function clearExistingDropshipOmsChannelAndConnectionMarkersInTx(
  client: PoolClient,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE channels.channels
     SET shipping_config = jsonb_set(
           COALESCE(shipping_config, '{}'::jsonb)
             #- '{dropship,role}'
             #- '{dropship,configuredAt}'
             #- '{dropship,configuredBy}'
             #- '{dropship,source}',
           '{dropship,omsChannel}',
           'false'::jsonb,
           true
         ),
         updated_at = $1
     WHERE LOWER(COALESCE(shipping_config #>> '{dropship,role}', '')) = 'oms'
        OR COALESCE(shipping_config #>> '{dropship,omsChannel}', 'false') = 'true'`,
    [now],
  );

  await client.query(
    `UPDATE channels.channel_connections
     SET metadata = jsonb_set(
           jsonb_set(
             COALESCE(metadata, '{}'::jsonb)
               #- '{dropship,role}'
               #- '{dropship,configuredAt}'
               #- '{dropship,configuredBy}'
               #- '{dropship,source}',
             '{features,dropshipOms}',
             'false'::jsonb,
             true
           ),
           '{features,dropship_oms}',
           'false'::jsonb,
           true
         ),
         updated_at = $1
     WHERE LOWER(COALESCE(metadata #>> '{dropship,role}', '')) = 'oms'
        OR COALESCE(metadata #>> '{features,dropshipOms}', 'false') = 'true'
        OR COALESCE(metadata #>> '{features,dropship_oms}', 'false') = 'true'`,
    [now],
  );
}

export async function markChannelAsDropshipOmsInTx<TRow extends Record<string, any>>(
  client: PoolClient,
  input: {
    channelId: number;
    configuredAtIso: string;
    configuredBy: string;
    now: Date;
  },
): Promise<TRow | undefined> {
  const result = await client.query<TRow>(
    `UPDATE channels.channels
     SET shipping_config = jsonb_set(
           jsonb_set(
             jsonb_set(
               jsonb_set(
                 jsonb_set(
                   COALESCE(shipping_config, '{}'::jsonb),
                   '{dropship}',
                   COALESCE(
                     CASE
                       WHEN jsonb_typeof(shipping_config -> 'dropship') = 'object'
                         THEN shipping_config -> 'dropship'
                       ELSE NULL
                     END,
                     '{}'::jsonb
                   ),
                   true
                 ),
                 '{dropship,role}',
                 to_jsonb('oms'::text),
                 true
               ),
               '{dropship,omsChannel}',
               'true'::jsonb,
               true
             ),
             '{dropship,configuredAt}',
             to_jsonb($2::text),
             true
           ),
           '{dropship,configuredBy}',
           to_jsonb($3::text),
           true
         ),
         updated_at = $4
     WHERE id = $1
     RETURNING
       id,
       name,
       type,
       provider,
       status,
       updated_at,
       true AS internal_dropship_channel,
       LOWER(COALESCE(shipping_config #>> '{dropship,role}', '')) = 'oms' AS channel_role_marked,
       COALESCE(shipping_config #>> '{dropship,omsChannel}', 'false') = 'true' AS channel_flag_marked,
       false AS connection_role_marked,
       false AS connection_feature_marked`,
    [input.channelId, input.configuredAtIso, input.configuredBy, input.now],
  );
  return result.rows[0];
}

export async function ensureDefaultShopifyChannelSeeded(
  executor: { execute: (query: any) => Promise<{ rows: unknown[] }> },
): Promise<void> {
  const existingShopify = await executor.execute(
    sql`SELECT id FROM channels.channels WHERE provider = 'shopify' LIMIT 1`,
  );
  if (existingShopify.rows.length === 0) {
    await executor.execute(
      sql`INSERT INTO channels.channels (name, type, provider, status) VALUES ('Shopify Store', 'internal', 'shopify', 'active') ON CONFLICT DO NOTHING`,
    );
  }
}

export async function listDropshipOmsChannelOptionsInTx<
  TRow extends Record<string, any>,
>(
  client: PoolClient,
  input: {
    defaultName: string;
    defaultType: string;
    defaultProvider: string;
  },
): Promise<TRow[]> {
  const result = await client.query<TRow>(
    `SELECT
       c.id,
       c.name,
       c.type,
       c.provider,
       c.status,
       c.updated_at,
       LOWER(c.name) = LOWER($1)
         AND c.type = $2
         AND c.provider = $3 AS internal_dropship_channel,
       LOWER(COALESCE(c.shipping_config #>> '{dropship,role}', '')) = 'oms' AS channel_role_marked,
       COALESCE(c.shipping_config #>> '{dropship,omsChannel}', 'false') = 'true' AS channel_flag_marked,
       EXISTS (
         SELECT 1
         FROM channels.channel_connections cc
         WHERE cc.channel_id = c.id
           AND LOWER(COALESCE(cc.metadata #>> '{dropship,role}', '')) = 'oms'
       ) AS connection_role_marked,
       EXISTS (
         SELECT 1
         FROM channels.channel_connections cc
         WHERE cc.channel_id = c.id
           AND (
             COALESCE(cc.metadata #>> '{features,dropshipOms}', 'false') = 'true'
             OR COALESCE(cc.metadata #>> '{features,dropship_oms}', 'false') = 'true'
           )
       ) AS connection_feature_marked
     FROM channels.channels c
     ORDER BY
       CASE WHEN c.status = 'active' THEN 0 ELSE 1 END,
       c.name ASC,
       c.id ASC`,
    [input.defaultName, input.defaultType, input.defaultProvider],
  );
  return result.rows;
}

export async function findDropshipDefaultOmsChannelIdInTx(
  client: PoolClient,
  input: {
    name: string;
    type: string;
    provider: string;
  },
): Promise<number | undefined> {
  const existing = await client.query<{ id: number }>(
    `SELECT id
     FROM channels.channels
     WHERE LOWER(name) = LOWER($1)
       AND type = $2
       AND provider = $3
     ORDER BY id ASC
     LIMIT 1`,
    [input.name, input.type, input.provider],
  );
  return existing.rows[0]?.id;
}

export async function lockDropshipOmsChannelByIdInTx(
  client: PoolClient,
  channelId: number,
): Promise<
  | {
      id: number;
      name: string;
      type: string;
      provider: string;
      status: string;
    }
  | undefined
> {
  const result = await client.query<{
    id: number;
    name: string;
    type: string;
    provider: string;
    status: string;
  }>(
    `SELECT id, name, type, provider, status
     FROM channels.channels
     WHERE id = $1
     FOR UPDATE`,
    [channelId],
  );
  return result.rows[0];
}
