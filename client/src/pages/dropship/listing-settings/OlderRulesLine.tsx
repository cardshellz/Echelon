import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { categoriesCardQueryOptions } from "@/lib/dropship-listing-settings-categories";
import {
  olderRulesLineModel,
  type ConversionSummaryFacts,
  type OlderRulesLineModel,
} from "@/lib/dropship-listing-settings-conversion";

export interface OlderRulesLineProps {
  storeConnectionId: number;
  /** The step's summary read: its three older-rules counts decide whether the line shows (D17, 11.1). */
  summary: ConversionSummaryFacts;
  /** The step's banner says more than 10,000 sizes are chosen (a read or a save was refused, D18): the too-large form, no button (K7). */
  tooLarge: boolean;
  /** [See what changes]: the step puts the sheet in the address (`?sheet=convert`, D21). */
  onOpen: () => void;
}

/**
 * "Your store still has older group rules. Move them over to use category
 * settings." [See what changes] (Listing settings PR 11b, plan 5.3, 11.1,
 * D17): one line under the attention strip whenever any of the summary's
 * three older-rules counts is above zero. Its form follows the Category
 * settings card's own read (already made on mount, the same key, so no new
 * read): no chosen product in a Card Shellz category drops the second
 * sentence; over 10,000 chosen sizes it says to choose fewer and has no
 * button (K7), also when a read or a save was refused as too large before the
 * summary says so. Hidden at zero, while the summary loads and after it failed.
 * The dry run itself is read only by the open sheet, never on mount (D18).
 */
export function OlderRulesLine({ storeConnectionId, summary, tooLarge, onOpen }: OlderRulesLineProps) {
  // The card's read, shared by key: it is off while the summary says too large (D18), and the card reports its 422.
  const categories = useQuery(categoriesCardQueryOptions(storeConnectionId, summary));
  const line = olderRulesLineModel(summary, { data: categories.data, error: categories.error }, { tooLarge });
  if (line === null) return null;
  return <OlderRulesLineView line={line} onOpen={onOpen} />;
}

/** The line as its model says (hook-free, so a test can press its button). */
export function OlderRulesLineView({ line, onOpen }: { line: OlderRulesLineModel; onOpen: () => void }) {
  return (
    <div
      role="status"
      data-testid="older-rules-line"
      className="mt-3 flex flex-col gap-2 rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-800 sm:flex-row sm:items-center sm:justify-between"
    >
      <p className="flex min-w-0 items-start gap-2">
        <span aria-hidden="true" className="leading-5 text-amber-600">●</span>
        <span className="min-w-0 break-words">{line.text}</span>
      </p>
      {line.opener && (
        <Button type="button" size="sm" variant="outline" className="min-h-11 shrink-0 self-start sm:min-h-8 sm:self-auto" onClick={onOpen}>
          {line.opener.label}
        </Button>
      )}
    </div>
  );
}
