import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink, LoaderCircle, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/avatar";
import { PostImages } from "@/components/image-strip";
import { MarkedText } from "@/components/marked-text";
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
import { Kbd } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Channel } from "@/lib/channels";
import { useShortcuts } from "@/lib/keyboard";
import { marksOf } from "@/lib/markup";
import { networkInfo } from "@/lib/networks";
import {
  canDelete,
  ownTextHeading,
  postStatusWords,
  postTimeWord,
  publishedPosts,
  type SentPost,
  type SentTarget,
  type StatusWords,
  selectSent,
  targetExplanation,
  targetStatusWords,
} from "@/lib/sent";
import { timeAgo, useNow, whenAgo } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useMutate, useSynced, useSyncState } from "@/sync/react";

type SentSearch = {
  /** The ID of a post to bring into view, such as one just published. */
  post?: string;
};

export const Route = createFileRoute("/_app/sent")({
  validateSearch: (search): SentSearch =>
    typeof search.post === "string" ? { post: search.post } : {},
  component: Sent,
});

/**
 * The posts that were published, newest first, each with where it went and
 * how that went: in words, with links to what was published, and "Retry"
 * where a delivery failed. Read from the local copy, where the server
 * reports each delivery as it goes on, so the progress shows as it happens.
 */
function Sent() {
  const { workspace } = Route.useRouteContext();
  const { post: wanted } = Route.useSearch();
  const sandbox = workspace.environment === "sandbox";
  const posts = useSynced(selectSent);
  const offline = useSyncState().connection === "offline";
  // The post that the person is asked about before it is deleted, and the
  // one next to it, where the keyboard goes when it is gone.
  const [deleting, setDeleting] = useState<SentPost | null>(null);
  const next = useRef<string>(undefined);
  const askToDelete = (post: SentPost) => {
    const index = posts.indexOf(post);
    next.current = (posts[index + 1] ?? posts[index - 1])?.id;
    setDeleting(post);
  };
  const list = useRef<HTMLOListElement>(null);
  // One clock for every time that the list shows.
  const now = useNow();

  const itemOf = (id: string) =>
    list.current?.querySelector<HTMLElement>(`[data-post="${id}"]`);

  // The post that the address names is brought into view and given the
  // focus, once: the person came here for it.
  const found = posts.some(({ id }) => id === wanted);
  const shown = useRef<string>(undefined);
  useEffect(() => {
    if (!wanted || !found || shown.current === wanted) return;
    shown.current = wanted;
    const item = list.current?.querySelector<HTMLElement>(
      `[data-post="${wanted}"]`,
    );
    item?.scrollIntoView({ block: "nearest" });
    item?.focus({ preventScroll: true });
  }, [wanted, found]);

  /** The post whose item has the focus, or holds it. */
  const focused = (event: KeyboardEvent) => {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-post]",
    );
    return posts.find((post) => post.id === item?.dataset.post);
  };

  useShortcuts((event) => {
    const current = focused(event);
    const index = current ? posts.indexOf(current) : -1;
    switch (event.key.toLowerCase()) {
      case "j":
      case "arrowdown": {
        const next = posts[Math.min(posts.length - 1, index + 1)];
        if (next) itemOf(next.id)?.focus();
        break;
      }
      case "k":
      case "arrowup": {
        const next = posts[Math.max(0, index - 1)];
        if (next) itemOf(next.id)?.focus();
        break;
      }
      case "backspace":
      case "delete":
        if (!current || !canDelete(current)) return;
        askToDelete(current);
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  return (
    <Page title="Sent">
      <div className="mx-auto flex max-w-2xl flex-col gap-3">
        {offline && (
          <p
            role="status"
            className="rounded-lg border px-3 py-2 text-muted-foreground"
          >
            You are offline. What is shown is what this device knows: what you
            published on it goes out, and the progress of every post shows here,
            when it is back online.
          </p>
        )}
        {posts.length === 0 ? (
          <EmptyState
            title="Nothing sent yet"
            description={
              sandbox
                ? "Posts that you publish appear here, with where each one went. In the sandbox they go to simulated accounts, whose feeds the simulator shows."
                : "Posts that you publish appear here, with where each one went."
            }
          >
            {sandbox && (
              <Link to="/simulator" className="underline underline-offset-4">
                Open the simulator
              </Link>
            )}
          </EmptyState>
        ) : (
          <>
            <ol
              ref={list}
              aria-label="Sent posts"
              className="flex flex-col gap-3"
            >
              {posts.map((post) => (
                <SentItem
                  key={post.id}
                  post={post}
                  sandbox={sandbox}
                  now={now}
                  wanted={post.id === wanted}
                  onDelete={() => askToDelete(post)}
                />
              ))}
            </ol>
            {/* Where the keys are said: a phone has none. */}
            <p className="hidden items-center justify-center gap-1.5 text-xs text-muted-foreground md:flex">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move through the posts ·<Kbd>⌫</Kbd> deletes one
            </p>
          </>
        )}
      </div>
      <DeleteDialog
        post={deleting}
        onClose={() => setDeleting(null)}
        focusAfter={() => (next.current && itemOf(next.current)) || true}
      />
    </Page>
  );
}

const tones: Record<StatusWords["tone"], string> = {
  busy: "text-muted-foreground",
  good: "text-emerald-700 dark:text-emerald-400",
  bad: "text-destructive",
  unsure: "text-amber-700 dark:text-amber-400",
};

/** A status in words, in its colour. */
function Status({ words }: { words: StatusWords }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
        tones[words.tone],
      )}
    >
      {words.tone === "busy" && (
        <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
      )}
      {words.label}
    </span>
  );
}

function SentItem({
  post,
  sandbox,
  now,
  wanted,
  onDelete,
}: {
  post: SentPost;
  sandbox: boolean;
  now: number;
  /** The address names this post. */
  wanted: boolean;
  onDelete: () => void;
}) {
  const textId = `${post.id}-text`;
  const words = postStatusWords(post);

  return (
    <li>
      <article
        data-post={post.id}
        aria-labelledby={textId}
        // Reached with ↑ and ↓, and from a link that names it.
        tabIndex={-1}
        className={cn(
          "rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring",
          wanted && "border-primary/50",
        )}
      >
        <header className="flex items-start gap-2 px-3 pt-2.5">
          <p
            id={textId}
            className="line-clamp-6 min-w-0 flex-1 break-words whitespace-pre-wrap"
          >
            {post.title ? (
              // Its links, mentions and hashtags, as the networks that
              // got this text take them.
              <MarkedText
                text={post.title}
                marks={marksOf(
                  post.title,
                  post.targets.flatMap(({ channel, ownText }) =>
                    channel && !ownText ? [channel.network] : [],
                  ),
                )}
              />
            ) : (
              <span className="text-muted-foreground">Empty post</span>
            )}
          </p>
          {canDelete(post) && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete post"
                    className="-mt-1 -mr-1.5"
                    onClick={onDelete}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                }
              />
              <TooltipContent>
                Delete from pigy
                <Kbd>⌫</Kbd>
              </TooltipContent>
            </Tooltip>
          )}
        </header>
        <div className="px-3">
          <PostImages partIds={post.parts.map(({ id }) => id)} />
        </div>
        <p className="flex flex-wrap items-center gap-x-2 px-3 pt-1 pb-2 text-xs text-muted-foreground">
          <Status words={words} />
          <span aria-hidden="true">·</span>
          <span>
            {postTimeWord(post)} {whenAgo(post.publishedAt, now)}
          </span>
          {post.parts.length > 1 && (
            <>
              <span aria-hidden="true">·</span>
              <span>Thread of {post.parts.length} parts</span>
            </>
          )}
        </p>
        <ul aria-label="Where it went" className="divide-y border-t">
          {post.targets.map((target) => (
            <TargetRow
              key={target.id}
              target={target}
              sandbox={sandbox}
              now={now}
            />
          ))}
        </ul>
      </article>
    </li>
  );
}

/** Text that goes with a link, in the style of the links of this screen. */
const linkStyle =
  "inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline";

function TargetRow({
  target,
  sandbox,
  now,
}: {
  target: SentTarget;
  sandbox: boolean;
  now: number;
}) {
  const mutate = useMutate();
  const { channel, status, error, published, reconnect } = target;
  const handle = channel?.handle ?? "A disconnected account";
  const network = channel && networkInfo[channel.network].label;
  const explanation = targetExplanation(target);

  return (
    <li
      // Named by its account, for whoever looks for one target of a post.
      aria-label={handle}
      className="flex items-start gap-3 px-3 py-2"
    >
      <Avatar
        name={channel?.name ?? "?"}
        src={channel?.avatarUrl ?? null}
        className="mt-0.5 size-7 text-[0.625rem]"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              "min-w-0 truncate font-medium",
              !channel && "text-muted-foreground",
            )}
          >
            {handle}
          </span>
          <Status words={targetStatusWords[status]} />
          {network && (
            <span className="text-xs text-muted-foreground">
              {network}
              {target.sentAt !== null && ` · ${timeAgo(target.sentAt, now)}`}
            </span>
          )}
        </div>
        {error && (
          <p
            className={
              status === "uncertain"
                ? "text-amber-700 dark:text-amber-400"
                : "text-destructive"
            }
          >
            {error}
          </p>
        )}
        {explanation && (
          <p className="text-xs text-muted-foreground">{explanation}</p>
        )}
        {status === "uncertain" && channel && (
          <p className="text-xs">
            <AccountLink channel={channel} sandbox={sandbox} />
          </p>
        )}
        {reconnect && channel && (
          <p className="text-xs text-muted-foreground">
            The account has to be connected again before this can be tried
            again.{" "}
            <Link
              to="/channels"
              search={{ reconnect: channel.id }}
              className={linkStyle}
            >
              Reconnect {channel.handle}
            </Link>
          </p>
        )}
        {target.ownText && (
          <div className="text-xs">
            <p className="text-muted-foreground">{ownTextHeading(target)}</p>
            <ol
              aria-label={`Text for ${handle}`}
              className="mt-0.5 flex flex-col gap-1 border-l-2 pl-2"
            >
              {target.ownText.map(({ id, text }) => (
                <li
                  key={id}
                  className="line-clamp-4 break-words whitespace-pre-wrap"
                >
                  <MarkedText
                    text={text}
                    marks={marksOf(text, channel ? [channel.network] : [])}
                  />
                </li>
              ))}
            </ol>
          </div>
        )}
        {published.length > 0 && (
          <PartLinks
            target={target}
            sandbox={sandbox}
            networkLabel={network ?? "the network"}
          />
        )}
      </div>
      {target.canRetry && (
        <Button
          variant="outline"
          size="sm"
          aria-label={`Retry ${handle}`}
          onClick={() => mutate("target.retry", { id: target.id })}
        >
          Retry
        </Button>
      )}
    </li>
  );
}

/**
 * Where a person looks for a post whose delivery nobody knows the end of:
 * the account at its network, or in the sandbox its simulated feed.
 */
function AccountLink({
  channel: { handle, network, profileUrl },
  sandbox,
}: {
  channel: Channel;
  sandbox: boolean;
}) {
  if (sandbox) {
    return (
      <Link
        to="/simulator"
        search={{ account: handle, network }}
        className={linkStyle}
      >
        Look at {handle} in the simulated feed
      </Link>
    );
  }
  // A network that gives pigy no address of the account has one where
  // everybody finds their own posts.
  const { label, ownPosts } = networkInfo[network];
  if (!profileUrl && ownPosts) {
    return (
      <a href={ownPosts} target="_blank" rel="noreferrer" className={linkStyle}>
        Look at your posts on {label}
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
    );
  }
  if (!profileUrl) return null;
  return (
    <a href={profileUrl} target="_blank" rel="noreferrer" className={linkStyle}>
      Look at {handle}
      <ExternalLink aria-hidden="true" className="size-3" />
    </a>
  );
}

/**
 * The links to what a delivery has published: one per part, which is one
 * for an ordinary post. In the sandbox a post has no address that a
 * browser can open: the links lead to it in the simulated feed.
 */
function PartLinks({
  target,
  sandbox,
  networkLabel,
}: {
  target: SentTarget;
  sandbox: boolean;
  networkLabel: string;
}) {
  const { channel } = target;
  // A post of the network is one link, however many parts are in it.
  const posts = publishedPosts(target.published);
  const one = posts.length === 1;
  const links: ReactNode[] = posts.map(({ remoteId, url, first, last }) => {
    const label = one
      ? null
      : first === last
        ? `Part ${first}`
        : `Parts ${first}–${last}`;
    if (sandbox) {
      return (
        <Link
          key={remoteId}
          to="/simulator"
          search={{
            ...(channel && {
              account: channel.handle,
              network: channel.network,
            }),
            post: remoteId,
          }}
          className={linkStyle}
        >
          {label ?? "See it in the simulated feed"}
        </Link>
      );
    }
    if (!url) {
      return label ? (
        <span key={remoteId} className="text-muted-foreground">
          {label}
        </span>
      ) : null;
    }
    return (
      <a
        key={remoteId}
        href={url}
        target="_blank"
        rel="noreferrer"
        className={linkStyle}
      >
        {label ?? `View on ${networkLabel}`}
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
    );
  });
  // A network that gives no link, for a post of one part.
  if (links.every((link) => link === null)) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {!one && (
        <span className="text-muted-foreground">
          {sandbox ? "In the simulated feed:" : "Published:"}
        </span>
      )}
      {links}
    </p>
  );
}

/**
 * Asks before a post is deleted, and says what that means: pigy forgets
 * it, and the networks keep it. There is no undo: a post that is not a
 * draft cannot be made again.
 */
function DeleteDialog({
  post,
  onClose,
  focusAfter,
}: {
  post: SentPost | null;
  onClose: () => void;
  /** Where the keyboard goes once the post is gone. */
  focusAfter: () => HTMLElement | true;
}) {
  const mutate = useMutate();
  // The post that the question is about stays in it while it closes.
  const [asked, setAsked] = useState(post);
  if (post && post !== asked) setAsked(post);
  const deleted = useRef(false);

  return (
    <AlertDialog
      open={post !== null}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
    >
      <AlertDialogContent
        // The item of the post is gone, and so is the button that opened
        // the question: the keyboard goes to the post next to it.
        finalFocus={() => {
          const gone = deleted.current;
          deleted.current = false;
          return gone ? focusAfter() : true;
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>Delete this post from pigy?</AlertDialogTitle>
          <AlertDialogDescription>
            pigy forgets the post and where it went. What it published stays on
            the networks: delete it there to take it down.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={() => {
              if (asked) {
                deleted.current = true;
                mutate("post.delete", { id: asked.id });
              }
              onClose();
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
