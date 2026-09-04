import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  DROPSHIP_EBAY_BRANDING_USE_CASE,
  type DropshipEbayOAuthBrandingCommandContext,
  type DropshipEbayOAuthBrandingRepository,
  type DropshipEbayOAuthBrandingRevision,
} from "../application/dropship-ebay-oauth-branding-service";
import { DropshipError } from "../domain/errors";

const PLATFORM = "ebay" as const;
const REVISION_ENTITY_TYPE =
  "dropship_channel_connection_branding_revisions";
const REQUEST_COMMAND_TYPE =
  "dropship_ebay_customer_facing_app_name_requested";
const VERIFY_COMMAND_TYPE =
  "dropship_ebay_customer_facing_app_name_verified";
const PROVIDER_STATUS_BY_ACTION = {
  name_requested: "pending_external_update",
  external_update_verified: "manually_verified",
  provider_update_applied: "provider_applied",
  provider_update_failed: "provider_failed",
} as const;
const VERIFIED_PROVIDER_STATUSES = new Set([
  "manually_verified",
  "provider_applied",
]);

interface BrandingRevisionRow {
  id: number;
  platform: string;
  use_case: string;
  environment: string;
  revision: number;
  customer_facing_app_name: string;
  provider_resource_fingerprint: string | null;
  provider_status: string;
  action: string;
  actor_type: string;
  actor_id: string | null;
  created_at: Date;
}

interface AdminCommandRow {
  id: number;
  command_type: string;
  request_hash: string;
  entity_type: string;
  entity_id: string | null;
}

interface ClaimedCommand {
  commandId: number;
  entityId: string | null;
  idempotentReplay: boolean;
}

export class PgDropshipEbayOAuthBrandingRepository
  implements DropshipEbayOAuthBrandingRepository
{
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async loadCurrent(input: {
    environment: "sandbox" | "production";
  }): Promise<DropshipEbayOAuthBrandingRevision | null> {
    const result = await this.dbPool.query<BrandingRevisionRow>(
      `${brandingRevisionSelect()}
       WHERE platform = $1 AND use_case = $2 AND environment = $3
       ORDER BY revision DESC
       LIMIT 1`,
      [PLATFORM, DROPSHIP_EBAY_BRANDING_USE_CASE, input.environment],
    );
    return result.rows[0] ? mapBrandingRevision(result.rows[0]) : null;
  }

  async requestCustomerFacingAppName(
    input: DropshipEbayOAuthBrandingCommandContext & {
      customerFacingAppName: string;
    },
  ): Promise<{
    revision: DropshipEbayOAuthBrandingRevision;
    idempotentReplay: boolean;
  }> {
    return this.withTransaction(async (client) => {
      const command = await claimAdminCommand(
        client,
        REQUEST_COMMAND_TYPE,
        input,
      );
      if (command.idempotentReplay) {
        return {
          revision: await loadReplayRevision(
            client,
            command,
            input.environment,
          ),
          idempotentReplay: true,
        };
      }

      await lockBrandingScope(client, input.environment);
      const current = await loadCurrentWithClient(client, input.environment);
      assertExpectedRevision(current, input.expectedRevision);
      if (
        current?.customerFacingAppName === input.customerFacingAppName &&
        current.providerResourceFingerprint ===
          input.providerResourceFingerprint &&
        current.providerStatus !== "provider_failed"
      ) {
        throw new DropshipError(
          "DROPSHIP_EBAY_OAUTH_BRANDING_UNCHANGED",
          "The requested customer-facing app name is already the current desired value.",
          {
            expectedRevision: input.expectedRevision,
            providerStatus: current.providerStatus,
          },
        );
      }

      const revision = await insertBrandingRevision(client, {
        environment: input.environment,
        revision: input.expectedRevision + 1,
        customerFacingAppName: input.customerFacingAppName,
        providerResourceFingerprint: input.providerResourceFingerprint,
        providerStatus: "pending_external_update",
        action: "name_requested",
        actor: input.actor,
        commandId: command.commandId,
        createdAt: input.now,
      });
      await completeAdminCommand(
        client,
        command.commandId,
        revision.id,
        input.now,
      );
      await recordBrandingAuditEvent(client, {
        revision,
        eventType: "customer_facing_app_name_requested",
        actor: input.actor,
        before: current,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.now,
      });
      return { revision, idempotentReplay: false };
    });
  }

  async confirmExternalUpdate(
    input: DropshipEbayOAuthBrandingCommandContext,
  ): Promise<{
    revision: DropshipEbayOAuthBrandingRevision;
    idempotentReplay: boolean;
  }> {
    if (!input.providerResourceFingerprint) {
      throw new DropshipError(
        "DROPSHIP_EBAY_OAUTH_BRANDING_CONFIGURATION_REQUIRED",
        "A configured eBay provider resource is required before manual verification.",
      );
    }
    return this.withTransaction(async (client) => {
      const command = await claimAdminCommand(
        client,
        VERIFY_COMMAND_TYPE,
        input,
      );
      if (command.idempotentReplay) {
        return {
          revision: await loadReplayRevision(
            client,
            command,
            input.environment,
          ),
          idempotentReplay: true,
        };
      }

      await lockBrandingScope(client, input.environment);
      const current = await loadCurrentWithClient(client, input.environment);
      assertExpectedRevision(current, input.expectedRevision);
      if (!current) {
        throw new DropshipError(
          "DROPSHIP_EBAY_OAUTH_BRANDING_NOT_FOUND",
          "Save a customer-facing app name before verifying the provider update.",
        );
      }
      const providerResourceChanged =
        current.providerResourceFingerprint !==
        input.providerResourceFingerprint;
      if (
        current.providerStatus !== "pending_external_update" &&
        !providerResourceChanged
      ) {
        throw new DropshipError(
          "DROPSHIP_EBAY_OAUTH_BRANDING_NOT_PENDING",
          "The current customer-facing app name is not awaiting external provider verification.",
          {
            revision: current.revision,
            providerStatus: current.providerStatus,
          },
        );
      }

      const revision = await insertBrandingRevision(client, {
        environment: input.environment,
        revision: input.expectedRevision + 1,
        customerFacingAppName: current.customerFacingAppName,
        providerResourceFingerprint: input.providerResourceFingerprint,
        providerStatus: "manually_verified",
        action: "external_update_verified",
        actor: input.actor,
        commandId: command.commandId,
        createdAt: input.now,
      });
      await completeAdminCommand(
        client,
        command.commandId,
        revision.id,
        input.now,
      );
      await recordBrandingAuditEvent(client, {
        revision,
        eventType: "customer_facing_app_name_external_update_verified",
        actor: input.actor,
        before: current,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        createdAt: input.now,
      });
      return { revision, idempotentReplay: false };
    });
  }

  private async withTransaction<T>(
    operation: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

function brandingRevisionSelect(): string {
  return `SELECT id, platform, use_case, environment, revision,
                 customer_facing_app_name, provider_resource_fingerprint,
                 provider_status, action,
                 actor_type, actor_id, created_at
          FROM dropship.dropship_channel_connection_branding_revisions`;
}

async function lockBrandingScope(
  client: PoolClient,
  environment: "sandbox" | "production",
): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
    `${PLATFORM}:${DROPSHIP_EBAY_BRANDING_USE_CASE}:${environment}`,
  ]);
}

async function loadCurrentWithClient(
  client: PoolClient,
  environment: "sandbox" | "production",
): Promise<DropshipEbayOAuthBrandingRevision | null> {
  const result = await client.query<BrandingRevisionRow>(
    `${brandingRevisionSelect()}
     WHERE platform = $1 AND use_case = $2 AND environment = $3
     ORDER BY revision DESC
     LIMIT 1`,
    [PLATFORM, DROPSHIP_EBAY_BRANDING_USE_CASE, environment],
  );
  return result.rows[0] ? mapBrandingRevision(result.rows[0]) : null;
}

async function insertBrandingRevision(
  client: PoolClient,
  input: {
    environment: "sandbox" | "production";
    revision: number;
    customerFacingAppName: string;
    providerResourceFingerprint: string | null;
    providerStatus: "pending_external_update" | "manually_verified";
    action: "name_requested" | "external_update_verified";
    actor: { actorType: "admin" | "system"; actorId?: string };
    commandId: number;
    createdAt: Date;
  },
): Promise<DropshipEbayOAuthBrandingRevision> {
  const result = await client.query<BrandingRevisionRow>(
    `INSERT INTO dropship.dropship_channel_connection_branding_revisions
      (platform, use_case, environment, revision,
       customer_facing_app_name, provider_resource_fingerprint,
       provider_status, action, actor_type, actor_id, command_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id, platform, use_case, environment, revision,
               customer_facing_app_name, provider_resource_fingerprint,
               provider_status, action,
               actor_type, actor_id, created_at`,
    [
      PLATFORM,
      DROPSHIP_EBAY_BRANDING_USE_CASE,
      input.environment,
      input.revision,
      input.customerFacingAppName,
      input.providerResourceFingerprint,
      input.providerStatus,
      input.action,
      input.actor.actorType,
      input.actor.actorId ?? null,
      input.commandId,
      input.createdAt,
    ],
  );
  return mapBrandingRevision(
    requiredRow(
      result.rows[0],
      "The customer-facing app name revision insert returned no row.",
    ),
  );
}

async function claimAdminCommand(
  client: PoolClient,
  commandType: string,
  input: DropshipEbayOAuthBrandingCommandContext,
): Promise<ClaimedCommand> {
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
    return {
      commandId: insertedId,
      entityId: null,
      idempotentReplay: false,
    };
  }

  const existing = await client.query<AdminCommandRow>(
    `SELECT id, command_type, request_hash, entity_type, entity_id
     FROM dropship.dropship_admin_config_commands
     WHERE idempotency_key = $1
     FOR UPDATE`,
    [input.idempotencyKey],
  );
  const row = requiredRow(
    existing.rows[0],
    "The branding idempotency command was not found after its key conflicted.",
  );
  if (row.command_type !== commandType || row.request_hash !== input.requestHash) {
    throw new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_IDEMPOTENCY_CONFLICT",
      "The idempotency key was already used for a different connection-branding request.",
      {
        commandType,
        idempotencyKey: input.idempotencyKey,
        requestHashMatches: row.request_hash === input.requestHash,
      },
    );
  }
  if (row.entity_type !== REVISION_ENTITY_TYPE || !row.entity_id) {
    throw new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_COMMAND_INCOMPLETE",
      "The prior connection-branding command has not completed safely.",
      { commandType, idempotencyKey: input.idempotencyKey },
    );
  }
  return {
    commandId: row.id,
    entityId: row.entity_id,
    idempotentReplay: true,
  };
}

async function completeAdminCommand(
  client: PoolClient,
  commandId: number,
  revisionId: number,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE dropship.dropship_admin_config_commands
     SET entity_type = $2, entity_id = $3, completed_at = $4
     WHERE id = $1 AND completed_at IS NULL`,
    [commandId, REVISION_ENTITY_TYPE, String(revisionId), now],
  );
  if (result.rowCount !== 1) {
    throw new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_COMMAND_INCOMPLETE",
      "The connection-branding command could not be completed exactly once.",
      { commandId, affectedRows: result.rowCount },
    );
  }
}

async function loadReplayRevision(
  client: PoolClient,
  command: ClaimedCommand,
  environment: "sandbox" | "production",
): Promise<DropshipEbayOAuthBrandingRevision> {
  const revisionId = parsePositiveInteger(command.entityId);
  const result = await client.query<BrandingRevisionRow>(
    `${brandingRevisionSelect()}
     WHERE id = $1 AND platform = $2 AND use_case = $3 AND environment = $4`,
    [revisionId, PLATFORM, DROPSHIP_EBAY_BRANDING_USE_CASE, environment],
  );
  return mapBrandingRevision(
    requiredRow(
      result.rows[0],
      "The completed connection-branding command references a missing revision.",
    ),
  );
}

async function recordBrandingAuditEvent(
  client: PoolClient,
  input: {
    revision: DropshipEbayOAuthBrandingRevision;
    eventType: string;
    actor: { actorType: "admin" | "system"; actorId?: string };
    before: DropshipEbayOAuthBrandingRevision | null;
    idempotencyKey: string;
    requestHash: string;
    createdAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO dropship.dropship_audit_events
      (entity_type, entity_id, event_type, actor_type, actor_id,
       severity, payload, created_at)
     VALUES ($1, $2, $3, $4, $5, 'info', $6::jsonb, $7)`,
    [
      REVISION_ENTITY_TYPE,
      String(input.revision.id),
      input.eventType,
      input.actor.actorType,
      input.actor.actorId ?? null,
      JSON.stringify({
        platform: input.revision.platform,
        useCase: input.revision.useCase,
        environment: input.revision.environment,
        before: input.before
          ? {
              revision: input.before.revision,
              customerFacingAppName: input.before.customerFacingAppName,
              providerResourceFingerprint:
                input.before.providerResourceFingerprint,
              providerStatus: input.before.providerStatus,
            }
          : null,
        after: {
          revision: input.revision.revision,
          customerFacingAppName: input.revision.customerFacingAppName,
          providerResourceFingerprint:
            input.revision.providerResourceFingerprint,
          providerStatus: input.revision.providerStatus,
        },
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
      }),
      input.createdAt,
    ],
  );
}

function assertExpectedRevision(
  current: DropshipEbayOAuthBrandingRevision | null,
  expectedRevision: number,
): void {
  const actualRevision = current?.revision ?? 0;
  if (actualRevision !== expectedRevision) {
    throw new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_REVISION_CONFLICT",
      "The customer-facing app name changed after this page was loaded. Refresh and try again.",
      { expectedRevision, actualRevision },
    );
  }
}

function mapBrandingRevision(
  row: BrandingRevisionRow,
): DropshipEbayOAuthBrandingRevision {
  const validActorTypes = new Set(["admin", "system"]);
  const expectedProviderStatus =
    PROVIDER_STATUS_BY_ACTION[
      row.action as keyof typeof PROVIDER_STATUS_BY_ACTION
    ];
  if (
    !Number.isInteger(row.id) ||
    row.id <= 0 ||
    row.platform !== PLATFORM ||
    row.use_case !== DROPSHIP_EBAY_BRANDING_USE_CASE ||
    (row.environment !== "sandbox" && row.environment !== "production") ||
    !Number.isInteger(row.revision) ||
    row.revision <= 0 ||
    typeof row.customer_facing_app_name !== "string" ||
    !row.customer_facing_app_name.trim() ||
    (row.provider_resource_fingerprint !== null &&
      !/^[0-9a-f]{64}$/.test(row.provider_resource_fingerprint)) ||
    !expectedProviderStatus ||
    expectedProviderStatus !== row.provider_status ||
    (VERIFIED_PROVIDER_STATUSES.has(row.provider_status) &&
      row.provider_resource_fingerprint === null) ||
    !validActorTypes.has(row.actor_type) ||
    !(row.created_at instanceof Date) ||
    Number.isNaN(row.created_at.getTime())
  ) {
    throw new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_CORRUPT_STATE",
      "Stored eBay connection-branding state failed validation.",
      { revisionId: row.id },
    );
  }
  return {
    id: row.id,
    platform: PLATFORM,
    useCase: DROPSHIP_EBAY_BRANDING_USE_CASE,
    environment: row.environment,
    revision: row.revision,
    customerFacingAppName: row.customer_facing_app_name,
    providerResourceFingerprint: row.provider_resource_fingerprint,
    providerStatus:
      row.provider_status as DropshipEbayOAuthBrandingRevision["providerStatus"],
    action: row.action as DropshipEbayOAuthBrandingRevision["action"],
    actorType:
      row.actor_type as DropshipEbayOAuthBrandingRevision["actorType"],
    actorId: row.actor_id,
    createdAt: row.created_at,
  };
}

function parsePositiveInteger(value: string | null): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_COMMAND_INCOMPLETE",
      "The completed branding command has an invalid revision reference.",
      { entityId: value },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

function mapDatabaseError(error: unknown): unknown {
  if (error instanceof DropshipError || !error || typeof error !== "object") {
    return error;
  }
  const databaseError = error as { code?: string; constraint?: string };
  if (
    databaseError.code === "23505" &&
    databaseError.constraint === "dropship_channel_branding_scope_revision_uq"
  ) {
    return new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_REVISION_CONFLICT",
      "The customer-facing app name changed concurrently. Refresh and try again.",
    );
  }
  return error;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction failure.
  }
}
