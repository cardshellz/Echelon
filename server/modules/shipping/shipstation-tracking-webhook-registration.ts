import type {
  ShipStationTrackingWebhook,
  ShipStationTrackingWebhooksClient,
} from "./shipstation-tracking-webhooks.client";
import { ShipStationTrackingWebhooksClientError } from "./shipstation-tracking-webhooks.client";

const TRACKING_WEBHOOK_NAME = "Echelon carrier tracking";

export type ShipStationTrackingWebhookRegistrationResult =
  | {
    status: "already_configured";
    targetUrl: string;
    webhook: ShipStationTrackingWebhook;
  }
  | {
    status: "create_planned";
    targetUrl: string;
  }
  | {
    status: "created";
    targetUrl: string;
    webhook: ShipStationTrackingWebhook;
  }
  | {
    status: "conflict";
    targetUrl: string;
    trackingWebhooks: ShipStationTrackingWebhook[];
  };

export interface ConfigureShipStationTrackingWebhookInput {
  client: ShipStationTrackingWebhooksClient;
  targetUrl: string;
  execute: boolean;
}

export function normalizeTrackingWebhookTargetUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("ShipStation tracking webhook target must be a valid absolute URL");
  }
  if (parsed.protocol !== "https:") {
    throw new Error("ShipStation tracking webhook target must use HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new Error("ShipStation tracking webhook target must not contain embedded credentials");
  }
  if (parsed.hash || parsed.search) {
    throw new Error("ShipStation tracking webhook target must not contain a query string or fragment");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return parsed.toString();
}

function normalizedProviderUrl(value: string): string | null {
  try {
    return normalizeTrackingWebhookTargetUrl(value);
  } catch {
    return null;
  }
}

function classifyExistingTrackingWebhooks(
  webhooks: ShipStationTrackingWebhook[],
  targetUrl: string,
): Extract<
  ShipStationTrackingWebhookRegistrationResult,
  { status: "already_configured" | "conflict" }
> | null {
  const trackingWebhooks = webhooks.filter((webhook) => webhook.event.toLowerCase() === "track");
  const exactMatches = trackingWebhooks.filter(
    (webhook) => normalizedProviderUrl(webhook.url) === targetUrl,
  );

  if (trackingWebhooks.length === 1 && exactMatches.length === 1) {
    return {
      status: "already_configured",
      targetUrl,
      webhook: exactMatches[0],
    };
  }

  if (trackingWebhooks.length > 0) {
    return {
      status: "conflict",
      targetUrl,
      trackingWebhooks,
    };
  }

  return null;
}

function isAlreadyExistsConflict(error: unknown): boolean {
  return error instanceof ShipStationTrackingWebhooksClientError
    && error.code === "HTTP"
    && error.context.status === 409;
}

export async function configureShipStationTrackingWebhook(
  input: ConfigureShipStationTrackingWebhookInput,
): Promise<ShipStationTrackingWebhookRegistrationResult> {
  const targetUrl = normalizeTrackingWebhookTargetUrl(input.targetUrl);
  const webhooks = await input.client.listWebhooks();
  const currentState = classifyExistingTrackingWebhooks(webhooks, targetUrl);
  if (currentState) return currentState;

  if (!input.execute) {
    return { status: "create_planned", targetUrl };
  }

  let webhook: ShipStationTrackingWebhook;
  try {
    webhook = await input.client.createWebhook({
      name: TRACKING_WEBHOOK_NAME,
      event: "track",
      url: targetUrl,
    });
  } catch (error) {
    if (!isAlreadyExistsConflict(error)) throw error;

    const racedState = classifyExistingTrackingWebhooks(
      await input.client.listWebhooks(),
      targetUrl,
    );
    if (racedState) return racedState;
    throw error;
  }
  if (webhook.event.toLowerCase() !== "track" || normalizedProviderUrl(webhook.url) !== targetUrl) {
    throw new Error("ShipStation created a webhook that does not match the requested tracking subscription");
  }
  return { status: "created", targetUrl, webhook };
}
