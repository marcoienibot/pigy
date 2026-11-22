CREATE TABLE `schedule_slot` (
	`id` text PRIMARY KEY NOT NULL,
	`weekday` integer NOT NULL,
	`minute` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `schedule_slot_weekday_minute_idx` ON `schedule_slot` (`weekday`,`minute`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` text PRIMARY KEY NOT NULL,
	`time_zone` text,
	`queue_paused` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `post` ADD `mode` text;--> statement-breakpoint
ALTER TABLE `post` ADD `due_at` integer;--> statement-breakpoint
ALTER TABLE `post` ADD `queue_position` integer;--> statement-breakpoint
ALTER TABLE `post` ADD `held_at` integer;--> statement-breakpoint
ALTER TABLE `post` ADD `trashed_at` integer;--> statement-breakpoint
CREATE INDEX `post_status_idx` ON `post` (`status`);