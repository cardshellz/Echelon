import { useLocation, useSearch } from "wouter";
import {
  parseProcurementJourney,
  parseProcurementRecord,
  procurementBackHref,
  procurementChildHref,
  procurementRecordHref,
  procurementRecordLabel,
  procurementTabHref,
} from "@/lib/procurement-navigation";

/** URL-backed document context works with browser history, reload and copied links. */
export function useProcurementNavigation() {
  const [path, navigate] = useLocation();
  const search = useSearch();
  const current = parseProcurementRecord(path, search);
  const journey = parseProcurementJourney(search);
  const parent = journey.trail.at(-1) ?? journey.purchase;
  return {
    record: current,
    tab: current?.tab ?? "lines",
    setTab: (tab: string) => {
      const href = procurementTabHref(path, search, tab);
      if (href && tab !== current?.tab) navigate(href);
    },
    childHref: (destination: string, options?: { replaceCurrent?: boolean }) => procurementChildHref(path, search, destination, options),
    backHref: (fallback: string) => procurementBackHref(search, fallback),
    backLabel: parent ? `Back to ${procurementRecordLabel(parent)}` : null,
    purchaseHref: journey.purchase ? procurementRecordHref(journey.purchase) : null,
    purchaseId: journey.purchase?.id ?? null,
  };
}

export type ProcurementNavigation = ReturnType<typeof useProcurementNavigation>;
