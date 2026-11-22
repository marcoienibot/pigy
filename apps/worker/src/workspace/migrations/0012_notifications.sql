CREATE TABLE `notification` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`post_id` text,
	`channel_id` text,
	`created_at` integer NOT NULL,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `notification_created_at_idx` ON `notification` (`created_at`);--> statement-breakpoint
CREATE TABLE `push_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`message` text NOT NULL,
	`notification_id` text NOT NULL,
	`queued_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `channel` ADD `expiry_warned_for` integer;--> statement-breakpoint
ALTER TABLE `post_target` ADD `disconnected` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Written by hand. A target of a workspace from before this column that a
-- disconnect ended says so from here on, so that a post which was still
-- being sent to another account at the upgrade is not told of as one that
-- failed when it ends. Nothing but its error said how a target ended
-- then, so it is matched by the text that `channel.disconnect` has
-- written since there are targets (`disconnectedMessage` in
-- packages/core/src/sync/mutators.ts), for this once: nothing reads the
-- text of an error from here on.
UPDATE `post_target` SET `disconnected` = true WHERE `status` = 'error' AND `error` = 'The account was disconnected before the post was sent.';