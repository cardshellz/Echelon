import { useQuery } from "@tanstack/react-query";
import type React from "react";
import { Bell, KeyRound, Mail, Plug, Settings, Store, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchJson,
  formatCents,
  formatDateTime,
  formatStatus,
  sectionStatusTone,
  type DropshipSettingsResponse,
  type DropshipSettingsSection,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

const icons: Record<DropshipSettingsSection["key"], React.ReactNode> = {
  account: <Settings className="h-4 w-4" />,
  store_connection: <Store className="h-4 w-4" />,
  wallet_payment: <Wallet className="h-4 w-4" />,
  notifications: <Bell className="h-4 w-4" />,
  api_keys: <KeyRound className="h-4 w-4" />,
  webhooks: <Plug className="h-4 w-4" />,
  return_contact: <Mail className="h-4 w-4" />,
};

export default function DropshipPortalSettings() {
  const settingsQuery = useQuery<DropshipSettingsResponse>({
    queryKey: ["/api/dropship/settings"],
    queryFn: () => fetchJson<DropshipSettingsResponse>("/api/dropship/settings"),
  });
  const settings = settingsQuery.data?.settings;

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Settings className="h-6 w-6 text-[#C060E0]" />
            Settings
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Account, store connection, wallet, notification, return contact, and Phase 2 surfaces.</p>
        </div>

        {settingsQuery.isLoading ? (
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : settings ? (
          <>
            <section className="mt-5 grid gap-4 lg:grid-cols-3">
              <Metric title="Vendor" value={settings.vendor.businessName || settings.vendor.email || "Card Shellz member"} detail={formatStatus(settings.vendor.status)} />
              <Metric title="Wallet" value={formatCents(settings.wallet.availableBalanceCents)} detail={settings.wallet.autoReloadEnabled ? "Auto-reload enabled" : "Auto-reload needs setup"} />
              <Metric title="Generated" value={formatDateTime(settings.generatedAt)} detail={`${settings.storeConnections.length} store connection(s)`} />
            </section>

            <section className="mt-5 grid gap-4 md:grid-cols-2">
              {settings.sections.map((section) => (
                <div key={section.key} className="rounded-md border border-zinc-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-zinc-100 text-zinc-700">
                        {icons[section.key]}
                      </div>
                      <div>
                        <h2 className="font-semibold">{section.label}</h2>
                        <p className="mt-1 text-sm text-zinc-500">{section.summary}</p>
                      </div>
                    </div>
                    <Badge variant="outline" className={sectionStatusTone(section.status)}>
                      {section.comingSoon ? "Coming soon" : formatStatus(section.status)}
                    </Badge>
                  </div>
                  {section.blockers.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {section.blockers.map((blocker) => (
                        <Badge key={blocker} variant="outline" className="border-amber-200 bg-amber-50 text-amber-900">
                          {formatStatus(blocker)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </section>
          </>
        ) : (
          <Empty className="mt-5 rounded-md border border-dashed p-8">
            <EmptyMedia variant="icon"><Settings /></EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No settings</EmptyTitle>
              <EmptyDescription>Dropship settings could not be loaded.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </div>
    </DropshipPortalShell>
  );
}

function Metric({ detail, title, value }: { detail: string; title: string; value: string }) {
  return (
    <div className="rounded-md border border-zinc-200 bg-white p-4">
      <div className="text-sm text-zinc-500">{title}</div>
      <div className="mt-2 truncate text-xl font-semibold">{value}</div>
      <div className="mt-1 text-sm text-zinc-500">{detail}</div>
    </div>
  );
}
