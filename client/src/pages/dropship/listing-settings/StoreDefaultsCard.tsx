import { useId, type ReactNode } from "react";
import { STORE_DEFAULTS_CARD_WORDS } from "@/lib/dropship-listing-settings-drafts";

/**
 * The Store defaults card (R:89): its title, one intro line, the seven rows
 * (`StoreDefaultRow`, passed in record order), anything the step adds under
 * them, and the fixed line "Card Shellz packs and ships every order." (R:583).
 */
export function StoreDefaultsCard({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} data-testid="store-defaults-card" className="rounded-lg border border-zinc-200 bg-white p-4 sm:p-5">
      <h3 id={titleId} className="text-base font-semibold text-zinc-900">{STORE_DEFAULTS_CARD_WORDS.title}</h3>
      <p className="mt-1 text-sm text-zinc-600">{STORE_DEFAULTS_CARD_WORDS.intro}</p>
      <div className="mt-2 divide-y divide-zinc-100" data-testid="store-defaults-rows">{children}</div>
      {footer}
      <p className="mt-3 border-t border-zinc-100 pt-3 text-sm text-zinc-600">{STORE_DEFAULTS_CARD_WORDS.footer}</p>
    </section>
  );
}
