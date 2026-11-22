CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`animated` integer NOT NULL,
	`created_at` integer NOT NULL,
	`error` text,
	`original_gone_at` integer,
	`upload_id` text,
	`upload_parts` text,
	`unattached_since` integer
);
--> statement-breakpoint
CREATE INDEX `media_status_idx` ON `media` (`status`);--> statement-breakpoint
CREATE TABLE `part_media` (
	`id` text PRIMARY KEY NOT NULL,
	`part_id` text NOT NULL,
	`media_id` text NOT NULL,
	`position` integer NOT NULL,
	`alt` text NOT NULL,
	FOREIGN KEY (`part_id`) REFERENCES `post_part`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `part_media_part_id_idx` ON `part_media` (`part_id`);--> statement-breakpoint
CREATE INDEX `part_media_media_id_idx` ON `part_media` (`media_id`);