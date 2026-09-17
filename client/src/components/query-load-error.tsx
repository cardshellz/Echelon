import { Button } from "@/components/ui/button";

/** A failed read is unknown, never evidence that the list is empty. */
export function QueryLoadError({ subject, retry, refreshing = false, stale = false }: {
  subject: string;
  retry: () => void;
  refreshing?: boolean;
  stale?: boolean;
}) {
  return (
    <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-4 space-y-2">
      <p className="font-medium">Could not load {subject}.</p>
      <p className="text-sm text-muted-foreground">
        {stale ? "The information below is from the last successful load and may be out of date." : "The current list is unavailable. This does not mean there are no records."}
      </p>
      <Button variant="outline" onClick={retry} disabled={refreshing}>
        {refreshing ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
}
