CREATE TABLE `keyed_call` (
	`key` text PRIMARY KEY NOT NULL,
	`outcome` text NOT NULL,
	`handled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `keyed_call_handled_at_idx` ON `keyed_call` (`handled_at`);