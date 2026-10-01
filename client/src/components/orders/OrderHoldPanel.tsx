import { useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, PauseCircle, PlayCircle } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  buildOrderHoldView,
  describeHoldRelease,
  describeReleaseOutcome,
  formatHeldFor,
  requestHoldRelease,
  RELEASE_NEEDS_PERMISSION,
  type HoldReleaseOrder,
  type HoldReleaseTarget,
} from "@/lib/order-hold-release";

// Everything that shows hold state: the Orders list and detail, and the pick queue.
const HOLD_STATE_QUERY_KEYS = [["/api/wms/orders"], ["picking-queue"]];

function releaseTestId(target: HoldReleaseTarget): string {
  return target.kind === "order"
    ? `button-release-order-hold-${target.orderId}`
    : `button-release-line-hold-${target.itemId}`;
}

/** Release button with its own confirmation; releasing makes the work shippable. */
export function HoldReleaseButton({
  target,
  disabled,
  label,
}: {
  target: HoldReleaseTarget;
  disabled: boolean;
  label: string;
}) {
  const [confirming, setConfirming] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const copy = describeHoldRelease(target);

  const release = useMutation({
    mutationFn: () => requestHoldRelease(target),
    onSuccess: ({ released }) => toast(describeReleaseOutcome(target, released)),
    onError: (error: Error) =>
      toast({ title: "Couldn't release hold", description: error.message, variant: "destructive" }),
    onSettled: () => {
      setConfirming(false);
      // Refresh on failure too: a refused release usually means a stale screen.
      for (const queryKey of HOLD_STATE_QUERY_KEYS) queryClient.invalidateQueries({ queryKey });
    },
  });

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="h-8 shrink-0 gap-1 border-emerald-300 text-emerald-700 hover:bg-emerald-50 hover:text-emerald-800"
        disabled={disabled || release.isPending}
        onClick={() => setConfirming(true)}
        data-testid={releaseTestId(target)}
      >
        {release.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlayCircle className="h-3.5 w-3.5" />}
        {label}
      </Button>
      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!release.isPending) setConfirming(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={release.isPending}>Keep on hold</AlertDialogCancel>
            <AlertDialogAction
              disabled={release.isPending}
              onClick={(event) => {
                // Keep the dialog open until the request settles.
                event.preventDefault();
                release.mutate();
              }}
              data-testid={`confirm-${releaseTestId(target)}`}
            >
              {copy.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function HoldRow({
  title,
  detail,
  blockedReason,
  action,
}: {
  title: ReactNode;
  detail: ReactNode;
  blockedReason: string | null;
  action: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex items-start gap-2">
        <PauseCircle className="h-4 w-4 mt-0.5 shrink-0 text-amber-600" />
        <div className="min-w-0">
          <p className="text-sm font-medium break-words">{title}</p>
          {detail && <p className="text-xs text-muted-foreground break-words">{detail}</p>}
          {blockedReason && <p className="text-xs text-amber-700">{blockedReason}</p>}
        </div>
      </div>
      {action}
    </div>
  );
}

/**
 * What is on hold for one order, with a Release for each hold. `showLines` is
 * off in the order detail, where each line already carries its own controls.
 */
export function OrderHoldPanel({ order, showLines = true }: { order: HoldReleaseOrder; showLines?: boolean }) {
  const { hasPermission } = useAuth();
  const view = buildOrderHoldView(order, hasPermission("orders", "hold"));
  const lines = showLines ? view.heldLines : [];
  if (!view.orderHold && !view.statusOnlyHold && lines.length === 0) return null;
  const heldFor = formatHeldFor(view.orderHold?.heldAt, new Date());

  return (
    // Release controls sit inside clickable order cards. Stop clicks here, and
    // events from the portaled confirm dialog that bubble through React.
    <div
      className="rounded-md border border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20 p-3 space-y-3"
      onClick={(event) => event.stopPropagation()}
      data-testid={`hold-panel-${order.id}`}
    >
      {view.orderHold && (
        <HoldRow
          title="Whole order on hold"
          detail={heldFor ? `Held for ${heldFor}` : null}
          blockedReason={view.orderHold.blockedReason}
          action={(
            <HoldReleaseButton
              target={view.orderHold.target}
              disabled={!view.canRelease || view.orderHold.blockedReason !== null}
              label="Release order"
            />
          )}
        />
      )}
      {view.statusOnlyHold && (
        <p className="text-xs text-amber-800">
          On hold by warehouse status, without a hold flag. There is no release for it here.
        </p>
      )}
      {lines.map(({ line, target, blockedReason }) => (
        <HoldRow
          key={line.id}
          title={<><span className="font-mono">{line.sku}</span> · qty {line.quantity}</>}
          detail={line.holdReason ? `${line.name} — ${line.holdReason}` : line.name}
          blockedReason={blockedReason}
          action={(
            <HoldReleaseButton
              target={target}
              disabled={!view.canRelease || blockedReason !== null}
              label="Release line"
            />
          )}
        />
      ))}
      {!view.canRelease && <p className="text-xs text-muted-foreground">{RELEASE_NEEDS_PERMISSION}</p>}
    </div>
  );
}
