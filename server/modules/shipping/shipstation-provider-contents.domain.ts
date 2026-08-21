export const POSTGRES_INTEGER_MAX = 2_147_483_647;

const MAX_WMS_ITEM_LINE_KEY_LENGTH = "wms-item-2147483647".length;
const MAX_PROVIDER_SHIPMENT_ITEMS = 500;

export interface ExactWmsShipmentItem {
  readonly sourceShipmentItemId: number;
  readonly quantity: number;
}

interface RawProviderShipmentItem {
  readonly lineItemKey?: unknown;
  readonly quantity?: unknown;
}

interface CanonicalProviderShipmentItem {
  readonly sourceShipmentItemId?: unknown;
  readonly quantity?: unknown;
}

export function isPositivePostgresInteger(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= POSTGRES_INTEGER_MAX;
}

function requireUniqueItems(
  items: readonly ExactWmsShipmentItem[],
): readonly ExactWmsShipmentItem[] | null {
  if (items.length === 0) return null;

  const seen = new Set<number>();
  for (const item of items) {
    if (seen.has(item.sourceShipmentItemId)) return null;
    seen.add(item.sourceShipmentItemId);
  }

  return Object.freeze(
    [...items]
      .sort((left, right) =>
        left.sourceShipmentItemId - right.sourceShipmentItemId
      )
      .map((item) => Object.freeze({ ...item })),
  );
}

export function parseExactPositiveWmsShipmentItems(
  items: unknown,
): readonly ExactWmsShipmentItem[] | null {
  if (
    !Array.isArray(items) || items.length === 0 || items.length > MAX_PROVIDER_SHIPMENT_ITEMS
  ) {
    return null;
  }

  const parsed: ExactWmsShipmentItem[] = [];
  for (const rawItem of items) {
    if (rawItem === null || typeof rawItem !== "object") return null;
    const item = rawItem as RawProviderShipmentItem;
    if (
      typeof item.lineItemKey !== "string"
      || item.lineItemKey.length > MAX_WMS_ITEM_LINE_KEY_LENGTH
    ) {
      return null;
    }
    const match = /^wms-item-([1-9][0-9]*)$/.exec(item.lineItemKey);
    if (!match) return null;
    const sourceShipmentItemId = Number(match[1]);
    if (
      !isPositivePostgresInteger(sourceShipmentItemId)
      || !isPositivePostgresInteger(item.quantity)
    ) {
      return null;
    }
    parsed.push({ sourceShipmentItemId, quantity: item.quantity });
  }

  return requireUniqueItems(parsed);
}

export function normalizeExactPositiveWmsShipmentItems(
  items: unknown,
): readonly ExactWmsShipmentItem[] | null {
  if (
    !Array.isArray(items) || items.length === 0 || items.length > MAX_PROVIDER_SHIPMENT_ITEMS
  ) {
    return null;
  }

  const parsed: ExactWmsShipmentItem[] = [];
  for (const rawItem of items) {
    if (rawItem === null || typeof rawItem !== "object") return null;
    const item = rawItem as CanonicalProviderShipmentItem;
    if (
      !isPositivePostgresInteger(item.sourceShipmentItemId)
      || !isPositivePostgresInteger(item.quantity)
    ) {
      return null;
    }
    parsed.push({
      sourceShipmentItemId: item.sourceShipmentItemId,
      quantity: item.quantity,
    });
  }

  return requireUniqueItems(parsed);
}
