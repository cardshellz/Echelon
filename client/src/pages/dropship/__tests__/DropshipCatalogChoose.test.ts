import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DropshipCatalogCategoriesAnswer, DropshipCatalogNewItemsAnswer } from "@shared/dropship/vendor-catalog-reads";
import { emptySelectionChangeEnds, type SelectionChangePreviewAnswer } from "@shared/dropship/vendor-selection-changes";
import {
  chooseCatalogRowSchema,
  describeChooseConfirmButton,
  EMPTY_CHOOSE_CHANGES,
  type ChooseCatalogRow,
  type ChooseCategoryTick,
  type ChooseChanges,
} from "@/lib/dropship-catalog-choose";
import { CHOOSE_WORDS } from "@/lib/dropship-catalog-choose-words";
import { newItemsNoticeModel } from "@/lib/dropship-catalog-new-items";
import { NEW_ITEMS_WORDS } from "@/lib/dropship-catalog-new-items-words";
import {
  ChooseCategoryList,
  ChooseChangesBar,
  ChooseMatchLineView,
  ChooseNewItemsNotice,
  ChooseSaveConfirmBody,
  ChooseTable,
  chooseHintId,
  chooseHowId,
  type ChooseCategoryListProps,
  type ChooseNewItemsNoticeProps,
  type ChooseTableProps,
} from "../catalog/ChooseTable";
import { CatalogActionBar } from "../catalog/CatalogActionBar";

afterEach(() => { vi.unstubAllGlobals(); });

function render(node: React.ReactElement): string {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(node);
}

/** A row as the server sends it (product-line facts and old rule ids all), read through the step's own contract. */
function serverRow(productVariantId: number, reason: ChooseCatalogRow["selectionDecision"]["reason"], picked: boolean,
  extra: Record<string, unknown> = {}): ChooseCatalogRow {
  return chooseCatalogRowSchema.parse({
    productId: 11, productVariantId, productSku: "ENV-SGL", productName: "Envelope Single Pocket", variantSku: `ENV-${productVariantId}`,
    variantName: "Pack of 50", category: "Mailers", categoryId: 5, productLineIds: [7], productLineNames: ["Trading Card Supplies"], unitsPerVariant: 50,
    selectionDecision: { selected: reason === "selected", reason, picked, marketplaceQuantity: reason === "selected" ? 1_433 : 0, quantityCapApplied: false,
      autoConnectNewSkus: false, autoListNewSkus: false, includeRuleIds: [], excludeRuleIds: [] },
    ...extra,
  });
}

const PICKED = serverRow(101, "selected", true, {
  listingTier: { tier: "case", eligible: false, reason: "balance_below_tier", policyMinimumCents: 50_000, reserveShortfallCents: 0, balanceShortfallCents: 38_000 },
});
const NOT_SELECTED = serverRow(102, "missing_vendor_include_rule", false);
const NOT_OFFERED = serverRow(103, "not_exposed_by_admin", false, { category: "Toploaders" });
const TURNED_OFF = serverRow(104, "disabled_by_vendor_override", false);

function pending(add: number[], remove: number[] = []): Pick<ChooseChanges, "add" | "remove"> {
  return { add: new Set(add), remove: new Set(remove) };
}

function table(overrides: Partial<ChooseTableProps> = {}): string {
  return render(React.createElement(ChooseTable, {
    rows: [PICKED, NOT_SELECTED, NOT_OFFERED, TURNED_OFF],
    changes: pending([102]),
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
      // Review DUX9: a row with a hint names it after the How words.
      expect(rowOf(markup, id)).toMatch(/<td class="[^"]*\bw-12 p-0"><label class="flex min-h-11 min-w-11[^"]*"><input type="checkbox" aria-label="Select Envelope Single Pocket, Pack of 50" aria-describedby="catalog-choose-how-\d+(?: catalog-choose-hint-\d+)?"/);
    }
    // The header box: one saved row checked and one marked to add, of two changeable rows; the property, not an attribute.
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
    for (const [id, words] of [[103, "Not offered by Card Shellz"], [104, "Turned off for you"]] as const) {
      const html = rowOf(markup, id);
      expect(html).toMatch(new RegExp(`<input type="checkbox"[^>]*aria-describedby="${chooseHowId(id)}"[^>]* disabled=""`));
      expect(html).toContain(`<span id="${chooseHowId(id)}" class="text-sm text-zinc-700">${words}</span>`);
    }
    expect(rowOf(markup, 102)).not.toMatch(/<input[^>]* disabled=""/);
    // Locked (saving, an older filter's rows): every box and the header box are off.
    const locked = table({ locked: true, dimmed: true });
    expect(locked.match(/<input type="checkbox"[^>]* disabled=""/g)).toHaveLength(5);
    expect(locked).toContain("opacity-60");
    expect(table({ rows: [NOT_OFFERED, TURNED_OFF] })).toMatch(/aria-label="Select all shown"[^>]* disabled=""/);
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
    const blocked = bar({ saveOff: true, saveOffReason: CHOOSE_WORDS.overCapAdd(10_001) });
    const reasonId = /<p id="([^"]+)" class="text-xs text-amber-900" data-testid="catalog-choose-save-off">/.exec(blocked)?.[1];
    expect(reasonId).toBeTruthy();
    expect(blocked).toMatch(new RegExp(`<button[^>]* disabled=""[^>]*aria-describedby="${reasonId}"[^>]*>Save changes</button>`));
    expect(blocked).toContain("This would make 10,001 selected, over the 10,000 limit.");
    const saving = bar({ saving: true });
    expect(saving).toMatch(/<button[^>]* disabled=""[^>]*>Saving…<\/button>/);
    expect(saving).toMatch(/<button[^>]* disabled=""[^>]*>Undo changes<\/button>/);
  });

  it("(step 1 plan S2-5 §4.9 item 2) offers Reload beside the retired refusal, and only there", () => {
    const retired = bar({ outcome: { kind: "error", message: CHOOSE_WORDS.retired, reload: true } });
    expect(retired).toContain('data-testid="catalog-choose-reload"');
    expect(retired).toMatch(/<button[^>]*data-testid="catalog-choose-reload"[^>]*>Reload<\/button>/);
    expect(bar({ outcome: { kind: "error", message: CHOOSE_WORDS.rejected } })).not.toContain("catalog-choose-reload");
  });

  it("after a save, says so in the status region; a refusal is an alert; with nothing to say it stays empty", () => {
    const saved = bar({ hasChanges: false, outcome: { kind: "saved", message: CHOOSE_WORDS.saved(3, 9) } });
    expect(saved).toContain('data-testid="catalog-choose-status" class="font-medium text-emerald-800">Saved. 3 added, 9 removed.</p>');
    expect(saved).not.toContain("Save changes");
    for (const message of [CHOOSE_WORDS.stale, CHOOSE_WORDS.pausedStill, CHOOSE_WORDS.notSaved, CHOOSE_WORDS.rejected, CHOOSE_WORDS.busy]) {
      expect(bar({ outcome: { kind: "error", message } })).toContain(`<p role="alert" class="text-sm text-red-800" data-testid="catalog-choose-error">${message.replace(/'/g, "&#x27;")}</p>`);
    }
    const quiet = bar({ hasChanges: false });
    expect(quiet).toContain('data-testid="catalog-choose-status" class="font-medium text-emerald-800"></p>');
    expect(quiet).not.toContain("<button");
  });
});

describe("review round (step 1 stage 1), on one-time picks", () => {
  const bar = (props: Partial<React.ComponentProps<typeof ChooseChangesBar>> = {}) => render(React.createElement(ChooseChangesBar, {
    add: 3, remove: 9, hasChanges: true, saving: false, saveOff: false, saveOffReason: null, outcome: null,
    onSave: () => undefined, onUndo: () => undefined, ...props,
  }));

  it("DUX3 a stop's reason is in the status region too, so a screen reader hears why Save went off", () => {
    const reason = CHOOSE_WORDS.overCapAdd(10_001);
    const blocked = bar({ saveOff: true, saveOffReason: reason });
    const statusHtml = blocked.slice(blocked.indexOf('data-testid="catalog-choose-status"'), blocked.indexOf("</p>", blocked.indexOf('data-testid="catalog-choose-status"')));
    expect(statusHtml).toContain(`Not saved: 3 to add · 9 to remove<span class="sr-only">. ${reason}</span>`);
    expect(bar()).not.toContain('<span class="sr-only">');
  });

  it("DUX8 the saved line can take focus; an unconfirmed save is a notice in the bar", () => {
    const saved = bar({ hasChanges: false, outcome: { kind: "saved", message: CHOOSE_WORDS.saved(2, 0) } });
    expect(saved).toMatch(/<p role="status" aria-live="polite" tabindex="-1" data-testid="catalog-choose-status"/);
    expect(bar({ hasChanges: false, outcome: { kind: "error", message: CHOOSE_WORDS.unconfirmed } }))
      .toContain(`data-testid="catalog-choose-error">${CHOOSE_WORDS.unconfirmed.replace(/'/g, "&#x27;")}</p>`);
  });

  it("(PLAN-B v4.1 §12.4) while the same save is sent again, the bar says paused or still saving", () => {
    expect(bar({ saving: true, progress: CHOOSE_WORDS.paused })).toContain(`<p role="status" class="text-sm text-sky-900" data-testid="catalog-choose-progress">${CHOOSE_WORDS.paused}</p>`);
    expect(bar({ saving: false, progress: CHOOSE_WORDS.paused })).not.toContain("catalog-choose-progress");
  });
});

describe("verify round (step 1 stage 1), on one-time picks", () => {
  const bar = (props: Partial<React.ComponentProps<typeof ChooseChangesBar>> = {}) => render(React.createElement(ChooseChangesBar, {
    add: 0, remove: 0, hasChanges: false, saving: false, saveOff: false, saveOffReason: null, outcome: null,
    onSave: () => undefined, onUndo: () => undefined, ...props,
  }));

  it("V6 a turned-off size holding the vendor's pick: its box is checked and on, and its hint says how to remove the pick", () => {
    const offPicked = serverRow(107, "disabled_by_vendor_override", true);
    const markup = table({ rows: [offPicked, TURNED_OFF], changes: EMPTY_CHOOSE_CHANGES });
    const picked = rowOf(markup, 107);
    expect(picked).toMatch(new RegExp(`<input type="checkbox"[^>]*aria-describedby="${chooseHowId(107)} ${chooseHintId(107)}"[^>]*checked=""`));
    expect(picked).not.toMatch(/<input type="checkbox"[^>]* disabled=""/);
    expect(picked).toContain(`<span id="${chooseHintId(107)}" class="block text-xs text-zinc-500">${CHOOSE_WORDS.turnedOffPickHint.replace(/'/g, "&#x27;")}</span>`);
    expect(picked).toContain("Turned off for you");
    // Turned off with no pick: the box stays off and unchecked, with no hint.
    const older = rowOf(markup, 104);
    expect(older).toMatch(/<input type="checkbox"[^>]* disabled=""/);
    expect(older).not.toMatch(/<input type="checkbox"[^>]*checked=""/);
    expect(older).not.toContain(CHOOSE_WORDS.turnedOffPickHint.replace(/'/g, "&#x27;"));
  });

  it("V1 good news with nothing left to do is in the status region, not an alert", () => {
    const info = bar({ outcome: { kind: "info", message: "Nothing to save." } });
    expect(info).toContain('data-testid="catalog-choose-status" class="font-medium text-emerald-800">Nothing to save.</p>');
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
  const html = (words: string) => words.replace(/'/g, "&#x27;");
  type StoreEffects = SelectionChangePreviewAnswer["effects"][number];
  const store = (storeConnectionId: number, storeName: string, counts: Partial<StoreEffects> = {}): StoreEffects =>
    ({ storeConnectionId, storeName, platform: "ebay", goesToZero: 0, startsSelling: 0, ends: 0, storeConnected: true, ...counts });
  const preview = (overrides: Partial<SelectionChangePreviewAnswer> = {}): SelectionChangePreviewAnswer => ({
    headRevisionId: 7, toAdd: 12, toRemove: 8, alreadySelected: 0, alreadyNotSelected: 0, skipped: { count: 0, first: [] },
    selectedBefore: 100, selectedAfter: 104, cap: 10_000, overCapAfter: false, refused: null,
    effects: [store(1, "Card Corner", { goesToZero: 8, startsSelling: 3 })], effectsHash: "a".repeat(64),
    otherEntriesHash: "c".repeat(64), ends: emptySelectionChangeEnds(),
    ...overrides,
  });

  it("(PLAN-B v4.1 §13) counts the server's numbers per store and never names an ended listing", () => {
    const markup = render(React.createElement(ChooseSaveConfirmBody, { preview: preview() }));
    // Exactly these lines, in this order: no line for listings that ended on eBay (V20, FIDELITY-9), and no
    // "aren't ended" line since PR C (PLAN-C v4.1 §11).
    const lines = ["12 added · 8 removed", CHOOSE_WORDS.confirmZero("Card Corner", 8), CHOOSE_WORDS.confirmResume("Card Corner", 3),
      CHOOSE_WORDS.confirmScope];
    expect(markup).toBe(`<div class="space-y-2 text-sm text-zinc-600" data-testid="catalog-choose-confirm">${lines.map((line) => `<p>${html(line)}</p>`).join("")}</div>`);
    expect(CHOOSE_WORDS.confirmZero("Card Corner", 8)).toBe("On Card Corner: 8 listings are set to quantity 0, so buyers can't buy them.");
    expect(CHOOSE_WORDS.confirmResume("Card Corner", 3)).toBe("On Card Corner: 3 listings get their quantity back shortly after you save, at the price they have on eBay now. To send today's prices, publish them in step 3.");
    expect(markup.toLowerCase()).not.toContain("ended on ebay");
    expect(markup).not.toContain("aren&#x27;t ended");
    expect(markup).not.toContain("catalog-choose-confirm-changed");
    const quiet = render(React.createElement(ChooseSaveConfirmBody, { preview: preview({ toRemove: 0, effects: [] }) }));
    expect(quiet).toContain(`<p>${CHOOSE_WORDS.confirmNone}</p>`);
    const again = render(React.createElement(ChooseSaveConfirmBody, { preview: preview(), effectsChanged: true }));
    expect(again).toContain(`data-testid="catalog-choose-confirm-changed">${CHOOSE_WORDS.effectsChanged}</p>`);
  });

  it("(PLAN-C v4.1 §11) a removal that ends eBay listings says so per store and for the products removed completely", () => {
    const ending = preview({ toAdd: 0, toRemove: 1, effects: [store(3, "Test Shop", { platform: "shopify", goesToZero: 1 }), store(5, "Marz Cards", { ends: 3 })],
      ends: { ...emptySelectionChangeEnds(), listingIds: [5_000_101, 5_000_102, 5_000_105], hiddenRemovedIds: [105], otherSizes: 2 } });
    const markup = render(React.createElement(ChooseSaveConfirmBody, { preview: ending }));
    const lines = ["0 added · 1 removed", CHOOSE_WORDS.confirmZero("Test Shop", 1), CHOOSE_WORDS.confirmEnd("Marz Cards", 3),
      CHOOSE_WORDS.confirmEndOtherSizes(2), CHOOSE_WORDS.confirmEndHidden(1), CHOOSE_WORDS.confirmScope];
    expect(markup).toBe(`<div class="space-y-2 text-sm text-zinc-600" data-testid="catalog-choose-confirm">${lines.map((line) => `<p>${html(line)}</p>`).join("")}</div>`);
    expect(markup).not.toContain(html(CHOOSE_WORDS.confirmNone));
  });

  it("(PLAN-C v4.1 §11) the question's button: End {l} listing(s) and save when it ends any, singular and plural; else Save changes", () => {
    const ends = (listingIds: number[]) => ({ ...emptySelectionChangeEnds(), listingIds });
    expect(describeChooseConfirmButton(preview())).toBe("Save changes");
    expect(describeChooseConfirmButton(preview({ ends: ends([5_000_102]) }))).toBe("End 1 listing and save");
    expect(describeChooseConfirmButton(preview({ ends: ends([5_000_101, 5_000_102]) }))).toBe("End 2 listings and save");
    // The dialog's action button reads it from the question's own preview (ChooseStep.tsx), never the bar's Save.
    const choose = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/ChooseStep.tsx"), "utf8");
    const action = choose.slice(choose.indexOf("<AlertDialogAction"), choose.indexOf("</AlertDialogAction>"));
    expect(action).toContain("{question ? describeChooseConfirmButton(question.preview) : CHOOSE_WORDS.confirmSave}");
    expect(choose.match(/describeChooseConfirmButton\(/g)).toHaveLength(1);
  });
});

describe("ChooseCategoryList (PLAN-B v4.1 §12.3)", () => {
  const html = (words: string) => words.replace(/'/g, "&#x27;");
  const CATEGORIES: DropshipCatalogCategoriesAnswer = {
    categories: [
      { categoryId: 5, name: "envelopes", rowCount: 311, selectedCount: 142 },
      { categoryId: 6, name: "Toploaders", rowCount: 40, selectedCount: 40 },
      { categoryId: 7, name: "Sleeves", rowCount: 12, selectedCount: 0 },
      { categoryId: 8, name: "Empty shelf", rowCount: 0, selectedCount: 0 },
    ],
    uncategorizedCount: 9,
  };
  const TICKS = new Map<number, ChooseCategoryTick>([
    [5, { tick: "some", empty: false }], [6, { tick: "all", empty: false }], [7, { tick: "none", empty: false }], [8, { tick: "none", empty: false }],
  ]);
  const card = (overrides: Partial<ChooseCategoryListProps> = {}) => render(React.createElement(ChooseCategoryList, {
    categories: CATEGORIES, failed: false, ticks: TICKS, activeCategoryId: null, locked: false,
    everything: { offered: 4_300, disabled: false, overRoom: false }, roomLine: CHOOSE_WORDS.room(363, 9_637), note: null,
    onTick: () => undefined, onShowOnly: () => undefined, onSelectEverything: () => undefined, onRetry: () => undefined, ...overrides,
  }));
  function lineOf(markup: string, categoryId: number): string {
    const at = markup.indexOf(`data-testid="catalog-choose-category-${categoryId}"`);
    expect(at).toBeGreaterThan(-1);
    return markup.slice(markup.lastIndexOf("<li", at)).split("</li>")[0];
  }
  const text = (markup: string) => markup.replace(/<[^>]+>/g, "");

  it("one line per category: a box named for it, its name as a Show only button, and its saved counts, with 44 px targets on a phone", () => {
    const markup = card();
    expect(markup).toMatch(/<section aria-labelledby="([^"]+)" data-testid="catalog-choose-categories"[^>]*><h2 id="\1"[^>]*>Categories<\/h2>/);
    const envelopes = lineOf(markup, 5);
    expect(envelopes).toMatch(/<label class="flex min-h-11 min-w-11[^"]*sm:min-h-9 sm:min-w-9"><input type="checkbox" aria-label="Select all in Envelopes"/);
    expect(envelopes).toMatch(/<button type="button" aria-label="Show only Envelopes" class="inline-flex min-h-11 [^"]*sm:min-h-9[^"]*">Envelopes<\/button>/);
    // The line reads exactly the words: "{name} · {selected} of {total} selected".
    expect(text(envelopes)).toBe(CHOOSE_WORDS.categoryLine("Envelopes", 142, 311));
    expect(text(envelopes)).toBe("Envelopes · 142 of 311 selected");
    expect(text(lineOf(markup, 6))).toBe("Toploaders · 40 of 40 selected");
    expect(CHOOSE_WORDS.categoryBox("Envelopes")).toBe("Select all in Envelopes");
    expect(CHOOSE_WORDS.categoryShowOnly("Envelopes")).toBe("Show only Envelopes");
  });

  it("the box is tri-state: ticked, some (the indeterminate property, shown as data-tick), or none; off while locked or with nothing to change", () => {
    const markup = card();
    expect(lineOf(markup, 6)).toContain('data-tick="all"');
    expect(lineOf(markup, 6)).toMatch(/<input type="checkbox" aria-label="Select all in Toploaders"[^>]* checked=""/);
    for (const [id, tick] of [[5, "some"], [7, "none"]] as const) {
      expect(lineOf(markup, id)).toContain(`data-tick="${tick}"`);
      expect(lineOf(markup, id)).not.toMatch(/<input[^>]*checked=""/);
      expect(lineOf(markup, id)).not.toMatch(/<input[^>]*disabled=""/);
    }
    // No size in it, or none a box can change (known from its id read): off.
    expect(lineOf(markup, 8)).toMatch(/<input[^>]*disabled=""/);
    const emptyTick = card({ ticks: new Map([...TICKS, [7, { tick: "none", empty: true }]]) });
    expect(lineOf(emptyTick, 7)).toMatch(/<input[^>]*disabled=""/);
    // A save or an id read running: every box and Select everything are off (the name buttons still filter).
    const locked = card({ locked: true });
    expect(locked.match(/<input type="checkbox"[^>]* disabled=""/g)).toHaveLength(4);
    expect(locked).toMatch(/<button[^>]*data-testid="catalog-choose-everything" disabled=""/);
    expect(locked).not.toMatch(/aria-label="Show only Envelopes"[^>]* disabled=""/);
  });

  it("the name of the category the table shows is marked current; the items with no category get a line under the list", () => {
    const markup = card({ activeCategoryId: 5 });
    expect(lineOf(markup, 5)).toMatch(/aria-label="Show only Envelopes" aria-current="true" class="[^"]* underline"/);
    expect(lineOf(markup, 6)).not.toContain("aria-current");
    expect(markup).toContain(`<p class="mt-3 text-xs text-zinc-500" data-testid="catalog-choose-no-category">${html(CHOOSE_WORDS.noCategory)}</p>`);
    expect(CHOOSE_WORDS.noCategory).toBe("Items with no category aren't listed here. Choose them in the table.");
    expect(card({ categories: { ...CATEGORIES, uncategorizedCount: 0 } })).not.toContain("catalog-choose-no-category");
  });

  it("Select everything (4,300) with the room line; off with the room as its reason when the room left is smaller than what isn't selected (D27)", () => {
    const open = card();
    expect(open).toMatch(/<button[^>]*data-testid="catalog-choose-everything"[^>]*>Select everything \(4,300\)<\/button>/);
    expect(open).not.toMatch(/data-testid="catalog-choose-everything" disabled=""/);
    const roomWords = CHOOSE_WORDS.room(9_000, 1_000);
    expect(roomWords).toBe("You can have up to 10,000 selected. 9,000 are selected, so 1,000 more can be added.");
    const off = card({ everything: { offered: 12_000, disabled: true, overRoom: true }, roomLine: roomWords });
    const roomId = /<p id="([^"]+)" class="mt-2 text-xs text-zinc-600" data-testid="catalog-choose-room">/.exec(off)?.[1];
    expect(roomId).toBeTruthy();
    expect(off).toMatch(new RegExp(`<button[^>]*data-testid="catalog-choose-everything" disabled=""[^>]*aria-describedby="${roomId}"[^>]*>Select everything \\(12,000\\)</button>`));
    expect(off).toContain(`data-testid="catalog-choose-room">${roomWords}</p>`);
    // Not read yet (the count or the categories): no button.
    expect(card({ everything: null, roomLine: null })).not.toContain("catalog-choose-everything");
  });

  it("what a press did is a polite status (always in the page); why it did nothing is an alert", () => {
    const quiet = card();
    expect(quiet).toContain('<p role="status" aria-live="polite" class="text-sm text-zinc-700" data-testid="catalog-choose-categories-status"></p>');
    const adds = CHOOSE_WORDS.tickAdds(169, "Envelopes");
    expect(adds).toBe("Adds the 169 items in Envelopes that aren't selected yet. Items Card Shellz adds to Envelopes later aren't added; you'll see them in a notice here instead.");
    expect(card({ note: { kind: "info", message: adds } })).toContain(`data-testid="catalog-choose-categories-status">${html(adds)}</p>`);
    expect(CHOOSE_WORDS.tickRemoves(40, "Toploaders")).toBe("Removes all 40 selected items in Toploaders.");
    expect(CHOOSE_WORDS.everythingAdds(4_158)).toBe("Adds every item Card Shellz offers that isn't selected yet (4,158). Items Card Shellz adds later aren't added. You'll see a notice for new items in categories you sell from.");
    const refused = card({ note: { kind: "error", message: CHOOSE_WORDS.tooManyMatch(10_050) } });
    expect(refused).toContain(`<p role="alert" class="mt-2 text-sm text-red-800" data-testid="catalog-choose-categories-error">${CHOOSE_WORDS.tooManyMatch(10_050)}</p>`);
    expect(refused).toContain('data-testid="catalog-choose-categories-status"></p>');
  });

  it("while the read loads it shows placeholders; when it gave up, says so with Try again; never a product line", () => {
    expect(card({ categories: undefined })).toContain('data-testid="catalog-choose-categories-loading"');
    const failed = card({ categories: undefined, failed: true });
    expect(failed).toMatch(/<div role="alert"[^>]*data-testid="catalog-choose-categories-failed"><span>The catalog couldn&#x27;t be loaded.<\/span><button[^>]*>Try again<\/button>/);
    expect(failed).not.toContain("catalog-choose-category-list");
    for (const markup of [card(), failed]) {
      expect(markup).not.toMatch(/product line/i);
      expect(markup).not.toContain("Trading Card Supplies");
    }
  });
});

describe("ChooseMatchLineView (PLAN-B v4.1 §12.3)", () => {
  const line = (props: Partial<React.ComponentProps<typeof ChooseMatchLineView>> = {}) => render(React.createElement(ChooseMatchLineView, {
    line: { purpose: "add", total: 1_433, shownChecked: 200, changed: null }, locked: false, error: null, onPress: () => undefined, ...props,
  }));

  it("after the header box checked every row shown: \"All 200 shown are checked.\" and Check all 1,433 that match, a 44 px target", () => {
    const markup = line();
    expect(markup).toContain("<span>All 200 shown are checked.</span>");
    expect(markup).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*sm:min-h-9[^"]*"[^>]*data-testid="catalog-choose-match-button">Check all 1,433 that match<\/button>/);
    expect(markup).not.toContain('role="alert"');
  });

  it("after unchecking them: Uncheck all 1,433 that match, without the checked words", () => {
    const markup = line({ line: { purpose: "remove", total: 1_433, shownChecked: null, changed: null } });
    expect(markup).toContain(">Uncheck all 1,433 that match</button>");
    expect(markup).not.toContain("shown are checked");
  });

  it("more matched at the press than it said: it says so and asks again with the new number; a refusal is an alert; off while locked", () => {
    const changed = line({ line: { purpose: "add", total: 1_500, shownChecked: 200, changed: { now: 1_500, was: 1_433 } } });
    expect(changed).toContain('<span role="status" data-testid="catalog-choose-match-changed">1,500 now match (was 1,433).</span>');
    expect(changed).toContain(">Check all 1,500 that match</button>");
    expect(changed).not.toContain("shown are checked");
    const refused = line({ error: CHOOSE_WORDS.tooManyMatch(10_050) });
    expect(refused).toContain(`<span role="alert" class="text-red-800" data-testid="catalog-choose-match-error">${CHOOSE_WORDS.tooManyMatch(10_050)}</span>`);
    expect(line({ locked: true })).toMatch(/<button[^>]*data-testid="catalog-choose-match-button" disabled=""/);
  });
});

describe("ChooseNewItemsNotice (PLAN-B v4.1 §11.4, §12.3, §13; TESTS-8)", () => {
  const html = (words: string) => words.replace(/'/g, "&#x27;");
  const text = (markup: string) => markup.replace(/<[^>]+>/g, "");
  const ANSWER: DropshipCatalogNewItemsAnswer = {
    categories: [
      { categoryId: 61, categoryName: "Armalope", productCount: 1, sizeCount: 3, throughArrivalId: 104 },
      { categoryId: 40, categoryName: "trading_card_sleeves", productCount: 1, sizeCount: 1, throughArrivalId: 99 },
      { categoryId: 42, categoryName: "Toploaders", productCount: 3, sizeCount: 12, throughArrivalId: 101 },
      { categoryId: 43, categoryName: "Binders", productCount: 1, sizeCount: 2, throughArrivalId: 102 },
      { categoryId: 44, categoryName: "Mailers", productCount: 1, sizeCount: 1, throughArrivalId: 103 },
    ],
  };
  const TWO: DropshipCatalogNewItemsAnswer = { categories: ANSWER.categories.slice(0, 2) };
  const notice = (overrides: Partial<ChooseNewItemsNoticeProps> = {}) => render(React.createElement(ChooseNewItemsNotice, {
    model: newItemsNoticeModel(TWO, false)!, acknowledging: false, failure: null, reviewingCategoryId: null,
    onReview: () => undefined, onGotIt: () => undefined, onShowAll: () => undefined, ...overrides,
  }));
  function lineOf(markup: string, categoryId: number): string {
    const at = markup.indexOf(`data-testid="catalog-new-items-${categoryId}"`);
    expect(at).toBeGreaterThan(-1);
    return markup.slice(markup.lastIndexOf("<li", at)).split("</li>")[0];
  }

  it("one line per category in the server's order: its words, then Review and Got it, each named for its line, with 44 px targets on a phone", () => {
    const markup = notice();
    expect(markup).toMatch(/^<div tabindex="-1" data-testid="catalog-new-items" class="[^"]*">/);
    const armalope = lineOf(markup, 61);
    expect(armalope).toContain("<span class=\"min-w-0 break-words font-medium\">3 new items from Card Shellz in Armalope</span>");
    expect(armalope).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*sm:min-h-9[^"]*"[^>]*aria-label="Review: 3 new items from Card Shellz in Armalope"[^>]*>Review<\/button>/);
    expect(armalope).toMatch(/<button[^>]*class="[^"]*min-h-11[^"]*sm:min-h-9[^"]*"[^>]*aria-label="Got it: 3 new items from Card Shellz in Armalope"[^>]*>Got it<\/button>/);
    expect(text(armalope)).toBe("3 new items from Card Shellz in ArmalopeReviewGot it");
    // One item: singular; the name as step 1 shows names (formatStatus).
    expect(text(lineOf(markup, 40))).toBe("1 new item from Card Shellz in Trading Card SleevesReviewGot it");
    expect(markup.indexOf("catalog-new-items-61")).toBeLessThan(markup.indexOf("catalog-new-items-40"));
    expect(markup).not.toContain("catalog-new-items-more");
    expect(NEW_ITEMS_WORDS.noticeLine(3, "Armalope")).toBe("3 new items from Card Shellz in Armalope");
  });

  it("more than three categories: the first three lines, then \"and 2 more categories\" with Show all; Show all draws all five", () => {
    const folded = notice({ model: newItemsNoticeModel(ANSWER, false)! });
    expect(folded.match(/data-testid="catalog-new-items-\d+"/g)).toHaveLength(3);
    expect(folded).toMatch(/<p class="[^"]*" data-testid="catalog-new-items-more"><span>and 2 more categories<\/span><button[^>]*class="[^"]*min-h-11[^"]*sm:min-h-9[^"]*"[^>]*>Show all<\/button><\/p>/);
    const all = notice({ model: newItemsNoticeModel(ANSWER, true)! });
    expect(all.match(/data-testid="catalog-new-items-\d+"/g)).toHaveLength(5);
    expect(all).not.toContain("catalog-new-items-more");
  });

  it("while a Got it is sent every Got it is off and Review still works; the reviewed line's Review is marked current", () => {
    const sending = notice({ acknowledging: true, reviewingCategoryId: 40 });
    expect(sending.match(/<button[^>]*disabled=""[^>]*>Got it<\/button>/g)).toHaveLength(2);
    expect(sending).not.toMatch(/<button[^>]*disabled=""[^>]*>Review<\/button>/);
    expect(lineOf(sending, 40)).toMatch(/aria-label="Review: 1 new item from Card Shellz in Trading Card Sleeves" aria-current="true"/);
    expect(lineOf(sending, 61)).not.toContain("aria-current");
  });

  it("a Got it that failed says so under its line only, as an alert, in the kept words", () => {
    const failed = notice({ failure: { categoryId: 61, message: NEW_ITEMS_WORDS.gotItFailed } });
    expect(lineOf(failed, 61)).toContain(`<p role="alert" class="w-full text-red-800" data-testid="catalog-new-items-failed-61">${html(NEW_ITEMS_WORDS.gotItFailed)}</p>`);
    expect(lineOf(failed, 40)).not.toContain('role="alert"');
    expect(notice()).not.toContain('role="alert"');
  });

  it("names no product line, no code and no id", () => {
    for (const markup of [notice(), notice({ model: newItemsNoticeModel(ANSWER, true)! })]) {
      expect(text(markup)).not.toMatch(/product line|DROPSHIP_|throughArrival|\b104\b/i);
    }
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
    // The one write goes through the runner: the preview, the question, then the save (PLAN-B v4.1 §12.4).
    expect(choose).toContain("await runChooseSave(chooseSaveDeps(ask, setProgress), {");
    expect(choose).toContain("preview: (body) => postChoosePreview(body),");
    expect(choose).toContain("post: (body) => postChooseChange(body),");
    expect(choose).not.toMatch(/selection-rules|putChooseSelectionRules|selectionRulesQueryOptions/);
  });

  it("(PLAN-B v4.1 §11.4, §12.3, B3) the new-items notice sits between the step intro and the filters, read in step 1 only", () => {
    const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    expect(choose.indexOf("<ChooseNewItemsNotice")).toBeGreaterThan(-1);
    expect(choose.indexOf("<ChooseNewItemsNotice")).toBeLessThan(choose.indexOf("<CatalogFilterPanel"));
    expect(page.indexOf("<CatalogStepIntro step=\"choose\"")).toBeLessThan(page.indexOf("<ChooseStep"));
    expect(choose).toContain("const newItems = useQuery(catalogNewItemsQueryOptions());");
    expect(page).not.toContain("catalogNewItemsQueryOptions");
    // Review filters the table (no save, no write); Show offers "New from Card Shellz" only while reviewing.
    expect(choose).toContain("const review = newItemsReviewFilters(line.categoryId);");
    expect(choose).toContain('...(showsNewItemsOption(show) ? [{ value: "new", label: NEW_ITEMS_WORDS.showNew }] : []),');
    expect(choose).toContain('onValueChange={(value) => onShowChange(value === "selected" || value === "not_selected" || value === "new" ? value : "all")}');
    // Got it through the runner; the line goes once the server took it; a save reads the notice again (a picked item isn't new).
    expect(choose).toContain("const outcome = await runNewItemsAcknowledge({ send: (body) => postCatalogNewItemsAcknowledge(body), sleep: pause }, line);");
    expect(choose).toContain("await hideAcknowledgedNewItems(queryClient, outcome.answer);");
    // Every cached "new" list is stale after a taken Got it; the shown one is read again unless the review ends (UIT-1).
    expect(choose).toContain("void markNewItemsListsStale(queryClient, { reviewEnds });");
    expect(choose.indexOf("void markNewItemsListsStale(queryClient, { reviewEnds });"))
      .toBeLessThan(choose.indexOf("if (reviewEnds) setShow(\"all\");"));
    expect(choose).toContain("await Promise.allSettled([readRowsAfterMove(), onSaved(), categories.refetch(), newItems.refetch()]);");
  });

  it("has one Select trigger per filter menu", () => {
    expect(choose.match(/<SelectTrigger/g)?.length ?? 0).toBe(choose.match(/function FilterSelect/g)?.length ?? 0);
    expect(choose.match(/<FilterSelect/g)).toHaveLength(2);
  });

  it("(PLAN-B v4.1 §12.3) puts the categories card first in one grid with the table: left from lg, above it on a phone", () => {
    const grid = choose.indexOf('<div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] lg:items-start">');
    const cardPosition = choose.indexOf("<ChooseCategoryList");
    expect(grid).toBeGreaterThan(choose.indexOf("<CatalogFilterPanel"));
    expect(cardPosition).toBeGreaterThan(grid);
    expect(cardPosition).toBeLessThan(choose.indexOf("{CHOOSE_WORDS.heading}"));
    expect(choose).toContain('<section className="min-w-0 overflow-hidden rounded-md border border-zinc-200 bg-white" data-testid="catalog-choose-card">');
    // The match line sits under the shown line, above the table.
    expect(choose.indexOf("<ChooseMatchLineView")).toBeGreaterThan(choose.indexOf('data-testid="catalog-choose-shown"'));
    expect(choose.indexOf("<ChooseMatchLineView")).toBeLessThan(choose.indexOf("<ChooseTable"));
  });

  it("(PLAN-B v4.1 §12.2, D26, D27) reads ids through the id query on a press: a category with only its id, everything with no filter", () => {
    expect(choose).toContain("const options = chooseIdsQueryOptions(filters, purpose);");
    expect(choose).toContain("const answer = await queryClient.fetchQuery({\n        ...options,");
    expect(choose).toContain("const read = await readIds(chooseCategoryFilters(category.categoryId), purpose);");
    expect(choose).toContain('const read = await readIds(CHOOSE_EVERYTHING_FILTERS, "add");');
    expect(choose).toContain("const read = await readIds(shownFilters, line.purpose);");
    // More matching than the button said is never applied (§12.3 "the line says so and asks again").
    expect(choose).toContain("if (chooseMatchGrew(read.answer.total, line.total)) {");
    // The box's tri-state is TickBox's own indeterminate property (V34: TickBox is shared with step 2 and unchanged).
    expect(chooseTable).toContain('indeterminate={tick.tick === "some"}');
  });

  it("(V26) the categories and id reads mount inside step 1 only; the page reads no rules and holds no step 1 save (V25)", () => {
    const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    expect(choose).toContain("const categories = useQuery(chooseCategoriesQueryOptions());");
    for (const read of ["chooseCategoriesQueryOptions", "chooseIdsQueryOptions", "CHOOSE_CATEGORIES_URL"]) expect(page).not.toContain(read);
    for (const gone of ["selectionRulesQuery", "choosePendingRef", "chooseNotice", "pendingRef=", "checkChoosePending", "catalog-choose-notice"]) {
      expect(page).not.toContain(gone);
    }
    expect(page).toContain("ticks={{ choose: chooseStepTick(selectionSummaryQuery.data?.selectedTotal), setup: setupRail.tick, publish: null }}");
    expect(page).toContain("selection={selectionSummaryQuery.data ?? null}");
  });

  it("(review round 1 CLI-1, TST-2) the changes gone while a kept save may have committed: the saved choices are read again, and on leaving step 1 too", () => {
    // Undo or unticking back empties the changes (any way): the same reads as after a save, and the kept save goes.
    expect(choose).toContain("if (!chooseUndoneAfterUnsure(kept, changes)) return;");
    const undone = choose.slice(choose.indexOf("if (!chooseUndoneAfterUnsure(kept, changes)) return;"));
    expect(undone.indexOf("pendingRef.current = null;")).toBeLessThan(undone.indexOf("void Promise.allSettled([readRowsAfterMove(), onSaved(), categories.refetch(), newItems.refetch()]);"));
    expect(undone).toContain("}, [changes]);");
    // The bar says so only once the count names a head newer than that save's base.
    expect(choose).toContain("if (undoneCheck === null || !chooseHeadMovedPast(undoneCheck.baseRevisionId, headRevisionId)) return;");
    expect(choose).toContain("setOutcome({ kind: \"info\", message: CHOOSE_WORDS.undoneSaveMoved });");
    // Leaving step 1 ("Discard and leave" dispatches undo from the page as this step unmounts): the page reads again.
    expect(choose).toContain("if (!pendingRef.current?.mayHaveCommitted) return;");
    expect(choose).toContain("void queryClient.invalidateQueries({ queryKey: [...CHOOSE_CATALOG_QUERY_KEY], refetchType: \"none\" });");
    expect(choose).toContain("void onSavedRef.current();");
  });

  it("(review round 1 CLI-2) the site-updating line shows while the list or a bulk press's ids are read again after an older server's answer", () => {
    expect(choose).toContain("const siteUpdating = (catalog.isFetching && catalog.failureCount > 0 && isOlderCatalogServerError(catalog.failureReason)) || idsSiteUpdating;");
    expect(choose).toContain("setIdsSiteUpdating(isOlderCatalogServerError(error));");
    expect(choose).toContain("return retryPublishRead(failureCount, error);");
    expect(choose).not.toContain("isDropshipSiteUpdatingError");
    // The count's lines, on step 1 and 2 (the page) and on step 3, take the same answers.
    const page = readFileSync(join(process.cwd(), "client/src/pages/dropship/DropshipPortalCatalog.tsx"), "utf8");
    const publish = readFileSync(join(process.cwd(), "client/src/pages/dropship/catalog/PublishStep.tsx"), "utf8");
    expect(page).toContain("&& isOlderCatalogServerError(selectionSummaryQuery.failureReason);");
    expect(publish).toContain("isOlderCatalogServerError(props.summary.failureReason);");
  });

  it("(review round 1 CLI-4) changes count from the save's own revision, and none can be made before the count names a head", () => {
    expect(choose).toContain("onChanges({ type: \"saved\" });\n          onChanges({ type: \"rebase\", revisionId: result.answer.revisionId });");
    expect(choose).toContain("const bulkLocked = saving || idsBusy || selection === null;");
    expect(choose).toContain("const locked = bulkLocked || catalog.isPlaceholderData || rowsBehind;");
  });

  it("labels the tier badge by tier and never says on sale or off sale", () => {
    expect(chooseTable).toContain('{row.listingTier.tier === "case" ? "Case tier not active" : "Pack tier not active"}');
    expect(chooseTable).not.toMatch(/"(Cases off sale|Off sale|On sale)"/);
  });
});
