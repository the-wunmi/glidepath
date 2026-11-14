CREATE TABLE "trust_trades" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"trust_id" bigint NOT NULL,
	"seq" integer NOT NULL,
	"deposit_address" text NOT NULL,
	"request_json" text NOT NULL,
	"signature" text NOT NULL,
	"enclave_key" text NOT NULL,
	"status" text NOT NULL,
	"chain_tx" text,
	"chain_error" text,
	"settlement_status" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusts" (
	"id" bigint PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"label" text NOT NULL,
	"commitment" text NOT NULL,
	"sealed_box" jsonb NOT NULL,
	"trust_account" text NOT NULL,
	"deposits" jsonb NOT NULL,
	"create_tx" text NOT NULL,
	"owner_key_hash" text NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "trust_trades_trust_seq" ON "trust_trades" USING btree ("trust_id","seq");