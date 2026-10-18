import { useQuery } from "@tanstack/react-query";
import type { ListingSettingsSummary } from "@shared/dropship/listing-settings";
import { Button } from "@/components/ui/button";
import type { ListingSettingsReadState } from "@/lib/dropship-listing-settings-access";
import {
  conversionNoticeQueryOptions,
  noticeLineModel,
  type ConversionNoticeModel,
} from "@/lib/dropship-listing-settings-conversion-notice";
import { firstConnected } from "./focusTarget";
import { useConversionNoticeGotIt } from "./useConversionNoticeGotIt";

export interface ConversionNoticeLineProps {
  storeConnectionId: number;
  /** The step's summary read: the line hides while the store holds older group rules (D21). */
  summary: ListingSettingsReadState<Pick<ListingSettingsSummary, "storeDefaults">>;
  /** Where focus goes once [Got it] took the line away: the Category settings card's heading, then the step's (11.2). */
  focusFallbacks?: () => readonly (HTMLElement | null | undefined)[];
}

/**
 * "We moved your older group rules. 2 categories and 5 products now have
 * their own settings. Nothing in your listings changed. Products you choose
 * later use their category's settings or your store defaults." [Got it]
 * (Listing settings PR 11e1, plan 9.2, 11.1, 11.3): one line in the strip's
 * slot, where the older-rules line was, after the job moved the store's
 * rules, until someone presses [Got it] on any device. Its read is a mount
 * read (D18) that the server answers over 10,000 sizes too; a read still
 * loading or failed shows nothing. Hidden while the store holds older group
 * rules again (D21). A failed [Got it] keeps the line, with why.
 */
export function ConversionNoticeLine({ storeConnectionId, summary, focusFallbacks }: ConversionNoticeLineProps) {
  const read = useQuery(conversionNoticeQueryOptions(storeConnectionId));
  const gotIt = useConversionNoticeGotIt(storeConnectionId);
  const conversionId = read.data?.notice?.conversionId ?? null;
  const line = noticeLineModel({ data: read.data, error: read.error }, summary,
    conversionId === null ? null : gotIt.failureFor(conversionId));
  if (line === null) return null;

  const onGotIt = async () => {
    const outcome = await gotIt.press(line.conversionId);
    if (outcome === null || outcome.kind === "failed" || typeof document === "undefined") return;
    // The button went with the line: focus moves on rather than falling to the page (11.2, PLAN10 3.4).
    const active = document.activeElement;
    if (active !== null && active !== document.body && active.isConnected) return;
    // The first still on the page: the sheet's own rule (firstConnected).
    firstConnected(focusFallbacks?.() ?? [])?.focus();
  };
  return <ConversionNoticeLineView line={line} sending={gotIt.sending} onGotIt={() => void onGotIt()} />;
}

/** The line as its model says (hook-free, so a test can press its button). */
export function ConversionNoticeLineView({ line, sending, onGotIt }: { line: ConversionNoticeModel; sending: boolean; onGotIt: () => void }) {
  return (
    <div
      data-testid="conversion-notice-line"
      className="mt-3 flex flex-col gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-zinc-800 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="min-w-0 space-y-1">
        <p role="status" className="flex min-w-0 items-start gap-2">
          <span aria-hidden="true" className="leading-5 text-emerald-700">●</span>
          <span className="min-w-0 break-words" data-testid="conversion-notice-text">{line.text}</span>
        </p>
        {line.failure && <p role="alert" className="text-amber-900" data-testid="conversion-notice-failure">{line.failure}</p>}
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="min-h-11 shrink-0 self-start sm:min-h-8 sm:self-auto"
        aria-label={line.gotIt.ariaLabel}
        disabled={sending}
        onClick={onGotIt}
      >
        {line.gotIt.label}
      </Button>
    </div>
  );
}
