// Peer-calibrated token launch radar model (Node 22 stdlib only, deterministic).
//
// Derives implied pre-token valuations directly from the snapshot's own figures:
//   1. Category peer multiple: shrinkage-smoothed median(mcap_usd / tvl_usd) of live-token
//      non-CEX protocols in the same category, anchored to the snapshot's global median.
//   2. 7d TVL momentum: bounded multiplier from change_7d.
//   3. Operating maturity: bounded multiplier from days since listed_at.
//   4. Chain breadth: bounded multiplier from the count of deployed chains.
//
// No protocol name is ever hardcoded or special-cased.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  prior_weight: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  breadth_step: number;
  breadth_max_extra: number;
}

export const MODEL: ModelConstants = {
  prior_weight: 4,
  multiple_floor: 0.03,
  multiple_cap: 1.5,
  growth_weight: 0.45,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.65,
  maturity_range: 0.45,
  maturity_days: 1095,
  unknown_age_days: 365,
  breadth_step: 0.025,
  breadth_max_extra: 6,
};

export const MODEL_VERSION = 'radar-2.1';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 30;

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export interface CategoryPeerStat {
  category: string;
  peers: number;
  raw_median: number;
  smoothed_multiple: number;
}

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  in_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    category_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  in_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  mcap_tvl_ratio: number | null;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  global_median_multiple: number;
  live_peer_count: number;
  category_stats: CategoryPeerStat[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0.25;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_OR_STAKED.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/**
 * Compute shrinkage-smoothed MCAP/TVL multiples per category from live-token peers
 * in the same snapshot.
 */
export function buildCategoryMultiples(
  protocols: SnapshotProtocol[],
  model: ModelConstants,
): { globalMedian: number; peerCount: number; byCategory: Map<string, CategoryPeerStat> } {
  const allRatios: number[] = [];
  const grouped = new Map<string, number[]>();
  for (const p of protocols) {
    if (isPreToken(p) || p.category === 'CEX') continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    allRatios.push(ratio);
    const cat = p.category ?? 'Other';
    let list = grouped.get(cat);
    if (!list) {
      list = [];
      grouped.set(cat, list);
    }
    list.push(ratio);
  }
  const globalMedian = round4(clamp(medianOf(allRatios), model.multiple_floor, model.multiple_cap));
  const byCategory = new Map<string, CategoryPeerStat>();
  for (const [cat, list] of grouped.entries()) {
    const raw = clamp(medianOf(list), model.multiple_floor, model.multiple_cap);
    const smoothed = (list.length * raw + model.prior_weight * globalMedian) / (list.length + model.prior_weight);
    byCategory.set(cat, {
      category: cat,
      peers: list.length,
      raw_median: round4(raw),
      smoothed_multiple: round4(clamp(smoothed, model.multiple_floor, model.multiple_cap)),
    });
  }
  return { globalMedian, peerCount: allRatios.length, byCategory };
}

export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
  catStats: { globalMedian: number; byCategory: Map<string, CategoryPeerStat> },
): {
  implied: number;
  categoryMult: number;
  growthPct: number;
  growthMult: number;
  maturityMult: number;
  breadthMult: number;
  age: number | null;
} {
  const cat = protocol.category ?? 'Other';
  const catMult = catStats.byCategory.get(cat)?.smoothed_multiple ?? catStats.globalMedian;
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = clamp(rawGrowth, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult =
    model.maturity_floor +
    (clamp(ageForModel, 0, model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = clamp(protocol.chains.length - 1, 0, model.breadth_max_extra);
  const breadthMult = 1 + extraChains * model.breadth_step;
  const base = protocol.tvl_usd * catMult;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * breadthMult));
  return {
    implied,
    categoryMult: catMult,
    growthPct,
    growthMult,
    maturityMult,
    breadthMult,
    age,
  };
}

const LOW_FEE_CHAINS = new Set([
  'solana', 'sui', 'aptos', 'ton', 'tron', 'stellar', 'near', 'algorand',
  'cardano', 'hedera', 'cosmos', 'osmosis', 'injective', 'sei', 'stacks',
  'icp', 'kaspa', 'tezos', 'flow', 'aleo', 'noble', 'neutron',
]);
const BITCOIN_CHAINS = new Set(['bitcoin', 'litecoin', 'doge', 'bitcoincash']);
const ETH_GAS_CHAINS = new Set([
  'ethereum', 'arbitrum', 'optimism', 'base', 'linea', 'scroll', 'zksync era',
  'blast', 'mode', 'starknet', 'ink', 'soneium', 'unichain', 'megaeth',
  'abstract', 'taiko', 'zircuit', 'fraxtal', 'eclipse', 'hemi', 'etherlink',
]);

interface ChainAssets {
  native: string;
  stable: string;
  pair: string;
}

const CHAIN_ASSET_MAP: Record<string, ChainAssets> = {
  tron: { native: 'TRX', stable: 'USDT', pair: 'USDT or TRX' },
  solana: { native: 'SOL', stable: 'USDC', pair: 'USDC or SOL' },
  sui: { native: 'SUI', stable: 'USDC', pair: 'USDC or SUI' },
  aptos: { native: 'APT', stable: 'USDC', pair: 'USDC or APT' },
  ton: { native: 'TON', stable: 'USDT', pair: 'USDT or TON' },
  binance: { native: 'BNB', stable: 'USDT', pair: 'USDT or BNB' },
  op_bnb: { native: 'BNB', stable: 'USDT', pair: 'USDT or BNB' },
  avalanche: { native: 'AVAX', stable: 'USDC', pair: 'USDC or AVAX' },
  polygon: { native: 'POL', stable: 'USDC', pair: 'USDC or POL' },
  'polygon zkevm': { native: 'ETH', stable: 'USDC', pair: 'USDC or ETH' },
  'hyperliquid l1': { native: 'HYPE', stable: 'USDC', pair: 'USDC or HYPE' },
  stellar: { native: 'XLM', stable: 'USDC', pair: 'USDC or XLM' },
  bitcoin: { native: 'BTC', stable: 'USDC', pair: 'BTC or USDC' },
  stacks: { native: 'STX', stable: 'sBTC', pair: 'STX or sBTC' },
  rsk: { native: 'RBTC', stable: 'USDT', pair: 'RBTC or USDT' },
  bitlayer: { native: 'BTC', stable: 'USDT', pair: 'BTC or USDT' },
  bsquared: { native: 'BTC', stable: 'USDT', pair: 'BTC or USDT' },
  merlin: { native: 'BTC', stable: 'USDT', pair: 'BTC or USDT' },
  core: { native: 'CORE', stable: 'USDT', pair: 'BTC or CORE' },
  bob: { native: 'ETH', stable: 'USDC', pair: 'BTC or USDC' },
  citrea: { native: 'cBTC', stable: 'USDC', pair: 'cBTC or USDC' },
  sonic: { native: 'S', stable: 'USDC', pair: 'USDC or S' },
  fantom: { native: 'FTM', stable: 'USDC', pair: 'USDC or FTM' },
  berachain: { native: 'BERA', stable: 'USDC', pair: 'USDC or BERA' },
  monad: { native: 'MON', stable: 'USDC', pair: 'USDC or MON' },
  sei: { native: 'SEI', stable: 'USDC', pair: 'USDC or SEI' },
  near: { native: 'NEAR', stable: 'USDC', pair: 'USDC or NEAR' },
  cardano: { native: 'ADA', stable: 'USDM', pair: 'ADA or USDM' },
  algorand: { native: 'ALGO', stable: 'USDC', pair: 'USDC or ALGO' },
  cosmos: { native: 'ATOM', stable: 'USDC', pair: 'USDC or ATOM' },
  osmosis: { native: 'OSMO', stable: 'USDC', pair: 'USDC or OSMO' },
  neutron: { native: 'NTRN', stable: 'USDC', pair: 'USDC or NTRN' },
  injective: { native: 'INJ', stable: 'USDT', pair: 'USDT or INJ' },
  celo: { native: 'CELO', stable: 'USDC', pair: 'USDC or CELO' },
  xdai: { native: 'xDAI', stable: 'USDC', pair: 'USDC or xDAI' },
  cronos: { native: 'CRO', stable: 'USDC', pair: 'USDC or CRO' },
  kava: { native: 'KAVA', stable: 'USDT', pair: 'USDT or KAVA' },
  mantle: { native: 'MNT', stable: 'USDC', pair: 'USDC or MNT' },
  plasma: { native: 'XPL', stable: 'USDT', pair: 'USDT or USDC' },
};

function chainAssets(chain: string): ChainAssets {
  const c = chain.toLowerCase();
  if (CHAIN_ASSET_MAP[c]) return CHAIN_ASSET_MAP[c]!;
  if (ETH_GAS_CHAINS.has(c)) return { native: 'ETH', stable: 'USDC', pair: 'USDC or ETH' };
  return { native: 'native gas', stable: 'USDC', pair: 'USDC' };
}

function gasEstimateForChain(chain: string): { setupGas: string; weeklyGas: string } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') {
    return { setupGas: '$8-$15 Ethereum gas', weeklyGas: '$4-$8 Ethereum weekly gas' };
  }
  if (LOW_FEE_CHAINS.has(c)) {
    return { setupGas: `under $0.10 ${chain} fee`, weeklyGas: `under $0.05 ${chain} weekly fee` };
  }
  if (BITCOIN_CHAINS.has(c)) {
    return { setupGas: `$1-$4 ${chain} fee`, weeklyGas: `$1-$3 ${chain} weekly fee` };
  }
  return { setupGas: `$0.15-$1.20 ${chain} gas`, weeklyGas: `$0.10-$0.60 ${chain} weekly gas` };
}

function tvlTierLabel(tvlUsd: number): string {
  if (tvlUsd >= 1_000_000_000) return 'mega-cap';
  if (tvlUsd >= 250_000_000) return 'large-cap';
  if (tvlUsd >= 50_000_000) return 'mid-cap';
  return 'early-stage';
}

function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 2_000_000_000) return 500;
  if (p.tvl_usd >= 500_000_000) return 300;
  if (p.tvl_usd >= 50_000_000) return 150;
  return 50;
}

function holdDaysFor(age: number | null, change7d: number | null): number {
  if (age !== null && age < 180) return 60;
  if (change7d !== null && change7d > 20) return 60;
  if (age !== null && age < 365) return 45;
  return 30;
}

function primaryStrategy(
  p: SnapshotProtocol,
  capital: number,
  chain: string,
  secondChain: string | null,
  assets: ChainAssets,
): string {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of ${assets.pair} as collateral on ${n} (${chain}) and borrow 30-35% LTV in ${assets.stable} to earn both supply and borrow points.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) {
    return `Deposit $${capital} ${assets.stable} margin on ${n} (${chain}) and place 2-3 small maker limit orders per week to build volume with minimal slippage.`;
  }
  if (c.includes('bridge')) {
    const dest = secondChain ?? 'a supported L2';
    return `Bridge $${capital} ${assets.stable} from ${chain} to ${dest} via ${n} and complete one destination swap so both legs register.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) {
    return `Provide $${capital} into ${n}'s deepest ${assets.pair} or stable pool on ${chain} to minimize impermanent loss while accruing LP points.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of ${assets.native} through ${n} on ${chain} and hold the liquid receipt token in the same wallet.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} ${assets.stable} into ${n}'s highest-TVL audited vault on ${chain} and retain the vault share token without unwrapping.`;
  }
  if (c.includes('basis') || c.includes('stable') || c.includes('rwa')) {
    return `Mint or deposit $${capital} of the yield-bearing ${assets.stable}/RWA asset on ${n} (${chain}) and hold it across epoch snapshots.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} ${assets.stable} on ${n} (${chain}) and place balanced YES/NO limit positions across 3+ active markets.`;
  }
  return `Deposit $${capital} of ${assets.stable} into ${n}'s primary pool on ${chain} and keep the receipt position active.`;
}

function retentionAction(p: SnapshotProtocol, chain: string, hold: number): string {
  const c = (p.category ?? '').toLowerCase();
  const tier = tvlTierLabel(p.tvl_usd);
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Hold the ${p.name} (${tier}) borrow/supply position on ${chain} for ${hold} days while keeping LTV below 40% across weekly snapshots.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) {
    return `Keep $${capitalFor(p)} active margin on ${p.name} (${chain}, ${tier}) for ${hold} days with steady weekly maker fills and zero full withdrawals.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) {
    return `Leave the ${p.name} LP position on ${chain} (${tier}) staked for ${hold} days, rebalancing only if price drifts outside range.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Keep ${p.name} vault shares on ${chain} (${tier}) untouched for ${hold} days so time-weighted epoch multipliers compound.`;
  }
  if (c.includes('basis') || c.includes('stable') || c.includes('rwa')) {
    return `Hold the ${p.name} yield-bearing receipt on ${chain} (${tier}) for ${hold} days across consecutive reward snapshots.`;
  }
  if (c.includes('prediction')) {
    return `Maintain active ${p.name} market positions on ${chain} (${tier}) for ${hold} days and roll settled stakes into new markets.`;
  }
  return `Maintain the ${p.name} (${tier}) position on ${chain} for at least ${hold} days across multiple weekly snapshots without full withdrawal.`;
}

function trackingAction(p: SnapshotProtocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const tier = tvlTierLabel(p.tvl_usd);
  if (c.includes('lend') || c.includes('cdp')) {
    return `Monitor ${p.name}'s ${chain} points dashboard and ${tier} borrow-rate incentives before repaying and unwinding.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('option')) {
    return `Audit weekly volume tiers, fee rebates, and TGE announcements on ${p.name} (${chain}) prior to closing margin.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Check ${p.name}'s vault epoch schedule and ${chain} withdrawal queue timing before redeeming ${tier} shares.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('farm')) {
    return `Verify ${p.name}'s ${chain} LP emission schedule and claimable ${tier} rewards before removing liquidity.`;
  }
  return `Track points, epoch multipliers, and claim windows on ${p.name}'s ${chain} (${tier}) dashboard before unwinding.`;
}

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Verify on the official app.`;
  return s;
}

export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = p.chains[0] ?? 'its primary chain';
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const capital = capitalFor(p);
  const hold = holdDaysFor(age, p.change_7d);
  const assets = chainAssets(chain);
  const gas = gasEstimateForChain(chain);
  const step3Chain = secondChain ?? chain;
  const step3Gas = gasEstimateForChain(step3Chain);
  const step3Assets = chainAssets(step3Chain);
  const strategy = primaryStrategy(p, capital, chain, secondChain, assets);

  const steps: FarmStep[] = [
    {
      text: `Fund a dedicated farming wallet on ${chain} with $${capital} in ${assets.stable} plus ${assets.native} for gas and verify the official ${p.name} contract URL.`,
      cost: `$${capital} principal + ${gas.setupGas}`,
      time: '10 minutes',
    },
    {
      text: strategy,
      cost: `${gas.setupGas} (capital remains withdrawable)`,
      time: '15 minutes',
    },
    {
      text: secondChain
        ? `Repeat one smaller deposit or swap ($${Math.max(25, Math.round(capital / 3))} in ${step3Assets.stable}) on ${p.name} (${secondChain}) so multi-chain activity is recorded.`
        : `Execute one recurring weekly interaction (rebalance, claim-and-compound, or small ${assets.stable} top-up) on ${p.name} (${chain}).`,
      cost: step3Gas.weeklyGas,
      time: '10 minutes per week',
    },
    {
      text: retentionAction(p, chain, hold),
      cost: `$${capital} locked opportunity cost`,
      time: `${hold} days`,
    },
    {
      text: trackingAction(p, chain),
      cost: `$0 to check; ${gas.weeklyGas} on unwind`,
      time: '10 minutes at epoch close',
    },
  ];
  return steps;
}

export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): {
  board: BoardRow[];
  catStats: { globalMedian: number; peerCount: number; byCategory: Map<string, CategoryPeerStat> };
} {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchSet = new Set(snapshot.watchlist);
  const chosen = new Map<string, SnapshotProtocol>();

  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const catStats = buildCategoryMultiples(snapshot.protocols, model);
  const scored = [...chosen.values()].map((p) => ({
    p,
    val: impliedValue(p, snapshot.as_of, model, catStats),
  }));

  scored.sort((a, b) => b.val.implied - a.val.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    in_watchlist: watchSet.has(s.p.slug),
    age_days: s.val.age,
    implied_value_usd: s.val.implied,
    model: {
      category_multiple: round4(s.val.categoryMult),
      growth_pct: round4(s.val.growthPct),
      growth_multiplier: round4(s.val.growthMult),
      maturity_multiplier: round4(s.val.maturityMult),
      breadth_multiplier: round4(s.val.breadthMult),
      age_days: s.val.age,
    },
    farm_steps: farmSteps(s.p, s.val.age).map(stepText),
  }));

  return { board, catStats };
}

export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      mcap_tvl_ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    in_watchlist: row.in_watchlist,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    farm_steps: row.farm_steps,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { board, catStats } = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !r.in_watchlist).length;
  const category_stats = [...catStats.byCategory.values()]
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    global_median_multiple: catStats.globalMedian,
    live_peer_count: catStats.peerCount,
    category_stats,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotError('snapshot.json is not a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) {
    throw new SnapshotError('snapshot.json has no as_of date');
  }
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    }
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `misses ${missing.length} watchlist slug(s): ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) {
      return `row ${i + 1} outranks row ${i} on implied value`;
    }
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share implied value $${board[0]!.implied_value_usd}`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} chars`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
  }
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
