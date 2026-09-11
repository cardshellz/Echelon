import { openingCaptureChunkSchema, openingCaptureStatusSchema, type OpeningCaptureStatus } from "@shared/types/inventory-opening-capture";
import { openingSourceSchema, type OpeningSource } from "@shared/types/inventory-cutover-opening";

const ROOT = "/api/inventory-planning/admin/cutover-opening/captures";
const POLL_MS = 2_000;
const MAX_WAIT_MS = 12 * 60_000;

async function responseJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      && body.error && typeof body.error === "object" && "message" in body.error
      && typeof body.error.message === "string" ? body.error.message : `Capture request failed (HTTP ${response.status}).`;
    throw new Error(message);
  }
  return body;
}
function pause(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException("Capture view closed", "AbortError")); return; }
    const abort = () => { clearTimeout(timer); reject(new DOMException("Capture view closed", "AbortError")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort",abort); resolve(); },POLL_MS);
    signal?.addEventListener("abort",abort,{ once:true });
  });
}

/** Only status/chunks cross the web dyno. The browser validates the COMPLETE
 * reassembled source before displaying or exporting any verification worksheet. */
export async function fetchBackgroundOpeningSource(idempotencyKey: string,
  onProgress: (message: string) => void, signal?: AbortSignal): Promise<OpeningSource> {
  const started = Date.now();
  let status: OpeningCaptureStatus = openingCaptureStatusSchema.parse(await responseJson(await fetch(ROOT, {
    method:"POST", credentials:"include", signal, headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ idempotencyKey }),
  })));
  const captureId = status.id;
  while (status.state === "queued" || status.state === "running") {
    onProgress(`Capture ${status.state}: ${status.stage.replaceAll("_"," ")}`);
    if (Date.now()-started > MAX_WAIT_MS) throw new Error("Capture is taking longer than expected. No partial source is available. Retry to check the same capture.");
    await pause(signal);
    status = openingCaptureStatusSchema.parse(await responseJson(await fetch(`${ROOT}/${captureId}`,{ credentials:"include",signal })));
    if (status.id !== captureId) throw new Error("Capture identity changed. No partial source is available.");
  }
  if (status.state !== "complete" || status.chunkCount === 0) throw new Error(`Capture failed (${status.errorCode ?? "INCOMPLETE"}). No partial source is available; start a new capture.`);
  const chunks: string[] = [];
  for (let index=0; index<status.chunkCount; index++) {
    onProgress(`Loading completed snapshot: ${index+1} of ${status.chunkCount} parts`);
    const chunk = openingCaptureChunkSchema.parse(await responseJson(await fetch(`${ROOT}/${captureId}/chunks/${index}`,{ credentials:"include",signal })));
    if (chunk.captureId !== captureId || chunk.index !== index) throw new Error("Capture chunk identity changed. No partial source is available.");
    chunks.push(chunk.text);
  }
  const source = openingSourceSchema.parse(JSON.parse(chunks.join("")));
  onProgress("Capture complete; recorded values are not independently verified counts.");
  return source;
}
