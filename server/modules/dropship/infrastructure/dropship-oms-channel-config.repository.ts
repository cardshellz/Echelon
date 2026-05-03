import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type {
  DropshipOmsChannelConfigCommandContext,
  DropshipOmsChannelConfigMutationResult,
  DropshipOmsChannelConfigOverview,
  DropshipOmsChannelConfigRepository,
  DropshipOmsChannelOption,
  NormalizedConfigureDropshipOmsChannelInput,
} from "../application/dropship-oms-channel-config-service";
import { DropshipError } from "../domain/errors";

interface OmsChannelRow {
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
  updated_at: Date;
  channel_role_marked: boolean;
  channel_flag_marked: boolean;
  connection_role_marked: boolean;
  connection_feature_marked: boolean;
}

interface AdminCommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_type: string;
  entity_id: string | null;
}

export class PgDropshipOmsChannelConfigRepository implements DropshipOmsChannelConfigRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getOverview(input: { generatedAt: Date }): Promise<DropshipOmsChannelConfigOverview> {
    const client = await this.dbPool.connect();
    try {
      return await loadOverviewWithClient(client, input.generatedAt);
    } finally {
      client.release();
    }
  }

  async configure(
    input: NormalizedConfigureDropshipOmsChannelInput & DropshipOmsChannelConfigCommandContext,
  ): Promise<DropshipOmsChannelConfigMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, "dropship_oms_channel_configured", input);
      if (command.idempotentReplay) {
        const selectedChannel = await loadChannelOptionByIdWithClient(
          client,
          parseEntityId(command.entityId, "channels.channels"),
        );
        const config = await loadOverviewWithClient(client, input.now);
        await client.query("COMMIT");
        return { config, selectedChannel, idempotentReplay: true };
      }

      const selectedBeforeUpdate = await lockConfiguredChannel(client, input.channelId);
      if (selectedBeforeUpdate.status !== "active") {
        throw new DropshipError(
          "DROPSHIP_OMS_CHANNEL_NOT_ACTIVE",
          "Dropship OMS channel must be active before it can be used for order intake.",
          {
            channelId: input.channelId,
            status: selectedBeforeUpdate.status,
          },
        );
      }

      await clearExistingDropshipOmsMarkers(client, input.now);
      const selectedChannel = await markDropshipOmsChannel(client, input);
      await completeAdminConfigCommand(client, command.commandId, "channels.channels", selectedChannel.channelId, input.now);
      await recordAdminOmsChannelAuditEvent(client, input, selectedChannel);
      const config = await loadOverviewWithClient(client, input.now);
      await client.query("COMMIT");
      return { config, selectedChannel, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function loadOverviewWithClient(
  client: PoolClient,
  generatedAt: Date,
): Promise<DropshipOmsChannelConfigOverview> {
  const channels = await listChannelOptionsWithClient(client);
  const activeMarkedChannels = channels.filter((channel) => (
    channel.status === "active" && channel.isDropshipOmsChannel
  ));
  return {
    currentChannelId: activeMarkedChannels.length === 1 ? activeMarkedChannels[0]!.channelId : null,
    currentChannelCount: activeMarkedChannels.length,
    channels,
    generatedAt,
  };
}

async function listChannelOptionsWithClient(client: PoolClient): Promise<DropshipOmsChannelOption[]> {
  const result = await client.query<OmsChannelRow>(
    `SELECT
       c.id,
       c.name,
       c.type,
       c.provider,
       c.status,
       c.updated_at,
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
  );
  return result.rows.map(mapOmsChannelRow);
}

async function loadChannelOptionByIdWithClient(
  client: PoolClient,
  channelId: number,
): Promise<DropshipOmsChannelOption> {
  const channels = await listChannelOptionsWithClient(client);
  const channel = channels.find((candidate) => candidate.channelId === channelId);
  if (!channel) {
    throw new DropshipError("DROPSHIP_OMS_CHANNEL_NOT_FOUND", "Dropship OMS channel was not found.", { channelId });
  }
  return channel;
}

async function lockConfiguredChannel(client: PoolClient, channelId: number): Promise<{
  id: number;
  name: string;
  type: string;
  provider: string;
  status: string;
}> {
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
  const row = result.rows[0];
  if (!row) {
    throw new DropshipError("DROPSHIP_OMS_CHANNEL_NOT_FOUND", "Dropship OMS channel was not found.", { channelId });
  }
  return row;
}

async function clearExistingDropshipOmsMarkers(client: PoolClient, now: Date): Promise<void> {
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

async function markDropshipOmsChannel(
  client: PoolClient,
  input: NormalizedConfigureDropshipOmsChannelInput & DropshipOmsChannelConfigCommandContext,
): Promise<DropshipOmsChannelOption> {
  const result = await client.query<OmsChannelRow>(
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
       LOWER(COALESCE(shipping_config #>> '{dropship,role}', '')) = 'oms' AS channel_role_marked,
       COALESCE(shipping_config #>> '{dropship,omsChannel}', 'false') = 'true' AS channel_flag_marked,
       false AS connection_role_marked,
       false AS connection_feature_marked`,
    [
      input.channelId,
      input.now.toISOString(),
      input.actor.actorId ?? input.actor.actorType,
      input.now,
    ],
  );
  return mapOmsChannelRow(requiredRow(result.rows[0], "Dropship OMS channel update did not return a row."));
}

async function claimAdminConfigCommand(
  client: PoolClient,
  commandType: string,
  input: DropshipOmsChannelConfigCommandContext,
): Promise<{
  commandId: number;
  entityId: string | null;
  idempotentReplay: boolean;
}> {
  const inserted = await client.query<{ id: number }>(
    `INSERT INTO dropship.dropship_admin_config_commands
      (command_type, idempotency_key, request_hash, entity_type,
       actor_type, actor_id, created_at)
     VALUES ($1, $2, $3, $1, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      commandType,
      input.idempotencyKey,
      input.requestHash,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.now,
    ],
  );
  const insertedId = inserted.rows[0]?.id;
  if (insertedId) {
    return { commandId: insertedId, entityId: null, idempotentReplay: false };
  }

  const existing = await client.query<AdminCommandRow>(
    `SELECT id, command_type, request_hash, entity_type, entity_id
     FROM dropship.dropship_admin_config_commands
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = requiredRow(existing.rows[0], "Dropship admin config idempotency row was not found after conflict.");
  if (row.command_type !== commandType || row.request_hash !== input.requestHash) {
    throw new DropshipError(
      "DROPSHIP_OMS_CHANNEL_CONFIG_IDEMPOTENCY_CONFLICT",
      "Dropship OMS channel config idempotency key was reused with a different request.",
      {
        commandType,
        idempotencyKey: input.idempotencyKey,
      },
    );
  }
  if (!row.entity_id) {
    throw new DropshipError(
      "DROPSHIP_OMS_CHANNEL_CONFIG_COMMAND_INCOMPLETE",
      "Dropship OMS channel config command replay is incomplete.",
      {
        commandType,
        idempotencyKey: input.idempotencyKey,
      },
    );
  }
  return { commandId: row.id, entityId: row.entity_id, idempotentReplay: true };
}

async function completeAdminConfigCommand(
  client: PoolClient,
  commandId: number,
  entityType: string,
  entityId: number,
  now: Date,
): Promise<void> {
  await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = $2, entity_id = $3, completed_at = $4
     WHERE id = $1`,
    [commandId, entityType, String(entityId), now],
  );
}

async function recordAdminOmsChannelAuditEvent(
  client: PoolClient,
  input: DropshipOmsChannelConfigCommandContext,
  selectedChannel: DropshipOmsChannelOption,
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (entity_type, entity_id, event_type, actor_type, actor_id,
       severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, 'info', $6::jsonb, $7)`,
    [
      "channels.channels",
      String(selectedChannel.channelId),
      "dropship_oms_channel_configured",
      input.actor.actorType,
      input.actor.actorId ?? null,
      JSON.stringify({
        channelId: selectedChannel.channelId,
        name: selectedChannel.name,
        provider: selectedChannel.provider,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      }),
      input.now,
    ],
  );
}

function mapOmsChannelRow(row: OmsChannelRow): DropshipOmsChannelOption {
  const markerSources = [
    row.channel_role_marked ? "channel.shipping_config.dropship.role" : null,
    row.channel_flag_marked ? "channel.shipping_config.dropship.omsChannel" : null,
    row.connection_role_marked ? "channel_connection.metadata.dropship.role" : null,
    row.connection_feature_marked ? "channel_connection.metadata.features.dropshipOms" : null,
  ].filter((source): source is string => source !== null);
  return {
    channelId: row.id,
    name: row.name,
    type: row.type,
    provider: row.provider,
    status: row.status,
    isDropshipOmsChannel: markerSources.length > 0,
    markerSources,
    updatedAt: row.updated_at,
  };
}

function parseEntityId(value: string | null, entityType: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_OMS_CHANNEL_CONFIG_COMMAND_INCOMPLETE",
      "Dropship OMS channel config replay entity id is invalid.",
      { entityType, entityId: value },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
