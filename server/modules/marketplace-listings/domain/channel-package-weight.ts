import Decimal from "decimal.js";

const WeightDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_CEIL });
const GRAMS_PER_OUNCE = "28.349523125";
const GRAMS_PER_KILOGRAM = 1000;
const OUNCES_PER_POUND = 16;

export interface ChannelPackageWeightInput {
  value: number | string;
  unit: "GRAM" | "KILOGRAM" | "OUNCE" | "POUND";
}

export class ChannelPublicationWeightError extends Error {
  readonly code = "CHANNEL_PACKAGE_WEIGHT_INVALID";
  readonly context = { field: "package_weight", reason: "invalid" } as const;
  constructor() {
    super("Package weight must be a positive finite measurement that can be published in whole ounces. Correct the saved weight before syncing.");
    this.name = "ChannelPublicationWeightError";
  }
}

/** Shared publication precision. Catalog measurements remain exact; every
 * channel sends enough whole ounces to cover the known positive weight.
 * Pounds are an exact transport conversion for channels that require them. */
export function prepareChannelPublicationWeight(input: ChannelPackageWeightInput): { ounces: number; pounds: number } {
  const invalid = () => new ChannelPublicationWeightError();
  if (typeof input.value !== "number" && typeof input.value !== "string") throw invalid();
  if (typeof input.value === "string" && !/^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(input.value.trim())) throw invalid();
  let weight: Decimal;
  try { weight = new WeightDecimal(typeof input.value === "string" ? input.value.trim() : input.value); }
  catch { throw invalid(); }
  if (!weight.isFinite() || weight.lte(0)) throw invalid();
  let ounces: Decimal;
  switch (input.unit) {
    case "GRAM": ounces = weight.div(GRAMS_PER_OUNCE); break;
    case "KILOGRAM": ounces = weight.mul(GRAMS_PER_KILOGRAM).div(GRAMS_PER_OUNCE); break;
    case "POUND": ounces = weight.mul(OUNCES_PER_POUND); break;
    case "OUNCE": ounces = weight; break;
    default: throw invalid();
  }
  const wholeOunces = ounces.ceil();
  if (!Number.isSafeInteger(wholeOunces.toNumber()) || wholeOunces.lte(0)) throw invalid();
  return { ounces: wholeOunces.toNumber(), pounds: wholeOunces.div(OUNCES_PER_POUND).toNumber() };
}
