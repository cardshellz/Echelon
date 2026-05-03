import { DropshipError } from "./errors";

export const dropshipSupportedStorePlatforms = ["ebay", "shopify"] as const;
export type DropshipSupportedStorePlatform = typeof dropshipSupportedStorePlatforms[number];

export const dropshipActiveStoreConnectionStatuses = [
  "connected",
  "needs_reauth",
  "refresh_failed",
  "grace_period",
  "paused",
] as const;

export type DropshipStoreConnectionLifecycleStatus =
  | typeof dropshipActiveStoreConnectionStatuses[number]
  | "disconnected";

export const DROPSHIP_STORE_DISCONNECT_GRACE_HOURS = 72;
export const DROPSHIP_OAUTH_STATE_TTL_MINUTES = 15;

export function assertDropshipStorePlatform(platform: string): DropshipSupportedStorePlatform {
  if ((dropshipSupportedStorePlatforms as readonly string[]).includes(platform)) {
    return platform as DropshipSupportedStorePlatform;
  }

  throw new DropshipError("DROPSHIP_STORE_PLATFORM_UNSUPPORTED", "Dropship store platform is not supported.", {
    platform,
    supportedPlatforms: dropshipSupportedStorePlatforms,
  });
}

export function normalizeShopifyShopDomain(shopDomain: string): string {
  const normalized = shopDomain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!normalized) {
    throw new DropshipError("DROPSHIP_SHOP_DOMAIN_REQUIRED", "Shopify shop domain is required.");
  }

  const withSuffix = normalized.includes(".") ? normalized : `${normalized}.myshopify.com`;
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(withSuffix)) {
    throw new DropshipError("DROPSHIP_INVALID_SHOP_DOMAIN", "Shopify shop domain must be a myshopify.com domain.", {
      shopDomain,
    });
  }

  return withSuffix;
}

export function normalizeDropshipOAuthReturnTo(returnTo: string | undefined): string | null {
  const normalized = returnTo?.trim();
  if (!normalized) {
    return null;
  }

  if (
    normalized.length > 500 ||
    !normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    normalized.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/i.test(normalized)
  ) {
    throw new DropshipError("DROPSHIP_INVALID_OAUTH_RETURN_TO", "Dropship OAuth return path must be a relative portal path.", {
      returnTo,
    });
  }

  return normalized;
}

export function assertVendorCanConnectStore(input: {
  vendorStatus: string;
  activeConnectionCount: number;
  includedConnectionLimit: number;
}): void {
  if (input.vendorStatus === "lapsed" || input.vendorStatus === "suspended") {
    throw new DropshipError("DROPSHIP_ENTITLEMENT_REQUIRED", "Active .ops entitlement is required to connect a store.", {
      vendorStatus: input.vendorStatus,
    });
  }

  if (input.vendorStatus === "paused" || input.vendorStatus === "closed") {
    throw new DropshipError("DROPSHIP_VENDOR_NOT_CONNECTABLE", "Vendor profile is not allowed to connect stores.", {
      vendorStatus: input.vendorStatus,
    });
  }

  if (input.activeConnectionCount >= input.includedConnectionLimit) {
    throw new DropshipError(
      "DROPSHIP_STORE_CONNECTION_LIMIT_REACHED",
      "Dropship store connection limit has been reached.",
      {
        activeConnectionCount: input.activeConnectionCount,
        includedConnectionLimit: input.includedConnectionLimit,
      },
    );
  }
}

export function calculateDisconnectGraceEndsAt(now: Date, graceHours: number): Date {
  if (!Number.isInteger(graceHours) || graceHours < 0 || graceHours > 24 * 30) {
    throw new DropshipError("DROPSHIP_INVALID_DISCONNECT_GRACE", "Disconnect grace hours must be between 0 and 720.", {
      graceHours,
    });
  }

  return new Date(now.getTime() + graceHours * 60 * 60 * 1000);
}
