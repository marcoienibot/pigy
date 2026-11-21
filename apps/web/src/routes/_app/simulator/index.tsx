import { type Network, networkSchema, type SandboxPost } from "@pigy/core";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { Avatar } from "@/components/avatar";
import { EmptyState } from "@/components/page";
import { RefreshFailure } from "@/components/refresh-failure";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { fetchSandboxFeed } from "@/lib/api";
import { selectChannels } from "@/lib/channels";
import { failureMessage, useFetched } from "@/lib/fetched";
import { useShortcuts } from "@/lib/keyboard";
import { listedNetworks, networkInfo } from "@/lib/networks";
import { useWorldChanges } from "@/lib/sandbox-world";
import { chainOf, type FeedChain } from "@/lib/simulator";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useSynced } from "@/sync/react";

type FeedsSearch = {
  /** The handle of an account to bring into view. */
  account?: string;
  /** The ID of a post to bring into view: the remote ID of a result. */
  post?: string;
  /** The network of the account, where the handle could be another's. */
  network?: Network;
};

export const Route = createFileRoute("/_app/simulator/")({
  validateSearch: (search): FeedsSearch => {
    const network = networkSchema.safeParse(search.network);
    return {
      ...(typeof search.account === "string" && { account: search.account }),
      ...(typeof search.post === "string" && { post: search.post }),
      ...(network.success && { network: network.data }),
    };
  },
  component: Feeds,
});

/**
 * What the simulated networks of the sandbox have published, by account:
 * every account of the world, each with its posts, a thread as a chain of
 * replies. It is asked for anew whenever a delivery of the workspace moves
 * on, every few seconds while one is under way, and when the person asks,
 * with Refresh.
 */
function Feeds() {
  const {
    account: wantedAccount,
    post: wantedPost,
    network,
  } = Route.useSearch();
  const channels = useSynced(selectChannels);
  // One clock for every time that the feeds show.
  const now = useNow();
  const {
    data: feed,
    failure,
    loading,
    refresh,
  } = useFetched(fetchSandboxFeed);

  // A delivery that moves on has done something in the world, and so may
  // one that is under way, and what was missed while the connection or
  // the person was away.
  useWorldChanges(refresh, loading);

  useShortcuts((event) => {
    if (event.key.toLowerCase() !== "r") return;
    event.preventDefault();
    refresh();
  });

  // What the address names is brought into view once, when it is there.
  const page = useRef<HTMLDivElement>(null);
  const shown = useRef<string>(undefined);
  const wanted = wantedPost ?? wantedAccount;
  useEffect(() => {
    if (!feed || !wanted || shown.current === wanted) return;
    const target = page.current?.querySelector<HTMLElement>(
      "[aria-current='true']",
    );
    if (!target) return;
    shown.current = wanted;
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }, [feed, wanted]);

  // What the sandbox has of each account: a channel, and whether the
  // network still takes its access.
  const connected = new Map(
    channels.map((channel) => [
      `${channel.network} ${channel.handle}`,
      channel.status,
    ]),
  );

  if (!feed) {
    return failure ? (
      <EmptyState
        title="The simulated feeds could not be loaded"
        description={failureMessage(failure)}
      >
        <Button variant="outline" onClick={refresh} disabled={loading}>
          Try again
        </Button>
      </EmptyState>
    ) : (
      <p role="status" className="py-16 text-center text-muted-foreground">
        Loading the simulated feeds…
      </p>
    );
  }

  const networks = listedNetworks.filter((candidate) =>
    feed.accounts.some((account) => account.network === candidate),
  );

  return (
    <div ref={page} className="flex flex-col gap-4">
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-muted-foreground">
          What the simulated networks of your sandbox have published, by
          account. None of it is on the internet.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw
            aria-hidden="true"
            className={cn(loading && "animate-spin")}
          />
          Refresh
          <Kbd className="hidden md:inline-flex">R</Kbd>
        </Button>
      </div>
      {failure !== null && (
        <RefreshFailure
          what="The feeds"
          failure={failure}
          loading={loading}
          onRetry={refresh}
        />
      )}
      {networks.map((name) => (
        <section key={name} aria-label={networkInfo[name].label}>
          <h2 className="mb-2 font-medium">{networkInfo[name].label}</h2>
          <ul className="flex flex-col gap-3">
            {feed.accounts
              .filter((account) => account.network === name)
              .map((account) => {
                const isWanted =
                  wantedPost === undefined &&
                  account.handle === wantedAccount &&
                  (network === undefined || network === name);
                return (
                  <li key={account.id}>
                    <section
                      aria-label={`${account.name} ${account.handle}`}
                      aria-current={isWanted || undefined}
                      tabIndex={-1}
                      className={cn(
                        "rounded-lg border outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        isWanted && "border-primary/50 ring-2 ring-primary/30",
                      )}
                    >
                      <header className="flex items-center gap-2 border-b px-3 py-2">
                        <Avatar name={account.name} className="size-7" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">
                            {account.name}
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {account.handle}
                          </div>
                        </div>
                        {connected.has(`${name} ${account.handle}`) && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {connected.get(`${name} ${account.handle}`) ===
                            "needs_reconnect"
                              ? "Needs reconnecting"
                              : "Connected"}
                          </span>
                        )}
                      </header>
                      {account.posts.length === 0 ? (
                        <p className="px-3 py-2 text-muted-foreground">
                          Nothing posted yet.
                        </p>
                      ) : (
                        <ol aria-label="Posts" className="divide-y">
                          {account.posts.map((post) => (
                            <li key={post.id} className="px-3 py-2">
                              <Chain
                                chain={chainOf(post)}
                                now={now}
                                wanted={
                                  account.handle === wantedAccount ||
                                  wantedAccount === undefined
                                    ? wantedPost
                                    : undefined
                                }
                              />
                            </li>
                          ))}
                        </ol>
                      )}
                    </section>
                  </li>
                );
              })}
          </ul>
        </section>
      ))}
    </div>
  );
}

/**
 * A post and the replies that follow it: one after the other, joined by a
 * line, the way a thread is read. Where a post has several replies, each
 * goes on under it, indented.
 */
function Chain({
  chain,
  wanted,
  now,
}: {
  chain: FeedChain;
  /** The ID of the post to bring into view, if it is in this feed. */
  wanted: string | undefined;
  now: number;
}) {
  const thread = chain.posts.length > 1;
  return (
    <>
      <ol
        aria-label={thread ? "Thread" : undefined}
        className="flex flex-col gap-2"
      >
        {chain.posts.map((post, index) => (
          <li
            key={post.id}
            className={cn(
              thread && "relative pl-4",
              // The line that joins a reply to the post before it.
              thread &&
                "before:absolute before:top-1.5 before:left-0.5 before:size-1.5 before:rounded-full before:bg-muted-foreground/60",
              thread &&
                index < chain.posts.length - 1 &&
                "after:absolute after:top-3.5 after:-bottom-2 after:left-[0.4rem] after:w-px after:bg-border",
            )}
          >
            <FeedPost post={post} wanted={post.id === wanted} now={now} />
          </li>
        ))}
      </ol>
      {chain.branches.length > 0 && (
        <ol
          aria-label="Replies"
          className="mt-2 ml-4 flex flex-col gap-2 border-l pl-3"
        >
          {chain.branches.map((branch) => (
            <li key={branch.posts[0]?.id}>
              <Chain chain={branch} wanted={wanted} now={now} />
            </li>
          ))}
        </ol>
      )}
    </>
  );
}

function FeedPost({
  post,
  wanted,
  now,
}: {
  post: SandboxPost;
  wanted: boolean;
  now: number;
}) {
  return (
    <article
      aria-current={wanted || undefined}
      tabIndex={wanted ? -1 : undefined}
      className={cn(
        "-mx-1.5 rounded-md px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
        wanted && "bg-accent",
      )}
    >
      <p className="break-words whitespace-pre-wrap">{post.text}</p>
      <p className="text-xs text-muted-foreground">
        <time dateTime={new Date(post.createdAt).toISOString()}>
          {timeAgo(post.createdAt, now)}
        </time>
      </p>
    </article>
  );
}
