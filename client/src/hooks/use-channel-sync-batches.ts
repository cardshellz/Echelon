import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  channelSyncBatchSchema,
  channelSyncBatchesSchema,
  type ChannelSyncBatch,
} from "@shared/types/channel-sync-batch";
import { apiRequest } from "@/lib/queryClient";

const POLL_INTERVAL_MS = 5_000;
class SyncRequestRefused extends Error {
  constructor(
    message: string,
    readonly permissionDenied: boolean,
  ) {
    super(message);
  }
}
export function useChannelSyncBatches(
  channelId: number | undefined,
  actorId: string | undefined,
) {
  const client = useQueryClient();
  const [offset, setOffset] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const submitting = useRef(false);
  const [requestRefused, setRequestRefused] = useState(false);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const storageKey =
    channelId && actorId
      ? `channel-sync-request:${actorId}:${channelId}`
      : null;
  const key = ["/api/channels", channelId, "sync-batches", offset] as const;
  const query = useQuery({
    queryKey: key,
    enabled: !!channelId,
    queryFn: async () => {
      const result = channelSyncBatchesSchema.parse(
        await (
          await apiRequest(
            "GET",
            `/api/channels/${channelId}/sync-batches?offset=${offset}`,
          )
        ).json(),
      );
      if (result.batches.some((batch) => batch.channelId !== channelId))
        throw new Error("Sync status scope mismatch");
      return result;
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  const batches = query.data?.batches ?? [];
  const selectedInPage = batches.find((value) => value.id === selectedId);
  const readSelected = !!channelId && !!selectedId && !selectedInPage;
  const selectedQuery = useQuery({
    queryKey: [
      "/api/channels",
      channelId,
      "sync-batches",
      "selected",
      selectedId,
    ],
    enabled: readSelected,
    queryFn: async () => {
      const saved = channelSyncBatchSchema.parse(
        await (
          await apiRequest(
            "GET",
            `/api/channels/${channelId}/sync-batches/${selectedId}`,
          )
        ).json(),
      );
      if (saved.channelId !== channelId || saved.id !== selectedId)
        throw new Error("Selected sync scope mismatch");
      return saved;
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    staleTime: 0,
    retry: false,
  });
  // A newer run can move this one off the history page. Keep observing the
  // selected exact batch instead of silently substituting the newest run.
  const batch = selectedId
    ? (selectedInPage ?? selectedQuery.data ?? null)
    : (batches[0] ?? null);
  const readPending = (): string | null => {
    // Browser storage only retains an unacknowledged request key. Progress is
    // always loaded from the server, including when browser storage is unavailable.
    try {
      return storageKey ? sessionStorage.getItem(storageKey) : null;
    } catch {
      return null;
    }
  };
  const clearPending = (id: string) => {
    try {
      if (storageKey && readPending() === id)
        sessionStorage.removeItem(storageKey);
    } catch {
      /* A confirmed server receipt remains authoritative. */
    }
  };
  useEffect(() => {
    const pending = readPending();
    if (pending && batches.some((value) => value.id === pending)) {
      clearPending(pending);
      setRequestError(null);
    } else if (pending && query.isSuccess && !submitting.current) {
      setRequestError(
        "A previous sync request has not been confirmed. Refresh saved status or resume the same request.",
      );
    }
  }, [query.data, storageKey, query.isSuccess]);
  const mutation = useMutation({
    mutationFn: async (commandKey: string) => {
      const response = await fetch(`/api/channels/${channelId}/sync-batches`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commandKey }),
      });
      if ([400, 401, 403, 409, 422].includes(response.status)) {
        const permission = response.status === 401 || response.status === 403;
        const body: unknown = await response.json().catch(() => null);
        const message =
          body &&
          typeof body === "object" &&
          "message" in body &&
          typeof body.message === "string" &&
          body.message.length <= 1000
            ? body.message
            : "This sync request was refused. Review the channel setup before requesting another sync.";
        throw new SyncRequestRefused(
          permission
            ? "Your session is not allowed to start sync. Sign in with channel edit permission; saved work can still be checked by an authorized user."
            : message,
          permission,
        );
      }
      if (!response.ok) throw new Error("Sync request outcome unavailable");
      const saved = channelSyncBatchSchema.parse(await response.json());
      if (saved.id !== commandKey || saved.channelId !== channelId)
        throw new Error("Sync acknowledgement scope mismatch");
      return saved;
    },
    onSuccess: (saved: ChannelSyncBatch) => {
      clearPending(saved.id);
      setRequestError(null);
      setOffset(0);
      setSelectedId(saved.id);
      client.setQueryData(
        ["/api/channels", channelId, "sync-batches", 0],
        (previous: unknown) => {
          const parsed = channelSyncBatchesSchema.safeParse(previous);
          return {
            batches: [
              saved,
              ...(parsed.success
                ? parsed.data.batches.filter((value) => value.id !== saved.id)
                : []),
            ].slice(0, 10),
          };
        },
      );
      void client.invalidateQueries({
        queryKey: ["/api/channels", channelId, "sync-batches"],
      });
    },
  });
  async function start(): Promise<void> {
    if (!channelId || !storageKey || submitting.current) return;
    submitting.current = true;
    setOpen(true);
    setRequestError(null);
    setRequestRefused(false);
    try {
      // Retain one intent across an uncertain HTTP response and a page reload.
      // Polling and opening/closing the dialog never submit provider work.
      const commandKey =
        sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
      sessionStorage.setItem(storageKey, commandKey);
      await mutation.mutateAsync(commandKey);
    } catch (error) {
      if (error instanceof SyncRequestRefused) {
        const pending = readPending();
        if (pending) clearPending(pending);
        setRequestRefused(true);
        setPermissionDenied(error.permissionDenied);
        setRequestError(error.message);
      } else {
        setRequestError(
          "This request has not been confirmed. Refresh saved status or resume the same request. Accepted work continues in the background.",
        );
      }
    } finally {
      submitting.current = false;
    }
  }
  return {
    query: {
      ...query,
      isError: query.isError || (readSelected && selectedQuery.isError),
      isFetching:
        query.isFetching || (readSelected && selectedQuery.isFetching),
      refetch: async () => {
        await Promise.all([
          query.refetch(),
          ...(readSelected ? [selectedQuery.refetch()] : []),
        ]);
      },
    },
    batch,
    batches,
    offset,
    setOffset,
    selectedId,
    setSelectedId,
    open,
    setOpen,
    start,
    starting: mutation.isPending,
    requestError,
    requestRefused,
    permissionDenied,
  };
}
export type ChannelSyncBatchesController = ReturnType<
  typeof useChannelSyncBatches
>;
