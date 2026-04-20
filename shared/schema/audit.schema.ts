import { pgTable, text, timestamp, jsonb, bigserial } from "drizzle-orm/pg-core";

export const auditEvents = pgTable("audit_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  timestamp: timestamp("timestamp", { withTimezone: true }).defaultNow().notNull(),
  level: text("level").default("AUDIT").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target"),
  changes: jsonb("changes"),
  context: jsonb("context"),
});

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  requestHash: text("request_hash").notNull(),
  responseBody: jsonb("response_body"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});
