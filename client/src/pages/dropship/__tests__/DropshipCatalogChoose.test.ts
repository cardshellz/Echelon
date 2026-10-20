import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooseCatalogRowSchema,
  chooseRulesView,
  EMPTY_CHOOSE_CHANGES,
  type ChooseCatalogRow,
  type ChooseChanges,
  type ChooseSelectionRule,
} from "@/lib/dropship-catalog-choose";
import { CHOOSE_WORDS } from "@/lib/dropship-catalog-choose-words";
import { ChooseChangesBar, ChooseSaveConfirmBody, ChooseTable, chooseHintId, chooseHowId, type ChooseTableProps } from "../catalog/ChooseTable";
import { CatalogActionBar } from "../catalog/CatalogActionBar";

afterEach(() => { vi.unstubAllGlobals(); });

function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(node);
}

function rule(id: number, scopeType: ChooseSelectionRule["scopeType"], action: ChooseSelectionRule["action"], target: Partial<ChooseSelectionRule>): ChooseSelectionRule {
  return { id, revisionId: 1, scopeType, action, productLineId: null, productId: null, productVariantId: null, category: null,
    autoConnectNewSkus: action === "include", autoListNewSkus: false, priority: 100, metadata: {}, isActive: true, ...target };
}

const RULES = [
  rule(1, "variant", "include", { productVariantId: 101 }),
  rule(2, "category", "include", { category: "Mailers" }),
  rule(3, "category", "exclude", { category: "Toploaders" }),
];
const VIEW = chooseRulesView(RULES);

/** A row as the server sends it (product-line facts and all), read through the step's own contract. */
function serverRow(productVariantId: number, reason: ChooseCatalogRow["selectionDecision"]["reason"], includeRuleIds: number[], excludeRuleIds: number[],
  extra: Record<string, unknown> = {}): ChooseCatalogRow {
  return chooseCatalogRowSchema.parse({
    productId: 11, productVariantId, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: `ENV-${productVariantId}`,
    variantName: "Pack of 50", category: "Mailers", productLineIds: [7], productLineNames: ["Trading Card Supplies"], unitsPerVariant: 50,
    selectionDecision: { selected: reason === "selected", reason, marketplaceQuantity: reason === "selected" ? 1_433 : 0, quantityCapApplied: false,
      autoConnectNewSkus: true, autoListNewSkus: false, includeRuleIds, excludeRuleIds },
    ...extra,
  });
}

const PICKED = serverRow(101, "selected", [1, 2], [], {
  listingTier: { tier: "case", eligible: false, reason: "balance_below_tier", policyMinimumCents: 50_000, reserveShortfallCents: 0, balanceShortfallCents: 38_000 },
});
const NOT_SELECTED = serverRow(102, "missing_vendor_include_rule", [], []);
const OLDER_EXCLUDE = serverRow(103, "excluded_by_vendor_rule", [], [3], { category: "Toploaders" });
const TURNED_OFF = serverRow(104, "disabled_by_vendor_override", [2], []);

function table(overrides: Partial<ChooseTableProps> = {}): string {
  return render(React.createElement(ChooseTable, {
    rows: [PICKED, NOT_SELECTED, OLDER_EXCLUDE, TURNED_OFF],
    changes: { marks: [{ productVariantId: 102, to: "selected", basis: { reason: "missing_vendor_include_rule", includeRuleIds: [], excludeRuleIds: [] } }] } satisfies Pick<ChooseChanges, "marks">,
    rulesById: VIEW.byId,
    locked: false,
    dimmed: false,
    onToggle: () => undefined,
    onToggleShown: () => undefined,
    ...overrides,
  }));
}

function rowOf(markup: string, productVariantId: number): string {
  const at = markup.indexOf(`data-testid="catalog-choose-row-${productVariantId}"`);
  expect(at).toBeGreaterThan(-1);
  return markup.slice(markup.lastIndexOf("<tr", at)).split("</tr>")[0];
}

describe("ChooseTable", () => {
  it("puts a checkbox first, names every box, and gives each a 44 px target on a phone", () => {
    const markup = table();
    expect(markup).toMatch(/<th[^>]*data-testid="catalog-choose-select-shown"[^>]*><label class="[^"]*min-h-11 min-w-11[^"]*"><input type="checkbox" aria-label="Select all shown"/);
    expect(markup.indexOf("Select all shown")).toBeLessThan(markup.indexOf(">Item</th>"));
    expect(markup).toContain('<caption class="sr-only">Items Card Shellz offers you. Check the ones you want to sell.</caption>');
    for (const id of [101, 102, 103, 104]) {
      // Review DUX9: a row with a hint (103, kept out by an older setting) names it after the How words.
      expect(rowOf(markup, id)).toMatch(/<td class="[^"]*\bw-12 p-0"><label class="flex min-h-11 min-w-11[^"]*"><input type="checkbox" aria-label="Select Envelope Single Pocket, Pack of 50" aria-describedby="catalog-choose-how-\d+(?: catalog-choose-hint-\d+)?"/);
    }
    // The header box: one saved row checked and one marked to add, of three changeable rows; the property, not an attribute.
    expect(markup).not.toContain("indeterminate");
  });

  it("shows a changed row in words and colour, and a saved one as checked", () => {
    const markup = table();
    const added = rowOf(markup, 102);
    expect(added).toContain('data-changed="add"');
    expect(added).toContain("bg-violet-50");
    expect(added).toContain(`<span id="${chooseHowId(102)}" class="text-sm font-medium text-violet-800">Will be added</span>`);
    expect(added).toMatch(/<input type="checkbox"[^>]* checked=""/);
    const picked = rowOf(markup, 101);
    expect(picked).not.toContain("data-changed");
    expect(picked).toMatch(/<input type="checkbox"[^>]* checked=""/);
    expect(picked).toContain(">Picked by you</span>");
    expect(picked).toContain(">1,433</td>");
  });

  it("shows — with words read out where a size isn't selected, never a 0", () => {
    const markup = table({ changes: EMPTY_CHOOSE_CHANGES });
    for (const id of [102, 103, 104]) {
      expect(rowOf(markup, id)).toContain('<span aria-hidden="true">—</span><span class="sr-only">No quantity: not selected</span>');
      expect(rowOf(markup, id)).not.toMatch(/>0</);
    }
  });

  it("turns off the boxes no pick can change, and says why in the words the box points to", () => {
    const markup = table();
    for (const [id, words] of [[103, "Kept out by an older setting"], [104, "Turned off for you"]] as const) {
      const html = rowOf(markup, id);
      // Review DUX9: and the hint, where there is one (103).
      expect(html).toMatch(new RegExp(`<input type="checkbox"[^>]*aria-describedby="${chooseHowId(id)}${id === 103 ? ` ${chooseHintId(id)}` : ""}"[^>]* disabled=""`));
      expect(html).toContain(`<span id="${chooseHowId(id)}" class="text-sm text-zinc-700">${words}</span>`);
    }
    expect(rowOf(markup, 102)).not.toMatch(/<input[^>]* disabled=""/);
    // Locked (saving, rules loading, an older filter's rows): every box and the header box are off.
    const locked = table({ locked: true, dimmed: true });
    expect(locked.match(/<input type="checkbox"[^>]* disabled=""/g)).toHaveLength(5);
    expect(locked).toContain("opacity-60");
    expect(table({ rulesById: null })).toMatch(/aria-label="Select all shown"[^>]* disabled=""/);
  });

  it("never shows a product line, and keeps the tier badge and its reason", () => {
    const markup = table();
    expect(markup).not.toContain("Trading Card Supplies");
    expect(markup).toContain('data-testid="catalog-tier-off-sale-101"');
    expect(markup).toContain('title="The Case tier is not active: your balance needs to reach $500. You need $380 more."');
    expect(markup).toContain(">Case tier not active</div>");
    expect(rowOf(markup, 102)).not.toContain("tier not active");
  });

  it("on a phone keeps the box and the item: the other columns hide, and the item says How and Available", () => {
    const markup = table();
    for (const column of ["Category", "Available", "How"]) expect(markup).toContain(`<th class="h-10 px-2 text-left align-middle font-medium text-muted-foreground [&amp;:has([role=checkbox])]:pr-0 [&amp;&gt;[role=checkbox]]:translate-y-[2px] hidden sm:table-cell">${column}</th>`);
    const cells = rowOf(markup, 101).match(/<td class="[^"]*"/g) ?? [];
    expect(cells).toHaveLength(5);
    expect(cells.slice(2).every((cell) => cell.includes("hidden sm:table-cell"))).toBe(true);
    expect(rowOf(markup, 101)).toContain('data-testid="catalog-choose-how-line-101"');
    expect(rowOf(markup, 101)).toMatch(/class="mt-1 text-xs text-zinc-600 sm:hidden"[^>]*><span class="">Picked by you<\/span><span aria-hidden="true"> · <\/span><span>Available 1,433<\/span>/);
    expect(rowOf(markup, 101)).toContain("Pack of 50 · ENV-101");
  });
});

describe("ChooseChangesBar", () => {
  const bar = (props: Partial<React.ComponentProps<typeof ChooseChangesBar>> = {}) => render(React.createElement(ChooseChangesBar, {
    add: 3, remove: 9, hasChanges: true, saving: false, saveOff: false, saveOffReason: null, outcome: null,
    onSave: () => undefined, onUndo: () => undefined, ...props,
  }));

  it("counts both ways in a status region, with Save and Undo", () => {
    const markup = bar();
    // tabindex="-1": the line takes focus after a save removes the focused button (review DUX8).
    expect(markup).toContain('<p role="status" aria-live="polite" tabindex="-1" data-testid="catalog-choose-status" class="font-medium text-zinc-900">Not saved: 3 to add · 9 to remove</p>');
    expect(markup).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*sm:min-h-9[^"]*"[^>]*>Save changes<\/button>/);
    expect(markup).toMatch(/<button[^>]*>Undo changes<\/button>/);
    expect(markup).not.toMatch(/<button[^>]* disabled=""/);
  });

  it("turns Save off with the reason beside it, and says Saving… while it saves", () => {
    const blocked = bar({ saveOff: true, saveOffReason: CHOOSE_WORDS.tooManyChoices(501, 500) });
    const reasonId = /<p id="([^"]+)" class="text-xs text-amber-900" data-testid="catalog-choose-save-off">/.exec(blocked)?.[1];
    expect(reasonId).toBeTruthy();
    expect(blocked).toMatch(new RegExp(`<button[^>]* disabled=""[^>]*aria-describedby="${reasonId}"[^>]*>Save changes</button>`));
    expect(blocked).toContain("This save would make 501, which is 1 over.");
    const saving = bar({ saving: true });
    expect(saving).toMatch(/<button[^>]* disabled=""[^>]*>Saving…<\/button>/);
    expect(saving).toMatch(/<button[^>]* disabled=""[^>]*>Undo changes<\/button>/);
  });

  it("after a save, says so in the status region; a refusal is an alert; with nothing to say it stays empty", () => {
    const saved = bar({ hasChanges: false, outcome: { kind: "saved", add: 3, remove: 9, notTaken: 0 } });
    expect(saved).toContain('data-testid="catalog-choose-status" class="font-medium text-emerald-800">Saved. 3 added, 9 removed.</p>');
    expect(saved).not.toContain("Save changes");
    for (const message of [CHOOSE_WORDS.stale, CHOOSE_WORDS.lastSaveWentThrough, CHOOSE_WORDS.notSaved, CHOOSE_WORDS.rejected,
      "A stock update is finishing. Your selection was not saved; retry it in a moment."]) {
      expect(bar({ outcome: { kind: "error", message } })).toContain(`<p role="alert" class="text-sm text-red-800" data-testid="catalog-choose-error">${message.replace(/'/g, "&#x27;")}</p>`);
    }
    const quiet = bar({ hasChanges: false });
    expect(quiet).toContain('data-testid="catalog-choose-status" class="font-medium text-emerald-800"></p>');
    expect(quiet).not.toContain("<button");
  });
});

describe("review round (step 1 stage 1)", () => {
  const RULES_WITH_KEEP_OUT = chooseRulesView([...RULES, rule(4, "variant", "exclude", { productVariantId: 105 })]);
  const REMOVED = serverRow(105, "excluded_by_vendor_rule", [2], [4]);
  const OLDER_INCLUDE = serverRow(106, "selected", [2], []);
  const hinted = () => table({ rows: [REMOVED, OLDER_INCLUDE, OLDER_EXCLUDE], changes: EMPTY_CHOOSE_CHANGES, rulesById: RULES_WITH_KEEP_OUT.byId });

  it("DUX6 DUX9 a row's hint shows on a phone and on a wide screen, and its box names it with the How words", () => {
    const markup = hinted();
    for (const [id, how, hint] of [
      [105, "Removed by you", CHOOSE_WORDS.removedHint],
      [106, "Selected by an older setting", CHOOSE_WORDS.olderIncludeHint],
      [103, "Kept out by an older setting", CHOOSE_WORDS.olderExcludeHint],
    ] as const) {
      const html = rowOf(markup, id);
      expect(html).toMatch(new RegExp(`<input type="checkbox"[^>]*aria-describedby="${chooseHowId(id)} ${chooseHintId(id)}"`));
      expect(html).toContain(`<span id="${chooseHintId(id)}" class="block text-xs text-zinc-500">${hint}</span>`);
      // The phone line (sm:hidden) says the How words and the hint too.
      const phone = html.slice(html.indexOf(`data-testid="catalog-choose-how-line-${id}"`));
      expect(phone.slice(0, phone.indexOf("</div>"))).toContain(how);
      expect(phone.slice(0, phone.indexOf("</div>"))).toContain(hint);
    }
    // A row with no hint keeps the How words alone as its description.
    expect(rowOf(table(), 102)).toMatch(new RegExp(`aria-describedby="${chooseHowId(102)}"`));
  });

  const bar = (props: Partial<React.ComponentProps<typeof ChooseChangesBar>> = {}) => render(React.createElement(ChooseChangesBar, {
    add: 3, remove: 9, hasChanges: true, saving: false, saveOff: false, saveOffReason: null, outcome: null,
    onSave: () => undefined, onUndo: () => undefined, ...props,
  }));

  it("DUX3 a stop's reason is in the status region too, so a screen reader hears why Save went off", () => {
    const reason = CHOOSE_WORDS.tooManyChoices(501, 500);
    const blocked = bar({ saveOff: true, saveOffReason: reason });
    const statusHtml = blocked.slice(blocked.indexOf('data-testid="catalog-choose-status"'), blocked.indexOf("</p>", blocked.indexOf('data-testid="catalog-choose-status"')));
    expect(statusHtml).toContain(`Not saved: 3 to add · 9 to remove<span class="sr-only">. ${reason}</span>`);
    expect(bar()).not.toContain('<span class="sr-only">');
  });

  it("MC4 CT3 DUX8 the saved line names changes that didn't take, and the status line can take focus", () => {
    const saved = bar({ hasChanges: false, outcome: { kind: "saved", add: 2, remove: 0, notTaken: 1 } });
    expect(saved).toContain(`>Saved. 2 added. ${CHOOSE_WORDS.notTakenLine(1).replace(/'/g, "&#x27;")}</p>`);
    expect(bar({ hasChanges: false, outcome: { kind: "saved", add: 2, remove: 0, notTaken: 0 } })).toContain(">Saved. 2 added.</p>");
    expect(saved).toMatch(/<p role="status" aria-live="polite" tabindex="-1" data-testid="catalog-choose-status"/);
  });

  it("MC1 an unconfirmed save and the checks behind Undo are notices in the bar", () => {
    for (const message of [CHOOSE_WORDS.unconfirmed, CHOOSE_WORDS.undoneButSaved, CHOOSE_WORDS.undoneUnknown]) {
      expect(bar({ hasChanges: false, outcome: { kind: "error", message } })).toContain(`data-testid="catalog-choose-error">${message.replace(/'/g, "&#x27;")}</p>`);
    }
  });
});

describe("verify round (step 1 stage 1)", () => {
  const bar = (props: Partial<React.ComponentProps<typeof ChooseChangesBar>> = {}) => render(React.createElement(ChooseChangesBar, {
    add: 0, remove: 0, hasChanges: false, saving: false, saveOff: false, saveOffReason: null, outcome: null,
    onSave: () => undefined, onUndo: () => undefined, ...props,
  }));

  it("V6 a turned-off size holding the vendor's own pick: its box is checked and on, and its hint says how to remove the pick", () => {
    const withPick = chooseRulesView([...RULES, rule(4, "variant", "include", { productVariantId: 107 })]);
    const offPicked = serverRow(107, "disabled_by_vendor_override", [4], []);
    const markup = table({ rows: [offPicked, TURNED_OFF], changes: EMPTY_CHOOSE_CHANGES, rulesById: withPick.byId });
    const picked = rowOf(markup, 107);
    expect(picked).toMatch(new RegExp(`<input type="checkbox"[^>]*aria-describedby="${chooseHowId(107)} ${chooseHintId(107)}"[^>]*checked=""`));
    expect(picked).not.toMatch(/<input type="checkbox"[^>]* disabled=""/);
    expect(picked).toContain(`<span id="${chooseHintId(107)}" class="block text-xs text-zinc-500">${CHOOSE_WORDS.turnedOffPickHint.replace(/'/g, "&#x27;")}</span>`);
    expect(picked).toContain("Turned off for you");
    // Turned off under an older setting only: the box stays off and unchecked, with no hint.
    const older = rowOf(markup, 104);
    expect(older).toMatch(/<input type="checkbox"[^>]* disabled=""/);
    expect(older).not.toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(older).not.toContain(CHOOSE_WORDS.turnedOffPickHint.replace(/'/g, "&#x27;"));
  });

  it("V1 nothing left to save after another tab's save: the words are in the status region, not an alert", () => {
    const info = bar({ outcome: { kind: "info", message: CHOOSE_WORDS.staleNothingLeft } });
    expect(info).toContain(`data-testid="catalog-choose-status" class="font-medium text-emerald-800">${CHOOSE_WORDS.staleNothingLeft}</p>`);
    expect(info).not.toContain('role="alert"');
    expect(info).not.toContain("<button");
  });
});

describe("CatalogActionBar children", () => {
  it("puts step 1's bar line above the summary row; without children the bar is as before", () => {
    const withChildren = render(React.createElement(CatalogActionBar, { summary: "1 selected", next: null },
      React.createElement("p", { "data-testid": "child" }, "Not saved: 1 to add · 0 to remove")));
    expect(withChildren.indexOf('data-testid="child"')).toBeGreaterThan(withChildren.indexOf('data-testid="catalog-action-bar"'));
    expect(withChildren.indexOf('data-testid="child"')).toBeLessThan(withChildren.indexOf('data-testid="catalog-action-summary"'));
    const without = render(React.createElement(CatalogActionBar, { summary: "1 selected", next: null }));
    expect(without).toBe(withChildren.replace('<p data-testid="child">Not saved: 1 to add · 0 to remove</p>', ""));
  });
});

describe("ChooseSaveConfirmBody", () => {
  const confirm = (add: number, remove: number) => render(React.createElement(ChooseSaveConfirmBody, { add, remove }));
  const html = (words: string) => words.replace(/'/g, "&#x27;");

  it("says what a save does on eBay for the changes made, and that the page can't tell which are listed", () => {
    const addOnly = confirm(2, 0);
    expect(addOnly).toContain(html(CHOOSE_WORDS.confirmAdd));
    expect(addOnly).not.toContain(html(CHOOSE_WORDS.confirmRemove));
    const removeOnly = confirm(0, 4);
    expect(removeOnly).toContain(html(CHOOSE_WORDS.confirmRemove));
    expect(removeOnly).not.toContain(html(CHOOSE_WORDS.confirmAdd));
    const both = confirm(1, 1);
    expect(both.indexOf(html(CHOOSE_WORDS.confirmRemove))).toBeLessThan(both.indexOf(html(CHOOSE_WORDS.confirmAdd)));
    for (const markup of [addOnly, removeOnly, both]) expect(markup).toContain(html(CHOOSE_WORDS.confirmUnknown));
  });
});

describe("step 1 sources", () => {
  const choose = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/ChooseStep.tsx"), "utf8");
  const chooseTable = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/ChooseTable.tsx"), "utf8");

  it("puts the filters, then the heading, then the table", () => {
    const filters = choose.indexOf("<CatalogFilterPanel");
    const heading = choose.indexOf("{CHOOSE_WORDS.heading}");
    const tablePosition = choose.indexOf("<ChooseTable");
    expect(filters).toBeGreaterThan(-1);
    expect(heading).toBeGreaterThan(filters);
    expect(tablePosition).toBeGreaterThan(heading);
    expect(CHOOSE_WORDS.heading).toBe("Available catalog");
  });

  it("has no product line, no visible-rows buttons, no Apply filters and no writer of its own", () => {
    for (const source of [choose, chooseTable]) {
      for (const gone of ["productLine", "Product line", "Select visible", "Remove visible", "Apply filters", "putJson"]) {
        expect(source).not.toContain(gone);
      }
      expect(source).not.toMatch(/(^|[^\w.])fetch\(/m);
    }
    // The one write goes through the runner.
    expect(choose).toContain("await runChooseSave(chooseSaveDeps(queryClient), {");
    expect(choose.match(/putChooseSelectionRules\(/g)).toHaveLength(1);
    expect(choose).toContain("putRules: (body) => putChooseSelectionRules(body),");
  });

  it("has one Select trigger per filter menu", () => {
    expect(choose.match(/<SelectTrigger/g)?.length ?? 0).toBe(choose.match(/function FilterSelect/g)?.length ?? 0);
    expect(choose.match(/<FilterSelect/g)).toHaveLength(2);
  });

  it("labels the tier badge by tier and never says on sale or off sale", () => {
    expect(chooseTable).toContain('{row.listingTier.tier === "case" ? "Case tier not active" : "Pack tier not active"}');
    expect(chooseTable).not.toMatch(/"(Cases off sale|Off sale|On sale)"/);
  });
});
