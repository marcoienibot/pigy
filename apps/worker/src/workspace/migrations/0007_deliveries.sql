ALTER TABLE `post_target` ADD `progress` text;--> statement-breakpoint
ALTER TABLE `post_target` ADD `dispatched` integer DEFAULT 0 NOT NULL;