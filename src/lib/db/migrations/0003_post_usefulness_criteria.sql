CREATE TABLE `post_usefulness_criteria` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`criteria_json` text NOT NULL,
	`signature` text NOT NULL,
	`model_id` text NOT NULL,
	`scored_at` text NOT NULL
);
