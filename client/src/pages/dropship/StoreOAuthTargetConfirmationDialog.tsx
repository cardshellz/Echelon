import { AlertTriangle, Store } from "lucide-react";
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
import type {
  DropshipStoreOAuthIntent,
  DropshipStorePlatform,
} from "@/lib/dropship-ops-surface";

export interface StoreOAuthConfirmationTarget {
  storeConnectionId: number;
  platform: DropshipStorePlatform;
  displayName: string;
  externalAccountId: string | null;
}

export function storeOAuthTargetConfirmationCopy(
  target: StoreOAuthConfirmationTarget,
  intent: Extract<DropshipStoreOAuthIntent, "refresh_connection" | "change_store">,
): {
  actionLabel: string;
  platformName: string;
  reconnecting: boolean;
  title: string;
} {
  const platformName = target.platform === "ebay" ? "eBay" : "Shopify";
  const reconnecting = intent === "refresh_connection";
  return {
    actionLabel: reconnecting
      ? `Continue to ${platformName} for ${target.displayName}`
      : `Continue to ${platformName} to choose a different store`,
    platformName,
    reconnecting,
    title: reconnecting
      ? `Reconnect ${target.displayName}`
      : `Replace ${target.displayName} with a different ${platformName} store?`,
  };
}

export function StoreOAuthTargetConfirmationDialog({
  intent,
  onCancel,
  onConfirm,
  open,
  target,
}: {
  intent: Extract<DropshipStoreOAuthIntent, "refresh_connection" | "change_store">;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  target: StoreOAuthConfirmationTarget;
}) {
  const { actionLabel, platformName, reconnecting, title } = storeOAuthTargetConfirmationCopy(target, intent);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4 text-left">
              <p>
                {reconnecting
                  ? `This authorization can refresh only the connected ${platformName} store shown below. It cannot replace that store.`
                  : `This action allows a different ${platformName} seller account to replace the connected store shown below.`}
              </p>
              <div className="rounded-md border border-violet-200 bg-violet-50 p-3 text-violet-950">
                <div className="flex items-start gap-3">
                  <Store className="mt-0.5 h-4 w-4 shrink-0" />
                  <div className="min-w-0">
                    <div className="text-xs font-medium uppercase tracking-wide text-violet-700">
                      {reconnecting ? "Store to reconnect" : "Store being replaced"}
                    </div>
                    <div className="mt-1 break-words font-semibold">{target.displayName}</div>
                    {target.externalAccountId && (
                      <div className="mt-1 break-all text-xs text-violet-800">
                        {platformName} account ID {target.externalAccountId}
                      </div>
                    )}
                  </div>
                </div>
              </div>
              {target.platform === "ebay" && (
                <div className="flex items-start gap-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-950">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <p>
                    {reconnecting
                      ? `eBay may already have another seller signed in. On eBay, verify that you are authorizing the account that owns ${target.displayName}. If another account appears, sign out there and use the correct account.`
                      : "eBay may already have a seller signed in. Verify the seller identity on eBay before approving the replacement."}
                  </p>
                </div>
              )}
              {reconnecting && (
                <p className="text-xs">
                  Echelon will reject a different seller account and will not save its credentials.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className="bg-[#C060E0] hover:bg-[#a94bc9]" onClick={onConfirm}>
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
