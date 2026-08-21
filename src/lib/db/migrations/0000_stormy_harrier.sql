CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`source_name` text NOT NULL,
	`original_title` text NOT NULL,
	`original_excerpt` text,
	`author` text,
	`thumbnail_url` text,
	`published_at` text,
	`ai_title` text,
	`ai_summary` text,
	`category` text,
	`tag` text,
	`embed_provider` text DEFAULT 'none' NOT NULL,
	`embed_html` text,
	`embed_fetched_at` text,
	`status` text DEFAULT 'published' NOT NULL,
	`content_hash` text,
	`curation_signature` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `posts_url_unique` ON `posts` (`url`);--> statement-breakpoint
CREATE INDEX `idx_source_status_pub` ON `posts` (`source_type`,`status`,`published_at`);--> statement-breakpoint
CREATE INDEX `idx_category` ON `posts` (`category`);--> statement-breakpoint
CREATE INDEX `idx_tag` ON `posts` (`tag`);--> statement-breakpoint
CREATE INDEX `idx_created_at` ON `posts` (`created_at`);