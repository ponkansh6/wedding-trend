CREATE TABLE `source_policy` (
	`host` text PRIMARY KEY NOT NULL,
	`robots_hash` text NOT NULL,
	`robots_body` text NOT NULL,
	`tos_url` text,
	`tos_hash` text,
	`checked_at` text NOT NULL
);
