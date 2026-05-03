import { useQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchJson,
  formatDateTime,
  formatStatus,
  type DropshipNotificationListResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

export default function DropshipPortalNotifications() {
  const notificationsQuery = useQuery<DropshipNotificationListResponse>({
    queryKey: ["/api/dropship/notifications?limit=50"],
    queryFn: () => fetchJson<DropshipNotificationListResponse>("/api/dropship/notifications?limit=50"),
  });
  const notifications = notificationsQuery.data?.items ?? [];

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold">
            <Bell className="h-6 w-6 text-[#C060E0]" />
            Alerts
          </h1>
          <p className="mt-1 text-sm text-zinc-500">Dropship account, order, wallet, store, listing, and return notifications.</p>
        </div>

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {notificationsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : notifications.length ? (
            <div className="divide-y divide-zinc-200">
              {notifications.map((notification) => (
                <div key={notification.notificationEventId} className="p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-semibold">{notification.title}</h2>
                        {notification.critical && (
                          <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-800">Critical</Badge>
                        )}
                        {!notification.readAt && (
                          <Badge variant="outline" className="border-[#C060E0]/30 bg-[#C060E0]/10 text-[#8c35aa]">Unread</Badge>
                        )}
                      </div>
                      {notification.message && <p className="mt-1 text-sm text-zinc-600">{notification.message}</p>}
                      <p className="mt-2 text-xs text-zinc-500">{formatStatus(notification.eventType)} via {formatStatus(notification.channel)}</p>
                    </div>
                    <div className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(notification.createdAt)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><Bell /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>No alerts</EmptyTitle>
                <EmptyDescription>No dropship notifications have been recorded.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </div>
      </div>
    </DropshipPortalShell>
  );
}
