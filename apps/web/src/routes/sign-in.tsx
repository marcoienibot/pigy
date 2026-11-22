import { type SignInError, safeReturnTo, signInErrorSchema } from "@pigy/core";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { PublicPage } from "@/components/page";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { answeredInTime, fetchMe, unanswered } from "@/lib/api";
import { useOnline } from "@/lib/online";
import {
  endSession,
  forgetSession,
  holdsSession,
  keptChanges,
  serverJustSilent,
} from "@/lib/session";

type SignInSearch = {
  /** The path to open after signing in. */
  returnTo?: string;
  /** Set by the Worker when a sign-in did not complete. */
  error?: SignInError;
};

export const Route = createFileRoute("/sign-in")({
  validateSearch: (search): SignInSearch => {
    const error = signInErrorSchema.safeParse(search.error);
    return {
      ...(typeof search.returnTo === "string" && { returnTo: search.returnTo }),
      ...(error.success && { error: error.data }),
    };
  },
  // Somebody who is signed in already has no use for this page. If that
  // cannot be found out, the page is shown and says why. Without an
  // answer of the server, as without a connection, it does not offer to
  // sign in: that leaves the app for the server, and would end on an
  // error page of the browser. A server that answers with an error can
  // still be asked to sign somebody in. `signIn` says whether the page
  // offers to. The page shows nothing before this is decided, so the
  // server is given a time to answer in: a request that is never answered
  // is one without an answer when that is up.
  beforeLoad: async ({ search, abortController }) => {
    // The app has just asked on its way here, for a device that holds a
    // session which is over, and got no answer in its time: the same
    // question would be the same wait again, with nothing on screen.
    if (serverJustSilent()) {
      return { server: "unreachable", signIn: false } as const;
    }
    let me: Awaited<ReturnType<typeof fetchMe>>;
    try {
      me = await answeredInTime(fetchMe, abortController.signal);
    } catch (error) {
      // The router has given this navigation up, and wants no answer.
      if (abortController.signal.aborted) throw error;
      if (unanswered(error)) {
        return { server: "unreachable", signIn: false } as const;
      }
      // Not over a session that this device still takes to be good. The
      // server has not said that it is over, so `endSession` below has
      // not dealt with it: nothing has looked for changes that were never
      // synced, and nothing has said that they are there. Whoever signed
      // in as somebody else now would have them deleted without a word,
      // as soon as the app has heard who is signed in.
      return { server: "failed", signIn: !holdsSession() } as const;
    }
    if (me) {
      // Loaded as a page, so that the address arrives as it is written:
      // the router would write its query anew, as it reads it.
      throw redirect({
        href: safeReturnTo(search.returnTo),
        replace: true,
        reloadDocument: true,
      });
    }
    // Nobody is signed in, so what this device holds of a session goes
    // before somebody else signs in here, unless something needs it: on
    // every load of this page, so that what was kept goes when nothing
    // needs it any more.
    await endSession();
    return { server: "answered", signIn: true } as const;
  },
  // What did not go: changes that were never synced, and what other
  // windows are still trying to store.
  loader: () => keptChanges(),
  component: SignIn,
});

const errorMessages: Record<SignInError, string> = {
  failed: "Signing in did not work. Please try again.",
  email_not_verified:
    "Google has not verified the email address of that account. Verify it with Google, or use another account.",
  not_configured:
    "Sign-in is not set up on this server. Whoever runs it has to add the Google credentials.",
};

function SignIn() {
  const { returnTo, error } = Route.useSearch();
  const { server, signIn } = Route.useRouteContext();
  const kept = Route.useLoaderData();
  const router = useRouter();
  // When the connection is back, there is no need to press the button.
  // That is no news about a server that has answered with an error.
  useOnline(() => {
    if (server === "unreachable") void router.invalidate();
  });
  const start = `/api/auth/google/start${
    returnTo ? `?${new URLSearchParams({ returnTo })}` : ""
  }`;

  return (
    <PublicPage title="Sign in to pigy">
      <p className="mt-1 text-muted-foreground">
        pigy is invite-only. Use the Google account you were invited with.
      </p>
      {error && (
        <p
          role="alert"
          className="mt-4 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-left text-destructive"
        >
          {errorMessages[error]}
        </p>
      )}
      {kept && <KeptChanges {...kept} />}
      {server === "unreachable" && (
        <p role="status" className="mt-4 rounded-lg border px-3 py-2 text-left">
          pigy cannot reach its server. Signing in takes a connection.
        </p>
      )}
      {server === "failed" && (
        <p role="status" className="mt-4 rounded-lg border px-3 py-2 text-left">
          Something went wrong on the server of pigy.{" "}
          {signIn
            ? "You can sign in, or try again in a moment."
            : "Try again in a moment."}
        </p>
      )}
      {signIn && (
        // A plain link: signing in leaves the app for Google and comes
        // back with a page load.
        <a
          href={start}
          className={buttonVariants({ size: "lg", className: "mt-6 w-full" })}
        >
          <GoogleLogo />
          Sign in with Google
        </a>
      )}
      {server !== "answered" && (
        <Button
          variant="outline"
          size="lg"
          className={signIn ? "mt-3 w-full" : "mt-6 w-full"}
          onClick={() => router.invalidate()}
        >
          Try again
        </Button>
      )}
    </PublicPage>
  );
}

/**
 * Says that this device holds changes of a session that ended before they
 * were synced, what becomes of them, and lets the person discard them.
 *
 * `count` of them are in the copies. `unstored` are in other windows,
 * which could not store them and stay open to try again. With `unknown`,
 * a window holds changes that it has not stored and has not said how
 * many: it does not answer, or its write is still under way. Deleting
 * takes all of those too, because the windows start again when the copies
 * go, so the question that is asked first counts what was counted and
 * says what was not.
 */
function KeptChanges({
  count,
  unstored,
  unknown,
  email,
}: {
  count: number;
  unstored: number;
  unknown: boolean;
  email: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const all = count + unstored;
  const changes = all === 1 ? "1 change" : `${all} changes`;
  // One change, and no window that may hold more.
  const one = all === 1 && !unknown;
  const who = <span className="font-medium">{email}</span>;

  return (
    <div className="mt-4 rounded-lg border px-3 py-2 text-left">
      {count > 0 && (
        <p>
          You were signed out before{" "}
          {count === 1 ? "1 change" : `${count} changes`} made on this device as{" "}
          {who} could be synced. Sign in with that account to sync{" "}
          {count === 1 ? "it" : "them"}. If somebody else signs in,{" "}
          {count === 1 ? "it is" : "they are"} deleted.
        </p>
      )}
      {unstored > 0 && !unknown && (
        <p className={count > 0 ? "mt-2" : undefined}>
          Another window of pigy holds{" "}
          {unstored === 1 ? "1 change" : `${unstored} changes`} of {who} that it
          could not save on this device. It keeps trying.{" "}
          {unstored === 1 ? "The change is" : "They are"} lost if that window is
          closed or somebody else signs in.
        </p>
      )}
      {unstored > 0 && unknown && (
        <p className={count > 0 ? "mt-2" : undefined}>
          Other windows of pigy hold at least{" "}
          {unstored === 1 ? "1 change" : `${unstored} changes`} of {who} that
          they have not saved on this device: one of them has not said how many.
          They are lost if those windows are closed or somebody else signs in.
        </p>
      )}
      {unstored === 0 && unknown && (
        <p className={count > 0 ? "mt-2" : undefined}>
          Another window of pigy holds changes of {who} that it has not saved on
          this device yet, and has not said how many. They are lost if that
          window is closed or somebody else signs in.
        </p>
      )}
      <Button
        variant="link"
        size="sm"
        className="mt-1 h-auto px-0 text-destructive"
        onClick={() => setConfirming(true)}
      >
        Delete {one ? "this change" : "these changes"}
      </Button>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {!unknown && `Delete ${changes}?`}
              {unknown && all > 0 && `Delete at least ${changes}?`}
              {unknown && all === 0 && "Delete the changes of another window?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {one ? "It exists" : "They exist"} only on this device and cannot
              be brought back.
              {unknown &&
                " Another window of pigy holds changes that it has not saved, and has not said how many: they go too."}
              {(unstored > 0 || unknown) &&
                " The other window of pigy goes to the sign-in page too."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                await forgetSession();
                await router.invalidate();
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Google's "G", in the colours its sign-in branding asks for. */
function GoogleLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1Z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09a6.6 6.6 0 0 1 0-4.18V7.07H2.18a11 11 0 0 0 0 9.86l3.66-2.84Z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1A11 11 0 0 0 2.18 7.07l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38Z"
      />
    </svg>
  );
}
