DROP INDEX `post_status_idx`;--> statement-breakpoint
CREATE INDEX `post_status_created_at_idx` ON `post` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `post_created_at_idx` ON `post` (`created_at`,`id`);