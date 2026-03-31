import { pgSchema, text, varchar, integer, timestamp, boolean, numeric } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Explicit PostgreSQL Namespace for the Membership/Rewards Pillar
export const membershipSchema = pgSchema("membership");

// ============================================
// MEMBERS
// ============================================

export const members = membershipSchema.table("members", {
  id: varchar("id").primaryKey(),
  email: text("email"),
  firstName: text("first_name"),
  lastName: text("last_name"),
  status: text("status"),
  shopifyCustomerId: varchar("shopify_customer_id"),
  tier: varchar("tier"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMemberSchema = createInsertSchema(members);
export type Member = typeof members.$inferSelect;
export type InsertMember = z.infer<typeof insertMemberSchema>;

// ============================================
// PLANS
// ============================================

export const plans = membershipSchema.table("plans", {
  id: varchar("id").primaryKey(),
  name: text("name"),
  tierLevel: integer("tier_level"),
  
  // DYNAMIC CONFIG: The priority modifier subtracted/added to the base shipping score
  priorityModifier: integer("priority_modifier").notNull().default(5),
  
  priceCents: integer("price_cents"),
  billingInterval: text("billing_interval"),
  billingIntervalCount: integer("billing_interval_count"),
  shopifySellingPlanId: varchar("shopify_selling_plan_id"),
  shopifySellingPlanGid: varchar("shopify_selling_plan_gid"),
  includesDropship: boolean("includes_dropship"),
  isActive: boolean("is_active"),
});

export const insertPlanSchema = createInsertSchema(plans);
export type Plan = typeof plans.$inferSelect;
export type InsertPlan = z.infer<typeof insertPlanSchema>;

// ============================================
// MEMBER SUBSCRIPTIONS
// ============================================

export const memberSubscriptions = membershipSchema.table("member_subscriptions", {
  id: varchar("id").primaryKey(),
  memberId: varchar("member_id").references(() => members.id),
  planId: varchar("plan_id").references(() => plans.id),
  status: text("status"),
  billingInterval: text("billing_interval"),
  cycleStartedAt: timestamp("cycle_started_at"),
  shopifySubscriptionContractId: varchar("shopify_subscription_contract_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMemberSubscriptionSchema = createInsertSchema(memberSubscriptions);
export type MemberSubscription = typeof memberSubscriptions.$inferSelect;
export type InsertMemberSubscription = z.infer<typeof insertMemberSubscriptionSchema>;
