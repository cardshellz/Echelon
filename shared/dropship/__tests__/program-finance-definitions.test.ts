import { describe, expect, it } from "vitest";
import { dropshipWalletLedgerTypeEnum } from "../../schema/dropship.schema";
import {
  FINANCE_CHECK_IDS,
  FINANCE_COST_WAIT_ALERT_DAYS,
  FINANCE_DATED_BY,
  FINANCE_INFO_KEYS,
  FINANCE_INFO_LINE_KEYS,
  FINANCE_LINE_KEYS,
  FINANCE_METRIC_KEYS,
  FINANCE_NEVER_CHARGED_KINDS,
  FINANCE_NOTE_KEYS,
  FINANCE_SECTION_KEYS,
  FINANCE_SECTION_LINE_KEYS,
  FINANCE_STALE_PENDING_DEPOSIT_DAYS,
  FINANCE_WAITING_REASONS,
  financeMetricKeySchema,
  isFinanceLineKey,
  type FinanceCheckGroup,
  type FinanceCheckId,
} from "../program-finance";
import {
  FINANCE_CHECK_DEFINITIONS,
  FINANCE_CHECK_GROUP_WORDS,
  FINANCE_CHECK_RESULT_WORDS,
  FINANCE_COUNTING_CHOICES,
  FINANCE_DATED_BY_DEFINITIONS,
  FINANCE_INFO_DEFINITIONS,
  FINANCE_LEDGER_TYPES,
  FINANCE_LINE_DEFINITIONS,
  FINANCE_METRIC_DEFINITIONS,
  FINANCE_MONEY_PATH_STEPS,
  FINANCE_NOTE_DEFINITIONS,
  FINANCE_REASON_DEFINITIONS,
  FINANCE_REASON_KEYS,
  FINANCE_SECTION_DEFINITIONS,
  FINANCE_SECTION_GROUP_CAPTIONS,
  FINANCE_STAFF_DEPOSIT_LABELS,
  FINANCE_STAFF_LEDGER_LABELS,
  FINANCE_STAFF_LEDGER_STATUS_WORDS,
  FINANCE_TWO_CLOCKS_SENTENCE,
  FINANCE_WAITING_REASON_DEFINITIONS,
  FINANCE_WORKING_DEFINITIONS,
  findMissingFinanceDefinitions,
  financeWorkingStepWords,
  isFinanceReasonKey,
  type FinanceDefinition,
  type FinanceTechnicalSource,
} from "../program-finance-definitions";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The contract's reason/working key shape (textKey in program-finance.ts). */
const TEXT_KEY = /^[a-z0-9_.]{3,80}$/;
/** Engineering words the copy deck keeps off the screen (spec §1.2 "Jargon"). */
const JARGON = /\b(FIFO|contribution|roll-forward|basis points|bps|mixed|COGS)\b/i;

function expectWords(value: string, label: string): void {
  expect(value.trim(), `${label} has words`).not.toBe("");
  expect(value, `${label} has no leading or trailing space`).toBe(value.trim());
}

function expectTechnicalSource(source: FinanceTechnicalSource, label: string): void {
  expect(source.tables.length + source.columns.length, `${label} names a table or a column`).toBeGreaterThan(0);
  for (const part of [...source.tables, ...source.columns, ...source.filters]) expectWords(part, `${label} source part`);
  for (const table of source.tables) expect(table, `${label} table is schema-qualified`).toMatch(/^[a-z_]+\.[a-z_]+$/);
  if (source.dateColumn !== null) expectWords(source.dateColumn, `${label} date column`);
}

function expectDefinition(definition: FinanceDefinition | undefined, label: string): void {
  expect(definition, `${label} is defined`).toBeDefined();
  if (!definition) return;
  expectWords(definition.words, `${label} words`);
  expectWords(definition.definition, `${label} definition`);
  expect(definition.definition, `${label} definition is a sentence`).toMatch(/[.)]$/);
  expect(definition.definition, `${label} definition is plain`).not.toMatch(JARGON);
  expect(definition.words, `${label} words are plain`).not.toMatch(JARGON);
  expectTechnicalSource(definition.technicalSource, label);
}

describe("program finance definitions", () => {
  it("leave no closed key without words", () => {
    expect(findMissingFinanceDefinitions()).toEqual([]);
  });

  it("give every line key words, a plain definition, a unit and a technical source", () => {
    for (const key of FINANCE_LINE_KEYS) expectDefinition(FINANCE_LINE_DEFINITIONS[key], `line ${key}`);
  });

  it("hold every FINANCE_SECTION_LINE_KEYS entry, and nothing else", () => {
    for (const section of FINANCE_SECTION_KEYS) {
      for (const key of FINANCE_SECTION_LINE_KEYS[section]) expect(FINANCE_LINE_DEFINITIONS[key], key).toBeDefined();
    }
    for (const info of FINANCE_INFO_KEYS) {
      for (const key of FINANCE_INFO_LINE_KEYS[info]) expect(FINANCE_LINE_DEFINITIONS[key], key).toBeDefined();
    }
    expect(Object.keys(FINANCE_LINE_DEFINITIONS).sort()).toEqual([...FINANCE_LINE_KEYS].sort());
  });

  it("link lines only to list sheets that exist", () => {
    for (const key of FINANCE_LINE_KEYS) {
      const opensMetric = FINANCE_LINE_DEFINITIONS[key].opensMetric;
      if (opensMetric !== undefined) expect(financeMetricKeySchema.safeParse(opensMetric).success, `${key} → ${opensMetric}`).toBe(true);
    }
  });

  it("count points in points, except the two lines that give their worth in cents", () => {
    const centsInPoints = new Set(["points.used.billed_value", "points.memo.from_cash"]);
    for (const key of FINANCE_SECTION_LINE_KEYS.points) {
      expect(FINANCE_LINE_DEFINITIONS[key].unit, key).toBe(centsInPoints.has(key) ? "cents" : "points");
    }
    for (const section of FINANCE_SECTION_KEYS.filter((candidate) => candidate !== "points")) {
      for (const key of FINANCE_SECTION_LINE_KEYS[section]) expect(FINANCE_LINE_DEFINITIONS[key].unit, key).not.toBe("points");
    }
  });

  it("use the copy deck's words for the statement lines (spec §10)", () => {
    const deck: Record<string, string> = {
      "sales.billed": "Billed to vendors",
      "sales.billed.markup": "our markup",
      "sales.waiting": "Not yet fully costed",
      "sales.cogs": "Cost of goods (what the products cost us)",
      "sales.pool_fc": "Insurance pool share (set aside, not ours to keep)",
      "sales.return_credits_cs": "Return credits we paid (not from the pool)",
      "sales.kept": "What we kept",
      "sales.never_charged": "Received {period} and never charged: {n} orders",
      "products.packs_fully_costed": "Cost and kept cover packs on fully costed orders ({x} of {y} packs)",
      "cash.received": "Cash received · before Stripe's fees",
      "cash.memo.stuck": "Waiting more than 7 days",
      "cash.memo.staff_credits": "Staff wallet credits aren't cash: see Returns and credits",
      "returns.credits_pool.no_inspection": "lost or approved without inspection",
      "returns.staff_credits": "Staff wallet credits (corrections, not cash)",
      "owed.walk.disputes_taken": "Disputes: deposits taken back",
      "owed.walk.closing": "Owed now",
      "points.given": "Given on bank and USDC deposits",
      "pool.topped_up": "Topped up (carrier recoveries, staff adjustments)",
      "pool.claims": "Carrier claims filed: {n} · {$} asked · none approved or paid yet",
    };
    for (const [key, words] of Object.entries(deck)) {
      expect(isFinanceLineKey(key), key).toBe(true);
      if (isFinanceLineKey(key)) expect(FINANCE_LINE_DEFINITIONS[key].words, key).toBe(words);
    }
    expect(FINANCE_LINE_DEFINITIONS["points.held"].wordsAtEndOfPeriod).toBe("Held at end of {date}");
  });

  it("describe on the way and the charged deposit lines as the page works them out", () => {
    // The Cash in memo sums the pending deposits in the wallet history; the We-owe figure reads the wallets (check W2 compares them).
    expect(FINANCE_LINE_DEFINITIONS["cash.memo.on_the_way"].technicalSource).toEqual({
      tables: ["dropship.dropship_wallet_ledger"],
      columns: ["Σ amount_cents", "COUNT(*)"],
      filters: ["type = 'funding'", "status = 'pending'"],
      dateColumn: null,
    });
    expect(FINANCE_METRIC_DEFINITIONS["cash.on_the_way"].technicalSource).toEqual(FINANCE_LINE_DEFINITIONS["cash.memo.on_the_way"].technicalSource);
    expect(FINANCE_LINE_DEFINITIONS["owed.on_the_way"].technicalSource).toMatchObject({
      tables: ["dropship.dropship_wallet_accounts"], columns: ["Σ pending_balance_cents"],
    });
    // A charged amount that is not whole cents counts at the wallet credit (contract C8): never "left out".
    const charged = ["cash.ach", "cash.card", "cash.usdc", "cash.collection", "cash.unknown", "cash.received_deposits"] as const;
    for (const key of charged) {
      const filters = FINANCE_LINE_DEFINITIONS[key].technicalSource.filters;
      expect(filters.some((filter) => filter.includes("counts at amount_cents") && filter.includes("partial")), key).toBe(true);
      expect(filters.some((filter) => filter.includes("left out")), key).toBe(false);
    }
    expect(FINANCE_LINE_DEFINITIONS["cash.received_deposits"].technicalSource.columns).toContain("COUNT(*)");
    // A card fee or points amount that is not whole cents is left out of its own sum.
    for (const key of ["sales.fees.card", "cash.card.fees", "points.memo.from_cash"] as const) {
      expect(FINANCE_LINE_DEFINITIONS[key].technicalSource.filters.some((filter) => filter.includes("left out")), key).toBe(true);
    }
    for (const source of [FINANCE_CHECK_DEFINITIONS.D7.technicalSource, FINANCE_REASON_DEFINITIONS.metadata_malformed.technicalSource]) {
      expect(source.filters.some((filter) => filter.includes("chargedCents that is not counts at amount_cents"))).toBe(true);
    }
  });

  it("word each waiting reason and its summary line the same way", () => {
    for (const reason of FINANCE_WAITING_REASONS) {
      const definition = FINANCE_WAITING_REASON_DEFINITIONS[reason];
      expectDefinition(definition, `waiting reason ${reason}`);
      expect(FINANCE_LINE_DEFINITIONS[`sales.waiting.${reason}`].words).toBe(definition.summaryWords);
      expect(definition.summaryWords).not.toMatch(/\{/);
    }
    expect(FINANCE_WAITING_REASON_DEFINITIONS.partly_shipped.words).toBe("Partly shipped ({x} of {y} packs)");
    expect(FINANCE_WAITING_REASON_DEFINITIONS.item_cost_missing.words).toBe("Cost of goods not recorded for {n} packs");
  });

  it("date the never-charged lines by the day received", () => {
    for (const kind of FINANCE_NEVER_CHARGED_KINDS) {
      const definition = FINANCE_LINE_DEFINITIONS[`sales.never_charged.${kind}`];
      expect(definition.technicalSource.dateColumn).toBe("dropship.dropship_order_intake.received_at");
      expect(definition.unit).toBe("count");
    }
  });

  it("give every check its §8 wording, group, scope, owner lines and a technical source", () => {
    const groups: Record<FinanceCheckId, FinanceCheckGroup> = {
      W1: "wallets", W2: "wallets", W3: "wallets", W4: "wallets",
      O1: "orders", O2: "orders", O3: "orders", O4: "orders", O5: "orders", O6: "orders",
      D1: "deposits", D2: "deposits", D3: "deposits", D4: "deposits", D5: "deposits", D6: "deposits", D7: "deposits",
      K1: "costs", K2: "costs", K3: "costs",
      R1: "returns_pool", R2: "returns_pool",
      N1: "never", N2: "never", N3: "never",
      P1: "page", P2: "page",
    };
    for (const id of FINANCE_CHECK_IDS) {
      const definition = FINANCE_CHECK_DEFINITIONS[id];
      expect(definition.group, id).toBe(groups[id]);
      expectWords(definition.wording, `check ${id} wording`);
      expectWords(definition.definition, `check ${id} definition`);
      expectTechnicalSource(definition.technicalSource, `check ${id}`);
      expect(definition.ownerLineKeys.length, id).toBeLessThanOrEqual(6);
      for (const owner of definition.ownerLineKeys) expect(isFinanceLineKey(owner), `${id} owner ${owner}`).toBe(true);
      expectWords(FINANCE_CHECK_GROUP_WORDS[definition.group], `group ${definition.group}`);
    }
    expect(FINANCE_CHECK_IDS.filter((id) => FINANCE_CHECK_DEFINITIONS[id].programOnly)).toEqual(["N2", "P2"]);
    expect(FINANCE_CHECK_DEFINITIONS.W1.wording).toBe("Each wallet's balance matches its history");
    expect(FINANCE_CHECK_DEFINITIONS.D6.wording).toBe(
      `No deposit has waited more than ${FINANCE_STALE_PENDING_DEPOSIT_DAYS} days, and every deposit has a way paid`,
    );
    expect(FINANCE_CHECK_DEFINITIONS.D6.wording).toBe("No deposit has waited more than 7 days, and every deposit has a way paid");
    expect(FINANCE_CHECK_DEFINITIONS.K3.wording).toBe(`No order has waited more than ${FINANCE_COST_WAIT_ALERT_DAYS} days for its costs`);
    expect(FINANCE_CHECK_DEFINITIONS.K3.scope).toBe("all_time");
    expect(Object.values(FINANCE_CHECK_RESULT_WORDS)).toEqual(["Fine", "Needs a look", "Couldn't check", "Program-wide: see all vendors"]);
  });

  it("give every information line, note and clock chip words and a source", () => {
    for (const key of FINANCE_INFO_KEYS) expectDefinition(FINANCE_INFO_DEFINITIONS[key], `info ${key}`);
    for (const key of FINANCE_NOTE_KEYS) expectDefinition(FINANCE_NOTE_DEFINITIONS[key], `note ${key}`);
    for (const key of FINANCE_DATED_BY) expectDefinition(FINANCE_DATED_BY_DEFINITIONS[key], `datedBy ${key}`);
    expect(FINANCE_DATED_BY_DEFINITIONS.accepted.words).toBe("day accepted");
    expect(FINANCE_DATED_BY_DEFINITIONS.now.words).toBe("right now");
  });

  it("date the policy-era notes as the contract says (§2.10), first day before last", () => {
    expect(FINANCE_NOTE_DEFINITIONS.card_fee_era).toMatchObject({ firstDate: "2026-09-16", lastDate: "2026-09-24" });
    expect(FINANCE_NOTE_DEFINITIONS.pricing_v1_era).toMatchObject({ firstDate: null, lastDate: "2026-09-12" });
    expect(FINANCE_NOTE_DEFINITIONS.weekly_collection_era).toMatchObject({ firstDate: "2026-08-05", lastDate: "2026-09-17" });
    for (const key of FINANCE_NOTE_KEYS) {
      const { firstDate, lastDate } = FINANCE_NOTE_DEFINITIONS[key];
      if (firstDate !== null) expect(firstDate).toMatch(LOCAL_DATE);
      if (lastDate !== null) expect(lastDate).toMatch(LOCAL_DATE);
      if (firstDate !== null && lastDate !== null) expect(firstDate <= lastDate, key).toBe(true);
    }
    expect(FINANCE_NOTE_DEFINITIONS.card_fee_era.words).toBe("Card top-ups carried a 3% fee from Sep 16 to Sep 24, 2026.");
    expect(FINANCE_NOTE_DEFINITIONS.pricing_v1_era.words).toBe("Orders before Sep 13, 2026 used older pricing.");
    expect(FINANCE_NOTE_DEFINITIONS.weekly_collection_era.words).toBe("The weekly collection ran from Aug 5 to Sep 17, 2026 (retired).");
  });

  it("give every reason a kind, words and a source, in the contract's key shape", () => {
    expect(FINANCE_REASON_KEYS.length).toBeGreaterThan(0);
    for (const key of FINANCE_REASON_KEYS) {
      expect(key).toMatch(TEXT_KEY);
      expect(isFinanceReasonKey(key)).toBe(true);
      expectDefinition(FINANCE_REASON_DEFINITIONS[key], `reason ${key}`);
    }
    expect(isFinanceReasonKey("toString")).toBe(false);
    expect(FINANCE_REASON_DEFINITIONS.packaging_not_saved.words).toBe("Box and mailer costs are not saved per package.");
    expect(FINANCE_REASON_DEFINITIONS.packaging_not_saved.kind).toBe("not_recorded");
    expect(FINANCE_REASON_DEFINITIONS.pieces_not_recorded.kind).toBe("partial");
    expect(FINANCE_REASON_DEFINITIONS.program_wide.kind).toBe("unavailable");
  });

  it("title every working step from a line key or a working key", () => {
    for (const key of Object.keys(FINANCE_WORKING_DEFINITIONS)) {
      expect(key).toMatch(TEXT_KEY);
      expect(financeWorkingStepWords(key)).toBe(FINANCE_WORKING_DEFINITIONS[key as keyof typeof FINANCE_WORKING_DEFINITIONS].words);
    }
    expect(financeWorkingStepWords("sales.kept_orders")).toBe("Kept on orders");
    expect(financeWorkingStepWords("working.bogus")).toBeNull();
    expect(financeWorkingStepWords("constructor")).toBeNull();
  });

  it("give every list sheet a title, a definition and a source", () => {
    for (const metric of FINANCE_METRIC_KEYS) expectDefinition(FINANCE_METRIC_DEFINITIONS[metric], `metric ${metric}`);
    expect(FINANCE_METRIC_DEFINITIONS["check.W1"].words).toBe(FINANCE_CHECK_DEFINITIONS.W1.wording);
  });

  it("give every section a title, a clock chip, a group caption and a collapsed amount line", () => {
    for (const section of FINANCE_SECTION_KEYS) {
      const definition = FINANCE_SECTION_DEFINITIONS[section];
      expectWords(definition.title, `${section} title`);
      expectWords(definition.chip, `${section} chip`);
      expectWords(FINANCE_SECTION_GROUP_CAPTIONS[definition.group], `${section} group`);
      if (definition.amountLineKey !== null) {
        expect((FINANCE_SECTION_LINE_KEYS[section] as readonly string[]).includes(definition.amountLineKey), section).toBe(true);
      }
    }
    expect(FINANCE_SECTION_DEFINITIONS.vendors.amountLineKey).toBeNull();
  });

  it("list the 13 choices of 'How this page counts', the dispute one awaiting sign-off", () => {
    expect(FINANCE_COUNTING_CHOICES).toHaveLength(13);
    expect(new Set(FINANCE_COUNTING_CHOICES.map((choice) => choice.key)).size).toBe(13);
    for (const choice of FINANCE_COUNTING_CHOICES) {
      expectWords(choice.words, `choice ${choice.key}`);
      expectWords(choice.technical, `choice ${choice.key} technical`);
      expect(choice.words, choice.key).not.toMatch(JARGON);
    }
    expect(FINANCE_COUNTING_CHOICES.filter((choice) => choice.needsSignOff).map((choice) => choice.key)).toEqual(["dispute_cash"]);
  });

  it("frame the page with the copy deck's two-clocks sentence and the five-step money path", () => {
    expect(FINANCE_TWO_CLOCKS_SENTENCE).toBe("Orders count on the day we accepted them. Money counts on the day it moved. Eastern time.");
    expect(financeWorkingStepWords("working.two_clocks")).toBe(FINANCE_TWO_CLOCKS_SENTENCE);
    expect(FINANCE_MONEY_PATH_STEPS).toHaveLength(5);
    for (const step of FINANCE_MONEY_PATH_STEPS) expectWords(step, "money path step");
  });

  it("label all 15 wallet entry types for staff, matching the schema's list", () => {
    expect([...FINANCE_LEDGER_TYPES].sort()).toEqual([...dropshipWalletLedgerTypeEnum].sort());
    expect(FINANCE_LEDGER_TYPES).toHaveLength(15);
    for (const type of FINANCE_LEDGER_TYPES) expectWords(FINANCE_STAFF_LEDGER_LABELS[type], `ledger ${type}`);
    expect(FINANCE_STAFF_LEDGER_LABELS.insurance_pool_credit).toBe("Return credit (insurance pool)");
    expect(FINANCE_STAFF_LEDGER_LABELS.refund_credit).toBe("Unexpected entry (nothing should write this)");
    expect(FINANCE_STAFF_DEPOSIT_LABELS.manual).toBe("Staff wallet credit");
    expect(FINANCE_STAFF_LEDGER_STATUS_WORDS.pending).toBe("on the way");
  });

  it("is frozen, so a consumer cannot change the page's words", () => {
    expect(Object.isFrozen(FINANCE_LINE_DEFINITIONS)).toBe(true);
    expect(Object.isFrozen(FINANCE_LINE_DEFINITIONS["sales.billed"])).toBe(true);
    expect(Object.isFrozen(FINANCE_LINE_DEFINITIONS["sales.billed"].technicalSource.tables)).toBe(true);
    expect(Object.isFrozen(FINANCE_CHECK_DEFINITIONS.W1.ownerLineKeys)).toBe(true);
    expect(Object.isFrozen(FINANCE_COUNTING_CHOICES)).toBe(true);
  });
});
