CREATE TABLE `post_target` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`status` text NOT NULL,
	`attempt` integer NOT NULL,
	`error` text,
	`queued_at` integer,
	`sent_at` integer,
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `post_target_post_id_channel_id_idx` ON `post_target` (`post_id`,`channel_id`);--> statement-breakpoint
CREATE INDEX `post_target_channel_id_idx` ON `post_target` (`channel_id`);--> statement-breakpoint
CREATE TABLE `target_part_result` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`part_id` text NOT NULL,
	`remote_id` text NOT NULL,
	`url` text,
	FOREIGN KEY (`target_id`) REFERENCES `post_target`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`part_id`) REFERENCES `post_part`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `target_part_result_target_id_part_id_idx` ON `target_part_result` (`target_id`,`part_id`);