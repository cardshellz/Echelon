import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { DropshipApiError } from "@/lib/dropship-ops-surface";
import { DropshipFinancePanel } from "../dropship-finance-panel";
import {
  DROPSHIP_FINANCE_QUERY_KEY_ROOT,
  FinanceContractError,
  buildFinanceCountingView,
  buildFinanceHowView,
  financeQueryRetry,
  financeQueryRetryDelay,
} from "../dropship-finance-model";
import { FinanceCountingBody, FinanceHowBody } from "../dropship-finance/finance-sheets";
import { FINANCE_TONE_TEXT_CLASSES } from "../dropship-finance/finance-ui";
import {
  financeFixtureCheck,
  financeSummaryFixture,
  financeSummaryFixtureInput,
  parseFinanceFixture,
} from "./fixtures/dropship-finance-summary.fixture";

// shadcn's Skeleton uses JSX without importing React; the classic JSX transform in tests needs it global.
vi.stubGlobal("React", React);

const queries = vi.hoisted(() => ({
  states: [] as Array<Record<string, unknown>>,
  index: 0,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn(() => {
    const state = queries.states[queries.index] ?? {};
    queries.index += 1;
    return {
      data: undefined,
      error: null,
      isLoading: false,
      isFetching: false,
      isError: false,
      refetch: () => Promise.resolve(),
      ...state,
    };
  }),
}));

beforeEach(() => {
  queries.states = [];
  queries.index = 0;
  vi.clearAllMocks();
});

const ALL_ROWS = "open=sales,products,cash,returns,owed,points,pool,vendors,checks";
const CLOCK = () => new Date("2026-10-05T13:14:00.000Z");

function renderPanel(options: { canView?: boolean; search?: string; query?: Record<string, unknown> } = {}): string {
  queries.states = [options.query ?? {}];
  queries.index = 0;
  return renderToStaticMarkup(
    createElement(Router, {
      ssrPath: "/dropship",
      ssrSearch: options.search ?? "tab=finance",
      children: createElement(DropshipFinancePanel, { canView: options.canView ?? true, clock: CLOCK }),
    }),
  );
}

function loaded(search = `tab=finance&${ALL_ROWS}`, data = financeSummaryFixture()): string {
  return renderPanel({ search, query: { data } });
}

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "source", "col", "wbr", "area", "base", "embed", "track"]);

/** The whole element (its open tag to its matching close tag) whose own opening tag carries this test id. */
function region(html: string, testId: string): string {
  const marker = html.indexOf(`data-testid="${testId}"`);
  expect(marker, `no element carries data-testid="${testId}"`).toBeGreaterThanOrEqual(0);
  const start = html.lastIndexOf("<", marker);
  const tagName = /^<([a-z0-9]+)/.exec(html.slice(start))?.[1] ?? "div";
  const tagPattern = new RegExp(`<(/?)${tagName}(?=[\\s>/])[^>]*>`, "g");
  tagPattern.lastIndex = start;
  let depth = 0;
  for (let match = tagPattern.exec(html); match; match = tagPattern.exec(html)) {
    const selfClosing = match[0].endsWith("/>") || VOID_TAGS.has(tagName);
    if (match[1] === "/") depth -= 1;
    else if (!selfClosing) depth += 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  return html.slice(start);
}

/** Text as renderToStaticMarkup escapes it. */
function escapeHtml(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#x27;");
}

function tags(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}(\\s[^>]*)?>`, "g")) ?? [];
}

const root = process.cwd();
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");
const page = read("client", "src", "pages", "Dropship.tsx");
const shell = read("client", "src", "components", "layout", "AppShell.tsx");
const css = read("client", "src", "index.css");
const financeSources: Record<string, string> = {
  "dropship-finance-model.ts": read("client", "src", "pages", "dropship-finance-model.ts"),
  "dropship-finance-panel.tsx": read("client", "src", "pages", "dropship-finance-panel.tsx"),
  ...Object.fromEntries(
    readdirSync(join(root, "client", "src", "pages", "dropship-finance")).map((file) => [
      `dropship-finance/${file}`,
      read("client", "src", "pages", "dropship-finance", file),
    ]),
  ),
};

/** Buttons this page renders itself; each must do something in part 1. */
const PAGE_ACTIONS = ["info", "open-checks", "remove-vendor", "pick-dates", "apply-dates", "open-counting", "open-how", "scope-vendor", "retry"];
/** Buttons Radix renders for its own widgets (select, switch, menu, accordion, collapsible, toggle group, popover). */
const RADIX_TRIGGER = /\saria-(controls|haspopup)="|\srole="(switch|combobox|radio)"/;

describe("wiring", () => {
  it("is a tab on the Dropship ops page, gated on the permission every finance route requires", () => {
    expect(page).toContain('  | "finance"\n');
    expect(page).toContain('  "finance",\n');
    expect(page).toContain('<TabsContent value="finance" className="m-0">');
    expect(page).toContain("<ProgramFinanceTab />");
    const tabStart = page.indexOf("function ProgramFinanceTab()");
    expect(tabStart).toBeGreaterThanOrEqual(0);
    const tabSource = page.slice(tabStart, page.indexOf("\n}\n", tabStart));
    expect(tabSource).toContain("const { hasPermission } = useAuth();");
    expect(tabSource).toContain('canView={hasPermission("dropship", "manage_operations")}');
  });

  it("makes the header Refresh refresh the finance summary on screen while the finance tab is open", () => {
    const refreshStart = page.indexOf("function refreshAll()");
    const refresh = page.slice(refreshStart, page.indexOf("\n  }\n", refreshStart));
    expect(refresh).toContain('if (activeTab === "finance")');
    // What it refetches (the visible summary only) is the model's refreshFinanceQueries, tested with a real QueryClient.
    expect(refresh).toContain("void refreshFinanceQueries(queryClient);");
    expect(refresh).not.toContain("refetchQueries");
    expect(DROPSHIP_FINANCE_QUERY_KEY_ROOT).toBe("dropship-finance");
  });

  it("links Program finance from the sidebar after Wallet Policy, for manage-operations only", () => {
    const walletPolicy = shell.indexOf('{ label: "Wallet Policy", icon: DollarSign, href: "/dropship?tab=wallet-policy" },');
    const finance = shell.indexOf('label: "Program finance"');
    const costChanges = shell.indexOf('{ label: "Cost Changes", icon: TrendingUp, href: "/dropship?tab=cost-changes" },');
    expect(walletPolicy).toBeGreaterThanOrEqual(0);
    expect(finance).toBeGreaterThan(walletPolicy);
    expect(costChanges).toBeGreaterThan(finance);
    const entry = shell.slice(finance, costChanges);
    expect(entry).toContain("icon: Receipt,");
    expect(entry).toContain('href: "/dropship?tab=finance",');
    expect(entry).toContain('requiredPermission: { resource: "dropship", action: "manage_operations" }');
  });

  it("keeps a Dropship tab link active while the tab writes its own query string", () => {
    const matcherStart = shell.indexOf("function isNavHrefActive(");
    const matcher = shell.slice(matcherStart, shell.indexOf("\n}\n", matcherStart));
    // The overview special case stays first.
    expect(matcher.indexOf('href === "/dropship?tab=overview"')).toBeLessThan(matcher.indexOf("DROPSHIP_TAB_HREF_PREFIX"));
    expect(matcher).toContain("if (href.startsWith(DROPSHIP_TAB_HREF_PREFIX)) {");
    expect(matcher).toContain('pathname === "/dropship" && navHrefQueryParam(currentHref, "tab") === navHrefQueryParam(href, "tab")');
    expect(shell).toContain('const DROPSHIP_TAB_HREF_PREFIX = "/dropship?tab=";');
  });

  it("keeps the status words at 4.5:1 text contrast or more in light and dark", () => {
    // Worked out from the shipped colours: Tailwind's OKLCH palette and the theme's HSL tokens.
    const palette = read("node_modules", "tailwindcss", "theme.css");
    const oklch = (name: string) => {
      const match = new RegExp(`--color-${name}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`).exec(palette);
      if (!match) throw new Error(`no ${name} in Tailwind's theme`);
      return oklchToSrgb(Number(match[1]) / 100, Number(match[2]), Number(match[3]));
    };
    const light = (token: string) => hslToken(css, token, 0);
    const dark = (token: string) => hslToken(css, token, 1);
    const [fine, attention] = [FINANCE_TONE_TEXT_CLASSES.fine, FINANCE_TONE_TEXT_CLASSES.attention];
    const shade = (classes: string, mode: "light" | "dark") => {
      const match = (mode === "light" ? /^text-([a-z]+-\d+)/ : /dark:text-([a-z]+-\d+)/).exec(classes);
      if (!match) throw new Error(`no ${mode} text colour in ${classes}`);
      return oklch(match[1]);
    };
    const pairs: Array<[string, number[], number[]]> = [
      ["light Fine on the card", shade(fine, "light"), light("card")],
      ["light Fine on the page", shade(fine, "light"), light("background")],
      ["light Needs a look on the card", shade(attention, "light"), light("card")],
      ["light Needs a look on the amber chip", shade(attention, "light"), oklch("amber-50")],
      ["dark Fine on the card", shade(fine, "dark"), dark("card")],
      ["dark Needs a look on the card", shade(attention, "dark"), dark("card")],
      ["dark Needs a look on the amber chip", shade(attention, "dark"), blend(oklch("amber-950"), 0.4, dark("background"))],
    ];
    for (const [what, text, background] of pairs) expect(contrastRatio(text, background), what).toBeGreaterThanOrEqual(4.5);
  });

  it("defines the finance colour tokens for light and dark themes", () => {
    for (const token of ["--finance-kept: var(--primary);", "--finance-track: var(--muted);"]) {
      expect(css.split(token)).toHaveLength(3);
    }
    expect(css).toContain("--finance-cogs: 215 25% 27%;");
    expect(css).toContain("--finance-cogs: 213 27% 84%;");
    expect(css).toContain("--finance-labels: 215 16% 47%;");
    expect(css).toContain("--finance-labels: 215 20% 65%;");
    expect(css).toContain("--finance-pool: 215 20% 65%;");
    expect(css).toContain("--finance-pool: 215 16% 47%;");
  });
});

// ── colour maths for the contrast test (WCAG 2 relative luminance) ──────────

function oklchToSrgb(lightness: number, chroma: number, hueDegrees: number): number[] {
  const hue = (hueDegrees * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((value) => {
    const clamped = Math.min(1, Math.max(0, value));
    return clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
  });
}

/** An HSL token from index.css: the first (light, :root) or second (dark, .dark) definition. */
function hslToken(source: string, token: string, occurrence: number): number[] {
  const matches = [...source.matchAll(new RegExp(`--${token}: (\\d+) (\\d+)% (\\d+)%;`, "g"))];
  const match = matches[occurrence];
  if (!match) throw new Error(`no --${token} #${occurrence} in index.css`);
  const [hue, saturation, lightness] = [Number(match[1]), Number(match[2]) / 100, Number(match[3]) / 100];
  const k = (n: number) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  return [0, 8, 4].map((n) => lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))));
}

function blend(top: number[], alpha: number, below: number[]): number[] {
  return top.map((channel, index) => channel * alpha + below[index] * (1 - alpha));
}

function contrastRatio(first: number[], second: number[]): number {
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [lighter, darker] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe("money safety in the finance sources", () => {
  it("imports none of the float or compact money formatters", () => {
    for (const [file, source] of Object.entries(financeSources)) {
      for (const forbidden of [
        /\bformatCents\b/, /\bformatDashboardCentsCompact\b/, /\bbpsToPercentText\b/, /\bformatPercent\b/, /\bformatMills\b/,
        /\.toFixed\(/, /\bparseFloat\(/, /Number\.parseFloat/, /style:\s*["']currency["']/, /\/\s*100\b(?!0)/, /\*\s*0\.01\b/,
      ]) {
        expect(source, `${file} uses ${forbidden}`).not.toMatch(forbidden);
      }
    }
  });

  it("calls only the summary route, and only through the model", () => {
    for (const [file, source] of Object.entries(financeSources)) {
      const routes = source.match(/"\/api\/[^"]*"/g) ?? [];
      expect(routes, file).toEqual(file === "dropship-finance-model.ts" ? ['"/api/dropship/admin/finance/summary"'] : []);
    }
  });

  it("uses theme tokens, never hex colours, in markup", () => {
    for (const [file, source] of Object.entries(financeSources)) {
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });

  it("gives every page button a handler, so no button is dead in part 1", () => {
    for (const [file, source] of Object.entries(financeSources)) {
      for (const match of source.matchAll(/data-finance-action="([a-z-]+)"/g)) {
        const action = match[1];
        expect(PAGE_ACTIONS, `${file}: unknown action ${action}`).toContain(action);
        const index = match.index ?? 0;
        const tag = source.slice(source.lastIndexOf("<", index), source.indexOf("<", index + 1));
        const popoverTrigger = source.slice(Math.max(0, index - 200), index).includes("<PopoverTrigger asChild>");
        expect(tag.includes("onClick=") || popoverTrigger, `${file}: ${action} has no handler`).toBe(true);
      }
    }
  });
});

describe("the summary query", () => {
  it("asks for the summary under the finance key, retrying transient errors only, and owns its error display", () => {
    renderPanel({ search: "tab=finance&period=last-month&compare=off&vendor=12&open=sales" });
    const options = vi.mocked(useQuery).mock.calls[0]![0] as unknown as Record<string, unknown>;
    expect(options).toMatchObject({
      queryKey: ["dropship-finance", "summary", { period: "last-month", from: null, to: null, compare: false, vendorId: 12 }],
      enabled: true,
      meta: { handlesLoadError: true },
    });
    expect(options.retry).toBe(financeQueryRetry);
    expect(options.retryDelay).toBe(financeQueryRetryDelay);
    expect(options).not.toHaveProperty("placeholderData");
  });

  it("shows nothing and asks for nothing without Dropship operations access", () => {
    const html = renderPanel({ canView: false, query: { data: financeSummaryFixture() } });
    expect(html).toContain("Program finance needs Dropship operations access (Administrator).");
    expect(html).not.toContain("$26.41");
    expect(html).not.toContain('data-testid="finance-period-bar"');
    expect(vi.mocked(useQuery).mock.calls[0]![0]).toMatchObject({ enabled: false });
  });
});

describe("loading", () => {
  it("renders the bar at once, skeletons at final heights and the rows' real titles, with no numbers", () => {
    const html = renderPanel({ query: { isLoading: true, isFetching: true } });
    expect(html).toContain('data-testid="finance-period-bar"');
    expect(html).toContain("This month so far");
    expect(html).toContain("Checking…");
    expect(html).toContain('data-testid="finance-loading"');
    for (const title of ["Sales and what we kept", "Products sold", "Cash in", "Returns and credits", "What we owe and are owed", "Points (rewards)", "Insurance pool", "Vendors", "Checks"]) {
      expect(html).toContain(title);
    }
    expect(html).not.toMatch(/\$\d/);
    expect(html).toContain("Orders count on the day we accepted them. Money counts on the day it moved. Eastern time.");
  });

  it("shows the custom dates from the URL before the server answers", () => {
    const html = renderPanel({ search: "tab=finance&period=custom&from=2026-11-01&to=2026-11-02", query: { isLoading: true } });
    expect(html).toContain("Nov 1 – 2, 2026");
  });

  it("leaves the Vendors row out of the skeleton in a vendor's view", () => {
    const html = renderPanel({ search: "tab=finance&vendor=12", query: { isLoading: true } });
    expect(html).not.toMatch(/>Vendors</);
    expect(html).toContain("Vendor: Vendor #12");
  });
});

describe("errors", () => {
  it("shows the load-failure card and a retry, and no numbers, when the request fails", () => {
    const error = new DropshipApiError({ status: 503, code: "DROPSHIP_FINANCE_QUERY_TIMEOUT", message: "Timed out", context: { classification: "transient" } });
    const html = renderPanel({ query: { isError: true, error, data: financeSummaryFixture() } });
    const card = region(html, "finance-page-error");
    expect(card).toContain('role="alert"');
    expect(card).toContain(
      "Couldn&#x27;t load program finance for this month so far. Nothing is shown so older numbers can&#x27;t be mistaken for current ones. (DROPSHIP_FINANCE_QUERY_TIMEOUT)",
    );
    expect(card).toContain('data-finance-action="retry"');
    // A failed refresh hides the numbers it had (spec §7).
    expect(html).not.toContain("$26.41");
  });

  it("says numbers that could not be checked are not shown, with no retry", () => {
    const html = renderPanel({ query: { isError: true, error: new FinanceContractError(["answer.billed"]) } });
    expect(html).toContain("These numbers could not be checked, so none are shown. (DROPSHIP_FINANCE_CONTRACT_VIOLATION)");
    expect(region(html, "finance-page-error")).not.toContain('data-finance-action="retry"');
  });

  it("says a bad period inline, and the permission copy for a 403", () => {
    const badPeriod = new DropshipApiError({ status: 400, code: "DROPSHIP_FINANCE_INVALID_PERIOD", message: "The end date is after today", context: { classification: "permanent" } });
    expect(renderPanel({ query: { isError: true, error: badPeriod } })).toContain("These dates don&#x27;t work: the end date is after today. Pick other dates.");
    const forbidden = new DropshipApiError({ status: 403, code: null, message: "Permission denied: dropship:manage_operations" });
    expect(renderPanel({ query: { isError: true, error: forbidden } })).toContain("Program finance needs Dropship operations access (Administrator).");
  });

  it("shows a failed section in its own row while the others render", () => {
    const input = financeSummaryFixtureInput();
    input.sections.cash = { status: "error", errorCode: "DROPSHIP_FINANCE_QUERY_TIMEOUT", lines: [] };
    const html = loaded(`tab=finance&${ALL_ROWS}`, parseFinanceFixture(input));
    const cash = region(html, "finance-detail-cash");
    expect(cash).toContain("Couldn&#x27;t work out cash in: DROPSHIP_FINANCE_QUERY_TIMEOUT.");
    expect(cash).toContain('data-finance-action="retry"');
    expect(html).toContain("$26.41");
  });
});

describe("the loaded page", () => {
  it("leads with what we kept, its caveat, the margin and the coverage meter", () => {
    const answer = region(loaded(), "finance-answer");
    expect(answer).toContain("What we kept");
    expect(answer).toContain("$26.41");
    expect(answer).toContain("before packaging, Stripe fees and overheads");
    expect(answer).toContain("39.9% of what we billed on fully costed orders");
    expect(answer).toContain("−0.5 pts vs Sep 1 – 5");
    expect(answer).toMatch(/role="meter"[^>]*aria-valuemin="0"[^>]*aria-valuemax="10"[^>]*aria-valuenow="3"[^>]*aria-valuetext="3 of 10 orders"/);
    expect(answer).toContain("Costs complete on 3 of 10 orders");
    expect(answer).toContain("7 orders ($90.00) count once their costs are recorded");
    expect(answer).toContain("$22.00 of what we billed was paid with points: no cash came in for it");
    expect(answer).toMatch(/data-finance-action="open-how"[^>]*aria-label="What we kept, 26 dollars and 41 cents, before packaging, Stripe fees and overheads, opens how it was worked out"|aria-label="What we kept, 26 dollars and 41 cents, before packaging, Stripe fees and overheads, opens how it was worked out"[^>]*data-finance-action="open-how"/);
  });

  it("draws the bar as an image with a sentence, and its legend as a real table", () => {
    const answer = region(loaded(), "finance-answer");
    expect(answer).toContain(
      'role="img" aria-label="Of each dollar billed on 3 fully costed orders: 40 cents kept, 39 cents cost of goods, 20 cents carrier labels, 1 cent insurance pool share; 7 orders, 90 dollars, not yet fully costed"',
    );
    expect(answer).toContain("flex-grow:2072");
    expect(answer).toContain("flex-grow:4805");
    expect(answer).toContain("bg-[hsl(var(--finance-kept))]");
    const legend = region(answer, "finance-bar-legend");
    expect(legend).toContain("<caption");
    for (const cell of ["Kept on orders", "40¢", "$38.81", "Cost of goods", "39¢", "$37.64", "Carrier labels", "$19.35", "Insurance pool share (set aside)", "$1.50", "Not yet fully costed · 7 orders", "$90.00"]) {
      expect(legend).toContain(cell);
    }
    expect(answer).toContain("$38.81 kept on orders + $7.60 fees we charged − $20.00 return credits we paid = $26.41 kept");
  });

  it("shows the four tiles as plain cards, not buttons", () => {
    const html = loaded();
    const tiles = region(html, "finance-tiles");
    for (const text of ["Billed to vendors", "$187.30", "+$161.30 (+620.4%) vs Sep 1 – 5", "Cash received", "$883.00", "We owe vendors · now", "$3,811.10", "$190.00 on the way, not yet cash", "Vendors owe us · now", "$12.50", "1 vendor below zero"]) {
      expect(tiles).toContain(text);
    }
    // The only buttons in the tiles are their ⓘ buttons and amber check dots.
    for (const button of tags(tiles, "button")) expect(button).toMatch(/data-finance-action="(info|open-checks)"/);
    // A value never wraps: its font follows the tile's width (a container query) and the value's length.
    const values = tags(tiles, "p").filter((tag) => tag.includes('data-testid="finance-tile-value"'));
    expect(values).toHaveLength(4);
    for (const value of values) expect(value).toMatch(/class="[^"]*whitespace-nowrap[^"]*" style="font-size:min\(1\.5rem, calc\(100cqi \/ \d+ \/ 0\.7\)\)"/);
    expect(tags(tiles, "div").filter((tag) => tag.includes('data-testid="finance-tile-')).every((tag) => tag.includes("@container"))).toBe(true);
  });

  it("puts the period, compare, checks chip and as-of time in the sticky bar", () => {
    const bar = region(loaded(), "finance-period-bar");
    expect(bar).toContain('aria-label="Period"');
    expect(bar).toContain("sticky top-0");
    expect(bar).toContain("<h2");
    expect(bar).toContain("Program finance");
    expect(bar).toContain("Oct 1 – 5, 2026");
    expect(bar).toContain("Compare with Sep 1 – 5 (to 9:14 AM)");
    expect(bar).toMatch(/role="switch"[^>]*aria-checked="true"/);
    expect(bar).toContain("4 need a look");
    expect(bar).toContain("Numbers as of 9:14 AM ET");
  });

  it("opens the rows in place into statement tables with captions and row headers", () => {
    const sales = region(loaded(), "finance-detail-sales");
    expect(sales).toContain("<h3");
    expect(sales).toContain("<caption");
    expect(sales).toContain('<th scope="row"');
    expect(sales).toMatch(/<td aria-hidden="true"[^>]*>−<\/td>/);
    expect(sales).toContain('<span class="sr-only">minus </span>');
    expect(sales).toContain("Billed to vendors · 10 orders");
    expect(sales).toContain("Kept on orders · 39.9%");
    expect(sales).toContain("Fees we charged · day posted");
    expect(sales).toContain("What we kept");
    expect(sales).toContain("border-double");
    expect(sales).toContain("Not taken off what we kept:");
    expect(sales).toContain("day accepted");
  });

  it("lists the products and vendors top tables with rounding rows and exact totals", () => {
    const html = loaded();
    const products = region(html, "finance-detail-products");
    for (const text of ["Toploaders", "Penny sleeves", "Not linked to a catalog item", "Rounding", "−$0.01", "$37.64", "$37.56", "Cost and kept cover packs on fully costed orders (11 of 21 packs)"]) {
      expect(products).toContain(text);
    }
    const vendors = region(html, "finance-detail-vendors");
    expect(vendors).toContain('data-finance-action="scope-vendor"');
    expect(vendors).toContain("Acme TCG");
    expect(vendors).toContain("Total · 3 vendors");
    expect(vendors).toContain("$26.41");
  });

  it("lists the checks by group, with the groups that need a look open", () => {
    const checks = region(loaded(), "finance-checks");
    expect(checks).toContain("Deposits");
    expect(checks).toContain("6 of 7 fine");
    expect(checks).toContain("Needs a look");
    expect(checks).toContain("No deposit has waited more than 7 days, and every deposit has a way paid");
    expect(checks).toContain("Cash returned (disputed amounts) $103.00 vs wallet restored $100.00");
  });

  it("shows only titles and amounts while every row is closed", () => {
    const html = loaded("tab=finance");
    expect(html).toContain("$26.41 kept");
    expect(html).toContain("21 packs · 950 pieces · 3 products");
    expect(html).not.toContain("Billed to vendors · 10 orders");
    expect(html).not.toContain('data-testid="finance-checks"');
  });

  it("scopes the page to a vendor: chip with a way out, vendor labels, no Vendors row", () => {
    const input = financeSummaryFixtureInput();
    input.scope = { vendor: { vendorId: 12, name: "Acme TCG", nameSource: "business_name" } };
    const html = loaded(`tab=finance&vendor=12&${ALL_ROWS}`, parseFinanceFixture(input));
    expect(html).toContain("Vendor: Acme TCG");
    expect(html).toContain('data-finance-action="remove-vendor"');
    expect(html).toContain("What we kept from Acme TCG");
    expect(html).toContain("Billed to Acme TCG");
    expect(html).not.toContain('data-testid="finance-detail-vendors"');
  });

  it("shows the loss state in words with the icon, not colour alone", () => {
    const input = financeSummaryFixtureInput();
    Object.assign(input.answer, {
      state: "loss", kept: { amount: -21_240, status: "recorded" }, keptOnOrders: -212, feesCharged: 0, returnCreditsPaid: 21_028,
      orders: 2, billed: 2_000, fullyCosted: { orders: 1, billed: 1_000 }, waiting: { orders: 1, billed: 1_000 },
      costOfGoods: 900, carrierLabels: 262, poolShare: 50, marginTenths: -212, marginBps: -2_120, marginChangeTenths: null,
      centsOfEachDollar: null, barBps: null, paidWithPoints: { billed: 0, points: 0 }, coverage: { done: 1, total: 2 },
    });
    const answer = region(loaded("tab=finance", parseFinanceFixture(input)), "finance-answer");
    expect(answer).toContain(">Loss<");
    expect(answer).toContain("−$212.40");
    expect(answer).toContain("text-red-700");
    expect(answer).toContain("Costs ran $2.12 over what we billed");
    expect(answer).toContain("calc(100% * 9041 / 10000)");
    expect(answer).not.toContain("¢");
  });

  it("has a polite live region for the 'Numbers updated' announcement, filled after the numbers mount", () => {
    // Effects do not run in a static render, so the region is present and still empty here;
    // the words come from financeUpdatedAnnouncement (model test).
    expect(region(loaded(), "finance-announcement")).toMatch(/^<div aria-live="polite" class="sr-only"[^>]*><\/div>$/);
  });
});

describe("no dead or part-2 affordances", () => {
  it("renders only buttons that act: the page's own actions or Radix widget triggers", () => {
    const html = loaded(`tab=finance&${ALL_ROWS}&depth=all`);
    const buttons = tags(html, "button");
    expect(buttons.length).toBeGreaterThan(10);
    for (const button of buttons) {
      const action = /data-finance-action="([a-z-]+)"/.exec(button)?.[1];
      if (action) expect(PAGE_ACTIONS).toContain(action);
      else expect(button, button).toMatch(RADIX_TRIGGER);
    }
    expect(tags(html, "a")).toEqual([]);
  });

  it("offers nothing that part 2 will build", () => {
    const html = loaded(`tab=finance&${ALL_ROWS}&depth=all`);
    for (const text of ["Export", "Download CSV", "Find an order", "See all", "See the rows", "Show 50 more", "Open in Order Intake", "Check custody now", "Wallet history"]) {
      expect(html, text).not.toContain(text);
    }
  });

  it("never prints a raw placeholder, NaN or undefined", () => {
    const input = financeSummaryFixtureInput();
    input.checks = input.checks.map((check) => (check.id === "W4" ? financeFixtureCheck("W4", { result: "could_not_check", errorCode: "DROPSHIP_FINANCE_BUDGET_EXCEEDED", exceptions: 0 }) : check));
    const html = loaded(`tab=finance&${ALL_ROWS}&depth=all`, parseFinanceFixture(input));
    expect(html).not.toMatch(/\{[a-z$]+\}/);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("[object Object]");
  });
});

describe("sheet bodies", () => {
  it("renders the server's working steps with operators and the technical source", () => {
    const view = buildFinanceHowView(financeSummaryFixture(), "answer.kept");
    expect(view).not.toBeNull();
    const html = renderToStaticMarkup(createElement(FinanceHowBody, { view: view! }));
    expect(html).toContain("$26.41");
    expect(html).toContain("Kept on orders");
    expect(html).toContain('<span class="sr-only">minus </span>Cost of goods (what the products cost us)');
    expect(html).toContain("$38.81");
    expect(html).toContain("Technical source");
    expect(html).toContain("dropship.dropship_order_economics_snapshots");
    // The margin steps show the card's own figures, in their units, the comparison with its dates.
    for (const text of ["39.9%", "40.4%", "−0.5 pts", "Kept on orders (Sep 1 – 5)", "Kept on orders as a share (Oct 1 – 5)"]) expect(html).toContain(text);
  });

  it("lists every number's plain definition, the money path and the choices", () => {
    const html = renderToStaticMarkup(createElement(FinanceCountingBody, { view: buildFinanceCountingView() }));
    expect(html).toContain("Vendors pay in");
    expect(html).toContain("Choices this page makes");
    expect(html).toContain("Needs the owner&#x27;s sign-off");
    expect(html).toContain("What we kept");
    expect(html).toContain("Technical source");
    expect(html).not.toMatch(/\{[a-z$]+\}/);
    // Each choice's code-level wording sits folded under "Technical source", never in plain view.
    const choices = region(html, "finance-choices-list");
    for (const choice of buildFinanceCountingView().choices) {
      const at = choices.indexOf(escapeHtml(choice.technical));
      expect(at, choice.key).toBeGreaterThan(0);
      expect(choices.lastIndexOf("<details", at), choice.key).toBeGreaterThan(choices.lastIndexOf("</details>", at));
    }
  });
});
