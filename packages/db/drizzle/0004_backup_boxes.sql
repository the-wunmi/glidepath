ALTER TABLE "plans" ADD COLUMN "backup_boxes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ADD COLUMN "pending_backup_boxes" jsonb DEFAULT '[]'::jsonb NOT NULL;