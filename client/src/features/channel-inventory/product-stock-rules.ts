import type {
  ChannelExposurePolicyHead, ChannelExposurePolicyScope, ChannelExposurePolicyValue,
} from "@shared/types/inventory-channel-exposure";
import type { ChannelRuleReview } from "@shared/types/inventory-channel-rule";
import { channelRuleSelectionSchema } from "@shared/types/inventory-channel-rule";

import { ChannelInventoryApiError, buildPolicyDraftRequest, describeError, savePolicyDraft } from "./api";
import { isDefinitiveDraftRejection } from "./draft-session";
import { formatPercent, formatUnits } from "./format";
import {
  effectiveMaxPublish, findPolicyHead, policyFormToValue, policyValueToForm, savedPolicy,
  type Channel, type PolicyForm, type PolicyFormError, type View,
} from "./model";
import { applyChannelRule, buildApplyRuleCommand, reviewChannelRule } from "./rule-apply";

/**
 * The SKU view of channel stock rules: one SKU (or whole product), every
 * channel. It reads and writes the same exception rows as Channel Inventory →
 * Stock rules; nothing here is a second store. Saving takes effect: the rule is
 * saved, checked and applied in one action.
 */

/** The four numbers an exception can change, in calculation order. */
export const STOCK_RULE_FIELDS = [
  { key: "shareBps", label: "Stock %", help: "Share of available stock" },
  { key: "holdbackSellableUnits", label: "Buffer", help: "Subtracted after the %" },
  { key: "maxPublish", label: "Max", help: "0 = out of stock" },
  { key: "minPublishSellableUnits", label: "Hide when below", help: "Shows 0 when fewer than this are available" },
] as const;
export type StockRuleFieldKey = typeof STOCK_RULE_FIELDS[number]["key"];

export type StockRuleSubject = { productId: number; productVariantId: number | null };
export type StockRuleSource = "sku" | "product" | "channel" | "unset";
export interface StockRuleCell { display: string; source: StockRuleSource }

export interface ChannelStockRuleRow {
  channel: Channel;
  scope: ChannelExposurePolicyScope;
  head: ChannelExposurePolicyHead | null;
  /** False when the channel has no default rule yet: nothing is sent there, so there is nothing to except. */
  managed: boolean;
  /** This subject has its own saved rule on the channel, applied or not (so there is something to edit or clear). */
  hasException: boolean;
  /** This subject's own rule is in effect on the channel right now. */
  liveException: boolean;
  /** A saved change on this exact rule has not been applied yet. It has no effect until it is. */
  pending: boolean;
  /** What the unapplied change would do, e.g. "Max 0" or "Clear exception"; null when nothing is pending. */
  pendingChange: string | null;
  /** The max in effect right now is 0: the channel shows this item as out of stock. */
  outOfStock: boolean;
  /** The values in effect right now. An unapplied change never appears here. */
  cells: Record<StockRuleFieldKey, StockRuleCell>;
}

export function stockRuleScope(channelId: number, subject: StockRuleSubject): ChannelExposurePolicyScope {
  return subject.productVariantId === null
    ? { scopeType: "product", channelId, productId: subject.productId }
    : { scopeType: "variant", channelId, productId: subject.productId, productVariantId: subject.productVariantId };
}

function displayField(key: StockRuleFieldKey, value: ChannelExposurePolicyValue): string | null {
  switch (key) {
    case "shareBps": return value.shareBps === null ? null : formatPercent(value.shareBps);
    case "holdbackSellableUnits": return value.holdbackSellableUnits === null ? null : formatUnits(value.holdbackSellableUnits);
    case "maxPublish": {
      const maxPublish = effectiveMaxPublish(value);
      if (maxPublish === null) return null;
      return maxPublish.mode === "unlimited" ? "No max" : formatUnits(maxPublish.units);
    }
    case "minPublishSellableUnits": return value.minPublishSellableUnits === null ? null : formatUnits(value.minPublishSellableUnits);
  }
}

/** What a saved, unapplied rule would set, in the operator's words. */
function describePendingChange(value: ChannelExposurePolicyValue): string {
  if (value.inheritAll) return "Clear exception";
  const parts = STOCK_RULE_FIELDS.flatMap(field => {
    const display = displayField(field.key, value);
    return display === null ? [] : [`${field.label} ${display}`];
  });
  return parts.length === 0 ? "Other settings" : parts.join(", ");
}

/**
 * One row per channel for a subject. Each field shows the value in effect
 * right now (SKU rule → product rule → channel default, applied rules only)
 * and where it comes from. A saved change that was never applied changes
 * nothing a channel shows, so it is reported separately (`pending`,
 * `pendingChange`) and never as the current value.
 */
export function listChannelStockRules(view: Pick<View, "channels" | "policyHeads">, subject: StockRuleSubject): ChannelStockRuleRow[] {
  return view.channels.filter(channel => channel.status === "active").map(channel => {
    const scope = stockRuleScope(channel.id, subject);
    const chain: Array<{ source: Exclude<StockRuleSource, "unset">; scope: ChannelExposurePolicyScope }> = [];
    if (scope.scopeType === "variant") {
      chain.push({ source: "sku", scope });
      chain.push({ source: "product", scope: { scopeType: "product", channelId: channel.id, productId: subject.productId } });
    } else {
      chain.push({ source: "product", scope });
    }
    chain.push({ source: "channel", scope: { scopeType: "channel", channelId: channel.id } });
    const live = chain.flatMap(link => {
      const value = findPolicyHead(view.policyHeads, link.scope)?.activePolicy?.value ?? null;
      return value && !value.inheritAll ? [{ source: link.source, value }] : [];
    });
    const cells = {} as Record<StockRuleFieldKey, StockRuleCell>;
    for (const field of STOCK_RULE_FIELDS) {
      let cell: StockRuleCell = { display: "Not set", source: "unset" };
      for (const link of live) {
        const display = displayField(field.key, link.value);
        if (display !== null) { cell = { display, source: link.source }; break; }
      }
      cells[field.key] = cell;
    }
    const head = findPolicyHead(view.policyHeads, scope);
    const own = savedPolicy(head);
    const ownSource: StockRuleSource = scope.scopeType === "variant" ? "sku" : "product";
    const draft = head?.draftPolicy?.value ?? null;
    return {
      channel, scope, head,
      managed: live.some(link => link.source === "channel"),
      hasException: own !== null && !own.value.inheritAll,
      liveException: live.some(link => link.source === ownSource),
      pending: draft !== null,
      pendingChange: draft === null ? null : describePendingChange(draft),
      outOfStock: cells.maxPublish.display === "0" && cells.maxPublish.source !== "unset",
      cells,
    };
  });
}

/** What the operator types. Blank means "use the default" for that field. */
export interface StockRuleInput {
  sharePercent: string;
  bufferUnits: string;
  maxMode: "inherit" | "unlimited" | "units";
  maxUnits: string;
  hideBelowUnits: string;
}

export const EMPTY_STOCK_RULE_INPUT: StockRuleInput = {
  sharePercent: "", bufferUnits: "", maxMode: "inherit", maxUnits: "", hideBelowUnits: "",
};

export function stockRuleInputFor(head: ChannelExposurePolicyHead | null): StockRuleInput {
  const form = policyValueToForm(savedPolicy(head)?.value ?? null);
  return {
    sharePercent: form.shareMode === "set" ? form.sharePercent : "",
    bufferUnits: form.holdbackMode === "set" ? form.holdbackUnits : "",
    maxMode: form.maxMode,
    maxUnits: form.maxMode === "units" ? form.maxUnits : "",
    hideBelowUnits: form.minMode === "set" ? form.minUnits : "",
  };
}

/**
 * True when the saved rule still carries the retired "Show as out of stock"
 * setting. The form already shows it as Max 0, so it must be saved again even
 * when the operator typed nothing new; otherwise the old flag would be applied.
 */
export function needsStockRuleRewrite(head: ChannelExposurePolicyHead | null): boolean {
  const saved = savedPolicy(head)?.value ?? null;
  return saved !== null && saved.eligible !== null;
}

export function sameStockRuleInput(left: StockRuleInput, right: StockRuleInput): boolean {
  return left.sharePercent.trim() === right.sharePercent.trim() && left.bufferUnits.trim() === right.bufferUnits.trim()
    && left.maxMode === right.maxMode && (left.maxMode !== "units" || left.maxUnits.trim() === right.maxUnits.trim())
    && left.hideBelowUnits.trim() === right.hideBelowUnits.trim();
}

export type StockRuleValueResult =
  | { ok: true; value: ChannelExposurePolicyValue }
  | { ok: false; errors: PolicyFormError[] };

/**
 * The exact rule value to save on one channel. Only the four stock numbers
 * change; the sharing mode and supply warehouses already saved on that rule
 * are carried over untouched, so this view never silently drops a setting it
 * does not show. A retired "Show as out of stock" is not carried: it is saved
 * as the Max 0 the form shows for it.
 */
export function stockRuleValue(input: StockRuleInput, head: ChannelExposurePolicyHead | null): StockRuleValueResult {
  const existing = savedPolicy(head)?.value ?? null;
  const base = policyValueToForm(existing);
  const share = input.sharePercent.trim();
  const buffer = input.bufferUnits.trim();
  const hideBelow = input.hideBelowUnits.trim();
  const form: PolicyForm = {
    ...base,
    shareMode: share === "" ? "inherit" : "set", sharePercent: share,
    holdbackMode: buffer === "" ? "inherit" : "set", holdbackUnits: buffer,
    maxMode: input.maxMode, maxUnits: input.maxMode === "units" ? input.maxUnits.trim() : "",
    minMode: hideBelow === "" ? "inherit" : "set", minUnits: hideBelow,
  };
  return policyFormToValue(form, {
    allowInheritAll: true,
    sourceFulfillmentNodeIds: existing?.sourceFulfillmentNodeIds ?? null,
  });
}

export type StockRuleSaveOutcome =
  | { status: "applied"; quantities: ChannelRuleReview["quantities"]; skipped: string[] }
  | { status: "unchanged" }
  /** Saved, but applying it would create a problem. It stays saved and unapplied. */
  | { status: "blocked"; blockers: string[] }
  /** Definitely not saved or not applied; nothing changed beyond what `saved` says. */
  | { status: "rejected"; message: string; saved: boolean }
  /** The request may or may not have landed (network). Reload shows the truth. */
  | { status: "unknown"; message: string };

export interface StockRuleSaveSteps {
  save: typeof savePolicyDraft;
  review: typeof reviewChannelRule;
  apply: typeof applyChannelRule;
  newKey(): string;
}

export const stockRuleSaveSteps: StockRuleSaveSteps = {
  save: savePolicyDraft, review: reviewChannelRule, apply: applyChannelRule, newKey: () => crypto.randomUUID(),
};

function failure(error: unknown, saved: boolean): StockRuleSaveOutcome {
  const message = describeError(error).message;
  return isDefinitiveDraftRejection(error instanceof ChannelInventoryApiError ? error.status : null)
    ? { status: "rejected", message, saved }
    : { status: "unknown", message: "The outcome is unknown. Reload to see whether this rule was saved and applied." };
}

/**
 * Save one channel's rule and make it take effect: save the draft, check
 * exactly what it changes, apply only it. Each step is the existing audited
 * command; the head revision and hashes fence every step, so a concurrent
 * edit is rejected instead of being overwritten. A rule that is already saved
 * but unapplied is applied without saving again.
 */
export async function saveAndApplyStockRule(input: {
  row: Pick<ChannelStockRuleRow, "scope" | "head">;
  value: ChannelExposurePolicyValue;
  changed: boolean;
  note: string;
}, steps: StockRuleSaveSteps = stockRuleSaveSteps): Promise<StockRuleSaveOutcome> {
  const { scope, head } = input.row;
  if (scope.scopeType === "channel") throw new Error("Channel defaults are edited in Channel Inventory.");
  let draft: { policyId: number; definitionHash: string; headRevision: string } | null = head?.draftPolicy
    ? { policyId: head.draftPolicy.policyId, definitionHash: head.draftPolicy.definitionHash, headRevision: head.revision }
    : null;
  if (input.changed) {
    try {
      const saved = await steps.save(buildPolicyDraftRequest({
        scope, value: input.value, head, note: input.note, idempotencyKey: steps.newKey(),
      }));
      draft = { policyId: saved.definitionId, definitionHash: saved.definitionHash, headRevision: saved.headRevision };
    } catch (error) { return failure(error, false); }
  }
  if (!draft) return { status: "unchanged" };
  let review: ChannelRuleReview;
  try {
    review = await steps.review(channelRuleSelectionSchema.parse({
      scope, draftPolicyId: draft.policyId, expectedHeadRevision: draft.headRevision, expectedDefinitionHash: draft.definitionHash,
    }));
  } catch (error) {
    // A failed read changes nothing: the rule is saved and simply not applied yet.
    return { status: "rejected", message: describeError(error).message, saved: true };
  }
  if (!review.ready) return { status: "blocked", blockers: review.blockers };
  try { await steps.apply(buildApplyRuleCommand(review, steps.newKey())); }
  catch (error) { return failure(error, true); }
  return { status: "applied", quantities: review.quantities, skipped: review.skippedDestinations };
}

/**
 * "Set on all channels": only the fields the operator filled in are written
 * to each channel; a blank field keeps that channel's own current exception
 * value. Typing Max 0 therefore stops the item everywhere without disturbing
 * a buffer or percentage one channel already has.
 */
export function mergeStockRuleInput(current: StockRuleInput, typed: StockRuleInput): StockRuleInput {
  return {
    sharePercent: typed.sharePercent.trim() === "" ? current.sharePercent : typed.sharePercent,
    bufferUnits: typed.bufferUnits.trim() === "" ? current.bufferUnits : typed.bufferUnits,
    maxMode: typed.maxMode === "inherit" ? current.maxMode : typed.maxMode,
    maxUnits: typed.maxMode === "inherit" ? current.maxUnits : typed.maxUnits,
    hideBelowUnits: typed.hideBelowUnits.trim() === "" ? current.hideBelowUnits : typed.hideBelowUnits,
  };
}

/** One line a person can read for a finished save on one channel. */
export function describeStockRuleOutcome(outcome: StockRuleSaveOutcome, variantId: number | null): string {
  switch (outcome.status) {
    case "unchanged": return "No change.";
    case "blocked": return `Saved but not applied: ${outcome.blockers.join(" ")}`;
    case "rejected": return outcome.saved ? `Saved but not applied: ${outcome.message}` : `Not saved: ${outcome.message}`;
    case "unknown": return outcome.message;
    case "applied": {
      const rows = outcome.quantities.filter(row => (variantId === null || row.variantId === variantId) && row.current !== row.proposed);
      const moved = rows.slice(0, 3).map(row => `${row.channelName} ${row.current === null ? "?" : formatUnits(row.current)} → ${formatUnits(row.proposed)}`);
      const more = rows.length > 3 ? ` and ${rows.length - 3} more` : "";
      return rows.length === 0 ? "Applied. No quantity changes right now." : `Applied. ${moved.join(", ")}${more}.`;
    }
  }
}
