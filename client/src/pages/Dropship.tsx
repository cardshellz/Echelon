import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, RefreshCw, ShieldAlert } from "lucide-react";
import { useLocation, useSearch } from "wouter";
import { legacyDropshipReturnDestination } from "@/lib/returns-admin-navigation";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  fetchJson,
  formatDateTime,
  type DropshipAdminOpsOverviewResponse,
  type DropshipAuditEventSearchResponse,
} from "@/lib/dropship-ops-surface";
import { useAuth } from "@/lib/auth";
import { loadChunkWithRetry } from "@/lib/chunk-loading";
import { DropshipWalletPolicyPanel } from "./dropship-wallet-policy-panel";
import { DropshipCostChangePolicyPanel } from "./dropship-cost-change-policy-panel";
import { DropshipFinancePanel } from "./dropship-finance-panel";
import { refreshFinanceQueries } from "./dropship-finance-model";
import {
  EmptyState,
  OverviewSkeleton,
  errorMessage,
  type AuditSeverityFilter,
  type DropshipOpsSearchSignal,
} from "./dropship-admin/dropship-admin-shared";
import {
  AuditEventsTab,
  OverviewTab,
} from "./dropship-admin/OverviewAndAuditTabs";

const DogfoodReadinessTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/DogfoodReadinessTab")),
);
const CatalogExposureTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/CatalogExposureTab")),
);
const ShippingConfigTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/ShippingConfigTab")),
);
const OrderIntakeOpsTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/OrderIntakeOpsTab")),
);
const LazyWalletOpsTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/WalletOpsTab")),
);
const StoreConnectionOpsTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/StoreConnectionOpsTab")),
);
const ListingPushOpsTab = lazy(() =>
  loadChunkWithRetry(() => import("./dropship-admin/ListingPushOpsTab")),
);
const TrackingPushOpsTab = lazy(() =>
  loadChunkWithRetry(() =>
    import("./dropship-admin/TrackingAndNotificationOpsTabs").then((m) => ({
      default: m.TrackingPushOpsTab,
    })),
  ),
);
const NotificationOpsTab = lazy(() =>
  loadChunkWithRetry(() =>
    import("./dropship-admin/TrackingAndNotificationOpsTabs").then((m) => ({
      default: m.NotificationOpsTab,
    })),
  ),
);

type DropshipOpsTabValue =
  | "overview"
  | "dogfood"
  | "catalog"
  | "shipping"
  | "order-intake"
  | "wallet-ops"
  | "wallet-policy"
  | "finance"
  | "cost-changes"
  | "stores"
  | "listing-pushes"
  | "tracking-pushes"
  | "notifications"
  | "audit";

const dropshipOpsTabValues = new Set<DropshipOpsTabValue>([
  "overview",
  "dogfood",
  "catalog",
  "shipping",
  "order-intake",
  "wallet-ops",
  "wallet-policy",
  "finance",
  "cost-changes",
  "stores",
  "listing-pushes",
  "tracking-pushes",
  "notifications",
  "audit",
]);

function isDropshipOpsTabValue(
  value: string | null,
): value is DropshipOpsTabValue {
  return (
    value !== null && dropshipOpsTabValues.has(value as DropshipOpsTabValue)
  );
}

function parseDropshipOpsTab(searchString: string): DropshipOpsTabValue {
  const normalizedSearch = searchString.startsWith("?")
    ? searchString.slice(1)
    : searchString;
  const tab = new URLSearchParams(normalizedSearch).get("tab");
  return isDropshipOpsTabValue(tab) ? tab : "overview";
}

function buildDropshipTabHref(tab: DropshipOpsTabValue): string {
  return `/dropship?tab=${encodeURIComponent(tab)}`;
}

export default function Dropship() {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const searchString = useSearch();
  const locationTab = useMemo(
    () => parseDropshipOpsTab(searchString),
    [searchString],
  );
  const [activeTab, setActiveTab] = useState<DropshipOpsTabValue>(locationTab);
  const [opsSearchSignal, setOpsSearchSignal] =
    useState<DropshipOpsSearchSignal | null>(null);
  const [auditSearch, setAuditSearch] = useState("");
  const [auditSeverity, setAuditSeverity] =
    useState<AuditSeverityFilter>("all");
  const [appliedAuditFilters, setAppliedAuditFilters] = useState({
    search: "",
    severity: "all" as AuditSeverityFilter,
  });

  const auditUrl = useMemo(() => {
    const params = new URLSearchParams({ page: "1", limit: "25" });
    if (appliedAuditFilters.search.trim())
      params.set("search", appliedAuditFilters.search.trim());
    if (appliedAuditFilters.severity !== "all")
      params.set("severity", appliedAuditFilters.severity);
    return `/api/dropship/admin/audit-events?${params.toString()}`;
  }, [appliedAuditFilters]);

  const overviewQuery = useQuery<DropshipAdminOpsOverviewResponse>({
    queryKey: ["/api/dropship/admin/ops/overview"],
    queryFn: () =>
      fetchJson<DropshipAdminOpsOverviewResponse>(
        "/api/dropship/admin/ops/overview",
      ),
  });
  const auditQuery = useQuery<DropshipAuditEventSearchResponse>({
    queryKey: [auditUrl],
    queryFn: () => fetchJson<DropshipAuditEventSearchResponse>(auditUrl),
  });

  const overview = overviewQuery.data?.overview;

  useEffect(() => {
    setActiveTab(locationTab);
  }, [locationTab]);

  useEffect(() => {
    const destination = legacyDropshipReturnDestination(searchString);
    if (destination) navigate(destination, { replace: true });
  }, [navigate, searchString]);

  function applyAuditFilters() {
    setAppliedAuditFilters({
      search: auditSearch,
      severity: auditSeverity,
    });
  }

  function refreshAll() {
    void overviewQuery.refetch();
    void auditQuery.refetch();
    // The finance tab has no Refresh of its own: the header button refetches
    // the summary on screen, keeping its numbers up while it runs, and marks
    // the other cached periods stale.
    if (activeTab === "finance") {
      void refreshFinanceQueries(queryClient);
    }
  }

  function openSmokeOpsSearch(input: Omit<DropshipOpsSearchSignal, "nonce">) {
    setOpsSearchSignal({ ...input, nonce: Date.now() });
    setActiveTab(input.tab);
    navigate(buildDropshipTabHref(input.tab));
  }

  function selectTab(value: string) {
    const nextTab = isDropshipOpsTabValue(value) ? value : "overview";
    setActiveTab(nextTab);
    navigate(buildDropshipTabHref(nextTab));
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="border-b bg-card px-4 py-5 md:px-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h1
              className="flex items-center gap-2 text-2xl font-bold tracking-normal"
              data-testid="text-page-title"
            >
              <ShieldAlert className="h-6 w-6 text-[#C060E0]" />
              Dropship Ops
            </h1>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Monitor .ops setup blockers, store health, order intake
              exceptions, listing pushes, tracking pushes, notifications, and
              audit history.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {overview && (
              <Badge variant="outline" className="h-9 px-3">
                Updated {formatDateTime(overview.generatedAt)}
              </Badge>
            )}
            <Button
              variant="outline"
              className="h-9 gap-2"
              disabled={overviewQuery.isFetching || auditQuery.isFetching}
              onClick={refreshAll}
            >
              <RefreshCw
                className={
                  overviewQuery.isFetching || auditQuery.isFetching
                    ? "h-4 w-4 animate-spin"
                    : "h-4 w-4"
                }
              />
              Refresh
            </Button>
          </div>
        </div>

        {(overviewQuery.error || auditQuery.error) && (
          <Alert variant="destructive" className="mt-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {errorMessage(overviewQuery.error ?? auditQuery.error)}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <div className="flex-1 overflow-auto p-4 md:p-6">
        <Tabs
          value={activeTab}
          onValueChange={selectTab}
          className="flex min-h-0 flex-1 flex-col"
        >
          <Suspense fallback={<OverviewSkeleton />}>
            <TabsContent value="overview" className="m-0 space-y-5">
              {overviewQuery.isLoading ? (
                <OverviewSkeleton />
              ) : overview ? (
                <OverviewTab overview={overview} />
              ) : (
                <EmptyState
                  title="No ops data"
                  description="The dropship ops overview did not return any data."
                />
              )}
            </TabsContent>

            <TabsContent value="dogfood" className="m-0">
              <DogfoodReadinessTab onOpenSmokeOpsSearch={openSmokeOpsSearch} />
            </TabsContent>

            <TabsContent value="catalog" className="m-0">
              <CatalogExposureTab />
            </TabsContent>

            <TabsContent value="shipping" className="m-0">
              <ShippingConfigTab />
            </TabsContent>

            <TabsContent value="order-intake" className="m-0">
              <OrderIntakeOpsTab
                searchSignal={
                  opsSearchSignal?.tab === "order-intake"
                    ? opsSearchSignal
                    : null
                }
              />
            </TabsContent>

            <TabsContent value="wallet-ops" className="m-0">
              <WalletOpsTab />
            </TabsContent>

            <TabsContent value="wallet-policy" className="m-0">
              <WalletPolicyTab />
            </TabsContent>

            <TabsContent value="finance" className="m-0">
              <ProgramFinanceTab />
            </TabsContent>

            <TabsContent value="cost-changes" className="m-0">
              <CostChangePolicyTab />
            </TabsContent>

            <TabsContent value="stores" className="m-0">
              <StoreConnectionOpsTab />
            </TabsContent>

            <TabsContent value="listing-pushes" className="m-0">
              <ListingPushOpsTab
                searchSignal={
                  opsSearchSignal?.tab === "listing-pushes"
                    ? opsSearchSignal
                    : null
                }
              />
            </TabsContent>

            <TabsContent value="tracking-pushes" className="m-0">
              <TrackingPushOpsTab
                searchSignal={
                  opsSearchSignal?.tab === "tracking-pushes"
                    ? opsSearchSignal
                    : null
                }
              />
            </TabsContent>

            <TabsContent value="notifications" className="m-0">
              <NotificationOpsTab />
            </TabsContent>

            <TabsContent value="audit" className="m-0 space-y-4">
              <AuditEventsTab
                auditSearch={auditSearch}
                auditSeverity={auditSeverity}
                events={auditQuery.data?.items ?? []}
                isLoading={auditQuery.isLoading || auditQuery.isFetching}
                onApply={applyAuditFilters}
                onSearchChange={setAuditSearch}
                onSeverityChange={setAuditSeverity}
                total={auditQuery.data?.total ?? 0}
              />
            </TabsContent>
          </Suspense>
        </Tabs>
      </div>
    </div>
  );
}

/**
 * Program finance tab: the program-level money rollup. Every finance route
 * requires `dropship:manage_operations` (Administrator), read here because
 * `/dropship` itself is gated by role only.
 */
function ProgramFinanceTab() {
  const { hasPermission } = useAuth();
  return (
    <DropshipFinancePanel
      canView={hasPermission("dropship", "manage_operations")}
    />
  );
}

/**
 * Cost changes tab: the staff settings for how a .ops cost change reaches
 * vendors. Gated like the wallet policy tab: `dropship:view` for the GET and
 * `dropship:manage_operations` for the POST, read here because `/dropship`
 * itself is gated by role only.
 */
function CostChangePolicyTab() {
  const { hasPermission } = useAuth();
  return (
    <DropshipCostChangePolicyPanel
      canView={hasPermission("dropship", "view")}
      canEdit={hasPermission("dropship", "manage_operations")}
    />
  );
}

/**
 * Wallet policy tab.
 *
 * `/dropship` is gated by ROLE, so a lead reaches this page without necessarily
 * holding the dropship abilities the wallet policy routes require. The two
 * permissions the server enforces are therefore read here and passed down
 * separately: `dropship:view` for the GET (no permission, no data) and
 * `dropship:manage_operations` for the POST (no permission, every control is
 * disabled).
 */
function WalletPolicyTab() {
  const { hasPermission } = useAuth();
  return (
    <DropshipWalletPolicyPanel
      canView={hasPermission("dropship", "view")}
      canEdit={hasPermission("dropship", "manage_operations")}
    />
  );
}

function WalletOpsTab() {
  return <LazyWalletOpsTab />;
}
