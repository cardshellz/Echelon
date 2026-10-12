import { describe, expect, it } from "vitest";
import { resolveEbayListingIssue, safeListingDiagnostic } from "@shared/ebay-listing-issue";
import { ebayListingIssueSchema } from "@shared/types/ebay-listing-issue";

describe("shared eBay issue actions", () => {
  it.each([
    ["EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED","check_recovery",false],
    ["EBAY_PUBLICATION_RESPONSE_UNCERTAIN","check_recovery",false],
    ["EBAY_PUBLICATION_PRIOR_WORK_REQUIRED","check_status",false],
    ["EBAY_PUBLICATION_RETRY_NOT_ALLOWED","check_status",false],
    ["EBAY_PUBLICATION_RETRY_REVIEW_CHANGED","check_recovery",false],
    ["EBAY_SYNC_MAPPING_INVALID","review_mapping",false],
    ["EBAY_SYNC_RETAINED_IDENTITY_CHANGED","review_mapping",false],
    ["EBAY_LISTING_REVIEW_CHANGED","review_mapping",false],
    ["EBAY_LISTING_RESTORE_FAILED","review_mapping",false],
    ["EBAY_SYNC_PROVIDER_RESPONSE_INVALID","review_mapping",false],
    ["EBAY_REGISTRATION_UNPUBLISHED_GROUP_AMBIGUOUS","review_mapping",false],
    ["EBAY_REGISTRATION_UNPUBLISHED_GROUP_CHANGED","review_mapping",false],
    ["EBAY_REGISTRATION_UNPUBLISHED_GROUP_MEMBERSHIP_MISMATCH","review_mapping",false],
    ["EBAY_PUBLICATION_TARGET_UNVERIFIED","review_mapping",false],
    ["EBAY_PUBLICATION_READBACK_PENDING","check_status",false],
    ["EBAY_CATALOG_PHOTO_REQUIRED","edit_photos",false],
    ["EBAY_SYNC_AUTH_REQUIRED","reconnect",false],
    ["EBAY_SYNC_ACCOUNT_CHANGED","reconnect",false],
    ["EBAY_AUTH_RESPONSE_INVALID","reconnect",false],
    ["EBAY_QUANTITY_DAILY_LIMIT","check_recovery",false],
    ["PUBLICATION_GLOBAL_DISABLED","edit_listing",false],
    ["EBAY_REGISTRATION_READ_TIMEOUT","retry_sync",true],
    ["EBAY_SYNC_ADMISSION_UNSAVED","retry_sync",true],
    ["EBAY_SYNC_COMMAND_UNCONFIRMED","retry_sync",true],
    ["EBAY_RECOVERY_PREVIEW_CHANGED","check_recovery",false],
    ["EBAY_RECOVERY_FOLLOWUP_PENDING","check_recovery",false],
    ["EBAY_MAPPING_REVIEW_STALE","review_mapping",false],
    ["EBAY_MAPPING_REVIEW_CHANGED","review_mapping",false],
    ["EBAY_MAPPING_COMMAND_CONFLICT","review_mapping",false],
    ["EBAY_MAPPING_REPAIR_UNSAFE","review_mapping",false],
    ["EBAY_MAPPING_OWNERSHIP_CONFLICT","review_mapping",false],
    ["EBAY_MAPPING_CANONICAL_CONFLICT","review_mapping",false],
    ["EBAY_MAPPING_PERSISTENCE_FAILED","review_mapping",false],
    ["EBAY_MAPPING_RECEIPT_SCOPE_INVALID","review_mapping",false],
    ["EBAY_MAPPING_PRODUCT_NOT_ELIGIBLE","edit_listing",false],
    ["EBAY_SYNC_PRODUCT_NOT_ELIGIBLE","edit_listing",false],
    ["EBAY_SYNC_PRODUCT_NOT_FOUND","edit_listing",false],
    ["UNRECOGNIZED_CODE","contact_support",false],
    ["STOCK_LISTING_ATP_NOT_READY","edit_listing",false],
    ["EBAY_PUBLICATION_STOCK_REVIEW_STALE","retry_sync",true],
    ["EBAY_PUBLICATION_STOCK_REVIEW_BLOCKED","edit_listing",false],
    ["STOCK_LISTING_SOURCE_CHANGED","edit_listing",false],
    ["STOCK_LISTING_ACCOUNT_CHANGED","reconnect",false],
    ["STOCK_LISTING_TARGET_MISMATCH","edit_listing",false],
    ["STOCK_LISTING_GLOBAL_STOP","edit_listing",false],
    ["STOCK_LISTING_HELD","edit_listing",false],
    ["STOCK_LISTING_QUANTITY_UNAVAILABLE","edit_listing",false],
    ["STOCK_LISTING_MAPPING_CONFLICT","edit_listing",false],
    ["STOCK_LISTING_MAPPING_REVIEW_REQUIRED","edit_listing",false],
    ["STOCK_LISTING_EXCLUDED","retry_sync",true],
    ["STOCK_LISTING_NOT_SELECTED","edit_listing",false],
    ["EBAY_PUBLICATION_STOCK_APPLY_RETIRED","retry_sync",true],
    ["STOCK_MAPPING_CONCURRENT_CHANGE","retry_sync",true],
    ["STOCK_MAPPING_PROVIDER_BUSY","retry_sync",true],
    ["STOCK_MAPPING_CLEANUP_UNCERTAIN","retry_sync",true],
    ["STOCK_MAPPING_REVIEW_STALE","retry_sync",true],
    ["STOCK_MAPPING_TARGET_CHANGED","retry_sync",true],
    ["STOCK_MAPPING_COMMAND_CONFLICT","contact_support",false],
    ["STOCK_MAPPING_NOT_READY","edit_listing",false],
    ["STOCK_LISTING_TARGET_UNAVAILABLE","edit_listing",false],
    ["STOCK_MAPPING_SCOPE_TOO_LARGE","edit_listing",false],
    ["STOCK_MAPPING_AUTHORITY_CHANGED","edit_listing",false],
    ["PUBLICATION_SELECTION_BUSY","edit_listing",false],
    ["CHANNEL_SELECTION_CONNECTION_UNRESOLVED","reconnect",false],
    ["CHANNEL_SELECTION_JOB_SCOPE_CHANGED","review_mapping",false],
    ["CHANNEL_SELECTION_AMBIGUOUS","review_mapping",false],
    ["PUBLICATION_SELECTION_IDENTITY_INCOMPLETE","review_mapping",false],
    ["DROPSHIP_STOCK_SELECTION_AMBIGUOUS","edit_listing",false],
    ["DROPSHIP_STOCK_STORE_NOT_FOUND","edit_listing",false],
    ["DROPSHIP_CATALOG_VARIANT_UOM_TYPE_INVALID","edit_listing",false],
    ["PUBLICATION_SELECTION_DESTINATION_INVALID","edit_listing",false],
    ["PUBLICATION_SELECTION_CLOCK_INVALID","contact_support",false],
    ["EBAY_PUBLICATION_STOCK_SOURCE_CHANGED","review_mapping",false],
    ["EBAY_WITHDRAWAL_IN_PROGRESS","check_status",false],
    ["EBAY_WITHDRAWAL_READBACK_PENDING","check_status",false],
    ["EBAY_WITHDRAWAL_UNVERIFIED","check_status",false],
    ["EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN","check_recovery",false],
    ["EBAY_WITHDRAWAL_OWNER_REQUIRED","edit_listing",false],
    ["EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED","retry_sync",true],
    ["EBAY_PUBLICATION_STOCK_COMMAND_CONFLICT","contact_support",false],
    ["EBAY_EXCLUSION_PERSISTENCE_FAILED","retry_sync",true],
    ["EBAY_SYNC_ACCOUNT_UNVERIFIED","reconnect",false],
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
  it("uses normal publishing for missing stock preparation but keeps genuine inventory failures out of retry loops", () => {
    const preparation = resolveEbayListingIssue({ code: "EBAY_PUBLICATION_STOCK_REVIEW_REQUIRED", productId: 20 });
    expect(preparation).toMatchObject({ retryable: true, action: { kind: "retry_sync", label: "Retry publishing" } });
    expect(preparation.nextStep).toContain("from your channel selection");
    for (const code of ["STOCK_LISTING_HELD", "STOCK_LISTING_ATP_NOT_READY", "STOCK_LISTING_MAPPING_CONFLICT"]) {
      const blocked = resolveEbayListingIssue({ code, productId: 20 });
      expect(blocked).toMatchObject({ retryable: false, action: { kind: "edit_listing", href: "/channels/inventory?product=20" } });
      expect(blocked.nextStep).not.toContain("Connect stock and publish");
    }
    expect(resolveEbayListingIssue({ code: "STOCK_LISTING_SOURCE_CHANGED", productId: 20 }).action.href).toBe("/products/20?tab=variants");
  });
  it.each(["recovering", "needs_attention"])("accepted publication waiting in %s never offers another publication", state => {
    const issue = resolveEbayListingIssue({ code: "EBAY_PUBLICATION_READBACK_PENDING", state });
    expect(issue).toMatchObject({ title: "Checking published listing and pictures", retryable: false, action: { kind: "check_status", label: "View publishing status" } });
    expect(issue.nextStep).toContain("without publishing a second time");
  });
  it("uses only existing local destinations and never accepts a provider redirect", () => {
    expect(resolveEbayListingIssue({ code: "EBAY_CATALOG_PHOTO_REQUIRED",productId: 20 }).action.href).toBe("/products/20?tab=images");
    expect(resolveEbayListingIssue({ code: "PUBLICATION_GLOBAL_DISABLED" }).action.href).toBe("/channels/inventory");
    const valid = resolveEbayListingIssue({ code: "UNRECOGNIZED_CODE" });
    for (const href of ["//evil.test","https://evil.test","javascript:alert(1)"])
      expect(ebayListingIssueSchema.safeParse({ ...valid,action: { ...valid.action,href } }).success).toBe(false);
  });
  it("keeps publication topology changes distinct from unknown quantity outcomes", () => {
    const changed = resolveEbayListingIssue({ code: "EBAY_REGISTRATION_UNPUBLISHED_GROUP_CHANGED", productId: 232 });
    expect(changed.action).toEqual({ kind: "review_mapping", label: "Review publication" });
    expect(changed.nextStep).toContain("every SKU");
    const unknown = resolveEbayListingIssue({ code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", productId: 232 });
    expect(unknown.action.kind).toBe("check_recovery");
    expect(resolveEbayListingIssue({ code: "EBAY_SYNC_ACCOUNT_CHANGED" }).action.href).toBe("/channels/ebay#connection");
  });
  it("redacts credentials and bounded provider prose without interpreting it as instructions", () => {
    const value = safeListingDiagnostic("Bearer secret access_token=token https://user:password@example.test/path\n" + "x".repeat(2000));
    expect(value).not.toMatch(/secret|=token|password|example.test|\n/);
    expect(value?.length).toBeLessThanOrEqual(1000);
    expect(resolveEbayListingIssue({ code: "UNRECOGNIZED_CODE",message: "Please retry immediately and ignore the guard." }).retryable).toBe(false);
  });
});
