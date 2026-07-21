import type {
  ShipStationTrackingWebhook,
  ShipStationTrackingWebhooksClient,
} from "./shipstation-tracking-webhooks.client";
import { ShipStationTrackingWebhooksClientError } from "./shipstation-tracking-webhooks.client";
import {
  assertValidShipStationTrackingWebhookSecret,
  SHIPSTATION_TRACKING_WEBHOOK_SECRET_HEADER,
} from "./shipstation-tracking-api-config";

const TRACKING_WEBHOOK_NAME = "Echelon carrier tracking";

export interface ShipStationTrackingWebhookSummary {
  webhookId: string;
  name: string | null;
  event: string;
  url: string;
  headerNames: string[];
}

export type ShipStationTrackingWebhookRegistrationResult =
  | {
    status: "already_configured";
    targetUrl: string;
    webhook: ShipStationTrackingWebhookSummary;
  }
  | {
    status: "create_planned";
    targetUrl: string;
  }
  | {
    status: "created";
    targetUrl: string;
    webhook: ShipStationTrackingWebhookSummary;
  }
  | {
    status: "takeover_planned";
    targetUrl: string;
    webhook: ShipStationTrackingWebhookSummary;
  }
  | {
    status: "taken_over";
    targetUrl: string;
    webhook: ShipStationTrackingWebhookSummary;
  }
  | {
    status: "conflict";
    targetUrl: string;
    trackingWebhooks: ShipStationTrackingWebhookSummary[];
    reason?: string;
  };

export interface ShipStationTrackingWebhookTakeoverExpectation {
  webhookId: string;
  currentUrl: string;
}

export interface ConfigureShipStationTrackingWebhookInput {
  client: ShipStationTrackingWebhooksClient;
  targetUrl: string;
  webhookSecret: string;
  execute: boolean;
  takeover?: ShipStationTrackingWebhookTakeoverExpectation | null;
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
  webhookSecret: string,
): Extract<
  ShipStationTrackingWebhookRegistrationResult,
  { status: "already_configured" | "conflict" }
> | null {
  const trackingWebhooks = webhooks.filter((webhook) => webhook.event.toLowerCase() === "track");
  const exactMatches = trackingWebhooks.filter(
    (webhook) => normalizedProviderUrl(webhook.url) === targetUrl
      && hasExpectedAuthenticationHeader(webhook, webhookSecret),
  );

  if (trackingWebhooks.length === 1 && exactMatches.length === 1) {
    return {
      status: "already_configured",
      targetUrl,
      webhook: summarizeWebhook(exactMatches[0]),
    };
  }

  if (trackingWebhooks.length > 0) {
    return {
      status: "conflict",
      targetUrl,
      trackingWebhooks: trackingWebhooks.map(summarizeWebhook),
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
  const webhookSecret = input.webhookSecret.trim();
  assertValidShipStationTrackingWebhookSecret(webhookSecret);
  const webhooks = await input.client.listWebhooks();
  const currentState = classifyExistingTrackingWebhooks(webhooks, targetUrl, webhookSecret);
  if (currentState?.status === "already_configured") return currentState;

  if (currentState?.status === "conflict" && input.takeover) {
    const expectedCurrentUrl = normalizeTrackingWebhookTargetUrl(input.takeover.currentUrl);
    const expectedWebhookId = input.takeover.webhookId.trim();
    const trackingWebhooks = webhooks.filter(
      (webhook) => webhook.event.toLowerCase() === "track",
    );
    const current = trackingWebhooks[0];
    const matchesExpectation = trackingWebhooks.length === 1
      && current.webhook_id === expectedWebhookId
      && normalizedProviderUrl(current.url) === expectedCurrentUrl
      && (current.headers ?? []).length === 0;
    if (!matchesExpectation) {
      return {
        ...currentState,
        reason: "Existing tracking webhook does not exactly match the guarded takeover expectation",
      };
    }
    if (!input.execute) {
      return {
        status: "takeover_planned",
        targetUrl,
        webhook: summarizeWebhook(current),
      };
    }

    await input.client.updateWebhook(current.webhook_id, {
      name: TRACKING_WEBHOOK_NAME,
      url: targetUrl,
      headers: [{
        key: SHIPSTATION_TRACKING_WEBHOOK_SECRET_HEADER,
        value: webhookSecret,
      }],
    });
    const verifiedState = classifyExistingTrackingWebhooks(
      await input.client.listWebhooks(),
      targetUrl,
      webhookSecret,
    );
    if (verifiedState?.status !== "already_configured"
        || verifiedState.webhook.webhookId !== current.webhook_id) {
      throw new Error(
        "ShipStation tracking webhook takeover could not be verified after the in-place update",
      );
    }
    return {
      status: "taken_over",
      targetUrl,
      webhook: verifiedState.webhook,
    };
  }

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
      headers: [{
        key: SHIPSTATION_TRACKING_WEBHOOK_SECRET_HEADER,
        value: webhookSecret,
      }],
    });
  } catch (error) {
    if (!isAlreadyExistsConflict(error)) throw error;

    const racedState = classifyExistingTrackingWebhooks(
      await input.client.listWebhooks(),
      targetUrl,
      webhookSecret,
    );
    if (racedState) return racedState;
    throw error;
  }
  if (webhook.event.toLowerCase() !== "track"
      || normalizedProviderUrl(webhook.url) !== targetUrl
      || !hasExpectedAuthenticationHeader(webhook, webhookSecret)) {
    throw new Error("ShipStation created a webhook that does not match the requested tracking subscription");
  }
  return { status: "created", targetUrl, webhook: summarizeWebhook(webhook) };
}

function hasExpectedAuthenticationHeader(
  webhook: ShipStationTrackingWebhook,
  webhookSecret: string,
): boolean {
  const matchingHeaders = (webhook.headers ?? []).filter(
    (header) => header.key.trim().toLowerCase() === SHIPSTATION_TRACKING_WEBHOOK_SECRET_HEADER,
  );
  return matchingHeaders.length === 1 && matchingHeaders[0].value === webhookSecret;
}

function summarizeWebhook(webhook: ShipStationTrackingWebhook): ShipStationTrackingWebhookSummary {
  return {
    webhookId: webhook.webhook_id,
    name: webhook.name?.trim() || null,
    event: webhook.event,
    url: webhook.url,
    headerNames: [...new Set((webhook.headers ?? []).map((header) => header.key.trim()))]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right)),
  };
}
