import "dotenv/config";

/**
 * Normalize secrets copied from dashboards / Vercel UI.
 * Never log the returned value.
 */
export function sanitizeSecret(raw: string): string {
  let value = raw.trim().replace(/^\uFEFF/, "");

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim();
  }

  // Tokens must be a single contiguous string (no spaces/newlines).
  value = value.replace(/[\r\n\t ]+/g, "");

  // Common paste mistakes from docs / curl examples.
  value = value.replace(/^Bearer/i, "").replace(/^access_token=/i, "");

  return value.trim();
}

function requireEnv(name: string): string {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    throw new Error(
      `Missing required environment variable: ${name}. Copy .env.example to .env and set your credentials.`,
    );
  }
  const value = sanitizeSecret(raw);
  if (!value) {
    throw new Error(
      `Environment variable ${name} is empty after trimming whitespace/quotes.`,
    );
  }
  return value;
}

export type AppConfig = {
  accessToken: string;
  /** Optional. For Instagram Login, IG ID is resolved from /me.user_id. */
  accountId: string | undefined;
  graphApiBase: string;
  apiVersion: string;
  port: number;
  /** Instagram app secret — required only for short→long-lived token exchange */
  appSecret: string | undefined;
};

export function loadConfig(): AppConfig {
  const graphApiBase = (
    process.env.INSTAGRAM_GRAPH_API_BASE?.trim() ||
    "https://graph.facebook.com"
  ).replace(/\/$/, "");

  const apiVersion = (
    process.env.INSTAGRAM_API_VERSION?.trim() || "v22.0"
  ).replace(/^\/+/, "");

  const appSecretRaw = process.env.INSTAGRAM_APP_SECRET;
  const appSecret =
    appSecretRaw && appSecretRaw.trim()
      ? sanitizeSecret(appSecretRaw)
      : undefined;

  const accountIdRaw = process.env.INSTAGRAM_ACCOUNT_ID;
  const accountId =
    accountIdRaw && accountIdRaw.trim()
      ? sanitizeSecret(accountIdRaw)
      : undefined;

  const isInstagramLogin = graphApiBase.includes("graph.instagram.com");
  if (!isInstagramLogin && !accountId) {
    throw new Error(
      "Missing required environment variable: INSTAGRAM_ACCOUNT_ID (required when not using https://graph.instagram.com).",
    );
  }

  return {
    accessToken: requireEnv("INSTAGRAM_ACCESS_TOKEN"),
    accountId,
    graphApiBase,
    apiVersion,
    port: Number(process.env.PORT) || 3000,
    appSecret: appSecret || undefined,
  };
}

export type AuthConfig = {
  issuer: string;
  resource: string;
};

/** Separate from Instagram config so health and OAuth discovery need no Meta token. */
export function loadAuthConfig(): AuthConfig {
  const issuer = new URL(process.env.WORKOS_AUTHKIT_ISSUER?.trim() || "");
  const resource = new URL(process.env.MCP_RESOURCE_URL?.trim() || "");
  const hasExtraParts = (url: URL) =>
    Boolean(url.username || url.password || url.search || url.hash);
  if (issuer.protocol !== "https:" || issuer.pathname !== "/" || hasExtraParts(issuer)) {
    throw new Error("WORKOS_AUTHKIT_ISSUER must be an HTTPS AuthKit origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(resource.hostname);
  if (
    (resource.protocol !== "https:" && !(local && resource.protocol === "http:")) ||
    resource.pathname !== "/mcp" || hasExtraParts(resource)
  ) {
    throw new Error("MCP_RESOURCE_URL must be the canonical HTTPS /mcp URL (HTTP allowed on loopback).");
  }
  return { issuer: issuer.origin, resource: resource.href };
}

export function getApiRoot(config: AppConfig): string {
  return `${config.graphApiBase}/${config.apiVersion}`;
}

/** Safe token fingerprint for diagnostics — never the full token. */
export function maskToken(token: string): {
  token_length: number;
  token_preview: string;
} {
  const length = token.length;
  if (length < 8) {
    return {
      token_length: length,
      token_preview: "[too_short_to_mask]",
    };
  }
  return {
    token_length: length,
    token_preview: `${token.slice(0, 4)}...${token.slice(-4)}`,
  };
}

export function extractMetaError(body: unknown): {
  code?: number;
  type?: string;
  message?: string;
  fbtrace_id?: string;
} | null {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return null;
  }
  const err = (body as { error?: Record<string, unknown> }).error;
  if (!err || typeof err !== "object") {
    return null;
  }
  return {
    code: typeof err.code === "number" ? err.code : undefined,
    type: typeof err.type === "string" ? err.type : undefined,
    message: typeof err.message === "string" ? err.message : undefined,
    fbtrace_id:
      typeof err.fbtrace_id === "string" ? err.fbtrace_id : undefined,
  };
}
