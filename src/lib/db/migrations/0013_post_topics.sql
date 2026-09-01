CREATE TABLE `post_topics` (
	`post_id` integer NOT NULL,
	`position` integer NOT NULL,
	`topic` text NOT NULL,
	`prompt_version` text NOT NULL,
	PRIMARY KEY(`post_id`, `position`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE NO ACTION ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_post_topics_topic_post` ON `post_topics` (`post_id`,`topic`);
--> statement-breakpoint
CREATE INDEX `idx_post_topics_topic` ON `post_topics` (`topic`);
