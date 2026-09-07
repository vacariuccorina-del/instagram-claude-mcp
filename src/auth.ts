import type { RequestHandler } from "express";
import { createRemoteJWKSet, jwtVerify, type RemoteJWKSetOptions } from "jose";
import { loadAuthConfig, type AuthConfig } from "./config.js";

/** One cached key set per app instance; jose refreshes it for key rotation. */
export function createWorkosAuth(
  load: () => AuthConfig = loadAuthConfig,
  jwksOptions: RemoteJWKSetOptions = {},
  fetchMetadata: typeof fetch = fetch,
) {
  let state: {
    config: AuthConfig;
    keys: ReturnType<typeof createRemoteJWKSet>;
    metadataUrl: string;
  } | undefined;
  const getState = () => {
    if (!state) {
      const config = load();
      state = {
        config,
        keys: createRemoteJWKSet(new URL(`${config.issuer}/oauth2/jwks`), {
          timeoutDuration: 5000,
          ...jwksOptions,
        }),
        metadataUrl: new URL("/.well-known/oauth-protected-resource/mcp", config.resource).href,
      };
    }
    return state;
  };

  const metadata: RequestHandler = (_req, res) => {
    try {
      const { config } = getState();
      res.json({
        resource: config.resource,
        authorization_servers: [config.issuer],
        bearer_methods_supported: ["header"],
      });
    } catch {
      res.status(503).json({ error: "OAuth is not configured." });
    }
  };

  // Compatibility for clients that discover the authorization server at our origin.
  // AuthKit remains the source of truth; never forward client headers or query strings.
  const authorizationServerMetadata: RequestHandler = async (_req, res) => {
    res.set("Cache-Control", "no-store");
    let config: AuthConfig;
    try {
      config = getState().config;
    } catch {
      res.status(503).json({ error: "OAuth is not configured." });
      return;
    }
    try {
      const upstream = await fetchMetadata(`${config.issuer}/.well-known/oauth-authorization-server`, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      });
      if (!upstream.ok) throw new Error("Metadata request failed");
      const document: unknown = await upstream.json();
      if (!document || typeof document !== "object" || Array.isArray(document) ||
          !("issuer" in document) || document.issuer !== config.issuer) {
        throw new Error("Invalid authorization server metadata");
      }
      res.json(document);
    } catch {
      res.status(502).json({ error: "Authorization server metadata unavailable." });
    }
  };

  const requireAuth: RequestHandler = async (req, res, next) => {
    let current: ReturnType<typeof getState>;
    try {
      current = getState();
    } catch {
      res.status(503).json({ error: "OAuth is not configured." });
      return;
    }
    res.set("Cache-Control", "no-store");
    const challenge = `Bearer resource_metadata="${current.metadataUrl}"`;
    const token = req.headers.authorization?.match(/^Bearer ([^\s,]+)$/i)?.[1];
    if (!token) {
      res.set("WWW-Authenticate", challenge).status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, current.keys, {
        issuer: current.config.issuer,
        audience: current.config.resource,
        algorithms: ["RS256"],
        requiredClaims: ["iss", "aud", "sub", "exp"],
      });
      if (typeof payload.sub !== "string" || !payload.sub.trim()) {
        throw new Error("Missing subject");
      }
    } catch {
      res.set("WWW-Authenticate", `${challenge}, error="invalid_token"`)
        .status(401).json({ error: "Invalid access token" });
      return;
    }
    next();
  };

  return { metadata, authorizationServerMetadata, requireAuth };
}
