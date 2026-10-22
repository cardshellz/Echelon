import { batchFixture, mockSyncBatches } from "./fixtures/channel-sync-batch.fixture";
import { channelIntentChange } from "./fixtures/listing-intent-changes.fixture";
import { expect, test, type Page } from "@playwright/test";
import { setupEbayChannelPage } from "./fixtures/ebay-channel-page.fixture";
import { resolveEbayListingIssue } from "../../shared/ebay-listing-issue";


test("AUDIT: excluded pending work opens its removal owner instead of the publication editor", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  state.excluded = true;
  state.feedStatus = "excluded";
  state.jobs = [{ ...withdrawal, state: "needs_attention", code: "EBAY_LISTING_SYNC_FAILED", message: "Removal needs review." }];
  state.intentChanges.items = [channelIntentChange(67, {
    state: "waiting_lifecycle", last_error_code: "LISTING_INTENT_LIFECYCLE_PENDING",
    last_error_message: "These members are excluded from content updates. Channel clearing or removal is still outstanding.",
    lifecycle: { assessedAt: "2026-10-20T20:00:00.000Z", selectionFingerprint: "a".repeat(64),
      members: [{ productVariantId: 11, duty: "stock_clear", state: "pending",
        code: "LISTING_LIFECYCLE_PRIOR_WORK", message: "Removal needs completion.", references: [withdrawal.id], nextActions: [{owner:"ebay_listing_sync",operationId:withdrawal.id}] }] },
  })];
  const publishingCalls: unknown[] = [];
  await page.route("**/api/ebay/listings/push", route => {
    publishingCalls.push(route.request().postDataJSON());
    // This is the real publication admission owner's excluded-product refusal.
    return route.fulfill({ json: { results: [{ productId: 1, success: false,
      error: "This product is excluded from eBay. Enable it in the listing feed before publishing." }] } });
  });
  await page.reload();
  const panel = page.getByTestId("listing-intent-changes");
  await panel.locator("summary").first().click();
  await panel.getByRole("button", { name: "Review listing", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Removal status", exact: true })).toBeVisible();
  expect(publishingCalls).toEqual([]);
});

const withdrawal = { id: "543b9237-920d-4786-a950-31c6fe941c8f", productId: 1, kind: "sync", operation: "withdraw", state: "queued", code: null, message: null,
  nextAttemptAt: "2026-10-12T12:00:00.000Z", updatedAt: "2026-10-12T12:00:00.000Z" };
const switchFor = (page: Page, included = true) => page.getByTitle(included ? "Exclude from eBay listings" : "Include in eBay listings", { exact: true });
type Command = { excluded: boolean; commandKey: string };
const receipt = (command: Command, job: unknown = withdrawal) => ({ success: true, productId: 1, excluded: command.excluded, commandKey: command.commandKey, replayed: false, job,
  remoteAction: command.excluded ? job ? "queued_withdrawal" : "local_exclusion" : "included" });

test("excluding saves removal and shows Ended only after the provider state is verified", async ({ page }, info) => {
  const state = await setupEbayChannelPage(page); const commands: Command[] = [];
  await page.route("**/api/ebay/product-exclusion/1", route => {
    commands.push(route.request().postDataJSON()); state.excluded = true; state.feedStatus = "excluded"; state.jobs = [withdrawal];
    return route.fulfill({ json: receipt(commands.at(-1)!) });
  });
  await page.route("**/api/ebay/product-exclusion/1/commands/*", route => route.fulfill({ status: 404, json: { error: "No saved receipt yet" } }));
  await switchFor(page).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("completion is not yet confirmed");
  await expect(dialog).not.toContainText("Removed from eBay.");
  expect(commands).toEqual([{ excluded: true, commandKey: expect.stringMatching(/^[a-f0-9-]{36}$/) }]);
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(switchFor(page, false)).not.toBeChecked(); await expect(switchFor(page, false)).toBeDisabled();
  await expect(page.getByText("Excluded · removal pending", { exact: true }).filter({ visible: true })).toBeVisible();
  await page.getByRole("button", { name: "View removal status", exact: true }).filter({ visible: true }).click();
  await expect(dialog.getByRole("heading", { name: "Removal status" })).toBeVisible();
  state.jobs = [{ ...withdrawal, state: "completed" }];
  await dialog.getByRole("button", { name: "Refresh removal status" }).click();
  await expect(dialog.getByRole("status")).toContainText("Removed from eBay.");
  await page.screenshot({ path: info.outputPath("verified-withdrawal.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByText("Ended on eBay · excluded", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an exclusion with a lost response survives reload and retries the identical command", async ({ page }) => {
  const state = await setupEbayChannelPage(page); const commands: Command[] = []; let accept = false;
  await page.route("**/api/ebay/product-exclusion/1", route => {
    commands.push(route.request().postDataJSON()); state.excluded = true; state.feedStatus = "excluded";
    if (!accept) return route.abort("failed");
    state.jobs = [withdrawal]; return route.fulfill({ json: receipt(commands.at(-1)!) });
  });
  await page.route("**/api/ebay/product-exclusion/1/commands/*", route => route.fulfill({ status: 404, json: { error: "No saved receipt yet" } }));
  await switchFor(page).click(); await expect(page.getByRole("dialog").getByRole("button", { name: "Retry same request" })).toBeVisible();
  await page.reload(); await expect(switchFor(page, false)).toBeDisabled();
  await page.getByRole("button", { name: "Check saved request", exact: true }).click();
  accept = true; await page.getByRole("dialog").getByRole("button", { name: "Retry same request" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("completion is not yet confirmed");
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(await page.evaluate(() => sessionStorage.getItem("ebay:product-exclusion:1"))).toBeNull();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("the exact exclusion receipt resolves a lost response without another write", async ({ page }) => {
  const state = await setupEbayChannelPage(page); const commands: Command[] = [];
  await page.route("**/api/ebay/product-exclusion/1", route => {
    commands.push(route.request().postDataJSON()); state.excluded = true; state.feedStatus = "excluded"; state.jobs = [withdrawal];
    return route.abort("failed");
  });
  await page.route("**/api/ebay/product-exclusion/1/commands/*", route => {
    expect(route.request().url()).toContain(commands[0].commandKey); return route.fulfill({ json: { ...receipt(commands[0]), replayed: true } });
  });
  await switchFor(page).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Exclusion saved. Removing the listing");
  expect(commands).toHaveLength(1); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("local exclusion without a provider job does not claim an eBay listing ended", async ({ page }) => {
  const state = await setupEbayChannelPage(page);
  await page.route("**/api/ebay/product-exclusion/1", route => { state.excluded = true; state.feedStatus = "excluded"; return route.fulfill({ json: receipt(route.request().postDataJSON(), null) }); });
  await switchFor(page).click(); const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("status")).toContainText("No provider removal was performed");
  await expect(dialog).not.toContainText("Removed from eBay.");
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByText("Excluded locally", { exact: true }).filter({ visible: true })).toBeVisible();
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("including again changes eligibility without claiming publication", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  const commands: Command[] = [];
  await page.route("**/api/ebay/product-exclusion/1", route => {
    commands.push(route.request().postDataJSON()); state.excluded = false; state.feedStatus = "ready";
    return route.fulfill({ json: receipt(commands[0], null) });
  });
  await page.reload(); await switchFor(page, false).click();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveText("Included. Sync this product to create or update its channel listing and check any remaining requirements.");
  await expect(page.getByRole("dialog").getByRole("button", { name: "Sync product" })).toBeVisible();
  expect(commands[0].excluded).toBe(false); expect(state.commands).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});


for (const lostResponse of [false, true]) {
  test(`including an unlisted product saves shared progress${lostResponse ? " despite a lost response" : ""}`, async ({ page }) => {
    const state = await setupEbayChannelPage(page);
    state.excluded = true; state.feedStatus = "excluded"; state.externalListingId = null;
    const batches = await mockSyncBatches(page, batchFixture(["queued"]));
    const commands: Command[] = [];
    await page.route("**/api/ebay/product-exclusion/1", route => {
      const command = route.request().postDataJSON() as Command;
      commands.push(command);
      state.excluded = false; state.feedStatus = "ready";
      batches.batch = { ...batches.batch, id: command.commandKey };
      batches.saved = true;
      return lostResponse ? route.abort("failed")
        : route.fulfill({ json: { ...receipt(command, null), syncBatchId: command.commandKey } });
    });
    await page.route("**/api/ebay/product-exclusion/1/commands/*", route => {
      expect(route.request().url()).toContain(commands[0].commandKey);
      return route.fulfill({ json: { ...receipt(commands[0], null), replayed: true, syncBatchId: commands[0].commandKey } });
    });
    await page.reload(); await switchFor(page, false).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("0 of 1 products processed");
    await expect(dialog).toContainText("1 queued");
    await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
    await page.reload();
    await expect(page.getByRole("region", { name: "Channel sync progress" })).toContainText("1 queued");
    expect(commands).toHaveLength(1); expect(commands[0].excluded).toBe(false);
    expect(batches.posts).toHaveLength(0); expect(state.commands).toHaveLength(0);
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}

test("retrying a failed removal uses the exclusion owner instead of sync or publish", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  state.jobs = [{ ...withdrawal, state: "needs_attention", code: "EBAY_LISTING_SYNC_FAILED", message: "The provider could not be reached." }];
  const commands: Command[] = [];
  await page.route("**/api/ebay/product-exclusion/1", route => {
    commands.push(route.request().postDataJSON()); state.jobs = [withdrawal]; return route.fulfill({ json: receipt(commands[0]) });
  });
  await page.reload();
  await page.getByRole("button", { name: "Retry this product", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText("Removing the listing from eBay");
  expect(commands).toHaveLength(1); expect(commands[0].excluded).toBe(true); expect(state.commands).toEqual([]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("accepted withdrawal waiting for verification offers a read-only status check", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  state.jobs = [{ ...withdrawal, state: "recovering", code: "EBAY_WITHDRAWAL_READBACK_PENDING", message: "eBay accepted the withdrawal. Checking that the listing ended." }];
  await page.reload();
  await page.getByRole("button", { name: "View removal status", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Checking removal from eBay");
  await expect(dialog.getByRole("button", { name: "Retry this product" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Refresh removal status" }).click();
  expect(state.commands).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("cleared quantity recovery continues the exact removal status without publishing or syncing", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  state.jobs = [{ ...withdrawal, state: "awaiting_evidence", code: "EBAY_SYNC_RESPONSE_EVIDENCE_REQUIRED", message: "A prior quantity response needs review." }];
  await page.route(`**/api/ebay/listings/sync-jobs/${withdrawal.id}/recovery`, route => route.fulfill({ json: {
    jobId: withdrawal.id, productId: 1, canRecover: true, requiredPermission: null, previewHash: "a".repeat(64), canResume: false,
    blockReason: "no_pending_attempts", attempts: [], publicationRetry: null,
  } }));
  await page.reload();
  await page.getByRole("button", { name: "Review blocked update", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Resolve listing removal" })).toBeVisible();
  await dialog.getByRole("button", { name: "Check saved removal", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Removal status" })).toBeVisible();
  expect(state.commands).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("a removal identity problem keeps the product excluded and avoids the publication mapping workflow", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  state.jobs = [{ ...withdrawal, state: "needs_attention", code: "EBAY_SYNC_IDENTITY_CHANGED", message: "Live listing 987 differs from saved listing 123." }];
  const commands: Command[] = [];
  await page.route("**/api/ebay/product-exclusion/1", route => {
    commands.push(route.request().postDataJSON()); state.jobs = [withdrawal]; return route.fulfill({ json: receipt(commands[0]) });
  });
  await page.reload();
  await expect(switchFor(page, false)).not.toBeChecked();
  await expect(page.getByText("Live listing 987 differs from saved listing 123.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Review listing mapping" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Review listings in eBay Seller Hub" })).toHaveAttribute("href", "https://www.ebay.com/sh/lst/active");
  await page.getByRole("button", { name: "Check saved removal", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Removal status" })).toBeVisible();
  await expect(dialog).toContainText("Keep the product excluded.");
  await dialog.getByRole("button", { name: "Retry removal", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Removing the listing from eBay");
  expect(commands).toHaveLength(1); expect(commands[0].excluded).toBe(true);
  expect(state.commands).toEqual([]); expect(state.unexpected).toEqual([]); expect(state.errors).toEqual([]);
});

test("an interrupted withdrawal needs explicit acknowledgement and retries the same authorization", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  state.jobs = [{ ...withdrawal, state: "awaiting_evidence", code: "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN", message: "The removal response was not recorded." }];
  const commands: Array<{ idempotencyKey: string; previewHash: string; publicationRetryHash: string }> = [];
  await page.route(`**/api/ebay/listings/sync-jobs/${withdrawal.id}/recovery`, route => {
    if (route.request().method() === "GET") return route.fulfill({ json: {
      jobId: withdrawal.id, productId: 1, canRecover: true, requiredPermission: null, previewHash: "a".repeat(64), canResume: true,
      blockReason: null, attempts: [], publicationRetry: { reviewHash: "b".repeat(64), revision: "1", message: "Check the exact offers before resuming the saved removal." },
    } });
    commands.push(route.request().postDataJSON());
    if (commands.length === 1) return route.abort("failed");
    state.jobs = [withdrawal];
    return route.fulfill({ json: { attemptIds: [], publicationRetryAuthorized: true, replayed: true, providerWriteAttempted: false, job: withdrawal } });
  });
  await page.reload(); await page.getByRole("button", { name: "Review interrupted removal", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Removal was interrupted before its result was recorded.");
  const resume = dialog.getByRole("button", { name: "Resume saved removal", exact: true });
  await expect(resume).toBeDisabled(); await expect(dialog.getByRole("button", { name: "Resume saved publication" })).toHaveCount(0);
  await dialog.getByRole("checkbox").check(); await resume.click();
  await expect(dialog.getByRole("alert")).toBeVisible(); await resume.click();
  await expect(dialog.getByRole("heading", { name: "Removal status", exact: true })).toBeVisible();
  await expect(dialog).toContainText("Removal from eBay has not yet been verified.");
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(commands[0].publicationRetryHash).toBe("b".repeat(64));
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("an older referenced recovery verifies its operation before offering withdrawal confirmation", async ({ page }) => {
  const state = await setupEbayChannelPage(page); state.excluded = true; state.feedStatus = "excluded";
  const interrupted = { ...withdrawal, state: "awaiting_evidence", code: "EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN", message: "Saved removal outcome is unknown." };
  state.jobs = [{ ...interrupted, id: "fb2bf6a0-7026-4e7c-afbe-046ff2bb034a", kind: "admission", operation: "sync",
    issue: resolveEbayListingIssue({ code: interrupted.code, jobId: withdrawal.id, productId: 1 }) }];
  let canReadOperation = false;
  await page.route(`**/api/ebay/listings/sync-jobs/${withdrawal.id}`, route => canReadOperation
    ? route.fulfill({ json: { job: interrupted } }) : route.fulfill({ status: 503, json: { error: "Status temporarily unavailable" } }));
  await page.route(`**/api/ebay/listings/sync-jobs/${withdrawal.id}/recovery`, route => route.fulfill({ json: {
    jobId: withdrawal.id, productId: 1, canRecover: true, requiredPermission: null, previewHash: "a".repeat(64), canResume: true,
    blockReason: null, attempts: [], publicationRetry: { reviewHash: "b".repeat(64), revision: "1", message: "Check the exact offers before resuming the saved removal." },
  } }));
  await page.reload(); await page.getByRole("button", { name: "Review interrupted removal", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("button", { name: "Check saved operation" })).toBeEnabled();
  await expect(dialog.getByRole("checkbox")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Resume saved publication" })).toHaveCount(0);
  canReadOperation = true; await dialog.getByRole("button", { name: "Check saved operation" }).click();
  await expect(dialog.getByRole("button", { name: "Resume saved removal" })).toBeDisabled();
  await expect(dialog.getByRole("heading", { name: "Resolve listing removal" })).toBeVisible();
  expect(state.commands).toEqual([]); expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});


for (const readOnly of [false, true]) {
  test(`automatic update history on eBay respects retry authority and saved status (${readOnly ? "viewer" : "editor"})`, async ({ page }) => {
    const state = await setupEbayChannelPage(page, { readOnly });
    const jobId = "6e4d8e03-3197-4d21-a6d7-aa1ddaecc775";
    state.jobs = [{ id: jobId, productId: 1, operation: "sync", state: "queued", code: null, message: null,
      nextAttemptAt: "2026-10-19T12:00:00.000Z", updatedAt: "2026-10-19T12:00:00.000Z" }];
    state.intentChanges.items = [
      channelIntentChange(67, {}),
      channelIntentChange(67, { id: "2", state: "blocked", can_retry: false, last_error_message: "The original account must be reviewed." }),
      channelIntentChange(67, { id: "9007199254740993", state: "blocked", can_retry: true, last_error_message: "A corrected update can be retried." }),
      channelIntentChange(67, { id: "4", state: "delivered", last_error_code: null, last_error_message: null,
        receipt: { owner: "ebay_listing_sync", operationId: jobId, commandKey: "41d4a5c3-bb5c-4ffc-8af8-df70d70ce6b8" } }),
    ];
    await page.reload();
    const panel = page.getByTestId("listing-intent-changes");
    await expect(panel.locator("summary")).toContainText("Listing updates (4)");
    await panel.locator("summary").click();
    const review = panel.locator("li").filter({ hasText: "Review the changed product category." });
    await expect(review.getByRole("button", { name: "Review listing", exact: true })).toBeVisible();
    await expect(review.getByRole("button", { name: "Retry update", exact: true })).toHaveCount(0);
    const account = panel.locator("li").filter({ hasText: "The original account must be reviewed." });
    await expect(account.getByRole("button", { name: "Retry update", exact: true })).toHaveCount(0);
    await expect(panel.getByText("Product 1 - Update requested", { exact: true })).toBeVisible();
    await expect(panel.getByText(/Provider completion has not been confirmed/)).toBeVisible();
    await expect(panel.getByText(/Later manual actions do not clear these records/)).toBeVisible();
    if (readOnly) await expect(panel.getByRole("button", { name: "Retry update", exact: true })).toHaveCount(0);
    else {
      await panel.getByRole("button", { name: "Retry update", exact: true }).click();
      await expect(panel.getByText("Product 1 - Update pending", { exact: true })).toBeVisible();
      expect(state.intentChanges.retries).toEqual(["/api/channels/67/listing-intent-changes/9007199254740993/retry"]);
    }
    await panel.getByRole("button", { name: "View update status", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Listing update status", exact: true })).toBeVisible();
    await expect(dialog).toContainText(jobId);
    await expect(dialog).toContainText("Queued for eBay");
    expect(state.commands).toEqual([]); expect(state.requests).toEqual([]);
    expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
  });
}

const archivedMember = {
  operationId:"f287ac52-dc4c-41dc-8b20-06af2d0cf057",sourceRevision:"catalog-v1",version:3,
  identity:{destinationKind:"channel_connection",connectionId:4,channelId:67,vendorId:null,provider:"ebay",
    accountId:"seller",environment:"production",market:"EBAY_US",productId:1,productVariantId:11,
    externalSku:"ARCHIVED-PACK",externalProductId:"listing-1",externalVariantId:"offer-11",externalInventoryItemId:null,identityConflict:false},
  state:"failed",code:"LISTING_MEMBER_RECOVERY_REQUIRED",message:"The exact member is still published. Review removal recovery.",
  verifiedAt:null,dispatchStatus:"unknown",dispatchKey:"f287ac52-dc4c-41dc-8b20-06af2d0cf057",verificationAttempts:1,recoveryRequired:true,
};
function memberChange() {
  return channelIntentChange(67,{state:"waiting_lifecycle",lifecycle:{
    assessedAt:"2026-10-20T20:00:00.000Z",selectionFingerprint:"a".repeat(64),
    members:[{productVariantId:11,duty:"retirement",state:"attention",code:"LISTING_MEMBER_RECOVERY_REQUIRED",
      message:"Removal needs review.",references:[archivedMember.operationId],
      nextActions:[{owner:"listing_member_retirement",operationId:archivedMember.operationId}]}],
  }});
}
for (const readOnly of [false,true]) test(`archived recovery uses the shared owner and preserves a lost-response command (read only: ${readOnly})`, async ({page}) => {
  const state=await setupEbayChannelPage(page,{readOnly}); state.excluded=true; state.feedStatus="excluded";
  state.intentChanges.items=[memberChange()];
  const commands:Array<{operationId:string;commandKey:string;reviewHash:string}>=[];
  let accepted=false;
  await page.route("**/api/channels/67/listing-lifecycle/members**",route=>{
    const path=new URL(route.request().url()).pathname;
    const record=accepted ? {...archivedMember,state:"pending",dispatchStatus:"authorized",recoveryRequired:false,version:4} : archivedMember;
    if (path.endsWith("/resume")) {
      commands.push(route.request().postDataJSON()); accepted=true;
      return commands.length===1 ? route.abort("failed") : route.fulfill({json:record});
    }
    if (path.endsWith("/recovery")) return route.fulfill({json:{record,observation:{identity:archivedMember.identity,retired:false},
      reviewHash:"d".repeat(64),canResume:!accepted,message:"The exact archived member is still published. Continuing authorizes another removal attempt."}});
    return route.fulfill({json:{items:[record]}});
  });
  await page.reload();
  const panel=page.getByTestId("listing-intent-changes"); await panel.locator("summary").first().click();
  await panel.getByRole("button",{name:"Review listing",exact:true}).click();
  await page.getByRole("button",{name:"Review removal: ARCHIVED-PACK",exact:true}).click();
  let dialog=page.getByRole("dialog");
  await expect(dialog.getByRole("heading",{name:"Archived member removal recovery",exact:true})).toBeVisible();
  if (readOnly) {
    await expect(dialog.getByRole("button",{name:"Authorize removal recovery",exact:true})).toHaveCount(0);
    expect(commands).toEqual([]); return;
  }
  await dialog.getByRole("button",{name:"Authorize removal recovery",exact:true}).click();
  await expect(dialog.getByRole("button",{name:"Retry saved recovery",exact:true})).toBeEnabled();
  await dialog.getByRole("button",{name:"Close",exact:true}).first().click();
  await page.getByRole("button",{name:"Review removal: ARCHIVED-PACK",exact:true}).click();
  dialog=page.getByRole("dialog");
  await dialog.getByRole("button",{name:"Retry saved recovery",exact:true}).click();
  await expect(dialog.getByRole("status")).toContainText("Recovery saved");
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect(commands[0]).toMatchObject({operationId:archivedMember.operationId,reviewHash:"d".repeat(64)});
  expect(state.requests.some(path=>path.includes("/listings/push"))).toBe(false);
});

test("disabled-category work still opens the saved removal operation",async({page})=>{
  const state=await setupEbayChannelPage(page);
  state.feedStatus="type_disabled"; state.jobs=[{...withdrawal,state:"needs_attention",code:"EBAY_WITHDRAWAL_RESPONSE_UNCERTAIN"}];
  state.intentChanges.items=[channelIntentChange(67,{state:"waiting_lifecycle",lifecycle:{
    assessedAt:"2026-10-20T20:00:00.000Z",selectionFingerprint:"a".repeat(64),members:[{
      productVariantId:11,duty:"stock_clear",state:"pending",code:"LISTING_LIFECYCLE_PRIOR_WORK",message:"Saved removal is unfinished.",
      references:[withdrawal.id],nextActions:[{owner:"ebay_listing_sync",operationId:withdrawal.id}],
    }],
  }})];
  await page.reload();
  const panel=page.getByTestId("listing-intent-changes");await panel.locator("summary").first().click();
  await panel.getByRole("button",{name:"Review listing",exact:true}).click();
  await expect(page.getByRole("dialog").getByRole("heading",{name:"Removal status",exact:true})).toBeVisible();
});
