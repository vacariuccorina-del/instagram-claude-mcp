import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import express, {
  type Request,
  type Response,
} from "express";
import { loadConfig, type AppConfig } from "./config.js";
import { createWorkosAuth } from "./auth.js";
import { InstagramClient } from "./instagram/client.js";
import { createInstagramMcpServer } from "./mcp-server.js";

let cachedConfig: AppConfig | undefined;
let cachedClient: InstagramClient | undefined;

function getConfig(): AppConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

function getInstagramClient(): InstagramClient {
  if (!cachedClient) {
    cachedClient = new InstagramClient(getConfig());
  }
  return cachedClient;
}

/**
 * Express app used for local Node hosting and Vercel serverless.
 * Do not call app.listen() here — the entrypoint decides that.
 */
export function createApp({ auth = createWorkosAuth() }: {
  auth?: ReturnType<typeof createWorkosAuth>;
} = {}): express.Express {
  // Bind 0.0.0.0 for remote deployment. Localhost-only DNS rebinding
  // protection is disabled when host is not loopback.
  // `express` is imported so Vercel can detect the Express framework entry.
  const app = createMcpExpressApp({ host: "0.0.0.0" });

  app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({
      status: "ok",
      service: "instagram-claude-mcp",
      mode: "read-only",
    });
  });

  // Both RFC 9728 path-specific discovery and the root compatibility endpoint.
  app.get("/.well-known/oauth-protected-resource/mcp", auth.metadata);
  app.get("/.well-known/oauth-protected-resource", auth.metadata);
  app.get("/.well-known/oauth-authorization-server", auth.authorizationServerMetadata);

  // Administrative diagnostics and token exchange are intentionally unavailable.
  app.use([
    "/debug-instagram-auth",
    "/debug-instagram-profile",
    "/debug-instagram-media",
    "/exchange-instagram-token",
  ], (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  app.use("/mcp", auth.requireAuth);

  async function handleMcp(req: Request, res: Response): Promise<void> {
    let client: InstagramClient;
    try {
      client = getInstagramClient();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({ error: message });
      return;
    }

    // Stateless Streamable HTTP: fresh server + transport per request.
    // Compatible with Vercel serverless (no sticky sessions required).
    const server = createInstagramMcpServer(client);
    const transport = new NodeStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP request failed:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }

  app.post("/mcp", (req, res) => {
    void handleMcp(req, res);
  });

  app.get("/mcp", (req, res) => {
    void handleMcp(req, res);
  });

  app.delete("/mcp", (req, res) => {
    void handleMcp(req, res);
  });

  return app;
}

const app = createApp();
export default app;
