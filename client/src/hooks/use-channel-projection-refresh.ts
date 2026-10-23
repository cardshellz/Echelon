import { useEffect, useRef } from "react";
import { useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";

const pending = new WeakMap<QueryClient, Map<string, { again: boolean; promise: Promise<void> }>>();

/** Multiple progress surfaces share one refresh owner. Never cancel an HTTP
 * read whose server-side database work is still running. Keep one follow-up
 * when a newer completion arrives during that read. */
export function refreshChannelProjection(client: QueryClient, queryKey: QueryKey): Promise<void> {
  let requests = pending.get(client);
  if (!requests) { requests = new Map(); pending.set(client, requests); }
  const key = JSON.stringify(queryKey);
  const current = requests.get(key);
  if (current) { current.again = true; return current.promise; }
  const request = { again: false, promise: Promise.resolve() };
  requests.set(key, request);
  request.promise = (async () => {
    // A read already in flight may have started before the changed projection.
    // Wait for it, then make one current read rather than aborting it.
    if (client.isFetching({ queryKey, exact: true })) {
      await client.refetchQueries({ queryKey, exact: true }, { cancelRefetch: false });
    }
    do {
      request.again = false;
      await client.invalidateQueries({ queryKey, exact: true }, { cancelRefetch: false });
    } while (request.again);
  })().finally(() => requests.delete(key));
  return request.promise;
}

export function useChannelProjectionRefresh(revision: string | undefined, queryKeys: readonly QueryKey[]): void {
  const client = useQueryClient();
  const previous = useRef<string | undefined>(undefined);
  const keys = JSON.stringify(queryKeys);
  useEffect(() => {
    if (revision === undefined) return;
    const changed = previous.current !== undefined && previous.current !== revision;
    previous.current = revision;
    if (changed) for (const queryKey of JSON.parse(keys) as QueryKey[]) {
      void refreshChannelProjection(client, queryKey);
    }
  }, [client, revision, keys]);
}
