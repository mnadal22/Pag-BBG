// Backend de la terminal: proxy a Yahoo Finance con caché, desplegado en Cloudflare Workers (gratis).
//
// Endpoints (todos GET, responden JSON con CORS):
//   /search?q=apple                  → búsqueda de tickers
//   /chart?symbol=AAPL&range=max&interval=1d   → historia {d:[...], v:[...], meta}
//   /quotes?symbols=AAPL,MSFT,CLP=X  → último precio y variación del día (máx. 60 símbolos)
//   /summary?symbol=AAPL             → fundamentals: PER, market cap, earnings, márgenes, etc.

const YH = "https://query1.finance.yahoo.com";
const YH2 = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const TTL = { search: 3600, chart_intraday: 60, chart_daily: 900, quotes: 30, summary: 3600 };
const RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "2y", "5y", "10y", "max"]);
const INTERVALS = new Set(["1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h", "1d", "1wk", "1mo"]);

// ---------- utilidades ----------
function cors(env) {
  return {
    "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
  };
}
function json(data, env, status = 200, ttl = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": ttl ? `public, max-age=${ttl}, s-maxage=${ttl}` : "no-store",
      ...cors(env),
    },
  });
}
const raw = (x) => (x && typeof x === "object" && "raw" in x ? x.raw : x ?? null);
const fmtDate = (x) => {
  const r = raw(x);
  return typeof r === "number" ? new Date(r * 1000).toISOString().slice(0, 10) : null;
};

async function yget(url, extraHeaders = {}) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...extraHeaders } });
  if (!r.ok) throw new HttpError(r.status, `Yahoo respondió ${r.status}`);
  return r.json();
}
class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

// ---------- crumb + cookie (necesarios para quoteSummary) ----------
let AUTH = null; // {cookie, crumb, ts}
async function getAuth(force = false) {
  if (!force && AUTH && Date.now() - AUTH.ts < 6 * 3600e3) return AUTH;
  const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
  const setCookie = r1.headers.get("set-cookie") || "";
  const cookie = setCookie.split(/,(?=[^;]+=)/).map((c) => c.split(";")[0].trim()).filter(Boolean).join("; ");
  const r2 = await fetch(`${YH2}/v1/test/getcrumb`, { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes("<") || crumb.length > 40) throw new HttpError(502, "No se pudo obtener el crumb de Yahoo");
  AUTH = { cookie, crumb, ts: Date.now() };
  return AUTH;
}

// ---------- handlers ----------
async function search(q) {
  const j = await yget(`${YH}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=12&newsCount=0&listsCount=0&enableFuzzyQuery=true`);
  return (j.quotes || [])
    .filter((x) => x.symbol)
    .map((x) => ({
      symbol: x.symbol,
      name: x.shortname || x.longname || x.symbol,
      type: x.quoteType || x.typeDisp,
      exchange: x.exchDisp || x.exchange,
    }));
}

export function parseChart(j) {
  const res = j?.chart?.result?.[0];
  if (!res) throw new HttpError(404, j?.chart?.error?.description || "Sin datos");
  const ts = res.timestamp || [];
  const q = res.indicators?.quote?.[0] || {};
  const adj = res.indicators?.adjclose?.[0]?.adjclose;
  const close = q.close || [];
  const intraday = (res.meta?.dataGranularity || "1d").match(/[mh]$/);
  const d = [], v = [], o = [], h = [], l = [], vol = [];
  for (let i = 0; i < ts.length; i++) {
    if (close[i] == null) continue;
    d.push(intraday ? new Date(ts[i] * 1000).toISOString().slice(0, 16) : new Date(ts[i] * 1000).toISOString().slice(0, 10));
    v.push(close[i]);
    o.push(q.open?.[i] ?? null); h.push(q.high?.[i] ?? null); l.push(q.low?.[i] ?? null); vol.push(q.volume?.[i] ?? null);
  }
  const m = res.meta || {};
  return {
    symbol: m.symbol,
    d, v, o, h, l, vol,
    adj: adj ? adj.filter((_, i) => close[i] != null) : null,
    intraday: !!intraday,
    meta: {
      name: m.longName || m.shortName || m.symbol,
      currency: m.currency,
      exchange: m.fullExchangeName || m.exchangeName,
      type: m.instrumentType,
      price: m.regularMarketPrice,
      prevClose: m.chartPreviousClose ?? m.previousClose,
      time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null,
      hi52: m.fiftyTwoWeekHigh, lo52: m.fiftyTwoWeekLow,
      dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, volume: m.regularMarketVolume,
      tz: m.exchangeTimezoneName,
    },
  };
}

async function chart(symbol, range, interval) {
  const j = await yget(`${YH}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false&events=div,split`);
  return parseChart(j);
}

async function quotes(symbols) {
  const out = await Promise.all(
    symbols.map(async (s) => {
      try {
        const c = await chart(s, "5d", "1d");
        const m = c.meta;
        const prev = c.v.length > 1 ? c.v[c.v.length - 2] : m.prevClose;
        const price = m.price ?? c.v[c.v.length - 1];
        return { symbol: s, name: m.name, currency: m.currency, price, prev, chg: price - prev, pct: prev ? (price / prev - 1) * 100 : null, time: m.time, hi52: m.hi52, lo52: m.lo52, volume: m.volume };
      } catch (e) {
        return { symbol: s, error: e.message };
      }
    })
  );
  return out;
}

const MODULES = ["price", "summaryDetail", "defaultKeyStatistics", "financialData", "calendarEvents", "assetProfile", "earnings", "earningsHistory", "earningsTrend", "recommendationTrend", "fundProfile", "topHoldings"];

export function parseSummary(r) {
  const p = r.price || {}, sd = r.summaryDetail || {}, ks = r.defaultKeyStatistics || {}, fd = r.financialData || {};
  const cal = r.calendarEvents || {}, ap = r.assetProfile || {}, fp = r.fundProfile || {};
  const ed = cal.earnings?.earningsDate || [];
  return {
    name: p.longName || p.shortName,
    type: p.quoteType,
    currency: p.currency,
    exchange: p.exchangeName,
    price: raw(p.regularMarketPrice),
    marketCap: raw(p.marketCap) ?? raw(sd.marketCap),
    valuation: {
      trailingPE: raw(sd.trailingPE), forwardPE: raw(sd.forwardPE) ?? raw(ks.forwardPE), peg: raw(ks.pegRatio),
      priceToBook: raw(ks.priceToBook), priceToSales: raw(sd.priceToSalesTrailing12Months),
      evToEbitda: raw(ks.enterpriseToEbitda), evToRevenue: raw(ks.enterpriseToRevenue), enterpriseValue: raw(ks.enterpriseValue),
    },
    perShare: { epsTrailing: raw(ks.trailingEps), epsForward: raw(ks.forwardEps), bookValue: raw(ks.bookValue) },
    dividends: {
      yield: raw(sd.dividendYield) ?? raw(sd.yield), rate: raw(sd.dividendRate), payout: raw(sd.payoutRatio),
      exDate: fmtDate(sd.exDividendDate) ?? fmtDate(cal.exDividendDate), payDate: fmtDate(cal.dividendDate),
    },
    risk: { beta: raw(sd.beta) ?? raw(ks.beta), hi52: raw(sd.fiftyTwoWeekHigh), lo52: raw(sd.fiftyTwoWeekLow), avgVolume: raw(sd.averageVolume), sharesOut: raw(ks.sharesOutstanding), floatShares: raw(ks.floatShares), shortPctFloat: raw(ks.shortPercentOfFloat) },
    financials: {
      revenue: raw(fd.totalRevenue), revenueGrowth: raw(fd.revenueGrowth), earningsGrowth: raw(fd.earningsGrowth),
      grossMargin: raw(fd.grossMargins), operatingMargin: raw(fd.operatingMargins), profitMargin: raw(fd.profitMargins),
      ebitda: raw(fd.ebitda), roe: raw(fd.returnOnEquity), roa: raw(fd.returnOnAssets),
      totalCash: raw(fd.totalCash), totalDebt: raw(fd.totalDebt), debtToEquity: raw(fd.debtToEquity), currentRatio: raw(fd.currentRatio), fcf: raw(fd.freeCashflow),
    },
    analysts: { target: raw(fd.targetMeanPrice), targetHigh: raw(fd.targetHighPrice), targetLow: raw(fd.targetLowPrice), recommendation: fd.recommendationKey, n: raw(fd.numberOfAnalystOpinions) },
    earnings: {
      nextDate: ed.map(fmtDate).filter(Boolean),
      epsEstimate: raw(cal.earnings?.earningsAverage), revenueEstimate: raw(cal.earnings?.revenueAverage),
      history: (r.earningsHistory?.history || []).map((x) => ({ quarter: fmtDate(x.quarter), actual: raw(x.epsActual), estimate: raw(x.epsEstimate), surprisePct: raw(x.surprisePercent) })),
      quarterly: (r.earnings?.financialsChart?.quarterly || []).map((x) => ({ period: x.date, revenue: raw(x.revenue), earnings: raw(x.earnings) })),
      yearly: (r.earnings?.financialsChart?.yearly || []).map((x) => ({ period: x.date, revenue: raw(x.revenue), earnings: raw(x.earnings) })),
    },
    profile: { sector: ap.sector, industry: ap.industry, country: ap.country, employees: ap.fullTimeEmployees, website: ap.website, summary: ap.longBusinessSummary },
    fund: r.fundProfile ? { family: fp.family, category: fp.categoryName, expenseRatio: raw(fp.feesExpensesInvestment?.annualReportExpenseRatio), totalAssets: raw(sd.totalAssets), holdings: (r.topHoldings?.holdings || []).slice(0, 10).map((h) => ({ symbol: h.symbol, name: h.holdingName, pct: raw(h.holdingPercent) })) } : null,
  };
}

async function summary(symbol) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { cookie, crumb } = await getAuth(attempt > 0);
    const url = `${YH2}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${MODULES.join(",")}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetch(url, { headers: { "User-Agent": UA, Cookie: cookie, Accept: "application/json" } });
    if (r.status === 401 || r.status === 403) continue; // crumb vencido → reintenta
    if (!r.ok) throw new HttpError(r.status, `Yahoo respondió ${r.status}`);
    const j = await r.json();
    const res = j?.quoteSummary?.result?.[0];
    if (!res) throw new HttpError(404, j?.quoteSummary?.error?.description || "Sin datos");
    return parseSummary(res);
  }
  throw new HttpError(502, "Yahoo rechazó la autenticación");
}

// ---------- router ----------
export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors(env) });
    if (request.method !== "GET") return json({ error: "Método no permitido" }, env, 405);

    const url = new URL(request.url);
    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    let resp;
    try {
      const p = url.searchParams;
      switch (url.pathname) {
        case "/":
          resp = json({ ok: true, endpoints: ["/search?q=", "/chart?symbol=&range=&interval=", "/quotes?symbols=", "/summary?symbol="] }, env);
          break;
        case "/search": {
          const q = (p.get("q") || "").trim();
          if (!q) return json({ error: "Falta q" }, env, 400);
          resp = json(await search(q), env, 200, TTL.search);
          break;
        }
        case "/chart": {
          const symbol = (p.get("symbol") || "").trim();
          const range = p.get("range") || "max";
          const interval = p.get("interval") || "1d";
          if (!symbol || !RANGES.has(range) || !INTERVALS.has(interval)) return json({ error: "Parámetros inválidos" }, env, 400);
          resp = json(await chart(symbol, range, interval), env, 200, /[mh]$/.test(interval) ? TTL.chart_intraday : TTL.chart_daily);
          break;
        }
        case "/quotes": {
          const symbols = [...new Set((p.get("symbols") || "").split(",").map((s) => s.trim()).filter(Boolean))].slice(0, 60);
          if (!symbols.length) return json({ error: "Falta symbols" }, env, 400);
          resp = json(await quotes(symbols), env, 200, TTL.quotes);
          break;
        }
        case "/summary": {
          const symbol = (p.get("symbol") || "").trim();
          if (!symbol) return json({ error: "Falta symbol" }, env, 400);
          resp = json(await summary(symbol), env, 200, TTL.summary);
          break;
        }
        default:
          return json({ error: "No encontrado" }, env, 404);
      }
    } catch (e) {
      return json({ error: e.message || String(e) }, env, e.status && e.status < 600 ? e.status : 502);
    }
    if (resp.ok) ctx.waitUntil(cache.put(cacheKey, resp.clone()));
    return resp;
  },
};
