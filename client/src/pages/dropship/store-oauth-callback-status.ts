export interface StoreOAuthCallbackStatus {
  kind: "connected" | "error";
  errorCode: string | null;
}

export function readStoreOAuthCallbackStatus(search: string): StoreOAuthCallbackStatus | null {
  const params = new URLSearchParams(search);
  const status = params.get("storeConnection");
  if (status === "connected") {
    return { kind: "connected", errorCode: null };
  }
  if (status === "error") {
    return { kind: "error", errorCode: params.get("error") };
  }
  return null;
}

export function storeOAuthCallbackMessage(
  status: StoreOAuthCallbackStatus,
  connectedStoreName?: string | null,
): string {
  if (status.kind === "connected") {
    return "Store connection completed.";
  }

  const storeTarget = connectedStoreName?.trim()
    ? `the eBay account that owns ${connectedStoreName.trim()}`
    : "the eBay account for the connected store";

  switch (status.errorCode) {
    case "DROPSHIP_STORE_OAUTH_ACCOUNT_MISMATCH":
    case "DROPSHIP_STORE_OAUTH_LEGACY_ACCOUNT_MISMATCH":
      return `The authorization was not saved because a different eBay account was used. Sign in to ${storeTarget}, or choose Change eBay store if you intended to replace it.`;
    case "DROPSHIP_STORE_OAUTH_ENVIRONMENT_MISMATCH":
    case "DROPSHIP_STORE_OAUTH_IDENTITY_SCHEME_MISMATCH":
      return "The authorization was not saved because eBay returned an incompatible account identity. Retry once, then contact support if the problem continues.";
    case "DROPSHIP_STORE_OAUTH_DECLINED":
      return "eBay authorization was cancelled. No connection changes were saved.";
    case "DROPSHIP_EBAY_TOKEN_EXCHANGE_FAILED":
    case "DROPSHIP_EBAY_STABLE_ACCOUNT_ID_REQUIRED":
      return "eBay did not complete account authorization. No connection changes were saved; retry the authorization.";
    case "DROPSHIP_OAUTH_STATE_EXPIRED":
      return "The eBay authorization request expired. Start the authorization again.";
    case "DROPSHIP_INVALID_OAUTH_STATE":
    case "DROPSHIP_STORE_OAUTH_STATE_MISMATCH":
      return "The eBay authorization request could not be verified. Start the authorization again.";
    default:
      return status.errorCode
        ? `Store connection failed. No connection changes were saved. Reference: ${status.errorCode}.`
        : "Store connection failed. No connection changes were saved.";
  }
}
