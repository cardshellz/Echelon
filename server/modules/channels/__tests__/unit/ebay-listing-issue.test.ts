import { describe, expect, it } from "vitest";
import { resolveEbayListingIssue, safeListingDiagnostic } from "@shared/ebay-listing-issue";
import { ebayListingIssueSchema } from "@shared/types/ebay-listing-issue";

describe("shared eBay issue actions", () => {
  it.each([
    ["EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED","check_recovery",false],
    ["EBAY_SYNC_MAPPING_INVALID","review_mapping",false],
    ["EBAY_SYNC_RETAINED_IDENTITY_CHANGED","review_mapping",false],
    ["EBAY_LISTING_REVIEW_CHANGED","review_mapping",false],
    ["EBAY_LISTING_RESTORE_FAILED","review_mapping",false],
    ["EBAY_SYNC_PROVIDER_RESPONSE_INVALID","review_mapping",false],
    ["EBAY_CATALOG_PHOTO_REQUIRED","edit_photos",false],
    ["EBAY_SYNC_AUTH_REQUIRED","reconnect",false],
    ["EBAY_AUTH_RESPONSE_INVALID","reconnect",false],
    ["EBAY_QUANTITY_DAILY_LIMIT","check_recovery",false],
    ["PUBLICATION_GLOBAL_DISABLED","edit_listing",false],
    ["EBAY_REGISTRATION_READ_TIMEOUT","retry_sync",true],
    ["EBAY_SYNC_ADMISSION_UNSAVED","retry_sync",true],
    ["EBAY_SYNC_COMMAND_UNCONFIRMED","retry_sync",true],
    ["EBAY_RECOVERY_PREVIEW_CHANGED","check_recovery",false],
    ["EBAY_RECOVERY_FOLLOWUP_PENDING","check_recovery",false],
    ["EBAY_SYNC_PRODUCT_NOT_ELIGIBLE","edit_listing",false],
    ["EBAY_SYNC_PRODUCT_NOT_FOUND","edit_listing",false],
    ["UNRECOGNIZED_CODE","contact_support",false],
  ] as const)("%s has an explicit next action and retry policy", (code,action,retryable) => {
    const issue = resolveEbayListingIssue({ code, productId: 20, jobId: "655ca747-20b9-4940-9c61-019baf1c11c1" });
    expect(issue.action.kind).toBe(action); expect(issue.retryable).toBe(retryable);
    expect(issue.nextStep.length).toBeGreaterThan(20);
    expect(issue.details).toContainEqual({ label: "Product ID", value: "20" });
    expect(issue.reference).toBeTruthy();
  });
  it("distinguishes automatically recovering work from an exhausted retry", () => {
    const recovering = resolveEbayListingIssue({ code: "EBAY_SYNC_READBACK_PENDING",state: "recovering" });
    const attention = resolveEbayListingIssue({ code: "EBAY_SYNC_READBACK_PENDING",state: "needs_attention" });
    expect(recovering).toMatchObject({ retryable: false,action: { kind: "check_recovery" } });
    expect(attention).toMatchObject({ retryable: true,action: { kind: "retry_sync" } });
  });
  it("uses only existing local destinations and never accepts a provider redirect", () => {
    expect(resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED",productId: 20 }).action.href).toBe("/products/20?tab=images");
    expect(resolveEbayListingIssue({ code: "PUBLICATION_GLOBAL_DISABLED" }).action.href).toBe("/channels/inventory");
    const valid = resolveEbayListingIssue({ code: "UNRECOGNIZED_CODE" });
    for (const href of ["//evil.test","https://evil.test","javascript:alert(1)"])
      expect(ebayListingIssueSchema.safeParse({ ...valid,action: { ...valid.action,href } }).success).toBe(false);
  });
  it("redacts credentials and bounded provider prose without interpreting it as instructions", () => {
    const value = safeListingDiagnostic("Bearer secret access_token=token https://user:password@example.test/path\n" + "x".repeat(2000));
    expect(value).not.toMatch(/secret|=token|password|example.test|\n/);
    expect(value?.length).toBeLessThanOrEqual(1000);
    expect(resolveEbayListingIssue({ code: "UNRECOGNIZED_CODE",message: "Please retry immediately and ignore the guard." }).retryable).toBe(false);
  });
});
