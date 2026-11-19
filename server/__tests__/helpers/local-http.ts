import { request as nodeRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";

export interface LocalHttpRequestOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string | Uint8Array | null;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type LocalHttpTransport = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

const DEFAULT_TIMEOUT_MS = 15_000;
// Node clamps longer timers to 1 ms; reject them rather than changing the deadline.
const MAX_TIMEOUT_MS = 2_147_483_647;
const SUPPORTED_OPTIONS = new Set(["method", "headers", "body", "signal", "timeoutMs"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export class LocalHttpRequestError extends Error {
  constructor(public readonly code: "LOCAL_HTTP_TIMEOUT" | "LOCAL_HTTP_RESPONSE_ABORTED" | "LOCAL_HTTP_RESPONSE_ENCODING", message: string) {
    super(message);
    this.name = "LocalHttpRequestError";
  }
}

/**
 * Real HTTP transport for loopback test fixtures. Node's HTTP client has no Fetch
 * unsafe-port filter, so OS-assigned ephemeral ports cannot randomly fail before
 * reaching a route. Responses retain native json/text/clone/header behavior.
 *
 * This intentionally supports buffered, uncompressed HTTP only: no redirects,
 * automatic cookie jar, multipart request bodies or arbitrary RequestInit options.
 * Cookies supplied by fixtures and response Set-Cookie headers are preserved.
 * The transport seam tests blocked logical ports against an owned ephemeral
 * server without reserving a fixed port or changing the global fetch function.
 */
export async function requestLocalHttp(
  input: string | URL,
  options: LocalHttpRequestOptions = {},
  transport: LocalHttpTransport = nodeRequest,
): Promise<Response> {
  const url = new URL(input);
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || !url.port
    || Number(url.port) === 0 || url.username || url.password) {
    throw new TypeError("Local HTTP fixtures require an explicit loopback HTTP port without credentials");
  }
  for (const key of Object.keys(options)) {
    if (!SUPPORTED_OPTIONS.has(key)) throw new TypeError(`Unsupported local HTTP request option: ${key}`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(`Local HTTP timeout must be an integer between 1 and ${MAX_TIMEOUT_MS} ms`);
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    throw new TypeError("Local HTTP signal must be an AbortSignal");
  }
  const method = (options.method ?? "GET").toUpperCase();
  if (options.body != null && typeof options.body !== "string" && !(options.body instanceof Uint8Array)) {
    throw new TypeError("Local HTTP request body must be text or bytes");
  }
  if (options.body != null && (method === "GET" || method === "HEAD")) {
    throw new TypeError("Local HTTP GET/HEAD requests cannot have a body");
  }
  const headers = new Headers(options.headers);
  if (headers.has("accept-encoding") && headers.get("accept-encoding") !== "identity") {
    throw new TypeError("Local HTTP fixtures support only identity response encoding");
  }
  headers.set("accept-encoding", "identity");
  const body = options.body == null ? undefined
    : typeof options.body === "string" ? Buffer.from(options.body, "utf8") : Buffer.from(options.body);
  if (body !== undefined) {
    if (!headers.has("content-length")) headers.set("content-length", String(body.byteLength));
    if (!headers.has("content-type") && typeof options.body === "string") headers.set("content-type", "text/plain;charset=UTF-8");
  }
  if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("The request was aborted", "AbortError");

  return new Promise<Response>((resolve, reject) => {
    let outgoing: ClientRequest | undefined;
    let incoming: IncomingMessage | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      incoming?.destroy();
      outgoing?.destroy();
      reject(error);
    };
    const abort = () => fail(options.signal?.reason ?? new DOMException("The request was aborted", "AbortError"));
    try {
      outgoing = transport(url, { method, headers: Object.fromEntries(headers), agent: false }, response => {
        incoming = response;
        const chunks: Buffer[] = [];
        response.on("error", fail);
        response.once("aborted", () => fail(new LocalHttpRequestError("LOCAL_HTTP_RESPONSE_ABORTED", "Local HTTP fixture ended its response before completion")));
        response.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          if (settled) return;
          try {
            const responseHeaders = new Headers();
            for (let index = 0; index < response.rawHeaders.length; index += 2) {
              responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
            }
            const encoding = responseHeaders.get("content-encoding");
            if (encoding && encoding !== "identity") throw new LocalHttpRequestError("LOCAL_HTTP_RESPONSE_ENCODING", "Local HTTP fixture returned an unsupported compressed response");
            const status = response.statusCode;
            if (status === undefined) throw new Error("Local HTTP fixture did not send a status code");
            const noBody = method === "HEAD" || [204, 205, 304].includes(status);
            const result = new Response(noBody ? null : new Uint8Array(Buffer.concat(chunks)), {
              status, statusText: response.statusMessage, headers: responseHeaders,
            });
            settled = true;
            cleanup();
            resolve(result);
          } catch (error) { fail(error); }
        });
      });
      outgoing.once("error", fail);
      options.signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(new LocalHttpRequestError("LOCAL_HTTP_TIMEOUT", `Local HTTP fixture did not complete within ${timeoutMs} ms`)), timeoutMs);
      // Account for cancellation between the preflight check and listener setup.
      if (options.signal?.aborted) { abort(); return; }
      outgoing.end(body);
    } catch (error) { fail(error); }
  });
}