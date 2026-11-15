import { offerToInstall } from "../app.ts";
import { expect, test } from "../fixtures.ts";

// What a browser needs to install pigy as an app, and what pigy says about
// installing. Whether a phone then shows it as it should cannot be tested
// here: that takes the phone.

/** The width and height that a PNG file says it has, as "192x192". */
function sizeOfPng(file: Buffer): string {
  // Eight bytes that every PNG begins with, then the header: the length
  // and name of the chunk, the width and the height.
  expect(file.subarray(1, 4).toString("latin1")).toBe("PNG");
  return `${file.readUInt32BE(16)}x${file.readUInt32BE(20)}`;
}

test("the manifest is what a browser installs pigy from", async ({ page }) => {
  await page.goto("/sign-in");
  // On every page of the app, signed in or not.
  const href = await page.locator('link[rel="manifest"]').getAttribute("href");
  if (!href) throw new Error("The page names no manifest");

  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = await response.json();

  // What Chrome asks of an app before it offers to install it: a name,
  // where it starts, that it has a window of its own, and icons of 192 and
  // 512 pixels.
  expect(manifest).toMatchObject({
    name: "pigy",
    short_name: "pigy",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  const icons: {
    src: string;
    sizes: string;
    type: string;
    purpose?: string;
  }[] = manifest.icons;
  expect(
    icons.filter(({ purpose }) => !purpose).map(({ sizes }) => sizes),
  ).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  // And one that Android may cut to the shape of its own icons.
  expect(icons.map(({ purpose }) => purpose)).toContain("maskable");

  for (const icon of icons) {
    const file = await page.request.get(icon.src);
    expect(file.status(), icon.src).toBe(200);
    expect(file.headers()["content-type"], icon.src).toBe(icon.type);
    expect(icon.type, icon.src).toBe("image/png");
    expect(sizeOfPng(await file.body()), icon.src).toBe(icon.sizes);
  }
});

test("the icon for the Home Screen of iOS is a file of its size", async ({
  page,
}) => {
  await page.goto("/sign-in");
  // iOS takes this link, not the icons of the manifest.
  const href = await page
    .locator('link[rel="apple-touch-icon"]')
    .getAttribute("href");
  if (!href) throw new Error("The page names no icon for iOS");

  const file = await page.request.get(href);
  expect(file.status()).toBe(200);
  expect(file.headers()["content-type"]).toBe("image/png");
  expect(sizeOfPng(await file.body())).toBe("180x180");
});

test("browsers keep the files that never change and ask again for what a new version begins with", async ({
  page,
}) => {
  const shell = await page.request.get("/");
  // A file that the build names after its content.
  const [script] = /\/assets\/[\w.-]+\.js/.exec(await shell.text()) ?? [];
  if (!script) throw new Error("The app shell loads no script");

  expect((await page.request.get(script)).headers()["cache-control"]).toBe(
    "public, max-age=31536000, immutable",
  );
  // A browser that kept one of these for a while would not hear of a new
  // version for as long.
  for (const path of ["/sw.js", "/manifest.webmanifest"]) {
    const response = await page.request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["cache-control"], path).toBe("no-cache");
  }
  // The app shell has no rule of its own: Cloudflare has it checked with
  // the server before every use.
  expect(shell.headers()["cache-control"]).toBe(
    "public, max-age=0, must-revalidate",
  );
});

for (const colorScheme of ["light", "dark"] as const) {
  test.describe(`in the ${colorScheme} theme`, () => {
    test.use({ colorScheme });

    test("the colour around the page is the background of the app", async ({
      page,
    }) => {
      await page.goto("/sign-in");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      // Both as the browser paints them: the page says its background in
      // another notation than the tag.
      const colors = await page.evaluate(() => {
        const painted = (color: string) => {
          const canvas = document.createElement("canvas").getContext("2d");
          if (!canvas) throw new Error("No canvas");
          canvas.fillStyle = color;
          canvas.fillRect(0, 0, 1, 1);
          return [...canvas.getImageData(0, 0, 1, 1).data].join(" ");
        };
        const tag = document.querySelector<HTMLMetaElement>(
          'meta[name="theme-color"]',
        );
        return {
          tag: painted(tag?.content ?? ""),
          background: painted(getComputedStyle(document.body).backgroundColor),
          // What an empty tag would be painted as.
          nothing: painted(""),
        };
      });

      expect(colors.tag).toBe(colors.background);
      expect(colors.tag).not.toBe(colors.nothing);
    });
  });
}

test("the manifest has the colours of the light theme", async ({ page }) => {
  // A manifest has one of each. The splash screen of Android is drawn from
  // it before the page can say which theme is on.
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/sign-in");
  const manifest = await (
    await page.request.get("/manifest.webmanifest")
  ).json();

  const tag = page.locator('meta[name="theme-color"]');
  await expect(tag).toHaveAttribute("content", manifest.theme_color);
  await expect(tag).toHaveAttribute("content", manifest.background_color);
});

test("pigy offers to install itself where the browser can, in Settings and in the command palette", async ({
  signedInPage: page,
}) => {
  await page.goto("/settings");
  const install = page.getByRole("button", { name: "Install", exact: true });
  await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
  // The browser has offered nothing, so there is nothing to press.
  await expect(install).toHaveCount(0);

  expect(await offerToInstall(page)).toBe(true);
  await install.click();
  // The person is asked by the browser, once: an offer is used up, and
  // pigy does not go on about it.
  await expect(install).toHaveCount(0);
  expect(
    await page.evaluate(
      () => (window as { askedToInstall?: number }).askedToInstall,
    ),
  ).toBe(1);

  // The next offer of the browser is also in the command palette.
  await offerToInstall(page);
  const palette = page.getByRole("dialog", { name: "Commands" });
  await page.keyboard.press("ControlOrMeta+k");
  await palette.getByRole("combobox").fill("install");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
  expect(
    await page.evaluate(
      () => (window as { askedToInstall?: number }).askedToInstall,
    ),
  ).toBe(2);

  // Installed: an offer that was still open is withdrawn.
  await offerToInstall(page);
  await expect(install).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(install).toHaveCount(0);
});

test.describe("on an iPhone", () => {
  // Safari on iOS has nothing that a page could ask to install it, so the
  // app goes by what the browser says it is.
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
  });

  test("Settings say how to add pigy to the Home Screen, until it is there", async ({
    signedInPage: page,
  }) => {
    await page.goto("/settings");
    await expect(page.getByText("Add to Home Screen")).toBeVisible();
    // No button: there is nothing that it could do.
    await expect(
      page.getByRole("button", { name: "Install", exact: true }),
    ).toHaveCount(0);

    // Opened from the Home Screen, the page is told so by Safari, in a
    // property that only Safari has.
    await page.addInitScript(() =>
      Object.defineProperty(navigator, "standalone", { value: true }),
    );
    await page.reload();

    await expect(
      page.getByRole("heading", { name: "Appearance" }),
    ).toBeVisible();
    await expect(page.getByText("Add to Home Screen")).toHaveCount(0);
  });
});
