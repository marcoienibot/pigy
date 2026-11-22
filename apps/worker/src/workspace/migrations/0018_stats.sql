CREATE TABLE `metric` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`likes` integer,
	`reposts` integer,
	`replies` integer,
	`quotes` integer,
	`views` integer,
	`counted_at` integer,
	`reason` text,
	FOREIGN KEY (`id`) REFERENCES `post_target`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `post_target` ADD `metrics_at` integer;--> statement-breakpoint
CREATE INDEX `post_target_metrics_at_idx` ON `post_target` (`status`,`metrics_at`);