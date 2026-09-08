import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIPv4 } from "node:net";
import { canonicalJson } from "@shared/utils/canonical-json";
import { COST_REPORT_ACK_MAX_BYTES, COST_REPORT_MAX_BYTES, costReportEnvelopeSchema, type CostReportAcknowledgement, type CostReportEnvelope } from "@shared/procurement/cost-report-delivery";
import { COST_REPORT_TIMEOUT_MS, CostReportingError, verifyReportAcknowledgement, type ReportTransportConfiguration } from "./cost-reporting.domain";

/** Deliberately IPv4-only until an equally strict IPv6 policy is supported.
 * DNS is resolved once and the selected public address is pinned to this TLS
 * request; checking DNS and then allowing the HTTP client to resolve again is unsafe. */
export function isPublicReportAddress(address: string): boolean {
  if (!isIPv4(address)) return false;
  const [a,b,c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
export interface CostReportHttpDependencies {
  resolve: (hostname: string) => Promise<Array<{address: string; family: number}>>;
  request: typeof request;
  timeoutMs: number;
}
const defaults: CostReportHttpDependencies = {
  resolve: (hostname) => lookup(hostname,{family:4,all:true,verbatim:true}), request, timeoutMs:COST_REPORT_TIMEOUT_MS,
};
export async function sendCostReport(configuration: ReportTransportConfiguration, raw: CostReportEnvelope,
  dependencies: CostReportHttpDependencies = defaults): Promise<CostReportAcknowledgement> {
  const envelope = costReportEnvelopeSchema.parse(raw);
  if (!configuration.enabled || envelope.destinationId !== configuration.id || envelope.sourceSystemId !== configuration.sourceSystemId) {
    throw new CostReportingError("COST_REPORT_BINDING_CONFLICT","Report delivery is disabled or the destination does not match.");
  }
  const url = new URL(configuration.endpoint), body = canonicalJson(envelope);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.port && url.port !== "443")) throw new CostReportingError("COST_REPORT_DESTINATION_INVALID","A secure reporting destination is required.");
  if (Buffer.byteLength(body) > COST_REPORT_MAX_BYTES) throw new CostReportingError("COST_REPORT_TOO_LARGE","The report exceeds the supported transport size.");
  const controller = new AbortController();
  const timeoutError = new CostReportingError("COST_REPORT_TIMEOUT","The receiver did not acknowledge the report within the delivery timeout.",true,503);
  const timer = setTimeout(() => controller.abort(timeoutError),dependencies.timeoutMs);
  let rejectAbort: (() => void) | undefined;
  try {
    const addresses = await Promise.race([dependencies.resolve(url.hostname),new Promise<never>((_,reject) => {
      rejectAbort = () => reject(timeoutError); controller.signal.addEventListener("abort",rejectAbort,{once:true});
    })]);
    if (!addresses.length || addresses.some(({address,family}) => family !== 4 || !isPublicReportAddress(address))) throw new CostReportingError("COST_REPORT_ADDRESS_BLOCKED","The reporting host must resolve exclusively to public IPv4 addresses.");
    if (controller.signal.aborted) throw timeoutError;
    const address = addresses[0].address;
    const response = await new Promise<unknown>((resolve,reject) => {
      const req = dependencies.request(url,{
        method:"POST",agent:false,family:4,servername:url.hostname,rejectUnauthorized:true,signal:controller.signal,
        lookup: (_hostname,_options,callback) => callback(null,address,4),
        headers:{"content-type":"application/json","accept":"application/json","content-length":Buffer.byteLength(body),authorization:`Bearer ${configuration.token}`},
      },(res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.destroy();
          const retryable = status === 408 || status === 429 || status >= 500;
          reject(new CostReportingError(`COST_REPORT_HTTP_${status}`,`The receiver rejected report delivery (HTTP ${status}).`,retryable,503)); return;
        }
        if (!/^application\/json(?:\s*;|$)/i.test(String(res.headers["content-type"] ?? ""))) {
          res.destroy(); reject(new CostReportingError("COST_REPORT_ACK_INVALID","The receiver did not return a JSON acknowledgement.")); return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on("data",(chunk: Buffer) => {
          size += chunk.length;
          if (size > COST_REPORT_ACK_MAX_BYTES) { res.destroy(); reject(new CostReportingError("COST_REPORT_ACK_TOO_LARGE","The receiver acknowledgement exceeds the supported size.")); }
          else chunks.push(chunk);
        });
        res.on("error",() => reject(new CostReportingError("COST_REPORT_RESPONSE_INTERRUPTED","The acknowledgement was interrupted; retry the retained report.",true,503)));
        res.on("end",() => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new CostReportingError("COST_REPORT_ACK_INVALID","The receiver acknowledgement is not valid JSON.")); } });
      });
      req.on("error",() => reject(controller.signal.aborted ? timeoutError : new CostReportingError("COST_REPORT_CONNECTION_FAILED","A secure connection to the receiver could not be completed.",true,503)));
      req.end(body);
    });
    return verifyReportAcknowledgement(response,envelope);
  } finally { clearTimeout(timer); if (rejectAbort) controller.signal.removeEventListener("abort",rejectAbort); }
}
