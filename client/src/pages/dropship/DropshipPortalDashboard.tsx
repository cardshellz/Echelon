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
  listLaunchReadyStoreConnections,
  type DropshipOnboardingState,
  type DropshipOnboardingStep,
  type DropshipOrderListItem,
  type DropshipOrderListResponse,
  type DropshipPaymentHoldSummaryResponse,
  type DropshipSettingsResponse,
  type DropshipStoreConnectionSummary,
  type DropshipWalletResponse,
} from "@/lib/dropship-ops-surface";
import {
  PAYMENT_HOLD_STATUS,
  PAYMENT_HOLD_SUMMARY_PATH,
  describeHeldOrder,
  describePaymentHoldSummary,
  type PaymentHoldNotice,
} from "@/lib/dropship-payment-holds";
import {
  describeVendorStanding,
  isPausedForFunding,
  type VendorStandingNotice,
} from "@/lib/dropship-vendor-standing";
import { describeChosenItems, isOnboardingVendor, walletTodoDetail } from "@/lib/dropship-onboarding";
import {
  vendorAccountStatusLabel,
  vendorAuthMethodLabel,
  vendorErrorMessage,
  vendorLedgerEntryLabel,
  vendorLedgerStatusLabel,
  vendorMarketplaceOrderLabel,
  vendorOrderStatusLabel,
  vendorPlatformName,
  vendorStepStatusLabel,
  vendorStoreConnectionLine,
  vendorStoreReadinessDetail,
  vendorStoreStatusLabel,
} from "@/lib/dropship-vendor-labels";
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
  const holdSummaryQuery = useQuery<DropshipPaymentHoldSummaryResponse>({
    queryKey: [PAYMENT_HOLD_SUMMARY_PATH],
    queryFn: () => fetchJson<DropshipPaymentHoldSummaryResponse>(PAYMENT_HOLD_SUMMARY_PATH),
    enabled: !!principal,
  });
  // One clock reading per data load so every countdown on the page agrees.
  const now = useMemo(() => new Date(), [holdSummaryQuery.data, ordersQuery.data]);
  const holdNotice = holdSummaryQuery.data
    ? describePaymentHoldSummary(holdSummaryQuery.data.summary, now, {
      pausedForFunding: onboardingQuery.data ? isPausedForFunding(onboardingQuery.data.vendor) : false,
    })
    : null;
  const heldCount = holdSummaryQuery.data?.summary.heldCount ?? 0;

  const settings = settingsQuery.data?.settings;
  const onboarding = onboardingQuery.data;
  const standingNotice = onboarding ? describeVendorStanding(onboarding.vendor) : null;
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
              {vendorErrorMessage(settingsQuery.error ?? onboardingQuery.error, "We couldn't load your dashboard. Reload the page to try again.")}
            </AlertDescription>
          </Alert>
        )}

        {holdSummaryQuery.error && (
          <Alert variant="destructive" className="mb-4" data-testid="dashboard-payment-hold-error">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {vendorErrorMessage(holdSummaryQuery.error, "We couldn't check for orders waiting on payment. Reload the page to try again.")}
            </AlertDescription>
          </Alert>
        )}

        {standingNotice && (
          <VendorStandingPanel
            notice={standingNotice}
            onAddFunds={() => setLocation(dropshipPortalPath("/wallet"))}
          />
        )}

        {holdNotice && (
          <PaymentHoldPanel
            notice={holdNotice}
            onAddFunds={() => setLocation(dropshipPortalPath("/wallet"))}
            onViewOrders={() => setLocation(`${dropshipPortalPath("/orders")}?status=${PAYMENT_HOLD_STATUS}`)}
          />
        )}

        <section className="grid gap-4 xl:grid-cols-[1.35fr_0.85fr]">
          <LaunchOverviewPanel
            completedStepCount={completedStepCount}
            heldCount={heldCount}
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
            now={now}
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
  heldCount,
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
  heldCount: number;
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
    ? vendorAccountStatusLabel(settings.vendor.entitlementStatus)
    : onboarding?.entitlement.status
      ? vendorAccountStatusLabel(onboarding.entitlement.status)
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
            {isLoading ? "Loading your setup" : complete ? "Setup complete" : `${completedStepCount} of ${totalStepCount} setup steps done`}
          </div>
          <div className="mt-1 text-zinc-600">
            {complete ? "You're ready to sell." : "Finish the next step to start selling."}
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
          detail={heldCount > 0
            ? `${heldCount} waiting on payment`
            : orderTotal === 0 ? "No orders yet" : "Orders from your store"}
        />
      </div>
    </div>
  );
}

/**
 * Held orders outrank every other card: money is the only thing between the
 * vendor and a sale, and the marketplace clock is running.
 */
function VendorStandingPanel({
  notice,
  onAddFunds,
}: {
  notice: VendorStandingNotice;
  onAddFunds: () => void;
}) {
  return (
    <div
      className="mb-4 rounded-md border border-red-300 bg-red-50 p-5 text-red-950 shadow-sm"
      data-testid="dashboard-vendor-standing-panel"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold" data-testid="dashboard-vendor-standing-title">
            <AlertCircle className="h-5 w-5" />
            {notice.title}
          </h2>
          <p className="mt-1 text-sm" data-testid="dashboard-vendor-standing-detail">{notice.reason} {notice.action}</p>
          {notice.since && <p className="mt-1 text-sm">{notice.since}</p>}
        </div>
        {notice.needsFunds && (
          <Button type="button" className="h-9 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={onAddFunds}>
            Add funds
          </Button>
        )}
      </div>
    </div>
  );
}

function PaymentHoldPanel({
  notice,
  onAddFunds,
  onViewOrders,
}: {
  notice: PaymentHoldNotice;
  onAddFunds: () => void;
  onViewOrders: () => void;
}) {
  return (
    <div
      className={notice.needsFunds
        ? "mb-4 rounded-md border border-amber-300 bg-amber-50 p-5 text-amber-950 shadow-sm"
        : "mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-5 text-emerald-900 shadow-sm"}
      data-testid="dashboard-payment-hold-panel"
    >
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold" data-testid="dashboard-payment-hold-title">
            <Wallet className="h-5 w-5" />
            {notice.title}
          </h2>
          <p className="mt-1 text-sm" data-testid="dashboard-payment-hold-detail">{notice.needs} {notice.action}</p>
          {notice.deadline && <p className="mt-1 text-sm">{notice.deadline}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {notice.needsFunds && (
            <Button type="button" className="h-9 bg-[#C060E0] hover:bg-[#a94bc9]" onClick={onAddFunds}>
              Add funds
            </Button>
          )}
          <Button type="button" variant="outline" className="h-9 gap-2" onClick={onViewOrders}>
            View waiting orders
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
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
          <span className="font-medium">{vendorAuthMethodLabel(authMethod)}</span>
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
            Setup checklist
          </h2>
          <p className="text-sm text-zinc-500">What's done and what's left before you can sell.</p>
        </div>
        {onboarding && isOnboardingVendor(onboarding.vendor.status) && (
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
        )}
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
          We couldn't load your checklist. Reload the page to try again.
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
            {vendorStepStatusLabel(step.status)}
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
          <p className="text-sm text-zinc-500">Your marketplace store and whether it's ready for orders.</p>
        </div>
        <Badge variant="outline">{launchReadyCount} ready</Badge>
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
          No store connected yet.
        </div>
      )}
    </div>
  );
}

function RecentOrdersPanel({
  error,
  isLoading,
  now,
  onViewAll,
  orders,
  total,
}: {
  error: unknown;
  isLoading: boolean;
  now: Date;
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
            {total > 0 ? `${Math.min(orders.length, dashboardActivityLimit)} of ${total} shown` : "Your latest orders"}
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
          <AlertDescription>{vendorErrorMessage(error, "We couldn't load your orders. Reload the page to try again.")}</AlertDescription>
        </Alert>
      ) : orders.length ? (
        <div className="mt-5 divide-y divide-zinc-200 rounded-md border border-zinc-200">
          {orders.map((order) => (
            <RecentOrderRow key={order.intakeId} order={order} now={now} />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
          No orders yet.
        </div>
      )}
    </div>
  );
}

function RecentOrderRow({ order, now }: { order: DropshipOrderListItem; now: Date }) {
  const heldDetail = describeHeldOrder(order, now);
  return (
    <div className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <div className="truncate font-medium">{order.externalOrderNumber || order.externalOrderId}</div>
          <Badge variant="outline" className={statusTone(order.status)}>
            {vendorOrderStatusLabel(order.status)}
          </Badge>
          {heldDetail && <span className="text-xs font-medium text-amber-800" data-testid="recent-order-hold-detail">{heldDetail}</span>}
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-500">
          <span>{vendorMarketplaceOrderLabel({ platform: order.platform })}</span>
          <span>{order.storeConnection.externalDisplayName || vendorPlatformName(order.storeConnection.platform)}</span>
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
          <AlertDescription>{vendorErrorMessage(error, "We couldn't load your wallet activity. Reload the page to try again.")}</AlertDescription>
        </Alert>
      ) : ledger.length ? (
        <div className="mt-5 divide-y divide-zinc-200 rounded-md border border-zinc-200">
          {ledger.map((entry) => (
            <RecentWalletLedgerRow key={entry.ledgerEntryId} entry={entry} />
          ))}
        </div>
      ) : (
        <div className="mt-5 rounded-md border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">
          No wallet activity yet.
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
          <div className="font-medium">{vendorLedgerEntryLabel(entry)}</div>
          <Badge variant="outline" className={statusTone(entry.status)}>
            {vendorLedgerStatusLabel(entry.status)}
          </Badge>
        </div>
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm text-zinc-500">
          <span>{formatDateTime(entry.createdAt)}</span>
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
          {connection.launchReady ? "Ready" : vendorStoreStatusLabel(connection.status)}
        </Badge>
      </div>
      <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <div className="text-zinc-500">Connection</div>
          <div className="mt-1 font-medium">{vendorStoreConnectionLine(connection)}</div>
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
      message: "Your setup is loading. If this stays blank, reload the page or open Onboarding.",
      path: null,
      title: "Loading your setup",
    };
  }

  // A funding pause outranks the checklist: nothing else the vendor does
  // matters until the wallet is funded and selling resumes.
  if (isPausedForFunding(onboarding.vendor)) {
    return {
      actionLabel: "Open wallet",
      message: "Selling is paused because a top-up failed. Add money in Wallet — a card payment counts at once, a bank transfer only once it settles. Selling resumes on its own when your available balance is back to your reserve.",
      path: "/wallet",
      title: "Add money to resume selling",
    };
  }

  const nextStep = onboarding.steps.find((step) => step.status !== "complete");
  if (!nextStep) {
    return {
      actionLabel: "Open catalog",
      message: "Your setup is done. List products on your eBay store from the Catalog page, and orders will show up here.",
      path: "/catalog",
      title: "You're ready to sell",
    };
  }

  if (nextStep.key === "vendor_profile") {
    return {
      actionLabel: "Open settings",
      message: "Finish your account profile to continue setting up.",
      path: "/settings",
      title: "Complete your profile",
    };
  }

  if (nextStep.key === "store_connection") {
    return {
      actionLabel: "Connect store",
      message: "Connect your eBay store so your listings, orders and tracking can go through the portal.",
      path: "/onboarding",
      title: "Connect a store",
    };
  }

  if (nextStep.key === "catalog_available") {
    return {
      actionLabel: "Check catalog",
      message: "Card Shellz is getting products ready for you. Check back soon to choose what to sell.",
      path: "/catalog",
      title: "Products coming soon",
    };
  }

  if (nextStep.key === "catalog_selection") {
    return {
      actionLabel: "Select products",
      message: "Choose the products you want to list on your store.",
      path: "/catalog",
      title: "Choose products to sell",
    };
  }

  if (onboarding.wallet.autoReloadConfigured && onboarding.wallet.hasCardBackstop) {
    return {
      actionLabel: "Open wallet",
      message: "Autopay is on but your agreement to the card fee is not on record. Confirm the terms in Wallet before you activate.",
      path: "/wallet",
      title: "Confirm your autopay terms",
    };
  }
  return {
    actionLabel: "Open wallet",
    message: "Choose your autopay source, set your reserve, add a backup card, then turn on autopay.",
    path: "/wallet",
    title: "Set up your wallet",
  };
}

function launchStepDetail(step: DropshipOnboardingStep, onboarding: DropshipOnboardingState): string {
  if (step.key === "vendor_profile") {
    return onboarding.vendor.status === "active"
      ? "Your profile is active."
      : `Your account: ${vendorAccountStatusLabel(onboarding.vendor.status).toLowerCase()}.`;
  }
  if (step.key === "store_connection") {
    return onboarding.storeConnections.launchReadyConnectedCount > 0
      ? "Your store is connected and ready."
      : "No store ready yet.";
  }
  if (step.key === "catalog_available") {
    return onboarding.catalog.adminCatalogAvailable
      ? "Products are ready for you to choose from."
      : "Card Shellz is getting products ready for you.";
  }
  if (step.key === "catalog_selection") {
    return onboarding.catalog.hasVendorSelection
      ? `${describeChosenItems(onboarding.catalog.vendorSelectedItemCount)}.`
      : "You haven't chosen any products yet.";
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
  if (!onboarding.catalog.adminCatalogAvailable) return "Coming soon";
  if (!onboarding.catalog.hasVendorSelection) return "Selection needed";
  return describeChosenItems(onboarding.catalog.vendorSelectedItemCount);
}

function catalogMetricDetail(onboarding: DropshipOnboardingState | undefined): string {
  if (!onboarding) return "Loading";
  if (!onboarding.catalog.adminCatalogAvailable) return "Card Shellz is getting products ready";
  if (!onboarding.catalog.hasVendorSelection) return "Pick products to list";
  return "Products chosen";
}

function walletMetricValue(
  settings: DropshipSettingsResponse["settings"] | undefined,
  onboarding: DropshipOnboardingState | undefined,
): string {
  // The value is always the balance; readiness is the detail line.
  if (settings) return formatCents(settings.wallet.availableBalanceCents);
  if (onboarding) return formatCents(onboarding.wallet.availableBalanceCents);
  return "Loading";
}

function walletMetricDetail(
  settings: DropshipSettingsResponse["settings"] | undefined,
  onboarding: DropshipOnboardingState | undefined,
): string {
  if (onboarding) return walletGateDetail(onboarding);
  if (!settings) return "Loading";
  if (!settings.wallet.autoReloadEnabled) return "Autopay disabled";
  if (!settings.wallet.autoReloadFundingMethodReady) return "Funding method needed";
  return "Autopay ready";
}

function walletGateDetail(onboarding: DropshipOnboardingState): string {
  if (onboarding.wallet.walletReady) {
    return `Top-ups from ${onboarding.wallet.autoReloadFundingMethodIsCard ? "card" : "bank"} · backup card on file`;
  }
  // The same next-piece sentence as the onboarding checklist row.
  return walletTodoDetail(onboarding.wallet);
}

function connectedStoreSummaryDetail(connection: DropshipStoreConnectionSummary): string {
  const details = [vendorPlatformName(connection.platform)];
  if (connection.shopDomain && connection.shopDomain !== connection.externalDisplayName) {
    details.push(connection.shopDomain);
  }
  return details.join(" | ");
}

function storeConnectionDisplayName(connection: DropshipStoreConnectionSummary): string {
  return connection.externalDisplayName || connection.shopDomain || `${vendorPlatformName(connection.platform)} store`;
}

function connectionStatusDetail(connection: DropshipStoreConnectionSummary): string {
  if (connection.launchReady) return `${vendorPlatformName(connection.platform)} store ready`;
  return vendorStoreReadinessDetail(connection);
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
