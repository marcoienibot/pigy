import { expect, test } from "../fixtures.ts";

test("home shows the health reported by the Worker", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  // The first row is the API status. "ok" comes from GET /api/health, so
  // this fails if the web app and the Worker are not served together.
  await expect(page.getByRole("definition").first()).toHaveText("ok");
});

test("navigates between screens without a page load", async ({ page }) => {
  await page.goto("/");
  // Set a marker that a full page load would wipe, to tell client-side
  // routing apart from the server answering /queue with the app shell.
  await page.evaluate(() => {
    (window as { marker?: boolean }).marker = true;
  });

  const nav = page.getByRole("navigation", { name: "Main" });
  await nav.getByRole("link", { name: "Queue" }).click();

  await expect(page).toHaveURL("/queue");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");
  expect(
    await page.evaluate(() => (window as { marker?: boolean }).marker),
  ).toBe(true);
});

test("navigation is a sidebar on desktop and a bottom bar on phones", async ({
  page,
  isMobile,
}) => {
  await page.goto("/");
  // The screen has rendered once its heading is there. Without this wait the
  // overflow check below could measure a page that has no content yet.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");

  // Both layouts are in the DOM; only the one for this viewport is visible.
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav).toHaveCount(1);
  const box = await nav.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport) throw new Error("Navigation is not rendered");

  if (isMobile) {
    expect(box.width).toBeCloseTo(viewport.width, 0);
    expect(box.y + box.height).toBeCloseTo(viewport.height, 0);
  } else {
    expect(box.x).toBe(0);
    expect(box.width).toBeLessThan(viewport.width / 2);
  }

  // The page itself must never scroll sideways.
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);
});

test("deep links and unknown paths get the app, unknown API paths do not", async ({
  page,
}) => {
  // Served by the single-page-app fallback of the static assets.
  await page.goto("/queue");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Queue");

  await page.goto("/no-such-page");
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();

  // /api/* always reaches the Worker, so a typo in an API path is a JSON
  // 404 rather than a 200 with the app shell. It has to be a navigation:
  // only navigations fall back to the app shell, so only a navigation shows
  // that `run_worker_first` in wrangler.jsonc is in effect.
  const response = await page.goto("/api/no-such-route");
  expect(response?.status()).toBe(404);
  expect(response?.headers()["content-type"]).toContain("application/json");
});

test("theme follows the system until it is set by hand", async ({ page }) => {
  const html = page.locator("html");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/settings");
  await expect(html).toContainClass("dark");

  await page.getByRole("button", { name: "Light" }).click();
  await expect(html).not.toContainClass("dark");

  // The choice is stored and wins over the system setting on the next load.
  await page.reload();
  // Waiting for the pressed button means the app has rendered, so the check
  // after it covers the theme provider and not only the script in index.html.
  await expect(page.getByRole("button", { name: "Light" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(html).not.toContainClass("dark");
});
