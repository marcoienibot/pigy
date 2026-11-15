CREATE TABLE `mastodon_app` (
	`scope` text NOT NULL,
	`domain` text NOT NULL,
	`registration` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope`, `domain`)
);
--> statement-breakpoint
CREATE TABLE `oauth_state` (
	`state` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`network` text NOT NULL,
	`pending` text NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspace`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `oauth_state_expires_at_idx` ON `oauth_state` (`expires_at`);