CREATE TABLE `topic_backfill_signatures` (
	`post_id` integer PRIMARY KEY NOT NULL,
	`signature` text NOT NULL,
	`source_digest` text,
	`extraction_version` text,
	`topic_prompt_version` text,
	`schema_version` text,
	`model_id` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_topic_backfill_signatures_updated` ON `topic_backfill_signatures` (`updated_at`);
