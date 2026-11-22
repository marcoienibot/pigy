import {
  type AllowedEmail,
  emailSchema,
  type Role,
  roleSchema,
} from "@pigy/core";
import {
  createFileRoute,
  type ErrorComponentProps,
  redirect,
  useRouter,
} from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import {
  addAllowedEmail,
  fetchAllowedEmails,
  removeAllowedEmail,
  updateAllowedEmail,
} from "@/lib/api";

export const Route = createFileRoute("/_app/settings/access")({
  // The Worker refuses members anyway. This keeps them from landing on a
  // screen that could only show them an error.
  beforeLoad: ({ context }) => {
    if (context.me.role !== "admin") {
      throw redirect({ to: "/settings", replace: true });
    }
  },
  loader: ({ abortController }) => fetchAllowedEmails(abortController.signal),
  component: Access,
  errorComponent: AccessError,
});

const roleLabels: Record<Role, string> = {
  admin: "Admin",
  member: "Member",
};

function RoleSelect({
  label,
  value,
  onChange,
  size = "default",
  disabled = false,
}: {
  label: string;
  value: Role;
  onChange: (role: Role) => void;
  size?: "default" | "sm";
  disabled?: boolean;
}) {
  return (
    <NativeSelect
      aria-label={label}
      size={size}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(roleSchema.parse(event.target.value))}
    >
      {roleSchema.options.map((role) => (
        <NativeSelectOption key={role} value={role}>
          {roleLabels[role]}
        </NativeSelectOption>
      ))}
    </NativeSelect>
  );
}

function Access() {
  const allowedEmails = Route.useLoaderData();
  const { me } = Route.useRouteContext();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The address that is about to be removed, while the question is open.
  const [removing, setRemoving] = useState<string | null>(null);

  /** Runs a change, shows why it failed if it did, and reloads the list. */
  const change = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    let done = true;
    try {
      await action();
    } catch (failure) {
      done = false;
      setError(failure instanceof Error ? failure.message : String(failure));
    }
    // Also after a failure: the list on screen may be out of date, which is
    // a likely reason for the failure. If the session has ended, this is
    // what leads to the sign-in page.
    await router.invalidate();
    setBusy(false);
    return done;
  };

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    const parsed = emailSchema.safeParse(email);
    if (!parsed.success) {
      setError("Enter a valid email address.");
      return;
    }
    if (await change(() => addAllowedEmail({ email: parsed.data, role }))) {
      setEmail("");
    }
  };

  return (
    <section>
      <h2 className="font-medium">Access</h2>
      <p className="mt-1 text-muted-foreground">
        Only the people listed here can sign in, with the Google account that
        has the email address.
      </p>

      <form onSubmit={invite} noValidate className="mt-4 flex flex-wrap gap-2">
        <Input
          type="email"
          aria-label="Email address to invite"
          placeholder="name@example.com"
          autoComplete="off"
          className="min-w-48 flex-1"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <RoleSelect
          label="Role of the invitation"
          value={role}
          onChange={setRole}
        />
        <Button type="submit" disabled={busy}>
          Invite
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}

      <ul className="mt-4 divide-y rounded-lg border">
        {allowedEmails.map((entry) => (
          <AccessRow
            key={entry.email}
            entry={entry}
            isMe={entry.email === me.user.email}
            busy={busy}
            onRoleChange={(next) =>
              change(() => updateAllowedEmail(entry.email, next))
            }
            onRemove={() => setRemoving(entry.email)}
          />
        ))}
      </ul>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing}?</AlertDialogTitle>
            {/* One description, which the dialog is described by. */}
            <AlertDialogDescription
              render={<div className="flex flex-col gap-2" />}
            >
              <p>
                They are signed out at once, on every device, and cannot sign in
                until they are invited again. Their API keys are revoked, and do
                not work again with a new invitation.
              </p>
              <p>
                Their workspaces are frozen until they sign in again: no
                scheduled post goes out, the posts that wait their turn are not
                sent, and the access to their accounts is not renewed, so that
                it ends at each network by itself. A post that is being sent at
                this moment still goes out. An access to Mastodon does not end
                by itself: it stays, unused, until they disconnect the account.
              </p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) change(() => removeAllowedEmail(removing));
                setRemoving(null);
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function AccessRow({
  entry,
  isMe,
  busy,
  onRoleChange,
  onRemove,
}: {
  entry: AllowedEmail;
  isMe: boolean;
  busy: boolean;
  onRoleChange: (role: Role) => void;
  onRemove: () => void;
}) {
  // What the Worker would refuse is not offered.
  const editable = !entry.fixed && !isMe;
  const notes = [
    isMe ? "You" : entry.signedIn ? "Has signed in" : "Has not signed in yet",
    entry.fixed && "Set in ADMIN_EMAILS",
  ].filter(Boolean);

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      <div className="min-w-0 flex-1 basis-48">
        <div className="truncate">{entry.email}</div>
        <div className="text-xs text-muted-foreground">{notes.join(" · ")}</div>
      </div>
      {editable ? (
        <>
          <RoleSelect
            label={`Role of ${entry.email}`}
            size="sm"
            value={entry.role}
            onChange={onRoleChange}
            disabled={busy}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${entry.email}`}
            disabled={busy}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground">{roleLabels[entry.role]}</span>
      )}
    </li>
  );
}

function AccessError({ error }: ErrorComponentProps) {
  const router = useRouter();

  return (
    <section>
      <h2 className="font-medium">Access</h2>
      <p role="alert" className="mt-1 text-destructive">
        {error instanceof Error ? error.message : String(error)}
      </p>
      <Button
        variant="outline"
        size="sm"
        className="mt-3"
        onClick={() => router.invalidate()}
      >
        Retry
      </Button>
    </section>
  );
}
