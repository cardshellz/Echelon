import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  hideConversionNotice,
  rereadConversionNotice,
  runConversionNoticeAcknowledge,
  sendConversionNoticeAcknowledge,
  type ConversionNoticeAcknowledgeOutcome,
} from "@/lib/dropship-listing-settings-conversion-notice";

/** [Got it] as the line and the sheet run it: one press at a time, and the failure of the last one, by the notice it named. */
export interface ConversionNoticeGotIt {
  /** A press is out: the button is off. */
  sending: boolean;
  /** The last press's failure words for this notice; null when it did not fail (or named another notice). */
  failureFor: (conversionId: number) => string | null;
  /** Sends one [Got it] for the notice (nothing while one is out: null then). */
  press: (conversionId: number) => Promise<ConversionNoticeAcknowledgeOutcome | null>;
}

/**
 * The one-time notice's [Got it] (PR 11e1, plan 9.3), shared by the line
 * (`ConversionNoticeLine`) and the older-rules sheet: the lib's runner with
 * the real route and this page's query cache. No draft and no request key
 * (plan 16): the server marks the notice seen by state, so a second press is
 * safe; the hook still sends one at a time, so a double click is one request.
 */
export function useConversionNoticeGotIt(storeConnectionId: number): ConversionNoticeGotIt {
  const queryClient = useQueryClient();
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<{ conversionId: number; message: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const press = useCallback(async (conversionId: number) => {
    if (inFlight.current) return null;
    inFlight.current = true;
    setSending(true);
    setFailure(null);
    try {
      const outcome = await runConversionNoticeAcknowledge({
        storeConnectionId,
        conversionId,
        send: (body) => sendConversionNoticeAcknowledge(storeConnectionId, body),
        hide: () => hideConversionNotice(queryClient, storeConnectionId, conversionId),
        reread: () => rereadConversionNotice(queryClient, storeConnectionId),
      });
      if (mounted.current && outcome.kind === "failed") setFailure({ conversionId, message: outcome.message });
      return outcome;
    } finally {
      inFlight.current = false;
      if (mounted.current) setSending(false);
    }
  }, [queryClient, storeConnectionId]);

  const failureFor = useCallback((conversionId: number) => (failure?.conversionId === conversionId ? failure.message : null), [failure]);
  return { sending, failureFor, press };
}
