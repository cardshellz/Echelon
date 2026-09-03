import { normalizeDropshipOAuthReturnTo } from "../../domain/store-connection";

export function buildDropshipPortalOAuthRedirect(input: {
  portalUrl: string;
  status: "connected" | "error";
  returnTo: string | null;
  errorCode?: string;
}): string {
  const returnTo = input.returnTo === null
    ? null
    : normalizeDropshipOAuthReturnTo(input.returnTo);
  const url = new URL(returnTo || "/settings", input.portalUrl);
  url.searchParams.set("storeConnection", input.status);
  if (input.errorCode) {
    url.searchParams.set("error", input.errorCode);
  }
  return url.toString();
}
