/**
 * Frankencoin API client
 * Wraps api.frankencoin.com REST endpoints, ponder.frankencoin.com GraphQL,
 * CoinGecko Pro, and Dune Analytics.
 *
 * API keys are loaded from the server environment — never exposed in tool output.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const API_BASE = "https://api.frankencoin.com";
const PONDER_BASE = "https://ponder.frankencoin.com";
const CG_BASE = "https://pro-api.coingecko.com/api/v3";
const DUNE_BASE = "https://api.dune.com/api/v1";

const CHAIN_NAMES = {
  1: "Ethereum",
  10: "Optimism",
  100: "Gnosis",
  137: "Polygon",
  146: "Sonic",
  8453: "Base",
  42161: "Arbitrum",
  43114: "Avalanche",
};

// ─── API key loading (server-side only, never in output) ──────────────────────

function loadKey(path) {
  try {
    return readFileSync(join(homedir(), path), "utf8").trim();
  } catch {
    return null;
  }
}

const CG_KEY = process.env.COINGECKO_API_KEY || loadKey(".config/coingecko/api_key");
const DUNE_KEY = process.env.DUNE_API_KEY || loadKey(".config/dune/api_key");

// CoinGecko IDs for Frankencoin collateral tokens (verified via contract lookup)
const COINGECKO_IDS = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": "weth",
  "0x8c1bed5b9a0928467c9b1341da1d7bd5e10b6549": "liquid-staked-ethereum",  // LsETH
  "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "wrapped-bitcoin",          // WBTC
  "0x1f9840a85d5af5bf1d1762f925bdaddc4201f984": "uniswap",
  "0x6810e776880c02933d47db1b9fc05908e5386b96": "gnosis",
  "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": "wrapped-steth",            // wstETH
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": "coinbase-wrapped-btc",     // cbBTC
  "0xd533a949740bb3306d119cc777fa900ba034cd52": "curve-dao-token",
  "0x45804880de22913dafe09f4980848ece6ecbaf78": "pax-gold",
  "0x68749665ff8d2d112fa859aa293f07a622782f38": "tether-gold",
  "0x79d4f0232a66c4c91b89c76362016a1707cfbf4f": "vnx-franc",
  "0xfedc5f4a6c38211c1338aa411018dfaf26612c08": "spdr-sp-500-etf-ondo",
  "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a": "apple-tokenized-stock-defichain",
  // FPS (0x1bA26...) is NOT on CoinGecko — use Frankencoin API prices/list instead
};

// Dune query IDs for Frankencoin dashboards
const DUNE_QUERIES = {
  zchfHolders: 6712642,
  fpsHolders: 6712643,
  mintingVolume: 6712644,
  savingsDeposits: 6712645,
  savingsTvl: 6712646,
  liquidations: 6712649,
  positionsOpened: 6712650,
  crossChainSupply: 6712648,
};

// ─── Fetch helpers ────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Frankencoin API error ${res.status}: ${path}`);
  return res.json();
}

async function ponderQuery(query) {
  const res = await fetch(PONDER_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Ponder error ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) throw new Error(json.errors[0].message);
  return json.data;
}

async function cgFetch(path) {
  if (!CG_KEY) throw new Error("CoinGecko API key not configured on server");
  const res = await fetch(`${CG_BASE}${path}`, {
    headers: { "x-cg-pro-api-key": CG_KEY, "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`CoinGecko error ${res.status}`);
  return res.json();
}

async function duneExecute(queryId) {
  if (!DUNE_KEY) throw new Error("Dune API key not configured on server");
  // Trigger execution
  const execRes = await fetch(`${DUNE_BASE}/query/${queryId}/execute`, {
    method: "POST",
    headers: { "x-dune-api-key": DUNE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ performance: "medium" }),
    signal: AbortSignal.timeout(10000),
  });
  if (!execRes.ok) throw new Error(`Dune execute error ${execRes.status}`);
  const { execution_id } = await execRes.json();

  // Poll for results (max 30s)
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2500));
    const statusRes = await fetch(`${DUNE_BASE}/execution/${execution_id}/results`, {
      headers: { "x-dune-api-key": DUNE_KEY },
      signal: AbortSignal.timeout(10000),
    });
    if (!statusRes.ok) continue;
    const data = await statusRes.json();
    if (data.state === "QUERY_STATE_COMPLETED") return data.result?.rows || [];
    if (data.state === "QUERY_STATE_FAILED") throw new Error("Dune query failed");
  }
  throw new Error("Dune query timed out");
}

// ─── Number helpers ───────────────────────────────────────────────────────────

/** Decode BigInt string with given decimals to float */
function fromWei(val, decimals = 18) {
  if (!val || val === "0") return 0;
  return Number(BigInt(val)) / Math.pow(10, decimals);
}

/** Basis points (×10) to percent: 37500 → 3.75 */
function bpsToPercent(bps) { return bps / 10000; }

/** PPM to percent */
function ppmToPercent(ppm) { return ppm / 10000; }

// ─── REST API wrappers ────────────────────────────────────────────────────────

export async function getProtocolInfo() {
  const data = await apiFetch("/ecosystem/frankencoin/info");
  const chains = Object.entries(data.chains || {}).map(([id, c]) => ({
    chainId: Number(id),
    chainName: CHAIN_NAMES[id] || `Chain ${id}`,
    address: c.address,
    supply: c.supply,
    mintEvents: c.counter?.mint,
    burnEvents: c.counter?.burn,
    updated: new Date(c.updated * 1000).toISOString(),
  }));
  return {
    token: { name: data.erc20?.name, symbol: data.erc20?.symbol, decimals: data.erc20?.decimals },
    totalSupply: data.token?.supply,
    priceUsd: data.token?.usd,
    fps: {
      priceChf: data.fps?.price,
      totalSupply: data.fps?.totalSupply,
      marketCapChf: data.fps?.marketCap,
    },
    tvl: { usd: data.tvl?.usd, chf: data.tvl?.chf },
    chains,
  };
}

export async function getFpsInfo() {
  const data = await apiFetch("/ecosystem/fps/info");
  return {
    token: {
      name: data.erc20?.name,
      symbol: data.erc20?.symbol,
      decimals: data.erc20?.decimals,
      address: data.chains?.[1]?.address,
    },
    priceUsd: data.token?.price,
    totalSupply: data.token?.totalSupply,
    marketCapUsd: data.token?.marketCap,
    earnings: {
      profitChf: data.earnings?.profit,
      lossChf: data.earnings?.loss,
      netChf: (data.earnings?.profit || 0) - (data.earnings?.loss || 0),
    },
    reserve: {
      totalChf: data.reserve?.balance,
      equityChf: data.reserve?.equity,
      minterReserveChf: data.reserve?.minter,
    },
  };
}

export async function getPrices() {
  const data = await apiFetch("/prices/list");
  return (data || []).map((t) => ({
    chainId: t.chainId,
    address: t.address,
    name: t.name,
    symbol: t.symbol,
    priceUsd: t.price?.usd,
    priceChf: t.price?.chf,
    source: t.source,
    updatedAt: new Date(t.timestamp).toISOString(),
  }));
}

export async function getSavingsRates() {
  const data = await apiFetch("/savings/leadrate/info");
  const result = { approved: [], proposed: [] };

  for (const [chainId, modules] of Object.entries(data.rate || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      result.approved.push({
        chainId: Number(chainId),
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        module: moduleAddr,
        ratePercent: bpsToPercent(m.approvedRate),
        rateBps: m.approvedRate,
        appliedAt: new Date(m.created * 1000).toISOString(),
        voteCount: m.count,
      });
    }
  }
  for (const [chainId, modules] of Object.entries(data.proposed || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      result.proposed.push({
        chainId: Number(chainId),
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        module: moduleAddr,
        proposedRatePercent: bpsToPercent(m.nextRate),
        proposedRateBps: m.nextRate,
        proposer: m.proposer,
        effectiveAt: new Date(m.nextChange * 1000).toISOString(),
        proposedAt: new Date(m.created * 1000).toISOString(),
      });
    }
  }
  return result;
}

export async function getSavingsStats() {
  const data = await apiFetch("/savings/core/info");
  const stats = [];
  for (const [chainId, modules] of Object.entries(data.status || {})) {
    for (const [moduleAddr, m] of Object.entries(modules)) {
      stats.push({
        chainId: Number(chainId),
        chainName: CHAIN_NAMES[chainId] || `Chain ${chainId}`,
        module: moduleAddr,
        balanceChf: fromWei(m.balance),
        totalInterestPaidChf: fromWei(m.interest),
        totalSavedChf: fromWei(m.save),
        totalWithdrawnChf: fromWei(m.withdraw),
        ratePercent: bpsToPercent(m.rate),
        updatedAt: new Date(m.updated * 1000).toISOString(),
        events: {
          interestPayments: m.counter?.interest,
          rateChanges: m.counter?.rateChanged,
          deposits: m.counter?.save,
          withdrawals: m.counter?.withdraw,
        },
      });
    }
  }
  return stats;
}

export async function getCollaterals() {
  const data = await apiFetch("/ecosystem/collateral/list");
  return (data.list || []).map((c) => ({
    chainId: c.chainId,
    chainName: CHAIN_NAMES[c.chainId] || `Chain ${c.chainId}`,
    address: c.address,
    name: c.name,
    symbol: c.symbol,
    decimals: c.decimals,
  }));
}

export async function getChallenges({ limit = 20, activeOnly = false } = {}) {
  // Fetch challenges + prices in parallel
  const [data, prices] = await Promise.all([
    apiFetch("/challenges/list"),
    apiFetch("/prices/list"),
  ]);

  let list = data.list || [];

  // Use API status as ground truth — don't re-derive from expiry timestamp
  if (activeOnly) {
    list = list.filter((c) => c.status !== "Success");
  }
  const sliced = list.slice(0, limit);

  // Build price lookup by address (lowercase)
  const priceMap = {};
  for (const p of prices) priceMap[p.address.toLowerCase()] = p;

  // Fetch position details for each unique position address individually
  // (bulk unfiltered query misses positions beyond page limit)
  const uniquePositions = [...new Set(sliced.map((c) => c.position.toLowerCase()))];
  const positionMap = {};

  await Promise.all(uniquePositions.map(async (addr) => {
    try {
      // V2 and V1 have different field names: V2 has riskPremiumPPM, V1 has annualInterestPPM
      const q = `{
        v2: mintingHubV2PositionV2s(where: {position: "${addr}"}) {
          items { position collateral collateralSymbol collateralDecimals collateralBalance minted price riskPremiumPPM owner }
        }
        v1: mintingHubV1PositionV1s(where: {position: "${addr}"}) {
          items { position collateral collateralSymbol collateralDecimals collateralBalance minted price annualInterestPPM owner }
        }
      }`;
      const d = await ponderQuery(q);
      const v2 = d.v2?.items?.[0];
      const v1 = d.v1?.items?.[0];
      if (v2) {
        positionMap[addr] = v2;
      } else if (v1) {
        // Normalize V1 field name to match V2 interface
        v1.riskPremiumPPM = v1.annualInterestPPM;
        positionMap[addr] = v1;
      }
    } catch { /* non-fatal */ }
  }));

  // Enrich with CoinGecko 24h change if available
  const collateralAddresses = Object.values(positionMap).map(p => p.collateral?.toLowerCase()).filter(Boolean);
  const cgIds = [...new Set(collateralAddresses.map(a => COINGECKO_IDS[a]).filter(Boolean))];
  let cgData = {};
  if (cgIds.length > 0 && CG_KEY) {
    try {
      cgData = await cgFetch(
        `/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`
      );
    } catch { /* non-fatal */ }
  }

  const now = Date.now() / 1000;

  return {
    total: data.num,
    active: (data.list || []).filter((c) => c.status !== "Success").length,
    challenges: sliced.map((c) => {
      const pos = positionMap[c.position.toLowerCase()];
      const collateralDecimals = pos?.collateralDecimals ?? 18;
      const collateralAddr = pos?.collateral?.toLowerCase();
      const priceEntry = collateralAddr ? priceMap[collateralAddr] : null;
      const cgId = collateralAddr ? COINGECKO_IDS[collateralAddr] : null;
      const cg = cgId ? cgData[cgId] : null;

      // liqPrice is stored as ZCHF-per-collateral-token × 10^(36 - collateralDecimals)
      // Universal formula: pricePerToken = rawPrice / 10^(36 - collateralDecimals)
      const liqPriceZchf = fromWei(c.liqPrice, 36 - collateralDecimals);

      const sizeHuman = fromWei(c.size, collateralDecimals);
      const filledHuman = fromWei(c.filledSize, collateralDecimals);
      const acquiredHuman = fromWei(c.acquiredCollateral, collateralDecimals);

      return {
        id: c.id || `${c.position}-challenge-${c.number}`,
        position: c.position,
        number: Number(c.number),
        challenger: c.challenger,
        status: c.status,
        version: c.version,
        startedAt: new Date(Number(c.start) * 1000).toISOString(),
        expiresAt: new Date((Number(c.start) + Number(c.duration)) * 1000).toISOString(),
        isExpired: Number(c.start) + Number(c.duration) < now,
        durationSeconds: Number(c.duration),
        bids: Number(c.bids),
        txHash: c.txHash,

        // ── Collateral details ──
        collateral: pos ? {
          address: pos.collateral,
          symbol: pos.collateralSymbol,
          decimals: collateralDecimals,
          // Current market price (from Frankencoin API)
          priceChf: priceEntry?.price?.chf ?? null,
          priceUsd: priceEntry?.price?.usd ?? null,
          // CoinGecko enrichment: 24h change + market cap
          change24hPercent: cg?.usd_24h_change?.toFixed(2) ?? null,
          marketCapUsd: cg?.usd_market_cap ? Math.round(cg.usd_market_cap) : null,
        } : null,

        // ── Challenge sizing (human-readable, correct decimals) ──
        size: sizeHuman,
        filledSize: filledHuman,
        acquiredCollateral: acquiredHuman,
        fillPercent: sizeHuman > 0 ? Number(((filledHuman / sizeHuman) * 100).toFixed(1)) : 0,

        // ── Pricing ──
        // Liquidation price for this challenge in ZCHF per collateral token
        liquidationPriceZchf: liqPriceZchf,
        // Current market price vs liquidation price (discount/premium)
        marketVsLiqPremiumPercent: (priceEntry?.price?.chf && liqPriceZchf)
          ? Number((((priceEntry.price.chf - liqPriceZchf) / liqPriceZchf) * 100).toFixed(2))
          : null,
        // Total value of challenged collateral at liquidation price
        challengeValueZchf: sizeHuman > 0 ? Number((sizeHuman * liqPriceZchf).toFixed(2)) : null,

        // ── Position context ──
        positionOwner: pos?.owner ?? null,
        positionMintedZchf: pos ? fromWei(pos.minted) : null,
        positionCollateralBalance: pos ? fromWei(pos.collateralBalance, collateralDecimals) : null,
        positionRiskPremiumPercent: pos ? ppmToPercent(pos.riskPremiumPPM) : null,
      };
    }),
  };
}

export async function getPositions({ limit = 50 } = {}) {
  const data = await apiFetch("/positions/open");
  return {
    total: data.num,
    returned: Math.min(limit, (data.addresses || []).length),
    addresses: (data.addresses || []).slice(0, limit),
    note: "Use get_positions_detail for full position data including collateral, amounts, and pricing",
  };
}

export async function getPositionsDetail({ limit = 20, activeOnly = true, collateral = null } = {}) {
  // Fetch positions, prices, and collateral list in parallel.
  // The collateral list is the authoritative source for decimals — the position
  // entity's collateralDecimals field can be stale/wrong for tokens with non-18
  // decimals (e.g. LENDS shows 18 in position entity but 0 in collateral list).
  const [pData, prices, collateralList] = await Promise.all([
    ponderQuery(`{
      mintingHubV2PositionV2s(limit: ${limit}${activeOnly ? ", where: {closed: false, denied: false" + (collateral ? `, collateral: "${collateral}"` : "") + "}" : collateral ? `, where: {collateral: "${collateral}"}` : ""}) {
        items {
          position owner collateral collateralSymbol collateralBalance collateralDecimals
          minted availableForMinting price cooldown expiration start
          closed denied isOriginal isClone minimumCollateral
          riskPremiumPPM reserveContribution challengePeriod
        }
        pageInfo { hasNextPage endCursor }
      }
    }`),
    apiFetch("/prices/list"),
    apiFetch("/ecosystem/collateral/list"),
  ]);

  const priceMap = {};
  for (const p of prices) priceMap[p.address.toLowerCase()] = p;

  // Build authoritative decimals map from collateral list (keyed by lowercase address)
  const decimalsMap = {};
  for (const c of (collateralList.list || [])) {
    decimalsMap[c.address.toLowerCase()] = c.decimals;
  }

  // Enrich with CoinGecko data for all unique collaterals
  const collateralAddrs = [...new Set(
    (pData.mintingHubV2PositionV2s?.items || []).map(p => p.collateral?.toLowerCase()).filter(Boolean)
  )];
  const cgIds = [...new Set(collateralAddrs.map(a => COINGECKO_IDS[a]).filter(Boolean))];
  let cgData = {};
  if (cgIds.length > 0 && CG_KEY) {
    try {
      cgData = await cgFetch(
        `/simple/price?ids=${cgIds.join(",")}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`
      );
    } catch { /* non-fatal */ }
  }

  const items = pData.mintingHubV2PositionV2s?.items || [];
  return {
    total: items.length,
    positions: items.map((p) => {
      const collateralAddr = p.collateral?.toLowerCase();
      const priceEntry = priceMap[collateralAddr];
      const cgId = COINGECKO_IDS[collateralAddr];
      const cg = cgId ? cgData[cgId] : null;
      // Use collateral list decimals as ground truth; fall back to position entity field.
      // The position entity's collateralDecimals can be stale for non-18-decimal tokens.
      const decimals = decimalsMap[collateralAddr] ?? p.collateralDecimals ?? 18;

      const collateralBalance = fromWei(p.collateralBalance, decimals);
      const minted = fromWei(p.minted);
      // Price is stored as ZCHF × 10^(36 - collateralDecimals) per collateral token
      const liqPrice = fromWei(p.price, 36 - decimals);
      const currentPriceChf = priceEntry?.price?.chf;

      // Collateral value at current market price
      const collateralValueChf = currentPriceChf ? collateralBalance * currentPriceChf : null;
      // Collateral ratio = collateral value / minted ZCHF
      // When minted = 0 return "N/A" (position is empty/unfunded) rather than null
      // to avoid NPE/type errors in downstream consumers (null is ambiguous).
      const collateralRatio = collateralValueChf == null
        ? null                          // price unknown → ratio unknown
        : minted === 0
          ? "N/A"                       // nothing minted → ratio is not meaningful
          : Number(((collateralValueChf / minted) * 100).toFixed(1));

      return {
        address: p.position,
        owner: p.owner,
        status: p.closed ? "closed" : p.denied ? "denied" : "active",
        isOriginal: p.isOriginal,
        isClone: p.isClone,
        collateral: {
          address: p.collateral,
          symbol: p.collateralSymbol,
          decimals,
          balance: collateralBalance,
          minimumRequired: fromWei(p.minimumCollateral, decimals),
          priceChf: currentPriceChf ?? null,
          priceUsd: priceEntry?.price?.usd ?? null,
          change24hPercent: cg?.usd_24h_change?.toFixed(2) ?? null,
          marketCapUsd: cg?.usd_market_cap ? Math.round(cg.usd_market_cap) : null,
          valueChf: collateralValueChf ? Number(collateralValueChf.toFixed(2)) : null,
        },
        minted,
        availableForMinting: fromWei(p.availableForMinting),
        collateralRatioPercent: collateralRatio,
        liquidationPriceZchf: liqPrice,
        riskPremiumPercent: ppmToPercent(p.riskPremiumPPM || 0),
        reserveContributionPercent: ppmToPercent(p.reserveContribution || 0),
        challengePeriodSeconds: Number(p.challengePeriod || 0),
        cooldownUntil: p.cooldown ? new Date(Number(p.cooldown) * 1000).toISOString() : null,
        expiresAt: p.expiration ? new Date(Number(p.expiration) * 1000).toISOString() : null,
        startedAt: p.start ? new Date(Number(p.start) * 1000).toISOString() : null,
      };
    }),
    pageInfo: pData.mintingHubV2PositionV2s?.pageInfo,
  };
}

export async function getAnalytics({ days = 30 } = {}) {
  const data = await ponderQuery(`{
    analyticDailyLogs(limit: ${days}, orderBy: "timestamp", orderDirection: "desc") {
      items {
        date timestamp totalSupply totalEquity totalSavings
        fpsTotalSupply fpsPrice currentLeadRate projectedInterests
        annualNetEarnings realizedNetEarnings earningsPerFPS
        annualV2BorrowRate totalMintedV1 totalMintedV2
      }
    }
  }`);
  return (data.analyticDailyLogs?.items || []).map((d) => ({
    date: d.date,
    supply: fromWei(d.totalSupply),
    equity: fromWei(d.totalEquity),
    savings: fromWei(d.totalSavings),
    fps: {
      supply: fromWei(d.fpsTotalSupply),
      priceChf: fromWei(d.fpsPrice),
      earningsPerFPS: fromWei(d.earningsPerFPS),
    },
    rates: {
      leadRatePercent: fromWei(d.currentLeadRate) * 100,
      annualBorrowRatePercent: fromWei(d.annualV2BorrowRate) * 100,
    },
    earnings: {
      projected: fromWei(d.projectedInterests),
      annual: fromWei(d.annualNetEarnings),
      realized: fromWei(d.realizedNetEarnings),
    },
    mintedV1: fromWei(d.totalMintedV1),
    mintedV2: fromWei(d.totalMintedV2),
  }));
}

export async function getEquityTrades({ limit = 20 } = {}) {
  // Schema (2025): kind, count, trader, amount, shares, price, created, txHash
  // No id/buyer/seller/totalprice/timestamp fields — removed in Ponder migration
  const data = await ponderQuery(`{
    equityTrades(limit: ${limit}, orderBy: "created", orderDirection: "desc") {
      items { kind count trader amount shares price created txHash }
    }
  }`);
  return (data.equityTrades?.items || []).map((t) => ({
    // count = sequential trade number; kind = "Invested" (buy) or "Redeemed" (sell)
    count: Number(t.count),
    kind: t.kind,
    trader: t.trader,
    sharesTraded: fromWei(t.shares),
    priceChf: fromWei(t.price),
    // amount = ZCHF value of the trade
    amountChf: fromWei(t.amount),
    timestamp: new Date(Number(t.created) * 1000).toISOString(),
    txHash: t.txHash,
  }));
}

export async function getMinters({ limit = 20 } = {}) {
  // Schema (2025): chainId, txHash, minter, applicationPeriod, applicationFee,
  // applyMessage, applyDate, suggestor, denyMessage, denyDate, denyTxHash, vetor
  // No id or isMinter fields — removed in Ponder migration
  const data = await ponderQuery(`{
    frankencoinMinters(limit: ${limit}) {
      items { chainId txHash minter applicationPeriod applicationFee applyMessage applyDate suggestor denyMessage denyDate denyTxHash vetor }
    }
  }`);
  return (data.frankencoinMinters?.items || []).map((m) => ({
    address: m.minter,
    chainId: m.chainId,
    // Active = applied but not denied (no denyDate set)
    isActive: !m.denyDate,
    applicationFeeChf: fromWei(m.applicationFee),
    appliedAt: m.applyDate ? new Date(Number(m.applyDate) * 1000).toISOString() : null,
    deniedAt: m.denyDate ? new Date(Number(m.denyDate) * 1000).toISOString() : null,
    suggestor: m.suggestor,
    applyMessage: m.applyMessage || null,
    denyMessage: m.denyMessage || null,
    vetor: m.vetor || null,
    txHash: m.txHash,
    applicationPeriodSeconds: Number(m.applicationPeriod),
  }));
}

export async function getMarketContext() {
  if (!CG_KEY) throw new Error("CoinGecko API key not configured on server");

  // Fetch all data in parallel: ZCHF peg, macro assets, full collateral set, FPS from FC API, global
  const collateralCgIds = [...new Set(Object.values(COINGECKO_IDS))].join(",");

  const [zchfData, macroData, collateralData, fcPrices, globalData] = await Promise.all([
    cgFetch(`/simple/price?ids=frankencoin&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`),
    cgFetch(`/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`),
    cgFetch(`/simple/price?ids=${collateralCgIds}&vs_currencies=usd,chf&include_24hr_change=true&include_market_cap=true`),
    apiFetch("/prices/list"),  // FPS price + all collateral prices in CHF
    cgFetch(`/global`).catch(() => null),
  ]);

  // Build FPS entry from Frankencoin API (not on CoinGecko)
  const fpsEntry = fcPrices.find(p => p.symbol === "FPS");
  const zchfEntry = fcPrices.find(p => p.symbol === "ZCHF");

  const zchf = zchfData["frankencoin"] || {};

  // Peg health: ZCHF should be ~1 CHF
  // Use the Frankencoin API CHF price (more accurate for ZCHF/CHF)
  const zchfPriceChf = zchfEntry?.price?.chf ?? zchf.chf;
  const pegDeviation = zchfPriceChf ? ((zchfPriceChf - 1) * 100) : null;

  // Build enriched collateral table: merge CoinGecko 24h data with FC API CHF prices
  const collateralTable = Object.entries(COINGECKO_IDS).map(([addr, cgId]) => {
    const cg = collateralData[cgId] || {};
    const fcEntry = fcPrices.find(p => p.address?.toLowerCase() === addr);
    return {
      symbol: fcEntry?.symbol ?? cgId,
      name: fcEntry?.name ?? cgId,
      address: addr,
      priceUsd: cg.usd ?? fcEntry?.price?.usd ?? null,
      priceChf: fcEntry?.price?.chf ?? cg.chf ?? null,
      change24hPercent: cg.usd_24h_change != null ? Number(cg.usd_24h_change.toFixed(2)) : null,
      marketCapUsd: cg.usd_market_cap ? Math.round(cg.usd_market_cap) : null,
    };
  }).sort((a, b) => (b.marketCapUsd ?? 0) - (a.marketCapUsd ?? 0));

  return {
    zchf: {
      priceUsd: zchf.usd,
      priceChf: zchfPriceChf,
      change24hPercent: zchf.usd_24h_change != null ? Number(zchf.usd_24h_change.toFixed(2)) : null,
      volume24hUsd: zchf.usd_24h_vol ?? null,
      marketCapUsd: zchf.usd_market_cap ?? null,
      pegDeviationPercent: pegDeviation != null ? Number(pegDeviation.toFixed(4)) : null,
      pegStatus: pegDeviation == null ? "unknown"
        : Math.abs(pegDeviation) < 0.5 ? "healthy"
        : Math.abs(pegDeviation) < 1.0 ? "warning"
        : "critical",
    },
    // FPS price from Frankencoin API (not listed on CoinGecko)
    fps: {
      priceChf: fpsEntry?.price?.chf ?? null,
      priceUsd: fpsEntry?.price?.usd ?? null,
      note: "FPS is not listed on CoinGecko — price sourced from Frankencoin API",
    },
    macro: {
      bitcoin: {
        priceUsd: macroData.bitcoin?.usd,
        priceChf: macroData.bitcoin?.chf,
        change24hPercent: macroData.bitcoin?.usd_24h_change != null ? Number(macroData.bitcoin.usd_24h_change.toFixed(2)) : null,
        volume24hUsd: macroData.bitcoin?.usd_24h_vol ?? null,
        marketCapUsd: macroData.bitcoin?.usd_market_cap ? Math.round(macroData.bitcoin.usd_market_cap) : null,
      },
      ethereum: {
        priceUsd: macroData.ethereum?.usd,
        priceChf: macroData.ethereum?.chf,
        change24hPercent: macroData.ethereum?.usd_24h_change != null ? Number(macroData.ethereum.usd_24h_change.toFixed(2)) : null,
        volume24hUsd: macroData.ethereum?.usd_24h_vol ?? null,
        marketCapUsd: macroData.ethereum?.usd_market_cap ? Math.round(macroData.ethereum.usd_market_cap) : null,
      },
    },
    // All accepted Frankencoin collateral tokens with live market data
    collateral: collateralTable,
    defiTotalMarketCapUsd: globalData?.data?.total_market_cap?.usd
      ? Math.round(globalData.data.total_market_cap.usd) : null,
    updatedAt: new Date().toISOString(),
  };
}

export async function getDuneStats() {
  if (!DUNE_KEY) throw new Error("Dune API key not configured on server");

  // Run the most useful queries in parallel (holders + minting volume + savings)
  const [zchfHolderRows, fpsHolderRows, mintingRows, savingsTvlRows] = await Promise.allSettled([
    duneExecute(DUNE_QUERIES.zchfHolders),
    duneExecute(DUNE_QUERIES.fpsHolders),
    duneExecute(DUNE_QUERIES.mintingVolume),
    duneExecute(DUNE_QUERIES.savingsTvl),
  ]);

  function settled(r) { return r.status === "fulfilled" ? r.value : null; }

  const zchfRows = settled(zchfHolderRows);
  const fpsRows = settled(fpsHolderRows);
  const mintRows = settled(mintingRows);
  const savRows = settled(savingsTvlRows);

  return {
    holders: {
      zchf: zchfRows ? zchfRows[0] : null,
      fps: fpsRows ? fpsRows[0] : null,
    },
    minting: mintRows ? mintRows.slice(0, 30) : null,
    savingsTvl: savRows ? savRows.slice(0, 30) : null,
    note: "Data from Dune Analytics — may be slightly delayed vs on-chain",
  };
}

export async function getHistorical({ days = 90, metric = "all" } = {}) {
  // Daily analytics (FPS price, supply, rates) — data goes back to 2023-10-28
  const analyticsData = await ponderQuery(`{
    analyticDailyLogs(limit: ${Math.min(days, 365)}, orderBy: "timestamp", orderDirection: "desc") {
      items {
        date
        totalSupply totalEquity totalSavings
        fpsTotalSupply fpsPrice
        currentLeadRate
        annualV1BorrowRate
        annualV2BorrowRate
        projectedInterests annualNetEarnings realizedNetEarnings earningsPerFPS
        totalMintedV1 totalMintedV2
        totalInflow totalOutflow totalTradeFee
      }
    }
  }`);

  // Full rate change history (all governance votes)
  const rateData = await ponderQuery(`{
    leadrateRateChangeds(limit: 100, orderBy: "created", orderDirection: "desc") {
      items { chainId module approvedRate created blockheight txHash }
    }
  }`);

  const daily = (analyticsData.analyticDailyLogs?.items || []).map((d) => ({
    date: d.date,
    supply: {
      total: fromWei(d.totalSupply),
      mintedV1: fromWei(d.totalMintedV1),   // V1 = CDP borrowing positions
      mintedV2: fromWei(d.totalMintedV2),   // V2 = newer positions
    },
    fps: {
      supply: fromWei(d.fpsTotalSupply),
      priceChf: fromWei(d.fpsPrice),
      // Market cap = FPS supply × price (both in CHF units)
      marketCapChf: fromWei(d.fpsTotalSupply) * fromWei(d.fpsPrice),
      earningsPerFPS: fromWei(d.earningsPerFPS),
    },
    rates: {
      // currentLeadRate = savings rate (what savers earn)
      savingsRatePercent: fromWei(d.currentLeadRate) * 100,
      // V1 = borrowing rate for V1 CDP positions (annualV1BorrowRate)
      v1BorrowRatePercent: fromWei(d.annualV1BorrowRate) * 100,
      // V2 = effective borrowing rate for V2 positions (annualV2BorrowRate)
      v2BorrowRatePercent: fromWei(d.annualV2BorrowRate) * 100,
    },
    protocol: {
      equity: fromWei(d.totalEquity),
      savings: fromWei(d.totalSavings),
      projectedAnnualInterestIncome: fromWei(d.projectedInterests),
      annualNetEarnings: fromWei(d.annualNetEarnings),
      realizedNetEarnings: fromWei(d.realizedNetEarnings),
      cumulativeInflow: fromWei(d.totalInflow),
      cumulativeOutflow: fromWei(d.totalOutflow),
      cumulativeTradeFees: fromWei(d.totalTradeFee),
    },
  }));

  // Rate change history — group by chain, show chronological governance timeline
  const rateHistory = (rateData.leadrateRateChangeds?.items || []).map((r) => ({
    date: new Date(Number(r.created) * 1000).toISOString().split("T")[0],
    chainId: r.chainId,
    chainName: CHAIN_NAMES[r.chainId] || `Chain ${r.chainId}`,
    ratePercent: bpsToPercent(r.approvedRate),
    module: r.module,
    txHash: r.txHash,
  }));

  // Ethereum-only rate timeline (clearest governance signal)
  const ethRateTimeline = rateHistory
    .filter((r) => r.chainId === 1)
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    note: {
      savingsRate: "currentLeadRate / savingsRatePercent = what ZCHF savers earn",
      v1BorrowRate: "annualV1BorrowRate = interest rate for V1 (legacy CDP) borrowers",
      v2BorrowRate: "annualV2BorrowRate = effective interest rate for V2 position borrowers",
      dataRange: `${daily[daily.length - 1]?.date ?? "?"} → ${daily[0]?.date ?? "?"}`,
      totalDays: daily.length,
    },
    daily,
    rateHistory: {
      ethereum: ethRateTimeline,
      all: rateHistory,
    },
  };
}

export async function runPonderQuery(graphqlQuery) {
  return ponderQuery(graphqlQuery);
}

// ─── GitHub raw content fetch ─────────────────────────────────────────────────

const GITHUB_API = "https://api.github.com";
const SITE_REPO = "Frankencoin-ZCHF/frankencoin-site";
const DOCS_REPO = "Frankencoin-ZCHF/gitbook";

async function githubFile(repo, path) {
  const res = await fetch(`${GITHUB_API}/repos/${repo}/contents/${path}`, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "frankencoin-mcp",
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${repo}/${path}`);
  const data = await res.json();
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function githubJson(repo, path) {
  return JSON.parse(await githubFile(repo, path));
}

// ─── Token addresses ──────────────────────────────────────────────────────────

export async function getTokenAddresses() {
  const data = await githubJson(SITE_REPO, "src/content/en/token.json");

  return {
    zchf: {
      name: "Frankencoin",
      symbol: "ZCHF",
      description: data.tokens?.subtitle ?? "Swiss franc ERC-20 stablecoin",
      chains: (data.tokens?.chains ?? []).map((c) => ({
        name: c.name,
        address: c.contract,
        explorer: c.explorerBaseUrl ? `${c.explorerBaseUrl}/${c.contract}` : null,
      })),
    },
    fps: {
      name: "Frankencoin Pool Shares",
      symbol: "FPS",
      description: data.fps?.subtitle ?? "Governance and equity token (Ethereum only)",
      chain: "Ethereum",
      address: data.fps?.chain?.contract ?? "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2",
      explorer: `https://etherscan.io/address/${data.fps?.chain?.contract ?? "0x1bA26788dfDe592fec8bcB0Eaff472a42BE341B2"}`,
    },
    svzchf: {
      name: "Frankencoin Savings Vault",
      symbol: "svZCHF",
      description: data.svzchf?.subtitle ?? "ERC-4626 savings vault token",
      chains: (data.svzchf?.chains ?? []).map((c) => ({
        name: c.name,
        address: c.contract,
        explorer: c.explorerBaseUrl ? `${c.explorerBaseUrl}/${c.contract}` : null,
      })),
    },
    note: "Addresses sourced live from the Frankencoin website repository.",
  };
}

// ─── Key links ────────────────────────────────────────────────────────────────

export async function getLinks() {
  const [footerData, exchangeData, useCaseData] = await Promise.all([
    githubJson(SITE_REPO, "src/content/en/shared/footer.json"),
    githubJson(SITE_REPO, "src/content/en/exchanges.json"),
    githubJson(SITE_REPO, "src/content/en/use-cases.json"),
  ]);

  // Parse footer columns into named buckets
  const footerLinks = {};
  for (const col of (footerData.footer?.columns ?? [])) {
    const key = col.title.toLowerCase().replace(/[^a-z]/g, "_");
    const links = [
      ...(col.links ?? []),
      ...((col.sections ?? []).flatMap((s) => s.links ?? [])),
    ].map((l) => ({
      label: l.label,
      url: l.href?.startsWith("http") ? l.href : `https://frankencoin.com${l.href}`,
      external: l.external ?? false,
    }));
    footerLinks[key] = links;
  }

  // Extract named community links for convenience
  const communityLinks = footerLinks["community"] ?? [];
  const findUrl = (label) => communityLinks.find((l) => l.label.toLowerCase().includes(label.toLowerCase()))?.url ?? null;

  return {
    app: {
      main: "https://app.frankencoin.com",
      mint: "https://app.frankencoin.com/mint",
      savings: "https://app.frankencoin.com/savings",
      equity: "https://app.frankencoin.com/equity",
      governance: "https://app.frankencoin.com/governance",
      monitoring: "https://app.frankencoin.com/monitoring/collateral",
      bridge: "https://app.frankencoin.com/transfer",
    },
    website: "https://frankencoin.com",
    community: {
      twitter: findUrl("twitter"),
      telegram: findUrl("telegram"),
      linkedin: findUrl("linkedin"),
      youtube: findUrl("youtube"),
      forum: findUrl("discussion"),
      events: findUrl("events"),
      merch: findUrl("merch"),
    },
    developers: {
      docs: "https://docs.frankencoin.com",
      api: "https://api.frankencoin.com",
      whitepaper: "https://app.frankencoin.com/thesis-frankencoin.pdf",
      github: "https://github.com/Frankencoin-ZCHF",
    },
    analytics: {
      defillama: "https://defillama.com/protocol/frankencoin",
      coingecko: "https://www.coingecko.com/en/coins/frankencoin",
      dune: "https://dune.com/frankencoin",
    },
    brand: {
      logos: "https://github.com/Frankencoin-ZCHF/www/tree/main/media_kit",
      guidelines: "https://frankencoin.com/Frankencoin_Brand_Guidelines.pdf",
    },
    // Full footer structure as-is for completeness
    footer: footerLinks,
    exchanges: (exchangeData.exchanges ?? []).map((e) => ({
      name: e.name,
      type: e.type,
      url: e.link,
      description: e.description,
    })),
    useCaseHighlights: (useCaseData.cases ?? []).map((c) => ({
      title: c.title,
      partner: c.partner,
      category: c.category,
      url: c.link,
    })),
    note: "Links sourced live from the Frankencoin website repository (footer.json, exchanges.json, use-cases.json).",
  };
}

// ─── Documentation ────────────────────────────────────────────────────────────

const DOC_FILES = {
  overview: "README.md",
  savings: "savings.md",
  pool_shares: "pool-shares.md",
  governance: "governance.md",
  reserve: "reserve.md",
  risks: "risks.md",
  faq: "faq.md",
  minting: "positions/README.md",
  opening_positions: "positions/open.md",
  auctions: "positions/auctions.md",
  api: "api-docs/README.md",
};

export async function getDocs({ section = "overview" } = {}) {
  const file = DOC_FILES[section];
  if (!file) {
    return {
      error: `Unknown section: "${section}"`,
      availableSections: Object.keys(DOC_FILES),
    };
  }

  const content = await githubFile(DOCS_REPO, file);

  return {
    section,
    file,
    source: `https://github.com/${DOCS_REPO}/blob/main/${file}`,
    docsUrl: `https://docs.frankencoin.com/${file.replace(/\.md$/, "").replace(/\/README$/, "")}`,
    content,
    availableSections: Object.keys(DOC_FILES),
  };
}

// ─── Media and use cases ──────────────────────────────────────────────────────

// ─── Merch store ─────────────────────────────────────────────────────────────

export async function getMerch() {
  const res = await fetch("https://merch.frankencoin.com/products.json?limit=250", {
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Merch store error ${res.status}`);
  const { products } = await res.json();

  return {
    storeUrl: "https://merch.frankencoin.com",
    totalProducts: products.length,
    products: products.map((p) => ({
      title: p.title,
      handle: p.handle,
      url: `https://merch.frankencoin.com/products/${p.handle}`,
      description: p.body_html?.replace(/<[^>]+>/g, "").trim() || null,
      type: p.product_type || null,
      tags: p.tags || [],
      images: p.images.map((i) => i.src),
      options: p.options.map((o) => ({ name: o.name, values: o.values })),
      variants: p.variants.map((v) => ({
        title: v.title,
        price: v.price,
        compareAtPrice: v.compare_at_price || null,
        available: v.available,
        sku: v.sku || null,
      })),
      minPrice: p.variants.reduce((min, v) => Math.min(min, parseFloat(v.price)), Infinity).toFixed(2),
      maxPrice: p.variants.reduce((max, v) => Math.max(max, parseFloat(v.price)), 0).toFixed(2),
      available: p.variants.some((v) => v.available),
    })),
    note: "Live from merch.frankencoin.com — prices in USD.",
  };
}

export async function getMediaAndUseCases() {
  const [mediaData, useCaseData, ecosystemData] = await Promise.all([
    githubJson(SITE_REPO, "src/content/shared/media.json"),
    githubJson(SITE_REPO, "src/content/en/use-cases.json"),
    githubJson(SITE_REPO, "src/content/en/ecosystem.json"),
  ]);

  // Merge article URLs with available metadata overrides
  const articles = (mediaData.articles ?? []).map((url) => {
    const meta = mediaData.articleMetadata?.[url] ?? {};
    return {
      url,
      title: meta.title ?? null,
      description: meta.description ?? null,
      siteName: meta.siteName ?? null,
      publishedDate: meta.publishedDate ?? null,
      image: meta.image ?? null,
    };
  });

  const videos = (mediaData.videos ?? []).map((url) => {
    const meta = mediaData.videoMetadata?.[url] ?? {};
    return {
      url,
      title: meta.title ?? null,
      description: meta.description ?? null,
      author: meta.author ?? null,
      publishedDate: meta.publishedDate ?? null,
    };
  });

  const useCases = (useCaseData.cases ?? []).map((c) => ({
    title: c.title,
    partner: c.partner,
    category: c.category,
    description: c.description,
    url: c.link,
  }));

  const ecosystem = (ecosystemData.tabs ?? []).map((t) => ({
    name: t.name,
    category: t.category ?? t.badge,
    description: t.description,
    url: t.href,
  }));

  return {
    media: { articles, videos },
    useCases,
    ecosystem,
    note: "Content sourced live from the Frankencoin website repository.",
  };
}

export async function getProtocolSummary() {
  const [info, fps, savings, challenges] = await Promise.all([
    getProtocolInfo(),
    getFpsInfo(),
    getSavingsRates(),
    getChallenges({ limit: 5 }),
  ]);

  const leadRate = savings.approved.find((r) => r.chainId === 1 && r.rateBps > 10000);
  const baseRate = savings.approved.find((r) => r.chainId === 1 && r.rateBps === 10000);
  const activeChallenges = challenges.challenges.filter((c) => c.status !== "Success");

  return {
    zchf: {
      totalSupply: info.totalSupply,
      priceUsd: info.priceUsd,
      tvlChf: info.tvl.chf,
      tvlUsd: info.tvl.usd,
      chainBreakdown: info.chains.map((c) => ({
        chain: c.chainName,
        supply: c.supply,
        sharePercent: Number(((c.supply / info.totalSupply) * 100).toFixed(1)),
      })),
    },
    fps: {
      priceChf: info.fps.priceChf,
      totalSupply: info.fps.totalSupply,
      marketCapChf: info.fps.marketCapChf,
      equityReserveChf: fps.reserve.equityChf,
      netEarningsChf: fps.earnings.netChf,
    },
    savings: {
      leadRatePercent: leadRate?.ratePercent ?? null,
      baseRatePercent: baseRate?.ratePercent ?? null,
      pendingRateChanges: savings.proposed.length,
    },
    challenges: {
      total: challenges.total,
      active: challenges.active,
      recent: activeChallenges.slice(0, 3),
    },
    updatedAt: new Date().toISOString(),
  };
}
