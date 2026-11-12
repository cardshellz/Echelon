import type {
  ChannelExposurePolicyHead, ChannelExposurePolicyScope, ChannelExposurePolicyValue,
} from "@shared/types/inventory-channel-exposure";
import type { ChannelPublicationStatus } from "@shared/types/inventory-channel-publication-status";
import type { ChannelRuleSetResult } from "@shared/types/inventory-channel-rule";

import { ChannelInventoryApiError, buildPolicyDraftRequest, describeError, savePolicyDraft } from "./api";
import { isDefinitiveDraftRejection } from "./draft-session";
import { formatPercent, formatUnits } from "./format";
import {
  effectiveMaxPublish, findPolicyHead, policyFormToValue, policyValueToForm, savedPolicy,
  type Channel, type PolicyForm, type PolicyFormError, type View,
} from "./model";
import { IN_FLIGHT_DELIVERY_STATES, RULE_BLOCKED_CODE, buildSetRuleCommand, setChannelRule } from "./rule-apply";

/**
 * The SKU view of channel stock rules: one SKU (or whole product), every
 * channel. It reads and writes the same exception rows as Channel Inventory →
 * Stock rules; nothing here is a second store. Saving takes effect: the rule is
 * saved, checked and applied by one server command in one transaction, and a
 * save that cannot be applied writes nothing, so the card has one state: what
 * the channel uses.
 */

/** The four numbers an exception can change, in calculation order. */
export const STOCK_RULE_FIELDS = [
  { key: "shareBps", label: "Stock %", help: "Share of available stock" },
  { key: "holdbackSellableUnits", label: "Buffer", help: "Subtracted after the %" },
  { key: "maxPublish", label: "Max", help: "0 = not sold on this channel" },
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
  /** The most specific applied rule in effect on the channel right now. */
  ruleSource: StockRuleSource;
  /**
   * A change saved on this exact rule never took effect and would change what
   * the channel uses. Saves from this card no longer leave one; it exists only
   * when the change was saved in Channel Inventory and not applied there, or
   * was left by this card before its save became one command.
   */
  pending: boolean;
  /** What that leftover change would do, e.g. "Max 0" or "Clear exception"; null when there is none. */
  pendingChange: string | null;
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

/**
 * Two rule values that mean the same thing. Compared field by field rather
 * than by definition hash: the hash is taken over the request as it was sent,
 * and the server reads a stored rule back without its unset optional fields
 * (no warehouses set), so the same rule saved twice is not
 * guaranteed the same hash.
 */
export function sameRuleValue(left: ChannelExposurePolicyValue, right: ChannelExposurePolicyValue): boolean {
  const shape = (value: ChannelExposurePolicyValue) => value.inheritAll === true ? "inherit" : JSON.stringify([
    value.allocationSemantics, value.eligible, value.shareBps, value.holdbackSellableUnits,
    value.maxPublish === null ? null : value.maxPublish.mode === "unlimited" ? "unlimited" : `units:${value.maxPublish.units}`,
    value.minPublishSellableUnits,
    value.sourceFulfillmentNodeIds ? [...value.sourceFulfillmentNodeIds].sort((a, b) => a - b) : null,
  ]);
  return shape(left) === shape(right);
}

/**
 * True when the head holds a saved version that is not applied AND would
 * change what the channel uses. A saved version that means the same as the
 * applied one (or a "use the default" marker where no rule is applied) changes
 * nothing, so it is not a pending change.
 */
export function hasPendingChange(head: ChannelExposurePolicyHead | null): boolean {
  const draft = head?.draftPolicy ?? null;
  if (!draft) return false;
  const active = head?.activePolicy ?? null;
  return active ? !sameRuleValue(draft.value, active.value) : !draft.value.inheritAll;
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
 * and where it comes from. A leftover saved change that never took effect
 * changes nothing a channel shows, so it is reported separately (`pending`,
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
    const pending = hasPendingChange(head);
    return {
      channel, scope, head,
      managed: live.some(link => link.source === "channel"),
      hasException: own !== null && !own.value.inheritAll,
      ruleSource: live[0]?.source ?? "unset",
      pending,
      pendingChange: pending && head?.draftPolicy ? describePendingChange(head.draftPolicy.value) : null,
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
  const parsed = policyFormToValue(form, {
    allowInheritAll: true,
    sourceFulfillmentNodeIds: existing?.sourceFulfillmentNodeIds ?? null,
  });
  if (!parsed.ok) return parsed;
  const conflict = stockRuleConflict(parsed.value);
  return conflict ? { ok: false, errors: [conflict] } : parsed;
}

/**
 * Settings on one rule that cancel each other out. The calculation caps at Max
 * and THEN sends 0 when the result is below "Hide when below"
 * (shared/inventory/channel-exposure-calculation.ts), so a cutoff above a
 * non-zero Max can never be met: the channel would always be sent 0 while the
 * rule looks like it sells. Only values set on this rule are compared; a value
 * left to the product rule or channel default is not known here.
 */
export function stockRuleConflict(value: Pick<ChannelExposurePolicyValue, "maxPublish" | "minPublishSellableUnits">): PolicyFormError | null {
  const max = value.maxPublish;
  const hideBelow = value.minPublishSellableUnits;
  if (max === null || max.mode !== "units" || hideBelow === null) return null;
  const maxUnits = BigInt(max.units);
  if (maxUnits === BigInt(0) || BigInt(hideBelow) <= maxUnits) return null;
  return {
    field: "minPublishSellableUnits",
    message: `Hide when below (${formatUnits(hideBelow)}) is more than Max (${formatUnits(max.units)}), so this channel would always be sent 0. Lower it, or set Max to 0 to stop selling here.`,
  };
}

/** True when the typed Max is 0: nothing is sent, so the other three numbers have no effect. */
export function stopsSelling(input: Pick<StockRuleInput, "maxMode" | "maxUnits">): boolean {
  return input.maxMode === "units" && /^0+$/.test(input.maxUnits.trim());
}

export type StockRuleSaveOutcome =
  | { status: "applied"; quantities: ChannelRuleSetResult["quantities"]; skipped: string[] }
  | { status: "unchanged" }
  /** A leftover saved change was thrown away. Nothing the channel uses changed. */
  | { status: "undone" }
  /** Applying it would create a problem, so nothing was saved. `leftover`: an earlier saved change still waits on this rule. */
  | { status: "blocked"; blockers: string[]; leftover: boolean }
  /** Definitely not saved. `leftover`: an earlier saved change still waits on this rule. */
  | { status: "rejected"; message: string; leftover: boolean }
  /** The request may or may not have landed (network). Reload shows the truth. */
  | { status: "unknown"; message: string };

export interface StockRuleSaveSteps {
  /** Save, check and apply in one server transaction. */
  set: typeof setChannelRule;
  /** Only for discarding a leftover: saved versions cannot be deleted, so one is withdrawn by overwriting it. */
  save: typeof savePolicyDraft;
  newKey(): string;
}

export const stockRuleSaveSteps: StockRuleSaveSteps = {
  set: setChannelRule, save: savePolicyDraft, newKey: () => crypto.randomUUID(),
};

const UNKNOWN_OUTCOME = "The outcome is unknown. Reload to see whether this rule was saved.";
const DISCARD_NOTE = "Discarded a saved change that was never applied.";

/**
 * The rule value that changes nothing when saved over a pending change: a copy
 * of the applied rule, or "use the default" when no rule is applied. Saved
 * versions are append-only (they cannot be deleted), so a leftover is withdrawn
 * by overwriting it with this.
 */
function noChangeValue(head: ChannelExposurePolicyHead | null): ChannelExposurePolicyValue | null {
  if (head?.activePolicy) return head.activePolicy.value;
  const cleared = stockRuleValue(EMPTY_STOCK_RULE_INPUT, null);
  return cleared.ok ? cleared.value : null;
}

/**
 * Save one channel's rule and make it take effect. One server command saves
 * the rule, checks exactly what it changes and applies only it, inside one
 * database transaction: a refused or failed save writes nothing, so there is
 * no half-saved state to clean up here. The head revision fences the command,
 * so a concurrent edit is rejected instead of being overwritten.
 *
 * A leftover saved change (one saved in Channel Inventory and never applied)
 * is replaced by what is saved here; with nothing typed, Save applies that
 * leftover as it is. A refusal leaves a leftover exactly as it was, and that
 * is reported (`leftover`).
 */
export async function saveAndApplyStockRule(input: {
  row: Pick<ChannelStockRuleRow, "scope" | "head">;
  value: ChannelExposurePolicyValue;
  changed: boolean;
  note: string;
}, steps: StockRuleSaveSteps = stockRuleSaveSteps): Promise<StockRuleSaveOutcome> {
  const { scope, head } = input.row;
  if (scope.scopeType === "channel") throw new Error("Channel defaults are edited in Channel Inventory.");
  const leftover = hasPendingChange(head);
  const value = input.changed ? input.value : leftover ? head?.draftPolicy?.value ?? null : null;
  if (value === null) return { status: "unchanged" };
  try {
    const result = await steps.set(buildSetRuleCommand({ scope, value, head, note: input.note, idempotencyKey: steps.newKey() }));
    return { status: "applied", quantities: result.quantities, skipped: result.skippedDestinations };
  } catch (error) {
    // The server rolled the whole command back on any definite refusal, so what was there before is still there.
    if (!isDefinitive(error)) return { status: "unknown", message: UNKNOWN_OUTCOME };
    if (error instanceof ChannelInventoryApiError && error.code === RULE_BLOCKED_CODE) {
      return { status: "blocked", blockers: error.details.length > 0 ? [...error.details] : [error.message], leftover };
    }
    return { status: "rejected", message: describeError(error).message, leftover };
  }
}

function isDefinitive(error: unknown): boolean {
  return isDefinitiveDraftRejection(error instanceof ChannelInventoryApiError ? error.status : null);
}

/**
 * Throw away a leftover saved change without applying it. The channel keeps
 * using exactly what it uses now.
 */
export async function discardPendingStockRule(
  row: Pick<ChannelStockRuleRow, "scope" | "head">, steps: StockRuleSaveSteps = stockRuleSaveSteps,
): Promise<StockRuleSaveOutcome> {
  const { scope, head } = row;
  if (scope.scopeType === "channel") throw new Error("Channel defaults are edited in Channel Inventory.");
  const value = noChangeValue(head);
  if (!hasPendingChange(head) || value === null) return { status: "unchanged" };
  try {
    await steps.save(buildPolicyDraftRequest({ scope, value, head, note: DISCARD_NOTE, idempotencyKey: steps.newKey() }));
    return { status: "undone" };
  } catch (error) {
    return isDefinitive(error)
      ? { status: "rejected", message: describeError(error).message, leftover: true }
      : { status: "unknown", message: UNKNOWN_OUTCOME };
  }
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
  const leftover = " An earlier saved change is still waiting on this rule; open Edit to apply or discard it.";
  switch (outcome.status) {
    case "unchanged": return "No change.";
    case "undone": return "Saved change discarded. Nothing changed on the channel.";
    case "blocked": return `Not saved. ${outcome.blockers.join(" ")}${outcome.leftover ? leftover : ""}`;
    case "rejected": return `Not saved. ${outcome.message}${outcome.leftover ? leftover : ""}`;
    case "unknown": return outcome.message;
    case "applied": {
      const rows = outcome.quantities.filter(row => (variantId === null || row.variantId === variantId) && row.current !== row.proposed);
      const moved = rows.slice(0, 3).map(row => `${row.channelName} ${row.current === null ? "?" : formatUnits(row.current)} → ${formatUnits(row.proposed)}`);
      const more = rows.length > 3 ? ` and ${rows.length - 3} more` : "";
      return rows.length === 0 ? "Saved. The quantity sent does not change right now." : `Saved. ${moved.join(", ")}${more}.`;
    }
  }
}

export type LastSentRow = ChannelPublicationStatus["rows"][number];
export interface LastSent {
  /** The quantity the channel last accepted, or why there is none. */
  primary: string;
  /** What is happening now, when a newer send is on its way or failed. */
  detail: string | null;
  /** When the channel accepted `primary`; null when it never did. */
  at: string | null;
  tone: "normal" | "muted" | "problem";
}

/**
 * The quantity a destination last accepted for one SKU, from recorded delivery
 * evidence (never a fresh calculation). An old time is normal: an unchanged
 * result is not re-sent, so a capped SKU keeps its last send until the number
 * moves.
 */
export function describeLastSent(row: LastSentRow | undefined): LastSent {
  if (!row || row.activeInventoryItemId === null) return { primary: "Not listed", detail: null, at: null, tone: "muted" };
  const { acknowledged, desired } = row;
  const primary = acknowledged ? formatUnits(acknowledged.quantity) : "Never sent";
  const at = acknowledged?.acknowledgedAt ?? null;
  const newer = desired !== null && desired.outboxId !== acknowledged?.outboxId ? desired : null;
  if (newer?.state === "dead_letter") {
    return { primary, detail: `Sending ${formatUnits(newer.quantity)} failed`, at, tone: "problem" };
  }
  if (newer && IN_FLIGHT_DELIVERY_STATES.includes(newer.state)) {
    return { primary, detail: `Sending ${formatUnits(newer.quantity)} now`, at, tone: "normal" };
  }
  return { primary, detail: null, at, tone: acknowledged ? "normal" : "muted" };
}
