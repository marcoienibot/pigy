CREATE TABLE `channel` (
	`id` text PRIMARY KEY NOT NULL,
	`network` text NOT NULL,
	`account_id` text NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`avatar_url` text,
	`profile_url` text,
	`status` text NOT NULL,
	`connected_at` integer NOT NULL,
	`expires_at` integer,
	`credentials` text,
	`refresh_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channel_network_account_id_idx` ON `channel` (`network`,`account_id`);