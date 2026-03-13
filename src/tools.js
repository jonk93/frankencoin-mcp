/**
 * MCP tool definitions for the Frankencoin MCP server
 */

import { z } from "zod";

export const TOOLS = [
  {
    name: "get_protocol_summary",
    description:
      "Get a comprehensive snapshot of the Frankencoin (ZCHF) protocol — total supply, price, TVL, FPS market cap and reserve, savings rate, and any active challenges. Best starting point for any protocol question.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_protocol_info",
    description:
      "Get detailed ZCHF supply breakdown by chain (Ethereum, Base, Gnosis, Arbitrum, Optimism, Polygon, Avalanche, Sonic), total TVL in CHF and USD, FPS price and market cap.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_fps_info",
    description:
      "Get Frankencoin Pool Share (FPS) governance token details — price, total supply, market cap, equity reserve, minter reserve, cumulative profit and loss.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_prices",
    description:
      "Get current prices in CHF and USD for all tokens in the Frankencoin ecosystem — ZCHF, FPS, and all accepted collateral tokens (WETH, WBTC, LsETH, etc.).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_savings_rates",
    description:
      "Get current approved savings/lead rates and any pending rate proposals across all chains. Ethereum has two modules: the savings rate module (0x27d9ad987bde08a0d083ef7e0e4043c857a17b38, ~3.75% — this is the svZCHF savings rate that depositors earn) and the base rate module (0x3bf301b0e2003e75a3e86ab82bd1eff6a9dfb2ae, ~1% — the protocol base rate). L2s have one module each at 3.75%.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_savings_stats",
    description:
      "Get savings module statistics — total ZCHF deposited, total interest paid out, total withdrawals, and event counts per module per chain.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_collaterals",
    description:
      "List all accepted collateral types in the Frankencoin protocol — token names, symbols, addresses, and which chain they're on.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_challenges",
    description:
      "List liquidation challenges against collateral positions. Returns challenge status, size, bids, and timing.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of challenges to return (default: 20, max: 100)",
        },
        active_only: {
          type: "boolean",
          description: "If true, return only challenges that are still active/open (default: false)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_positions",
    description:
      "Get the list of open ZCHF minting position addresses. Returns addresses and total count. Use get_positions_detail for full position data.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of position addresses to return (default: 50)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_positions_detail",
    description:
      "Get detailed on-chain data for ZCHF collateral positions — collateral type and balance, amount minted, available capacity, liquidation price, risk premium, expiry, cooldown status. Sourced from on-chain indexer.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of positions to return (default: 20, max: 100)",
        },
        active_only: {
          type: "boolean",
          description: "If true, exclude closed and denied positions (default: true)",
        },
        collateral: {
          type: "string",
          description: "Filter by collateral token address (optional, e.g. 0x2260FAC5... for WBTC)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_analytics",
    description:
      "Get daily historical analytics for the Frankencoin protocol — supply, equity reserve, savings balance, FPS price, earnings per FPS, and interest rates. Returns data for the last N days.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days of history to return (default: 30, max: 365)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_equity_trades",
    description:
      "Get recent FPS (Frankencoin Pool Share) buy/sell trades — buyer, seller, shares traded, price per share in CHF, total value, and timestamps.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of recent trades to return (default: 20, max: 100)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_minters",
    description:
      "List approved and historical minter contracts — addresses that are authorized to mint ZCHF. Includes application fee paid, application date, and whether the minter is currently active. Key contracts on Ethereum: Minting Hub V1 (0x7546762fdb1a6d9146b33960545c3f6394265219, CDP minting for V1 positions) and Minting Hub V2 (0xde12b620a8a714476a97efd14e6f7180ca653557, CDP minting for V2 positions). Note: savings modules are separate contracts — see get_savings_rates.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Number of minters to return (default: 20)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_historical",
    description:
      "Get historical time-series data for the Frankencoin protocol. Returns daily snapshots with: FPS price and market cap in CHF, ZCHF total supply, equity reserve, savings TVL, interest rates, annual earnings, and FPS earnings per share. Also includes the full rate change governance history. Note: Minting Hub V1 = CDP positions V1; Minting Hub V2 = CDP positions V2; savings rate (svZCHF, ~3.75%) and base rate (~1%) are governed by separate savings modules. Data available from October 2023.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days of history to return (default: 90, max: 365)",
        },
      },
      required: [],
    },
  },
  {
    name: "get_market_context",
    description:
      "Get live CoinGecko market data for the Frankencoin ecosystem — ZCHF peg health (deviation from 1 CHF), FPS 24h price change and volume, plus macro context (BTC, ETH, wstETH, WBTC prices and 24h changes). Useful for monitoring peg stability and market conditions.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_dune_stats",
    description:
      "Get on-chain analytics from Dune Analytics — ZCHF holder count, FPS holder count, historical minting volume, and savings TVL over time. Data may be slightly delayed vs real-time.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_merch",
    description:
      "Get all products from the Frankencoin merch store (merch.frankencoin.com) — titles, prices, variants (sizes/colors), availability, images, and direct product URLs. Live data, no caching.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_token_addresses",
    description:
      "Get the official contract addresses for all Frankencoin tokens across all supported chains — ZCHF (stablecoin), FPS (governance token), and svZCHF (savings vault). Includes explorer links. Sourced live from the Frankencoin website repository so always up to date.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_links",
    description:
      "Get all key Frankencoin links in one place — app sections (mint, savings, equity, governance, bridge), website, docs, whitepaper, GitHub, social channels (Telegram, Twitter, forum), exchanges and on-ramps, and use case highlights. Sourced live from the website repository.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_docs",
    description:
      "Fetch a section of the official Frankencoin documentation directly from the gitbook repository — always the latest version. Available sections: overview, savings, pool_shares, governance, reserve, risks, faq, minting, opening_positions, auctions, api.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          description:
            "Which documentation section to fetch. One of: overview, savings, pool_shares, governance, reserve, risks, faq, minting, opening_positions, auctions, api. Defaults to overview.",
        },
      },
      required: [],
    },
  },
  {
    name: "get_media_and_use_cases",
    description:
      "Get Frankencoin media coverage (press articles and videos with titles, descriptions, dates, and sources) plus real-world use cases (retail, DeFi, business integrations) and ecosystem partners. Sourced live from the Frankencoin website repository.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "query_ponder",
    description:
      "Execute a raw GraphQL query against the Frankencoin on-chain indexer at ponder.frankencoin.com. Use for advanced queries not covered by other tools. Available entities include: mintingHubV2PositionV2s, mintingHubV1PositionV1s, mintingHubV2ChallengeV2s, mintingHubV1ChallengeV1s, equityTrades, analyticDailyLogs, savingsActivity, savingsMappings, frankencoinMinters, eRC20Balances, eRC20TotalSupplys, leadrateRateChangeds, frankencoinProfitLosss, equityTradeCharts.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "GraphQL query string (without the outer `query` keyword for simple queries, e.g. `{ mintingHubV2PositionV2s(limit:5) { items { position owner minted } } }`)",
        },
      },
      required: ["query"],
    },
  },
];
