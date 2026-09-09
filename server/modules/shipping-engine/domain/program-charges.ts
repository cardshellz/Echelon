import {
  programChargesSchema,
  type ProgramCharges,
  type ProgramChargeEvidence,
} from "@shared/shipping/configuration";
import { ShippingConfigurationError } from "./configuration-error";

function safeCents(value: bigint): number {
  if (value < BigInt(0) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ShippingConfigurationError(
      "SHIPPING_CHARGE_OVERFLOW",
      "Program charges exceed the supported currency amount.",
    );
  }
  return Number(value);
}

/** Integer arithmetic throughout. Floor each percentage before adding fixed
 * cents and applying caps, preserving the established Dropship fee semantics. */
function fee(basis: bigint, rule: ProgramCharges["markup"]): bigint {
  let result =
    (basis * BigInt(rule.bps)) / BigInt(10000) + BigInt(rule.fixedCents);
  if (rule.minCents !== null && result < BigInt(rule.minCents))
    result = BigInt(rule.minCents);
  if (rule.maxCents !== null && result > BigInt(rule.maxCents))
    result = BigInt(rule.maxCents);
  return result;
}

export function applyProgramCharges(
  baseCents: number,
  charges: ProgramCharges,
  revision: number,
): ProgramChargeEvidence {
  if (
    !Number.isSafeInteger(baseCents) ||
    baseCents < 0 ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    throw new ShippingConfigurationError(
      "SHIPPING_CHARGE_INVALID",
      "Program charge inputs must be non-negative safe integers.",
    );
  const validated = programChargesSchema.parse(charges);
  const base = BigInt(baseCents);
  const markup = fee(base, validated.markup);
  // Insurance is a charge on base + markup, not carrier insurance procurement.
  const insurance = fee(base + markup, validated.insurance);
  return {
    revision,
    baseCents,
    markupCents: safeCents(markup),
    insuranceCents: safeCents(insurance),
    totalCents: safeCents(base + markup + insurance),
    charges: validated,
  };
}
