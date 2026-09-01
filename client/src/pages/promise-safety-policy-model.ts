import {
  INVENTORY_DEMAND_METHOD_VERSION,
  promiseSafetyAdminValueSchema,
  type PromiseSafetyAdminScope,
  type PromiseSafetyAdminValue,
  type PromiseSafetyPolicyHeadAdmin,
} from "@shared/types/inventory-promise-safety-admin";

const POSTGRES_INTEGER_MAX = 2_147_483_647;

export interface PromiseSafetyPolicyForm {
  policyMode: PromiseSafetyAdminValue["policyMode"];
  fixedUnits: string;
  daysOfCover: string;
  untrustedDemandFallbackUnits: string;
}

export type ParsedPromiseSafetyPolicyForm =
  | { success: true; value: PromiseSafetyAdminValue }
  | { success: false; message: string };

export function promiseSafetyScopeKey(scope: PromiseSafetyAdminScope): string {
  switch (scope.scopeType) {
    case "business":
      return "business";
    case "network_variant":
      return `network:variant:${scope.productVariantId}`;
    case "warehouse_variant":
      return `warehouse:${scope.warehouseId}:variant:${scope.productVariantId}`;
  }
}

export function policyHeadForScope(
  heads: readonly PromiseSafetyPolicyHeadAdmin[],
  scope: PromiseSafetyAdminScope,
): PromiseSafetyPolicyHeadAdmin | null {
  const scopeKey = promiseSafetyScopeKey(scope);
  return heads.find((head) => head.scopeKey === scopeKey) ?? null;
}

export function initialPromiseSafetyPolicyForm(
  scope: PromiseSafetyAdminScope,
  head: PromiseSafetyPolicyHeadAdmin | null,
): PromiseSafetyPolicyForm {
  const value = head?.draftPolicy?.value
    ?? head?.activePolicy?.value
    ?? (scope.scopeType === "business"
      ? { policyMode: "fixed_units", fixedUnits: 0 } as const
      : { policyMode: "inherit" } as const);
  switch (value.policyMode) {
    case "inherit":
    case "off":
      return {
        policyMode: value.policyMode,
        fixedUnits: "0",
        daysOfCover: "1",
        untrustedDemandFallbackUnits: "0",
      };
    case "fixed_units":
      return {
        policyMode: value.policyMode,
        fixedUnits: String(value.fixedUnits),
        daysOfCover: "1",
        untrustedDemandFallbackUnits: "0",
      };
    case "days_of_cover":
      return {
        policyMode: value.policyMode,
        fixedUnits: "0",
        daysOfCover: formatMilliDays(value.daysOfCoverMilliDays),
        untrustedDemandFallbackUnits: String(value.untrustedDemandFallbackUnits),
      };
  }
}

export function parsePromiseSafetyPolicyForm(
  scope: PromiseSafetyAdminScope,
  form: PromiseSafetyPolicyForm,
): ParsedPromiseSafetyPolicyForm {
  if (scope.scopeType === "business" && form.policyMode === "inherit") {
    return { success: false, message: "The business default cannot inherit." };
  }
  let candidate: unknown;
  switch (form.policyMode) {
    case "inherit":
    case "off":
      candidate = { policyMode: form.policyMode };
      break;
    case "fixed_units": {
      const fixedUnits = parseInteger(form.fixedUnits);
      if (fixedUnits === null) {
        return { success: false, message: "Fixed safety units must be a whole number of zero or more." };
      }
      candidate = { policyMode: form.policyMode, fixedUnits };
      break;
    }
    case "days_of_cover": {
      const daysOfCoverMilliDays = parseMilliDays(form.daysOfCover);
      if (daysOfCoverMilliDays === null) {
        return {
          success: false,
          message: "Days of cover must be greater than zero with no more than three decimal places.",
        };
      }
      const untrustedDemandFallbackUnits = parseInteger(form.untrustedDemandFallbackUnits);
      if (untrustedDemandFallbackUnits === null) {
        return {
          success: false,
          message: "Fallback safety units must be a whole number of zero or more.",
        };
      }
      candidate = {
        policyMode: form.policyMode,
        daysOfCoverMilliDays,
        untrustedDemandFallbackUnits,
        demandMethodVersion: INVENTORY_DEMAND_METHOD_VERSION,
      };
      break;
    }
  }
  const parsed = promiseSafetyAdminValueSchema.safeParse(candidate);
  return parsed.success
    ? { success: true, value: parsed.data }
    : { success: false, message: parsed.error.issues[0]?.message ?? "The safety policy is invalid." };
}

export function formatPromiseSafetyPolicy(value: PromiseSafetyAdminValue): string {
  switch (value.policyMode) {
    case "inherit":
      return "Inherit the next broader policy";
    case "off":
      return "No safety floor";
    case "fixed_units":
      return `${value.fixedUnits.toLocaleString()} fixed unit${value.fixedUnits === 1 ? "" : "s"}`;
    case "days_of_cover":
      return `${formatMilliDays(value.daysOfCoverMilliDays)} days of cover; ${value.untrustedDemandFallbackUnits.toLocaleString()} fallback units`;
  }
}

function parseInteger(value: string): number | null {
  const normalized = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) && parsed <= POSTGRES_INTEGER_MAX ? parsed : null;
}

function parseMilliDays(value: string): number | null {
  const normalized = value.trim();
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,3}))?$/.exec(normalized);
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? "").padEnd(3, "0"));
  const result = whole * 1_000 + fraction;
  return Number.isSafeInteger(result) && result > 0 && result <= POSTGRES_INTEGER_MAX
    ? result
    : null;
}

function formatMilliDays(value: number): string {
  const whole = Math.floor(value / 1_000);
  const fraction = String(value % 1_000).padStart(3, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}
