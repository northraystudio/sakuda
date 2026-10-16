CREATE TABLE `mcp_api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mcp_api_keys_key_hash_unique` ON `mcp_api_keys` (`key_hash`);