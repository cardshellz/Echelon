import type { ChannelExposurePolicyHead } from "@shared/types/inventory-channel-exposure";
import { channelRuleCopyResultSchema, copyChannelRulesSchema, type ChannelRuleCopyResult } from "@shared/types/inventory-channel-rule";

import { ChannelInventoryApiError, describeError, jsonInit, requestJson } from "./api";
import { isDefinitiveDraftRejection } from "./draft-session";

/**
 * "Copy stock rules from": give a channel that has no stock rules another
 * channel's default and exceptions. The server writes and applies all of them
 * in one transaction, so a copy either takes effect completely or leaves
 * nothing behind. A channel that already has a rule cannot be copied over.
 */
export const COPY_STOCK_RULES_ENDPOINT = "/api/inventory-planning/admin/channel-rule-definitions/copy";

export function sendCopyStockRules(command: unknown): Promise<ChannelRuleCopyResult> {
  return requestJson(COPY_STOCK_RULES_ENDPOINT, channelRuleCopyResultSchema, jsonInit("POST", copyChannelRulesSchema.parse(command)));
}

type Heads = readonly Pick<ChannelExposurePolicyHead, "scopeKey" | "channelId" | "activePolicy">[];

/** True when the channel has no stock rule of any kind, saved or in effect. Only then can rules be copied to it. */
export function hasNoStockRules(heads: Heads, channelId: number): boolean {
  return !heads.some(head => head.channelId === channelId);
}

/** Channels whose default is in effect, so they have rules to copy. Never the channel being copied to. */
export function copySources<T extends { id: number; name: string }>(channels: readonly T[], heads: Heads, targetChannelId: number | null): T[] {
  const withDefault = new Set(heads.filter(head => head.activePolicy !== null && head.scopeKey === `channel:${head.channelId}`)
    .map(head => head.channelId));
  return channels.filter(channel => channel.id !== targetChannelId && withDefault.has(channel.id));
}

export type CopyStockRulesOutcome =
  | { status: "copied"; result: ChannelRuleCopyResult }
  /** Definitely not copied; nothing changed. */
  | { status: "rejected"; message: string; details: readonly string[] }
  /** The request may or may not have landed (network, timeout). Retrying sends the same command. */
  | { status: "unknown"; message: string };

export interface CopyStockRulesInput {
  sourceChannelId: number;
  targetChannelId: number;
  /** One key per distinct copy. A retry after an unknown outcome reuses it, so the server replays instead of copying twice. */
  idempotencyKey: string;
}

export async function copyStockRules(input: CopyStockRulesInput, send: typeof sendCopyStockRules = sendCopyStockRules): Promise<CopyStockRulesOutcome> {
  try {
    return { status: "copied", result: await send({ sourceChannelId: input.sourceChannelId, targetChannelId: input.targetChannelId,
      idempotencyKey: input.idempotencyKey }) };
  } catch (error) {
    if (isDefinitiveDraftRejection(error instanceof ChannelInventoryApiError ? error.status : null)) {
      const described = describeError(error);
      return { status: "rejected", message: described.message, details: described.details };
    }
    return { status: "unknown", message: "The outcome is unknown. Copy again to retry the same copy, or reload to see what is in effect." };
  }
}

const SHOWN_REASONS = 3;
const plural = (count: number, one: string, many: string) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;

/** One short paragraph a person can read for a finished copy. */
export function describeCopyOutcome(outcome: CopyStockRulesOutcome): string {
  if (outcome.status === "unknown") return outcome.message;
  if (outcome.status === "rejected") {
    const reasons = outcome.details.slice(0, SHOWN_REASONS).join(" ");
    const more = outcome.details.length > SHOWN_REASONS ? ` And ${outcome.details.length - SHOWN_REASONS} more.` : "";
    return `Not copied. ${outcome.message}${reasons ? ` ${reasons}${more}` : ""}`;
  }
  const { result } = outcome;
  const exceptions = result.copiedExceptions === 0 ? "the default" : `the default and ${plural(result.copiedExceptions, "exception", "exceptions")}`;
  const sent = result.changedQuantities === 0
    ? "No quantity sent to a channel changes right now."
    : `${plural(result.changedQuantities, "quantity", "quantities")} sent to channels changed.`;
  const skipped = result.skippedRules.length === 0 ? ""
    : ` Not copied: ${result.skippedRules.slice(0, SHOWN_REASONS).join(" ")}${result.skippedRules.length > SHOWN_REASONS ? ` And ${result.skippedRules.length - SHOWN_REASONS} more.` : ""}`;
  const destinations = result.skippedDestinations.length === 0 ? ""
    : ` ${plural(result.skippedDestinations.length, "destination was", "destinations were")} skipped.`;
  return `Copied ${exceptions} from ${result.sourceChannelName} to ${result.targetChannelName}. ${sent}${skipped}${destinations}`;
}
