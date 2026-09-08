CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"accountId" text NOT NULL,
	"providerId" text NOT NULL,
	"userId" text NOT NULL,
	"accessToken" text,
	"refreshToken" text,
	"idToken" text,
	"accessTokenExpiresAt" timestamp with time zone,
	"refreshTokenExpiresAt" timestamp with time zone,
	"scope" text,
	"password" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo" text,
	"metadata" jsonb,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY,
	"deviceCode" text NOT NULL,
	"userCode" text NOT NULL,
	"userId" text,
	"expiresAt" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"lastPolledAt" timestamp with time zone,
	"pollingInterval" integer,
	"clientId" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"id" text PRIMARY KEY,
	"companyId" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"inviterId" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"id" text PRIMARY KEY,
	"companyId" text NOT NULL,
	"userId" text NOT NULL,
	"role" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"emailVerified" boolean DEFAULT false NOT NULL,
	"image" text,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" text PRIMARY KEY,
	"companyId" text NOT NULL,
	"name" text NOT NULL,
	"parentProjectId" text,
	"createdBy" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expiresAt" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
	"ipAddress" text,
	"userAgent" text,
	"userId" text NOT NULL,
	"activeCompanyId" text
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"personId" text PRIMARY KEY,
	"theme" text DEFAULT 'system' NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"updatedAt" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" ("userId");--> statement-breakpoint
CREATE UNIQUE INDEX "account_provider_idx" ON "account" ("providerId","accountId");--> statement-breakpoint
CREATE UNIQUE INDEX "company_slug_idx" ON "company" ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_device_idx" ON "device_code" ("deviceCode");--> statement-breakpoint
CREATE UNIQUE INDEX "device_code_user_idx" ON "device_code" ("userCode");--> statement-breakpoint
CREATE INDEX "invitation_company_idx" ON "invitation" ("companyId");--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "membership_company_user_idx" ON "membership" ("companyId","userId");--> statement-breakpoint
CREATE INDEX "membership_user_idx" ON "membership" ("userId");--> statement-breakpoint
CREATE INDEX "membership_company_idx" ON "membership" ("companyId");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_idx" ON "user" ("email");--> statement-breakpoint
CREATE INDEX "project_company_idx" ON "project" ("companyId");--> statement-breakpoint
CREATE INDEX "project_parent_idx" ON "project" ("parentProjectId");--> statement-breakpoint
CREATE INDEX "project_company_parent_idx" ON "project" ("companyId","parentProjectId");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_idx" ON "session" ("token");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" ("userId");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "device_code" ADD CONSTRAINT "device_code_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_companyId_company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_user_id_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_companyId_company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_companyId_company_id_fkey" FOREIGN KEY ("companyId") REFERENCES "company"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_parentProjectId_project_id_fkey" FOREIGN KEY ("parentProjectId") REFERENCES "project"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_createdBy_user_id_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_userId_user_id_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_activeCompanyId_company_id_fkey" FOREIGN KEY ("activeCompanyId") REFERENCES "company"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_personId_user_id_fkey" FOREIGN KEY ("personId") REFERENCES "user"("id") ON DELETE CASCADE;