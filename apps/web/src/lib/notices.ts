import { toast } from "sonner";

/**
 * Whose the notices on screen are: those of the workspace that they were
 * made in, or those of the person.
 *
 * A notice is the workspace's unless it is said to be the person's here,
 * which is the safe way round. What a notice offers to do is done to the
 * workspace on screen, and what it says is read under the name of that
 * one: the undo of a deleted draft, a change that was refused. Such a
 * notice leaves the screen when the workspace does.
 *
 * A notice of the person's says how something went that they asked for
 * and may have to act on, to somebody who is no longer where they asked:
 * that a network kept the access of an account that was disconnected. It
 * stays until it is closed, whichever workspace is on screen by then. So
 * it has to say which workspace it is about, and it offers nothing to do.
 *
 * The notices of the person, by the ID that the notice library gave them.
 */
const ofPerson = new Set<string | number>();

/**
 * Makes the notice `id` one of the person's: it stays on screen when the
 * workspace changes. For a notice that names its workspace and offers
 * nothing to do.
 */
export function keepOverSwitch(id: string | number): void {
  ofPerson.add(id);
}

/**
 * Ends the notices of the workspace that the tab leaves. For the list of
 * the notices, in the step in which it goes itself: see `Notices` in
 * `components/app-shell.tsx`. The notices of the person are left alone,
 * and the notice library hands them to the list that comes next.
 */
export function dismissWorkspaceNotices(): void {
  const onScreen = new Set(toast.getToasts().map(({ id }) => id));
  for (const id of onScreen) {
    if (!ofPerson.has(id)) toast.dismiss(id);
  }
  // Those that the person has closed since are of nobody any more.
  for (const id of ofPerson) {
    if (!onScreen.has(id)) ofPerson.delete(id);
  }
}
