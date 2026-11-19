import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { persistAuditEvent } from "../../../infrastructure/transactional-audit";
import {
  ShopifyStaffOAuthError,
  type ShopifyStaffOAuthActor,
  type ShopifyStaffOAuthBinding,
  type ShopifyStaffOAuthClaim,
  type ShopifyStaffOAuthClaimInput,
  type ShopifyStaffOAuthClaimResult,
  type ShopifyStaffOAuthCreate,
  type ShopifyStaffOAuthRepository,
  type ShopifyStaffOAuthResult,
  type ShopifyStaffOAuthToken,
} from "../shopify-staff-oauth.types";

// The caller supplies the existing public Identity reader. Importing this
// repository must not initialize the application database through a barrel.
type ReadAuthority = typeof import("../../identity").readCommandAuthorityActor;
export type ShopifyStaffOAuthTransaction = Parameters<ReadAuthority>[0]
  & Parameters<typeof persistAuditEvent>[0];
export interface ShopifyStaffOAuthDatabase {
  transaction<T>(work: (tx: ShopifyStaffOAuthTransaction) => Promise<T>): Promise<T>;
}

const id = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const shop = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/);
const instant = z.date();
// Raw Drizzle execute rows can carry PostgreSQL timestamps as strings. Normalize
// only stored values; public command inputs still require actual Date objects.
const storedInstant = z.union([z.date(), z.string().min(1)]).pipe(z.coerce.date());
const actorFields = { actorId: z.string().trim().min(1).max(255), sessionHash: hash };
const bindingSchema = z.object({
  ...actorFields,
  operationId: z.string().uuid(), stateHash: hash, configFingerprint: hash,
  shopDomain: shop, channelId: id, connectionId: id, connectionFingerprint: hash,
  createdAt: instant, expiresAt: instant,
});
const createSchema = z.object({
  ...actorFields,
  operationId: z.string().uuid(), stateHash: hash, configFingerprint: hash,
  shopDomain: shop, requestedChannelId: id.optional(), now: instant, expiresAt: instant,
}).strict();
const claimInputSchema = z.object({
  ...actorFields, stateHash: hash, configFingerprint: hash, shopDomain: shop,
  attemptId: z.string().uuid(), now: instant,
}).strict();
const claimSchema = bindingSchema.extend({ attemptId: z.string().uuid() }).strict();
const rowSchema = bindingSchema.extend({
  createdAt: storedInstant, expiresAt: storedInstant,
  status: z.enum(["issued", "exchanging", "succeeded", "exchange_unknown", "failed", "superseded"]),
  attemptId: z.string().uuid().nullable(), startedAt: storedInstant.nullable(),
  completedAt: storedInstant.nullable(), errorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/).nullable(),
});
type Authorization = z.infer<typeof rowSchema>;
const connectionSchema = z.object({
  channelId: id, connectionId: id, provider: z.literal("shopify"), shopDomain: shop,
  accessToken: z.string().nullable(), refreshToken: z.string().nullable(),
  expiresAt: storedInstant.nullable(),
  scopes: z.string().nullable(), apiVersion: z.string().nullable(),
  webhookSecret: z.string().nullable(), shopifyLocationId: z.string().nullable(),
});
type Connection = z.infer<typeof connectionSchema>;
const tokenSchema = z.object({
  accessToken: z.string().min(1).max(16_384).refine(value => value.trim() === value && !/[\x00-\x20\x7f]/.test(value)),
  scopes: z.string().min(1).max(16_384).regex(/^[a-z0-9_]+(?:,[a-z0-9_]+)*$/),
}).strict();
const authorizationColumns = sql`
  operation_id AS "operationId", state_hash AS "stateHash", actor_id AS "actorId",
  session_hash AS "sessionHash", config_fingerprint AS "configFingerprint",
  shop_domain AS "shopDomain", channel_id AS "channelId", connection_id AS "connectionId",
  connection_fingerprint AS "connectionFingerprint", created_at AS "createdAt",
  expires_at AS "expiresAt", status, attempt_id AS "attemptId", started_at AS "startedAt",
  completed_at AS "completedAt", error_code AS "errorCode"
`;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_INPUT_INVALID", 400);
  return parsed.data;
}

/** Do not include volatile sync status/timestamps in the credential binding. */
function fingerprint(connection: Connection): string {
  return createHash("sha256").update(JSON.stringify([
    connection.channelId, connection.connectionId, connection.provider, connection.shopDomain,
    connection.accessToken, connection.refreshToken, connection.expiresAt, connection.scopes, connection.apiVersion,
    connection.webhookSecret, connection.shopifyLocationId,
  ])).digest("hex");
}

function binding(row: Authorization): ShopifyStaffOAuthBinding {
  return bindingSchema.parse(row);
}

function result(row: Authorization, replayed = true, now?: Date): ShopifyStaffOAuthResult {
  // Provider dispatch is bounded to <=60s. Another 60s is a conservative
  // persistence grace, not a lease permitting replay. A crashed process leaves
  // the database fence intact and is presented as uncertain, never reclaimed.
  const stalled = row.status === "exchanging" && row.startedAt !== null && now !== undefined
    && now.getTime() - row.startedAt.getTime() >= 120_000;
  return {
    operationId: row.operationId, channelId: row.channelId, connectionId: row.connectionId,
    status: stalled ? "exchange_unknown" : row.status === "succeeded" ? "connected"
      : row.status === "issued" || row.status === "exchanging" ? "in_progress" : row.status,
    replayed,
    ...(stalled ? { code: "SHOPIFY_OAUTH_ATTEMPT_STALLED" } : row.errorCode ? { code: row.errorCode } : {}),
  };
}

function assertActorBinding(row: Authorization, actor: ShopifyStaffOAuthActor): void {
  if (row.actorId !== actor.actorId || row.sessionHash !== actor.sessionHash) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHORIZATION_INVALID", 403);
  }
}

function assertCallbackBinding(row: Authorization, input: ShopifyStaffOAuthClaimInput): void {
  assertActorBinding(row, input);
  if (row.stateHash !== input.stateHash || row.configFingerprint !== input.configFingerprint
    || row.shopDomain !== input.shopDomain) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHORIZATION_INVALID", 403);
  }
}

function assertClaimBinding(row: Authorization, claim: ShopifyStaffOAuthClaim): void {
  assertActorBinding(row, claim);
  if (row.operationId !== claim.operationId || row.stateHash !== claim.stateHash
    || row.configFingerprint !== claim.configFingerprint || row.shopDomain !== claim.shopDomain
    || row.channelId !== claim.channelId || row.connectionId !== claim.connectionId
    || row.connectionFingerprint !== claim.connectionFingerprint
    || row.createdAt.getTime() !== claim.createdAt.getTime()
    || row.expiresAt.getTime() !== claim.expiresAt.getTime() || row.attemptId !== claim.attemptId) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_ATTEMPT_INVALID", 409);
  }
}

/** No provider work occurs here. Privileged changes recheck current Identity
 * authority with identity -> connection -> authorization lock ordering. An
 * already accepted attempt may only record its terminal failure after revocation. */
export class PostgresShopifyStaffOAuthRepository implements ShopifyStaffOAuthRepository {
  constructor(private readonly db: ShopifyStaffOAuthDatabase, private readonly readAuthority: ReadAuthority) {}

  private async authorize(tx: ShopifyStaffOAuthTransaction, actorId: string): Promise<void> {
    const actor = await this.readAuthority(tx, actorId);
    if (!actor.active || !actor.permissions.includes("channels:edit")) {
      throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_FORBIDDEN", 403);
    }
  }

  private async connection(tx: ShopifyStaffOAuthTransaction, shopDomain: string, channelId?: number,
    lifecycleFailureOutcome: "failed" | "exchange_unknown" = "failed"): Promise<Connection> {
    const rows = await tx.execute(sql`
      SELECT channel.id AS "channelId", connection.id AS "connectionId", channel.provider,
        lower(btrim(connection.shop_domain)) AS "shopDomain",
        connection.access_token AS "accessToken", connection.refresh_token AS "refreshToken",
        connection.expires_at AS "expiresAt",
        connection.scopes, connection.api_version AS "apiVersion",
        connection.webhook_secret AS "webhookSecret", connection.shopify_location_id AS "shopifyLocationId"
      FROM channels.channels channel
      JOIN channels.channel_connections connection ON connection.channel_id=channel.id
      WHERE channel.provider='shopify' AND lower(btrim(connection.shop_domain))=${shopDomain}
        ${channelId === undefined ? sql`` : sql`AND channel.id=${channelId}`}
      ORDER BY channel.id,connection.id LIMIT 2 FOR UPDATE OF channel,connection
    `);
    // Never let row order resolve a duplicate shop/channel mapping. A token may
    // be absent: this same boundary supports the initial configured connection.
    if (rows.rows.length !== 1) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONNECTION_UNRESOLVED", 409);
    const parsed = connectionSchema.safeParse(rows.rows[0]);
    if (!parsed.success) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONNECTION_UNRESOLVED", 409);
    // This bounded flow replaces non-expiring offline tokens only. Preserving an
    // unrelated refresh token/expiry beside a replacement access token would
    // leave an incoherent lifecycle. Supporting that lifecycle is separate work.
    if (parsed.data.refreshToken !== null || parsed.data.expiresAt !== null) {
      throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_LIFECYCLE_UNSUPPORTED", 409, lifecycleFailureOutcome);
    }
    return parsed.data;
  }

  private async readState(tx: ShopifyStaffOAuthTransaction, stateHash: string, lock = false): Promise<Authorization | null> {
    const rows = await tx.execute(sql`SELECT ${authorizationColumns}
      FROM channels.shopify_oauth_authorizations WHERE state_hash=${stateHash} ${lock ? sql`FOR UPDATE` : sql``}`);
    if (rows.rows.length === 0) return null;
    return rowSchema.parse(rows.rows[0]);
  }

  private async lockRecordedConnection(tx: ShopifyStaffOAuthTransaction, channelId: number, connectionId: number): Promise<void> {
    // Failure/outcome record the historical attempt, not permission to replace a
    // credential. A changed or deleted connection must not prevent recording its
    // unknown outcome. Preserve lock ordering when the live connection still exists.
    await tx.execute(sql`SELECT connection.id
      FROM channels.channels channel
      JOIN channels.channel_connections connection ON connection.channel_id=channel.id
      WHERE channel.id=${channelId} AND connection.id=${connectionId}
      FOR UPDATE OF channel,connection`);
  }

  private async audit(tx: ShopifyStaffOAuthTransaction, action: string, row: Authorization,
    actorId: string, now: Date, beforeStatus: Authorization["status"] | null,
    extra: Record<string, string | boolean | null> = {}): Promise<void> {
    await persistAuditEvent(tx, {
      actor: actorId, action: `channels.shopify_oauth.${action}`,
      target: `channel_connection:${row.connectionId}`,
      changes: { before: beforeStatus === null ? null : { status: beforeStatus }, after: { status: row.status } },
      context: {
        operationId: row.operationId, attemptId: row.attemptId, channelId: row.channelId,
        connectionId: row.connectionId, shopDomain: row.shopDomain, code: row.errorCode, ...extra,
      },
    }, { timestamp: now, emitStructuredLog: false });
  }

  async create(raw: ShopifyStaffOAuthCreate): Promise<ShopifyStaffOAuthBinding> {
    const input = parse(createSchema, raw);
    const lifetime = input.expiresAt.getTime() - input.now.getTime();
    if (lifetime <= 0 || lifetime > 10 * 60_000) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXPIRY_INVALID", 400);
    return this.db.transaction(async tx => {
      await this.authorize(tx, input.actorId);
      const connection = await this.connection(tx, input.shopDomain, input.requestedChannelId);
      const previous = await tx.execute(sql`SELECT ${authorizationColumns}
        FROM channels.shopify_oauth_authorizations
        WHERE connection_id=${connection.connectionId} AND status IN ('issued','exchanging')
        ORDER BY operation_id FOR UPDATE`);
      for (const value of previous.rows) {
        const old = rowSchema.parse(value);
        if (input.now.getTime() < old.createdAt.getTime()
          || (old.startedAt && input.now.getTime() < old.startedAt.getTime())) {
          throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CLOCK_INVALID", 409);
        }
        const updated = await tx.execute(sql`UPDATE channels.shopify_oauth_authorizations
          SET status='superseded',completed_at=${input.now},error_code='SHOPIFY_OAUTH_SUPERSEDED'
          WHERE operation_id=${old.operationId} AND status IN ('issued','exchanging')
          RETURNING ${authorizationColumns}`);
        const superseded = rowSchema.parse(updated.rows[0]);
        await this.audit(tx, "superseded", superseded, input.actorId, input.now, old.status,
          { replacementOperationId: input.operationId });
      }
      const inserted = await tx.execute(sql`INSERT INTO channels.shopify_oauth_authorizations
        (operation_id,state_hash,actor_id,session_hash,config_fingerprint,shop_domain,channel_id,
         connection_id,connection_fingerprint,created_at,expires_at,status)
        VALUES (${input.operationId},${input.stateHash},${input.actorId},${input.sessionHash},
          ${input.configFingerprint},${input.shopDomain},${connection.channelId},${connection.connectionId},
          ${fingerprint(connection)},${input.now},${input.expiresAt},'issued')
        RETURNING ${authorizationColumns}`);
      const row = rowSchema.parse(inserted.rows[0]);
      await this.audit(tx, "issued", row, input.actorId, input.now, null);
      return binding(row);
    });
  }

  async claim(raw: ShopifyStaffOAuthClaimInput): Promise<ShopifyStaffOAuthClaimResult> {
    const input = parse(claimInputSchema, raw);
    return this.db.transaction(async tx => {
      await this.authorize(tx, input.actorId);
      // This preliminary read acquires no row lock. Binding is immutable and is
      // checked again after the connection and authorization locks are held.
      const found = await this.readState(tx, input.stateHash);
      if (!found) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHORIZATION_INVALID", 403);
      assertCallbackBinding(found, input);
      const connection = await this.connection(tx, found.shopDomain, found.channelId);
      const row = await this.readState(tx, input.stateHash, true);
      if (!row) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHORIZATION_INVALID", 403);
      assertCallbackBinding(row, input);
      if (row.status !== "issued") return { kind: "result", result: result(row, true, input.now) };
      if (row.connectionId !== connection.connectionId || row.connectionFingerprint !== fingerprint(connection)) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONNECTION_CHANGED", 409);
      }
      if (input.now.getTime() < row.createdAt.getTime() || input.now.getTime() >= row.expiresAt.getTime()) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHORIZATION_EXPIRED", 403);
      }
      const updated = await tx.execute(sql`UPDATE channels.shopify_oauth_authorizations
        SET status='exchanging',attempt_id=${input.attemptId},started_at=${input.now}
        WHERE operation_id=${row.operationId} AND status='issued'
        RETURNING ${authorizationColumns}`);
      const claimed = rowSchema.parse(updated.rows[0]);
      await this.audit(tx, "claimed", claimed, input.actorId, input.now, "issued");
      return { kind: "claimed", claim: { ...binding(claimed), attemptId: input.attemptId } };
    });
  }

  async complete(rawClaim: ShopifyStaffOAuthClaim, rawToken: ShopifyStaffOAuthToken, rawNow: Date): Promise<ShopifyStaffOAuthResult> {
    const claim = parse(claimSchema, rawClaim);
    const token = parse(tokenSchema, rawToken);
    const now = parse(instant, rawNow);
    return this.db.transaction(async tx => {
      await this.authorize(tx, claim.actorId);
      const connection = await this.connection(tx, claim.shopDomain, claim.channelId, "exchange_unknown");
      const row = await this.readState(tx, claim.stateHash, true);
      if (!row) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_ATTEMPT_INVALID", 409);
      assertClaimBinding(row, claim);
      if (row.status !== "exchanging") return result(row);
      if (row.connectionId !== connection.connectionId || row.connectionFingerprint !== fingerprint(connection)) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONNECTION_CHANGED", 409, "exchange_unknown");
      }
      if (!row.startedAt || row.startedAt.getTime() >= row.expiresAt.getTime()
        || now.getTime() < row.startedAt.getTime()) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CLOCK_INVALID", 409, "exchange_unknown");
      }
      const changed = await tx.execute(sql`UPDATE channels.channel_connections
        SET access_token=${token.accessToken},scopes=${token.scopes},updated_at=${now}
        WHERE id=${claim.connectionId} AND channel_id=${claim.channelId} RETURNING id`);
      if (changed.rows.length !== 1) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONNECTION_CHANGED", 409, "exchange_unknown");
      const updated = await tx.execute(sql`UPDATE channels.shopify_oauth_authorizations
        SET status='succeeded',completed_at=${now}
        WHERE operation_id=${row.operationId} AND status='exchanging' AND attempt_id=${claim.attemptId}
        RETURNING ${authorizationColumns}`);
      const completed = rowSchema.parse(updated.rows[0]);
      await this.audit(tx, "connected", completed, claim.actorId, now, "exchanging", { credentialsReplaced: true });
      return result(completed, false);
    });
  }

  async fail(rawClaim: ShopifyStaffOAuthClaim, rawStatus: "exchange_unknown" | "failed", rawCode: string, rawNow: Date): Promise<void> {
    const claim = parse(claimSchema, rawClaim);
    const status = parse(z.enum(["exchange_unknown", "failed"]), rawStatus);
    const code = parse(z.string().regex(/^[A-Z][A-Z0-9_]{0,99}$/), rawCode);
    const now = parse(instant, rawNow);
    await this.db.transaction(async tx => {
      // Revocation blocks credential writes, not evidence of work already
      // authorized and dispatched. The immutable claim + single attempt token
      // fence this completion. This method cannot replace credentials, issue a
      // challenge, reclaim an attempt, or grant permission. No HTTP endpoint
      // accepts a claim from a caller.
      await this.lockRecordedConnection(tx, claim.channelId, claim.connectionId);
      const row = await this.readState(tx, claim.stateHash, true);
      if (!row) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_ATTEMPT_INVALID", 409);
      assertClaimBinding(row, claim);
      // A late error must never downgrade success or touch newer intent.
      if (row.status !== "exchanging") return;
      if (!row.startedAt || now.getTime() < row.startedAt.getTime()) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CLOCK_INVALID", 409, "exchange_unknown");
      }
      const updated = await tx.execute(sql`UPDATE channels.shopify_oauth_authorizations
        SET status=${status},completed_at=${now},error_code=${code}
        WHERE operation_id=${row.operationId} AND status='exchanging' AND attempt_id=${claim.attemptId}
        RETURNING ${authorizationColumns}`);
      await this.audit(tx, status, rowSchema.parse(updated.rows[0]), claim.actorId, now, "exchanging",
        { completionAuthority: "accepted_attempt" });
    });
  }

  async outcome(raw: ShopifyStaffOAuthClaimInput): Promise<ShopifyStaffOAuthResult | null> {
    const input = parse(claimInputSchema, raw);
    return this.db.transaction(async tx => {
      await this.authorize(tx, input.actorId);
      const found = await this.readState(tx, input.stateHash);
      if (!found) return null;
      assertCallbackBinding(found, input);
      await this.lockRecordedConnection(tx, found.channelId, found.connectionId);
      const row = await this.readState(tx, input.stateHash, true);
      if (!row) return null;
      assertCallbackBinding(row, input);
      return result(row, true, input.now);
    });
  }
}
