import {
  channelChoice,
  connectSimulated,
  connectSimulatedLinkedIn,
  editor,
  expectSync,
  feedOf,
  grace,
  graceOnLinkedIn,
  openScreen,
  overflowOf,
  partField,
  publishPanel,
  sentPost,
} from "../app.ts";
import { expect, type Locator, type Page, test } from "../fixtures.ts";
import { file, png } from "../images.ts";

// Images in the editor of a draft, with the built Worker behind the page:
// attaching, describing, moving and removing them, what an account would
// refuse, an upload that is cut off, and a post that goes out with its
// image. Each test is somebody of its own, in their own sandbox:
// `ownPage`. The Worker tests cover what the server makes of a file.

/** The images of the one part of the open draft, or of part `number`. */
function images(page: Page, of = "the post"): Locator {
  return page.getByRole("list", { name: `Images of ${of}` });
}

/** The image `number`, from 1, of the open draft's part. */
function image(page: Page, number: number, of = "the post"): Locator {
  return images(page, of)
    .getByRole("listitem")
    .nth(number - 1);
}

/** The field for the description of an image. */
const description = (tile: Locator) =>
  tile.getByRole("textbox", { name: /^Description of image/ });

/** Chooses `files` with the picker of the part, as a person does. */
async function choose(
  page: Page,
  files: ReturnType<typeof file>[],
  of = "the post",
) {
  await page.getByLabel(`Image files for ${of}`).setInputFiles(files);
}

/** The descriptions of the images of the part, in the order they are shown in. */
const descriptions = (page: Page, of = "the post") =>
  images(page, of)
    .getByRole("textbox")
    .evaluateAll((fields) =>
      fields.map((field) => (field as HTMLTextAreaElement).value),
    );

/** Waits until no image of the part says where its upload stands. */
async function uploaded(page: Page, count: number, of = "the post") {
  await expect(images(page, of).getByRole("listitem")).toHaveCount(count);
  // The server reads each file and makes a small picture of it, which
  // takes its time on a machine that runs other tests.
  await expect(images(page, of).getByRole("status")).toHaveCount(0, {
    timeout: 30_000,
  });
  // Each has its picture.
  await expect(images(page, of).locator("img")).toHaveCount(count);
}

test("images are attached to a draft, described, moved and removed, and all of it is the server's", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("A harbour");
  await choose(page, [
    file("boats.png", png(320, 240)),
    file("pier.png", png(240, 320, { color: [20, 90, 200] })),
  ]);
  await uploaded(page, 2);

  // The editor reminds of the descriptions, and keeps nothing back.
  await expect(page.locator("[data-image-notes]")).toContainText(
    "The images have no description.",
  );
  await description(image(page, 1)).fill("Boats at dusk");
  await description(image(page, 2)).fill("The pier");
  await expect(page.locator("[data-image-notes]")).toHaveCount(0);

  // The second comes first, and back.
  await image(page, 2)
    .getByRole("button", { name: "Move image 2 of the post earlier" })
    .click();
  expect(await descriptions(page)).toEqual(["The pier", "Boats at dusk"]);
  await expect(
    image(page, 1).getByRole("button", { name: /earlier$/ }),
  ).toBeDisabled();
  await image(page, 1)
    .getByRole("button", { name: "Move image 1 of the post later" })
    .click();
  expect(await descriptions(page)).toEqual(["Boats at dusk", "The pier"]);

  await image(page, 1)
    .getByRole("button", { name: "Remove image 1 of the post" })
    .click();
  expect(await descriptions(page)).toEqual(["The pier"]);
  expect(await overflowOf(page)).toBe(0);

  // What the server took: after a reload, the page has what the copy of
  // the device was given back.
  await expectSync(page, "Synced");
  await page.reload();
  await expect(editor(page)).toHaveValue("A harbour");
  expect(await descriptions(page)).toEqual(["The pier"]);
  await uploaded(page, 1);
});

test("a file that is no image is not taken, and a part takes four images", async ({
  ownPage: page,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("Too much");
  await choose(page, [
    file("script.png", Buffer.from("<script>alert(1)</script>")),
    ...["a", "b", "c", "d", "e"].map((name) =>
      file(`${name}.png`, png(64, 48)),
    ),
  ]);
  await expect(
    page.getByRole("listitem").filter({
      hasText: "script.png is not a JPEG, PNG, WebP or GIF image.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("listitem").filter({
      hasText: "e.png was not added: a part has 4 images at most.",
    }),
  ).toBeVisible();
  await uploaded(page, 4);
  await expect(page.getByRole("button", { name: "Add more" })).toBeDisabled();
  expect(await overflowOf(page)).toBe(0);
});

test("what an account would refuse of the images is said next to it, and the draft does not go out until it is cured", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await connectSimulatedLinkedIn(page, graceOnLinkedIn);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("With an image");
  await channelChoice(page, grace).click();
  await channelChoice(page, graceOnLinkedIn).click();
  const publish = publishPanel(page).getByRole("button", {
    name: "Publish now",
  });
  await expect(publish).toBeEnabled();

  await choose(page, [file("boats.png", png(320, 240))]);
  await uploaded(page, 1);
  // pigy publishes no images to LinkedIn yet: said next to that account,
  // and of no other.
  await expect(publishPanel(page)).toContainText(
    "pigy does not publish images to LinkedIn yet.",
  );
  await expect(publish).toBeDisabled();
  expect(await overflowOf(page)).toBe(0);

  // Left out, the draft can go to the account that takes it.
  await channelChoice(page, graceOnLinkedIn).click();
  await expect(publish).toBeEnabled();
});

test("a post goes out with its image, which the Sent screen and the feed of the simulated account show with its description", async ({
  ownPage: page,
}) => {
  await openScreen(page, "Channels");
  await connectSimulated(page, grace);
  await openScreen(page, "Drafts");
  await page.getByRole("button", { name: "New draft" }).click();
  const text = "The harbour, with a picture";
  await editor(page).fill(text);
  await choose(page, [file("boats.png", png(320, 240))]);
  await uploaded(page, 1);
  await description(image(page, 1)).fill("Boats at dusk");
  await channelChoice(page, grace).click();
  await publishPanel(page).getByRole("button", { name: "Publish now" }).click();
  await expect(editor(page)).toHaveCount(0);

  await openScreen(page, "Sent");
  const post = sentPost(page, text);
  await expect(post).toContainText("Sent");
  // The small picture that pigy keeps, by its description.
  await expect(post.getByRole("img", { name: "Boats at dusk" })).toBeVisible();

  await openScreen(page, "Simulator");
  const published = feedOf(page, grace)
    .getByRole("article")
    .filter({ hasText: text });
  const shown = published.getByRole("img", { name: "Boats at dusk" });
  await expect(shown).toBeVisible();
  // A picture that was drawn: the simulated network handed back an image.
  expect(
    await shown.evaluate(
      (element) => (element as HTMLImageElement).naturalWidth,
    ),
  ).toBe(320);
  expect(await overflowOf(page)).toBe(0);
});

test("an upload that loses its connection waits, says so, and goes on with what is missing, also after the page was loaded again", async ({
  ownPage: page,
}) => {
  // Noise does not compress: a file of more than one chunk of 5 MiB.
  const large = png(1400, 1300, { noise: true });
  expect(large.length).toBeGreaterThan(5 * 1024 * 1024);

  // What the page sends of the upload, and a connection that fails the
  // second chunk for as long as the test says.
  const sent: string[] = [];
  let cut = true;
  await page.route(/\/media\/[^/]+\/upload(\/|$)/, async (route) => {
    const request = route.request();
    const step = new URL(request.url()).pathname.split("/upload")[1] || "/";
    sent.push(`${request.method()} ${step}`);
    if (cut && step === "/2") return route.abort("connectionfailed");
    return route.continue();
  });

  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("A large picture");
  await choose(page, [file("large.png", large)]);
  const status = image(page, 1).getByRole("status");
  await expect(status).toHaveText("Waiting for a connection", {
    timeout: 30_000,
  });
  // The picture is on the page all the same, from the file itself.
  await expect(image(page, 1).locator("img")).toBeVisible();
  expect(sent).toContain("PUT /1");

  // The page is loaded again while the upload waits: the device has kept
  // the file, and the row of the image says that it is on its way.
  await expectSync(page, "Synced");
  await page.reload();
  await expect(editor(page)).toHaveValue("A large picture");
  await expect(image(page, 1).getByRole("status")).toHaveText(
    "Waiting for a connection",
    { timeout: 30_000 },
  );

  cut = false;
  await uploaded(page, 1);
  // The first chunk went up once: after the reload the page asked what
  // the server has, and sent the rest.
  expect(sent.filter((step) => step === "PUT /1")).toHaveLength(1);
  expect(sent.filter((step) => step === "POST /complete")).toHaveLength(1);
  expect(sent.at(-1)).toBe("POST /complete");
});

test("an image that is dropped on a part of a thread goes into that part, and an Undo brings a removed part back with it", async ({
  ownPage: page,
  isMobile,
}) => {
  await page.getByRole("button", { name: "New draft" }).click();
  await editor(page).fill("First");
  await page.getByRole("button", { name: "Add a part" }).click();
  await partField(page, 2).fill("Second");

  // Dropped on the second part, as from a folder.
  const boats = png(320, 240).toString("base64");
  const transfer = await page.evaluateHandle((data) => {
    const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
    const dropped = new DataTransfer();
    dropped.items.add(new File([bytes], "boats.png", { type: "image/png" }));
    return dropped;
  }, boats);
  await partField(page, 2).dispatchEvent("drop", { dataTransfer: transfer });
  await uploaded(page, 1, "part 2");
  await expect(images(page, "part 1")).toHaveCount(0);
  await description(image(page, 1, "part 2")).fill("Boats");

  await page.getByRole("button", { name: "Remove part 2" }).click();
  await expect(images(page, "part 2")).toHaveCount(0);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Part removed" })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(partField(page, 2)).toHaveValue("Second");
  expect(await descriptions(page, "part 2")).toEqual(["Boats"]);
  await uploaded(page, 1, "part 2");
  if (isMobile) expect(await overflowOf(page)).toBe(0);
});
