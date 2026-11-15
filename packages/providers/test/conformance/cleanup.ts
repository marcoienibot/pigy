/** A post that a test published. */
export type Leftover = {
  id: string;
  /** Where a person finds it, if the network said. */
  url: string | null;
  remove(): Promise<void>;
};

/**
 * Deletes what the tests published. A live run must leave nothing behind,
 * and a network may refuse a deletion: Mastodon allows 30 in half an hour.
 * So every post is tried, also after one has failed, and what could not be
 * deleted is named, for somebody to delete by hand.
 */
export async function removeAll(posts: readonly Leftover[]): Promise<void> {
  const left: string[] = [];
  for (const { id, url, remove } of posts) {
    try {
      await remove();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      left.push(`${url ?? id}: ${reason}`);
    }
  }
  if (left.length > 0) {
    throw new Error(
      `${left.length} of ${posts.length} posts could not be deleted and are still on the network. Delete them by hand:\n${left.join("\n")}`,
    );
  }
}
