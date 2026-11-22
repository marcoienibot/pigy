CREATE TABLE `publish_record` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` text NOT NULL,
	`requested_at` integer NOT NULL,
	`source` text NOT NULL,
	`api_key_id` text,
	`target_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`network` text NOT NULL,
	`outcome` text,
	`ended_at` integer
);
--> statement-breakpoint
CREATE INDEX `publish_record_requested_at_idx` ON `publish_record` (`requested_at`);--> statement-breakpoint
CREATE INDEX `publish_record_target_id_idx` ON `publish_record` (`target_id`);