import {
  applyChannelRuleSchema, channelRuleProgressSchema, channelRuleReceiptSchema, channelRuleReviewSchema, channelRuleSelectionSchema,
  type ApplyChannelRule, type ChannelRuleProgress, type ChannelRuleReceipt, type ChannelRuleReview, type ChannelRuleSelection,
} from "@shared/types/inventory-channel-rule";
import type { ChannelExposurePolicyHead, ChannelExposurePolicyScope } from "@shared/types/inventory-channel-exposure";

import { jsonInit, requestJson } from "./api";

/**
 * Applying ONE saved product or SKU rule (owner decision 2026-11-07). Only that
 * rule is applied; other saved changes on the channel stay saved. Channel
 * defaults keep the whole-channel review.
 */
export const RULE_ENDPOINT = "/api/inventory-planning/admin/channel-rule-definitions";

/** Outbox states that are still on their way to the marketplace. */
export const IN_FLIGHT_DELIVERY_STATES: readonly string[] = ["desired", "queued", "leased", "published", "acknowledged", "retryable", "drifted"];

/** Pins the exact saved draft shown, or null when this rule has nothing waiting to apply. */
export function ruleSelectionFor(scope: ChannelExposurePolicyScope, head: ChannelExposurePolicyHead | null): ChannelRuleSelection | null {
  if (scope.scopeType === "channel" || !head?.draftPolicy) return null;
  return channelRuleSelectionSchema.parse({
    scope,
    draftPolicyId: head.draftPolicy.policyId,
    expectedHeadRevision: head.revision,
    expectedDefinitionHash: head.draftPolicy.definitionHash,
  });
}

/** One command per reviewed change; a retry after a lost response resends it unchanged. */
export function buildApplyRuleCommand(review: Pick<ChannelRuleReview, "selection" | "reviewHash">, idempotencyKey: string): ApplyChannelRule {
  return applyChannelRuleSchema.parse({ ...review.selection, expectedReviewHash: review.reviewHash, idempotencyKey });
}

export function reviewChannelRule(selection: ChannelRuleSelection, signal?: AbortSignal): Promise<ChannelRuleReview> {
  return requestJson(`${RULE_ENDPOINT}/review`, channelRuleReviewSchema, { ...jsonInit("POST", selection), signal });
}

export function applyChannelRule(command: ApplyChannelRule): Promise<ChannelRuleReceipt> {
  return requestJson(`${RULE_ENDPOINT}/apply`, channelRuleReceiptSchema, jsonInit("POST", applyChannelRuleSchema.parse(command)));
}

export function fetchChannelRuleProgress(scopeKey: string, signal?: AbortSignal): Promise<ChannelRuleProgress | null> {
  return requestJson(`${RULE_ENDPOINT}/progress?scopeKey=${encodeURIComponent(scopeKey)}`, channelRuleProgressSchema.nullable(), { signal });
}

/** Rows that move first; rows that stay the same are kept but shown on request.
 * An unknown current quantity counts as a change. Display only: the server
 * computes every quantity. */
export function splitRuleQuantities(review: Pick<ChannelRuleReview, "quantities">) {
  const changed = review.quantities.filter(row => row.current !== row.proposed);
  const unchanged = review.quantities.filter(row => row.current === row.proposed);
  return { changed, unchanged };
}

export function summarizeRuleDelivery(progress: Pick<ChannelRuleProgress, "publications">) {
  const total = progress.publications.length;
  const confirmed = progress.publications.filter(row => row.state === "verified").length;
  const inFlight = progress.publications.some(row => IN_FLIGHT_DELIVERY_STATES.includes(row.state));
  const needsAttention = progress.publications.some(row => ["dead_letter", "drifted", "retryable"].includes(row.state));
  return { total, confirmed, inFlight, needsAttention };
}
