import { pgTable, serial, text, real, integer, bigint, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  provider: text("provider").notNull(), // kiro | codebuddy | canva
  email: text("email").notNull(),
  password: text("password").notNull(), // encrypted
  status: text("status").notNull().default("pending"), // active | exhausted | error | pending
  tokens: jsonb("tokens"), // { access_token, refresh_token, ... }
  quotaLimit: real("quota_limit").default(0),
  quotaRemaining: real("quota_remaining").default(0),
  quotaResetAt: timestamp("quota_reset_at"),
  lastUsedAt: timestamp("last_used_at"),
  lastLoginAt: timestamp("last_login_at"),
  errorMessage: text("error_message"),
  metadata: jsonb("metadata"), // extra provider-specific data
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  // Email must be unique PER provider (same email can exist for kiro + codebuddy + canva)
  uniqueIndex("accounts_provider_email_idx").on(table.provider, table.email),
]);

export const requestLogs = pgTable("request_logs", {
  id: serial("id").primaryKey(),
  accountId: integer("account_id").references(() => accounts.id),
  provider: text("provider").notNull(),
  model: text("model"),
  promptTokens: integer("prompt_tokens").default(0),
  completionTokens: integer("completion_tokens").default(0),
  totalTokens: integer("total_tokens").default(0),
  creditsUsed: real("credits_used").default(0),
  status: text("status").notNull(), // success | error
  durationMs: integer("duration_ms"),
  errorMessage: text("error_message"),
  requestBody: jsonb("request_body"),
  responseBody: jsonb("response_body"),
  accountEmail: text("account_email"),
  accountQuotaBefore: real("account_quota_before").default(0),
  accountQuotaAfter: real("account_quota_after").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("request_logs_created_at_idx").on(table.createdAt),
  index("request_logs_status_created_at_idx").on(table.status, table.createdAt),
  index("request_logs_provider_created_at_idx").on(table.provider, table.createdAt),
  index("request_logs_provider_model_status_idx").on(table.provider, table.model, table.status),
  index("request_logs_account_idx").on(table.accountId),
]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const usageSummary = pgTable("usage_summary", {
  id: serial("id").primaryKey(),
  bucket: timestamp("bucket").notNull(), // start of hour (UTC)
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  totalRequests: integer("total_requests").default(0),
  successRequests: integer("success_requests").default(0),
  errorRequests: integer("error_requests").default(0),
  promptTokens: bigint("prompt_tokens", { mode: "number" }).default(0),
  completionTokens: bigint("completion_tokens", { mode: "number" }).default(0),
  totalTokens: bigint("total_tokens", { mode: "number" }).default(0),
  creditsUsed: real("credits_used").default(0),
  totalDurationMs: bigint("total_duration_ms", { mode: "number" }).default(0),
}, (table) => [
  uniqueIndex("usage_summary_bucket_provider_model_idx").on(table.bucket, table.provider, table.model),
  index("usage_summary_bucket_idx").on(table.bucket),
  index("usage_summary_provider_idx").on(table.provider, table.bucket),
]);

// Type exports
export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type RequestLog = typeof requestLogs.$inferSelect;
export type NewRequestLog = typeof requestLogs.$inferInsert;
export type Setting = typeof settings.$inferSelect;
export type UsageSummary = typeof usageSummary.$inferSelect;
export type NewUsageSummary = typeof usageSummary.$inferInsert;
