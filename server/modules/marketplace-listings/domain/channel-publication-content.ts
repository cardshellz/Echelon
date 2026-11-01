export interface ChannelPublishedPhoto {
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly sourceAliases?: readonly string[];
}

/** Provider adapters normalize published state; this owner decides whether the
 * customer-visible content satisfies the accepted publication contract. */
export interface ChannelPublishedContent {
  readonly listingId: string;
  readonly skus: readonly string[];
  readonly policies: Readonly<Record<string, string>>;
  readonly photos: readonly ChannelPublishedPhoto[];
  /** Some providers expose only the original source of the gallery's first image. */
  readonly firstPhotoSource: string | null;
}

export interface ChannelPublicationContentExpectation {
  readonly listingId: string;
  readonly skus: readonly string[];
  readonly policies: Readonly<Record<string, string>>;
  readonly photoCount: number;
  readonly firstPhotoSource: string;
  readonly minimumPhotoLongestSide: number;
}

/** Return a safe field path. Inventory/offer echoes cannot substitute for this
 * published observation, and provider read failures must never become a match. */
export function findChannelPublishedContentMismatch(
  observed: ChannelPublishedContent,
  expected: ChannelPublicationContentExpectation,
): string | null {
  if (observed.listingId !== expected.listingId) return "published.listingId";
  const members = new Set(observed.skus);
  if (expected.skus.some((sku) => !members.has(sku))) return "published.skus";
  for (const [kind, value] of Object.entries(expected.policies)) {
    if (observed.policies[kind] !== value) return `published.policies.${kind}`;
  }
  if (observed.photos.length !== expected.photoCount)
    return "published.photos.count";
  if (observed.firstPhotoSource !== expected.firstPhotoSource)
    return "published.photos.firstSource";
  if (
    observed.photos.some(
      (photo) =>
        !Number.isSafeInteger(photo.width) ||
        !Number.isSafeInteger(photo.height) ||
        photo.width <= 0 ||
        photo.height <= 0 ||
        Math.max(photo.width, photo.height) < expected.minimumPhotoLongestSide,
    )
  )
    return "published.photos.resolution";
  return null;
}
