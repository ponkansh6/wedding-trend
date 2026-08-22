CREATE TABLE `post_usefulness` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`firsthand` integer NOT NULL,
	`ceremony_decision` integer NOT NULL,
	`specific` integer NOT NULL,
	`tradeoff` integer NOT NULL,
	`promotional` integer NOT NULL,
	`signature` text NOT NULL,
	`model_id` text NOT NULL,
	`scored_at` text NOT NULL
);
