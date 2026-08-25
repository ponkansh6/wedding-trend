ALTER TABLE `post_publications` ADD COLUMN `text_length` integer;
--> statement-breakpoint
ALTER TABLE `post_publications` ADD COLUMN `link_density` real;
--> statement-breakpoint
ALTER TABLE `post_publications` ADD COLUMN `paragraph_count` integer;
