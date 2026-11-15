CREATE TABLE `workspace` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`environment` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_owner_environment_idx` ON `workspace` (`owner_id`,`environment`);