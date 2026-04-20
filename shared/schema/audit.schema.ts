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
