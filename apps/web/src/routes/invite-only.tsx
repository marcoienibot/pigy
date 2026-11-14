import { createFileRoute, Link } from "@tanstack/react-router";
import { PublicPage } from "@/components/page";
import { buttonVariants } from "@/components/ui/button";

// Where the Worker sends somebody whose Google account is not invited.
export const Route = createFileRoute("/invite-only")({
  component: InviteOnly,
});

function InviteOnly() {
  return (
    <PublicPage title="pigy is invite-only">
      <p className="mt-1 text-muted-foreground">
        The Google account you chose has not been invited. Ask whoever runs this
        pigy to invite you, or sign in with another account.
      </p>
      <Link
        to="/sign-in"
        className={buttonVariants({
          variant: "outline",
          className: "mt-6 w-full",
        })}
      >
        Use another account
      </Link>
    </PublicPage>
  );
}
