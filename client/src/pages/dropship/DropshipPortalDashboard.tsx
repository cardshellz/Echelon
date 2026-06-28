import React, { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  Boxes,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  History,
  Store,
  Wallet,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  dropshipPortalPath,
  useDropshipAuth,
} from "@/lib/dropship-auth";
import {
  buildQueryUrl,
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  listLaunchReadyStoreConnections,
  queryErrorMessage,
  type DropshipOnboardingState,
  type DropshipOnboardingStep,
  type DropshipOrderListItem,
  type DropshipOrderListResponse,
  type DropshipSettingsResponse,
  type DropshipStoreConnectionSummary,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

type DropshipWalletLedgerEntry = DropshipWalletResponse["wallet"]["recentLedger"][number];

const dashboardActivityLimit = 5;

interface DashboardAction {
  actionLabel: string | null;
  message: string;
  path: string | null;
  title: string;
}

export default function DropshipPortalDashboard() {
  const [, setLocation] = useLocation();
  const { principal } = useDropshipAuth();
  const ordersUrl = buildQueryUrl("/api/dropship/orders", {
    page: 1,
    limit: dashboardActivityLimit,
  });
  const walletUrl = buildQueryUrl("/api/dropship/wallet", {
    limit: dashboardActivityLimit,
  });

  const settingsQuery = useQuery<DropshipSettingsResponse>({
    queryKey: ["/api/dropship/settings"],
    queryFn: () => fetchJson<DropshipSettingsResponse>("/api/dropship/settings"),
    enabled: !!principal,
  });
  const onboardingQuery = useQuery<DropshipOnboardingState>({
    queryKey: ["/api/dropship/onboarding/state"],
    queryFn: () => fetchJson<DropshipOnboardingState>("/api/dropship/onboarding/state"),
    enabled: !!principal,
  });
  const ordersQuery = useQuery<DropshipOrderListResponse>({
    queryKey: [ordersUrl],
    queryFn: () => fetchJson<DropshipOrderListResponse>(ordersUrl),
    enabled: !!principal,
  });
  const walletQuery = useQuery<DropshipWalletResponse>({
    queryKey: [walletUrl],
    queryFn: () => fetchJson<DropshipWalletResponse>(walletUrl),
    enabled: !!principal,
  });

  const settings = settingsQuery.data?.settings;
  const onboarding = onboardingQuery.data;
  const storeConnections = settings?.storeConnections ?? [];
  const launchReadyStoreConnections = useMemo(
    () => listLaunchReadyStoreConnections(storeConnections),
    [storeConnections],
  );
  const completedStepCount = onboarding?.steps.filter((step) => step.status === "complete").length ?? 0;
  const totalStepCount = onboarding?.steps.length ?? 0;
  const dashboardAction = dashboardNextAction(onboarding);
  const loadingOverview = settingsQuery.isLoading || onboardingQuery.isLoading;

  if (!principal) {
    return null;
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {(settingsQuery.error || onboardingQuery.error) && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(settingsQuery.error ?? onboardingQuery.error, "Unable to load dropship dashboard.")}
            </AlertDescription>
          </Alert>
        )}

        <section className="grid gap-4 xl:grid-cols-[1.35fr_0.85fr]">
          <LaunchOverviewPanel
            completedStepCount={completedStepCount}
            isLoading={loadingOverview}
            onboarding={onboarding}
            orderTotal={ordersQuery.data?.total ?? 0}
            principalEmail={principal.cardShellzEmail}
            settings={settings}
            storeConnections={storeConnections}
            launchReadyStoreConnections={launchReadyStoreConnections}
            totalStepCount={totalStepCount}
          />

          <NextActionPanel
            action={dashboardAction}
            authMethod={principal.authMethod}
            hasPasskey={principal.hasPasskey}
            onNavigate={(path) => setLocation(dropshipPortalPath(path))}
          />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1fr_0.8fr]">
          <LaunchChecklistPanel
            isLoading={onboardingQuery.isLoading}
            onboarding={onboarding}
            onNavigate={(path) => setLocation(dropshipPortalPath(path))}
          />

          <StoreHealthPanel
            isLoading={settingsQuery.isLoading}
            launchReadyCount={launchReadyStoreConnections.length}
            storeConnections={storeConnections}
          />
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1fr_0.8fr]">
          <RecentOrdersPanel
            error={ordersQuery.error}
            isLoading={ordersQuery.isLoading}
            orders={ordersQuery.data?.items ?? []}
            total={ordersQuery.data?.total ?? 0}
            onViewAll={() => setLocation(dropshipPortalPath("/orders"))}
          />

          <RecentWalletPanel
            availableBalanceCents={walletQuery.data?.wallet.account.availableBalanceCents ?? null}
            error={walletQuery.error}
            isLoading={walletQuery.isLoading}
            ledger={walletQuery.data?.wallet.recentLedger ?? []}
            onViewWallet={() => setLocation(dropshipPortalPath("/wallet"))}
          />
        </section>
      </div>
    </DropshipPortalShell>
  );
}

function LaunchOverviewPanel({
  completedStepCount,
  isLoading,
  launchReadyStoreConnections,
  onboarding,
  orderTotal,
  principalEmail,
  settings,
  storeConnections,
  totalStepCount,
}: {
  completedStepCount: number;
  isLoading: boolean;
  launchReadyStoreConnections: DropshipStoreConnectionSummary[];
  onboarding: DropshipOnboardingState | undefined;
  orderTotal: number;
  principalEmail: string;
  settings: DropshipSettingsResponse["settings"] | undefined;
  storeConnections: DropshipStoreConnectionSummary[];
  totalStepCount: number;
}) {
  const complete = totalStepCount > 0 && completedStepCount === totalStepCount;
  const firstStore = launchReadyStoreConnections[0] ?? storeConnections[0] ?? null;
  const statusLabel = settings?.vendor.entitlementStatus
    ? formatStatus(settings.vendor.entitlementStatus)
    : onboarding?.entitlement.status
      ? formatStatus(onboarding.entitlement.status)
      : "Active";

  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-normal">Dropship dashboard</h1>
            <Badge className="bg-[#C060E0] text-white hover:bg-[#C060E0]">{statusLabel}</Badge>
          </div>
          <p className="mt-2 text-sm text-zinc-500">
            {settings?.vendor.businessName || onboarding?.vendor.businessName || principalEmail}
          </p>
          <p className="mt-1 text-xs text-zinc-500">{principalEmail}</p>
        </div>

        <div className="rounded-md border border-[#C060E0]/25 bg-[#C060E0]/5 px-4 py-3 text-sm">
          <div className="font-semibold text-[#8c35aa]">
            {isLoading ? "Loading launch status" : complete ? "Launch checklist complete" : `${completedStepCount} of ${totalStepCount} launch steps complete`}
          </div>
          <div className="mt-1 text-zinc-600">
            {complete ? "Ready for smoke testing." : "Work through the next required launch gate."}
          </div>
        </div>
      </div>

      <div className="mt-6 grid gap-4 border-t border-zinc-200 pt-5 sm:grid-cols-2 xl:grid-cols-4">
        <DashboardMetric
          icon={<Store className="h-4 w-4" />}
          label="Connected store"
          value={firstStore ? storeConnectionDisplayName(firstStore) : "None"}
          detail={firstStore ? connectionStatusDetail(firstStore) : "Connect eBay or Shopify"}
        />
        <DashboardMetric
          icon={<Boxes className="h-4 w-4" />}
          label="Catalog"
          value={catalogMetricValue(onboarding)}
          detail={catalogMetricDetail(onboarding)}
        />
        <DashboardMetric
          icon={<CircleDollarSign className="h-4 w-4" />}
          label="Wallet"
          value={walletMetricValue(settings, onboarding)}
          detail={walletMetricDetail(settings, onboarding)}
        />
        <DashboardMetric
          icon={<ClipboardList className="h-4 w-4" />}
          label="Orders"
          value={String(orderTotal)}
          detail={orderTotal === 0 ? "No marketplace orders yet" : "Marketplace intake recorded"}
        />
      </div>
    </div>
  );
}

function NextActionPanel({
  action,
  authMethod,
  hasPasskey,
  onNavigate,
}: {
  action: DashboardAction;
  authMethod: string;
  hasPasskey: boolean;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-[#C060E0] text-white">
          <ArrowRight className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium uppercase text-zinc-500">Next step</p>
          <h2 className="mt-1 text-xl font-semibold">{action.title}</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-600">{action.message}</p>
        </div>
      </div>

      {action.path && action.actionLabel && (
        <Button
          type="button"
          className="mt-5 h-10 w-full gap-2 bg-[#C060E0] hover:bg-[#a94bc9]"
          onClick={() => onNavigate(action.path as string)}
        >
          {action.actionLabel}
          <ArrowRight className="h-4 w-4" />
        </Button>
      )}

      <div className="mt-5 border-t border-zinc-200 pt-4 text-sm">
        <div className="flex items-center justify-between gap-3">
          <span className="text-zinc-500">Signed in with</span>
          <span className="font-medium">{formatStatus(authMethod)}</span>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          <span className="text-zinc-500">Passkey</span>
          <span className="font-medium">{hasPasskey ? "Enrolled" : "Not enrolled"}</span>
        </div>
      </div>
    </div>
  );
}

function DashboardMetric({
  detail,
  icon,
  label,
  value,
}: {
  detail: string;
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 border-l-2 border-[#C060E0]/40 pl-3">
      <div className="flex items-center gap-2 text-sm text-zinc-500">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 truncate text-lg font-semibold text-zinc-950">{value}</div>
      <div className="mt-1 truncate text-sm text-zinc-500">{detail}</div>
    </div>
  );
}

function LaunchChecklistPanel({
  isLoading,
  onboarding,
  onNavigate,
}: {
  isLoading: boolean;
  onboarding: DropshipOnboardingState | undefined;
  onNavigate: (path: string) => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <CheckCircle2 className="h-5 w-5 text-[#C060E0]" />
            Launch checklist
          </h2>
          <p className="text-sm text-zinc-500">What is complete and what is still blocking launch.</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-fit gap-2"
          onClick={() => onNavigate("/onboarding")}
        >
          Onboarding
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 5 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : onboarding ? (
        <div className="mt-5 divide-y divide-zinc-200 rounded-md border border-zinc-200">
          {onboarding.steps.map((step) => (
            <LaunchStepRow key={step.key} onboarding={onboarding} step={step} />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
          Launch checklist could not be loaded.
        </div>
      )}
    </div>
  );
}

function LaunchStepRow({
  onboarding,
  step,
}: {
  onboarding: DropshipOnboardingState;
  step: DropshipOnboardingStep;
}) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{step.label}</span>
          <Badge variant="outline" className={launchStepTone(step.status)}>
            {formatStatus(step.status)}
          </Badge>
        </div>
        <p className="mt-1 text-sm text-zinc-500">{launchStepDetail(step, onboarding)}</p>
      </div>
      {step.required && <span className="text-xs font-medium uppercase text-zinc-400">Required</span>}
    </div>
  );
}

function StoreHealthPanel({
  isLoading,
  launchReadyCount,
  storeConnections,
}: {
  isLoading: boolean;
  launchReadyCount: number;
  storeConnections: DropshipStoreConnectionSummary[];
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Store className="h-5 w-5 text-[#C060E0]" />
            Store connection
          </h2>
          <p className="text-sm text-zinc-500">Marketplace account and token readiness.</p>
        </div>
        <Badge variant="outline">{launchReadyCount} launch-ready</Badge>
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-3">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : storeConnections.length ? (
        <div className="mt-5 space-y-3">
          {storeConnections.map((connection) => (
            <StoreConnectionCard key={connection.storeConnectionId} connection={connection} />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
          No store connection configured.
        </div>
      )}
    </div>
  );
}

function RecentOrdersPanel({
  error,
  isLoading,
  onViewAll,
  orders,
  total,
}: {
  error: unknown;
  isLoading: boolean;
  onViewAll: () => void;
  orders: DropshipOrderListItem[];
  total: number;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <ClipboardList className="h-5 w-5 text-[#C060E0]" />
            Recent orders
          </h2>
          <p className="text-sm text-zinc-500">
            {total > 0 ? `${Math.min(orders.length, dashboardActivityLimit)} of ${total} shown` : "Latest marketplace intake"}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-9 w-fit gap-2" onClick={onViewAll}>
          Orders
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-16 w-full" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="destructive" className="mt-5">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{queryErrorMessage(error, "Unable to load recent dropship orders.")}</AlertDescription>
        </Alert>
      ) : orders.length ? (
        <div className="mt-5 divide-y divide-zinc-200 rounded-md border border-zinc-200">
          {orders.map((order) => (
            <RecentOrderRow key={order.intakeId} order={order} />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
          No dropship orders recorded yet.
        </div>
      )}
    </div>
  );
}

function RecentOrderRow({ order }: { order: DropshipOrderListItem }) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="truncate font-medium">{order.externalOrderNumber || order.externalOrderId}</div>
          <Badge variant="outline" className={statusTone(order.status)}>
            {formatStatus(order.status)}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-500">
          <span>{formatStatus(order.platform)} intake {order.intakeId}</span>
          <span>{order.storeConnection.externalDisplayName || formatStatus(order.storeConnection.platform)}</span>
          <span>{order.lineCount} line{order.lineCount === 1 ? "" : "s"} / {order.totalQuantity} unit{order.totalQuantity === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div className="whitespace-nowrap text-sm text-zinc-500">
        {formatDateTime(order.updatedAt)}
      </div>
    </div>
  );
}

function RecentWalletPanel({
  availableBalanceCents,
  error,
  isLoading,
  ledger,
  onViewWallet,
}: {
  availableBalanceCents: number | null;
  error: unknown;
  isLoading: boolean;
  ledger: DropshipWalletLedgerEntry[];
  onViewWallet: () => void;
}) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <History className="h-5 w-5 text-[#C060E0]" />
            Wallet activity
          </h2>
          <p className="text-sm text-zinc-500">
            Available {availableBalanceCents === null ? "not loaded" : formatCents(availableBalanceCents)}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-9 w-fit gap-2" onClick={onViewWallet}>
          Wallet
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      {isLoading ? (
        <div className="mt-5 space-y-3">
          {Array.from({ length: 3 }).map((_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      ) : error ? (
        <Alert variant="destructive" className="mt-5">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{queryErrorMessage(error, "Unable to load wallet activity.")}</AlertDescription>
        </Alert>
      ) : ledger.length ? (
        <div className="mt-5 divide-y divide-zinc-200 rounded-md border border-zinc-200">
          {ledger.map((entry) => (
            <RecentWalletLedgerRow key={entry.ledgerEntryId} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
          No wallet ledger activity recorded yet.
        </div>
      )}
    </div>
  );
}

function RecentWalletLedgerRow({ entry }: { entry: DropshipWalletLedgerEntry }) {
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="font-medium">{formatStatus(entry.type)}</div>
          <Badge variant="outline" className={statusTone(entry.status)}>
            {formatStatus(entry.status)}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-500">
          <span>{formatDateTime(entry.createdAt)}</span>
          {entry.referenceType && <span>{formatStatus(entry.referenceType)} {entry.referenceId ?? ""}</span>}
          {entry.settledAt && <span>Settled {formatDateTime(entry.settledAt)}</span>}
        </div>
      </div>
      <div className={`whitespace-nowrap font-mono text-sm font-semibold ${ledgerAmountTone(entry.amountCents)}`}>
        {formatLedgerAmount(entry.amountCents)}
      </div>
    </div>
  );
}

function StoreConnectionCard({ connection }: { connection: DropshipStoreConnectionSummary }) {
  return (
    <div className="rounded-md border border-zinc-200 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase text-zinc-500">Connected store</div>
          <h3 className="mt-1 truncate font-semibold">{storeConnectionDisplayName(connection)}</h3>
          <p className="mt-1 text-sm text-zinc-500">{connectedStoreSummaryDetail(connection)}</p>
        </div>
        <Badge variant={connection.launchReady ? "default" : "outline"}>
          {connection.launchReady ? "Launch ready" : formatStatus(connection.status)}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="text-zinc-500">Setup</div>
          <div className="mt-1 font-medium">{formatStatus(connection.setupStatus)}</div>
        </div>
        <div>
          <div className="text-zinc-500">Tokens</div>
          <div className="mt-1 font-medium">{tokenStatus(connection)}</div>
        </div>
        <div>
          <div className="text-zinc-500">Updated</div>
          <div className="mt-1 font-medium">{formatDateTime(connection.updatedAt)}</div>
        </div>
      </div>
    </div>
  );
}

function dashboardNextAction(onboarding: DropshipOnboardingState | undefined): DashboardAction {
  if (!onboarding) {
    return {
      actionLabel: null,
      message: "Launch readiness is loading. If this stays blank, reload the page or open onboarding.",
      path: null,
      title: "Loading launch status",
    };
  }

  const nextStep = onboarding.steps.find((step) => step.status !== "complete");
  if (!nextStep) {
    return {
      actionLabel: "Open catalog",
      message: "The checklist is complete. Push a test listing, place a marketplace order, then verify order intake, fulfillment, and tracking.",
      path: "/catalog",
      title: "Ready for smoke testing",
    };
  }

  if (nextStep.key === "vendor_profile") {
    return {
      actionLabel: "Open settings",
      message: "Finish the account profile before launch readiness can be completed.",
      path: "/settings",
      title: "Complete the vendor profile",
    };
  }

  if (nextStep.key === "store_connection") {
    return {
      actionLabel: "Open onboarding",
      message: "Connect or refresh the marketplace store so orders, listings, and tracking can flow through the portal.",
      path: "/onboarding",
      title: "Connect a store",
    };
  }

  if (nextStep.key === "catalog_available") {
    return {
      actionLabel: "Check catalog",
      message: "Card Shellz ops needs to expose catalog rows before you can select products for dropship.",
      path: "/catalog",
      title: "Waiting on catalog access",
    };
  }

  if (nextStep.key === "catalog_selection") {
    return {
      actionLabel: "Select products",
      message: "Choose the products or variants you want to make available for marketplace listing.",
      path: "/catalog",
      title: "Select dropship products",
    };
  }

  return {
    actionLabel: "Open wallet",
    message: "Add a funding method or configure auto-reload so accepted orders can be paid automatically.",
    path: "/wallet",
    title: "Set up wallet funding",
  };
}

function launchStepDetail(step: DropshipOnboardingStep, onboarding: DropshipOnboardingState): string {
  if (step.key === "vendor_profile") {
    return onboarding.vendor.status === "active"
      ? "Vendor profile is active."
      : `Vendor profile status is ${formatStatus(onboarding.vendor.status)}.`;
  }
  if (step.key === "store_connection") {
    return `${onboarding.storeConnections.launchReadyConnectedCount} launch-ready of ${onboarding.storeConnections.includedLimit} included connection(s).`;
  }
  if (step.key === "catalog_available") {
    return onboarding.catalog.adminCatalogAvailable
      ? `${onboarding.catalog.adminExposureRuleCount} admin exposure rule(s) available.`
      : "Card Shellz ops has not exposed catalog rows yet.";
  }
  if (step.key === "catalog_selection") {
    return onboarding.catalog.hasVendorSelection
      ? `${onboarding.catalog.vendorSelectionRuleCount} vendor selection rule(s) saved.`
      : "No product selection has been saved yet.";
  }
  if (onboarding.wallet.walletReady) {
    return "Wallet funding and auto-reload are ready.";
  }
  return walletGateDetail(onboarding);
}

function launchStepTone(status: DropshipOnboardingStep["status"]): string {
  if (status === "complete") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "blocked") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function catalogMetricValue(onboarding: DropshipOnboardingState | undefined): string {
  if (!onboarding) return "Loading";
  if (!onboarding.catalog.adminCatalogAvailable) return "Not available";
  if (!onboarding.catalog.hasVendorSelection) return "Selection needed";
  return `${onboarding.catalog.vendorSelectionRuleCount} rule(s)`;
}

function catalogMetricDetail(onboarding: DropshipOnboardingState | undefined): string {
  if (!onboarding) return "Catalog readiness loading";
  if (!onboarding.catalog.adminCatalogAvailable) return "Waiting on admin exposure";
  if (!onboarding.catalog.hasVendorSelection) return "Pick products to list";
  return `${onboarding.catalog.adminExposureRuleCount} exposed rule(s)`;
}

function walletMetricValue(
  settings: DropshipSettingsResponse["settings"] | undefined,
  onboarding: DropshipOnboardingState | undefined,
): string {
  if (onboarding?.wallet.walletReady) return "Ready";
  if (settings) return formatCents(settings.wallet.availableBalanceCents);
  if (onboarding) return formatCents(onboarding.wallet.availableBalanceCents);
  return "Loading";
}

function walletMetricDetail(
  settings: DropshipSettingsResponse["settings"] | undefined,
  onboarding: DropshipOnboardingState | undefined,
): string {
  if (onboarding) return walletGateDetail(onboarding);
  if (!settings) return "Wallet readiness loading";
  if (!settings.wallet.autoReloadEnabled) return "Auto-reload disabled";
  if (!settings.wallet.autoReloadFundingMethodReady) return "Funding method needed";
  return "Auto-reload ready";
}

function walletGateDetail(onboarding: DropshipOnboardingState): string {
  if (!onboarding.wallet.autoReloadEnabled) return "Auto-reload is not enabled.";
  if (!onboarding.wallet.autoReloadFundingMethodReady) return "Auto-reload needs a ready funding method.";
  if (!onboarding.wallet.hasUsdcBaseFundingMethod) return "USDC Base funding method is missing.";
  if (!onboarding.wallet.hasSpendableBalance) return "No spendable balance yet.";
  return "Wallet is ready.";
}

function connectedStoreSummaryDetail(connection: DropshipStoreConnectionSummary): string {
  const details = [formatStatus(connection.platform)];
  if (connection.shopDomain && connection.shopDomain !== connection.externalDisplayName) {
    details.push(connection.shopDomain);
  }
  return details.join(" | ");
}

function storeConnectionDisplayName(connection: DropshipStoreConnectionSummary): string {
  return connection.externalDisplayName || connection.shopDomain || `${formatStatus(connection.platform)} store name pending`;
}

function connectionStatusDetail(connection: DropshipStoreConnectionSummary): string {
  if (connection.launchReady) return `${formatStatus(connection.platform)} launch-ready`;
  if (connection.status !== "connected") return formatStatus(connection.status);
  return `Setup ${formatStatus(connection.setupStatus)}`;
}

function tokenStatus(connection: DropshipStoreConnectionSummary): string {
  if (connection.hasAccessToken && connection.hasRefreshToken) return "Access + refresh";
  if (connection.hasAccessToken) return "Access only";
  return "Missing";
}

function formatLedgerAmount(amountCents: number): string {
  const prefix = amountCents > 0 ? "+" : "";
  return `${prefix}${formatCents(amountCents)}`;
}

function ledgerAmountTone(amountCents: number): string {
  if (amountCents > 0) return "text-emerald-700";
  if (amountCents < 0) return "text-rose-700";
  return "text-zinc-700";
}

function statusTone(status: string): string {
  if (
    status === "accepted"
    || status === "active"
    || status === "complete"
    || status === "completed"
    || status === "connected"
    || status === "processing"
    || status === "ready"
    || status === "settled"
    || status === "succeeded"
  ) {
    return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
  if (
    status === "incomplete"
    || status === "payment_hold"
    || status === "pending"
    || status === "queued"
    || status === "received"
    || status === "retrying"
  ) {
    return "border-amber-200 bg-amber-50 text-amber-900";
  }
  if (
    status === "blocked"
    || status === "cancelled"
    || status === "exception"
    || status === "failed"
    || status === "rejected"
    || status === "voided"
  ) {
    return "border-rose-200 bg-rose-50 text-rose-800";
  }
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
