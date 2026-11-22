ALTER TABLE `post_target` ADD `may_have_sent` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Written by hand. A target of a workspace from before this column that
-- stands as `uncertain` is one whose last attempt may have sent, which is
-- what the column says from here on.
UPDATE `post_target` SET `may_have_sent` = true WHERE `status` = 'uncertain';
