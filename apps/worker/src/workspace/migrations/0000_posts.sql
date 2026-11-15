CREATE TABLE `change_log` (
	`seq` integer NOT NULL,
	`table_name` text NOT NULL,
	`row_id` text NOT NULL,
	PRIMARY KEY(`seq`, `table_name`, `row_id`)
);
--> statement-breakpoint
CREATE TABLE `client_mutation` (
	`client_id` text PRIMARY KEY NOT NULL,
	`last_mutation_id` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `post_part` (
	`id` text PRIMARY KEY NOT NULL,
	`post_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `post`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `post_part_post_id_idx` ON `post_part` (`post_id`);--> statement-breakpoint
CREATE TABLE `post` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`environment` text NOT NULL,
	`seq` integer NOT NULL,
	`log_floor` integer NOT NULL
);
