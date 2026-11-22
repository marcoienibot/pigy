ALTER TABLE `post_part` ADD `target_id` text REFERENCES post_target(id);--> statement-breakpoint
CREATE INDEX `post_part_target_id_idx` ON `post_part` (`target_id`);--> statement-breakpoint
CREATE INDEX `target_part_result_part_id_idx` ON `target_part_result` (`part_id`);