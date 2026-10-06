import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuardedLink } from "./UnsavedChangesGuard";

export interface CatalogNextStepAction {
  label: string;
  href: string;
  disabled: boolean;
}

/** Bottom of every step: what the vendor is working on, and the step's one way forward (asks first when changes aren't saved). */
export function CatalogActionBar({ next, summary }: { summary: string; next: CatalogNextStepAction | null }) {
  return (
    <div
      className="sticky bottom-0 z-20 -mx-4 mt-6 border-t border-zinc-200 bg-white/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
      data-testid="catalog-action-bar"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm text-zinc-700" data-testid="catalog-action-summary">{summary}</p>
        {next && (next.disabled ? (
          <Button type="button" disabled className="shrink-0 gap-2">
            {next.label}
            <ArrowRight className="h-4 w-4" />
          </Button>
        ) : (
          <Button asChild className="shrink-0 gap-2 bg-[#C060E0] hover:bg-[#a94bc9]">
            <GuardedLink href={next.href}>
              {next.label}
              <ArrowRight className="h-4 w-4" />
            </GuardedLink>
          </Button>
        ))}
      </div>
    </div>
  );
}
