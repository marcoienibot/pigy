import {
  backToList,
  draftRows,
  editor,
  expectSync,
  expectWorkspace,
  serviceWorkerAnswersFor,
  switchTo,
} from "../app.ts";
import {
  type BrowserContext,
  expect,
  type Page,
  signIn,
  test,
} from "../fixtures.ts";
import { file, png } from "../images.ts";

// Sharing to pigy: the manifest registers the app as a share target, and
// Android then posts what another app shares to `/share`, as a form with
// the files, in the installed app. The service worker keeps the files on
// the device and sends the browser on to
// `/share?title=…&text=…&url=…&files=…`. No test has an Android to share
// from: what these show is what the app does with that address, and with
// a form posted to it, which is all that is the app's. That Android
// offers pigy in its share sheet is to be seen on a phone: PLAN.md
// section 19.
//
// The address is one that any website can send a browser to, and the form
// one that any website can post, so neither stores anything: the app shows
// what came and asks.

/** The address that Android opens for a share of `shared`. */
const shareAddress = (shared: Record<string, string>) =>
  `/share?${new URLSearchParams(shared)}`;

/** What the screen says was shared. */
const shared = (page: Page) => page.getByLabel("What was shared");

/** The pictures of the images that were shared. */
const pictures = (page: Page) =>
  page.getByRole("list", { name: "Images that were shared" }).getByRole("img");

/**
 * Posts a share to the app as the share target of the manifest has the
 * browser do: a form of `multipart/form-data` to `/share`, with `fields`
 * and `files` as `images`, from a page of a context whose service worker
 * answers for the app. The page is blank and of nobody, as one of another
 * site is: the form is what such a site could post. Returns the page,
 * which the service worker sends on to the share screen.
 */
async function postShare(
  context: BrowserContext,
  origin: string,
  fields: Record<string, string>,
  files: ReturnType<typeof file>[],
): Promise<Page> {
  const sender = await context.newPage();
  await sender.setContent(
    `<form method="post" enctype="multipart/form-data" action="${origin}/share">${Object.keys(
      fields,
    )
      .map((name) => `<input type="hidden" name="${name}">`)
      .join("")}<input type="file" name="images" multiple></form>`,
  );
  for (const [name, value] of Object.entries(fields)) {
    await sender.locator(`input[name="${name}"]`).evaluate((input, value) => {
      (input as HTMLInputElement).value = value;
    }, value);
  }
  await sender.locator('input[type="file"]').setInputFiles(files);
  await sender.locator("form").evaluate((form) => {
    (form as HTMLFormElement).submit();
  });
  await sender.waitForURL(({ pathname }) => pathname !== "blank");
  return sender;
}

/** How many shares wait on the device of `page` for the share screen. */
const waitingShares = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve, reject) => {
        const request = indexedDB.open("pigy-shares", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("shares", { keyPath: "id" });
        };
        request.onsuccess = () => {
          const db = request.result;
          const count = db.transaction("shares").objectStore("shares").count();
          count.onsuccess = () => {
            db.close();
            resolve(count.result);
          };
          count.onerror = () => reject(count.error);
        };
        request.onerror = () => reject(request.error);
      }),
  );

/** The images of the part of the open draft, once each has its picture. */
async function uploadedImages(page: Page, count: number) {
  const images = page.getByRole("list", { name: "Images of the post" });
  await expect(images.getByRole("listitem")).toHaveCount(count);
  // The server reads each file and makes a small picture of it, which
  // takes its time on a machine that runs other tests.
  await expect(images.getByRole("status")).toHaveCount(0, { timeout: 30_000 });
  await expect(images.locator("img")).toHaveCount(count);
}

const save = (page: Page) =>
  page.getByRole("button", { name: "Save as draft" });

test("the manifest registers pigy for text, links and images, at an address of the app's own", async ({
  page,
}) => {
  const response = await page.request.get("/manifest.webmanifest");
  const manifest = await response.json();

  // A share with files is a form that is posted: Chrome on Android asks
  // for the method and the encoding of one, and for the types of file.
  expect(manifest.share_target).toEqual({
    action: "/share",
    method: "POST",
    enctype: "multipart/form-data",
    params: {
      title: "title",
      text: "text",
      url: "url",
      files: [
        {
          name: "images",
          accept: [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/gif",
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".gif",
          ],
        },
      ],
    },
  });
  // Not a path of the Worker: the answer is the app shell, which the
  // service worker also has without a connection. No session is needed
  // to be given it.
  const shell = await page.request.get(shareAddress({ text: "Hello" }));
  expect(shell.headers()["content-type"]).toContain("text/html");
  expect(await shell.text()).toContain('<div id="root">');
});

test("what is shared is shown with the text and the link put together, and becomes a draft when the person says so", async ({
  ownPage: page,
  isMobile,
}) => {
  await page.goto(
    shareAddress({
      title: "A fine article",
      text: "",
      url: "https://example.com/article",
    }),
  );

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Shared to pigy",
  );
  // Read without its line breaks here: the draft below has them.
  await expect(shared(page)).toHaveText(
    "A fine article https://example.com/article",
  );
  // As text: the address in it is nothing to press.
  await expect(shared(page).getByRole("link")).toHaveCount(0);

  // Saving is the main thing to do there, and has the keyboard.
  await expect(save(page)).toBeFocused();
  await page.keyboard.press("Enter");

  await expect(editor(page)).toHaveValue(
    "A fine article\n\nhttps://example.com/article",
  );
  // In the sandbox, which this device showed last, and on to the draft:
  // the address of the share is gone from the history.
  await expect(page).toHaveURL(/\/\?draft=/);

  // Loading the page again shares nothing a second time: one draft. On a
  // phone the editor covers the list.
  await page.reload();
  await expect(editor(page)).toHaveValue(
    "A fine article\n\nhttps://example.com/article",
  );
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(1);
});

test("opening the address of a share stores nothing: the person can discard what came", async ({
  ownPage: page,
  otherDevice,
}) => {
  // As a website does that sends a signed-in browser here, with a text
  // of its own.
  await page.goto(shareAddress({ text: "Written by somebody else" }));
  await expect(shared(page)).toHaveText("Written by somebody else");
  // The page has nothing to sync, and says so once it has heard from the
  // server: the check below is about a server that was reached.
  await expectSync(page, "Synced");

  // Nothing has reached the other devices of the person.
  const other = await otherDevice();
  await expectSync(other, "Synced");
  await expect(draftRows(other)).toHaveCount(0);

  await page.getByRole("button", { name: "Discard" }).click();

  // And nothing is on this one, where the drafts are read from the copy.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(page).toHaveURL(/\/$/);
  await expect(draftRows(page)).toHaveCount(0);
});

test("a text that holds its link is not given the link twice", async ({
  ownPage: page,
}) => {
  await page.goto(
    shareAddress({
      text: "Look at this https://example.com/a",
      url: "https://example.com/a",
    }),
  );

  await expect(shared(page)).toHaveText("Look at this https://example.com/a");
});

for (const text of [
  "null",
  "[1,2]",
  '{"a":1}',
  "9007199254740993",
  '"quoted"',
]) {
  test(`a shared text that reads like JSON is the text that it is: ${text}`, async ({
    ownPage: page,
  }) => {
    // A router reads such a value of an address as what it reads like:
    // as nothing, as a list or an object, as a number that it rounds, as
    // a text without its quotation marks.
    await page.goto(shareAddress({ text }));

    await expect(shared(page)).toHaveText(text);
    await save(page).click();
    await expect(editor(page)).toHaveValue(text);
  });
}

test("a share of nothing leads to the drafts and makes none", async ({
  ownPage: page,
}) => {
  await page.goto(shareAddress({ title: " ", text: "" }));

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(page).toHaveURL(/\/$/);
  await expect(draftRows(page)).toHaveCount(0);
});

test("what is shared can be saved in the other workspace: it stays when the person changes to that one", async ({
  ownPage: page,
}) => {
  // In quotation marks, which the address loses if it is written anew
  // the way the router reads it.
  await page.goto(shareAddress({ text: '"For real"' }));
  await expect(shared(page)).toHaveText('"For real"');
  await expect(page.getByText("The draft is saved in Sandbox.")).toBeVisible();

  await switchTo(page, "Live");

  await expectWorkspace(page, "Live");
  await expect(shared(page)).toHaveText('"For real"');
  await expect(page.getByText("The draft is saved in Live.")).toBeVisible();
  await save(page).click();
  await expect(editor(page)).toHaveValue('"For real"');
  await expectWorkspace(page, "Live");
});

test("somebody who is signed out signs in first, and what was shared is there then, as it came", async ({
  page,
  ownEmail,
  isMobile,
}) => {
  // In quotation marks: the way back from signing in must not change it.
  await page.goto(shareAddress({ text: '"Shared while signed out"' }));

  // The app has them sign in, and keeps where they were going.
  await page.waitForURL(({ pathname }) => pathname === "/sign-in");
  await signIn(page, ownEmail);

  // Nothing was saved on the way: they are asked like anybody.
  await expect(shared(page)).toHaveText('"Shared while signed out"');
  await save(page).click();
  await expect(editor(page)).toHaveValue('"Shared while signed out"');
  await backToList(page, isMobile);
  await expect(draftRows(page)).toHaveCount(1);
});

// The server keeps where somebody was going through the sign-in, and no
// address of more than 1,000 characters: a longer one leads to the first
// screen. An address is written in ASCII, so a text in another script is
// several times as long in it as it reads. What was shared does not take
// that way: it stays on the device.
for (const [what, text] of [
  [
    "a long text",
    // 1,500 characters, each of them one of the address.
    `${"Shared while signed out, and long. ".repeat(43).trim()} End.`,
  ],
  [
    "a text in a script that an address has to encode",
    // 200 characters, each of them nine of the address.
    `${"分享到小猪的文字，登录之后还在。".repeat(12)}完完完完完完完完`,
  ],
] as const) {
  test(`${what} that is shared to somebody who is signed out is there after the sign-in, whole`, async ({
    page,
    ownEmail,
    isMobile,
  }) => {
    // The address as Android would open it is longer than the server
    // keeps: the test is about nothing otherwise.
    expect(shareAddress({ text }).length).toBeGreaterThan(1000);
    await page.goto(shareAddress({ text }));
    await page.waitForURL(({ pathname }) => pathname === "/sign-in");

    await signIn(page, ownEmail);

    await expect(shared(page)).toHaveText(text);
    await save(page).click();
    await expect(editor(page)).toHaveValue(text);
    await backToList(page, isMobile);
    await expect(draftRows(page)).toHaveCount(1);

    // Saved, it is no longer kept: the address of a share that names
    // nothing has nothing to offer a second time.
    await page.goto("/share");
    await page.waitForURL(({ pathname }) => pathname === "/");
    // No draft is open, so this is the list, also on a phone.
    await expectSync(page, "Synced");
    await expect(draftRows(page)).toHaveCount(1);
  });
}

test("what was shared to somebody who is signed out and left unsaved after the sign-in is not offered again later", async ({
  page,
  ownEmail,
}) => {
  await page.goto(shareAddress({ text: "Shared, and then left alone" }));
  await page.waitForURL(({ pathname }) => pathname === "/sign-in");
  await signIn(page, ownEmail);
  await expect(shared(page)).toHaveText("Shared, and then left alone");
  // A reload is no decision: the text is still there, as it is for a
  // share that the address holds.
  await page.reload();
  await expect(shared(page)).toHaveText("Shared, and then left alone");

  // They go elsewhere in the app without saying what to do with it.
  await page.goto("/settings");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");

  // The address of a share that names nothing, typed or kept: a share of
  // nothing, and not the text from before.
  await page.goto("/share");
  await page.waitForURL(({ pathname }) => pathname === "/");
  await expect(shared(page)).toHaveCount(0);
});

test("what is shared without a connection is shown, saved as a draft on the device, and synced later", async ({
  ownPage: page,
  context,
  otherDevice,
}) => {
  // The app is on the device once its service worker answers for it.
  await serviceWorkerAnswersFor(page);
  await context.setOffline(true);

  await page.goto(shareAddress({ text: "Shared on the train" }));

  await expect(shared(page)).toHaveText("Shared on the train");
  await save(page).click();
  await expect(editor(page)).toHaveValue("Shared on the train");

  await context.setOffline(false);
  const other = await otherDevice();
  await expect(draftRows(other)).toContainText("Shared on the train");
});

test("images that are shared are kept on the device, shown, and become a draft with them when the person says so", async ({
  ownPage: page,
  context,
}) => {
  // The service worker takes the form in.
  await serviceWorkerAnswersFor(page);
  const origin = new URL(page.url()).origin;

  const screen = await postShare(
    context,
    origin,
    { text: "From the gallery" },
    [
      file("boats.png", png(320, 240)),
      file("pier.png", png(240, 320, { color: [20, 90, 200] })),
      // Said to be a picture, and a page: what a file is, its bytes say.
      file("note.png", Buffer.from("<!doctype html><p>Not a picture</p>")),
    ],
  );

  // On to the screen, with the files on the device and nothing saved.
  await expect(screen).toHaveURL(/\/share\?text=From\+the\+gallery&files=/);
  await expect(shared(screen)).toHaveText("From the gallery");
  await expect(pictures(screen)).toHaveCount(2);
  await expect(
    screen.getByText("note.png is not a JPEG, PNG, WebP or GIF image."),
  ).toBeVisible();
  expect(await waitingShares(screen)).toBe(1);

  await save(screen).click();

  // A draft with the text and the two images, which are uploaded as the
  // editor uploads them, and the files of the share are gone from where
  // they waited.
  await expect(editor(screen)).toHaveValue("From the gallery");
  await uploadedImages(screen, 2);
  expect(await waitingShares(screen)).toBe(0);
  await expectSync(screen, "Synced");
  await screen.close();
});

test("a form that a site posts to the share address saves nothing and uploads nothing, and its files go when the person discards them", async ({
  ownPage: page,
  context,
  otherDevice,
}) => {
  await serviceWorkerAnswersFor(page);
  const origin = new URL(page.url()).origin;
  const uploads: string[] = [];
  await context.route("**/api/workspaces/*/media/**", async (route) => {
    uploads.push(route.request().url());
    await route.continue();
  });

  // As a site of somebody else's could post it, to a browser that is
  // signed in to pigy.
  const screen = await postShare(context, origin, {}, [
    file("planted.png", png(64, 64)),
  ]);
  await expect(pictures(screen)).toHaveCount(1);
  // Nothing has a text: the share is the image alone.
  await expect(shared(screen)).toHaveCount(0);
  await expectSync(screen, "Synced");
  const other = await otherDevice();
  await expectSync(other, "Synced");
  await expect(draftRows(other)).toHaveCount(0);

  await screen.getByRole("button", { name: "Discard" }).click();
  await expect(screen.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await expect(draftRows(screen)).toHaveCount(0);
  expect(uploads).toEqual([]);
  await expect.poll(() => waitingShares(screen)).toBe(0);
  await screen.close();
});

test("images that are shared to somebody who is signed out wait on the device while they sign in", async ({
  page,
  context,
  ownEmail,
}) => {
  // The service worker is there once the app has been opened: here, on
  // the sign-in page.
  await page.goto("/");
  await page.waitForURL(({ pathname }) => pathname === "/sign-in");
  await serviceWorkerAnswersFor(page);
  const origin = new URL(page.url()).origin;

  const screen = await postShare(context, origin, { title: "A view" }, [
    file("view.png", png(200, 120)),
  ]);
  await screen.waitForURL(({ pathname }) => pathname === "/sign-in");
  await signIn(screen, ownEmail);

  await expect(shared(screen)).toHaveText("A view");
  await expect(pictures(screen)).toHaveCount(1);
  await save(screen).click();
  await expect(editor(screen)).toHaveValue("A view");
  await uploadedImages(screen, 1);
  await screen.close();
});
