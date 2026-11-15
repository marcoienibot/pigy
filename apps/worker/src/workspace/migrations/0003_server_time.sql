ALTER TABLE `workspace` ADD `time` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Written by hand. A workspace from before this column has rows with times
-- in them, which the clock of whatever machine ran its mutations then put
-- there. Its clock starts from the latest of them and not from zero, so
-- that its next mutation is run later than every one before it, also
-- where the clock of today is behind. These are the columns that a
-- mutator had written a time to by then.
UPDATE `workspace` SET `time` = max(
	coalesce((SELECT max(`created_at`) FROM `post`), 0),
	coalesce((SELECT max(`updated_at`) FROM `post`), 0),
	coalesce((SELECT max(`connected_at`) FROM `channel`), 0)
);