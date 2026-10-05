/**
 * Dropship "Program finance" tab (/dropship?tab=finance) — the rollup page,
 * part 1 (design spec finance-spec.md §2–§3.4, §5–§8, §12).
 *
 * One calm answer first ("What we kept"), one bar for where each $1 we
 * billed went, four tiles, then nine quiet detail rows that open in place.
 * Every number comes from GET /api/dropship/admin/finance/summary, validated
 * by the shared contract; this component renders and navigates. What the
 * URL means, how a number is written and what each part shows live in
 * `dropship-finance-model.ts`.
 *
 * State lives in the URL (period, compare, vendor, open rows, depth, the How
 * drawer), with open rows and depth also remembered per viewer. A period,
 * compare or vendor change is a new query and blanks to skeletons, so old
 * numbers never sit under a new label; the header Refresh keeps the numbers
 * and the bar says "Refreshing…" (spec §7).
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FINANCE_SECTION_KEYS, type FinanceLineKey, type FinanceSummary } from "@shared/dropship/program-finance";
import {
  FINANCE_PAGE_TITLE,
  FINANCE_PERMISSION_TEXT,
  buildFinanceAnswerView,
  buildFinanceChecksRow,
  buildFinanceChecksView,
  buildFinanceCountingView,
  buildFinanceDetailGroups,
  buildFinanceHowView,
  buildFinancePageError,
  buildFinancePeriodBarView,
  buildFinanceProductsTable,
  buildFinanceSectionRow,
  buildFinanceTilesView,
  buildFinanceVendorsTable,
  fetchFinanceSummary,
  financeDetailTitle,
  financePeriodWords,
  financeQueryRetry,
  financeQueryRetryDelay,
  financeRequestedPeriodText,
  financeSummaryQueryKey,
  financeSummaryScope,
  financeTodayInEastern,
  financeUpdatedAnnouncement,
  financeUrlHref,
  financeViewStorage,
  readFinanceUrlState,
  readFinanceViewMemory,
  resolveFinanceView,
  writeFinanceViewMemory,
  type FinanceDepth,
  type FinanceDetailKey,
  type FinanceDetailRowView,
  type FinancePageErrorView,
  type FinanceUrlState,
  type FinanceViewMemory,
} from "./dropship-finance-model";
import { FinanceAnswerCard, FinanceAnswerSkeleton, FinanceTiles, FinanceTilesSkeleton } from "./dropship-finance/finance-answer";
import { FinanceDetail, FinanceDetailSkeleton } from "./dropship-finance/finance-detail";
import { FINANCE_PERIOD_BAR_ID, FinancePeriodBar, FinanceTwoClocksLine } from "./dropship-finance/finance-period-bar";
import { FinanceCountingSheet, FinanceHowSheet } from "./dropship-finance/finance-sheets";

/** The registry does not change while the page is open, so the sheet's content is built once. */
const COUNTING_VIEW = buildFinanceCountingView();
/** The id the checks chip scrolls to (the Checks detail row). */
const CHECKS_ROW_ID = "finance-detail-checks";
/** Space left between the sticky period bar and a row the page scrolls to. */
const SCROLL_GAP_PX = 16;

/**
 * Brings a detail row to the top of whatever scrolls the page (the window
 * here, the Dropship page's own scroll area in the app), just under the
 * sticky period bar. The bar wraps to two or three lines on a phone, so the
 * room it needs is measured each time rather than fixed in CSS.
 */
function scrollRowUnderPeriodBar(rowId: string): void {
  const row = document.getElementById(rowId);
  if (!row) return;
  const barHeight = document.getElementById(FINANCE_PERIOD_BAR_ID)?.getBoundingClientRect().height ?? 0;
  row.style.scrollMarginTop = `${Math.ceil(barHeight) + SCROLL_GAP_PX}px`;
  row.scrollIntoView({ block: "start" });
}

export interface DropshipFinancePanelProps {
  /** `dropship:manage_operations`, the permission every finance route requires (spec §1.1). */
  readonly canView: boolean;
  /** Injected for tests; only the custom-date picker reads it, to grey out future days. */
  readonly clock?: () => Date;
}

const systemClock = () => new Date();

export function DropshipFinancePanel({ canView, clock = systemClock }: DropshipFinancePanelProps) {
  const search = useSearch();
  const [, navigate] = useLocation();
  const { state, dropped } = useMemo(() => readFinanceUrlState(search), [search]);
  const [memory, setMemory] = useState<FinanceViewMemory | null>(() => readFinanceViewMemory(financeViewStorage()));
  const [countingOpen, setCountingOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const view = resolveFinanceView(state, memory);
  const scope = financeSummaryScope(state);

  const query = useQuery<FinanceSummary>({
    queryKey: financeSummaryQueryKey(scope),
    queryFn: ({ signal }) => fetchFinanceSummary(scope, { signal }),
    enabled: canView,
    retry: financeQueryRetry,
    retryDelay: financeQueryRetryDelay,
    // The page shows its own error card; the shell's generic data-health banner stays out of it.
    meta: { handlesLoadError: true },
  });
  // A disabled query can still hold cached numbers from before a permission
  // change, and a failed refresh must not leave old numbers on screen
  // (spec §7): the permission and the error decide, not the cache.
  const summary = canView && !query.isError ? query.data ?? null : null;
  const refreshing = summary !== null && query.isFetching;
  const howView = summary !== null && state.how !== null ? buildFinanceHowView(summary, state.how) : null;

  function go(patch: Partial<FinanceUrlState>, mode: "push" | "replace" = "replace") {
    navigate(financeUrlHref({ ...state, ...patch }), { replace: mode === "replace" });
  }

  // An invalid or unknown URL value is dropped and the URL rewritten in place (spec §5).
  useEffect(() => {
    if (dropped.length > 0) navigate(financeUrlHref(state), { replace: true });
  }, [dropped, navigate, state]);

  // A drawer for a figure the loaded summary has no workings for closes.
  useEffect(() => {
    if (summary !== null && state.how !== null && howView === null) {
      navigate(financeUrlHref({ ...state, how: null }), { replace: true });
    }
  }, [summary, howView, navigate, state]);

  // Cleared while numbers load or fail, so the region never names a period whose numbers are gone (spec §7).
  useEffect(() => {
    setAnnouncement(summary !== null ? financeUpdatedAnnouncement(summary) : "");
  }, [summary]);

  // The checks chip asked for the Checks row: once it has opened, bring it into view.
  const checksScrollPending = useRef(false);
  const checksOpen = view.open.includes("checks");
  useEffect(() => {
    if (!checksScrollPending.current || !checksOpen || summary === null) return;
    checksScrollPending.current = false;
    const row = document.getElementById(CHECKS_ROW_ID);
    if (!row) return;
    const scroll = () => scrollRowUnderPeriodBar(CHECKS_ROW_ID);
    scroll();
    // The row opens with a short height animation, and until it ends the page can be too short to
    // bring the row up; it is scrolled to once more when the animation ends (none with reduced motion).
    row.addEventListener("animationend", scroll, { once: true });
    return () => row.removeEventListener("animationend", scroll);
  }, [checksOpen, summary]);

  function changeView(next: { open?: readonly FinanceDetailKey[]; depth?: FinanceDepth }) {
    const resolved: FinanceViewMemory = { open: next.open ?? view.open, depth: next.depth ?? view.depth };
    writeFinanceViewMemory(financeViewStorage(), resolved);
    setMemory(resolved);
    go({ open: resolved.open.length > 0 ? resolved.open : null, depth: resolved.depth === "every_line" ? "every_line" : null });
  }

  function openChecks() {
    // An open row already has its full height; a closed one is scrolled to by the effect above once it opens.
    if (checksOpen) {
      scrollRowUnderPeriodBar(CHECKS_ROW_ID);
      return;
    }
    checksScrollPending.current = true;
    changeView({ open: [...view.open, "checks"] });
  }

  const actions: FinancePageActions = {
    onOpenHow: (key) => go({ how: key }, "push"),
    onOpenChecks: openChecks,
    onScopeVendor: (vendorId) => go({ vendorId, how: null }, "push"),
    onOpenChange: (open) => changeView({ open }),
    onDepthChange: (depth) => changeView({ depth }),
    onRetry: () => void query.refetch(),
  };

  if (!canView) return <PermissionCard />;

  const periodBar = buildFinancePeriodBarView(state, summary, { refreshing });
  const pageError = query.isError ? buildFinancePageError(query.error, financeRequestedPeriodText(state)) : null;

  return (
    <div className="space-y-6" data-testid="finance-page">
      <div aria-live="polite" className="sr-only" data-testid="finance-announcement">
        {announcement}
      </div>
      <FinancePeriodBar
        view={periodBar}
        state={state}
        todayEastern={financeTodayInEastern(clock())}
        onPreset={(preset) => go({ period: preset, from: null, to: null, how: null })}
        onCustomRange={(from, to) => go({ period: "custom", from, to, how: null })}
        onCompare={(compare) => go({ compare })}
        onRemoveVendor={() => go({ vendorId: null, how: null })}
        onOpenChecks={openChecks}
        onOpenCounting={() => setCountingOpen(true)}
      />
      <FinanceTwoClocksLine notes={periodBar.notes} onOpenCounting={() => setCountingOpen(true)} />
      {pageError ? (
        <FinancePageError error={pageError} onRetry={actions.onRetry} />
      ) : summary ? (
        <FinanceLoaded summary={summary} vendorScoped={state.vendorId !== null} open={view.open} depth={view.depth} actions={actions} />
      ) : (
        <FinanceLoading vendorScoped={state.vendorId !== null} />
      )}
      <FinanceHowSheet view={howView} onClose={() => go({ how: null })} />
      <FinanceCountingSheet open={countingOpen} view={COUNTING_VIEW} onOpenChange={setCountingOpen} />
    </div>
  );
}

interface FinancePageActions {
  readonly onOpenHow: (key: FinanceLineKey) => void;
  readonly onOpenChecks: () => void;
  readonly onScopeVendor: (vendorId: number) => void;
  readonly onOpenChange: (open: FinanceDetailKey[]) => void;
  readonly onDepthChange: (depth: FinanceDepth) => void;
  readonly onRetry: () => void;
}

function FinanceLoaded({
  summary,
  vendorScoped,
  open,
  depth,
  actions,
}: {
  summary: FinanceSummary;
  /** The URL asks for one vendor; the server's scope says the same once it has answered. */
  vendorScoped: boolean;
  open: readonly FinanceDetailKey[];
  depth: FinanceDepth;
  actions: FinancePageActions;
}) {
  const answer = useMemo(() => buildFinanceAnswerView(summary), [summary]);
  const tiles = useMemo(() => buildFinanceTilesView(summary), [summary]);
  const checks = useMemo(() => buildFinanceChecksView(summary), [summary]);
  const products = useMemo(() => buildFinanceProductsTable(summary), [summary]);
  const vendors = useMemo(() => buildFinanceVendorsTable(summary), [summary]);
  const rows = useMemo(() => {
    const built: Partial<Record<FinanceDetailKey, FinanceDetailRowView>> = { checks: buildFinanceChecksRow(summary) };
    for (const key of FINANCE_SECTION_KEYS) built[key] = buildFinanceSectionRow(summary, key, depth);
    return built;
  }, [summary, depth]);
  const groups = buildFinanceDetailGroups(financePeriodWords(summary.period), vendorScoped || summary.scope.vendor !== null);

  return (
    <>
      <FinanceAnswerCard view={answer} onOpenHow={() => actions.onOpenHow("answer.kept")} onOpenChecks={actions.onOpenChecks} onRetry={actions.onRetry} />
      <FinanceTiles tiles={tiles} onOpenChecks={actions.onOpenChecks} />
      <FinanceDetail
        groups={groups}
        rows={rows}
        products={products}
        vendors={vendors}
        checks={checks}
        open={open}
        depth={depth}
        onOpenChange={actions.onOpenChange}
        onDepthChange={actions.onDepthChange}
        onOpenHow={actions.onOpenHow}
        onOpenChecks={actions.onOpenChecks}
        onScopeVendor={actions.onScopeVendor}
        onRetry={actions.onRetry}
      />
    </>
  );
}

/** First load: the hero, bar and tiles at their final heights, the rows with their real titles (spec §7). */
function FinanceLoading({ vendorScoped }: { vendorScoped: boolean }) {
  return (
    <div className="space-y-6" data-testid="finance-loading">
      <FinanceAnswerSkeleton />
      <FinanceTilesSkeleton />
      <FinanceDetailSkeleton groups={buildFinanceDetailGroups(null, vendorScoped)} titles={financeDetailTitle} />
    </div>
  );
}

/**
 * The whole request failed (spec §7): nothing is shown, so older numbers
 * cannot be mistaken for current ones. A bad period is a plain inline note;
 * a load failure is the one place the destructive colour is used.
 */
function FinancePageError({ error, onRetry }: { error: FinancePageErrorView; onRetry: () => void }) {
  if (error.kind === "permission") return <PermissionCard />;
  return (
    <Alert variant={error.kind === "invalid_period" ? "default" : "destructive"} data-testid="finance-page-error">
      <AlertCircle className="h-4 w-4" />
      <AlertDescription className="space-y-2">
        <p>{error.text}</p>
        {error.canRetry ? (
          <Button size="sm" variant="outline" data-finance-action="retry" onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

function PermissionCard() {
  return (
    <section className="rounded-md border bg-card p-5" data-testid="finance-permission-required">
      <h2 className="text-lg font-semibold">{FINANCE_PAGE_TITLE}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{FINANCE_PERMISSION_TEXT}</p>
    </section>
  );
}
