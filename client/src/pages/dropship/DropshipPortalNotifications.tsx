import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Bell, CheckCircle2, Fingerprint, Mail, MailOpen, SlidersHorizontal } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  buildDropshipNotificationsUrl,
  buildNotificationPreferenceUpdateInput,
  fetchJson,
  formatDateTime,
  formatStatus,
  postJson,
  putJson,
  queryErrorMessage,
  type DropshipNotificationListItem,
  type DropshipNotificationListResponse,
  type DropshipNotificationMarkReadResponse,
  type DropshipNotificationPreference,
  type DropshipNotificationPreferencesResponse,
  type DropshipNotificationPreferenceUpdateResponse,
} from "@/lib/dropship-ops-surface";
import { useDropshipAuth } from "@/lib/dropship-auth";
import { DropshipPortalShell } from "./DropshipPortalShell";

type PendingPreferenceAction = "send-code" | "verify-code" | "passkey-proof" | "save" | null;

interface NotificationPreferenceRow {
  eventType: string;
  critical: boolean;
  emailEnabled: boolean;
  inAppEnabled: boolean;
  smsEnabled: boolean;
  webhookEnabled: boolean;
  updatedAt: string | null;
  source: "saved" | "recent";
  recentCount: number;
}

export default function DropshipPortalNotifications() {
  const queryClient = useQueryClient();
  const {
    principal,
    sensitiveProofs,
    startEmailStepUp,
    verifyEmailStepUp,
    verifyPasskeyStepUp,
  } = useDropshipAuth();
  const [view, setView] = useState<"all" | "unread">("all");
  const [markingNotificationId, setMarkingNotificationId] = useState<number | "displayed" | null>(null);
  const [emailCodeSent, setEmailCodeSent] = useState(false);
  const [verificationCode, setVerificationCode] = useState("");
  const [pendingPreferenceAction, setPendingPreferenceAction] = useState<PendingPreferenceAction>(null);
  const [pendingPreferenceEventType, setPendingPreferenceEventType] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const notificationsUrl = useMemo(() => buildDropshipNotificationsUrl({
    view,
    limit: 50,
  }), [view]);
  const preferenceEventsUrl = useMemo(() => buildDropshipNotificationsUrl({
    view: "all",
    limit: 100,
  }), []);
  const notificationsQuery = useQuery<DropshipNotificationListResponse>({
    queryKey: [notificationsUrl],
    queryFn: () => fetchJson<DropshipNotificationListResponse>(notificationsUrl),
  });
  const preferenceEventsQuery = useQuery<DropshipNotificationListResponse>({
    queryKey: [preferenceEventsUrl],
    queryFn: () => fetchJson<DropshipNotificationListResponse>(preferenceEventsUrl),
  });
  const preferencesQuery = useQuery<DropshipNotificationPreferencesResponse>({
    queryKey: ["/api/dropship/notification-preferences"],
    queryFn: () => fetchJson<DropshipNotificationPreferencesResponse>("/api/dropship/notification-preferences"),
  });
  const notifications = notificationsQuery.data?.items ?? [];
  const unreadNotifications = notifications.filter((notification) => !notification.readAt);
  const preferenceRows = useMemo(() => buildPreferenceRows(
    preferencesQuery.data?.preferences ?? [],
    preferenceEventsQuery.data?.items ?? [],
  ), [preferencesQuery.data?.preferences, preferenceEventsQuery.data?.items]);

  const hasActivePreferenceProof = () => {
    const proof = sensitiveProofs.manage_notification_preferences;
    return !!proof && new Date(proof.expiresAt).getTime() > Date.now();
  };

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

  async function updatePreference(
    row: NotificationPreferenceRow,
    changes: Partial<Pick<NotificationPreferenceRow, "emailEnabled" | "inAppEnabled">>,
  ): Promise<void> {
    setPendingPreferenceEventType(row.eventType);
    try {
      if (!await ensurePreferenceProof()) return;
      await runPreferenceAction("save", async () => {
        const response = await putJson<DropshipNotificationPreferenceUpdateResponse>(
          `/api/dropship/notification-preferences/${encodeURIComponent(row.eventType)}`,
          buildNotificationPreferenceUpdateInput({
            critical: row.critical,
            emailEnabled: changes.emailEnabled ?? row.emailEnabled,
            inAppEnabled: changes.inAppEnabled ?? row.inAppEnabled,
          }),
        );
        await Promise.all([
          preferencesQuery.refetch(),
          queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
        ]);
        setEmailCodeSent(false);
        setVerificationCode("");
        setMessage(`${formatStatus(response.preference.eventType)} preferences saved.`);
      });
    } finally {
      setPendingPreferenceEventType(null);
    }
  }

  async function ensurePreferenceProof(): Promise<boolean> {
    if (hasActivePreferenceProof()) {
      setEmailCodeSent(false);
      setVerificationCode("");
      return true;
    }
    if (principal?.hasPasskey) {
      return runPreferenceAction("passkey-proof", async () => {
        await verifyPasskeyStepUp("manage_notification_preferences");
      });
    }

    if (!emailCodeSent) {
      await runPreferenceAction("send-code", async () => {
        await startEmailStepUp("manage_notification_preferences");
        setEmailCodeSent(true);
        setVerificationCode("");
        setMessage("Verification code sent. Enter it below, then retry the preference change.");
      });
      return false;
    }

    if (verificationCode.length !== 6) {
      setError("Enter the 6-digit verification code before saving notification preferences.");
      return false;
    }

    const verified = await runPreferenceAction("verify-code", async () => {
      await verifyEmailStepUp({
        action: "manage_notification_preferences",
        verificationCode,
      });
    });
    if (verified) {
      setEmailCodeSent(false);
      setVerificationCode("");
    }
    return verified;
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
        preferenceEventsQuery.refetch(),
        queryClient.invalidateQueries({ queryKey: ["/api/dropship/settings"] }),
      ]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Alert update failed.");
    } finally {
      setMarkingNotificationId(null);
    }
  }

  async function runPreferenceAction(action: PendingPreferenceAction, task: () => Promise<void>): Promise<boolean> {
    setPendingPreferenceAction(action);
    setError("");
    setMessage("");
    try {
      await task();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Notification preference update failed.");
      return false;
    } finally {
      setPendingPreferenceAction(null);
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
        {preferencesQuery.error && (
          <Alert variant="destructive" className="mt-5">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              {queryErrorMessage(preferencesQuery.error, "Unable to load notification preferences.")}
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

        {emailCodeSent && (
          <SensitiveActionVerificationPanel
            pendingPreferenceAction={pendingPreferenceAction}
            verificationCode={verificationCode}
            onVerificationCodeChange={setVerificationCode}
          />
        )}

        <NotificationPreferencesPanel
          isLoading={preferencesQuery.isLoading || preferenceEventsQuery.isLoading}
          pendingPreferenceAction={pendingPreferenceAction}
          pendingPreferenceEventType={pendingPreferenceEventType}
          rows={preferenceRows}
          emailCodeSent={emailCodeSent}
          verificationCode={verificationCode}
          onUpdatePreference={updatePreference}
        />

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

function NotificationPreferencesPanel({
  emailCodeSent,
  isLoading,
  onUpdatePreference,
  pendingPreferenceAction,
  pendingPreferenceEventType,
  rows,
  verificationCode,
}: {
  emailCodeSent: boolean;
  isLoading: boolean;
  onUpdatePreference: (
    row: NotificationPreferenceRow,
    changes: Partial<Pick<NotificationPreferenceRow, "emailEnabled" | "inAppEnabled">>,
  ) => void;
  pendingPreferenceAction: PendingPreferenceAction;
  pendingPreferenceEventType: string | null;
  rows: NotificationPreferenceRow[];
  verificationCode: string;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <SlidersHorizontal className="h-5 w-5 text-zinc-500" />
            Alert preferences
          </h2>
          <p className="mt-1 text-sm text-zinc-500">Email and in-app delivery by event type.</p>
        </div>
        <Badge variant="outline">{rows.length} type{rows.length === 1 ? "" : "s"}</Badge>
      </div>

      {isLoading ? (
        <div className="mt-4 space-y-2">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </div>
      ) : rows.length ? (
        <div className="mt-4 divide-y divide-zinc-200 rounded-md border border-zinc-200">
          {rows.map((row) => {
            const rowPending = pendingPreferenceEventType === row.eventType && pendingPreferenceAction !== null;
            const disabled = pendingPreferenceAction !== null || (emailCodeSent && verificationCode.length !== 6);
            return (
              <div key={row.eventType} className="grid gap-4 p-4 lg:grid-cols-[1fr_360px] lg:items-center">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{formatStatus(row.eventType)}</h3>
                    {row.critical && (
                      <Badge variant="outline" className="border-rose-200 bg-rose-50 text-rose-800">Critical</Badge>
                    )}
                    <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-700">
                      {row.source === "saved" ? "Saved" : "Default"}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-zinc-500">
                    {row.recentCount} recent alert{row.recentCount === 1 ? "" : "s"}
                    {row.updatedAt ? ` | Updated ${formatDateTime(row.updatedAt)}` : ""}
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-4">
                  <PreferenceSwitch
                    checked={row.emailEnabled}
                    disabled={disabled || row.critical}
                    label="Email"
                    pending={rowPending}
                    onCheckedChange={(checked) => onUpdatePreference(row, { emailEnabled: checked })}
                  />
                  <PreferenceSwitch
                    checked={row.inAppEnabled}
                    disabled={disabled || row.critical}
                    label="In-app"
                    pending={rowPending}
                    onCheckedChange={(checked) => onUpdatePreference(row, { inAppEnabled: checked })}
                  />
                  <PreferenceSwitch checked={false} disabled label="SMS" pending={false} onCheckedChange={() => undefined} />
                  <PreferenceSwitch checked={false} disabled label="Webhook" pending={false} onCheckedChange={() => undefined} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Empty className="mt-4 rounded-md border border-dashed p-8">
          <EmptyMedia variant="icon"><SlidersHorizontal /></EmptyMedia>
          <EmptyHeader>
            <EmptyTitle>No preference event types</EmptyTitle>
            <EmptyDescription>Preference controls appear after a notification event type exists.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  );
}

function PreferenceSwitch({
  checked,
  disabled,
  label,
  onCheckedChange,
  pending,
}: {
  checked: boolean;
  disabled: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
  pending: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
      <span className="text-sm font-medium">{pending ? "Saving" : label}</span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function SensitiveActionVerificationPanel({
  onVerificationCodeChange,
  pendingPreferenceAction,
  verificationCode,
}: {
  onVerificationCodeChange: (value: string) => void;
  pendingPreferenceAction: PendingPreferenceAction;
  verificationCode: string;
}) {
  return (
    <section className="mt-5 rounded-md border border-zinc-200 bg-white p-4">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-sm space-y-2">
          <Label>Verification code</Label>
          <InputOTP
            maxLength={6}
            value={verificationCode}
            onChange={onVerificationCodeChange}
            containerClassName="justify-between"
            disabled={pendingPreferenceAction !== null}
          >
            <InputOTPGroup>
              {Array.from({ length: 6 }).map((_, index) => (
                <InputOTPSlot key={index} index={index} className="h-10 w-10 text-sm" />
              ))}
            </InputOTPGroup>
          </InputOTP>
        </div>
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          {pendingPreferenceAction === "passkey-proof" ? <Fingerprint className="h-4 w-4" /> : <Mail className="h-4 w-4" />}
          {preferenceProofLabel(pendingPreferenceAction)}
        </div>
      </div>
    </section>
  );
}

function buildPreferenceRows(
  preferences: DropshipNotificationPreference[],
  notifications: DropshipNotificationListItem[],
): NotificationPreferenceRow[] {
  const rows = new Map<string, NotificationPreferenceRow>();
  const recentCounts = notifications.reduce<Record<string, number>>((counts, notification) => {
    counts[notification.eventType] = (counts[notification.eventType] ?? 0) + 1;
    return counts;
  }, {});

  for (const preference of preferences) {
    rows.set(preference.eventType, {
      eventType: preference.eventType,
      critical: preference.critical,
      emailEnabled: preference.emailEnabled,
      inAppEnabled: preference.inAppEnabled,
      smsEnabled: preference.smsEnabled,
      webhookEnabled: preference.webhookEnabled,
      updatedAt: preference.updatedAt,
      source: "saved",
      recentCount: recentCounts[preference.eventType] ?? 0,
    });
  }

  for (const notification of notifications) {
    const existing = rows.get(notification.eventType);
    if (existing) {
      existing.critical = existing.critical || notification.critical;
      existing.recentCount = recentCounts[notification.eventType] ?? existing.recentCount;
      continue;
    }

    rows.set(notification.eventType, {
      eventType: notification.eventType,
      critical: notification.critical,
      emailEnabled: true,
      inAppEnabled: true,
      smsEnabled: false,
      webhookEnabled: false,
      updatedAt: null,
      source: "recent",
      recentCount: recentCounts[notification.eventType] ?? 0,
    });
  }

  return Array.from(rows.values()).sort((left, right) => left.eventType.localeCompare(right.eventType));
}

function preferenceProofLabel(action: PendingPreferenceAction): string {
  if (action === "send-code") return "Sending code";
  if (action === "verify-code") return "Verifying code";
  if (action === "passkey-proof") return "Waiting for passkey";
  if (action === "save") return "Saving preferences";
  return "Preference changes require step-up verification.";
}

function statusTone(status: string): string {
  if (status === "delivered") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "pending") return "border-amber-200 bg-amber-50 text-amber-900";
  if (status === "failed") return "border-rose-200 bg-rose-50 text-rose-800";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}
