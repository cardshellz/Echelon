import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const editPageSource = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/pages/BuildRecipeCreate.tsx"),
  "utf8",
);
const buildsPageSource = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/pages/Builds.tsx"),
  "utf8",
);
const appSource = fs.readFileSync(
  path.resolve(process.cwd(), "client/src/App.tsx"),
  "utf8",
);
const routeSource = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/inventory/build.routes.ts"),
  "utf8",
);

describe("build recipe edit UI and route contract", () => {
  it("exposes a protected edit route and latest-version-only list action", () => {
    expect(appSource).toContain('/inventory/builds/recipes/:recipeId/edit');
    expect(buildsPageSource).toContain("latestRecipeIdByCode");
    expect(buildsPageSource).toContain('recipe.status !== "retired"');
    expect(buildsPageSource).toContain('/inventory/builds/recipes/${recipe.id}/edit');
  });

  it("submits an idempotent optimistic version command with mandatory audit reason", () => {
    expect(editPageSource).toContain('method: "PATCH"');
    expect(editPageSource).toContain('"Idempotency-Key": idempotencyKey');
    expect(editPageSource).toContain("expectedVersion: recipe.version");
    expect(editPageSource).toContain("changeReason: changeReason.trim()");
    expect(editPageSource).toContain("Reason for change *");
    expect(editPageSource).toContain("Version history");
    expect(editPageSource).toContain("Existing build orders retain their original version");
  });

  it("routes edit commands through inventory permission and the build use case", () => {
    expect(routeSource).toContain('app.patch("/api/inventory/build-recipes/:id"');
    expect(routeSource).toContain('requirePermission("inventory", "adjust")');
    expect(routeSource).toContain("services.builds.updateRecipe");
    expect(routeSource).toContain("actorId: actorId(req)");
  });
});
