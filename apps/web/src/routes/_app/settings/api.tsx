import {
  type ApiKey,
  type CreateApiKeyResponse,
  grantableApiScopes,
  maxApiKeyNameLength,
} from "@pigy/core";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Trash2 } from "lucide-react";
import { type FormEvent, useCallback, useRef, useState } from "react";
import { RefreshFailure } from "@/components/refresh-failure";
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
import { createApiKey, fetchApiKeys, revokeApiKey } from "@/lib/api";
import {
  expiryOf,
  keyNotes,
  lifetimes,
  reachOf,
  scopeLabels,
  workspaceWords,
} from "@/lib/api-keys";
import { checkSignedOut, failureMessage, useFetched } from "@/lib/fetched";
import { useNow } from "@/lib/time";

export const Route = createFileRoute("/_app/settings/api")({
  component: Api,
});

/**
 * The keys of the public API of the workspace on screen. They are not
 * synced: a key is the server's, and making one needs a connection. The
 * list, and the key that was just made, are kept in this screen alone, so
 * they go with it when the workspace changes: a key of the live workspace
 * is never on screen under the name of the sandbox.
 */
function Api() {
  const { workspace } = Route.useRouteContext();
  const request = useCallback(
    (signal: AbortSignal) => fetchApiKeys(workspace.id, signal),
    [workspace.id],
  );
  const { data: keys, failure, loading, refresh } = useFetched(request);
  // The key that was just made, with its secret, until the person says
  // that they have it.
  const [made, setMade] = useState<CreateApiKeyResponse | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow();

  /** Makes a request that changes the keys, and reads the list again. */
  const change = async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    let done = true;
    try {
      await action();
    } catch (failed) {
      done = false;
      checkSignedOut(failed);
      setError(failureMessage(failed));
    }
    setBusy(false);
    refresh();
    return done;
  };

  return (
    <section>
      <h2 className="font-medium">API keys</h2>
      <p className="mt-1 text-muted-foreground">
        A key lets a script do what you do here: write posts, share and schedule
        them, and read what became of them. {reachOf[workspace.environment]}{" "}
        <a
          href="/api/v1/docs"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          How to use the API
        </a>
      </p>

      {made && <NewKey made={made} onDone={() => setMade(null)} />}

      <CreateForm
        busy={busy}
        onCreate={({ name, scopes, days }) =>
          change(async () => {
            setMade(
              await createApiKey(workspace.id, {
                name,
                scopes,
                expiresAt: expiryOf(days, Date.now()),
              }),
            );
          })
        }
      />
      {error && (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      )}

      <div className="mt-6">
        {keys === null ? (
          failure ? (
            <div role="alert">
              <p className="text-destructive">{failureMessage(failure)}</p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={refresh}
                disabled={loading}
              >
                Try again
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground">Loading the keys…</p>
          )
        ) : (
          <>
            {failure !== null && (
              <div className="mb-3">
                <RefreshFailure
                  what="The keys"
                  failure={failure}
                  loading={loading}
                  onRetry={refresh}
                />
              </div>
            )}
            {keys.length === 0 ? (
              <p className="text-muted-foreground">
                The {workspaceWords[workspace.environment]} has no API keys.
              </p>
            ) : (
              <ul aria-label="API keys" className="divide-y rounded-lg border">
                {keys.map((key) => (
                  <li key={key.id} className="flex items-start gap-3 px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-medium break-words">
                          {key.name}
                        </span>
                        <code className="text-xs text-muted-foreground">
                          {key.prefix}…
                        </code>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {key.scopes.join(", ")}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {keyNotes(key, now)}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Revoke ${key.name}`}
                      disabled={busy}
                      onClick={() => setRevoking(key)}
                    >
                      <Trash2 aria-hidden="true" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revoking?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Whatever uses this key stops working at once. A revoked key cannot
              be brought back: make a new one in its place.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const key = revoking;
                setRevoking(null);
                if (!key) return;
                // The key that is on screen with its secret is this one.
                if (made?.apiKey.id === key.id) setMade(null);
                void change(() => revokeApiKey(workspace.id, key.id));
              }}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** The key that was just made: the one time that its secret is shown. */
function NewKey({
  made,
  onDone,
}: {
  made: CreateApiKeyResponse;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState<boolean | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(made.secret);
      setCopied(true);
    } catch {
      // The browser did not let the page write to the clipboard. The key
      // is selected, for the person to copy it themselves.
      field.current?.select();
      setCopied(false);
    }
  };

  return (
    <section
      aria-label="Your new key"
      className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
    >
      <h3 className="font-medium">Copy the key “{made.apiKey.name}” now</h3>
      <p className="mt-1">
        This is the only time that pigy shows it. If you lose it, revoke it and
        make another. Anybody who has it can use it, so keep it out of chats,
        screenshots and code that others see.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Input
          ref={field}
          readOnly
          aria-label="The new key"
          value={made.secret}
          className="min-w-48 flex-1 font-mono text-xs"
          onFocus={(event) => event.target.select()}
        />
        <Button variant="outline" onClick={copy}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </Button>
        <Button onClick={onDone}>I have copied it</Button>
      </div>
      <p role="status" className="mt-2 text-xs text-muted-foreground">
        {copied === false &&
          "The browser did not let pigy copy the key. It is selected: copy it yourself."}
      </p>
    </section>
  );
}

function CreateForm({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (key: {
    name: string;
    scopes: (typeof grantableApiScopes)[number][];
    days: number | null;
  }) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<ReadonlySet<string>>(
    new Set(grantableApiScopes),
  );
  const [lifetime, setLifetime] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const chosen = grantableApiScopes.filter((scope) => scopes.has(scope));
    if (name.trim() === "") {
      setError("Give the key a name, to know later what uses it.");
      return;
    }
    if (chosen.length === 0) {
      setError("Choose what the key may do.");
      return;
    }
    setError(null);
    const made = await onCreate({
      name: name.trim(),
      scopes: chosen,
      days: lifetimes[lifetime]?.days ?? null,
    });
    if (made) setName("");
  };

  return (
    <form onSubmit={submit} noValidate className="mt-4 space-y-3">
      <Input
        aria-label="Name of the new key"
        placeholder="What will use the key"
        autoComplete="off"
        maxLength={maxApiKeyNameLength}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <fieldset>
        <legend className="text-muted-foreground">The key may</legend>
        {grantableApiScopes.map((scope) => (
          <label key={scope} className="mt-1 flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 size-4 accent-foreground"
              checked={scopes.has(scope)}
              onChange={(event) => {
                const next = new Set(scopes);
                if (event.target.checked) next.add(scope);
                else next.delete(scope);
                setScopes(next);
              }}
            />
            <span>
              {scopeLabels[scope]}{" "}
              <code className="text-xs text-muted-foreground">{scope}</code>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <NativeSelect
          aria-label="How long the key works"
          value={String(lifetime)}
          onChange={(event) => setLifetime(Number(event.target.value))}
        >
          {lifetimes.map(({ label }, index) => (
            <NativeSelectOption key={label} value={String(index)}>
              {label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <Button type="submit" disabled={busy}>
          Create key
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
