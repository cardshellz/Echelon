/**
 * Links inside a vendor alert's plain-text message (owner report: an eBay
 * shipping policy alert names each listing's eBay page and the Listing
 * settings page as plain URLs). Only https URLs on a fixed list of hosts
 * become links: eBay's own sites and the Card Shellz portal. Anything else,
 * a `javascript:` URL or another host, stays text. The page renders the
 * pieces as React text and anchor elements, never as HTML.
 */
export type VendorMessagePiece =
  | { kind: "text"; text: string }
  | { kind: "link"; href: string; text: string; external: boolean };

/** eBay's item and Seller Hub pages, production and sandbox. */
export const VENDOR_MESSAGE_EBAY_HOSTS: ReadonlySet<string> = new Set(["ebay.com", "www.ebay.com", "sandbox.ebay.com"]);
/** The Card Shellz vendor portal (DROPSHIP_PORTAL_URL's default, server/routes/ebay-oauth.routes.ts). */
export const VENDOR_MESSAGE_PORTAL_HOSTS: ReadonlySet<string> = new Set(["cardshellz.io"]);

/** A URL candidate runs to the next whitespace; sentence punctuation right after it stays text. */
const URL_CANDIDATE_PATTERN = /https?:\/\/\S+/g;
const TRAILING_PUNCTUATION_PATTERN = /[.,;:!?)\]"']+$/;

/**
 * The message as text and link pieces, in order. `portalOrigin` (the page's
 * own origin) is also allowed when it is https, so a portal on another
 * configured host links to itself.
 */
export function splitVendorMessageLinks(message: string, portalOrigin?: string | null): VendorMessagePiece[] {
  const portalHosts = new Set(VENDOR_MESSAGE_PORTAL_HOSTS);
  const ownHost = httpsHost(portalOrigin ?? null);
  if (ownHost) portalHosts.add(ownHost);

  const pieces: VendorMessagePiece[] = [];
  let last = 0;
  for (const match of message.matchAll(URL_CANDIDATE_PATTERN)) {
    const start = match.index ?? 0;
    const trailing = TRAILING_PUNCTUATION_PATTERN.exec(match[0])?.[0] ?? "";
    const candidate = match[0].slice(0, match[0].length - trailing.length);
    const host = httpsHost(candidate);
    const ebay = host !== null && VENDOR_MESSAGE_EBAY_HOSTS.has(host);
    if (!host || !(ebay || portalHosts.has(host))) continue;
    if (start > last) pieces.push({ kind: "text", text: message.slice(last, start) });
    pieces.push({ kind: "link", href: new URL(candidate).toString(), text: candidate, external: ebay });
    last = start + candidate.length;
  }
  if (last < message.length) pieces.push({ kind: "text", text: message.slice(last) });
  return pieces;
}

/** The lower-case host of an https URL with no credentials, else null. */
function httpsHost(value: string | null): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // Deliberate: text that is not a URL is shown as text.
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  return url.hostname.toLowerCase();
}
