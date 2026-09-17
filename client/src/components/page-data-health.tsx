import { useCallback, useState, useSyncExternalStore } from "react";
import { useQueryClient, type Query } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

export function isUnhandledPageReadFailure(query: Query): boolean {
  return query.isActive() && query.state.status === "error" && query.meta?.handlesLoadError !== true;
}

/** App-wide fallback for screens that have not adopted an inline error state.
 * Only mounted, enabled queries count: failures on a previous page must not
 * follow the user around. Never display payloads, URLs or customer data here.
 */
export function PageDataHealth() {
  const client = useQueryClient();
  const cache = client.getQueryCache();
  const subscribe = useCallback((changed: () => void) => cache.subscribe(changed), [cache]);
  const snapshot = useCallback(() => cache.findAll({ predicate: isUnhandledPageReadFailure }).length > 0, [cache]);
  const hasFailure = useSyncExternalStore(subscribe, snapshot, () => false);
  const [retrying, setRetrying] = useState(false);
  if (!hasFailure) return null;

  return (
    <div role="alert" className="m-3 rounded-md border border-destructive/40 bg-background p-4 space-y-2">
      <p className="font-medium">Some data on this page could not be loaded.</p>
      <p className="text-sm text-muted-foreground">Empty lists and zero counts may be incomplete. Previously loaded information may be out of date.</p>
      <Button variant="outline" disabled={retrying} onClick={async () => {
        setRetrying(true);
        try {
          // React Query records any repeated failure; it remains visible here.
          await client.refetchQueries({ predicate: isUnhandledPageReadFailure });
        } finally {
          setRetrying(false);
        }
      }}>{retrying ? "Retrying…" : "Retry failed loads"}</Button>
    </div>
  );
}
