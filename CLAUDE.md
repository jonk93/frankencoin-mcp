# CLAUDE.md — Frankencoin MCP Server

## Project overview

This is the Frankencoin MCP server — a Model Context Protocol server that exposes real-time Frankencoin (ZCHF) protocol data as tools for AI assistants and developer tools.

**Stack:** Node.js ESM, `@modelcontextprotocol/sdk`, no build step (runs directly)  
**Entrypoint:** `src/index.js`  
**Data layer:** `src/api.js`  
**Tool definitions:** `src/tools.js`

---

## Architecture

```
src/
  index.js          — HTTP server + stdio transport, session management, tool dispatch
  tools.js          — MCP tool definitions (name, description, inputSchema)
  api.js            — Barrel re-export of all api/ modules
  api/
    helpers.js      — Shared constants, fetch helpers (apiFetch, ponderQuery, cgFetch, ethCall, githubFile), number utils (fromWei, bpsToPercent, ppmToPercent)
    protocol.js     — ZCHF info, FPS, prices, savings rates/stats, collaterals
    positions.js    — Positions + challenges (with CoinGecko enrichment)
    analytics.js    — Analytics, historical data, equity trades, minters, Dune stats
    market.js       — Market context, CHF stablecoin comparison (ZCHF/VCHF/CHFAU)
    content.js      — Docs, links, token addresses, media, merch
    summary.js      — High-level protocol summary (composes protocol + savings + challenges)
```

### Key design decisions

**One McpServer instance per session.** The SDK's `McpServer` is stateful and can only connect to one transport at a time. For HTTP mode, `createServer()` is called per incoming session, not once globally. This is intentional — do not refactor to a shared singleton.

**Two transports:**
- `POST /mcp` — Streamable HTTP (MCP spec 2024-11-05), recommended for all modern clients
- `GET /sse` + `POST /messages?sessionId=` — Legacy SSE for older clients (Claude Desktop pre-Nov 2024)

**No auth.** This is a public read-only API. Do not add auth unless explicitly requested.

**No build step.** Node.js ESM with `"type": "module"` in package.json. No TypeScript, no bundler. Keep it that way unless the project grows significantly.

---

## Running

```bash
# stdio mode (local Claude Desktop / Cursor)
node src/index.js

# HTTP mode (public server)
node src/index.js --http

# Custom port
PORT=8080 node src/index.js --http
```

Health check: `curl http://localhost:3000/health`

---

## Data sources

### REST: `api.frankencoin.com`

No auth. All endpoints return JSON.

| Endpoint | Function in api.js |
|----------|-------------------|
| `/ecosystem/frankencoin/info` | `getProtocolInfo()` |
| `/ecosystem/fps/info` | `getFpsInfo()` |
| `/prices/list` | `getPrices()` |
| `/savings/leadrate/info` | `getSavingsRates()` |
| `/savings/core/info` | `getSavingsStats()` |
| `/ecosystem/collateral/list` | `getCollaterals()` |
| `/challenges/list` | `getChallenges()` |
| `/positions/open` | `getPositions()` |

### GraphQL: `ponder.frankencoin.com`

POST with `{ query: "..." }`. No auth.

Key entities and their primary keys:

| Entity | Key field | Notes |
|--------|-----------|-------|
| `mintingHubV2PositionV2s` | `position` | Active ZCHF positions (use this, not V1) |
| `mintingHubV1PositionV1s` | `position` | Legacy positions |
| `mintingHubV2ChallengeV2s` | - | Active liquidation challenges |
| `analyticDailyLogs` | `date` | Daily protocol metrics, order by `timestamp desc` |
| `equityTrades` | `id` | FPS buy/sell trades |
| `savingsActivity` | - | Per-address savings history |
| `frankencoinMinters` | `minter` | Approved minting contracts |
| `eRC20Balances` | - | Token holder balances |

**Important:** Ponder entities do NOT have an `id` field — use the entity-specific primary key (e.g. `position`, `minter`, `date`). Querying `id` returns a validation error.

**Pagination:** All list queries support `limit`, `orderBy`, `orderDirection`, and `where`. Results come back as `{ items: [...], pageInfo: { hasNextPage, endCursor } }`.

### Number encoding

- All token amounts from Ponder come as BigInt strings (e.g. `"27195555478609416088678148"`)
- Use `fromWei(val, decimals)` in `api.js` to convert to float
- Savings rates: stored as basis points × 10 (37500 = 3.75%) — use `bpsToPercent()`
- Risk premiums: stored in PPM (parts per million) — use `ppmToPercent()`

---

## Adding a new tool

1. Add the tool definition to `src/tools.js` (name, description, inputSchema)
2. Add the API function to the appropriate `src/api/*.js` module (or create a new one)
3. Re-export it from `src/api.js`
4. Add the case to the switch in `createServer()` in `src/index.js`

That's it. No registration elsewhere needed.

---

## Common gotchas

**Ponder response format is SSE-wrapped.** When testing with curl, responses come as:
```
event: message
data: {"jsonrpc":"2.0","result":{...},"id":1}
```
Parse with `grep '^data:' | sed 's/^data: //'`.

**Savings modules on Ethereum:** There are two — the savings rate module (`0x27d9...`, ~3.75%) and the base/pending rate module (`0x3bf3...`, ~1%). L2s have one each. When showing "the" savings rate, use the max (savings module).

**Chain IDs:**
```
1=Ethereum, 10=Optimism, 100=Gnosis, 137=Polygon,
146=Sonic, 8453=Base, 42161=Arbitrum, 43114=Avalanche
```

**ZCHF contract addresses:**
- Ethereum: `0xb58e61c3098d85632df34eecfb899a1ed80921cb`
- All other chains: `0xd4dd9e2f021bb459d5a5f6c24c12fe09c5d45553`

**FPS contract:** Ethereum only — `0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2`

---

## Testing

No test framework configured. For manual testing:

```bash
# Start server
node src/index.js --http &

# Initialize session
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  -D /tmp/h.txt -o /tmp/r.txt

SESSION=$(grep -i "^mcp-session-id:" /tmp/h.txt | awk '{print $2}' | tr -d '\r')

# List tools
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | grep '^data:' | sed 's/^data: //' | python3 -c "import sys,json; d=json.load(sys.stdin); [print(t['name']) for t in d['result']['tools']]"

# Call a tool
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "mcp-session-id: $SESSION" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_protocol_summary","arguments":{}}}' \
  | grep '^data:' | sed 's/^data: //' | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['result']['content'][0]['text'])"
```

---

## Deployment

Target: `mcp.frankencoin.com` (managed by Frankencoin Association)

See README.md for systemd service and nginx config.

The server is stateless between restarts — no database, no persistent state. Safe to restart at any time.
