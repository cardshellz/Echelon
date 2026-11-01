/** Trading and Inventory photos are subject to eBay's actual Picture Policy.
 * https://developer.ebay.com/devzone/xml/docs/Reference/ebay/types/PictureDetailsType.html */
export const EBAY_MINIMUM_PHOTO_LONGEST_SIDE = 500;

/** GetItem's legacy $_1 URL requests a 400px rendition even when the stored
 * original is larger. Read the same EPS image's full-size rendition; this does
 * not increase the source image's resolution or invent an original. */
export function ebayOriginalPhotoUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "i.ebayimg.com" ||
    url.username ||
    url.password ||
    url.port
  )
    return value;
  const legacy = url.pathname.match(
    /^\/00\/s\/[^/]+\/z\/([A-Za-z0-9~_-]+)\/\$_\d+\.(?:jpg|png|webp)$/i,
  );
  const modern = url.pathname.match(
    /^\/images\/g\/([A-Za-z0-9~_-]+)\/s-l\d+\.(?:jpg|png|webp)$/i,
  );
  const key = legacy?.[1] ?? modern?.[1];
  return key ? `https://i.ebayimg.com/images/g/${key}/s-l1600.jpg` : value;
}
