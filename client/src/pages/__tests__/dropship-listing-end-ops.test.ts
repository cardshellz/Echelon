import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract of the admin section "eBay listings that couldn't be ended" (PR C, PLAN-C v4.1 §10, §13.3; TST-1,
 * DC33): no browser harness mounts the staff Dropship page, so these pins keep the section where staff look for it,
 * with Retry, the two Mark resolved choices and the required reason, and with every request and word from its own
 * client lib (client/src/lib/dropship-listing-end-ops.ts), whose answers go through readDropshipAnswer.
 */
const source = readFileSync(join(__dirname, "..", "Dropship.tsx"), "utf8");

function componentSource(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Dropship admin: eBay listings that couldn't be ended", () => {
  it("sits on the listing push tab, after the push jobs table", () => {
    const tab = componentSource("function ListingPushOpsTab", "\nfunction ");
    const table = tab.indexOf("<ListingPushJobsTable");
    const section = tab.indexOf("<ListingEndOpsSection />");
    expect(table).toBeGreaterThan(0);
    expect(section).toBeGreaterThan(table);
    expect(source.match(/<ListingEndOpsSection \/>/g)).toHaveLength(1);
  });

  it("names the section and offers Retry and Mark resolved only where the lib allows (a failed end)", () => {
    const section = componentSource("function ListingEndOpsSection", "\nfunction ");
    expect(section).toContain("{words.staffSection}");
    expect(section).toContain("const words = LISTING_END_OPS_WORDS;");
    expect(section).toContain("canActOnListingEnd(row) && (");
    expect(section).toContain("{words.staffRetry}");
    expect(section).toContain("{words.staffResolve}");
  });

  it("asks for one of the two outcomes and a required reason before Mark resolved sends anything", () => {
    const section = componentSource("function ListingEndOpsSection", "\nfunction ");
    expect(section).toContain("{words.staffResolveEnded}");
    expect(section).toContain('updateDraft({ outcome: "ended_on_ebay" })');
    expect(section).toContain("{words.staffResolveLeft}");
    expect(section).toContain('updateDraft({ outcome: "left_on_sale" })');
    expect(section).toContain("{words.staffResolveReason}");
    expect(section).toMatch(/<Textarea[\s\S]*?required[\s\S]*?maxLength=\{LISTING_END_STAFF_REASON_MAX_LENGTH\}/);
    // The lib checks the draft first; nothing is built or sent when it refuses.
    const submit = section.slice(section.indexOf("function submitResolve"), section.indexOf("function updateDraft"));
    expect(submit.indexOf("checkListingEndResolveDraft(draft)")).toBeGreaterThan(0);
    expect(submit.indexOf("if (!checked.ok)")).toBeLessThan(submit.indexOf("buildListingEndResolveRequest"));
  });

  it("sends through the lib (readDropshipAnswer) with one key per press, kept only while a failure is transient", () => {
    const section = componentSource("function ListingEndOpsSection", "\nfunction ");
    expect(section).toContain("fetchListingEnds(listingEndOpsFetch");
    expect(section).toContain("sendListingEndAction(listingEndOpsFetch, build(idempotencyKey))");
    expect(section).toContain("pressKeys[slot] ?? newListingEndStaffKey(action, row.endRequestId)");
    expect(section).toContain("isTransientListingEndOpsError(caught)");
    expect(section).toContain("setError(describeListingEndOpsError(caught))");
    expect(section).toContain("queryClient.invalidateQueries({ queryKey: LISTING_END_OPS_QUERY_KEY })");
    // The older helpers would crash on an older server's HTML 200 (TST-9).
    for (const helper of ["fetchJson", "postJson", "apiRequest", "/api/dropship/admin/listing-ends"]) {
      expect(section, helper).not.toContain(helper);
    }
  });

  it("steps back from a page an action emptied and keeps a way back past page 1 (review TST-1)", () => {
    const section = componentSource("function ListingEndOpsSection", "\nfunction ");
    // The lib's pager decides from the newest answer and whether its fetch settled (an action refetches the same page).
    expect(section).toMatch(/const pager = listingEndOpsPager\(\{\s*page,\s*limit: LISTING_END_OPS_DEFAULT_LIMIT,/);
    expect(section).toContain("settled: !listQuery.isFetching");
    expect(section).toMatch(/useEffect\(\(\) => \{\s*if \(pager\.stepBackTo !== null\) setPage\(pager\.stepBackTo\);\s*\}, \[pager\.stepBackTo\]\);/);
    // An emptied page past the last shows the skeleton while it steps back, not "No eBay listing ends in this state."
    expect(section).toContain("listQuery.isLoading || pager.stepBackTo !== null ? (");
    expect(section).toContain("{pager.show && (");
    expect(section).toContain("{pager.label}");
    expect(section).toContain("disabled={!pager.canGoBack}");
    expect(section).toContain("disabled={!pager.canGoForward}");
    // The old rule (a pager only past 50 rows, its own last page) is gone.
    expect(section).not.toContain("total > LISTING_END_OPS_DEFAULT_LIMIT");
    expect(section).not.toContain("const lastPage =");
  });
});
