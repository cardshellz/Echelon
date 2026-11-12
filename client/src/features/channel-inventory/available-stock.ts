import type { PromiseSafetyAdminScope, PromiseSafetyAdminValue } from "@shared/types/inventory-promise-safety-admin";
import {
  promiseSafetyOverviewSchema, safetyDefinitionSetResultSchema, setSafetyDefinitionSchema,
  type PromiseSafetyOverview, type SafetyDefinitionSetResult,
} from "@shared/types/inventory-safety-definition";

import { ChannelInventoryApiError, describeError, jsonInit, requestJson } from "./api";
import { isDefinitiveDraftRejection } from "./draft-session";
import { formatUnits } from "./format";

/**
 * Available stock: how many units of a SKU are held back from EVERY channel
 * before any channel stock rule runs ("promise safety" on the server). One
 * number for the business, optional numbers per SKU. A save takes effect: the
 * server saves, checks and applies it in one transaction, and a refused save
 * leaves nothing behind.
 */
export const HOLD_BACK_ENDPOINT = "/api/inventory-planning/admin/safety-definitions";
/** Postgres integer column. */
const MAX_HOLD_BACK_UNITS = 2_147_483_647;

export type HoldBackSetting = NonNullable<PromiseSafetyOverview["business"]>;
export type HoldBackException = PromiseSafetyOverview["exceptions"][number];

export function fetchHoldBackOverview(signal?: AbortSignal): Promise<PromiseSafetyOverview> {
  return requestJson(`${HOLD_BACK_ENDPOINT}/overview`, promiseSafetyOverviewSchema, { signal });
}

export function setHoldBack(command: unknown): Promise<SafetyDefinitionSetResult> {
  return requestJson(`${HOLD_BACK_ENDPOINT}/set`, safetyDefinitionSetResultSchema, jsonInit("POST", setSafetyDefinitionSchema.parse(command)));
}

/**
 * How a stored setting reads. `simple` settings are a plain number this screen
 * can edit; the demand-based mode is shown but edited where its evidence is.
 */
export function describeHoldBack(value: PromiseSafetyAdminValue | null): { text: string; simple: boolean } {
  if (value === null) return { text: "Not set", simple: true };
  switch (value.policyMode) {
    case "fixed_units": return { text: formatUnits(String(value.fixedUnits)), simple: true };
    case "off": return { text: "0", simple: true };
    case "inherit": return { text: "Business number", simple: true };
    case "days_of_cover": return { text: `${formatDays(value.daysOfCoverMilliDays)} of recent sales`, simple: false };
  }
}

function formatDays(milliDays: number): string {
  const days = milliDays / 1000;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} day${days === 1 ? "" : "s"}`;
}

/** What goes in the number box for a stored setting. Blank when it is not a plain number. */
export function holdBackInput(value: PromiseSafetyAdminValue | null): string {
  if (value?.policyMode === "fixed_units") return String(value.fixedUnits);
  return value?.policyMode === "off" ? "0" : "";
}

export type HoldBackParse = { ok: true; value: PromiseSafetyAdminValue } | { ok: false; message: string };

/**
 * The typed number as a setting. A blank box means "use the business number"
 * for a SKU; the business number itself has nothing above it, so it must be a
 * number.
 */
export function parseHoldBack(text: string, options: { blankUsesBusiness: boolean }): HoldBackParse {
  const trimmed = text.trim();
  if (trimmed === "") {
    return options.blankUsesBusiness ? { ok: true, value: { policyMode: "inherit" } } : { ok: false, message: "Enter a number, 0 or more." };
  }
  if (!/^\d+$/.test(trimmed)) return { ok: false, message: "Enter a whole number, 0 or more." };
  const units = Number(trimmed);
  if (!Number.isSafeInteger(units) || units > MAX_HOLD_BACK_UNITS) return { ok: false, message: "That number is too large." };
  return { ok: true, value: { policyMode: "fixed_units", fixedUnits: units } };
}

/** Two settings that hold back the same amount. "Off" and a fixed 0 both hold back nothing. */
export function sameHoldBack(left: PromiseSafetyAdminValue | null, right: PromiseSafetyAdminValue | null): boolean {
  const shape = (value: PromiseSafetyAdminValue | null) => {
    if (value === null) return "none";
    switch (value.policyMode) {
      case "off": return "fixed:0";
      case "fixed_units": return `fixed:${value.fixedUnits}`;
      case "inherit": return "inherit";
      case "days_of_cover": return `cover:${value.daysOfCoverMilliDays}:${value.untrustedDemandFallbackUnits}:${value.demandMethodVersion}`;
    }
  };
  return shape(left) === shape(right);
}

/** SKU settings that are in effect. A SKU handed back to the business number is no longer an exception. */
export function activeHoldBackExceptions(overview: Pick<PromiseSafetyOverview, "exceptions">): HoldBackException[] {
  return overview.exceptions.filter(row => row.value === null ? row.hasUnappliedChange : row.value.policyMode !== "inherit");
}

export type HoldBackOutcome =
  | { status: "saved"; result: SafetyDefinitionSetResult }
  /** Definitely not saved; nothing changed. */
  | { status: "rejected"; message: string }
  /** The request may or may not have landed (network, timeout). Retrying sends the same command. */
  | { status: "unknown"; message: string };

export interface HoldBackSaveInput {
  scope: PromiseSafetyAdminScope;
  value: PromiseSafetyAdminValue;
  /** The revision shown on screen; null when this scope has never had a setting. */
  expectedHeadRevision: string | null;
  note: string;
  /** One key per distinct command. A retry after an unknown outcome reuses it, so the server replays instead of writing twice. */
  idempotencyKey: string;
}

export async function saveHoldBack(input: HoldBackSaveInput, send: typeof setHoldBack = setHoldBack): Promise<HoldBackOutcome> {
  try {
    return { status: "saved", result: await send({ scope: input.scope, value: input.value,
      expectedHeadRevision: input.expectedHeadRevision, changeReason: input.note.trim() || null, idempotencyKey: input.idempotencyKey }) };
  } catch (error) {
    return isDefinitiveDraftRejection(error instanceof ChannelInventoryApiError ? error.status : null)
      ? { status: "rejected", message: describeError(error).message }
      : { status: "unknown", message: "The outcome is unknown. Save again to retry the same change, or reload to see what is in effect." };
  }
}

/** The fingerprint of a command: the same change retried gets the same key, a different change a new one. */
export function holdBackFingerprint(input: Pick<HoldBackSaveInput, "scope" | "value" | "expectedHeadRevision" | "note">): string {
  return JSON.stringify([input.scope, input.value, input.expectedHeadRevision, input.note.trim()]);
}

const SHOWN_CHANGES = 3;

/** One line a person can read for a finished save. */
export function describeHoldBackOutcome(outcome: HoldBackOutcome): string {
  if (outcome.status === "rejected") return `Not saved. ${outcome.message}`;
  if (outcome.status === "unknown") return outcome.message;
  const { changes, changedRows, skippedDestinations } = outcome.result;
  const skipped = skippedDestinations.length === 0 ? "" : ` ${skippedDestinations.length} destination${skippedDestinations.length === 1 ? " was" : "s were"} skipped.`;
  if (changedRows === 0) return `Saved. Available stock does not change right now.${skipped}`;
  const shown = changes.slice(0, SHOWN_CHANGES).map(row =>
    `${row.sku ?? "SKU"} at ${row.warehouseName} ${row.current === null ? "?" : formatUnits(row.current)} → ${formatUnits(row.proposed)}`);
  const more = changedRows > shown.length ? ` and ${changedRows - shown.length} more` : "";
  return `Saved. Available stock changed: ${shown.join(", ")}${more}.${skipped}`;
}
