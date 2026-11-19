import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_STALE_PO_THRESHOLDS } from "@/features/purchasing/autoDraftSettingsValidation";

// Classic JSX transforms in child components compiled under Vitest's node environment expect React on globalThis.
(globalThis as { React?: typeof React }).React = React;

const authState = vi.hoisted(() => ({
  permissions: ["purchasing:view", "purchasing:edit", "inventory:adjust"] as string[],
}));

const linkState = vi.hoisted(() => ({
  capturedClicks: [] as Array<{ href: string; onClick?: () => void }>,
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    hasPermission: (resource: string, action: string) =>
      authState.permissions.includes(`${resource}:${action}`),
  }),
}));

vi.mock("@/components/ui/dialog", () => {
  const passthrough = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Dialog: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
      open ? createElement("div", { "data-testid": "planning-policy-dialog" }, children) : null,
    DialogContent: passthrough,
    DialogHeader: passthrough,
    DialogTitle: passthrough,
    DialogDescription: passthrough,
  };
});

vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return {
    ...actual,
    Link: ({
      href,
      onClick,
      className,
      children,
    }: {
      href: string;
      onClick?: () => void;
      className?: string;
      children?: ReactNode;
    }) => {
      linkState.capturedClicks.push({ href, onClick });
      return createElement("a", { href, className }, children);
    },
  };
});

import {
  ExclusionRulesModal,
  type PlanningPolicyTab,
} from "../../ExclusionRulesModal";
import {
  DEFAULT_FORECAST_POLICY,
  PLANNING_ADJUST_PERMISSION_MESSAGE,
  PLANNING_POLICY_TABS,
  mergeForecastPolicy,
  thresholdInputDefaults,
  validateForecastPolicyDraft,
  type AutoDraftSettings,
  type RulesData,
} from "../../planning-policy/planningPolicyTypes";

const readSource = (relativePath: string): string =>
  readFileSync(resolve(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");

function sampleSettings(): AutoDraftSettings {
  return {
    autoDraftMode: "draft_po",
    approvalPolicy: "high_confidence_only",
    includeOrderSoon: false,
    skipOnOpenPo: true,
    skipNoVendor: true,
    candidateScoreStrongThreshold: 80,
    candidateScoreReviewThreshold: 60,
    rfqDraftAutomationMode: "manual",
    rfqDraftMinimumConfidence: "high",
    rfqDraftRequireTrustedForecast: true,
    rfqDraftMaximumLinesPerRun: 100,
    stalePoThresholds: { ...DEFAULT_STALE_PO_THRESHOLDS },
    forecastPolicy: DEFAULT_FORECAST_POLICY,
  };
}

function sampleRules(): RulesData {
  return {
    totalExcluded: 14,
    rules: [
      {
        id: 7,
        field: "brand",
        value: "Vault Editions",
        matchCount: 14,
        createdAt: "2026-11-01T00:00:00.000Z",
      },
    ],
  };
}

function renderModal(options?: {
  open?: boolean;
  initialTab?: PlanningPolicyTab;
  onOpenChange?: (open: boolean) => void;
}): string {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  queryClient.setQueryData(["/api/purchasing/exclusion-rules"], sampleRules());
  queryClient.setQueryData(["/api/purchasing/auto-draft-settings"], sampleSettings());
  queryClient.setQueryData(["/api/purchasing/exclusion-rules/field-values", "category"], {
    field: "category",
    values: ["Supplies", "Apparel"],
  });

  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(Router, {
          ssrPath: "/reorder-analysis",
          children: createElement(ExclusionRulesModal, {
            open: options?.open ?? true,
            onOpenChange: options?.onOpenChange ?? vi.fn<(open: boolean) => void>(),
            initialTab: options?.initialTab,
          }),
        }),
      ),
    );
  } finally {
    queryClient.clear();
  }
}

describe("ExclusionRulesModal 4-tab planning policy decomposition", () => {
  beforeEach(() => {
    authState.permissions = ["purchasing:view", "purchasing:edit", "inventory:adjust"];
    linkState.capturedClicks = [];
  });

  it("defines the section filter tabs in canonical order and defaults to All Sections", () => {
    expect(PLANNING_POLICY_TABS).toEqual([
      { value: "all", label: "All Sections" },
      { value: "stock-targets", label: "Stock & Overrides" },
      { value: "exclusions", label: "Exclusions" },
      { value: "forecasting", label: "Forecasting" },
      { value: "automation", label: "Automation" },
    ]);

    const markup = renderModal();
    expect(markup).toContain("Purchasing Planning Policy");
    expect(markup).toContain("All Sections");
    expect(markup).toContain("Stock &amp; Overrides");
    expect(markup).toContain("Exclusions");
    expect(markup).toContain("Forecasting");
    expect(markup).toContain("Automation");
    expect(markup).toMatch(
      /role="tab"[^>]*aria-selected="true"[^>]*data-state="active"[^>]*>All Sections<\/button>/,
    );
    expect(markup).toContain("Loading stock and growth policy");
    expect(markup).toContain("Active Rules");
    expect(markup).toContain("Demand Forecast Policy");
    expect(markup).toContain("Downstream Priced-PO Automation");

    const stockOnlyMarkup = renderModal({ initialTab: "stock-targets" });
    expect(stockOnlyMarkup).toContain("Loading stock and growth policy");
    expect(stockOnlyMarkup).not.toContain("Downstream Priced-PO Automation");
    expect(stockOnlyMarkup).not.toContain("Demand Forecast Policy");
  });

  it("renders each isolated subsystem when selected via initialTab", () => {
    const exclusionsMarkup = renderModal({ initialTab: "exclusions" });
    expect(exclusionsMarkup).toContain("Active Rules");
    expect(exclusionsMarkup).toContain("1 rules · 14 products excluded");
    expect(exclusionsMarkup).toContain("Vault Editions");
    expect(exclusionsMarkup).toContain("Add Rule");
    expect(exclusionsMarkup).toContain("Per-Product Overrides");
    expect(exclusionsMarkup).not.toContain("Demand Forecast Policy");

    const forecastingMarkup = renderModal({ initialTab: "forecasting" });
    expect(forecastingMarkup).toContain("Demand Forecast Policy");
    expect(forecastingMarkup).toContain("Total: 100%");
    expect(forecastingMarkup).toContain("Future-demand overlays");
    expect(forecastingMarkup).toContain("Automation sample guardrail");
    expect(forecastingMarkup).toContain("Save forecast policy");
    expect(forecastingMarkup).not.toContain("Active Rules");

    const automationMarkup = renderModal({ initialTab: "automation" });
    expect(automationMarkup).toContain("RFQ Draft Automation");
    expect(automationMarkup).toContain("Downstream Priced-PO Automation");
    expect(automationMarkup).toContain("Candidate score thresholds");
    expect(automationMarkup).toContain("Stale PO aging thresholds");
    expect(automationMarkup).not.toContain("Active Rules");
  });

  it("links the Automation tab banner to /procurement/automation and closes the modal on click", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>();
    const markup = renderModal({ initialTab: "automation", onOpenChange });

    expect(markup).toContain('href="/procurement/automation"');
    expect(markup).toContain("/procurement/automation");

    const automationLink = linkState.capturedClicks.find(
      (entry) => entry.href === "/procurement/automation",
    );
    expect(automationLink).toBeDefined();
    automationLink?.onClick?.();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("gates exclusions, forecasting, and automation fieldsets on inventory:adjust while keeping navigation accessible", () => {
    authState.permissions = ["purchasing:view"];

    for (const tab of ["exclusions", "forecasting", "automation"] as const) {
      const markup = renderModal({ initialTab: tab });
      expect(markup).toContain(PLANNING_ADJUST_PERMISSION_MESSAGE);
      expect(markup).toMatch(/<fieldset[^>]*disabled=""/);
    }

    // Even without inventory:adjust, operators with read access can still follow the shortcut link
    const automationMarkup = renderModal({ initialTab: "automation" });
    expect(automationMarkup).toContain('href="/procurement/automation"');

    authState.permissions = ["purchasing:view", "inventory:adjust"];
    for (const tab of ["exclusions", "forecasting", "automation"] as const) {
      const markup = renderModal({ initialTab: tab });
      expect(markup).not.toContain(PLANNING_ADJUST_PERMISSION_MESSAGE);
      expect(markup).not.toMatch(/<fieldset[^>]*disabled=""/);
    }
  });

  it("decomposes ExclusionRulesModal into focused planning-policy sub-components while preserving threshold validation contracts", () => {
    const modalSource = readSource("client/src/components/purchasing/ExclusionRulesModal.tsx");
    const exclusionsSource = readSource(
      "client/src/components/purchasing/planning-policy/PurchasingExclusionRulesTab.tsx",
    );
    const forecastSource = readSource(
      "client/src/components/purchasing/planning-policy/PurchasingForecastPolicyTab.tsx",
    );
    const automationSource = readSource(
      "client/src/components/purchasing/planning-policy/PurchasingAutomationGuardrailsTab.tsx",
    );

    expect(modalSource).toContain('defaultValue="all"');
    expect(modalSource).toContain("PurchasePlanningPolicyEditor");
    expect(modalSource).toContain("PurchasingExclusionRulesTab");
    expect(modalSource).toContain("PurchasingForecastPolicyTab");
    expect(modalSource).toContain("PurchasingAutomationGuardrailsTab");
    expect(modalSource).toContain("validateCandidateScoreThresholds");
    expect(modalSource).toContain("validateStalePoThresholds");

    expect(exclusionsSource).toContain("FIELD_LABELS");
    expect(exclusionsSource).toContain("/api/purchasing/exclusion-rules/field-values");
    expect(forecastSource).toContain("Save forecast policy");
    expect(automationSource).toContain(
      '<Link\n          href="/procurement/automation"\n          onClick={() => onOpenChange(false)}',
    );
  });

  it("validates forecast policy weights, window ordering, and forward-demand confidence bands", () => {
    expect(validateForecastPolicyDraft(DEFAULT_FORECAST_POLICY)).toEqual({ ok: true });

    const invalidWeights = mergeForecastPolicy({
      weights: { short: 40, standard: 40, long: 20, seasonal: 15 },
    });
    expect(validateForecastPolicyDraft(invalidWeights)).toEqual({
      ok: false,
      error: {
        title: "Invalid forecast weights",
        description: "Short, standard, long, and seasonal weights must total 100.",
      },
    });

    const invalidWindows = mergeForecastPolicy({
      shortWindowDays: 45,
      standardWindowDays: 30,
      longWindowDays: 90,
    });
    expect(validateForecastPolicyDraft(invalidWindows)).toEqual({
      ok: false,
      error: {
        title: "Invalid forecast windows",
        description: "Window lengths must run from short to standard to long.",
      },
    });

    const invalidConfidence = mergeForecastPolicy({
      forwardDemandConfidenceWeights: { high: 60, medium: 80, low: 40 },
    });
    expect(validateForecastPolicyDraft(invalidConfidence)).toEqual({
      ok: false,
      error: {
        title: "Invalid confidence weights",
        description: "High must be at least medium, and medium at least low.",
      },
    });

    expect(thresholdInputDefaults().reviewPendingWarningDays).toBe("2");
  });
});
