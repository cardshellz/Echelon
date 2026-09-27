import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  createPortalPolicyDraft,
  type PortalPolicyChannel,
  type PortalPolicyDraft,
} from "@/lib/customer-return-policy-setup";

export function CustomerReturnPolicySetupDialog({
  channel,
  previousPolicy,
  saving,
  onClose,
  onSave,
}: {
  channel: PortalPolicyChannel;
  previousPolicy: { name: string; version: number } | null;
  saving: boolean;
  onClose: () => void;
  onSave: (
    draft: PortalPolicyDraft,
    idempotencyKey: string,
  ) => Promise<unknown>;
}) {
  // The immutable reviewed payload and key survive a failed-response retry.
  const [intent] = useState(() => ({
    draft: createPortalPolicyDraft(channel),
    key: crypto.randomUUID(),
  }));
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (saving) return;
    setError(null);
    try {
      await onSave(intent.draft, intent.key);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The policy was not confirmed. Retry to check the same request.",
      );
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Review customer return policy</DialogTitle>
          <DialogDescription>
            These are the rules required by the current Shopify returns portal.
            Review them before creating an active policy version.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm">
          <dt className="text-muted-foreground">Policy</dt>
          <dd>{intent.draft.name}</dd>
          <dt className="text-muted-foreground">Applies to</dt>
          <dd>{channel.name} sales channel</dd>
          <dt className="text-muted-foreground">Return window</dt>
          <dd>{intent.draft.returnWindowDays} days from the order date</dd>
          <dt className="text-muted-foreground">Return postage</dt>
          <dd>Paid by Card Shellz, labels through ShipStation</dd>
          <dt className="text-muted-foreground">Receiving</dt>
          <dd>Return to Card Shellz; inspection required</dd>
          <dt className="text-muted-foreground">Refunds</dt>
          <dd>Portal returns: staff confirm and manually refund in Shopify</dd>
          <dt className="text-muted-foreground">Other rules</dt>
          <dd>No returnless refunds or vendor settlement</dd>
        </dl>
        <div className="rounded-md border bg-muted/40 p-3 text-sm">
          {previousPolicy ? (
            <p>
              Creating this version replaces{" "}
              <strong>
                {previousPolicy.name} · version {previousPolicy.version}
              </strong>{" "}
              as the active policy for this sales channel. The previous version
              remains in history.
            </p>
          ) : (
            <p>
              Creating this version makes it the active policy for this sales
              channel.
            </p>
          )}
          <p className="mt-2">
            This applies to future returns using this channel policy, including
            staff-created returns. Creating it does not enable labels or open
            customer access.
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          After creation, return to Label settings, refresh, and choose this
          policy. Your unsaved label settings stay in that tab.
        </p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error} Retry here to check the same request. If you leave this
            page, refresh the policy list before creating another version.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={saving} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={saving} onClick={() => void save()}>
            {saving ? "Creating…" : "Create portal policy version"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
