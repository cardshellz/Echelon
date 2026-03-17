/**
 * eBay-Specific Schema
 *
 * Tables specifically needed for eBay channel integration
 * that don't fit in the generic channels schema.
 */

import { pgTable, text, varchar, integer, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import { channels } from "./channels.schema";

// ---------------------------------------------------------------------------
// eBay OAuth Tokens — rotating token storage
// ---------------------------------------------------------------------------

/**
 * Stores eBay OAuth2 tokens with support for token rotation.
 *
 * CRITICAL: eBay refresh tokens change on every refresh call.
 * The new refresh token must be persisted immediately or access is lost.
 * One row per channel + environment combination.
 */
export const ebayOauthTokens = pgTable("ebay_oauth_tokens", {
  id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
  channelId: integer("channel_id").notNull().references(() => channels.id, { onDelete: "cascade" }),
  environment: varchar("environment", { length: 20 }).notNull().default("production"), // sandbox | production
  accessToken: text("access_token").notNull(),
  accessTokenExpiresAt: timestamp("access_token_expires_at").notNull(),
  refreshToken: text("refresh_token").notNull(),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"), // ~18 months from issuance
  scopes: text("scopes"), // Space-separated OAuth scopes
  lastRefreshedAt: timestamp("last_refreshed_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("ebay_oauth_tokens_channel_env_idx").on(table.channelId, table.environment),
]);

export const insertEbayOauthTokenSchema = createInsertSchema(ebayOauthTokens).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertEbayOauthToken = z.infer<typeof insertEbayOauthTokenSchema>;
export type EbayOauthToken = typeof ebayOauthTokens.$inferSelect;
