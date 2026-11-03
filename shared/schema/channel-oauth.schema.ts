import { sql } from "drizzle-orm";
import { check, index, timestamp, uniqueIndex, uuid, varchar, integer } from "drizzle-orm/pg-core";
import { channelsSchema } from "./channels.schema";

/** Channels owns operator authorization; no raw OAuth codes, states or tokens are retained here. */
export const shopifyOAuthAuthorizations = channelsSchema.table("shopify_oauth_authorizations", {
  operationId: uuid("operation_id").primaryKey(),
  stateHash: varchar("state_hash", { length: 64 }).notNull(),
  // Historical IDs: the migration verifies actor/connection existence under
  // key-share locks at issuance, without preventing their later legitimate deletion.
  actorId: varchar("actor_id").notNull(),
  sessionHash: varchar("session_hash", { length: 64 }).notNull(),
  configFingerprint: varchar("config_fingerprint", { length: 64 }).notNull(),
  shopDomain: varchar("shop_domain", { length: 255 }).notNull(),
  channelId: integer("channel_id").notNull(),
  connectionId: integer("connection_id").notNull(),
  connectionFingerprint: varchar("connection_fingerprint", { length: 64 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  status: varchar("status", { length: 24 }).notNull().default("issued"),
  attemptId: uuid("attempt_id"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  errorCode: varchar("error_code", { length: 100 }),
}, table => [
  uniqueIndex("shopify_oauth_authorizations_state_uq").on(table.stateHash),
  uniqueIndex("shopify_oauth_authorizations_attempt_uq").on(table.attemptId),
  uniqueIndex("shopify_oauth_authorizations_active_connection_uq").on(table.connectionId)
    .where(sql`${table.status} IN ('issued','exchanging')`),
  index("shopify_oauth_authorizations_expiry_idx").on(table.expiresAt),
  check("shopify_oauth_authorizations_hashes_chk", sql`${table.stateHash} ~ '^[a-f0-9]{64}$'
    AND ${table.sessionHash} ~ '^[a-f0-9]{64}$' AND ${table.configFingerprint} ~ '^[a-f0-9]{64}$'
    AND ${table.connectionFingerprint} ~ '^[a-f0-9]{64}$'`),
  check("shopify_oauth_authorizations_shop_chk", sql`${table.shopDomain} ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?[.]myshopify[.]com$'`),
  check("shopify_oauth_authorizations_expiry_chk", sql`${table.expiresAt} > ${table.createdAt}
    AND ${table.expiresAt} <= ${table.createdAt} + interval '10 minutes'`),
  check("shopify_oauth_authorizations_error_chk", sql`${table.errorCode} IS NULL OR ${table.errorCode} ~ '^[A-Z][A-Z0-9_]{0,99}$'`),
  check("shopify_oauth_authorizations_status_chk", sql`${table.status} IN
    ('issued','exchanging','succeeded','exchange_unknown','failed','superseded')`),
  check("shopify_oauth_authorizations_lifecycle_chk", sql`
    (${table.status} = 'issued' AND ${table.attemptId} IS NULL AND ${table.startedAt} IS NULL
      AND ${table.completedAt} IS NULL AND ${table.errorCode} IS NULL)
    OR (${table.status} = 'exchanging' AND ${table.attemptId} IS NOT NULL AND ${table.startedAt} IS NOT NULL
      AND ${table.completedAt} IS NULL AND ${table.errorCode} IS NULL)
    OR (${table.status} = 'succeeded' AND ${table.attemptId} IS NOT NULL AND ${table.startedAt} IS NOT NULL
      AND ${table.completedAt} IS NOT NULL AND ${table.errorCode} IS NULL)
    OR (${table.status} IN ('failed','exchange_unknown') AND ${table.attemptId} IS NOT NULL
      AND ${table.startedAt} IS NOT NULL AND ${table.completedAt} IS NOT NULL AND ${table.errorCode} IS NOT NULL)
    OR (${table.status} = 'superseded' AND ${table.completedAt} IS NOT NULL AND ${table.errorCode} IS NOT NULL
      AND ((${table.attemptId} IS NULL AND ${table.startedAt} IS NULL)
        OR (${table.attemptId} IS NOT NULL AND ${table.startedAt} IS NOT NULL)))`),
  check("shopify_oauth_authorizations_times_chk", sql`
    (${table.startedAt} IS NULL OR (${table.startedAt} >= ${table.createdAt} AND ${table.startedAt} < ${table.expiresAt}))
    AND (${table.completedAt} IS NULL OR ${table.completedAt} >= coalesce(${table.startedAt}, ${table.createdAt}))`),
]);

export type ShopifyOAuthAuthorizationRow = typeof shopifyOAuthAuthorizations.$inferSelect;
