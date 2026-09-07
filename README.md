# instagram-claude-mcp

Remote MCP server that connects Claude to the **official Meta Instagram Graph API** (read-only).

Exposes Instagram profile, media, insights, and comments as MCP tools over **Streamable HTTP**, so Claude can call them via an HTTPS MCP URL.

## Features

| Tool | Description |
|------|-------------|
| `get_instagram_profile` | Connected Instagram professional account profile |
| `list_instagram_media` | Recent posts / reels / carousels |
| `get_instagram_media` | Details for a specific media item |
| `get_instagram_insights` | Account-level or media-level insights |
| `get_instagram_comments` | Comments (and replies when available) on a media item |

**Not implemented (by design):** publishing, deleting, messaging, comment replies, or any write operations.

## Requirements

- Node.js 20+
- An Instagram **professional** account (Business or Creator)
- A Meta app with Instagram Graph API access
- A long-lived access token with read permissions for the account
- The Instagram account ID (`IG User ID`)

## Environment variables

Copy `.env.example` to `.env` and fill in values locally. Never commit `.env`.

| Variable | Required | Description |
|----------|----------|-------------|
| `INSTAGRAM_ACCESS_TOKEN` | Yes | Instagram User access token (prefer long-lived) |
| `INSTAGRAM_ACCOUNT_ID` | Conditional | Optional for Instagram Login (`graph.instagram.com`) — IG ID is resolved from `/me.user_id`. Required for `graph.facebook.com` |
| `INSTAGRAM_GRAPH_API_BASE` | No* | Default `https://graph.facebook.com`. *Use `https://graph.instagram.com` for Instagram Login tokens |
| `INSTAGRAM_API_VERSION` | No | Default `v22.0` |
| `INSTAGRAM_APP_SECRET` | No | App secret — only for short→long-lived token exchange |
| `PORT` | No | HTTP port (default `3000`) |
| `WORKOS_AUTHKIT_ISSUER` | Yes | HTTPS AuthKit origin, matching the WorkOS Connect issuer |
| `MCP_RESOURCE_URL` | Yes | Canonical HTTPS MCP endpoint URL including `/mcp`; must match the WorkOS Resource Indicator |

## Local development

```bash
npm install
cp .env.example .env
# Edit .env with Instagram credentials, WORKOS_AUTHKIT_ISSUER, and MCP_RESOURCE_URL

npm run dev
# or
npm run build && npm start
```

Endpoints:

- Health: `GET http://localhost:3000/health`
- MCP (Streamable HTTP): `http://localhost:3000/mcp`

### Instagram Login `id` vs `user_id`

On `graph.instagram.com`, `GET /me` returns:

- `id` — app-scoped ID (not used for `/media`)
- `user_id` — Instagram professional account ID (`<IG_ID>`) used for `/{user_id}/media`, insights, etc.

This server resolves `user_id` from `/me` for Instagram Login and does **not** blindly trust `INSTAGRAM_ACCOUNT_ID` (which is often mistakenly set to `id`).

### Instagram Login tokens (short vs long-lived)

- **App Dashboard → Generate token**: already **long-lived** (~60 days). Put it in `INSTAGRAM_ACCESS_TOKEN`.
- **OAuth / Business Login** (authorization code → token): returns a **short-lived** token (~1 hour). Exchange it securely outside this server before production use, using Meta’s documented flow. Set the resulting long-lived token in your host’s secret environment variables. `/exchange-instagram-token` is disabled and never returns credentials.

Auth is sent to Meta as its documented `access_token` query parameter. Instagram tokens are trimmed (whitespace, quotes, accidental `Bearer` / `access_token=` prefixes) before use. The diagnostic HTTP endpoints are disabled.

Type-check without running:

```bash
npm run typecheck
```

### Test with MCP Inspector

```bash
npx @modelcontextprotocol/inspector
```

Connect with transport **Streamable HTTP** and URL `http://localhost:3000/mcp`.

## Deploy as a remote MCP server

### Vercel (serverless Express)

This project is set up for Vercel’s Express runtime: the app is **exported as a default Express handler** and only calls `app.listen()` when **not** running on Vercel (`VERCEL=1`). That matches serverless invocation — there is no permanently running Node process in production.

1. Import the GitHub repo in Vercel (or run `vercel`).
2. Set Project Environment Variables (Production/Preview):
   - `INSTAGRAM_ACCESS_TOKEN`
   - `INSTAGRAM_ACCOUNT_ID`
   - `WORKOS_AUTHKIT_ISSUER`, `MCP_RESOURCE_URL`
   - Optional: `INSTAGRAM_GRAPH_API_BASE`, `INSTAGRAM_API_VERSION`
3. Deploy. Endpoints stay the same:
   - `https://your-app.vercel.app/health`
   - `https://your-app.vercel.app/mcp` (Streamable HTTP)

`vercel.json` pins the Express framework, runs `npm run build`, and sets function `maxDuration` to 60s for Graph API calls. MCP handling is **stateless** (fresh transport per request), which is compatible with Vercel Functions / Fluid compute.

Claude connector URL example:

```text
https://your-app.vercel.app/mcp
```

### Other Node hosts (Railway, Render, Fly.io, Cloud Run, etc.)

1. Push this repo and deploy as a normal Node service.
2. Set the same secret environment variables in the host dashboard.
3. The process runs `npm start` → `node dist/index.js`, which listens on `PORT`.

```bash
npm install
npm run build
npm start
```

## Connect from Claude

### Claude (web / desktop connectors)

Add a custom connector with your HTTPS MCP URL, for example:

```text
https://your-service.example.com/mcp
```

Claude discovers AuthKit through OAuth protected resource metadata and prompts you to sign in.

### Claude Code

```bash
claude mcp add --transport http instagram-claude-mcp https://your-service.example.com/mcp
```

### Cursor

Add to `.cursor/mcp.json` (or your MCP config):

```json
{
  "mcpServers": {
    "instagram-claude-mcp": {
      "url": "https://your-service.example.com/mcp"
    }
  }
}
```

## Instagram API notes

- Uses only the official Meta Graph API (`graph.facebook.com` or `graph.instagram.com`).
- Credentials are read from environment variables only — never hardcoded.
- Insights metrics and periods depend on Meta’s current Insights API rules (metric availability differs for account vs media, and by media product type). Pass the metrics Meta documents for your use case via the `metrics` tool argument.
- Tokens expire; rotate long-lived tokens as needed in your host’s secret store.

## Project layout

```text
src/
  app.ts                # Express app factory (/health, /mcp) — default-exported for Vercel
  index.ts              # Entry: export app; listen only when not on Vercel
  config.ts             # Environment configuration
  auth.ts               # WorkOS JWT verification and OAuth resource metadata
  mcp-server.ts         # MCP tool registration
  instagram/client.ts   # Official Graph API client (read-only)
vercel.json             # Vercel Express + function limits
```

## License

MIT

## WorkOS AuthKit OAuth

All requests to `/mcp` require a WorkOS Connect access token in the Authorization Bearer header. There is no static-token or anonymous fallback. Tokens must have an RS256 signature from the configured AuthKit JWKS, the correct issuer, an audience matching `MCP_RESOURCE_URL`, a nonempty subject, and an unexpired expiration claim. Future `nbf` claims are rejected. Signing keys are cached and refreshed by `jose`.

1. In WorkOS, configure AuthKit for the users who should access this Instagram account.
2. Under **Connect → Configuration**, enable **Client ID Metadata Document (CIMD)**. AuthKit handles CIMD, authorization, consent, and token issuance; this server does not host those endpoints. Enable DCR only if an older client requires it.
3. Register the exact HTTPS MCP endpoint (for example, `https://your-service.example.com/mcp`) as a **Resource Indicator**. Set `MCP_RESOURCE_URL` to that same value. You may mark it as the default for clients that omit the resource parameter.
4. Set `WORKOS_AUTHKIT_ISSUER` to the HTTPS AuthKit origin shown by `https://your-domain.authkit.app/.well-known/oauth-authorization-server`. Keys are read from that origin’s `/oauth2/jwks`. No WorkOS API key or client secret is needed for this resource server.
5. After separately reviewing and deploying the changes, add the HTTPS `/mcp` URL as a Claude connector and complete AuthKit sign-in. The metadata resource, token audience, and configured WorkOS Resource Indicator must match exactly, including the path and absence of a trailing slash.

This is a single-account server: every user admitted by your AuthKit configuration who obtains a token for this resource can read the configured Instagram account. Restrict AuthKit access to the intended users; the server does not map users to separate Instagram accounts.

Public discovery is available at `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`. Both return `resource`, `authorization_servers`, and `bearer_methods_supported: ["header"]`. A missing or rejected bearer token receives HTTP 401 with a `WWW-Authenticate` header pointing to the path-specific metadata URL. Metadata uses configured URLs, never untrusted Host or forwarded headers.

`/health` remains public and returns the existing read-only health response. Missing or malformed OAuth configuration produces HTTP 503 on MCP and metadata routes while health remains available in the running app. Local startup still requires the existing Instagram configuration. For local development, `MCP_RESOURCE_URL=http://localhost:3000/mcp` is allowed; the AuthKit issuer must still use HTTPS. Register the local resource separately if testing a real local OAuth flow.

`/debug-instagram-auth`, `/debug-instagram-profile`, `/debug-instagram-media`, and `/exchange-instagram-token` return HTTP 404, even with a valid token. Their underlying Instagram client methods and all five read-only MCP tools are unchanged. The existing MCP POST/GET/DELETE transport handlers remain; these do not add Instagram write operations.

Run `npm test`, `npm run typecheck`, and `npm run build` before deployment. Security tests use generated signing keys and mocked JWKS responses, without real WorkOS or Instagram credentials.

References: [WorkOS MCP guide](https://workos.com/docs/authkit/mcp), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

### Authorization-server discovery compatibility

`GET /.well-known/oauth-authorization-server` is public and proxies the configured AuthKit issuer’s `/.well-known/oauth-authorization-server` JSON document. This supports clients that look for authorization-server discovery directly on the MCP server, following the [WorkOS compatibility guidance](https://workos.com/docs/authkit/mcp#compatibility). AuthKit remains the source of truth: its issuer, OAuth endpoint URLs, CIMD support, and extension fields are preserved.

The proxy forwards no incoming credentials, cookies, query parameters, or host headers. It uses a five-second timeout, rejects redirects, verifies the returned issuer, and returns a generic 502 for upstream failures or invalid metadata. Missing OAuth configuration returns 503. Responses use `Cache-Control: no-store`. MCP token validation and all disabled administrative routes are unchanged.
