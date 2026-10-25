import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import type {
  ChannelSyncBatch,
  ChannelSyncItem,
} from "../../../shared/types/channel-sync-batch";
export function batchFixture(
  states: ChannelSyncItem["state"][] = ["queued"],
): ChannelSyncBatch {
  const time = "2026-10-21T19:05:40.000Z";
  return refreshBatch({
    id: randomUUID(),
    channelId: 67,
    createdAt: time,
    checkedAt: time,
    lastActivityAt: time,
    state: "working",
    counts: {
      total: 0,
      finished: 0,
      completed: 0,
      needsAttention: 0,
      pending: 0,
      queued: 0,
      running: 0,
      retrying: 0,
      verifying: 0,
      unavailable: 0,
    },
    items: states.map((state, index) => ({
      productId: index + 1,
      name: index === 0 ? "55PT Toploader Combo Pack" : "Another product",
      sku: `SKU-${index + 1}`,
      commandKey: randomUUID(),
      operationId: randomUUID(),
      state,
      code: null,
      message: null,
      updatedAt: time,
      nextAttemptAt: null,
    })),
  });
}
export function refreshBatch(batch: ChannelSyncBatch): ChannelSyncBatch {
  const count = (state: ChannelSyncItem["state"]) =>
    batch.items.filter((item) => item.state === state).length;
  const completed = count("completed"),
    needsAttention = count("needs_attention"),
    finished = completed + needsAttention,
    unavailable = count("unavailable");
  return {
    ...batch,
    state: unavailable
      ? "unavailable"
      : finished < batch.items.length
        ? "working"
        : needsAttention
          ? "needs_attention"
          : "completed",
    counts: {
      total: batch.items.length,
      finished,
      completed,
      needsAttention,
      unavailable,
      pending: count("pending"),
      queued: count("queued"),
      running: count("running"),
      retrying: count("retrying"),
      verifying: count("verifying"),
    },
  };
}
export async function mockSyncBatches(page: Page, initial = batchFixture()) {
  const state = {
    batch: initial,
    saved: false,
    posts: [] as string[],
    getFailure: false,
    malformedPost: false,
    lostPost: false,
    onPost: () => {},
  };
  await page.route("**/api/channels/67/sync-batches**", async (route) => {
    if (route.request().method() === "GET")
      return state.getFailure
        ? route.fulfill({ status: 503, json: { message: "Read failed" } })
        : route.fulfill({
            json: new URL(route.request().url()).pathname.endsWith(state.batch.id) ? state.batch : { batches: state.saved ? [state.batch] : [] },
          });
    const { commandKey } = route.request().postDataJSON();
    state.posts.push(commandKey);
    state.batch = { ...state.batch, id: commandKey };
    state.saved = true;
    state.onPost();
    if (state.lostPost) return route.abort("failed");
    if (state.malformedPost)
      return route.fulfill({ json: { bad: "response" } });
    return route.fulfill({ status: 202, json: state.batch });
  });
  return state;
}
