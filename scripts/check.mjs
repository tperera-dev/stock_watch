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
async function fromYahoo(sym) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (res.status === 404) throw Object.assign(new Error("ticker not found"), { notFound: true });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const json = await res.json();
  if (json?.chart?.error) throw Object.assign(new Error(json.chart.error.description || "ticker not found"), { notFound: true });
  const meta = json?.chart?.result?.[0]?.meta;
  const price = Number(meta?.regularMarketPrice);
  if (!(price > 0)) throw new Error("Yahoo: no price");
  const period = meta.currentTradingPeriod?.regular;
  const t = Math.floor(now.getTime() / 1000);
  return {
    price, source: "Yahoo Finance",
    currency: meta.currency || null,
    prevClose: Number(meta.chartPreviousClose ?? meta.previousClose) || null,
    quoteTime: meta.regularMarketTime ? new Date(meta.regularMarketTime * 1000).toISOString() : null,
    openBySource: period ? t >= period.start && t <= period.end + 600 : null, // knows holidays
  };
}
async function fromGoogle(sym) {
  const market = marketOf(sym);
  for (const ex of MARKETS[market].google) {
    const res = await fetch(`https://www.google.com/finance/quote/${encodeURIComponent(baseSymbol(sym))}:${ex}?hl=en`,
      { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
    if (!res.ok) continue;
    const html = await res.text();
    const m = html.match(/data-last-price="([\d.]+)"/);
    if (m && Number(m[1]) > 0) {
      const pc = html.match(/Previous close<\/div>[\s\S]{0,200}?([\d,]+\.\d+)/);
      return { price: Number(m[1]), source: "Google Finance", currency: MARKETS[market].currency,
        prevClose: pc ? Number(pc[1].replace(/,/g, "")) : null, quoteTime: null, openBySource: null };
    }
  }
  throw new Error("Google: price not found");
}
const MOCK = env.MOCK_PRICES ? JSON.parse(env.MOCK_PRICES) : null;
async function getQuote(sym) {
  if (MOCK) {
    if (!(sym in MOCK)) throw Object.assign(new Error("ticker not found"), { notFound: true });
    return { price: Number(MOCK[sym]), source: "mock", currency: MARKETS[marketOf(sym)].currency, prevClose: null, quoteTime: null, openBySource: null };
  }
  const errors = [];
  try { return await fromYahoo(sym); } catch (e) { errors.push(e.message); if (e.notFound) { try { return await fromGoogle(sym); } catch {} throw e; } }
  try { return await fromGoogle(sym); } catch (e) { errors.push(e.message); }
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
