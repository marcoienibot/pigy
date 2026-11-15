CREATE TABLE `rejection` (
	`client_id` text NOT NULL,
	`mutation_id` integer NOT NULL,
	`code` text NOT NULL,
	`message` text NOT NULL,
	PRIMARY KEY(`client_id`, `mutation_id`)
);
