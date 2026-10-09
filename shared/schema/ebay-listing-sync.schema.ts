import {
  bigint,
  bigserial,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { products } from "./catalog.schema";
import {
  channels,
  channelConnections,
  channelsSchema,
} from "./channels.schema";

// Migration 0729 additionally enforces immutable audit and session ownership.
export const ebayListingSyncJobs = channelsSchema.table(
  "ebay_listing_sync_jobs",
  {
    id: uuid("id").primaryKey(),
    channelId: integer("channel_id")
      .notNull()
      .references(() => channels.id),
    connectionId: integer("connection_id")
      .notNull()
      .references(() => channelConnections.id),
    productId: integer("product_id")
      .notNull()
      .references(() => products.id),
    identity: jsonb("identity").notNull(),
    identityHash: text("identity_hash").notNull(),
    state: text("state").notNull().default("queued"),
    revision: bigint("revision", { mode: "bigint" })
      .notNull()
      .default(sql`1`),
    claimedRevision: bigint("claimed_revision", { mode: "bigint" }),
    ownerToken: uuid("owner_token"),
    attempts: integer("attempts").notNull().default(0),
    requestedBy: text("requested_by").notNull(),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    result: jsonb("result"),
    nextAttemptAt: timestamp("next_attempt_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("ebay_listing_sync_one_active")
      .on(table.channelId, table.productId)
      .where(
        sql`${table.state} IN ('queued','running','recovering','awaiting_evidence')`,
      ),
    index("ebay_listing_sync_due")
      .on(table.nextAttemptAt, table.id)
      .where(
        sql`${table.state} IN ('queued','running','recovering','awaiting_evidence')`,
      ),
    index("ebay_listing_sync_latest").on(
      table.channelId,
      table.productId,
      table.updatedAt.desc(),
      table.id.desc(),
    ),
    check(
      "ebay_listing_sync_jobs_state_check",
      sql`${table.state} IN ('queued','running','recovering','awaiting_evidence','completed','needs_attention')`,
    ),
    check("ebay_listing_sync_jobs_revision_check", sql`${table.revision} > 0`),
    check(
      "ebay_listing_sync_jobs_claimed_revision_check",
      sql`${table.claimedRevision} > 0 AND ${table.claimedRevision} <= ${table.revision}`,
    ),
    check(
      "ebay_listing_sync_jobs_check",
      sql`(${table.state} = 'running') = (${table.ownerToken} IS NOT NULL AND ${table.claimedRevision} IS NOT NULL)`,
    ),
  ],
);
export const ebayListingSyncCommands = channelsSchema.table(
  "ebay_listing_sync_commands",
  {
    commandKey: uuid("command_key").primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => ebayListingSyncJobs.id),
    identityHash: text("identity_hash").notNull(),
    actor: text("actor").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);
export const ebayListingSyncEvents = channelsSchema.table(
  "ebay_listing_sync_events",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => ebayListingSyncJobs.id),
    revision: bigint("revision", { mode: "bigint" }).notNull(),
    event: text("event").notNull(),
    ownerToken: uuid("owner_token"),
    evidence: jsonb("evidence").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
);
