ALTER TABLE `session` ADD `usage_input` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `session` ADD `usage_output` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `session` ADD `usage_reasoning` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `session` ADD `usage_cache_read` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `session` ADD `usage_cache_write` integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE `session` ADD `usage_cost` real DEFAULT 0;