import { lookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isPublicIpv4Address } from "../../infrastructure/public-network-address";
import { ProductAssetError } from "./product-asset-errors";
import { MAX_PRODUCT_IMAGE_BYTES, PRODUCT_IMAGE_EXTENSIONS, validateProductImage, type DownloadableProductImage } from "./product-image-download.service";

const MAX_IMAGE_REDIRECTS = 3;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000;
export interface ProductImageTransportDependencies {
  resolve: (hostname: string) => Promise<Array<{ address: string; family: number }>>;
  request: (url: URL, options: RequestOptions & { autoSelectFamily: boolean }, callback: (response: IncomingMessage) => void) => ClientRequest;
  timeoutMs: number;
}
const defaults: ProductImageTransportDependencies = {
  resolve: hostname => lookup(hostname, { family: 4, all: true, verbatim: true }),
  request: (url, options, callback) => (url.protocol === "https:" ? httpsRequest : httpRequest)(url, options, callback),
  timeoutMs: IMAGE_DOWNLOAD_TIMEOUT_MS,
};

function validateUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new ProductAssetError("IMAGE_URL_INVALID", "The image URL is invalid.", 422); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password
    || (url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))) {
    throw new ProductAssetError("IMAGE_URL_BLOCKED", "Images must use a public HTTP or HTTPS URL on its standard port.", 422);
  }
  return url;
}

export async function fetchProductImage(rawUrl: string, dependencies: ProductImageTransportDependencies = defaults): Promise<DownloadableProductImage> {
  const controller = new AbortController();
  const timeoutError = new ProductAssetError("IMAGE_DOWNLOAD_TIMEOUT", "The image source took too long. Try again.", 504);
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs);
  try {
    let url = validateUrl(rawUrl);
    for (let redirects = 0; redirects <= MAX_IMAGE_REDIRECTS; redirects++) {
      if (controller.signal.aborted) throw timeoutError;
      let onAbort: (() => void) | undefined;
      const addresses = await Promise.race([
        dependencies.resolve(url.hostname),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(timeoutError);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]).finally(() => { if (onAbort) controller.signal.removeEventListener("abort", onAbort); });
      if (controller.signal.aborted) throw timeoutError;
      if (!addresses.length || addresses.some(({ address, family }) => family !== 4 || !isPublicIpv4Address(address))) {
        throw new ProductAssetError("IMAGE_ADDRESS_BLOCKED", "The image source must resolve to a public internet address.", 422);
      }
      const result = await new Promise<DownloadableProductImage | { redirect: string }>((resolve, reject) => {
        // Pin the verified IP so the socket cannot resolve a different, private address.
        // The original hostname still supplies Host and TLS certificate verification.
        const req = dependencies.request(url, {
          method: "GET", agent: false, family: 4, autoSelectFamily: false, rejectUnauthorized: true,
          signal: controller.signal,
          lookup: (_hostname, _options, callback) => callback(null, addresses[0].address, 4),
          headers: { Accept: "image/jpeg,image/png,image/webp,image/gif", "Accept-Encoding": "identity" },
        }, response => {
          const status = response.statusCode ?? 0;
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.destroy(); resolve({ redirect: response.headers.location }); return;
          }
          if (status !== 200) {
            response.destroy(); reject(new ProductAssetError("IMAGE_SOURCE_UNAVAILABLE", "The image source could not provide the photo. Try again later.", 502)); return;
          }
          const mimeType = String(response.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
          if (!Object.hasOwn(PRODUCT_IMAGE_EXTENSIONS, mimeType)) {
            response.destroy(); reject(new ProductAssetError("IMAGE_FORMAT_UNSUPPORTED", "The source did not return a supported image.", 422)); return;
          }
          const tooLarge = () => new ProductAssetError("IMAGE_TOO_LARGE", "The image exceeds the 10 MB download limit.", 413);
          if (Number(response.headers["content-length"]) > MAX_PRODUCT_IMAGE_BYTES) {
            response.destroy(); reject(tooLarge()); return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_PRODUCT_IMAGE_BYTES) { response.destroy(); reject(tooLarge()); }
            else chunks.push(chunk);
          });
          response.on("error", () => reject(controller.signal.aborted ? timeoutError
            : new ProductAssetError("IMAGE_DOWNLOAD_INTERRUPTED", "The download was interrupted. Try again.", 502)));
          response.on("end", () => resolve({ data: Buffer.concat(chunks), mimeType }));
        });
        req.on("error", () => reject(controller.signal.aborted ? timeoutError
          : new ProductAssetError("IMAGE_SOURCE_UNAVAILABLE", "Could not connect to the image source. Try again.", 502)));
        req.end();
      });
      if (!("redirect" in result)) return validateProductImage(result);
      url = validateUrl(new URL(result.redirect, url).href);
    }
    throw new ProductAssetError("IMAGE_REDIRECT_LIMIT", "The image source redirected too many times.", 502);
  } catch (error) {
    if (error instanceof ProductAssetError) throw error;
    throw new ProductAssetError("IMAGE_SOURCE_UNAVAILABLE", "Could not download the image from its source. Try again.", 502);
  } finally { clearTimeout(timer); }
}
