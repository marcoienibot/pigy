import {
  type ConnectOutcome,
  connectOutcomeOf,
  maxConnectIdentifierLength,
  type Network,
  networkSchema,
  sandboxServers,
  type Workspace,
} from "@pigy/core";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, Plus, Unplug, X } from "lucide-react";
import {
  type FormEvent,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { EmptyState, Page } from "@/components/page";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ApiError, beginConnect, disconnectChannel } from "@/lib/api";
import {
  type Channel,
  connectNotice,
  disconnectNotice,
  keepConnectOutcome,
  type Notice,
  overChannels,
  selectChannels,
  takeConnectOutcome,
} from "@/lib/channels";
import {
  comingNetworks,
  connectableNetworks,
  listedNetworks,
  networkInfo,
} from "@/lib/networks";
import { keepOverSwitch } from "@/lib/notices";
import { checkSession } from "@/lib/session";
import { cn } from "@/lib/utils";
import { environmentLabels, showWorkspace } from "@/lib/workspace";
import { useSynced, useSyncState } from "@/sync/react";
import { unsavedInTab } from "@/sync/workspace-sync";

type ChannelsSearch = {
  /**
   * The dialog that connects an account is open: on the choice of a
   * network, or on the form of the network that is named.
   */
  add?: true | Network;
  /** It is open to connect the account of this channel again: its ID. */
  reconnect?: string;
} & Partial<ConnectOutcome>;

export const Route = createFileRoute("/_app/channels")({
  validateSearch: (search): ChannelsSearch => {
    const network = networkSchema.safeParse(search.add);
    return {
      ...(search.add === true && { add: true }),
      ...(network.success && { add: network.data }),
      ...(typeof search.reconnect === "string" && {
        reconnect: search.reconnect,
      }),
      // How a connection ended, which a network sends the browser back
      // with: `beforeLoad` takes it out of the address.
      ...connectOutcomeOf(search),
    };
  },
  beforeLoad: ({ search, context, preload }) => {
    const outcome = connectOutcomeOf(search);
    if (!outcome || preload) return;
    // The connection was for one of the person's two workspaces, and it
    // can end in a tab that shows the other: it was begun in another tab,
    // or the network has sent the browser back in a new one. The person
    // is shown the workspace that it was for.
    const workspace = context.workspaces.find(
      ({ id }) => id === outcome.workspace,
    );
    if (workspace) showWorkspace(workspace);
    keepConnectOutcome(outcome);
    // On to the address without the outcome, so that loading the page
    // again does not say it again. That also takes the app through the
    // route above once more, which opens the workspace to show.
    throw redirect({ to: "/channels", replace: true });
  },
  component: Channels,
});

/** Why what needs the server cannot be done right now. */
const offlineNote =
  "You are offline. Connecting and disconnecting accounts need a connection.";

/** What the screen says above the list, until something else happens. */
type Said =
  /** A connection has ended, and brought the browser here. */
  | { outcome: ConnectOutcome }
  /** The person has disconnected a channel. */
  | { disconnected: Channel; revoked: boolean };

/**
 * The connected accounts of the workspace, and the way to connect one and
 * to disconnect it.
 *
 * The list is read from the local copy, like every screen, so it is there
 * at once and without a connection. Connecting and disconnecting are not
 * changes that the device can make by itself: they go to the server over
 * HTTP, because the server holds what an account is connected with. They
 * need a connection, and the list follows when the change arrives.
 */
function Channels() {
  const { workspace } = Route.useRouteContext();
  const { add, reconnect } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const synced = useSynced(selectChannels);
  const offline = useSyncState().connection === "offline";
  const sandbox = workspace.environment === "sandbox";

  const [said, setSaid] = useState<Said | null>(() => {
    const outcome = takeConnectOutcome();
    return outcome ? { outcome } : null;
  });
  // The channels that the server has removed for this screen. The copy
  // hears of it a moment later, and until then they are not listed: the
  // person has been told that they are gone.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const channels = synced.filter(({ id }) => !gone.has(id));
  // The channel that the person is asked about before it is disconnected.
  const [removing, setRemoving] = useState<Channel | null>(null);

  // The channel that a connection has just made, once the copy has it.
  const connected =
    said && "outcome" in said && said.outcome.connect === "connected"
      ? channels.find(({ id }) => id === said.outcome.channel)
      : undefined;
  const notice =
    said &&
    ("outcome" in said
      ? connectNotice(said.outcome, connected)
      : disconnectNotice(said.disconnected, said.revoked));

  const again = channels.find(({ id }) => id === reconnect);
  const dialogOpen = add !== undefined || again !== undefined;
  // The dialog that connects an account is one step in the history of
  // the browser, whatever it shows. Opening it adds an entry, so that
  // Back closes it. Its steps take the place of that entry: Back leads
  // out of the dialog, and not through what it has shown.
  //
  // The entry that this screen adds says that the screen is under it:
  // `overChannels`. Closing the dialog then takes the entry back, and the
  // history is as it was before the dialog. Putting the screen in the
  // place of the entry would leave the screen in the history twice, once
  // more for every time the dialog was closed, and Back would do nothing
  // that often.
  const open = (search: ChannelsSearch) =>
    void navigate({ search, state: overChannels });
  // Asked of the entry that the browser is on, which the screen follows a
  // moment later.
  const isOverScreen = () =>
    router.history.location.state.overChannels === true;
  const step = (search: ChannelsSearch) =>
    void navigate({
      search,
      replace: true,
      ...(isOverScreen() && { state: overChannels }),
    });
  // Back has been asked for and the dialog is still there: the browser
  // goes back a moment after it is told to. A second "Cancel" or Escape in
  // that moment must not go back a second time, out of the screen.
  const leaving = useRef(false);
  useEffect(() => {
    if (!dialogOpen) leaving.current = false;
  }, [dialogOpen]);
  const close = () => {
    // What is under an entry that this screen did not add is not known:
    // the dialog was opened by a link from another screen, or by an
    // address from outside the app. The screen takes the place of the
    // entry there, so that Back leads to where the person came from.
    if (!isOverScreen()) return step({});
    if (leaving.current) return;
    leaving.current = true;
    router.history.back();
  };
  const connectButton = useRef<HTMLButtonElement>(null);

  return (
    <Page
      title="Channels"
      actions={
        <Button
          ref={connectButton}
          variant="outline"
          size="sm"
          disabled={offline}
          onClick={() => open({ add: true })}
        >
          <Plus aria-hidden="true" />
          Connect account
        </Button>
      }
    >
      <div className="mx-auto flex max-w-xl flex-col gap-3">
        {offline && (
          <p
            role="status"
            className="rounded-lg border px-3 py-2 text-muted-foreground"
          >
            {offlineNote} The list is the copy on this device.
          </p>
        )}
        {notice && <NoticeLine notice={notice} onClose={() => setSaid(null)} />}

        {channels.length === 0 ? (
          <EmptyState
            title="No accounts connected"
            description={
              sandbox
                ? "A channel is an account on a network that pigy posts to for you. The networks of the sandbox are simulated: connect one of its made-up accounts, and nothing you publish goes anywhere real."
                : "A channel is an account on a network that pigy posts to for you. Connect one to publish what you write."
            }
          >
            <div className="flex flex-col items-center gap-2">
              {connectableNetworks.map((network) => (
                <Button
                  key={network}
                  disabled={offline}
                  onClick={() => open({ add: network })}
                >
                  Connect a {sandbox ? "simulated " : ""}
                  {networkInfo[network].label} account
                </Button>
              ))}
              {comingNetworks.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {new Intl.ListFormat("en").format(comingNetworks)} are coming.
                </p>
              )}
            </div>
          </EmptyState>
        ) : (
          <ul aria-label="Channels" className="divide-y rounded-lg border">
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                isNew={channel === connected}
                offline={offline}
                onReconnect={() => open({ reconnect: channel.id })}
                onDisconnect={() => setRemoving(channel)}
              />
            ))}
          </ul>
        )}
      </div>

      <ConnectDialog
        open={dialogOpen}
        network={again?.network ?? (add === true ? undefined : add)}
        again={again}
        workspace={workspace}
        offline={offline}
        onChoose={(network) => step({ add: network })}
        onClose={close}
      />
      <DisconnectDialog
        channel={removing}
        workspace={workspace}
        offline={offline}
        focusAfter={connectButton}
        onClose={() => setRemoving(null)}
        onDisconnected={(channel, revoked) => {
          setGone((before) => new Set(before).add(channel.id));
          setSaid(
            revoked === undefined ? null : { disconnected: channel, revoked },
          );
          setRemoving(null);
        }}
      />
    </Page>
  );
}

const noticeTones: Record<Notice["tone"], string> = {
  good: "border-emerald-600/30 bg-emerald-500/10",
  plain: "",
  bad: "border-destructive/30 bg-destructive/10",
};

/** What happened, in a line above the list, until it is closed. */
function NoticeLine({
  notice,
  onClose,
}: {
  notice: Notice;
  onClose: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border py-1.5 pr-1.5 pl-3",
        noticeTones[notice.tone],
      )}
    >
      <p
        // Read out when it appears. What did not work interrupts.
        role={notice.tone === "bad" ? "alert" : "status"}
        className="min-w-0 flex-1 py-0.5"
      >
        {notice.text}
      </p>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close"
        onClick={onClose}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );
}

function ChannelRow({
  channel,
  isNew,
  offline,
  onReconnect,
  onDisconnect,
}: {
  channel: Channel;
  /** A connection that has just ended made this channel. */
  isNew: boolean;
  offline: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}) {
  const { label } = networkInfo[channel.network];
  const broken = channel.status === "needs_reconnect";

  return (
    <li
      className={cn(
        "flex items-center gap-3 px-3 py-2 first:rounded-t-lg last:rounded-b-lg",
        isNew && "bg-accent",
      )}
    >
      <Avatar
        name={channel.name}
        src={channel.avatarUrl}
        className="size-8 text-xs"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate font-medium">{channel.name}</span>
          <span
            className={cn(
              "shrink-0 text-xs",
              broken
                ? "text-amber-700 dark:text-amber-400"
                : "text-muted-foreground",
            )}
          >
            {broken ? "Needs reconnecting" : "Connected"}
          </span>
        </div>
        <div className="truncate text-muted-foreground">
          {label} ·{" "}
          {channel.profileUrl ? (
            <a
              href={channel.profileUrl}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-4 outline-none hover:underline focus-visible:underline"
            >
              {channel.handle}
            </a>
          ) : (
            channel.handle
          )}
        </div>
      </div>
      {broken && (
        <Button
          variant="outline"
          size="sm"
          disabled={offline}
          aria-label={`Reconnect ${channel.handle}`}
          onClick={onReconnect}
        >
          Reconnect
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        disabled={offline}
        aria-label={`Disconnect ${channel.handle}`}
        onClick={onDisconnect}
      >
        <Unplug aria-hidden="true" />
        <span className="hidden md:inline">Disconnect</span>
      </Button>
    </li>
  );
}

/**
 * Connects an account: the choice of a network, then what that network
 * asks before it sends the person to itself. `network` is the one that
 * is chosen, and `again` the channel whose account is connected again.
 */
function ConnectDialog({
  open,
  network,
  again,
  workspace,
  offline,
  onChoose,
  onClose,
}: {
  open: boolean;
  network: Network | undefined;
  again: Channel | undefined;
  workspace: Workspace;
  offline: boolean;
  onChoose: (network: Network | true) => void;
  onClose: () => void;
}) {
  // What the dialog is about stays in it while it closes.
  const [view, setView] = useState({ network, again });
  if (open && (view.network !== network || view.again !== again)) {
    setView({ network, again });
  }
  // A network that cannot be connected yet is not chosen, whatever the
  // address says.
  const chosen =
    view.network && networkInfo[view.network].connect
      ? view.network
      : undefined;
  // The request of the form that begins a connection, while it is on its
  // way. Whatever takes the form away calls the connection off, at once:
  // the request is given up, and the form does not follow an answer that
  // comes all the same. Otherwise the answer would take the browser to the
  // network after the person has turned to something else, which can be
  // the other workspace.
  const attempt = useRef<AbortController>(null);
  const callOff = () => attempt.current?.abort();
  // The dialog also closes without being told to, when the address
  // changes under it.
  useEffect(() => {
    if (!open) attempt.current?.abort();
  }, [open]);
  const close = () => {
    callOff();
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) close();
      }}
    >
      <DialogContent>
        {chosen ? (
          <ConnectForm
            // A form of its own for every network and account.
            key={`${chosen}/${view.again?.id ?? ""}`}
            network={chosen}
            again={view.again}
            workspace={workspace}
            offline={offline}
            attempt={attempt}
            onBack={
              view.again
                ? undefined
                : () => {
                    callOff();
                    onChoose(true);
                  }
            }
            onCancel={close}
          />
        ) : (
          <NetworkChoice onChoose={onChoose} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The networks: those that can be connected to choose from, the others. */
function NetworkChoice({ onChoose }: { onChoose: (network: Network) => void }) {
  const list = useRef<HTMLUListElement>(null);
  // The keyboard goes on where the dialog does: on the first network, also
  // when this takes the place of a form whose button had the focus.
  useEffect(() => list.current?.querySelector("button")?.focus(), []);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Connect an account</DialogTitle>
        <DialogDescription>
          Choose the network that the account is on.
        </DialogDescription>
      </DialogHeader>
      <ul ref={list} aria-label="Networks" className="-mx-1.5">
        {listedNetworks.map((network) =>
          networkInfo[network].connect ? (
            <li key={network}>
              <button
                type="button"
                className="flex h-8 w-full items-center justify-between rounded-md px-1.5 font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onChoose(network)}
              >
                {networkInfo[network].label}
                <ChevronRight
                  aria-hidden="true"
                  className="size-4 text-muted-foreground"
                />
              </button>
            </li>
          ) : (
            // Not a button: there is nothing to do with it yet.
            <li
              key={network}
              className="flex h-8 items-center justify-between px-1.5 text-muted-foreground"
            >
              {networkInfo[network].label}
              <span className="text-xs">Coming soon</span>
            </li>
          ),
        )}
      </ul>
    </>
  );
}

/** Where a refusal to begin a connection is shown, and what it says. */
type Refusal = { atField: boolean; message: string };

/**
 * What to tell the person when a connection could not be begun.
 * `ConnectError` in `@pigy/core` says what each answer means.
 */
function refusalOf(failure: unknown, hasField: boolean): Refusal {
  if (!(failure instanceof ApiError)) {
    return {
      atField: false,
      message: "pigy did not answer. Check your connection and try again.",
    };
  }
  const { status, field, message } = failure;
  // About what was typed: next to it. A network that asks for nothing has
  // no such field, and the message goes with the form.
  if (field === "identifier" && hasField) return { atField: true, message };
  switch (status) {
    case 401:
      // The app leaves for the sign-in page once the server has said so.
      void checkSession();
      return { atField: false, message: "You are signed out. Sign in again." };
    case 502:
      // The trouble of a server, which can be over a moment later.
      return { atField: false, message: `${message} Try again in a moment.` };
    case 503:
      return {
        atField: false,
        message: `${message} Whoever runs it has to give it the key that it keeps the access to accounts safe with: until then, no account can be connected.`,
      };
    default:
      return { atField: false, message };
  }
}

function ConnectForm({
  network,
  again,
  workspace,
  offline,
  attempt,
  onBack,
  onCancel,
}: {
  network: Network;
  again: Channel | undefined;
  workspace: Workspace;
  offline: boolean;
  /**
   * Where the form puts its request to begin a connection while it is on
   * its way, for the dialog to call it off.
   */
  attempt: RefObject<AbortController | null>;
  /** Back to the choice of a network. Left out where there is none. */
  onBack: (() => void) | undefined;
  onCancel: () => void;
}) {
  const { label, connect } = networkInfo[network];
  const asked = connect?.identifier;
  // In a sandbox there is nothing to guess: it has one simulated server.
  const simulated =
    workspace.environment === "sandbox" ? sandboxServers[network] : undefined;
  const [identifier, setIdentifier] = useState(
    again && asked ? asked.of(again) : (simulated ?? ""),
  );
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  // From the click until the browser has left for the network.
  const [busy, setBusy] = useState(false);
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  // The keyboard goes where the person has something to say, so that
  // Enter goes on: also when the form takes the place of the choice of a
  // network, whose button had the focus.
  useEffect(() => field.current?.focus(), []);
  // A form that goes takes its request with it: another form has taken
  // its place, the dialog is done closing, or the screen is gone.
  useEffect(() => () => attempt.current?.abort(), [attempt]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const typed = identifier.trim();
    if (asked && typed === "") {
      setRefusal({
        atField: true,
        message: `Enter the ${asked.label.toLowerCase()} of the account.`,
      });
      field.current?.focus();
      return;
    }
    setBusy(true);
    setRefusal(null);
    const controller = new AbortController();
    attempt.current = controller;
    const { signal } = controller;
    try {
      const url = await beginConnect(
        workspace.id,
        { network, ...(asked && { identifier: typed }) },
        signal,
      );
      // Called off while the answer was on its way, which came anyway.
      if (signal.aborted) return;
      // In place of this page, so that the way back from the network does
      // not lead into a form that has been sent.
      location.replace(url);
      // While this window holds changes that it could not save, the
      // browser asks first, and the person may stay: the form is theirs
      // again then.
      if (unsavedInTab() > 0) setBusy(false);
    } catch (failure) {
      // Called off: there is nobody to tell that the request has ended.
      if (signal.aborted) return;
      setBusy(false);
      const next = refusalOf(failure, asked !== undefined);
      setRefusal(next);
      if (next.atField) field.current?.focus();
    } finally {
      // A form that was called off waits for nothing, should the dialog
      // show it again before it has gone.
      if (signal.aborted) setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="grid gap-4">
      <DialogHeader>
        <DialogTitle>
          {again ? `Reconnect ${again.handle}` : `Connect a ${label} account`}
        </DialogTitle>
        <DialogDescription>
          {workspace.environment === "sandbox"
            ? `This is the sandbox: its ${label} is simulated and its accounts are made up. Nothing reaches a real server.`
            : `You sign in at ${label} and allow pigy to post for the account. pigy never sees your password.`}
        </DialogDescription>
      </DialogHeader>

      {asked && (
        <div className="grid gap-1.5">
          <label htmlFor={`${id}-field`} className="font-medium">
            {asked.label}
          </label>
          <Input
            ref={field}
            id={`${id}-field`}
            // An address, not a word: no correction, no capital letter.
            inputMode="url"
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            placeholder={asked.placeholder}
            maxLength={maxConnectIdentifierLength}
            value={identifier}
            aria-invalid={refusal?.atField || undefined}
            aria-describedby={`${id}-hint${refusal?.atField ? ` ${id}-error` : ""}`}
            onChange={(event) => setIdentifier(event.target.value)}
          />
          {refusal?.atField && (
            <p id={`${id}-error`} role="alert" className="text-destructive">
              {refusal.message}
            </p>
          )}
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {simulated
              ? `${simulated} is the simulated server of the sandbox, and the only one it has.`
              : asked.hint}
          </p>
        </div>
      )}
      {refusal && !refusal.atField && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive"
        >
          {refusal.message}
        </p>
      )}
      {offline && (
        <p role="status" className="text-muted-foreground">
          {offlineNote}
        </p>
      )}

      <DialogFooter className="sm:justify-between">
        {onBack ? (
          <Button type="button" variant="ghost" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            Networks
          </Button>
        ) : (
          <span />
        )}
        <div className="flex flex-col-reverse gap-2 sm:flex-row">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={busy || offline}>
            {busy ? "Connecting…" : `Continue to ${label}`}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

/**
 * How a disconnect went: whether the network took the access back, with
 * `revoked` undefined for a channel that turned out to be gone, or what to
 * say of a failure.
 */
type Disconnected = { revoked: boolean | undefined } | { failed: string };

/**
 * Says how the disconnect of `channel` went to somebody who has left the
 * screen while it was on its way: in a notice, which every screen shows.
 * Above all when the network did not take the access back: the person has
 * to remove pigy there, and nothing else would tell them.
 *
 * The notice is for the person, not about the workspace on screen, so it
 * does not leave with a workspace: somebody who goes on to the other one
 * before they have read it still has to hear it. It can therefore be on
 * screen under the name of either workspace, and says what it is about
 * wherever it appears: it names the account, and `workspace`, the one
 * that the account was connected in.
 */
function tellElsewhere(
  channel: Channel,
  workspace: Workspace,
  outcome: Disconnected,
): void {
  const where = `In the ${environmentLabels[workspace.environment].toLowerCase()} workspace.`;
  if ("failed" in outcome) {
    keepOverSwitch(
      toast.error(`${channel.handle} was not disconnected`, {
        description: `${where} ${outcome.failed}`,
      }),
    );
  } else if (outcome.revoked !== undefined) {
    const { tone, text } = disconnectNotice(channel, outcome.revoked);
    keepOverSwitch(
      tone === "bad"
        ? // To be read and acted on: it stays until it is closed.
          toast.error(text, {
            description: where,
            duration: Number.POSITIVE_INFINITY,
            closeButton: true,
          })
        : toast.success(text, { description: where }),
    );
  }
}

/**
 * Asks before a channel is disconnected, says what that means, and does
 * it. `revoked` is undefined for a channel that turned out to be gone.
 */
function DisconnectDialog({
  channel,
  workspace,
  offline,
  focusAfter,
  onClose,
  onDisconnected,
}: {
  channel: Channel | null;
  workspace: Workspace;
  offline: boolean;
  /** Where the keyboard goes when the channel has been disconnected. */
  focusAfter: RefObject<HTMLElement | null>;
  onClose: () => void;
  onDisconnected: (channel: Channel, revoked: boolean | undefined) => void;
}) {
  // The channel that the question is about stays in it while it closes.
  const [asked, setAsked] = useState(channel);
  if (channel && channel !== asked) setAsked(channel);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Whether the screen is still there when the server has answered. The
  // request is not one to call off: the server goes through with it
  // whatever becomes of the page. The dialog does not close while it
  // waits, and the person can still leave the screen, with the Back of
  // the browser.
  const here = useRef(true);
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
    };
  }, []);
  // The ID of the channel that this has just disconnected, until the
  // dialog has closed over it.
  const disconnected = useRef<string>(null);

  const disconnect = async (target: Channel) => {
    setBusy(true);
    setError(null);
    let outcome: Disconnected;
    try {
      const { revoked } = await disconnectChannel(workspace.id, target.id);
      outcome = { revoked };
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        // Disconnected already, in another tab or on another device,
        // which the copy has not heard of yet.
        outcome = { revoked: undefined };
      } else if (failure instanceof ApiError) {
        if (failure.status === 401) void checkSession();
        outcome = { failed: failure.message };
      } else {
        outcome = {
          failed: "pigy did not answer. Check your connection and try again.",
        };
      }
    }
    if (!here.current) {
      tellElsewhere(target, workspace, outcome);
      return;
    }
    setBusy(false);
    if ("failed" in outcome) {
      setError(outcome.failed);
    } else {
      disconnected.current = target.id;
      onDisconnected(target, outcome.revoked);
    }
  };

  return (
    <AlertDialog
      open={channel !== null}
      onOpenChange={(isOpen) => {
        // Not while the request is on its way: its answer is said here.
        if (isOpen || busy) return;
        setError(null);
        onClose();
      }}
    >
      <AlertDialogContent
        // A dialog that closes gives the keyboard back to the button that
        // opened it. After a disconnect that button is gone, with the row
        // of the channel, and the keyboard would be on nothing: it goes to
        // the button that connects an account.
        finalFocus={() => {
          const gone = disconnected.current === asked?.id;
          disconnected.current = null;
          return gone ? focusAfter.current : true;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Disconnect {asked?.handle}?</AlertDialogTitle>
          <AlertDialogDescription>
            pigy stops posting to this account, and gives the access that it has
            back to {asked && networkInfo[asked.network].label}. What is
            published there stays. You can connect the account again at any
            time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {offline && (
          <p role="status" className="text-muted-foreground">
            {offlineNote}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy || offline}
            onClick={() => {
              if (channel) void disconnect(channel);
            }}
          >
            {busy ? "Disconnecting…" : "Disconnect"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
