import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import {
  DropshipWalletPolicyImpactPanel,
  DropshipWalletPolicyPanel,
} from "../dropship-wallet-policy-panel";
import type { DropshipWalletPolicyOverview } from "../dropship-wallet-policy-model";

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

function overviewFixture(
  patch: Partial<DropshipWalletPolicyOverview> = {},
): DropshipWalletPolicyOverview {
  return {
    policy: null,
    limits: {
      autoReloadMinTriggerCents: 10_000,
      caseTierMinimumCents: 50_000,
      autoReloadMinAmountCents: 10_000,
      manualFundingMinCents: 1_000,
      manualFundingMaxCents: 500_000,
      defaultPaymentHoldTimeoutMinutes: 1_440,
      holdExpiryWarningMinutes: 120,
      advanceFeeBps: 100,
      advanceCapCents: 50_000,
      tierChangeGraceDays: 14,
    },
    limitsSource: "environment",
    envLimits: {
      autoReloadMinTriggerCents: 10_000,
      caseTierMinimumCents: 50_000,
      autoReloadMinAmountCents: 10_000,
      manualFundingMinCents: 1_000,
      manualFundingMaxCents: 500_000,
      defaultPaymentHoldTimeoutMinutes: 1_440,
      holdExpiryWarningMinutes: 120,
      advanceFeeBps: 100,
      advanceCapCents: 50_000,
      tierChangeGraceDays: 14,
    },
    envKeys: {
      autoReloadMinTriggerCents: "DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS",
      caseTierMinimumCents: null,
      autoReloadMinAmountCents: "DROPSHIP_AUTO_RELOAD_MIN_AMOUNT_CENTS",
      manualFundingMinCents: "DROPSHIP_STRIPE_MIN_WALLET_FUNDING_CENTS",
      manualFundingMaxCents: "DROPSHIP_STRIPE_MAX_WALLET_FUNDING_CENTS",
      // The hold timeout, the case tier, the advance and the grace have no
      // environment override; the server serves null for each.
      defaultPaymentHoldTimeoutMinutes: null,
      holdExpiryWarningMinutes: "DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES",
      advanceFeeBps: null,
      advanceCapCents: null,
      tierChangeGraceDays: null,
    },
    cardFundingFee: {
      bps: 290,
      envKey: "DROPSHIP_CARD_FUNDING_FEE_BPS",
      editable: false,
      readOnlyReason:
        "A vendor's agreement to the card fee is recorded only in an audit payload, not on their settings row.",
    },
    // Deliberately inconsistent with `limits`: a page that computed the counts
    // from the form could not produce these numbers.
    impact: {
      proposedAutoReloadMinTriggerCents: 7_500,
      proposedAutoReloadMinAmountCents: 25_000,
      vendorsBelowMinimumFloor: 7,
      vendorsBelowMinimumSingleTopUpLimit: 3,
      activeVendorsWithAutoReloadSettings: 19,
      evaluatedAt: "2026-09-20T10:00:00.000Z",
    },
    generatedAt: "2026-09-20T10:00:00.000Z",
    ...patch,
  };
}

function renderPanel(options: {
  canView?: boolean;
  canEdit?: boolean;
  overview?: DropshipWalletPolicyOverview;
  overviewState?: Record<string, unknown>;
  proposedState?: Record<string, unknown>;
} = {}): string {
  queries.states = [
    { data: options.overview, ...options.overviewState },
    { ...options.proposedState },
  ];
  queries.index = 0;
  return renderToStaticMarkup(
    createElement(DropshipWalletPolicyPanel, {
      canView: options.canView ?? true,
      canEdit: options.canEdit ?? true,
    }),
  );
}

/** The one <section> whose own opening tag carries this test id. */
function section(html: string, testId: string): string {
  const marker = `data-testid="${testId}"`;
  const part = html
    .split("<section")
    .find((candidate) => candidate.slice(0, candidate.indexOf(">")).includes(marker));
  expect(part, `no <section> carries ${marker}`).toBeDefined();
  return part ?? "";
}

function tags(html: string, tag: string): string[] {
  return html.match(new RegExp(`<${tag}[^>]*>`, "g")) ?? [];
}

/** The rendered `disabled` attribute, not the `disabled:` Tailwind classes. */
const DISABLED_ATTRIBUTE = /\sdisabled=""/;

const page = readFileSync(
  join(process.cwd(), "client", "src", "pages", "Dropship.tsx"),
  "utf8",
);
const shell = readFileSync(
  join(process.cwd(), "client", "src", "components", "layout", "AppShell.tsx"),
  "utf8",
);
const panelSource = readFileSync(
  join(process.cwd(), "client", "src", "pages", "dropship-wallet-policy-panel.tsx"),
  "utf8",
);
const modelSource = readFileSync(
  join(process.cwd(), "client", "src", "pages", "dropship-wallet-policy-model.ts"),
  "utf8",
);

describe("dropship wallet policy tab", () => {
  it("is a tab on the dropship ops page, reachable from the sidebar", () => {
    expect(page).toContain('| "wallet-policy"');
    expect(page).toContain('  "wallet-policy",');
    expect(page).toContain('<TabsContent value="wallet-policy" className="m-0">');
    expect(page).toContain("<WalletPolicyTab />");
    expect(shell).toContain(
      '{ label: "Wallet Policy", icon: DollarSign, href: "/dropship?tab=wallet-policy" },',
    );
  });

  it("gates the tab on the two dropship permissions the routes enforce, not on the page role", () => {
    const tabStart = page.indexOf("function WalletPolicyTab()");
    expect(tabStart).toBeGreaterThanOrEqual(0);
    const tabSource = page.slice(tabStart, page.indexOf("function WalletOpsTab()", tabStart));
    expect(tabSource).toContain("const { hasPermission } = useAuth();");
    expect(tabSource).toContain('canView={hasPermission("dropship", "view")}');
    expect(tabSource).toContain('canEdit={hasPermission("dropship", "manage_operations")}');
  });

  it("calls the wallet policy admin route and nothing else", () => {
    renderPanel({ overview: overviewFixture() });
    expect(vi.mocked(useQuery).mock.calls[0]![0]).toMatchObject({
      queryKey: ["/api/dropship/admin/wallet/policy"],
      enabled: true,
    });
    expect(modelSource).toContain(
      'export const DROPSHIP_WALLET_POLICY_ADMIN_URL = "/api/dropship/admin/wallet/policy";',
    );
    expect(modelSource).toContain('parameters.set(\n      "proposedAutoReloadMinTriggerCents",');
    expect(modelSource).toContain('parameters.set(\n      "proposedAutoReloadMinAmountCents",');
    expect(panelSource).toContain(
      "await postJson<unknown>(DROPSHIP_WALLET_POLICY_ADMIN_URL, body),",
    );
    // The proposal re-query is the same GET with the candidate minimums on it.
    expect(panelSource).toContain("buildDropshipWalletPolicyOverviewUrl(proposal)");
    const routes = panelSource.match(/"\/api\/[^"]*"/g) ?? [];
    expect(routes).toEqual([]);
  });

  it("shows no data at all without the dropship view permission", () => {
    const html = renderPanel({ canView: false, overview: overviewFixture() });
    expect(html).toContain(
      "The dropship view permission is required. No wallet policy data is shown.",
    );
    expect(html).not.toContain("Card funding fee");
    expect(html).not.toContain("7 of 19");
    expect(html).not.toContain("$100.00");
    expect(html).not.toContain("$500.00");
    expect(html).not.toContain("<input");
    expect(vi.mocked(useQuery).mock.calls[0]![0]).toMatchObject({ enabled: false });
  });

  it("disables every control without the manage-operations permission", () => {
    const html = renderPanel({ canEdit: false, overview: overviewFixture() });
    expect(html).toContain(
      "The dropship manage-operations permission is required to change these values.",
    );
    const inputs = tags(html, "input");
    const textareas = tags(html, "textarea");
    expect(inputs).toHaveLength(10);
    expect(textareas).toHaveLength(1);
    for (const element of [...inputs, ...textareas]) {
      expect(element).toMatch(DISABLED_ATTRIBUTE);
    }
    for (const button of tags(section(html, "wallet-policy-form"), "button")) {
      expect(button).toMatch(DISABLED_ATTRIBUTE);
    }
    expect(tags(html, "fieldset")[0]).toMatch(DISABLED_ATTRIBUTE);
  });

  it("opens the ten limit boxes for an operator who may manage operations", () => {
    const html = renderPanel({ canEdit: true, overview: overviewFixture() });
    const inputs = tags(html, "input");
    expect(inputs).toHaveLength(10);
    // The new limits are labelled in their own units, never as dollars.
    expect(html).toContain("Case tier minimum ($)");
    expect(html).toContain("Advance fee (%)");
    expect(html).toContain("Advance cap ($)");
    expect(html).toContain("Tier change grace (days)");
    for (const input of inputs) {
      expect(input).not.toMatch(DISABLED_ATTRIBUTE);
    }
    // Nothing is dirty on load, so publishing is not offered yet.
    expect(html).toContain("These values match the limits in force.");
  });

  it("prints the impact counts the server measured instead of computing them", () => {
    const impact = section(renderPanel({ overview: overviewFixture() }), "wallet-policy-impact");
    expect(impact).toContain("7 of 19");
    expect(impact).toContain("3 of 19");
    // The minimums the counts were measured against come from the payload, not
    // from the form: the fixture's limits in force are $100.00 and $100.00.
    expect(impact).toContain("$75.00");
    expect(impact).toContain("$250.00");
    expect(impact).not.toContain("$100.00");
    expect(impact).toContain("Saving does not change their stored settings.");
    expect(impact).toContain(
      "they are only asked to raise the value the next time they change their auto-reload settings themselves",
    );
    expect(panelSource).not.toMatch(/vendorsBelowMinimum\w*\s*[:=][^=]/);
  });

  it("keeps an in-flight or failed proposal measurement out of the way of publishing", () => {
    const impact = overviewFixture().impact;
    const measuring = renderToStaticMarkup(
      createElement(DropshipWalletPolicyImpactPanel, {
        impact,
        isMeasuringProposal: true,
        proposalError: null,
      }),
    );
    expect(measuring).toContain("Measuring the proposed minimums…");
    // The last counts the server returned stay on screen while a new
    // measurement is in flight, rather than blanking out.
    expect(measuring).toContain("7 of 19");

    const failed = renderToStaticMarkup(
      createElement(DropshipWalletPolicyImpactPanel, {
        impact,
        isMeasuringProposal: false,
        proposalError: "The proposed minimums could not be measured.",
      }),
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("This does not block publishing.");
    // Publishing is gated on the form, never on the impact query.
    expect(panelSource).toContain(
      "disabled={!canEdit || busy || !dirty || !parsed.success}",
    );
  });

  it("serves the card funding fee read-only, with no input and the server's reason", () => {
    const fee = section(renderPanel({ overview: overviewFixture() }), "wallet-policy-card-fee");
    expect(fee).toContain("2.90%");
    expect(fee).toContain("(290 bps)");
    expect(fee).toContain("DROPSHIP_CARD_FUNDING_FEE_BPS");
    expect(fee).toContain(
      "A vendor&#x27;s agreement to the card fee is recorded only in an audit payload, not on their settings row.",
    );
    expect(fee).not.toContain("<input");
    expect(fee).not.toContain("<textarea");
    expect(panelSource).not.toContain("cardFundingFeeBps");
    expect(panelSource).not.toMatch(/onChange=\{[^}]*bps/);
  });

  it("says where each value in force came from, including the schema default", () => {
    const html = renderPanel({ overview: overviewFixture() });
    expect(html).toContain("Environment fallback");
    expect(html).toContain("Environment variable DROPSHIP_AUTO_RELOAD_MIN_TRIGGER_CENTS");
    expect(html).toContain("Environment variable DROPSHIP_PAYMENT_HOLD_EXPIRING_WARNING_MINUTES");
    // The payment hold timeout, the case tier, the advance and the grace have
    // no environment variable; the page says so rather than inventing one.
    expect(html).toContain("Built-in default (no environment variable exists)");
    expect(html).not.toContain("Schema default");
    expect(html).toContain("No policy version has been published");
    expect(html).toContain("1,440 min");
    // Each new limit is printed in its own unit.
    expect(html).toContain("1.00%");
    expect(html).toContain("14 days");
  });

  it("names the published version and its author once a policy row exists", () => {
    const html = renderPanel({
      overview: overviewFixture({
        limitsSource: "policy",
        policy: {
          policyId: 9,
          version: 3,
          limits: overviewFixture().limits,
          isActive: true,
          changeNote: "Raised the floor after the November incident.",
          createdAt: "2026-09-19T12:00:00.000Z",
          createdBy: { actorType: "admin", actorId: "u-42" },
          deactivatedAt: null,
        },
      }),
    });
    expect(html).toContain("Policy version 3");
    expect(html).toContain("Published policy version");
    expect(html).toContain("admin u-42");
    expect(html).toContain("Raised the floor after the November incident.");
    expect(html).not.toContain("Environment fallback");
  });
});
