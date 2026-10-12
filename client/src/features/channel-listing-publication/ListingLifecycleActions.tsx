import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { MoreHorizontal } from "lucide-react";
import {
  listingLifecycleHistorySchema,
  listingLifecycleListSchema,
  listingLifecycleViewSchema,
  type ListingLifecycleView,
} from "@shared/types/channel-listing-lifecycle";
import type { ListingAccount } from "@shared/types/channel-listing-publication";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { publicationRequest } from "./api";
import { errorMessage } from "./model";

export interface ListingLifecycleSelection {
  sku: string;
  title: string;
  action: "unpublish" | "remove";
}
type ReviewedSelection = ListingLifecycleSelection & {
  account: ListingAccount;
};
export function useListingLifecycle(
  channelId: number,
  skus: readonly string[],
  enabled: boolean,
  searchSku: string,
) {
  const base = `/api/channels/${channelId}/listing-lifecycle`;
  const client = useQueryClient();
  const [selection, setSelection] = useState<ReviewedSelection | null>(null);
  const [showRemoved, setShowRemoved] = useState(false);
  const exactSkus = [...new Set(skus)].sort();
  const query = useQuery({
    queryKey: [base, exactSkus],
    enabled,
    queryFn: async () => {
      const batches = exactSkus.length
        ? Array.from(
            { length: Math.ceil(exactSkus.length / 250) },
            (_, index) => exactSkus.slice(index * 250, (index + 1) * 250),
          )
        : [[]];
      const results = await Promise.all(
        batches.map((batch) =>
          publicationRequest(
            "POST",
            `${base}/lookup`,
            listingLifecycleListSchema,
            { skus: batch },
          ),
        ),
      );
      const first = results[0];
      if (
        results.some(
          (result) =>
            JSON.stringify(result.account) !== JSON.stringify(first.account),
        )
      )
        throw new Error(
          "The Walmart connection changed. Refresh the listing feed.",
        );
      return {
        account: first.account,
        items: results.flatMap((result) => result.items),
      };
    },
    refetchInterval: 15_000,
  });
  // Keep saved listings accessible even if Walmart omits retired items from a
  // later catalog page. Keyset pages bound each read as the history grows.
  const history = useInfiniteQuery({
    queryKey: [base, "history", searchSku],
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) =>
      publicationRequest(
        "POST",
        `${base}/history`,
        listingLifecycleHistorySchema,
        { afterSku: pageParam, sku: searchSku.trim() || null },
      ),
    getNextPageParam: (page) => page.nextSku ?? undefined,
    refetchInterval: 15_000,
  });
  const accountChanged = Boolean(
    query.data &&
      history.data?.pages.some(
        (page) =>
          JSON.stringify(page.account) !== JSON.stringify(query.data!.account),
      ),
  );
  const retained = accountChanged
    ? []
    : (history.data?.pages.flatMap((page) => page.items) ?? []);
  const refreshViews = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: [base] }),
      client.invalidateQueries({
        queryKey: [`/api/channels/${channelId}/catalog`],
      }),
    ]);
  };
  const action = useMutation({
    mutationFn: (input: ReviewedSelection) =>
      publicationRequest("POST", base, listingLifecycleViewSchema, {
        account: input.account,
        sku: input.sku,
        action: input.action,
      }),
    onSuccess: async () => {
      setSelection(null);
      await refreshViews();
    },
  });
  const check = useMutation({
    mutationFn: (sku: string) =>
      publicationRequest("POST", `${base}/status`, listingLifecycleViewSchema, {
        sku,
      }),
    onSuccess: refreshViews,
  });
  return {
    bySku: new Map(
      [...retained, ...(query.data?.items ?? [])].map((item) => [
        item.sku,
        item,
      ]),
    ),
    retained,
    hasMoreHistory: history.hasNextPage,
    loadingHistory: history.isFetchingNextPage,
    loadMoreHistory: () => {
      void history.fetchNextPage();
    },
    showRemoved,
    setShowRemoved,
    selection,
    open: (input: ListingLifecycleSelection) => {
      if (!query.data || accountChanged) return;
      action.reset();
      // Pin the reviewed account. A reconnect while the dialog is open must
      // reject at the server, never redirect this action to the new account.
      setSelection({ ...input, account: { ...query.data.account } });
    },
    close: () => {
      if (!action.isPending) setSelection(null);
    },
    confirm: () => {
      if (selection) action.mutate(selection);
    },
    check: (sku: string) => check.mutate(sku),
    checking: check.isPending,
    pending: action.isPending,
    ready:
      query.isSuccess &&
      !query.isFetching &&
      history.isSuccess &&
      !accountChanged,
    error: action.error ? errorMessage(action.error) : null,
    readError: accountChanged
      ? "The Walmart connection changed. Refresh the listing feed."
      : query.error
        ? errorMessage(query.error)
        : history.error
          ? errorMessage(history.error)
          : check.error
            ? errorMessage(check.error)
            : null,
  };
}

export function ListingLifecycleMenu({
  sku,
  title,
  control,
  disabled,
  onSelect,
}: {
  sku: string;
  title: string;
  control?: ListingLifecycleView;
  disabled: boolean;
  onSelect(selection: ListingLifecycleSelection): void;
}) {
  if (control?.action === "remove") return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          aria-label={`More actions for ${sku}`}
        >
          <MoreHorizontal className="h-4 w-4" />
          <span className="sr-only">Listing actions</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!control && (
          <DropdownMenuItem
            onSelect={() => onSelect({ sku, title, action: "unpublish" })}
          >
            Unpublish from Walmart
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => onSelect({ sku, title, action: "remove" })}
        >
          Remove from Echelon
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ListingLifecycleStatus({
  control,
}: {
  control: ListingLifecycleView;
}) {
  const label =
    control.state === "retired"
      ? control.action === "remove"
        ? "Removed from Echelon"
        : "Unpublished"
      : control.state === "failed"
        ? "Unpublish needs attention"
        : "Unpublishing";
  return (
    <div className="space-y-1">
      <Badge variant={control.state === "failed" ? "destructive" : "secondary"}>
        {label}
      </Badge>
      {control.message && (
        <p className="text-xs break-words text-muted-foreground">
          {control.message}
        </p>
      )}
    </div>
  );
}

export function ListingLifecycleDialog({
  selection,
  pending,
  error,
  onClose,
  onConfirm,
}: {
  selection: ListingLifecycleSelection | null;
  pending: boolean;
  error: string | null;
  onClose(): void;
  onConfirm(): void;
}) {
  const remove = selection?.action === "remove";
  return (
    <Dialog
      open={selection !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {remove
              ? "Remove listing from Echelon?"
              : "Unpublish from Walmart?"}
          </DialogTitle>
          <DialogDescription>
            {remove
              ? "Unpublish this offer from Walmart, stop future updates, and remove it from this listing feed once Walmart confirms."
              : "Unpublish this offer from Walmart and stop future listing and stock updates. Keep the listing in Echelon."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <div>
            <p className="font-medium break-words">{selection?.title}</p>
            <p className="font-mono text-xs break-all text-muted-foreground">
              {selection?.sku}
            </p>
          </div>
          <p>
            Your catalog product, existing orders, and listing history are kept.
          </p>
          <p className="text-muted-foreground">
            Walmart calls this retiring an item. Confirmation can take up to 48
            hours. The listing stays visible here while it is being unpublished.
          </p>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={pending} onClick={onConfirm}>
            {pending
              ? "Saving…"
              : remove
                ? "Unpublish and remove"
                : "Unpublish from Walmart"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
