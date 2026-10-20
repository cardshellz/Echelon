import type { ChannelPricing, ChannelPricingRule } from "@shared/schema";
import type { AuditLogPayload } from "../../infrastructure/auditLogger";
import type { PricingRuleTarget, SaveChannelPrice, SaveChannelPricingRule } from "./channel-pricing.domain";

export type ListedChannelPricingRule = ChannelPricingRule & { scopeLabel: string | null };
// PostgreSQL bigint can exceed JavaScript's exact integer range. Preserve the
// stored representation so corrections and deletions have an exact before image.
export type StoredChannelPrice = Omit<ChannelPricing, "price" | "compareAtPrice" | "cost"> & {
  price: string;
  compareAtPrice: string | null;
  cost: string | null;
};

export interface ChannelPricingTransaction {
  targetExists(target: PricingRuleTarget): Promise<boolean>;
  rule(target: PricingRuleTarget): Promise<ChannelPricingRule | null>;
  ruleById(id: number): Promise<ChannelPricingRule | null>;
  saveRule(command: SaveChannelPricingRule, now: Date): Promise<ChannelPricingRule>;
  deleteRule(id: number): Promise<boolean>;
  price(variantId: number): Promise<StoredChannelPrice | null>;
  savePrice(variantId: number, command: SaveChannelPrice, now: Date): Promise<ChannelPricing>;
  deletePrice(variantId: number): Promise<boolean>;
  audit(payload: AuditLogPayload, now: Date): Promise<void>;
}

export interface ChannelPricingStore {
  listRules(channelId: number): Promise<ListedChannelPricingRule[]>;
  withChannel<T>(channelId: number, work: (transaction: ChannelPricingTransaction) => Promise<T>): Promise<T>;
}
