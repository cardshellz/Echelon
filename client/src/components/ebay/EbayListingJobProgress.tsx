import { presentEbayListingJob } from "@shared/ebay-listing-progress";
import type { EbayListingSyncJob } from "@shared/types/ebay-listing-sync";

/** Both listing surfaces render the same server evidence. This component never
 * polls, changes a job, or infers completion from a stage or elapsed time. */
export function EbayListingJobProgress({ job, label, detail }: {
  job: EbayListingSyncJob; label?: string; detail?: string | null;
}) {
  const presentation = presentEbayListingJob(job);
  return <div role="status" aria-label={label} className="space-y-1 text-sm min-w-0">
    <p className="font-medium break-words">{presentation.summary}</p>
    {presentation.phase && <p className="break-words">Last recorded step: {presentation.phase}</p>}
    {presentation.verification && <p className="text-muted-foreground break-words">{presentation.verification}</p>}
    {presentation.activity && <p>{presentation.activity}</p>}
    {detail && job.state !== "completed" && <p className="text-muted-foreground break-words">{detail}</p>}
    {presentation.times.map(({ label: timeLabel, at }) => <p key={timeLabel} className="text-xs text-muted-foreground">
      {timeLabel}: <time dateTime={at}>{new Date(at).toLocaleString()}</time>
    </p>)}
  </div>;
}
