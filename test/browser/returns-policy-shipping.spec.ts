import { test, expect, type Page } from "@playwright/test";
import { installReturnPreviewFixtures } from "./returns-preview-fixtures";
import { installReturnLabelFixtures } from "./returns-label-fixtures";
import { installPolicyShippingFixtures } from "./returns-policy-shipping-fixtures";

async function openPolicy(page: Page) {
  await page.goto("/return-policies?policyId=3&section=shipping");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("policy editor saves rules and shipping as one version and removes the separate menu entry", async ({
  page,
}, testInfo) => {
  const transport = await installReturnPreviewFixtures(page);
  const policies = await installPolicyShippingFixtures(page);
  const labels = await installReturnLabelFixtures(page);
  const dialog = await openPolicy(page);
  await expect(dialog.getByText("Return rules", { exact: true })).toBeVisible();
  await expect(
    dialog.getByText("Return shipping", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByLabel("Return warehouse", { exact: true }),
  ).toHaveValue("1");
  await dialog.getByLabel("Return window (days)", { exact: true }).fill("365");
  await dialog
    .getByLabel("Return warehouse", { exact: true })
    .selectOption("2");
  await dialog
    .getByLabel("Return contact name", { exact: true })
    .fill("Updated receiving desk");
  await expect(
    page.getByRole("link", { name: "Label settings", exact: true }),
  ).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("policy-return-shipping.png"),
    animations: "disabled",
  });
  await dialog
    .getByRole("button", { name: "Create version", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(policies.writes).toHaveLength(1);
  expect(policies.writes[0]).toMatchObject({
    expectedPolicyId: 3,
    returnWindowDays: 365,
    shipping: {
      warehouseId: 2,
      contactName: "Updated receiving desk",
      enabled: true,
    },
  });
  expect(policies.writes[0].shipping).not.toHaveProperty("destinationAddress");
  expect(policies.writes[0].shipping).not.toHaveProperty("expectedVersion");
  expect(labels.settingsWrites).toEqual([]);
  expect(labels.submissions).toEqual([]);
  expect(policies.failures).toEqual([]);
  expect(transport.failures).toEqual([]);
});

test("policy shipping validates allowed services and weight limits before the combined save", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  const policies = await installPolicyShippingFixtures(page);
  const dialog = await openPolicy(page);
  await dialog
    .getByLabel("Service selection", { exact: true })
    .selectOption("cheapest_eligible");
  const save = dialog.getByRole("button", {
    name: "Create version",
    exact: true,
  });
  await expect(save).toBeDisabled();
  const postal = dialog.getByTestId("return-carrier-rule-se-postal");
  await postal
    .getByRole("checkbox", {
      name: "Allow Fixture USPS (se-postal)",
      exact: true,
    })
    .check();
  await expect(save).toBeDisabled();
  await postal
    .getByRole("checkbox", {
      name: "Allow USPS Ground from Fixture USPS (se-postal)",
      exact: true,
    })
    .check();
  const weight = postal.getByLabel(
    "Maximum box weight (lb) for Fixture USPS (se-postal)",
    { exact: true },
  );
  await weight.fill("0");
  await expect(save).toBeDisabled();
  await weight.fill("20.0001");
  await expect(save).toBeDisabled();
  await weight.fill("20");
  await expect(save).toBeEnabled();
  await save.click();
  await expect(dialog).toHaveCount(0);
  expect(policies.writes[0]).toMatchObject({
    shipping: {
      selectionMode: "cheapest_eligible",
      carrierId: null,
      serviceCode: null,
      carrierRules: [
        {
          carrierId: "se-postal",
          serviceCodes: ["usps_ground"],
          maxWeightLb: "20",
        },
      ],
    },
  });
  expect(policies.failures).toEqual([]);
});

test("uncertain combined save retries the same policy and shipping intent exactly once", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  const policies = await installPolicyShippingFixtures(page, {
    uncertainFirstSave: true,
  });
  const dialog = await openPolicy(page);
  await dialog
    .getByLabel("Return contact name", { exact: true })
    .fill("Retry receiving desk");
  await dialog
    .getByRole("button", { name: "Create version", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(
    dialog.getByLabel("Return contact name", { exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: /Retry/ }).click();
  await expect(dialog).toHaveCount(0);
  expect(policies.writes).toHaveLength(2);
  expect(policies.keys[1]).toBe(policies.keys[0]);
  expect(policies.writes[1]).toEqual(policies.writes[0]);
  expect(policies.accepted).toBe(1);
  expect(policies.failures).toEqual([]);
});

test("a stale policy save preserves edits and cannot silently replace the newer policy", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  const policies = await installPolicyShippingFixtures(page, {
    staleFirstSave: true,
  });
  const dialog = await openPolicy(page);
  await dialog
    .getByLabel("Return contact name", { exact: true })
    .fill("My unsaved desk");
  await dialog
    .getByRole("button", { name: "Create version", exact: true })
    .click();
  await expect(dialog.getByRole("alert")).toContainText(
    "Another administrator changed",
  );
  await expect(
    dialog.getByLabel("Return contact name", { exact: true }),
  ).toHaveValue("My unsaved desk");
  expect(policies.writes[0]).toMatchObject({ expectedPolicyId: 3 });
  expect(policies.accepted).toBe(0);
});

test("legacy label settings links open the applicable policy and unknown shops never select another policy", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  await installPolicyShippingFixtures(page);
  await page.goto("/returns/label-settings?channelId=36");
  await expect(page).toHaveURL(/\/return-policies/);
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Policy name", { exact: true })).toHaveValue(
    "Shopify returns",
  );
  await page.goto("/returns/label-settings?channelId=999");
  await expect(page).toHaveURL(/\/return-policies/);
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("portal links to its applied policy and pause controls do not write a policy or shipping configuration", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  const labels = await installReturnLabelFixtures(page);
  const policies = await installPolicyShippingFixtures(page);
  await page.goto("/return-portal");
  await page.getByText("Testing controls", { exact: true }).click();
  const link = page.getByRole("link", { name: /^Edit return policy/ });
  await expect(link).toHaveAttribute(
    "href",
    "/return-policies?policyId=2&section=shipping",
  );
  await page.getByRole("button", { name: /Pause label/ }).click();
  await expect(
    page.getByRole("button", { name: /Resume label/ }),
  ).toBeVisible();
  expect(labels.settingsWrites).toEqual([{ paused: true, expectedVersion: 0 }]);
  expect(policies.writes).toEqual([]);
  await page.getByRole("button", { name: /Resume label/ }).click();
  expect(labels.settingsWrites[1]).toEqual({
    paused: false,
    expectedVersion: 1,
  });
  expect(labels.submissions).toEqual([]);
  expect(labels.failures).toEqual([]);
});

test("another channel starts with unconfigured shipping and never borrows Shopify's warehouse", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  const policies = await installPolicyShippingFixtures(page);
  await page.goto("/return-policies");
  await page.getByRole("button", { name: "New policy", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("Policy name", { exact: true })
    .fill("Second shop returns");
  await dialog.getByLabel("Sales channel", { exact: true }).click();
  await page
    .getByRole("option", { name: "Second Shopify shop", exact: true })
    .click();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Configure return shipping",
      exact: true,
    }),
  ).not.toBeChecked();
  await expect(
    dialog.getByLabel("Return warehouse", { exact: true }),
  ).toHaveCount(0);
  await dialog
    .getByRole("button", { name: "Create version", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  expect(policies.writes[0]).toMatchObject({
    channelId: 37,
    expectedPolicyId: null,
    shipping: null,
  });
  expect(policies.policies.find((policy) => policy.id === 3)).toMatchObject({
    status: "active",
    shipping: { warehouseId: 1 },
  });
});

test("a delayed legacy channel resolution cannot replace a manually edited policy draft", async ({
  page,
}) => {
  await installReturnPreviewFixtures(page);
  await installPolicyShippingFixtures(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let observed!: () => void;
  const requested = new Promise<void>((resolve) => {
    observed = resolve;
  });
  let completed!: () => void;
  const finished = new Promise<void>((resolve) => {
    completed = resolve;
  });
  await page.route("**/api/returns/admin/policies/resolve", async (route) => {
    observed();
    await held;
    try {
      await route.fallback();
    } finally {
      completed();
    }
  });
  await page.goto("/returns/label-settings?channelId=36");
  await requested;
  await page.getByRole("button", { name: "New version", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const contact = dialog.getByLabel("Return contact name", { exact: true });
  await contact.fill("My manually edited desk");
  release();
  await finished;
  await expect(contact).toHaveValue("My manually edited desk");
});
