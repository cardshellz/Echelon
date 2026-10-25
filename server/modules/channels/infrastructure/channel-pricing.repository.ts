import { and, asc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import {
  channelPricing, channelPricingRules, channels, products, productTypes, productVariants,
  type ChannelPricing, type ChannelPricingRule,
} from "@shared/schema";
import type { db } from "../../../db";
import { persistAuditEvent, type AuditLogPayload } from "../../../infrastructure/auditLogger";
import { ChannelPricingError, type PricingRuleTarget, type SaveChannelPrice, type SaveChannelPricingRule } from "../channel-pricing.domain";
import type { ChannelPricingStore, ChannelPricingTransaction, ListedChannelPricingRule, StoredChannelPrice } from "../channel-pricing.store";

export type ChannelPricingDatabase = Pick<typeof db, "select" | "transaction">;
type Transaction = Parameters<Parameters<ChannelPricingDatabase["transaction"]>[0]>[0];

export class PgChannelPricingRepository implements ChannelPricingStore {
  constructor(private readonly database: ChannelPricingDatabase) {}

  async listRules(channelId: number): Promise<ListedChannelPricingRule[]> {
    // String equality deliberately avoids casting corrupt historical scope IDs
    // to integers and turning the entire rule editor into an HTTP 500.
    return this.database.select({
      ...getTableColumns(channelPricingRules),
      scopeLabel: sql<string | null>`CASE ${channelPricingRules.scope}
        WHEN 'product' THEN (SELECT name FROM catalog.products WHERE id::text=${channelPricingRules.scopeId})
        WHEN 'variant' THEN (SELECT name || ' (' || sku || ')' FROM catalog.product_variants WHERE id::text=${channelPricingRules.scopeId})
        WHEN 'category' THEN (SELECT name FROM catalog.product_types WHERE slug=${channelPricingRules.scopeId})
        ELSE NULL END`,
    }).from(channelPricingRules).where(eq(channelPricingRules.channelId, channelId)).orderBy(
      sql`CASE ${channelPricingRules.scope} WHEN 'variant' THEN 1 WHEN 'product' THEN 2 WHEN 'category' THEN 3 ELSE 4 END`,
      asc(channelPricingRules.createdAt),
    );
  }

  async withChannel<T>(channelId: number, work: (transaction: ChannelPricingTransaction) => Promise<T>): Promise<T> {
    return this.database.transaction(async transaction => {
      const channel = await transaction.select({ id: channels.id }).from(channels)
        .where(eq(channels.id, channelId)).for("update");
      if (channel.length !== 1) throw new ChannelPricingError("CHANNEL_PRICING_CHANNEL_MISSING",
        "The selected sales channel no longer exists. Reload Channels before saving pricing.", 404, { channelId });
      // Every pricing writer locks the same channel before reading previous
      // state. This includes first inserts, deletes and legacy route adapters.
      return work(new PgChannelPricingTransaction(transaction, channelId));
    });
  }
}

class PgChannelPricingTransaction implements ChannelPricingTransaction {
  constructor(private readonly transaction: Transaction, private readonly channelId: number) {}

  async targetExists(target: PricingRuleTarget): Promise<boolean> {
    if (target.scope === "channel") return true;
    if (target.scope === "category") {
      const rows = await this.transaction.select({ id: productTypes.id }).from(productTypes)
        .where(eq(productTypes.slug, target.scopeId!)).for("key share");
      return rows.length === 1;
    }
    if (target.scope === "product") {
      const rows = await this.transaction.select({ id: products.id }).from(products)
        .where(eq(products.id, Number(target.scopeId))).for("key share");
      return rows.length === 1;
    }
    const rows = await this.transaction.select({ id: productVariants.id }).from(productVariants)
      .where(eq(productVariants.id, Number(target.scopeId))).for("key share");
    return rows.length === 1;
  }

  async rule(target: PricingRuleTarget): Promise<ChannelPricingRule | null> {
    const rows = await this.transaction.select().from(channelPricingRules).where(and(
      eq(channelPricingRules.channelId, this.channelId), eq(channelPricingRules.scope, target.scope),
      target.scopeId === null ? isNull(channelPricingRules.scopeId) : eq(channelPricingRules.scopeId, target.scopeId),
    )).for("update");
    if (rows.length > 1) throw new ChannelPricingError("CHANNEL_PRICING_RULE_AMBIGUOUS",
      "Multiple pricing rules exist for this selection. Resolve the conflicting rules before saving.", 409,
      { channelId: this.channelId, ...target });
    return rows[0] ?? null;
  }

  async ruleById(id: number): Promise<ChannelPricingRule | null> {
    const rows = await this.transaction.select().from(channelPricingRules)
      .where(and(eq(channelPricingRules.id, id), eq(channelPricingRules.channelId, this.channelId))).for("update");
    return rows[0] ?? null;
  }

  async saveRule(command: SaveChannelPricingRule, now: Date): Promise<ChannelPricingRule> {
    const row = { channelId: this.channelId, scope: command.scope, scopeId: command.scopeId,
      ruleType: command.ruleType, value: command.value, createdAt: now, updatedAt: now };
    const changed = { ruleType: command.ruleType, value: command.value, updatedAt: now };
    const insert = this.transaction.insert(channelPricingRules).values(row);
    // Match the actual two production partial indexes, including predicates.
    const result = command.scopeId === null
      ? await insert.onConflictDoUpdate({
        target: [channelPricingRules.channelId, channelPricingRules.scope],
        targetWhere: sql`${channelPricingRules.scopeId} IS NULL`, set: changed,
      }).returning()
      : await insert.onConflictDoUpdate({
        target: [channelPricingRules.channelId, channelPricingRules.scope, channelPricingRules.scopeId],
        targetWhere: sql`${channelPricingRules.scopeId} IS NOT NULL`, set: changed,
      }).returning();
    return result[0];
  }

  async deleteRule(id: number): Promise<boolean> {
    const rows = await this.transaction.delete(channelPricingRules).where(and(
      eq(channelPricingRules.channelId, this.channelId), eq(channelPricingRules.id, id),
    )).returning({ id: channelPricingRules.id });
    return rows.length === 1;
  }

  async price(variantId: number): Promise<StoredChannelPrice | null> {
    const rows = await this.transaction.select({
      ...getTableColumns(channelPricing),
      price: sql<string>`${channelPricing.price}::text`,
      compareAtPrice: sql<string | null>`${channelPricing.compareAtPrice}::text`,
      cost: sql<string | null>`${channelPricing.cost}::text`,
    }).from(channelPricing).where(and(
      eq(channelPricing.channelId, this.channelId), eq(channelPricing.productVariantId, variantId),
    )).for("update");
    if (rows.length > 1) throw new ChannelPricingError("CHANNEL_PRICE_AMBIGUOUS",
      "Multiple explicit prices exist for this channel variant. Resolve the conflicting prices before saving.", 409,
      { channelId: this.channelId, variantId });
    return rows[0] ?? null;
  }

  async savePrice(variantId: number, command: SaveChannelPrice, now: Date): Promise<ChannelPricing> {
    const rows = await this.transaction.insert(channelPricing).values({
      channelId: this.channelId, productVariantId: variantId, ...command, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [channelPricing.channelId, channelPricing.productVariantId],
      set: { ...command, updatedAt: now },
    }).returning();
    return rows[0];
  }

  async deletePrice(variantId: number): Promise<boolean> {
    const rows = await this.transaction.delete(channelPricing).where(and(
      eq(channelPricing.channelId, this.channelId), eq(channelPricing.productVariantId, variantId),
    )).returning({ id: channelPricing.id });
    return rows.length === 1;
  }

  async audit(payload: AuditLogPayload, now: Date): Promise<void> {
    await persistAuditEvent(this.transaction, payload, { timestamp: now, emitStructuredLog: false });
  }
}
