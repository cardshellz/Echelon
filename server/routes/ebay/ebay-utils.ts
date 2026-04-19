import { eq } from "drizzle-orm";
import { createInventoryAtpService } from "../../modules/inventory/atp.service";
import https from "https";
import { db } from "../../db";
export const atpService = createInventoryAtpService(db);
import { channelConnections } from "@shared/schema";
import { EbayAuthService, createEbayAuthConfig } from "../../modules/channels/adapters/ebay/ebay-auth.service";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EBAY_CHANNEL_ID = 67;
export const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------------------------------------------------------------------
// Category tree cache (module-level, 1-hour TTL)
// ---------------------------------------------------------------------------

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const categoryTreeCache: Map<string, CacheEntry<any>> = new Map();

export function getCached<T>(key: string): T | null {
  const entry = categoryTreeCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    categoryTreeCache.delete(key);
    return null;
  }
  return entry.data as T;
}

export function setCache<T>(key: string, data: T): void {
  categoryTreeCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function getAuthService(): EbayAuthService | null {
  try {
    const config = createEbayAuthConfig();
    return new EbayAuthService(db as any, config);
  } catch {
    return null;
  }
}

export async function getChannelConnection() {
  const [conn] = await (db as any)
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, EBAY_CHANNEL_ID))
    .limit(1);
  return conn || null;
}

// ---------------------------------------------------------------------------
// XML Helper
// ---------------------------------------------------------------------------

export function escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&'"]/g, function (c) {
        switch (c) {
            case '<': return '&lt;';
            case '>': return '&gt;';
            case '&': return '&amp;';
            case '\'': return '&apos;';
            case '"': return '&quot;';
        }
        return c;
    });
}

// ---------------------------------------------------------------------------
// eBay REST API helper (uses https module, not fetch)
// ---------------------------------------------------------------------------

export function ebayApiRequest(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
  retryCount = 0,
): Promise<any> {
  const environment = process.env.EBAY_ENVIRONMENT || "production";
  const hostname =
    environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        // Handle 429 rate limiting with retry
        if (res.statusCode === 429 && retryCount < 3) {
          const retryAfter = parseInt(res.headers["retry-after"] || "30", 10);
          const waitMs = retryAfter * 1000;
          console.log(`[eBay API] Rate limited (429), waiting ${retryAfter}s before retry ${retryCount + 1}/3...`);
          setTimeout(() => {
            ebayApiRequest(method, path, accessToken, body, retryCount + 1)
              .then(resolve)
              .catch(reject);
          }, waitMs);
          return;
        }
        if (res.statusCode === 204) {
          resolve(undefined);
          return;
        }
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(data ? JSON.parse(data) : undefined);
          } catch {
            resolve(data);
          }
          return;
        }
        reject(
          new Error(
            `eBay API ${method} ${path} failed (${res.statusCode}): ${data.substring(0, 1000)}`,
          ),
        );
      });
    });

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export async function ebayApiRequestWithRateNotify(
  method: string,
  path: string,
  accessToken: string,
  body?: unknown,
  onRateLimit?: (waitSeconds: number) => void,
): Promise<any> {
  const environment = process.env.EBAY_ENVIRONMENT || "production";
  const hostname =
    environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const options: https.RequestOptions = {
      hostname,
      path,
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Language": "en-US",
        "Accept-Language": "en-US",
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
      },
    };

    const makeRequest = (attempt: number) => {
      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 429 && attempt < 3) {
            const retryAfter = parseInt(res.headers["retry-after"] || "30", 10);
            console.log(`[eBay API] Rate limited (429), waiting ${retryAfter}s before retry ${attempt + 1}/3...`);
            if (onRateLimit) onRateLimit(retryAfter);
            setTimeout(() => makeRequest(attempt + 1), retryAfter * 1000);
            return;
          }
          if (res.statusCode === 204) { resolve(undefined); return; }
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(data); }
            return;
          }
          reject(new Error(`eBay API ${method} ${path} failed (${res.statusCode}): ${data.substring(0, 1000)}`));
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    };

    makeRequest(0);
  });
}
