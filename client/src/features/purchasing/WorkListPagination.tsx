import { Button } from "@/components/ui/button";

export function WorkListPagination({ page, busy, onOffset, label }: {
  page?: { total: number; limit: number; offset: number; nextOffset: number | null };
  busy: boolean; onOffset: (offset: number) => void; label: string;
}) {
  if (!page) return null;
  return <nav aria-label={`${label} pages`} className="flex flex-wrap items-center justify-between gap-2 p-3 border-t">
    <span className="text-sm text-muted-foreground" aria-live="polite">{page.total === 0 ? "0" : page.offset >= page.total ? "0" : `${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)}`} of {page.total} {label}</span>
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={busy || page.offset === 0} onClick={() => onOffset(Math.max(0, page.offset - page.limit))}>Previous</Button>
      <Button size="sm" variant="outline" disabled={busy || page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) onOffset(page.nextOffset); }}>Next</Button>
    </div>
  </nav>;
}
