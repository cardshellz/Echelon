import { calculateChannelExposure } from "@shared/inventory/channel-exposure-calculation";

import { formatPercent, formatUnits, parseWholeUnits } from "./format";
import { policyFormToValue, type PolicyForm } from "./model";

export type PolicyQuantityExampleResult =
  | { ok: false; message: string; stockError?: string }
  | { ok: true; publishedUnits: string; steps: Array<{ label: string; units: string }> };

/** Uses only the operator's hypothetical input, never catalog stock or publication evidence. */
export function buildPolicyQuantityExample(form: PolicyForm, availableStock: string): PolicyQuantityExampleResult {
  const stock = parseWholeUnits(availableStock, "Example available stock");
  if (!stock.ok) return { ok: false, message: stock.message, stockError: stock.message };
  const parsed = policyFormToValue(form, { requireComplete: true });
  if (!parsed.ok) return { ok: false, message: "Complete the inventory settings with valid values to see this example." };
  const policy = parsed.value;
  // Narrow explicitly; null must never become an invented zero or unlimited value.
  if (policy.eligible === null || policy.shareBps === null || policy.holdbackSellableUnits === null
    || policy.maxPublish === null || policy.minPublishSellableUnits === null) {
    return { ok: false, message: "Complete the inventory settings to see this example." };
  }
  const calculation = calculateChannelExposure(BigInt(stock.value), {
    eligible: policy.eligible,
    shareBps: policy.shareBps,
    holdbackSellableUnits: policy.holdbackSellableUnits,
    maxPublishSellableUnits: policy.maxPublish.mode === "units" ? policy.maxPublish.units : null,
    minPublishSellableUnits: policy.minPublishSellableUnits,
  });
  const steps: Array<{ label: string; units: string }> = [];
  if (!policy.eligible) {
    steps.push({ label: "Marked as out of stock", units: "0" });
  } else {
    steps.push({ label: `After ${formatPercent(policy.shareBps)} of available stock`, units: calculation.sharedUnits.toString() });
    if (policy.holdbackSellableUnits !== "0") {
      steps.push({ label: `After a buffer of ${formatUnits(policy.holdbackSellableUnits)}`, units: calculation.afterHoldbackUnits.toString() });
    }
    if (policy.maxPublish.mode === "units") {
      steps.push({ label: `After a maximum of ${formatUnits(policy.maxPublish.units)}`, units: calculation.cappedUnits.toString() });
    }
    if (policy.minPublishSellableUnits !== "0") {
      steps.push({ label: `After an out-of-stock cutoff of ${formatUnits(policy.minPublishSellableUnits)}`, units: calculation.publishedUnits.toString() });
    }
  }
  return { ok: true, publishedUnits: calculation.publishedUnits.toString(), steps };
}
