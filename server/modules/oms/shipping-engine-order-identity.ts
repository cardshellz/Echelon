export type LegacyHeaderPolicy = "strict" | "aggregate_projection";

export type ProviderOrderIdResolution =
  | "compatible"
  | "known_alias"
  | "stable_key_alias"
  | "conflict";

export interface ResolveProviderOrderIdInput {
  readonly legacyHeaderPolicy: LegacyHeaderPolicy;
  readonly persistedProviderOrderId: string | null;
  readonly persistedProviderOrderKey: string | null;
  readonly incomingProviderOrderId: string | null;
  readonly incomingProviderOrderKey: string | null;
  readonly incomingProviderOrderIdAlreadyAliased: boolean;
}

function normalize(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

/**
 * A provider order key identifies stable logical shipping work. A provider may
 * create multiple order records for that work while splitting or recreating
 * physical packages, so provider order ids are aliases once the stable key is
 * proven equal. Physical package identity remains independently enforced.
 */
export function resolveProviderOrderId(
  input: ResolveProviderOrderIdInput,
): ProviderOrderIdResolution {
  const persistedId = normalize(input.persistedProviderOrderId);
  const incomingId = normalize(input.incomingProviderOrderId);
  if (!persistedId || !incomingId || persistedId === incomingId) {
    return "compatible";
  }
  if (input.incomingProviderOrderIdAlreadyAliased) {
    return "known_alias";
  }

  const persistedKey = normalize(input.persistedProviderOrderKey);
  const incomingKey = normalize(input.incomingProviderOrderKey);
  if (
    input.legacyHeaderPolicy === "aggregate_projection"
    && persistedKey
    && incomingKey
    && persistedKey === incomingKey
  ) {
    return "stable_key_alias";
  }
  return "conflict";
}
