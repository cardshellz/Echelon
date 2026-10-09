import { z } from 'zod';
import { resolveEbayListingIssue, safeListingDiagnostic } from '@shared/ebay-listing-issue';

export function listingFailure(error: unknown, productId?: number) {
  const code = error instanceof z.ZodError ? 'EBAY_LISTING_INPUT_INVALID'
    : error instanceof Error && 'code' in error && typeof error.code === 'string' && /^(EBAY_|PUBLICATION_|QUANTITY_)/.test(error.code)
      ? error.code : 'EBAY_LISTING_SYNC_FAILED';
  const message = error instanceof z.ZodError ? 'The request is invalid. Refresh this page and select the product again.'
    : error instanceof Error && code !== 'EBAY_LISTING_SYNC_FAILED' ? safeListingDiagnostic(error.message)
      : 'The listing operation could not finish. Refresh its saved status before retrying.';
  console.error(JSON.stringify({ event: 'ebay_listing_request_failed', code, productId }));
  return { code, error: message, issue: resolveEbayListingIssue({ code, message, productId }) };
}
export function listingFailureStatus(error: unknown): number {
  if (error instanceof z.ZodError) return 400;
  const code = error instanceof Error && 'code' in error ? error.code : null;
  if (code === 'EBAY_SYNC_JOB_NOT_FOUND') return 404;
  if (typeof code === 'string' && /CONFLICT|CHANGED|BUSY|STALE|SCOPE|RECOVERY/.test(code)) return 409;
  return 500;
}
