import type { ChannelPricing, ChannelPricingRule } from "@shared/schema";
import {
  ChannelPricingError, expectedPricingRuleSchema, parsePricingContext, parsePricingId,
  pricingRuleValueSchema, saveChannelPriceSchema, saveChannelPricingRuleSchema,
  expectedChannelPriceSchema,
  type ExpectedPricingRule,
  type ExpectedChannelPrice,
} from "./channel-pricing.domain";
import type { ChannelPricingStore, ChannelPricingTransaction, ListedChannelPricingRule, StoredChannelPrice } from "./channel-pricing.store";
import { PgChannelPricingRepository, type ChannelPricingDatabase } from "./infrastructure/channel-pricing.repository";

export type { ExpectedChannelPrice } from "./channel-pricing.domain";

/** Channels is the sole command owner for hierarchical rules and explicit prices.
 * The existing database trigger captures propagation in these same transactions;
 * adapters must not enqueue a second sync or call a marketplace provider here.
 */
export class ChannelPricingService {
  constructor(private readonly store: ChannelPricingStore) {}

  listRules(channelId: number): Promise<ListedChannelPricingRule[]> {
    return this.store.listRules(parsePricingId(channelId));
  }

  async saveRule(channelId: number, input: unknown, actor: string, now: Date): Promise<ChannelPricingRule> {
    const context = parsePricingContext(channelId, actor, now);
    const command = saveChannelPricingRuleSchema.parse(input);
    if (command.ruleType === "override" && command.value === "0.00") {
      throw new ChannelPricingError("CHANNEL_PRICING_VALUE_INVALID", "A fixed selling price must be greater than zero.", 400);
    }
    return this.store.withChannel(context.channelId, async transaction => {
      if (!await transaction.targetExists(command)) throw new ChannelPricingError("CHANNEL_PRICING_TARGET_MISSING",
        "The selected product type, product or variant no longer exists. Reload the pricing editor and select it again.", 404,
        { channelId, scope: command.scope, scopeId: command.scopeId });
      const before = await transaction.rule(command);
      // An identical replay is successful, even after a lost response. It cannot
      // overwrite another value or create another audit/propagation obligation.
      if (before && sameRule(before, command)) return before;
      assertExpectedRule(before, command.expected);
      const after = await transaction.saveRule(command, context.now);
      await audit(transaction, context, "rule_saved", `rule:${after.id}`, before, after);
      return after;
    });
  }

  async deleteRule(channelId: number, ruleId: number, actor: string, now: Date, expected?: unknown): Promise<boolean> {
    const context = parsePricingContext(channelId, actor, now);
    const id = parsePricingId(ruleId);
    const expectation = expectedPricingRuleSchema.nullable().optional().parse(expected);
    return this.store.withChannel(context.channelId, async transaction => {
      const before = await transaction.ruleById(id);
      if (!before) return false;
      assertExpectedRule(before, expectation);
      const deleted = await transaction.deleteRule(id);
      await audit(transaction, context, "rule_deleted", `rule:${id}`, before, null);
      return deleted;
    });
  }

  async savePrice(channelId: number, variantId: number, input: unknown, actor: string, now: Date, expected?: ExpectedChannelPrice | null):
    Promise<{ price: ChannelPricing; created: boolean }> {
    const context = parsePricingContext(channelId, actor, now);
    const id = parsePricingId(variantId);
    const command = saveChannelPriceSchema.parse(input);
    const expectation = expectedChannelPriceSchema.nullable().optional().parse(expected);
    return this.store.withChannel(context.channelId, async transaction => {
      if (!await transaction.targetExists({ scope: "variant", scopeId: String(id) })) {
        throw new ChannelPricingError("CHANNEL_PRICING_TARGET_MISSING",
          "The selected variant no longer exists. Reload the pricing editor before saving.", 404, { channelId, variantId: id });
      }
      const before = await transaction.price(id);
      const resolved = saveChannelPriceSchema.parse({
        price: command.price,
        compareAtPrice: command.compareAtPrice === undefined
          ? retainedCents(before?.compareAtPrice ?? null, "compare-at price") : command.compareAtPrice,
        cost: command.cost === undefined ? retainedCents(before?.cost ?? null, "cost") : command.cost,
        currency: command.currency ?? before?.currency ?? "USD",
      });
      if (before && before.price === String(resolved.price)
        && before.compareAtPrice === (resolved.compareAtPrice === null ? null : String(resolved.compareAtPrice))
        && before.cost === (resolved.cost === null ? null : String(resolved.cost)) && before.currency === resolved.currency) {
        return { price: { ...before, ...resolved, compareAtPrice: resolved.compareAtPrice ?? null,
          cost: resolved.cost ?? null, currency: resolved.currency ?? "USD" }, created: false };
      }
      if (expectation !== undefined && (expectation === null ? before !== null : !before
        || before.price !== expectation.price || before.compareAtPrice !== expectation.compareAtPrice || before.currency !== expectation.currency)) {
        throw new ChannelPricingError("CHANNEL_PRICING_CONFLICT", "This channel price changed after the Shopify creation review. Refresh and review the current price before continuing.", 409);
      }
      const price = await transaction.savePrice(id, resolved, context.now);
      await audit(transaction, context, "price_saved", `variant:${id}`, before, exactPriceSnapshot(price));
      return { price, created: before === null };
    });
  }

  async deletePrice(channelId: number, variantId: number, actor: string, now: Date): Promise<boolean> {
    const context = parsePricingContext(channelId, actor, now);
    const id = parsePricingId(variantId);
    return this.store.withChannel(context.channelId, async transaction => {
      const before = await transaction.price(id);
      if (!before) return false;
      const deleted = await transaction.deletePrice(id);
      await audit(transaction, context, "price_deleted", `variant:${id}`, before, null);
      return deleted;
    });
  }
}

function retainedCents(value: string | null, field: string): number | null {
  if (value === null) return null;
  if (!/^\d+$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ChannelPricingError("CHANNEL_PRICE_STORED_VALUE_INVALID",
      `The saved ${field} is outside the supported range. Enter a valid amount or clear it before saving.`, 409);
  }
  return Number(value);
}

function exactPriceSnapshot(price: ChannelPricing): StoredChannelPrice {
  return { ...price, price: String(price.price), compareAtPrice: price.compareAtPrice === null ? null : String(price.compareAtPrice),
    cost: price.cost === null ? null : String(price.cost) };
}

function sameRule(row: Pick<ChannelPricingRule, "ruleType" | "value">, expected: Pick<ExpectedPricingRule, "ruleType" | "value">): boolean {
  const actualValue = pricingRuleValueSchema.safeParse(row.value);
  const expectedValue = pricingRuleValueSchema.safeParse(expected.value);
  const equalValue = actualValue.success && expectedValue.success
    ? actualValue.data === expectedValue.data
    : row.value === expected.value;
  return row.ruleType === expected.ruleType && equalValue;
}

function assertExpectedRule(before: ChannelPricingRule | null, expected: ExpectedPricingRule | null | undefined): void {
  if (expected === undefined) return;
  if (expected === null ? before !== null : !before
    || (expected.id !== undefined && before.id !== expected.id) || !sameRule(before, expected)) {
    throw new ChannelPricingError("CHANNEL_PRICING_CONFLICT",
      "This pricing rule changed after you opened it. Reload the rules and review the current value before saving.", 409);
  }
}

async function audit(
  transaction: ChannelPricingTransaction,
  context: { channelId: number; actor: string; now: Date },
  action: string, target: string,
  before: ChannelPricingRule | StoredChannelPrice | null, after: ChannelPricingRule | StoredChannelPrice | null,
): Promise<void> {
  await transaction.audit({
    actor: context.actor, action: `channel_pricing.${action}`, target: `channel:${context.channelId}:${target}`,
    changes: { before, after },
  }, context.now);
}

export function createChannelPricingService(database: ChannelPricingDatabase): ChannelPricingService {
  return new ChannelPricingService(new PgChannelPricingRepository(database));
}
