import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import type { ListingIntentChangeStatus } from "@shared/listing-intent-propagation";
import type { ListingWorkAction } from "@shared/listing-work-action";
import { listingMemberRetirementSchema } from "@shared/types/listing-member-lifecycle";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ListingIntentChangeScope } from "./listing-intent-change-presentation";
import { publicationRequest } from "./api";
import { ListingMemberRecoveryDialog } from "./ListingMemberRecoveryDialog";

export function remainingWorkActions(
  row: ListingIntentChangeStatus,
): ListingWorkAction[] {
  const actions = (row.lifecycle?.members ?? [])
    .filter((member) => member.state !== "settled")
    .flatMap((member) =>
      member.nextActions?.length
        ? member.nextActions
        : [
            {
              owner:
                member.duty === "retirement"
                  ? ("listing_member_retirement" as const)
                  : member.duty === "stock_clear"
                    ? ("stock_publication" as const)
                    : ("listing_mapping" as const),
            },
          ],
    );
  return [
    ...new Map(
      actions.map((action) => [
        action.owner + ":" + (action.operationId ?? ""),
        action,
      ]),
    ).values(),
  ];
}
const labels: Record<ListingWorkAction["owner"], string> = {
  ebay_listing_sync: "View saved listing operation",
  listing_member_retirement: "Review archived member removal",
  stock_publication: "Review stock clearing",
  listing_mapping: "Review listing link",
  channel_listing_update: "View saved listing update",
  channel_listing_publication: "View saved publication",
  dropship_listing_push: "View saved channel operation",
};
export function ListingRemainingWorkDialog({
  row,
  scope,
  canEdit,
  onClose,
  onOpenWork,
}: {
  row: ListingIntentChangeStatus;
  scope: ListingIntentChangeScope;
  canEdit: boolean;
  onClose(): void;
  onOpenWork?(
    row: ListingIntentChangeStatus,
    action: ListingWorkAction,
  ): boolean;
}) {
  const [memberId, setMemberId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const actions = remainingWorkActions(row);
  const members = useQuery({
    queryKey: ["listing-member-history", scope, row.product_id],
    refetchInterval: 10_000,
    enabled: actions.some(
      (action) => action.owner === "listing_member_retirement",
    ),
    queryFn: () =>
      publicationRequest(
        "POST",
        scope.kind === "channel"
          ? `/api/channels/${scope.channelId}/listing-lifecycle/members`
          : `/api/dropship/listings/stores/${scope.storeConnectionId}/listing-lifecycle/members`,
        z.object({ items: z.array(listingMemberRetirementSchema) }),
        { productId: row.product_id },
      ),
  });
  if (memberId)
    return (
      <ListingMemberRecoveryDialog
        scope={scope}
        operationId={memberId}
        canEdit={canEdit}
        onClose={() => setMemberId(null)}
      />
    );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Remaining channel work</DialogTitle>
          <DialogDescription>
            This product remains excluded. Complete or reconcile its saved
            channel operations below.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {row.lifecycle?.members
            .filter((member) => member.state !== "settled")
            .map((member) => (
              <li key={member.productVariantId} className="text-sm">
                <strong>Variant {member.productVariantId}</strong>
                <p>{member.message}</p>
              </li>
            ))}
        </ul>
        {actions.some(
          (action) => action.owner === "listing_member_retirement",
        ) && (
          <Button
            variant="outline"
            disabled={members.isFetching}
            onClick={() => void members.refetch()}
          >
            Refresh removal history
          </Button>
        )}
        {members.error && (
          <p role="alert">
            {members.error instanceof Error
              ? members.error.message
              : "Removal history could not be loaded."}
          </p>
        )}
        {members.data?.items
          .filter((member) => !["retired", "superseded"].includes(member.state))
          .map((member) => (
            <Button
              key={member.operationId}
              variant="outline"
              onClick={() => setMemberId(member.operationId)}
            >
              Review removal:{" "}
              {member.identity.externalSku ??
                "Variant " + member.identity.productVariantId}
            </Button>
          ))}
        {actionMessage && <p role="alert">{actionMessage}</p>}
        <div className="flex flex-wrap gap-2">
          {actions
            .filter((action) => action.owner !== "listing_member_retirement")
            .map((action) => (
              <Button
                key={action.owner + action.operationId}
                variant="outline"
                onClick={() => {
                  if (onOpenWork?.(row, action)) {
                    onClose();
                    return;
                  }
                  if (
                    action.owner === "stock_publication" &&
                    scope.kind === "channel"
                  )
                    window.location.assign(
                      `/channels/inventory?channel=${scope.channelId}&product=${row.product_id}&tab=quantities`,
                    );
                  else if (
                    action.owner === "listing_mapping" &&
                    scope.kind === "channel"
                  )
                    window.location.assign(
                      `/products/${row.product_id}?tab=channels`,
                    );
                  else
                    setActionMessage(
                      "This channel operation is unavailable in the current workspace. Refresh the page to load its saved action.",
                    );
                }}
              >
                {labels[action.owner]}
              </Button>
            ))}
        </div>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </DialogContent>
    </Dialog>
  );
}
