import { useState } from "react";
import type { ListingIntentChangeScope } from "./listing-intent-change-presentation";
import { useQuery } from "@tanstack/react-query";
import {
  listingMemberRecoveryCommandSchema,
  listingMemberRecoveryReviewSchema,
  listingMemberRetirementSchema,
} from "@shared/types/listing-member-lifecycle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { publicationRequest, PublicationRequestError } from "./api";

type Command = ReturnType<typeof listingMemberRecoveryCommandSchema.parse>;
export function ListingMemberRecoveryDialog({
  scope,
  operationId,
  canEdit,
  onClose,
}: {
  scope: ListingIntentChangeScope;
  operationId: string;
  canEdit: boolean;
  onClose(): void;
}) {
  const base =
    scope.kind === "channel"
      ? `/api/channels/${scope.channelId}/listing-lifecycle/members/recovery`
      : `/api/dropship/listings/stores/${scope.storeConnectionId}/listing-lifecycle/members/recovery`;
  const storageKey = `listing-member-recovery:${base}:${operationId}`;
  const [command, setCommand] = useState<Command | null>(() => {
    try {
      return listingMemberRecoveryCommandSchema.parse(
        JSON.parse(sessionStorage.getItem(storageKey) ?? "null"),
      );
    } catch {
      return null;
    }
  });
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState<string | null>(null);
  const review = useQuery({
    queryKey: [base, operationId],
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: () =>
      publicationRequest("POST", base, listingMemberRecoveryReviewSchema, {
        operationId,
      }),
  });
  async function resume() {
    if (!canEdit || busy || (!command && !review.data?.canResume)) return;
    const request = command ?? {
      operationId,
      reviewHash: review.data!.reviewHash,
      commandKey: crypto.randomUUID(),
    };
    // Keep the exact command through lost responses, closing and reopening.
    // Storage failure prevents dispatch rather than losing retry identity.
    try {
      sessionStorage.setItem(storageKey, JSON.stringify(request));
    } catch {
      setMessage(
        "Recovery could not be saved in this browser. Enable session storage before continuing.",
      );
      return;
    }
    setCommand(request);
    setBusy(true);
    setMessage(null);
    try {
      await publicationRequest(
        "POST",
        base + "/resume",
        listingMemberRetirementSchema,
        request,
      );
      sessionStorage.removeItem(storageKey);
      setCommand(null);
      setMessage(
        "Recovery saved. The listing lifecycle will verify the exact archived member and complete its removal.",
      );
      await review.refetch();
    } catch (error) {
      if (
        error instanceof PublicationRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408
      ) {
        sessionStorage.removeItem(storageKey);
        setCommand(null);
      }
      setMessage(
        error instanceof Error
          ? error.message
          : "The recovery result could not be read. Retry the saved request.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Archived member removal recovery</DialogTitle>
          <DialogDescription>
            Review the exact saved channel member before authorizing another
            removal attempt.
          </DialogDescription>
        </DialogHeader>
        {review.isPending && <p role="status">Checking the saved member...</p>}
        {review.error && (
          <p role="alert">
            {review.error instanceof Error
              ? review.error.message
              : "The member could not be checked."}
          </p>
        )}
        {review.data && (
          <div className="space-y-2 text-sm">
            <p>
              SKU:{" "}
              <strong>
                {review.data.record.identity.externalSku ??
                  "Saved SKU unavailable"}
              </strong>
            </p>
            <p>{review.data.message}</p>
            <p className="text-xs text-muted-foreground">
              Earlier dispatches and this recovery decision remain in the
              operation history.
            </p>
          </div>
        )}
        {message && <p role="status">{message}</p>}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || review.isFetching}
            onClick={() => void review.refetch()}
          >
            Refresh review
          </Button>
          {canEdit && (
            <Button
              disabled={busy || (!command && !review.data?.canResume)}
              onClick={() => void resume()}
            >
              {busy
                ? "Saving recovery..."
                : command
                  ? "Retry saved recovery"
                  : "Authorize removal recovery"}
            </Button>
          )}
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Close
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
