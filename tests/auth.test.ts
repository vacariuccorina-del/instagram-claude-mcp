import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import { once } from "node:events";
import { customFetch, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createApp } from "../src/app.js";
import { createWorkosAuth } from "../src/auth.js";
import { loadAuthConfig } from "../src/config.js";

const issuer = "https://test.authkit.app";
const resource = "https://instagram.example.com/mcp";
const signingKey = await generateKeyPair("RS256");
const otherKey = await generateKeyPair("RS256");
const publicKey = { ...await exportJWK(signingKey.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
const servers: Server[] = [];
let base: string;
let keyRequests = 0;

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  servers.push(server);
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function token(claims: Record<string, unknown> = {}, key = signingKey.privateKey) {
  return new SignJWT({
    iss: issuer, aud: resource, sub: "user_test", exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  }).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(key);
}

const initBody = {
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "auth-test", version: "1" } },
};
async function mcp(bearer?: string, origin = base, body = initBody) {
  return fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Accept: "application/json, text/event-stream",
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

before(async () => {
  // Initialize/list tools never calls Instagram; these placeholders only satisfy config.
  process.env.INSTAGRAM_ACCESS_TOKEN = "test-placeholder-not-a-real-token";
  process.env.INSTAGRAM_GRAPH_API_BASE = "https://graph.instagram.com";
  process.env.MCP_AUTH_TOKEN = "legacy-token-must-not-work";
  base = await listen(createApp({ auth: createWorkosAuth(() => ({ issuer, resource }), {
    [customFetch]: async (url) => {
      assert.equal(String(url), `${issuer}/oauth2/jwks`);
      keyRequests++;
      return new Response(JSON.stringify({ keys: [publicKey] }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    },
  }) }));
});
after(async () => {
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

test("health and both metadata endpoints are public and use configured origins", async () => {
  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "instagram-claude-mcp", mode: "read-only" });
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    const res = await fetch(base + path, { headers: { "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http" } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"] });
  }
});

test("every MCP transport method requires a header token and advertises discovery", async () => {
  for (const method of ["GET", "POST", "DELETE", "HEAD"]) {
    const res = await fetch(`${base}/mcp`, { method });
    assert.equal(res.status, 401, method);
    assert.equal(res.headers.get("WWW-Authenticate"), 'Bearer resource_metadata="https://instagram.example.com/.well-known/oauth-protected-resource/mcp"');
  }
  const query = await fetch(`${base}/mcp?access_token=${await token()}`);
  assert.equal(query.status, 401);
  const legacy = await mcp("legacy-token-must-not-work");
  assert.equal(legacy.status, 401);
});

test("valid token reaches unchanged MCP initialization and keys are cached", async () => {
  for (let i = 0; i < 2; i++) {
    const res = await mcp(await token());
    assert.equal(res.status, 200, await res.clone().text());
    assert.match(await res.text(), /instagram-claude-mcp/);
  }
  assert.equal(keyRequests, 1);
});

test("invalid signature, issuer, audience, times and missing claims are rejected", async () => {
  const cases = [
    await token({}, otherKey.privateKey),
    await token({ iss: "https://attacker.example" }),
    await token({ aud: "https://another.example/mcp" }),
    await token({ aud: "client_environment_default" }),
    await token({ exp: Math.floor(Date.now() / 1000) - 60 }),
    await token({ nbf: Math.floor(Date.now() / 1000) + 300 }),
    await token({ exp: undefined }),
    await token({ iss: undefined }),
    await token({ aud: undefined }),
    await token({ sub: undefined }),
    await token({ sub: "" }),
    "not-a-jwt",
    await new SignJWT({ iss: issuer, aud: resource, sub: "test", exp: 9999999999 })
      .setProtectedHeader({ alg: "HS256" }).sign(new TextEncoder().encode("a-test-secret-with-at-least-32-bytes")),
  ];
  for (const badToken of cases) {
    const res = await mcp(badToken);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("WWW-Authenticate")!, /error="invalid_token"/);
    assert.deepEqual(await res.json(), { error: "Invalid access token" });
  }
});

test("disabled endpoints stay unavailable even with a valid token", async () => {
  for (const path of ["/debug-instagram-auth", "/debug-instagram-profile", "/debug-instagram-media", "/exchange-instagram-token"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const headers of [new Headers(), new Headers({ Authorization: `Bearer ${await token()}` })]) {
        const res = await fetch(base + path, { method, headers });
        assert.equal(res.status, 404, `${method} ${path}`);
        assert.deepEqual(await res.json(), { error: "Not found" });
      }
    }
  }
});

test("missing OAuth configuration fails closed without affecting health", async () => {
  const origin = await listen(createApp({ auth: createWorkosAuth(() => { throw new Error("private configuration details"); }) }));
  assert.equal((await fetch(`${origin}/health`)).status, 200);
  for (const path of ["/mcp", "/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
    const res = await fetch(origin + path);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: "OAuth is not configured." });
  }
});

test("JWKS outage denies access", async () => {
  const origin = await listen(createApp({ auth: createWorkosAuth(() => ({ issuer, resource }), {
    [customFetch]: async () => { throw new Error("offline"); },
  }) }));
  assert.equal((await mcp(await token(), origin)).status, 401);
});

test("public authorization-server proxy preserves AuthKit metadata and isolates the upstream request", async () => {
  const document = {
    issuer, authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`, jwks_uri: `${issuer}/oauth2/jwks`,
    client_id_metadata_document_supported: true,
    code_challenge_methods_supported: ["S256"], extension: { preserved: true },
  };
  let calls = 0;
  const origin = await listen(createApp({ auth: createWorkosAuth(() => ({ issuer, resource }), {},
    async (url, options) => {
      calls++;
      assert.equal(url, `${issuer}/.well-known/oauth-authorization-server`);
      assert.deepEqual(options?.headers, { Accept: "application/json" });
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal instanceof AbortSignal);
      return Response.json(document);
    },
  ) }));
  for (const headers of [new Headers(), new Headers({
    Authorization: "Bearer do-not-forward", Cookie: "session=do-not-forward",
    "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "http",
  })]) {
    const res = await fetch(`${origin}/.well-known/oauth-authorization-server?issuer=https://attacker.example`, { headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("WWW-Authenticate"), null);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await res.json(), document);
  }
  assert.equal(calls, 2);
  assert.equal((await fetch(`${origin}/mcp`)).status, 401);
  assert.equal((await fetch(`${origin}/exchange-instagram-token`, { method: "POST" })).status, 404);
});

test("authorization-server proxy returns sanitized errors for upstream failures", async () => {
  const failures: Array<() => Promise<Response>> = [
    async () => new Response("private upstream error", { status: 500 }),
    async () => new Response("not JSON"),
    async () => Response.json(null),
    async () => Response.json([]),
    async () => Response.json({ issuer: "https://attacker.example" }),
    async () => Response.json({}),
    async () => { throw new Error("private network details"); },
    async () => { throw new DOMException("timed out", "TimeoutError"); },
    async () => new Response(null, { status: 302, headers: { Location: "https://attacker.example" } }),
  ];
  for (const fail of failures) {
    const origin = await listen(createApp({ auth: createWorkosAuth(() => ({ issuer, resource }), {}, fail) }));
    const res = await fetch(`${origin}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 502);
    assert.deepEqual(await res.json(), { error: "Authorization server metadata unavailable." });
  }
});

test("OAuth environment validation rejects unsafe or mismatched URLs", () => {
  const oldIssuer = process.env.WORKOS_AUTHKIT_ISSUER;
  const oldResource = process.env.MCP_RESOURCE_URL;
  try {
    for (const [inputIssuer, inputResource] of [
      ["", resource], [issuer, ""], ["http://test.authkit.app", resource],
      [`${issuer}/other`, resource], [issuer, "https://instagram.example.com/"],
      [issuer, `${resource}/`], [issuer, `${resource}?token=x`],
      [issuer, "http://instagram.example.com/mcp"],
      ["https://user:password@test.authkit.app", resource],
      [issuer, `${resource}#fragment`],
    ]) {
      process.env.WORKOS_AUTHKIT_ISSUER = inputIssuer;
      process.env.MCP_RESOURCE_URL = inputResource;
      assert.throws(() => loadAuthConfig());
    }
    process.env.WORKOS_AUTHKIT_ISSUER = issuer;
    process.env.MCP_RESOURCE_URL = resource;
    assert.deepEqual(loadAuthConfig(), { issuer, resource });
    process.env.MCP_RESOURCE_URL = "http://localhost:3000/mcp";
    assert.equal(loadAuthConfig().resource, "http://localhost:3000/mcp");
  } finally {
    if (oldIssuer === undefined) delete process.env.WORKOS_AUTHKIT_ISSUER;
    else process.env.WORKOS_AUTHKIT_ISSUER = oldIssuer;
    if (oldResource === undefined) delete process.env.MCP_RESOURCE_URL;
    else process.env.MCP_RESOURCE_URL = oldResource;
  }
});
