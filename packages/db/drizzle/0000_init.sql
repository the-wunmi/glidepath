CREATE TABLE "activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" bigint,
	"kind" text NOT NULL,
	"message" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enclave_store" (
	"key" text PRIMARY KEY NOT NULL,
	"box" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "executions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"plan_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"amount" text NOT NULL,
	"correlation_id" text NOT NULL,
	"deposit_address" text NOT NULL,
	"min_amount_out" text NOT NULL,
	"quote" jsonb NOT NULL,
	"request_json" text NOT NULL,
	"signature" text NOT NULL,
	"enclave_key" text NOT NULL,
	"status" text NOT NULL,
	"chain_tx" text,
	"chain_error" text,
	"evm_tx_hash" text,
	"evm_sent_at_block" bigint,
	"evm_resigns" integer DEFAULT 0 NOT NULL,
	"settlement_status" text,
	"amount_out" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"idem_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"label" text NOT NULL,
	"token_chain" text NOT NULL,
	"token_address" text NOT NULL,
	"token_symbol" text NOT NULL,
	"token_decimals" integer NOT NULL,
	"commitment" text NOT NULL,
	"sealed_box" jsonb NOT NULL,
	"pending_sealed_box" jsonb,
	"plan_account" text NOT NULL,
	"create_tx" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_oneclick_quotes" (
	"deposit_address" text PRIMARY KEY NOT NULL,
	"correlation_id" text NOT NULL,
	"deposit_key" text NOT NULL,
	"response" jsonb NOT NULL,
	"status" text NOT NULL,
	"outcome" text NOT NULL,
	"swap_details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sim_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "world" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"genesis_hash" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "activity_plan" ON "activity" USING btree ("plan_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "executions_plan_seq" ON "executions" USING btree ("plan_id","seq");--> statement-breakpoint
CREATE INDEX "executions_status" ON "executions" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_idem" ON "jobs" USING btree ("idem_key");--> statement-breakpoint
CREATE INDEX "jobs_due" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "plans_owner" ON "plans" USING btree ("owner");--> statement-breakpoint
CREATE UNIQUE INDEX "sim_oneclick_correlation" ON "sim_oneclick_quotes" USING btree ("correlation_id");