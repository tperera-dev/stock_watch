// Server side of the stock price alarm.
// Reads the watchlist (GitHub variable WATCHLIST), checks each ticker whose
// market is open, and sends one Web Push alert to the phone when tickers cross
// their "below" or "above" prices. Public output goes to docs/status.json:
// prices only. Alarm prices never go in that file, and the alert state is
// stored encrypted.
//
// Env (set by the workflow):
//   WATCHLIST          JSON: [{"symbol":"AMD","below":540,"above":650,"on":true}, ...]
//   PUSH_SUBSCRIPTION  JSON push subscription saved by the phone app
//   VAPID_PUBLIC_KEY   variable, VAPID_PRIVATE_KEY secret, VAPID_SUBJECT url
//   FINNHUB_API_KEY    optional secret: extra price source for US stocks
//   FORCE=true         check every ticker even if its market is closed
//   TEST_ALERT=true    send a test alarm
// Local testing: MOCK_PRICES='{"AMD":530}' NOW=2026-10-16T15:00:00Z DRY_RUN=true
import { readFile, writeFile } from "node:fs/promises";
import crypto from "node:crypto";
import webpush from "web-push";

const STATUS_PATH = new URL("../docs/status.json", import.meta.url);
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const env = process.env;
const truthy = v => String(v).toLowerCase() === "true";
const now = env.NOW ? new Date(env.NOW) : new Date();
const MAX_TICKERS = 25;
const HISTORY = 60;

// ---------- markets ----------
const MARKETS = {
  US:  { tz: "America/New_York", open: 9 * 60 + 30, close: 16 * 60 + 5,  currency: "USD", google: ["NASDAQ", "NYSE", "NYSEARCA", "NYSEAMERICAN"] },
  ASX: { tz: "Australia/Sydney", open: 10 * 60,     close: 16 * 60 + 10, currency: "AUD", google: ["ASX"] },
};
const marketOf = sym => (/\.AX$/i.test(sym) ? "ASX" : "US");
const baseSymbol = sym => sym.replace(/\.AX$/i, "");

function localParts(d, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d).map(x => [x.type, x.value]));
  return { day: p.weekday, mins: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}
export function inMarketHours(market, d) {
  const m = MARKETS[market];
  const { day, mins } = localParts(d, m.tz);
  if (day === "Sat" || day === "Sun") return false;
  return mins >= m.open && mins <= m.close;
}

// ---------- watchlist ----------
export function parseWatchlist(raw) {
  if (!raw || !raw.trim()) return [];
  let list;
  try { list = JSON.parse(raw); } catch { throw new Error("WATCHLIST is not valid JSON"); }
  if (!Array.isArray(list)) throw new Error("WATCHLIST must be a JSON array");
  const seen = new Set();
  return list
    .map(x => ({
      symbol: String(x.symbol || "").trim().toUpperCase(),
      below: Number(x.below) > 0 ? Number(x.below) : null,
      above: Number(x.above) > 0 ? Number(x.above) : null,
      on: x.on !== false,
    }))
    .filter(x => /^[A-Z0-9.\-^=]{1,15}$/.test(x.symbol) && !seen.has(x.symbol) && seen.add(x.symbol))
    .slice(0, MAX_TICKERS);
}

// ---------- price sources ----------
// Order: Yahoo batch quote (one request for every ticker, with Yahoo's cookie
// + crumb, which avoids most "429 Too Many Requests" blocks), then per ticker:
// Yahoo chart, CNBC, Finnhub (US only, if FINNHUB_API_KEY is set), Google.
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => { const n = Number(String(v ?? "").replace(/[,$A]/g, "")); return n > 0 ? n : null; };
const notFound = msg => Object.assign(new Error(msg || "ticker not found"), { notFound: true });

// Yahoo session: a cookie from fc.yahoo.com plus a crumb, like a real browser.
let yahooSession = null;
async function getYahooSession() {
  if (yahooSession) return yahooSession;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" }).catch(() => null);
  const setCookies = r1?.headers?.getSetCookie ? r1.headers.getSetCookie() : [];
  const cookie = setCookies.map(c => c.split(";")[0]).join("; ");
  if (!cookie) throw new Error("Yahoo: no session cookie");
  for (const host of ["query1", "query2"]) {
    const r2 = await fetch(`https://${host}.finance.yahoo.com/v1/test/getcrumb`, { headers: { "User-Agent": UA, Cookie: cookie } });
    const crumb = r2.ok ? (await r2.text()).trim() : "";
    if (crumb && !crumb.includes("<") && crumb.length < 40) return (yahooSession = { cookie, crumb });
    if (r2.status === 429) await sleep(1500);
  }
  throw new Error("Yahoo: couldn't get a session");
}
async function yahooFetch(path) {
  let s = null;
  try { s = await getYahooSession(); } catch {}
  const sep = path.includes("?") ? "&" : "?";
  let last;
  for (const host of ["query1", "query2"]) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = `https://${host}.finance.yahoo.com${path}${s ? `${sep}crumb=${encodeURIComponent(s.crumb)}` : ""}`;
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...(s ? { Cookie: s.cookie } : {}) } });
      if (res.status !== 429 && res.status < 500) return res;
      last = res.status; await sleep(1500 + Math.random() * 1500);
    }
  }
  throw new Error(`Yahoo HTTP ${last}`);
}
const STALE_MS = 18 * 3600e3; // no trade for 18 h during market hours = holiday
function fromYahooQuoteRow(q) {
  const price = num(q.regularMarketPrice);
  if (!price) return null;
  const t = q.regularMarketTime ? q.regularMarketTime * 1000 : null;
  return {
    price, source: "Yahoo Finance", currency: q.currency || null,
    prevClose: num(q.regularMarketPreviousClose),
    quoteTime: t ? new Date(t).toISOString() : null,
    openBySource: t ? now.getTime() - t < STALE_MS : null,
  };
}
const prefetched = new Map();
async function prefetchYahoo(symbols) {
  if (!symbols.length) return;
  try {
    const res = await yahooFetch(`/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(",")}`);
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const rows = (await res.json())?.quoteResponse?.result || [];
    for (const q of rows) { const v = fromYahooQuoteRow(q); if (v) prefetched.set(String(q.symbol).toUpperCase(), v); }
    console.log(`Yahoo batch: ${prefetched.size} of ${symbols.length} prices.`);
  } catch (e) { console.log("Yahoo batch failed:", e.message); }
}
async function fromYahooChart(sym) {
  const res = await yahooFetch(`/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=5d`);
  if (res.status === 404) throw notFound();
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  if (json?.chart?.error) throw notFound(json.chart.error.description);
  const meta = json?.chart?.result?.[0]?.meta;
  const price = num(meta?.regularMarketPrice);
  if (!price) throw new Error("Yahoo: no price");
  const t = meta.regularMarketTime ? meta.regularMarketTime * 1000 : null;
  return { price, source: "Yahoo Finance", currency: meta.currency || null,
    prevClose: num(meta.previousClose ?? meta.chartPreviousClose),
    quoteTime: t ? new Date(t).toISOString() : null, openBySource: t ? now.getTime() - t < STALE_MS : null };
}
async function fromCnbc(sym) {
  const cs = marketOf(sym) === "ASX" ? `${baseSymbol(sym)}-AU` : sym; // CNBC writes BHP.AX as BHP-AU
  const url = `https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(cs)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`CNBC HTTP ${res.status}`);
  const q = [].concat((await res.json())?.FormattedQuoteResult?.FormattedQuote || [])[0];
  const price = num(q?.last);
  if (!price) throw new Error("CNBC: no price");
  return { price, source: "CNBC", currency: q.currencyCode || MARKETS[marketOf(sym)].currency,
    prevClose: num(q.previous_day_closing), quoteTime: null, openBySource: null };
}
async function fromFinnhub(sym) {
  if (!env.FINNHUB_API_KEY || marketOf(sym) !== "US") throw new Error("Finnhub: not configured");
  const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${encodeURIComponent(env.FINNHUB_API_KEY)}`);
  if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
  const q = await res.json();
  if (!num(q.c)) throw new Error("Finnhub: no price");
  const t = q.t ? q.t * 1000 : null;
  return { price: num(q.c), source: "Finnhub", currency: "USD", prevClose: num(q.pc),
    quoteTime: t ? new Date(t).toISOString() : null, openBySource: t ? now.getTime() - t < STALE_MS : null };
}
async function fromGoogle(sym) {
  const market = marketOf(sym);
  let lastStatus = null;
  for (const ex of MARKETS[market].google) {
    const res = await fetch(`https://www.google.com/finance/quote/${encodeURIComponent(baseSymbol(sym))}:${ex}?hl=en&gl=us`,
      { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "CONSENT=YES+cb; SOCS=CAI" } });
    lastStatus = res.status;
    if (!res.ok) continue;
    const html = await res.text();
    const m = html.match(/data-last-price="([\d.]+)"/) || html.match(/<title>[^<]*?\$([\d,]+\.\d+)/);
    if (m && num(m[1])) {
      const pc = html.match(/Previous close<\/div>[\s\S]{0,200}?([\d,]+\.\d+)/);
      return { price: num(m[1]), source: "Google Finance", currency: MARKETS[market].currency,
        prevClose: pc ? num(pc[1]) : null, quoteTime: null, openBySource: null };
    }
  }
  throw new Error(lastStatus && lastStatus !== 200 ? `Google HTTP ${lastStatus}` : "Google: price not found");
}
const MOCK = env.MOCK_PRICES ? JSON.parse(env.MOCK_PRICES) : null;
async function getQuote(sym) {
  if (MOCK) {
    if (!(sym in MOCK)) throw notFound();
    return { price: Number(MOCK[sym]), source: "mock", currency: MARKETS[marketOf(sym)].currency, prevClose: null, quoteTime: null, openBySource: null };
  }
  if (prefetched.has(sym)) return prefetched.get(sym);
  const errors = [];
  let yahooSaysMissing = false;
  for (const src of [fromYahooChart, fromCnbc, fromFinnhub, fromGoogle]) {
    try { return await src(sym); }
    catch (e) { if (e.notFound) yahooSaysMissing = true; if (!/not configured/.test(e.message)) errors.push(e.message); }
  }
  if (yahooSaysMissing) throw notFound();
  throw new Error(errors.join("; "));
}

// ---------- alert state (encrypted, so the public file doesn't reveal alarm levels) ----------
function stateKey() {
  return env.VAPID_PRIVATE_KEY ? crypto.createHash("sha256").update("stock-watch-state:" + env.VAPID_PRIVATE_KEY).digest() : null;
}
function encryptState(obj) {
  const key = stateKey(); if (!key) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), data]).toString("base64");
}
function decryptState(b64) {
  const key = stateKey(); if (!key || !b64) return {};
  try {
    const buf = Buffer.from(b64, "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch { return {}; } // key changed: start fresh
}

// Decide which alarms fire. Each side alerts once per crossing and re-arms
// when the price moves back. Changing a level re-arms that side.
export function evaluate(item, price, prev = {}) {
  const st = { ...prev };
  const fired = [];
  for (const side of ["below", "above"]) {
    const level = item[side];
    if (level == null) { delete st[side]; delete st[side + "Level"]; continue; }
    if (st[side + "Level"] !== level) { st[side] = false; st[side + "Level"] = level; }
    const crossed = side === "below" ? price < level : price > level;
    if (crossed && !st[side]) { fired.push({ symbol: item.symbol, side, level, price }); st[side] = true; }
    else if (!crossed) st[side] = false;
  }
  return { state: st, fired };
}

// ---------- push ----------
const money = (n, cur) => `${cur === "AUD" ? "A$" : "$"}${n.toFixed(2)}`;
let pushError = null;
async function push(payload) {
  if (truthy(env.DRY_RUN)) { console.log("[dry run] push:", JSON.stringify(payload)); return true; }
  if (!env.PUSH_SUBSCRIPTION || !env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    pushError = "Alerts aren't set up yet. Open the app and tap Enable alerts.";
    console.log(pushError); return false;
  }
  try {
    webpush.setVapidDetails(env.VAPID_SUBJECT || "mailto:alarm@example.com", env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    await webpush.sendNotification(JSON.parse(env.PUSH_SUBSCRIPTION), JSON.stringify(payload), { TTL: 1800, urgency: "high" });
    return true;
  } catch (e) {
    pushError = (e.statusCode === 404 || e.statusCode === 410)
      ? "Your phone's alert registration expired. Open the app and tap Enable alerts again."
      : `Couldn't send the alert (${e.statusCode || e.message}).`;
    console.error("Push failed:", e.statusCode || "", e.body || e.message);
    return false;
  }
}

// ---------- main ----------
async function main() {
  let status = {};
  try { status = JSON.parse(await readFile(STATUS_PATH, "utf8")); } catch {}
  const prevTickers = status.tickers || {};
  const alertState = decryptState(status.state);

  const watchlist = parseWatchlist(env.WATCHLIST);
  const force = truthy(env.FORCE);
  const openMarkets = Object.keys(MARKETS).filter(m => force || inMarketHours(m, now));

  if (truthy(env.TEST_ALERT)) {
    await push({ type: "test", title: "Stock alarm test", body: "Alerts are working on this phone.", items: [], at: now.toISOString() });
  }

  const due = watchlist.filter(w => w.on && openMarkets.includes(marketOf(w.symbol)));
  console.log(`Open now: ${openMarkets.join(", ") || "none"}. Checking ${due.length} of ${watchlist.length} tickers.`);
  if (!due.length && !truthy(env.TEST_ALERT) && !force) return; // nothing to do, leave status.json untouched

  const tickers = {};
  for (const w of watchlist) if (prevTickers[w.symbol]) tickers[w.symbol] = prevTickers[w.symbol]; // drop removed tickers
  const fired = [];

  if (!MOCK) await prefetchYahoo(due.map(w => w.symbol));
  for (const w of due) {
    const prev = prevTickers[w.symbol] || { history: [] };
    try {
      const q = await getQuote(w.symbol);
      if (!force && q.openBySource === false) { console.log(`${w.symbol}: market closed today (holiday). Skipped.`); continue; }
      const r = evaluate(w, q.price, alertState[w.symbol]);
      alertState[w.symbol] = r.state;
      r.fired.forEach(f => fired.push({ ...f, currency: q.currency }));
      tickers[w.symbol] = {
        price: q.price, currency: q.currency, prevClose: q.prevClose,
        changePct: q.prevClose ? Math.round(((q.price - q.prevClose) / q.prevClose) * 10000) / 100 : null,
        market: marketOf(w.symbol), source: q.source, quoteTime: q.quoteTime,
        checkedAt: now.toISOString(), error: null,
        history: [...(prev.history || []), { t: now.toISOString(), p: q.price }].slice(-HISTORY),
      };
      console.log(`${w.symbol} ${q.price} (${q.source})${r.fired.length ? "  ALERT " + r.fired.map(f => f.side).join("+") : ""}`);
    } catch (e) {
      tickers[w.symbol] = { ...prev, market: marketOf(w.symbol), checkedAt: now.toISOString(),
        error: e.notFound ? "Ticker not found. Check the symbol (ASX stocks end in .AX)." : `Couldn't get a price: ${e.message}` };
      console.error(`${w.symbol}: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, MOCK ? 0 : 400)); // be gentle with the quote sites
  }
  for (const sym of Object.keys(alertState)) if (!watchlist.some(w => w.symbol === sym)) delete alertState[sym];

  if (fired.length) {
    const lines = fired.map(f => `${f.symbol} ${money(f.price, f.currency)} is ${f.side} ${money(f.level, f.currency)}`);
    const title = fired.length === 1
      ? `${fired[0].symbol} ${fired[0].side} ${money(fired[0].level, fired[0].currency)}`
      : `${fired.length} stock alarms`;
    await push({ type: "alarm", title, body: lines.join("\n"), items: fired, at: now.toISOString() });
  }

  const allFailed = due.length > 0 && due.every(w => tickers[w.symbol]?.error && tickers[w.symbol].checkedAt === now.toISOString());
  const out = {
    updatedAt: due.length || truthy(env.TEST_ALERT) ? now.toISOString() : status.updatedAt || null,
    pushError,
    tickers,
    state: encryptState(alertState) ?? status.state ?? null,
  };
  await writeFile(STATUS_PATH, JSON.stringify(out, null, 2) + "\n");
  if (allFailed) process.exit(1); // shows red in GitHub Actions and GitHub emails you
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
