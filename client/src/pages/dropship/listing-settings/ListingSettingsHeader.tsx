import { useId, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SM_MIN_WIDTH_PX, useMinWidth } from "@/hooks/use-min-width";
import {
  LISTING_SETTINGS_HEADER_WORDS,
  listingSettingsTitle,
  sendTimingLines,
} from "@/lib/dropship-listing-settings-attention";

export interface ListingSettingsHeaderProps {
  storeName: string;
  /** The vendor's eBay stores that are not disconnected; more than one adds "These settings are for <Store> only." */
  ebayStoreCount: number;
}

const LINK_BUTTON = "inline rounded-sm font-medium text-violet-700 underline underline-offset-2 hover:text-violet-900 "
  + "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C060E0]";

/**
 * The top of the Listing settings step (R:87, R:111-114; phone R:420-426):
 * the title, one intro line, and when saved settings reach eBay, with
 * "When is that?" opening the details (a popover, or a bottom sheet on a
 * phone).
 */
export function ListingSettingsHeader({ storeName, ebayStoreCount }: ListingSettingsHeaderProps) {
  const wide = useMinWidth(SM_MIN_WIDTH_PX);
  const lines = sendTimingLines(storeName, ebayStoreCount);
  return (
    <header data-testid="listing-settings-header" className="mt-5">
      <h2 className="text-xl font-semibold text-zinc-900">{listingSettingsTitle(storeName, !wide)}</h2>
      <p className="mt-1 text-sm text-zinc-600">{LISTING_SETTINGS_HEADER_WORDS.intro}</p>
      <p className="mt-1 text-sm text-zinc-600" data-testid="listing-settings-timing">
        {wide ? LISTING_SETTINGS_HEADER_WORDS.timing : LISTING_SETTINGS_HEADER_WORDS.timingPhone}
        {" "}
        {wide ? <WhenIsThatPopover lines={lines} /> : <WhenIsThatSheet lines={lines} />}
      </p>
    </header>
  );
}

function TimingLines({ lines }: { lines: readonly string[] }) {
  return (
    <ul className="space-y-2 text-sm text-zinc-700" data-testid="listing-settings-timing-details">
      {lines.map((line) => <li key={line}>{line}</li>)}
    </ul>
  );
}

function WhenIsThatPopover({ lines }: { lines: readonly string[] }) {
  const titleId = useId();
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={LINK_BUTTON}>{LISTING_SETTINGS_HEADER_WORDS.whenIsThat}</button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80" aria-labelledby={titleId}>
        <p id={titleId} className="mb-2 text-sm font-semibold text-zinc-900">{LISTING_SETTINGS_HEADER_WORDS.whenIsThat}</p>
        <TimingLines lines={lines} />
      </PopoverContent>
    </Popover>
  );
}

function WhenIsThatSheet({ lines }: { lines: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={LINK_BUTTON}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {LISTING_SETTINGS_HEADER_WORDS.whenIsThat}
      </button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          // No description: Radix's aria-describedby would point at nothing (and it warns).
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // The sheet has no Radix trigger, so Radix would send focus to <body>; it goes back to the button.
            const target = triggerRef.current;
            if (!target || !target.isConnected) return;
            event.preventDefault();
            target.focus();
          }}
          className="max-h-[90dvh] overflow-y-auto motion-reduce:animate-none motion-reduce:transition-none"
        >
          <SheetHeader className="pr-8 text-left">
            <SheetTitle className="text-base">{LISTING_SETTINGS_HEADER_WORDS.whenIsThat}</SheetTitle>
          </SheetHeader>
          <div className="mt-3"><TimingLines lines={lines} /></div>
        </SheetContent>
      </Sheet>
    </>
  );
}
