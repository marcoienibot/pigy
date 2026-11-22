import { createFileRoute, Link } from "@tanstack/react-router";
import { CalendarClock, CircleAlert, Clock, Unplug, X } from "lucide-react";
import { useRef } from "react";
import { EmptyState, Page } from "@/components/page";
import { Button } from "@/components/ui/button";
import { type InboxItem, inboxWords, readAll, selectInbox } from "@/lib/inbox";
import { timeAgo, useNow } from "@/lib/time";
import { cn } from "@/lib/utils";
import { useMutate, useSynced } from "@/sync/react";

export const Route = createFileRoute("/_app/inbox")({
  component: Inbox,
});

const icons = {
  post_failed: CircleAlert,
  post_held: CalendarClock,
  channel_needs_reconnect: Unplug,
  channel_expiring: Clock,
} as const;

/**
 * The inbox: what the person has to hear of, the newest first, each
 * leading to where the thing is dealt with. It is where the push messages
 * of a device are read by somebody who has none, or missed one: an iPhone
 * takes push messages only for an app on its Home Screen.
 *
 * Read from the local copy, like every synced screen: it is there at once
 * and without a connection, and reading and dismissing are changes like
 * any other, which wait on the device until it is back online.
 */
function Inbox() {
  const items = useSynced(selectInbox);
  const mutate = useMutate();
  const now = useNow();
  const anyUnread = items.some((item) => item.unread);
  const heading = useRef<HTMLHeadingElement>(null);

  return (
    <Page
      title="Inbox"
      heading={heading}
      actions={
        anyUnread && (
          <Button
            variant="outline"
            size="sm"
            // All of them, in as many mutations as that takes.
            onClick={() => {
              for (const args of readAll(items)) {
                mutate("notification.read", args);
              }
            }}
          >
            Mark all read
          </Button>
        )
      }
    >
      <div className="mx-auto max-w-2xl">
        {items.length === 0 ? (
          <EmptyState
            title="Nothing needs your attention"
            description="pigy tells you here when a post could not be sent, when a scheduled post missed its time, when an account has to be connected again, and a week before the access to an account ends."
          >
            <Link to="/settings" className="underline underline-offset-4">
              Get notifications on this device
            </Link>
          </EmptyState>
        ) : (
          <ol aria-label="Notifications" className="flex flex-col gap-2">
            {items.map((item) => (
              <Item
                key={item.id}
                item={item}
                now={now}
                onRead={() =>
                  item.unread &&
                  mutate("notification.read", {
                    notifications: [{ id: item.id, createdAt: item.createdAt }],
                  })
                }
                onDismiss={() => {
                  // As it is on screen: one that has come in its place
                  // on another device meanwhile stays.
                  mutate("notification.dismiss", {
                    id: item.id,
                    createdAt: item.createdAt,
                  });
                  // The button that had the focus is gone with its item.
                  heading.current?.focus();
                }}
              />
            ))}
          </ol>
        )}
      </div>
    </Page>
  );
}

function Item({
  item,
  now,
  onRead,
  onDismiss,
}: {
  item: InboxItem;
  now: number;
  onRead: () => void;
  onDismiss: () => void;
}) {
  const { title, detail, action } = inboxWords(item, now);
  const Icon = icons[item.kind];
  const titleId = `${item.id}-title`;
  const link = cn(
    "flex min-w-0 flex-1 items-start gap-3 rounded-l-lg py-2.5 pl-3 outline-none",
    "hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
  );
  const body = (
    <>
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-4 shrink-0",
          item.unread ? "text-destructive" : "text-muted-foreground",
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          id={titleId}
          className={cn("block break-words", item.unread && "font-medium")}
        >
          {item.unread && <span className="sr-only">Unread: </span>}
          {title}
        </span>
        <span className="mt-0.5 line-clamp-2 block break-words text-muted-foreground">
          {detail}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          <span className="underline underline-offset-4">{action}</span>
          {" · "}
          <time dateTime={new Date(item.createdAt).toISOString()}>
            {timeAgo(item.createdAt, now)}
          </time>
        </span>
      </span>
    </>
  );

  return (
    <li
      data-unread={item.unread}
      aria-labelledby={titleId}
      className={cn(
        "flex items-start rounded-lg border",
        item.unread && "border-primary/40 bg-accent/30",
      )}
    >
      {/* Where the thing is dealt with: the post on the Sent screen, or
          on the Queue screen if it was held there, the account on the
          Channels screen, in the dialog that connects it again. Going
          there is reading it. */}
      {item.kind === "post_held" ? (
        <Link to="/queue" onClick={onRead} className={link}>
          {body}
        </Link>
      ) : item.kind === "post_failed" ? (
        <Link
          to="/sent"
          search={{ post: item.postId }}
          onClick={onRead}
          className={link}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/channels"
          search={{ reconnect: item.channel.id }}
          onClick={onRead}
          className={link}
        >
          {body}
        </Link>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="m-1.5 shrink-0"
        aria-label={`Dismiss: ${title}`}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </Button>
    </li>
  );
}
