export function isEbayResourceAuthFailureStatus(status: number): boolean {
  return status === 401 || status === 403;
}

// OAuth refresh uses 400 for invalid_grant; eBay resource APIs use 400 for ordinary payload validation.
export function isEbayTokenRefreshAuthFailureStatus(status: number): boolean {
  return status === 400 || status === 401 || status === 403;
}
