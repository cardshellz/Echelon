export interface ChannelLineDisplayNameInput {
  name?: string | null;
  title?: string | null;
  variantTitle?: string | null;
}

const DEFAULT_VARIANT_TITLES = new Set(["default title", "default"]);

function normalizeText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function isDefaultVariantTitle(value: string | null | undefined): boolean {
  const normalized = normalizeText(value);
  return normalized ? DEFAULT_VARIANT_TITLES.has(normalized.toLowerCase()) : true;
}

export function buildChannelLineDisplayName(input: ChannelLineDisplayNameInput): string {
  const name = normalizeText(input.name);
  if (name) return name;

  const title = normalizeText(input.title);
  const variantTitle = isDefaultVariantTitle(input.variantTitle)
    ? null
    : normalizeText(input.variantTitle);

  if (title && variantTitle) {
    const normalizedTitle = title.toLowerCase();
    const normalizedVariant = variantTitle.toLowerCase();
    if (
      normalizedTitle === normalizedVariant ||
      normalizedTitle.endsWith(` - ${normalizedVariant}`) ||
      normalizedTitle.includes(` ${normalizedVariant}`)
    ) {
      return title;
    }
    return `${title} - ${variantTitle}`;
  }

  return title || variantTitle || "Unknown Item";
}

export function chooseBestLineDisplayName(
  existingValue: string | null | undefined,
  incomingValue: string | null | undefined,
): string {
  const existing = normalizeText(existingValue);
  const incoming = normalizeText(incomingValue);

  if (!existing) return incoming || "Unknown Item";
  if (!incoming) return existing;
  if (existing === incoming) return existing;

  const existingLower = existing.toLowerCase();
  const incomingLower = incoming.toLowerCase();

  if (existingLower.includes(incomingLower) && existing.length >= incoming.length) {
    return existing;
  }
  if (incomingLower.includes(existingLower) && incoming.length >= existing.length) {
    return incoming;
  }

  const existingLooksComposed = existing.includes(" - ");
  const incomingLooksComposed = incoming.includes(" - ");
  if (existingLooksComposed && !incomingLooksComposed) return existing;
  if (incomingLooksComposed && !existingLooksComposed) return incoming;

  return incoming;
}
