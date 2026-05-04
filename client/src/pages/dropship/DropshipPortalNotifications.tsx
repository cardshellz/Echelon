import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bell, CheckCircle2, MailOpen } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  buildDropshipNotificationsUrl,
  fetchJson,
  formatDateTime,
  formatStatus,
  postJson,
  queryErrorMessage,
  type DropshipNotificationListItem,
  type DropshipNotificationListResponse,
  type DropshipNotificationMarkReadResponse,
} from "@/lib/dropship-ops-surface";
import { DropshipPortalShell } from "./DropshipPortalShell";

export default function DropshipPortalNotifications() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"all" | "unread">("all");
  const [markingNotificationId, setMarkingNotificationId] = useState<number | "displayed" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const notificationsUrl = useMemo(() => buildDropshipNotificationsUrl({
    view,
    limit: 50,
  }), [view]);
  const notificationsQuery = useQuery<DropshipNotificationListResponse>({
    queryKey: [notificationsUrl],
    queryFn: () => fetchJson<DropshipNotificationListResponse>(notificationsUrl),
  });
  const notifications = notificationsQuery.data?.items ?? [];
  const unreadNotifications = notifications.filter((notification) => !notification.readAt);

  async function markRead(notification: DropshipNotificationListItem): Promise<void> {
    if (notification.readAt) return;
    await runMarkRead(notification.notificationEventId, async () => {
      await postJson<DropshipNotificationMarkReadResponse>(
        `/api/dropship/notifications/${notification.notificationEventId}/read`,
        {},
      );
      setMessage("Alert marked read.");
    });
  }

  async function markDisplayedRead(): Promise<void> {
    if (unreadNotifications.length === 0) return;
    await runMarkRead("displayed", async () => {
      for (const notification of unreadNotifications) {
        await postJson<DropshipNotificationMarkReadResponse>(
          `/api/dropship/notifications/${notification.notificationEventId}/read`,
          {},
        );
      }
      setMessage(`${unreadNotifications.length} displayed alert${unreadNotifications.length === 1 ? "" : "s"} marked read.`);
    });
  }

  async function runMarkRead(
    marker: number | "displayed",
    task: () => Promise<void>,
  ): Promise<void> {
    setMarkingNotificationId(marker);
    setError("");
    setMessage("");
    try {
      await task();
      await Promise.all([
        notificationsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Alert update failed.");
    } finally {
      setMarkingNotificationId(null);
    }
  }

  return (
    <DropshipPortalShell>
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-2xl font-semibold">
              <Bell className="h-6 w-6 text-[#C060E0]" />
              Alerts
            </h1>
            <p className="mt-1 text-sm text-zinc-500">Dropship account, order, wallet, store, listing, and return notifications.</p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select value={view} onValueChange={(value) => setView(value === "unread" ? "unread" : "all")}>
              <SelectTrigger className="h-10 sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All alerts</SelectItem>
                <SelectItem value="unread">Unread only</SelectItem>
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="h-10 gap-2"
              disabled={unreadNotifications.length === 0 || markingNotificationId !== null}
              onClick={markDisplayedRead}
            >
              <CheckCircle2 className="h-4 w-4" />
              {markingNotificationId === "displayed" ? "Marking read" : "Mark displayed read"}
            </Button>
          </div>
        </div>

        {notificationsQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(notificationsQuery.error, "Unable to load dropship alerts.")}
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {message && (
          <Alert className="mt-5 border-emerald-200 bg-emerald-50 text-emerald-900">
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{message}</AlertDescription>
          </Alert>
        )}

        <div className="mt-5 rounded-md border border-zinc-200 bg-white">
          {notificationsQuery.isLoading ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : notificationsQuery.error ? (
            <Empty className="p-8">
              <EmptyMedia variant="icon"><AlertCircle /></EmptyMedia>
              <EmptyHeader>
                <EmptyTitle>Alerts unavailable</EmptyTitle>
                <EmptyDescription>The alerts API request failed.</EmptyDescription>
              </EmptyHeader>
            </Empty>
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
                        <Badge variant="outline" className={statusTone(notification.status)}>{formatStatus(notification.status)}</Badge>
                      </div>
                      {notification.message && <p className="mt-1 text-sm text-zinc-600">{notification.message}</p>}
                      <p className="mt-2 text-xs text-zinc-500">
                        {formatStatus(notification.eventType)} via {formatStatus(notification.channel)}
                        {notification.readAt ? ` | Read ${formatDateTime(notification.readAt)}` : ""}
                      </p>
                    </div>
                    <div className="flex flex-col items-start gap-2 sm:items-end">
                      <div className="whitespace-nowrap text-sm text-zinc-500">{formatDateTime(notification.createdAt)}</div>
                      {!notification.readAt && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="h-9 gap-2"
                          disabled={markingNotificationId !== null}
                          onClick={() => markRead(notification)}
                        >
                          <MailOpen className="h-4 w-4" />
                          {markingNotificationId === notification.notificationEventId ? "Marking read" : "Mark read"}
                        </Button>
                      )}
                    </div>
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

function statusTone(status: string): string {
  if (status === "delivered") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "pending") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
