/** Fixed private portal destinations. Never derive a sign-in redirect from request input. */
export const CUSTOMER_RETURN_PORTAL_PATH = "/return-portal";
export const CUSTOMER_RETURN_PORTAL_ACCESS_PATH = "/return-portal/access";
export const CUSTOMER_RETURN_PORTAL_LEGACY_PATH = "/returns/portal-preview";
export const CUSTOMER_RETURN_PREVIEW_API_PATH = "/api/returns/admin/portal-preview";

/** Includes the sign-in page and legacy shortcut so they bypass the staff application shell. */
export function isCustomerReturnPortalPath(pathname: string): boolean {
  // Match Express and Wouter's case-insensitive paths before selecting a shell.
  const path = pathname.toLowerCase();
  return [CUSTOMER_RETURN_PORTAL_PATH, CUSTOMER_RETURN_PORTAL_LEGACY_PATH]
    .some(prefix => path === prefix || path.startsWith(`${prefix}/`));
}
