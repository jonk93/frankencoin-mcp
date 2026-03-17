#!/usr/bin/env node
/**
 * Frankencoin MCP Server
 *
 * Exposes Frankencoin (ZCHF) protocol data via three interfaces:
 *   - MCP stdio (default): for local Claude Desktop / Cursor / CLI usage
 *   - MCP HTTP  (--http):  POST /mcp  — MCP protocol, for AI agents
 *   - REST API  (--http):  GET  /api/<tool>[?param=value]  — plain JSON, no handshake
 *
 * The REST /api layer is the lightweight "agentic shortcut" — any agent or
 * script can call it with a single HTTP GET, no MCP session required.
 *
 * Usage:
 *   node src/index.js              # stdio mode
 *   node src/index.js --http       # HTTP mode (default port 3000)
 *   PORT=8080 node src/index.js --http
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import http from "http";
import { readFileSync } from "fs";
import { z } from "zod";
import { TOOLS } from "./tools.js";
import * as api from "./api.js";

const { version: SERVER_VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

// ─── Tool registration ────────────────────────────────────────────────────────
// Each session gets its own McpServer instance (required by SDK — one server per transport).
// Tool logic is shared via the api module.

function ok(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(e) {
  return { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true };
}

/**
 * Convert a JSON Schema properties map to a Zod raw shape.
 * The SDK's server.tool() accepts a Zod raw shape (object whose values are
 * Zod schemas). Passing a plain JSON Schema object causes args to be silently
 * dropped — this helper ensures every property becomes a properly typed Zod
 * schema so the SDK can validate and forward arguments correctly.
 */
function jsonPropsToZodShape(properties = {}, required = []) {
  const shape = {};
  for (const [key, prop] of Object.entries(properties)) {
    let schema;
    switch (prop.type) {
      case "number":  schema = z.number(); break;
      case "boolean": schema = z.boolean(); break;
      case "string":
      default:        schema = z.string(); break;
    }
    if (prop.description) schema = schema.describe(prop.description);
    shape[key] = required.includes(key) ? schema : schema.optional();
  }
  return shape;
}

function createServer() {
  const server = new McpServer({ name: "frankencoin", version: SERVER_VERSION });

  for (const tool of TOOLS) {
    // Convert JSON Schema properties to a Zod raw shape. Passing a plain
    // JSON Schema (type/properties/required) to server.tool() causes the SDK
    // to silently ignore it because it's not recognised as a Zod object —
    // args then arrive as {} in the callback, breaking any tool with params.
    const zodShape = jsonPropsToZodShape(
      tool.inputSchema.properties || {},
      tool.inputSchema.required || [],
    );
    server.tool(tool.name, tool.description, zodShape, async (args) => {
      try {
        switch (tool.name) {
          case "get_protocol_summary":    return ok(await api.getProtocolSummary());
          case "get_protocol_info":       return ok(await api.getProtocolInfo());
          case "get_fps_info":            return ok(await api.getFpsInfo());
          case "get_prices":              return ok(await api.getPrices());
          case "get_savings_rates":       return ok(await api.getSavingsRates());
          case "get_savings_stats":       return ok(await api.getSavingsStats());
          case "get_collaterals":         return ok(await api.getCollaterals());
          case "get_challenges":
            return ok(await api.getChallenges({
              limit: Math.min(args.limit ?? 20, 100),
              activeOnly: args.active_only ?? false,
            }));
          case "get_positions":
            return ok(await api.getPositions({ limit: args.limit ?? 50 }));
          case "get_positions_detail":
            return ok(await api.getPositionsDetail({
              limit: Math.min(args.limit ?? 20, 100),
              activeOnly: args.active_only ?? true,
              collateral: args.collateral ?? null,
            }));
          case "get_analytics":
            return ok(await api.getAnalytics({ days: Math.min(args.days ?? 30, 365) }));
          case "get_equity_trades":
            return ok(await api.getEquityTrades({ limit: Math.min(args.limit ?? 20, 100) }));
          case "get_minters":
            return ok(await api.getMinters({ limit: args.limit ?? 20 }));
          case "get_historical":
            return ok(await api.getHistorical({ days: Math.min(args.days ?? 90, 365) }));
          case "get_market_context":      return ok(await api.getMarketContext());
          case "get_chf_stablecoins":     return ok(await api.getChfStablecoins());
          case "get_dune_stats":          return ok(await api.getDuneStats());
          case "get_merch":               return ok(await api.getMerch());
          case "get_token_addresses":     return ok(await api.getTokenAddresses());
          case "get_links":               return ok(await api.getLinks());
          case "get_docs":                return ok(await api.getDocs({ section: args.section ?? "overview" }));
          case "get_media_and_use_cases": return ok(await api.getMediaAndUseCases());
          case "query_ponder":
            if (!args.query) return err(new Error("query parameter required"));
            return ok(await api.runPonderQuery(args.query));
          default:
            return err(new Error(`Unknown tool: ${tool.name}`));
        }
      } catch (e) {
        return err(e);
      }
    });
  }

  return server;
}

// ─── Transport ────────────────────────────────────────────────────────────────

const useHttp = process.argv.includes("--http");
const PORT = parseInt(process.env.PORT || "3000", 10);

if (!useHttp) {
  // ── stdio mode — Claude Desktop / Cursor / CLI ──
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Frankencoin MCP server running on stdio");

} else {
  // ── HTTP mode — public deployment ──
  // Each session gets its own (server, transport) pair.
  // Map: sessionId → { server, transport }
  const sessions = new Map();

  // SSE sessions (legacy): keyed by a synthetic ID we manage
  const sseSessions = new Map();

  // Init lock: prevents a burst of concurrent sessionless requests from each
  // spawning their own (server, transport) pair before any one of them has
  // finished the MCP initialize handshake. Without this, 14 simultaneous cold
  // calls all "win" the new-session branch, the SDK sees multiple concurrent
  // initialize calls on the same transport handle, and the server gets stuck
  // in an uninitialized state.
  //
  // Strategy: only one request may run the initialize path at a time.
  // All other concurrent sessionless requests wait for it to complete, then
  // they re-check sessions for an active session to route to. If none exists
  // (e.g. it was a stateless/single-request session), they respond with a
  // 503 Retry-After so the client knows to re-issue the initialize.
  let initLockPromise = null;

  const httpServer = http.createServer(async (req, res) => {
    // CORS — fully open, read-only public API
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, mcp-session-id");
    res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ── Health / root ──────────────────────────────────────────────────────
    if (url.pathname === "/" || url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        server: "frankencoin-mcp",
        version: SERVER_VERSION,
        description: "Frankencoin (ZCHF) protocol data server",
        interfaces: {
          mcp:  "POST /mcp  — MCP protocol (AI agents, Claude Desktop, Cursor)",
          rest: "GET  /api/<tool>  — plain JSON REST, no handshake (curl, fetch, scripts)",
          sse:  "GET  /sse  — legacy SSE transport (older clients)",
        },
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        activeSessions: sessions.size,
        docs: "https://github.com/Frankencoin-ZCHF/frankencoin-mcp",
      }, null, 2));
      return;
    }

    // ── REST API  (/api/<tool>) ────────────────────────────────────────────
    // Stateless, no handshake. Any GET returns JSON directly.
    // Params passed as query string: /api/get_challenges?limit=10&active_only=true
    // POST also accepted: body is JSON object of params.
    //
    // GET /api            → list all tools with descriptions and param schemas
    // GET /api/<tool>     → call tool with optional query params
    // POST /api/<tool>    → call tool with JSON body params
    //
    // Response: { ok: true, tool: "...", result: <data> }
    //        or { ok: false, tool: "...", error: "..." }
    if (url.pathname === "/api" || url.pathname === "/api/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        description: "Frankencoin REST API — call any tool with a single GET, no MCP session required.",
        usage: "GET https://mcp.frankencoin.com/api/<tool>[?param=value&...]",
        examples: [
          "GET /api/get_protocol_summary",
          "GET /api/get_prices",
          "GET /api/get_positions_detail?limit=10&active_only=true",
          "GET /api/get_challenges?active_only=true",
          "GET /api/get_historical?days=30",
          "GET /api/get_docs?section=savings",
          "POST /api/query_ponder  body: {\"query\": \"{ analyticDailyLogs(limit:3) { items { totalSupply date } } }\"}",
        ],
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          params: Object.entries(t.inputSchema.properties || {}).map(([k, v]) => ({
            name: k,
            type: v.type,
            required: (t.inputSchema.required || []).includes(k),
            description: v.description,
          })),
          url: `GET /api/${t.name}`,
        })),
      }, null, 2));
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      const toolName = url.pathname.slice(5); // strip /api/
      const toolDef = TOOLS.find((t) => t.name === toolName);

      if (!toolDef) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          ok: false,
          error: `Unknown tool: ${toolName}`,
          available: TOOLS.map((t) => t.name),
        }));
        return;
      }

      // Parse params: query string for GET, JSON body for POST
      let params = {};
      if (req.method === "POST" || req.method === "PUT") {
        try {
          const body = await new Promise((resolve, reject) => {
            let buf = "";
            req.on("data", (d) => { buf += d; });
            req.on("end", () => resolve(buf));
            req.on("error", reject);
          });
          if (body.trim()) params = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, tool: toolName, error: "Invalid JSON body" }));
          return;
        }
      } else {
        // GET: coerce query string values to the right types per tool schema
        for (const [k, v] of url.searchParams.entries()) {
          const propDef = toolDef.inputSchema.properties?.[k];
          if (propDef?.type === "number") params[k] = Number(v);
          else if (propDef?.type === "boolean") params[k] = v === "true" || v === "1";
          else params[k] = v;
        }
      }

      try {
        let result;
        switch (toolName) {
          case "get_protocol_summary":    result = await api.getProtocolSummary(); break;
          case "get_protocol_info":       result = await api.getProtocolInfo(); break;
          case "get_fps_info":            result = await api.getFpsInfo(); break;
          case "get_prices":              result = await api.getPrices(); break;
          case "get_savings_rates":       result = await api.getSavingsRates(); break;
          case "get_savings_stats":       result = await api.getSavingsStats(); break;
          case "get_collaterals":         result = await api.getCollaterals(); break;
          case "get_challenges":
            result = await api.getChallenges({
              limit: Math.min(params.limit ?? 20, 100),
              activeOnly: params.active_only ?? false,
            }); break;
          case "get_positions":
            result = await api.getPositions({ limit: params.limit ?? 50 }); break;
          case "get_positions_detail":
            result = await api.getPositionsDetail({
              limit: Math.min(params.limit ?? 20, 100),
              activeOnly: params.active_only ?? true,
              collateral: params.collateral ?? null,
            }); break;
          case "get_analytics":
            result = await api.getAnalytics({ days: Math.min(params.days ?? 30, 365) }); break;
          case "get_equity_trades":
            result = await api.getEquityTrades({ limit: Math.min(params.limit ?? 20, 100) }); break;
          case "get_minters":
            result = await api.getMinters({ limit: params.limit ?? 20 }); break;
          case "get_historical":
            result = await api.getHistorical({ days: Math.min(params.days ?? 90, 365) }); break;
          case "get_market_context":      result = await api.getMarketContext(); break;
          case "get_chf_stablecoins":     result = await api.getChfStablecoins(); break;
          case "get_dune_stats":          result = await api.getDuneStats(); break;
          case "get_merch":               result = await api.getMerch(); break;
          case "get_token_addresses":     result = await api.getTokenAddresses(); break;
          case "get_links":               result = await api.getLinks(); break;
          case "get_docs":
            result = await api.getDocs({ section: params.section ?? "overview" }); break;
          case "get_media_and_use_cases": result = await api.getMediaAndUseCases(); break;
          case "query_ponder":
            if (!params.query) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ ok: false, tool: toolName, error: "query param required" }));
              return;
            }
            result = await api.runPonderQuery(params.query); break;
          default:
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: `No handler for tool: ${toolName}` }));
            return;
        }
        console.error(`[/api/${toolName}] ok`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, tool: toolName, result }, null, 2));
      } catch (e) {
        console.error(`[/api/${toolName}] error: ${e.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, tool: toolName, error: e.message }));
      }
      return;
    }

    // ── Streamable HTTP  (/mcp) ────────────────────────────────────────────
    if (url.pathname === "/mcp") {
      try {
        if (req.method === "POST") {
          const sessionId = req.headers["mcp-session-id"];

          // Existing known session
          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res);
            return;
          }

          // Stale session ID (server restarted, session expired) — reject cleanly
          // with 404 so the client knows to re-initialize rather than getting
          // the confusing "Server not initialized" error from the SDK
          if (sessionId && !sessions.has(sessionId)) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32001, message: "Session not found — please re-initialize" },
              id: null,
            }));
            return;
          }

          // New session (no session ID = first request, must be initialize).
          // Guard: only one initialization may run at a time. Concurrent
          // sessionless requests queue behind the lock. After the lock resolves,
          // they retry the session lookup — if a session was created they can
          // use it; otherwise they return 503 so the client retries.
          if (initLockPromise) {
            // Another initialization is in flight — wait for it, then re-check
            await initLockPromise.catch(() => {});
            // If there's now at least one session, tell the client to re-init
            // (they need to send a proper initialize with the new session ID)
            if (sessions.size > 0) {
              res.writeHead(503, {
                "Content-Type": "application/json",
                "Retry-After": "1",
              });
              res.end(JSON.stringify({
                jsonrpc: "2.0",
                error: {
                  code: -32000,
                  message: "Server initializing — please retry initialize",
                },
                id: null,
              }));
              return;
            }
            // No session yet (e.g. previous init failed) — fall through and try again
          }

          let resolveLock, rejectLock;
          initLockPromise = new Promise((res, rej) => { resolveLock = res; rejectLock = rej; });

          try {
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => crypto.randomUUID(),
              onsessioninitialized: (id) => {
                sessions.set(id, { server: mcpServer, transport });
                console.error(`[session] new: ${id} (total: ${sessions.size})`);
              },
            });
            transport.onclose = () => {
              if (transport.sessionId) {
                sessions.delete(transport.sessionId);
                console.error(`[session] closed: ${transport.sessionId} (total: ${sessions.size})`);
              }
            };
            const mcpServer = createServer();
            await mcpServer.connect(transport);
            await transport.handleRequest(req, res);
            resolveLock();
          } catch (initErr) {
            rejectLock(initErr);
            throw initErr;
          } finally {
            // Clear lock so future new-session requests don't queue indefinitely
            initLockPromise = null;
          }
          return;
        }

        if (req.method === "GET") {
          const sessionId = req.headers["mcp-session-id"];
          if (!sessionId || !sessions.has(sessionId)) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing or invalid mcp-session-id" }));
            return;
          }
          const { transport } = sessions.get(sessionId);
          await transport.handleRequest(req, res);
          return;
        }

        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"];
          if (sessionId && sessions.has(sessionId)) {
            const { transport } = sessions.get(sessionId);
            await transport.handleRequest(req, res);
            sessions.delete(sessionId);
          } else {
            res.writeHead(200); res.end();
          }
          return;
        }

        res.writeHead(405, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Method not allowed" }));

      } catch (e) {
        console.error("[/mcp error]", e.message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      }
      return;
    }

    // ── SSE  (/sse + /messages) ────────────────────────────────────────────
    // Legacy transport for older clients. Each GET /sse creates a session.
    if (url.pathname === "/sse") {
      if (req.method !== "GET") {
        res.writeHead(405); res.end(); return;
      }
      const sseId = crypto.randomUUID();
      const transport = new SSEServerTransport(`/messages?sessionId=${sseId}`, res);
      const mcpServer = createServer();
      sseSessions.set(sseId, { server: mcpServer, transport });
      transport.onclose = () => sseSessions.delete(sseId);
      await mcpServer.connect(transport);
      // res stays open (SSE stream)
      return;
    }

    if (url.pathname === "/messages") {
      if (req.method !== "POST") {
        res.writeHead(405); res.end(); return;
      }
      const sseId = url.searchParams.get("sessionId");
      if (!sseId || !sseSessions.has(sseId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unknown sessionId — connect via GET /sse first" }));
        return;
      }
      const { transport } = sseSessions.get(sseId);
      await transport.handlePostMessage(req, res);
      return;
    }

    // ── 404 ───────────────────────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/api", "/sse", "/health"] }));
  });

  httpServer.listen(PORT, () => {
    console.error(`Frankencoin MCP server listening on port ${PORT}`);
    console.error(`  MCP (streamable): http://localhost:${PORT}/mcp`);
    console.error(`  REST API        : http://localhost:${PORT}/api/<tool>`);
    console.error(`  SSE (legacy)    : http://localhost:${PORT}/sse`);
    console.error(`  Health          : http://localhost:${PORT}/health`);
  });
}
