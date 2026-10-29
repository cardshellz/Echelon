import { expect, test } from "@playwright/test";

test("the real application resolves eager page imports and renders login", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => {
    if (response.status() >= 400 && response.request().resourceType() === "script")
      errors.push(`Module response ${response.status()}: ${new URL(response.url()).pathname}`);
  });
  // Exercise main.tsx and App.tsx themselves. Never replace the HTML/entrypoint
  // with a feature harness: this gate owns their full eager import graph.
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() !== "GET") {
      errors.push(`Unexpected startup mutation: ${route.request().method()} ${path}`);
      return route.abort();
    }
    return route.fulfill({ status: path === "/api/auth/me" ? 401 : 200, json: {} });
  });
  await page.goto("/login");
  await expect(page.getByTestId("input-username")).toBeVisible();
  await expect(page.getByTestId("input-password")).toBeVisible();
  await page.getByTestId("input-username").fill("bootstrap-smoke");
  await page.getByTestId("input-password").fill("synthetic-password");
  await expect(page.getByTestId("button-login")).toBeEnabled();
  await expect(page.getByTestId("input-username")).toHaveValue("bootstrap-smoke");
  expect(errors).toEqual([]);
});
