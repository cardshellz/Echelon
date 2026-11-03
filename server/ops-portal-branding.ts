/**
 * Host-specific branding for the `.ops` dropship vendor portal.
 *
 * Echelon and the vendor portal are one client build served from one
 * index.html. Vendors reach the portal on cardshellz.io, where the Echelon
 * icon, name and installable-app manifest (which opens `/picking`) are wrong.
 * The swap happens on the server so the first HTML response already carries
 * the portal's icon: browsers, bookmarks and home-screen installs read the
 * icon before any client script runs. Every other host gets index.html
 * byte-for-byte unchanged.
 */

/** Hosts that serve the vendor portal at the root path. Keep in sync with
 * `isDropshipPortalHost` in client/src/lib/dropship-auth.tsx. */
const OPS_PORTAL_HOSTS: ReadonlySet<string> = new Set(["cardshellz.io", "www.cardshellz.io"]);

export const OPS_PORTAL_TITLE = "Card Shellz .ops";
const OPS_PORTAL_DESCRIPTION = "Card Shellz dropship portal";
const OPS_PORTAL_THEME_COLOR = "#581C87";

/** Tags in client/index.html that the portal replaces. Each must match exactly
 * once; a template change that breaks a match fails loudly at startup (static)
 * or on the first request (dev) instead of shipping half-branded HTML. */
const OPS_PORTAL_REPLACEMENTS: ReadonlyArray<readonly [from: string, to: string]> = [
  [
    `<link rel="icon" type="image/png" href="/favicon.png" />`,
    `<link rel="icon" type="image/svg+xml" href="/ops/favicon.svg" />\n    <link rel="icon" type="image/png" sizes="32x32" href="/ops/favicon-32.png" />`,
  ],
  [`<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`, `<link rel="apple-touch-icon" href="/ops/apple-touch-icon.png" />`],
  [`<link rel="manifest" href="/manifest.json" />`, `<link rel="manifest" href="/ops/manifest.json" />`],
  [`<meta name="apple-mobile-web-app-title" content="Echelon" />`, `<meta name="apple-mobile-web-app-title" content=".ops" />\n    <title>${OPS_PORTAL_TITLE}</title>`],
  [`<meta name="theme-color" content="#0f172a" />`, `<meta name="theme-color" content="${OPS_PORTAL_THEME_COLOR}" />`],
  [`<meta property="og:title" content="Echelon" />`, `<meta property="og:title" content="${OPS_PORTAL_TITLE}" />`],
  [`<meta name="twitter:title" content="Echelon" />`, `<meta name="twitter:title" content="${OPS_PORTAL_TITLE}" />`],
  [
    `<meta property="og:description" content="End-to-end operations from purchase to fulfillment" />`,
    `<meta property="og:description" content="${OPS_PORTAL_DESCRIPTION}" />`,
  ],
  [
    `<meta name="twitter:description" content="End-to-end operations from purchase to fulfillment" />`,
    `<meta name="twitter:description" content="${OPS_PORTAL_DESCRIPTION}" />`,
  ],
];

export class OpsPortalBrandingError extends Error {
  readonly code = "OPS_PORTAL_BRANDING_TEMPLATE_MISMATCH";
  constructor(readonly context: { tag: string; matches: number }) {
    super(`index.html must contain exactly one ${context.tag} for .ops branding; found ${context.matches}.`);
    this.name = "OpsPortalBrandingError";
  }
}

/** `hostname` as Express reports it (`req.hostname`: no port, proxy-aware). */
export function isOpsPortalHost(hostname: string | undefined): boolean {
  return typeof hostname === "string" && OPS_PORTAL_HOSTS.has(hostname.trim().toLowerCase());
}

/** Pure: returns the portal-branded copy of the Echelon index.html. */
export function applyOpsPortalBranding(html: string): string {
  let branded = html;
  for (const [from, to] of OPS_PORTAL_REPLACEMENTS) {
    const matches = branded.split(from).length - 1;
    if (matches !== 1) throw new OpsPortalBrandingError({ tag: from, matches });
    branded = branded.replace(from, to);
  }
  return branded;
}

/** The HTML for this request's host. */
export function indexHtmlForHost(html: string, hostname: string | undefined): string {
  return isOpsPortalHost(hostname) ? applyOpsPortalBranding(html) : html;
}
