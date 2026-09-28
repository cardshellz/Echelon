import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_DROPSHIP_COST_CHANGE_POLICY } from "@shared/dropship/cost-change-policy";
import {
  DropshipCostChangeEnforcementPanel,
  DropshipCostChangePolicyPanel,
} from "../dropship-cost-change-policy-panel";
import {
  DROPSHIP_COST_CHANGE_TODAY_SUMMARY,
  type DropshipCostChangePolicyOverview,
  type DropshipCostChangePolicyRecordView,
} from "../dropship-cost-change-policy-model";

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

const defaults = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };

const staffSettings = {
  ...defaults,
  increaseNoticeDays: 21,
  notifyOnDecrease: false,
  noticeMinimumChangeCents: 25,
};

const seed: DropshipCostChangePolicyRecordView = {
  policyId: 1,
  version: 1,
  settings: defaults,
  isActive: true,
  changeNote: "Initial defaults from migration 0710. Confirm or change them in Dropship, Cost changes.",
  createdAt: "2026-09-27T10:00:00.000Z",
  createdBy: { actorType: "system", actorId: "migration:0710" },
  deactivatedAt: null,
};

const staffVersion: DropshipCostChangePolicyRecordView = {
  policyId: 2,
  version: 2,
  settings: staffSettings,
  isActive: true,
  changeNote: "Three weeks for the holiday catalog.",
  createdAt: "2026-09-28T10:00:00.000Z",
  createdBy: { actorType: "admin", actorId: "admin-1" },
  deactivatedAt: null,
};

const noneLive = { detection: false, priceProtection: false, vendorNotices: false, listingActions: false };

function seededOverview(): DropshipCostChangePolicyOverview {
  return {
    policy: seed,
    settings: defaults,
    settingsSource: "policy",
    defaults,
    versions: [seed],
    enforcement: noneLive,
    generatedAt: "2026-09-27T10:05:00.000Z",
  };
}

function staffOverview(): DropshipCostChangePolicyOverview {
  return {
    ...seededOverview(),
    policy: staffVersion,
    settings: staffSettings,
    versions: [staffVersion, { ...seed, isActive: false, deactivatedAt: "2026-09-28T10:00:00.000Z" }],
  };
}

function renderPanel(options: {
  canView?: boolean;
  canEdit?: boolean;
  overview?: DropshipCostChangePolicyOverview;
  overviewState?: Record<string, unknown>;
} = {}): string {
  queries.states = [{ data: options.overview, ...options.overviewState }];
  queries.index = 0;
  return renderToStaticMarkup(
    createElement(DropshipCostChangePolicyPanel, {
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

const page = readFileSync(join(process.cwd(), "client", "src", "pages", "Dropship.tsx"), "utf8");
const shell = readFileSync(join(process.cwd(), "client", "src", "components", "layout", "AppShell.tsx"), "utf8");
const panelSource = readFileSync(
  join(process.cwd(), "client", "src", "pages", "dropship-cost-change-policy-panel.tsx"),
  "utf8",
);
const modelSource = readFileSync(
  join(process.cwd(), "client", "src", "pages", "dropship-cost-change-policy-model.ts"),
  "utf8",
);

describe("dropship cost changes tab", () => {
  it("is a tab on the dropship ops page, reachable from the sidebar", () => {
    expect(page).toContain('| "cost-changes"');
    expect(page).toContain('  "cost-changes",');
    expect(page).toContain('<TabsContent value="cost-changes" className="m-0">');
    expect(page).toContain("<CostChangePolicyTab />");
    expect(shell).toContain('{ label: "Cost Changes", icon: TrendingUp, href: "/dropship?tab=cost-changes" },');
  });

  it("gates the tab on the two dropship permissions the routes enforce, not on the page role", () => {
    const tabStart = page.indexOf("function CostChangePolicyTab()");
    expect(tabStart).toBeGreaterThanOrEqual(0);
    const tabSource = page.slice(tabStart, page.indexOf("\n}\n", tabStart));
    expect(tabSource).toContain("const { hasPermission } = useAuth();");
    expect(tabSource).toContain('canView={hasPermission("dropship", "view")}');
    expect(tabSource).toContain('canEdit={hasPermission("dropship", "manage_operations")}');
  });

  it("calls the cost change policy admin route and nothing else", () => {
    renderPanel({ overview: seededOverview() });
    expect(vi.mocked(useQuery).mock.calls[0]![0]).toMatchObject({
      queryKey: ["/api/dropship/admin/cost-changes/policy"],
      enabled: true,
    });
    expect(modelSource).toContain(
      'export const DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL = "/api/dropship/admin/cost-changes/policy";',
    );
    expect(panelSource).toContain("await postJson<unknown>(DROPSHIP_COST_CHANGE_POLICY_ADMIN_URL, body),");
    expect(panelSource.match(/"\/api\/[^"]*"/g) ?? []).toEqual([]);
  });

  it("shows no data at all without the dropship view permission", () => {
    const html = renderPanel({ canView: false, overview: staffOverview() });
    expect(html).toContain("The dropship view permission is required. No cost change policy data is shown.");
    expect(html).not.toContain("21 days");
    expect(html).not.toContain("Three weeks for the holiday catalog.");
    expect(html).not.toContain("<input");
    expect(vi.mocked(useQuery).mock.calls[0]![0]).toMatchObject({ enabled: false });
  });

  it("says a failed read failed, and renders no settings", () => {
    const html = renderPanel({
      overviewState: { isError: true, error: new Error("Request failed with 503") },
    });
    expect(html).toContain("Request failed with 503");
    expect(html).not.toContain("Settings in force");
  });

  it("says what happens today while no part is live, and marks every setting not live", () => {
    const html = renderPanel({ overview: seededOverview() });
    const enforcement = section(html, "cost-change-policy-enforcement");
    expect(enforcement).toContain(DROPSHIP_COST_CHANGE_TODAY_SUMMARY);
    expect(enforcement.match(/Not live yet/g)).toHaveLength(4);
    const inForce = section(html, "cost-change-policy-in-force");
    expect(inForce.match(/Not yet/g)).toHaveLength(12);
    expect(section(html, "cost-change-policy-form").match(/\(not live yet\)/g)).toHaveLength(12);
  });

  it("drops the today summary once every part is live", () => {
    const html = renderToStaticMarkup(createElement(DropshipCostChangeEnforcementPanel, {
      enforcement: { detection: true, priceProtection: true, vendorNotices: true, listingActions: true },
    }));
    expect(html).not.toContain(DROPSHIP_COST_CHANGE_TODAY_SUMMARY);
    expect(html.match(/>Live</g)).toHaveLength(4);
  });

  it("shows the settings in force with their defaults and who published them", () => {
    const inForce = section(renderPanel({ overview: staffOverview() }), "cost-change-policy-in-force");
    expect(inForce).toContain("Version 2");
    expect(inForce).toContain("Staff user admin-1");
    expect(inForce).toContain("Three weeks for the holiday catalog.");
    expect(inForce).toContain("21 days");
    expect(inForce).toContain("14 days");
    expect(inForce).toContain("$0.25");
    expect(inForce).toContain("No minimum");
  });

  it("says the defaults apply when no version exists", () => {
    const html = renderPanel({
      overview: { ...seededOverview(), policy: null, settingsSource: "defaults", versions: [] },
    });
    expect(section(html, "cost-change-policy-in-force")).toContain(
      "No version has been published, so the defaults below apply. Publishing a version records them.",
    );
    expect(section(html, "cost-change-policy-history")).toContain("No version has been published yet.");
  });

  it("disables every control without the manage-operations permission", () => {
    const html = renderPanel({ canEdit: false, overview: staffOverview() });
    const form = section(html, "cost-change-policy-form");
    expect(form).toContain("The dropship manage-operations permission is required to change these settings.");
    expect(tags(form, "fieldset")[0]).toMatch(DISABLED_ATTRIBUTE);
    const controls = [...tags(form, "input"), ...tags(form, "textarea"), ...tags(form, "button")];
    // Radix renders a hidden input behind each switch and radio for native
    // forms; those are disabled too, but only the visible controls are counted:
    // 4 boxes + 1 note, 5 switches + 7 radio choices, and 2 action buttons.
    const visible = controls.filter((control) => !control.includes('aria-hidden="true"'));
    expect(visible).toHaveLength(19);
    for (const control of controls) {
      expect(control).toMatch(DISABLED_ATTRIBUTE);
    }
    expect(form).not.toContain('data-testid="cost-change-policy-publish-hint"');
  });

  it("opens every setting to an operator who may manage operations, grouped as staff think of them", () => {
    const form = section(renderPanel({ overview: staffOverview() }), "cost-change-policy-form");
    for (const input of tags(form, "input")) expect(input).not.toMatch(DISABLED_ATTRIBUTE);
    for (const title of ["Notice and charging", "Who is told", "Listings when a new cost takes effect", "Checking for changes"]) {
      expect(form).toContain(title);
    }
    expect(form).toContain("Notice before a higher cost is charged (days)");
    expect(form).toContain("Skip notices for changes under ($ per unit)");
    expect(form).toContain("Check live costs every (minutes)");
    expect(form).toMatch(/id="cost-change-policy-increaseNoticeDays"[^>]*value="21"|value="21"[^>]*id="cost-change-policy-increaseNoticeDays"/);
    expect(form).toMatch(/role="switch"[^>]*aria-checked="false"[^>]*id="cost-change-policy-notifyOnDecrease"|id="cost-change-policy-notifyOnDecrease"[^>]*aria-checked="false"/);
    expect(form).toContain("Pause the listing");
  });

  it("offers nothing to publish while a staff version is in force unchanged", () => {
    const form = section(renderPanel({ overview: staffOverview() }), "cost-change-policy-form");
    const publish = tags(form, "button").find((button) => button.includes('data-testid="cost-change-policy-publish"'));
    expect(publish).toMatch(DISABLED_ATTRIBUTE);
    expect(form).toContain("These settings match the version in force.");
    expect(form).toContain("Publish new version");
  });

  it("asks staff to confirm the migration's seed, once a note says why", () => {
    const form = section(renderPanel({ overview: seededOverview() }), "cost-change-policy-form");
    expect(form).toContain("No one on staff has approved these settings yet.");
    expect(form).toContain("Confirm these settings");
    expect(form).toContain("Add a change note to publish.");
    const publish = tags(form, "button").find((button) => button.includes('data-testid="cost-change-policy-publish"'));
    expect(publish).toMatch(DISABLED_ATTRIBUTE);
  });

  it("lists every version with what it changed and whether it is in force", () => {
    const history = section(renderPanel({ overview: staffOverview() }), "cost-change-policy-history");
    expect(history).toContain("System (migration:0710)");
    expect(history).toContain("First version");
    expect(history).toContain("Notice before a higher cost is charged: 14 days → 21 days");
    expect(history).toContain("Also tell vendors when a cost goes down: On → Off");
    expect(history).toContain("Skip notices for changes under: No minimum → $0.25");
    expect(history).toContain("In force");
    expect(history).toContain("Retired");
  });
});
