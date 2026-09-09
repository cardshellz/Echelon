import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getJson } from "./pricing-programs/api";
interface Entry {
  actorId: string;
  createdAt: string;
  before: unknown;
  after: { revision?: number };
}
export function ConfigurationHistory({ resourceKey }: { resourceKey: string }) {
  const [open, setOpen] = useState(false);
  const url = `/api/shipping/admin/configuration-history?key=${encodeURIComponent(resourceKey)}`;
  const query = useQuery({
    queryKey: [url],
    queryFn: () => getJson<Entry[]>(url),
    enabled: open,
  });
  return (
    <details
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="text-sm"
    >
      <summary className="cursor-pointer text-muted-foreground">
        Change history
      </summary>
      {query.isLoading && <p>Loading history…</p>}
      {query.isError && <p role="alert">History could not be loaded.</p>}
      <div className="max-h-56 overflow-auto space-y-2 py-2">
        {query.data?.map((entry, index) => (
          <details
            key={`${entry.createdAt}:${index}`}
            className="rounded border p-2"
          >
            <summary className="cursor-pointer">
              Revision {entry.after.revision ?? "—"} ·{" "}
              {new Date(entry.createdAt).toLocaleString()} · {entry.actorId}
            </summary>
            <pre className="overflow-auto p-2 text-xs">
              {JSON.stringify(
                { before: entry.before, after: entry.after },
                null,
                2,
              )}
            </pre>
          </details>
        ))}
        {query.data?.length === 0 && (
          <p className="text-muted-foreground">
            No admin edits yet. Initial configuration was migrated.
          </p>
        )}
      </div>
    </details>
  );
}
