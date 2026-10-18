export class ShipmentCreateError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode: number) {
    super(message);
    this.name = "ShipmentCreateError";
  }
}

const SHIPMENT_NUMBER_MAX_LENGTH = 30;

export function shipmentNumberPrefix(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Shipment creation requires a valid clock");
  return `SHP-${now.toISOString().slice(0, 10).replaceAll("-", "")}-`;
}

/** Numeric comparison avoids 999 sorting after 1000. BigInt never rounds a suffix. */
export function nextShipmentNumber(prefix: string, largestSuffix: string | null): string {
  if (!/^SHP-\d{8}-$/.test(prefix) || (largestSuffix !== null && !/^\d+$/.test(largestSuffix))) {
    throw new TypeError("Stored shipment numbering evidence is invalid");
  }
  const next = (largestSuffix === null ? BigInt(0) : BigInt(largestSuffix)) + BigInt(1);
  const number = `${prefix}${next.toString().padStart(3, "0")}`;
  if (number.length > SHIPMENT_NUMBER_MAX_LENGTH) {
    throw new ShipmentCreateError(
      "SHIPMENT_CREATE_NUMBER_EXHAUSTED",
      "Automatic shipment numbering is exhausted for this date. Choose a manual shipment number.",
      409,
    );
  }
  return number;
}

const MODE_DEFAULT_ALLOCATION: Readonly<Record<string, string>> = Object.freeze({
  sea_fcl: "by_volume", sea_lcl: "by_volume", air: "by_chargeable_weight",
  ground: "by_weight", ltl: "by_weight", ftl: "by_weight", parcel: "by_weight", courier: "by_weight",
});

export function shipmentDefaultAllocation(mode: string | null | undefined): string {
  return mode ? MODE_DEFAULT_ALLOCATION[mode] ?? "by_volume" : "by_volume";
}
