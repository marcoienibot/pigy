import { expect, signIn, test, uniqueEmail } from "../fixtures.ts";

test("an admin invites a member, changes their role and removes them", async ({
  signedInPage: admin,
  newPerson,
}, testInfo) => {
  const email = uniqueEmail(testInfo, "member");
  // The row of the member in the admin's list. Other tests add rows of
  // their own to the same list.
  const row = admin.getByRole("listitem").filter({ hasText: email });

  // Before the invitation, the member is refused.
  const member = await newPerson();
  await signIn(member, email);
  await expect(member).toHaveURL("/invite-only");

  await admin
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Settings" })
    .click();
  await admin.getByRole("link", { name: "Access" }).click();
  await admin.getByLabel("Email address to invite").fill(email);
  await admin.getByRole("button", { name: "Invite" }).click();
  await expect(row).toContainText("Has not signed in yet");
  // The form is ready for the next invitation.
  await expect(admin.getByLabel("Email address to invite")).toHaveValue("");

  // The list must fit the screen, on a phone too.
  const overflow = await admin.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBe(0);

  // Now the member gets in, as a member: without the admin's screen.
  await member.getByRole("link", { name: "Use another account" }).click();
  await signIn(member, email);
  await expect(member.getByRole("heading", { level: 1 })).toHaveText("Drafts");
  await member.goto("/settings/access");
  await expect(member).toHaveURL("/settings");
  await expect(member.getByRole("link", { name: "Access" })).toHaveCount(0);

  await admin.reload();
  await expect(row).toContainText("Has signed in");

  // A new role applies to the member's next step, without signing in again.
  await row.getByLabel(`Role of ${email}`).selectOption("Admin");
  await expect(row.getByLabel(`Role of ${email}`)).toHaveValue("admin");
  await member.getByRole("link", { name: "About" }).click();
  await expect(member.getByRole("link", { name: "Access" })).toBeVisible();

  // Removal asks first, and cancelling keeps the member.
  await row.getByRole("button", { name: `Remove ${email}` }).click();
  const dialog = admin.getByRole("alertdialog");
  await expect(dialog).toContainText(`Remove ${email}?`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: `Remove ${email}` }).click();
  await dialog.getByRole("button", { name: "Remove" }).click();
  await expect(row).toHaveCount(0);

  // The member is signed out by whatever they do next, here a click in the
  // navigation, and cannot get back in.
  await member
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Queue" })
    .click();
  await expect(member).toHaveURL("/sign-in?returnTo=%2Fqueue");
  await signIn(member, email);
  await expect(member).toHaveURL("/invite-only");
});

test("the admin from the configuration is listed as fixed", async ({
  signedInPage: page,
}) => {
  await page.goto("/settings/access");

  const row = page
    .getByRole("listitem")
    .filter({ hasText: "admin@example.com" });
  await expect(row).toContainText("Set in ADMIN_EMAILS");
  // Nothing to change the entry with: the Worker would refuse it.
  await expect(row.getByRole("combobox")).toHaveCount(0);
  await expect(row.getByRole("button")).toHaveCount(0);
});

test("inviting says what is wrong with an address", async ({
  signedInPage: page,
}, testInfo) => {
  const email = uniqueEmail(testInfo, "twice");
  await page.goto("/settings/access");
  const input = page.getByLabel("Email address to invite");
  const invite = page.getByRole("button", { name: "Invite" });

  await input.fill("not an address");
  await invite.click();
  await expect(page.getByRole("alert")).toHaveText(
    "Enter a valid email address.",
  );

  await input.fill(email);
  await invite.click();
  await expect(
    page.getByRole("listitem").filter({ hasText: email }),
  ).toBeVisible();
  // The error of the attempt before is gone.
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The second invitation is refused by the Worker, and its reason shown.
  await input.fill(email);
  await invite.click();
  await expect(page.getByRole("alert")).toHaveText(
    `${email} is already on the list`,
  );
});
