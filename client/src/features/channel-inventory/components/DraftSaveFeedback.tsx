import { Button } from "@/components/ui/button";
import { Callout } from "./primitives";

export function DraftSaveFeedback({ conflict, uncertain, error, onReload, reloading }: {
  conflict: boolean; uncertain: boolean; error: string | null; onReload(): void; reloading: boolean;
}) {
  if (uncertain) return <Callout tone="warning" title="Save outcome unknown">{error}</Callout>;
  if (conflict) return <Callout tone="warning" title="Saved settings changed while you were editing"
    action={<Button type="button" variant="outline" size="sm" disabled={reloading} onClick={onReload}>Discard edits and reload</Button>}>
    Your edits are preserved below, but cannot overwrite the newer version. Reload and review the latest settings before making changes.
  </Callout>;
  return error ? <Callout tone="danger" title="Draft not saved">{error}</Callout> : null;
}
