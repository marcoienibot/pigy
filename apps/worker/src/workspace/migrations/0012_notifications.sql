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
ALTER TABLE `post_target` ADD `disconnected` integer DEFAULT false NOT NULL;