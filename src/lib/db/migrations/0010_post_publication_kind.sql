CREATE TABLE `post_publication_kind` (
	`post_id` integer PRIMARY KEY NOT NULL REFERENCES `posts`(`id`),
	`hash_kind` text NOT NULL
);
