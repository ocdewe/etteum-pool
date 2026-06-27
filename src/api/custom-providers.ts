import { Hono } from "hono";
import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq, and } from "drizzle-orm";
import { encrypt, decrypt } from "../utils/crypto";
import { pool } from "../proxy/pool";
import { providers } from "../proxy/router";
import { broadcast } from "../ws/index";
import { config } from "../config";

export const customProviderRouter = new Hono();

/**
 * POST /api/custom-providers - Create a custom provider account
 * Body: { name, base_url, api_key, models?: string[] }
 */
customProviderRouter.post("/", async (c) => {
  const body = await c.req.json<{
    name: string;
    base_url: string;
    api_key: string;
    models?: string[];
  }>();

  if (!body.name || !body.base_url || !body.api_key) {
    return c.json({ error: "name, base_url, and api_key are required" }, 400);
  }

  // Normalize base_url (remove trailing slash)
  const baseUrl = body.base_url.replace(/\/+$/, "");

  // Check if provider with this name already exists
  const existing = await db.select().from(accounts)
    .where(and(eq(accounts.provider, "custom"), eq(accounts.email, body.name)))
    .then(rows => rows[0]);

  if (existing) {
    return c.json({ error: `Provider "${body.name}" already exists (id: ${existing.id})` }, 409);
  }

  // Models start empty — user adds them manually via PUT /api/custom-providers/:id/models
  let models: string[] = body.models || [];

  // Store as a single account with tokens containing all provider info
  // API key stored as plaintext in tokens (not exposed via API)
  const tokens = {
    base_url: baseUrl,
    api_key: body.api_key,
    provider_name: body.name,
    models,
  };

  // Password field stores encrypted version for consistency
  const encryptedPassword = encrypt(body.api_key);

  const [created] = await db.insert(accounts).values({
    provider: "custom",
    email: body.name,
    password: encryptedPassword,
    status: "active",
    tokens: tokens as any,
  }).returning();

  pool.invalidate("custom");

  broadcast({
    type: "account_created",
    data: { id: created.id, provider: "custom", email: body.name },
  });

  return c.json({
    id: created.id,
    name: body.name,
    base_url: baseUrl,
    status: "active",
    models: models,
    model_count: models.length,
  }, 201);
});

/**
 * GET /api/custom-providers - List all custom providers
 */
customProviderRouter.get("/", async (c) => {
  const rows = await db.select().from(accounts)
    .where(eq(accounts.provider, "custom"));

  const providers = rows.map(row => {
    const tokens = row.tokens && typeof row.tokens === "object"
      ? row.tokens as Record<string, any>
      : {};
    return {
      id: row.id,
      name: row.email,
      base_url: tokens.base_url || "",
      status: row.status,
      enabled: row.enabled,
      models: tokens.models || [],
      model_count: (tokens.models || []).length,
      created_at: row.createdAt,
    };
  });

  return c.json({ data: providers });
});

/**
 * GET /api/custom-providers/:id/models - Fetch fresh models from provider
 */
customProviderRouter.get("/:id/models", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [account] = await db.select().from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.provider, "custom")));

  if (!account) {
    return c.json({ error: "Provider not found" }, 404);
  }

  const tokens = account.tokens && typeof account.tokens === "object"
    ? account.tokens as Record<string, any>
    : {};

  const baseUrl = tokens.base_url;
  const apiKey = tokens.api_key;
  if (!baseUrl || !apiKey) {
    return c.json({ error: "Missing base_url or api_key" }, 400);
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      return c.json({ error: `HTTP ${response.status}` }, 502);
    }

    const data = await response.json() as any;
    const modelList = data.data || data.models || [];
    const models = modelList.map((m: any) => ({
      id: m.id,
      name: m.id,
      context_length: m.context_length || m.context_window || null,
      owned_by: m.owned_by || "unknown",
    }));

    // Update stored models
    await db.update(accounts).set({
      tokens: { ...tokens, models: models.map((m: any) => m.id) } as any,
      updatedAt: new Date(),
    }).where(eq(accounts.id, id));

    return c.json({
      provider: account.email,
      base_url: baseUrl,
      models,
      count: models.length,
    });
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : String(error),
    }, 502);
  }
});

/**
 * PUT /api/custom-providers/:id/models - Set models manually
 * Body: { models: ["model-id-1", "model-id-2", ...] }
 */
customProviderRouter.put("/:id/models", async (c) => {
  const id = parseInt(c.req.param("id"));
  const body = await c.req.json<{ models: string[] }>();

  const [account] = await db.select().from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.provider, "custom")));

  if (!account) {
    return c.json({ error: "Provider not found" }, 404);
  }

  const tokens = account.tokens && typeof account.tokens === "object"
    ? account.tokens as Record<string, any>
    : {};

  await db.update(accounts).set({
    tokens: { ...tokens, models: body.models || [] } as any,
    updatedAt: new Date(),
  }).where(eq(accounts.id, id));

  pool.invalidate("custom");

  return c.json({
    id,
    name: account.email,
    models: body.models || [],
    model_count: (body.models || []).length,
  });
});

/**
 * DELETE /api/custom-providers/:id - Remove a custom provider
 */
customProviderRouter.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"));
  const [account] = await db.select().from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.provider, "custom")));

  if (!account) {
    return c.json({ error: "Provider not found" }, 404);
  }

  await db.delete(accounts).where(eq(accounts.id, id));
  pool.invalidate("custom");

  broadcast({
    type: "account_deleted",
    data: { id, provider: "custom", email: account.email },
  });

  return c.json({ success: true, deleted: id });
});
