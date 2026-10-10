import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const panel = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPricingRulesPanel.tsx"), "utf8");

/** The apply handler's body, from its declaration to the next handler. */
function applyBody(): string {
  const start = panel.indexOf("async function apply()");
  const end = panel.indexOf("async function pageReview(", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return panel.slice(start, end);
}

describe("Older pricing panel: Apply", () => {
  it("reads the listing settings again once the apply is confirmed, not only beside the POST", () => {
    const body = applyBody();
    const before = body.indexOf("onConfigurationChange();");
    const post = body.indexOf("await postJson(`${endpoint}/apply`");
    const saved = body.indexOf("saved = true;");
    const after = body.indexOf("onConfigurationChange();", saved);
    const reload = body.indexOf("await reloadRules();", saved);
    // Before the POST: the preview is marked stale at once.
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(post);
    // After the apply is confirmed: the summary (the Price row and the drawer head) is read again,
    // before the rules reload, so a failed reload still leaves it re-read.
    expect(saved).toBeGreaterThan(post);
    expect(after).toBeGreaterThan(saved);
    expect(after).toBeLessThan(reload);
    // Only those two: a refused apply (stale review, unconfirmed outcome) changed nothing saved.
    expect(body.split("onConfigurationChange();").length - 1).toBe(2);
  });
});
