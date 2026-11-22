import { uuidv7 } from "@pigy/core";
import { Link, useNavigate, useRouteContext } from "@tanstack/react-router";
import { Check, Info, PenLine, Send, TriangleAlert } from "lucide-react";
import { useId, useRef } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { type Draft, restoreOwnText } from "@/lib/drafts";
import { installOfferOnce } from "@/lib/install";
import {
  dialogIsOpen,
  isBusy,
  modKey,
  takeFocus,
  useKeyDown,
  withMod,
} from "@/lib/keyboard";
import { connectableNetworks, networkInfo } from "@/lib/networks";
import { undoMs } from "@/lib/notices";
import {
  audienceOf,
  blockedReason,
  type Choice,
  type Composer,
  ownTextsOf,
  selectOwnTexts,
} from "@/lib/publish";
import { cn } from "@/lib/utils";
import { useMutate, useSyncedNow, useSyncState } from "@/sync/react";

/**
 * Where a draft goes, and "Publish now": under the text of the editor.
 *
 * The channels are chosen with mutators, like every change of a draft, so
 * the choice is saved at once and syncs. What a chosen account would
 * refuse in the text that it gets, the post's or its own, is said next to
 * the choice, part by part, and the post cannot be published while there
 * is any: `validateContent`, which the server checks with too. `composer`
 * has it, from the editor, which counts by the same.
 *
 * Publishing is a mutation like the others: it is made on this device at
 * once, and reaches the server when the device does. Offline, the panel
 * says so, and so does the notice after it.
 */
export function PublishPanel({
  draft,
  composer,
  onPublished,
}: {
  draft: Draft;
  /** What `compose` makes of the draft and the channels of the workspace. */
  composer: Composer;
  /** The draft has been published, and is a draft no more. */
  onPublished: () => void;
}) {
  const { workspace } = useRouteContext({ from: "/_app" });
  const sandbox = workspace.environment === "sandbox";
  const mutate = useMutate();
  const tablesNow = useSyncedNow();
  const navigate = useNavigate();
  const offline = useSyncState().connection === "offline";
  const { choices, blocked } = composer;
  const reason = blockedReason(composer, draft.parts.length);
  const id = useId();
  const noteId = (channelId: string) => `${id}-${channelId}`;
  const [network] = connectableNetworks;
  /** The choices of this draft, to find the button of one of them in. */
  const chips = useRef<HTMLDivElement>(null);

  const toggle = ({ channel, chosen }: Choice) => {
    if (!chosen) {
      mutate("target.add", {
        id: uuidv7(new Date()),
        postId: draft.id,
        channelId: channel.id,
      });
      return;
    }
    // The text that was written for the account goes with the choice:
    // read before it does.
    const own = ownTextsOf(selectOwnTexts(tablesNow()), draft.id).get(
      channel.id,
    );
    mutate("target.remove", { postId: draft.id, channelId: channel.id });
    if (!own) return;
    // One press must not cost a text that somebody wrote. The notice is
    // of this workspace, and leaves with it.
    toast(`${channel.handle} left out, and its own text with it`, {
      duration: undoMs,
      action: {
        label: "Undo",
        onClick: () => {
          const tables = tablesNow();
          // Only into the draft, if it still is one, and for an account
          // that is still connected: the server would refuse the rest.
          if (
            tables.post.get(draft.id)?.status !== "draft" ||
            !tables.channel.has(channel.id)
          ) {
            return;
          }
          const chip = chips.current?.querySelector<HTMLElement>(
            `[data-channel="${channel.id}"]`,
          );
          // The account was chosen again since, and given a text anew:
          // that text stays, and nothing of the earlier one is put into
          // it. The server would do the same, and tell nobody.
          if (ownTextsOf(selectOwnTexts(tables), draft.id).has(channel.id)) {
            toast(`${channel.handle} has a text of its own again`, {
              description: "The text that it had before was not brought back.",
            });
            takeFocus(chip);
            return;
          }
          mutate("target.add", {
            id: uuidv7(new Date()),
            postId: draft.id,
            channelId: channel.id,
          });
          // All of the text, also where it has grown longer than one
          // step carries.
          restoreOwnText(mutate, draft.id, channel.id, own);
          // The notice leaves the page with the press, and the keyboard
          // would be left on the page, where its keys are shortcuts: it
          // goes back to the choice that was taken back, if the draft is
          // still the one that is open.
          takeFocus(chip);
        },
      },
    });
  };

  const publish = () => {
    if (blocked) return;
    mutate("post.publish", { id: draft.id });
    const audience = audienceOf(choices);
    // A notice of this workspace: it leaves with it, and so does what it
    // offers, which leads to the post in this workspace.
    toast(
      offline
        ? `Publishing to ${audience} when this device is back online`
        : `Publishing to ${audience}`,
      {
        ...(offline && {
          description:
            "The post waits on this device, and goes out once pigy can reach its server.",
        }),
        action: {
          label: "View",
          onClick: () =>
            void navigate({ to: "/sent", search: { post: draft.id } }),
        },
      },
    );
    // On a phone, in a browser, the one time that pigy brings installing
    // up by itself: PLAN.md section 13.
    const offered = installOfferOnce();
    if (offered) {
      toast("Install pigy on this phone", {
        description:
          "It opens like an app, also without a connection, and can tell you when a post could not be sent.",
        // Longer than a notice that only says something: it is read,
        // weighed and reached.
        duration: 20_000,
        action: offered.install
          ? { label: "Install", onClick: offered.install }
          : {
              label: "How",
              onClick: () => void navigate({ to: "/settings" }),
            },
      });
    }
    onPublished();
  };

  useKeyDown((event) => {
    if (!withMod(event) || event.key !== "Enter") return;
    // Not a key that somebody else has taken, one that is held down, or
    // one that ends the composition of a character.
    if (event.defaultPrevented || event.repeat || event.isComposing) return;
    // With Shift it adds a part to the text.
    if (event.shiftKey) return;
    // From the text of the draft, where the person is when they are done
    // with it, and from the page. Not from what a key press is meant for
    // otherwise: a menu, which Enter chooses in, a dialog, another field.
    const fromText =
      event.target instanceof HTMLTextAreaElement &&
      event.target.dataset.part !== undefined &&
      !dialogIsOpen();
    if (!fromText && isBusy(event)) return;
    event.preventDefault();
    publish();
  });

  // The notes that go with the choice: what keeps an account from taking
  // the post.
  const notes = choices.filter((choice) => choice.troubled);
  // What a network without threads makes of one, said in advance.
  const joined = choices.filter((choice) => choice.joined);

  return (
    <section
      aria-label="Publish"
      className="flex shrink-0 flex-col gap-2 border-t px-4 py-3 md:px-6"
    >
      {choices.length === 0 ? (
        <p className="text-muted-foreground">
          {sandbox
            ? "Connect a simulated account to publish this draft to."
            : "Connect an account to publish this draft to."}{" "}
          {network && (
            <Link
              to="/channels"
              search={{ add: network }}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Connect {sandbox ? "a simulated" : "an"} account
            </Link>
          )}
        </p>
      ) : (
        <fieldset className="min-w-0">
          <legend className="mb-1.5 text-xs text-muted-foreground">
            Publish to
          </legend>
          <div ref={chips} className="flex flex-wrap items-center gap-1.5">
            {choices.map((choice) => (
              <ChannelChip
                key={choice.channel.id}
                choice={choice}
                describedBy={
                  choice.troubled ? noteId(choice.channel.id) : undefined
                }
                onToggle={() => toggle(choice)}
              />
            ))}
          </div>
        </fieldset>
      )}

      {notes.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs">
          {notes.map(({ channel, needsReconnect, refuses }) => (
            <li
              key={channel.id}
              id={noteId(channel.id)}
              className="flex items-start gap-1.5 text-amber-700 dark:text-amber-400"
            >
              <TriangleAlert
                aria-hidden="true"
                className="mt-px size-3.5 shrink-0"
              />
              <span className="min-w-0">
                {needsReconnect ? (
                  <>
                    {channel.handle} has to be connected again before pigy can
                    post to it.{" "}
                    <Link
                      to="/channels"
                      search={{ reconnect: channel.id }}
                      className="font-medium underline underline-offset-4"
                    >
                      Reconnect {channel.handle}
                    </Link>
                  </>
                ) : (
                  <>
                    {networkInfo[channel.network].label} would refuse this for{" "}
                    {channel.handle}: {refuses.join(" ")}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {joined.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {joined.map(({ channel }) => (
            <li key={channel.id} className="flex items-start gap-1.5">
              <Info aria-hidden="true" className="mt-px size-3.5 shrink-0" />
              <span className="min-w-0">
                {networkInfo[channel.network].label} has no threads:{" "}
                {channel.handle} gets the parts as one post, with an empty line
                between them.
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2">
        <p
          role="status"
          className="min-w-0 flex-1 basis-48 text-xs text-muted-foreground"
        >
          {blocked && blocked !== "no-channels"
            ? reason
            : offline
              ? "You are offline. What you publish now goes out when this device is back online."
              : null}
        </p>
        <Button disabled={blocked !== null} onClick={publish}>
          <Send aria-hidden="true" />
          Publish now
          <span className="hidden items-center gap-0.5 md:inline-flex">
            <Kbd>{modKey}</Kbd>
            <Kbd>↵</Kbd>
          </span>
        </Button>
      </div>
    </section>
  );
}

/**
 * A channel to choose or leave out: a button that is pressed when the
 * draft goes there. One that needs connecting again cannot be chosen, and
 * one that was chosen before can only be left out.
 */
function ChannelChip({
  choice,
  describedBy,
  onToggle,
}: {
  choice: Choice;
  /** The ID of the note that says what is wrong with the channel. */
  describedBy: string | undefined;
  onToggle: () => void;
}) {
  const { channel, chosen, own, needsReconnect, troubled } = choice;
  return (
    <button
      type="button"
      data-channel={channel.id}
      aria-pressed={chosen}
      aria-describedby={describedBy}
      disabled={needsReconnect && !chosen}
      onClick={onToggle}
      className={cn(
        "inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border py-1 pr-3 pl-1 text-sm outline-none",
        "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
        chosen
          ? "border-primary bg-primary/10 font-medium"
          : "text-muted-foreground",
        troubled && "border-amber-500/70",
      )}
    >
      <Avatar
        name={channel.name}
        src={channel.avatarUrl}
        className="size-6 text-[0.625rem]"
      />
      <span className="truncate">{channel.handle}</span>
      <span className="sr-only"> on {networkInfo[channel.network].label}</span>
      {own && (
        <>
          <PenLine aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="sr-only">, with a text of its own</span>
        </>
      )}
      {troubled ? (
        <TriangleAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 text-amber-700 dark:text-amber-400"
        />
      ) : (
        chosen && <Check aria-hidden="true" className="size-3.5 shrink-0" />
      )}
    </button>
  );
}
