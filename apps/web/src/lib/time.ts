import { useEffect, useState } from "react";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const dayAndMonth = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
});
const dayMonthAndYear = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

/** How long ago `time` was at `now`, in as few characters as it takes. */
export function timeAgo(time: number, now: number): string {
  const ago = now - time;
  // Also for a time that is ahead: the clocks of two devices differ.
  if (ago < minute) return "now";
  if (ago < hour) return `${Math.floor(ago / minute)}m`;
  if (ago < day) return `${Math.floor(ago / hour)}h`;
  if (ago < 7 * day) return `${Math.floor(ago / day)}d`;
  const date = new Date(time);
  return date.getFullYear() === new Date(now).getFullYear()
    ? dayAndMonth.format(date)
    : dayMonthAndYear.format(date);
}

/**
 * When `time` was at `now`, as the end of a sentence: "Published 5m ago",
 * "Published just now", "Published on 3 Mar". `timeAgo` alone is for
 * where a time stands by itself, as in a list.
 */
export function whenAgo(time: number, now: number): string {
  const ago = now - time;
  if (ago < minute) return "just now";
  if (ago < 7 * day) return `${timeAgo(time, now)} ago`;
  return `on ${timeAgo(time, now)}`;
}

/** The time, to the minute: the component renders again when it changes. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), minute / 2);
    return () => clearInterval(timer);
  }, []);
  return now;
}
