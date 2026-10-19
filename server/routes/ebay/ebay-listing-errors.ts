import { EbayBusinessPolicyError, ebayPolicySourceSchema } from "@shared/ebay-business-policies";
import { z } from 'zod';
import { resolveEbayListingIssue, safeListingDiagnostic } from '@shared/ebay-listing-issue';
import { publicationSelectionBusyIssue } from '../../modules/inventory-planning/publication-selection-work';

export function listingFailure(error: unknown, productId?: number, jobId?: string) {
  const busy = publicationSelectionBusyIssue(error);
  if (busy) return { ...busy, error: busy.message,
    issue: resolveEbayListingIssue({ code: busy.code, message: busy.message, productId, jobId }) };
  const savedJob = z.string().uuid().safeParse(jobId ?? (error instanceof Error && 'jobId' in error ? error.jobId : undefined));
  const code = error instanceof z.ZodError ? 'EBAY_LISTING_INPUT_INVALID'
    : error instanceof Error && 'code' in error && typeof error.code === 'string' && /^(EBAY_|PUBLICATION_|QUANTITY_)/.test(error.code)
      ? error.code : 'EBAY_LISTING_SYNC_FAILED';
  const message = error instanceof z.ZodError ? 'The request is invalid. Refresh this page and select the product again.'
    : error instanceof Error && code !== 'EBAY_LISTING_SYNC_FAILED' ? safeListingDiagnostic(error.message)
      : 'The listing operation could not finish. Refresh its saved status before retrying.';
  const policySource = error instanceof EbayBusinessPolicyError ? ebayPolicySourceSchema.safeParse(error.context.policySource) : undefined;
  console.error(JSON.stringify({ event: 'ebay_listing_request_failed', code, productId }));
  return { code, error: message, issue: resolveEbayListingIssue({ code, message, productId, jobId: savedJob.success ? savedJob.data : undefined, ...(policySource?.success ? { policySource: policySource.data } : {}) }) };
}
export function listingFailureStatus(error: unknown): number {
  if (error instanceof EbayBusinessPolicyError) return error.statusCode;
  if (publicationSelectionBusyIssue(error)) return 409;
  if (error instanceof z.ZodError) return 400;
  const code = error instanceof Error && 'code' in error ? error.code : null;
  if (code === 'EBAY_SYNC_JOB_NOT_FOUND') return 404;
  if (code === 'EBAY_WITHDRAWAL_IN_PROGRESS') return 409;
  if (code === 'EBAY_PUBLICATION_PRIOR_WORK_REQUIRED') return 409;
  if (typeof code === 'string' && code.startsWith('EBAY_PUBLICATION_STOCK_') && !code.endsWith('RECEIPT_INCOMPLETE')) return 409;
  if (code === 'EBAY_MAPPING_REPAIR_UNSAFE' || code === 'EBAY_MAPPING_SOURCE_INVALID' || code === 'EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE') return 409;
  if (typeof code === 'string' && /CONFLICT|CHANGED|BUSY|STALE|SCOPE|RECOVERY/.test(code)) return 409;
  return 500;
}
