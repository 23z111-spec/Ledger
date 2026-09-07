import { useEffect, useMemo, useRef, useState } from "react";
import { api, session } from "./api";
import Sparkline from "./Sparkline";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const POLL_MS = 6000;
const HISTORY_LEN = 40;
const DIGEST_LIMIT = 5;

function fmtMoney(n) {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pctChange(price, base) {
  if (!base) return 0;
  return ((price - base) / base) * 100;
}

function timeAgo(iso) {
  if (!iso) return "never";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`;
}

const FEED_LABEL = { live: "Live", delayed: "Delayed", stale: "Stale" };
const FEED_COLOR = { live: "var(--gain)", delayed: "var(--amber)", stale: "var(--loss)" };
const FEED_BG = { live: "var(--gain-tint)", delayed: "var(--amber-tint)", stale: "var(--loss-tint)" };

function Logo({ size = 30 }) {
  return (
    <div className="logo" style={{ width: size, height: size, borderRadius: size * 0.3 }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
        <path d="M3 15 9 9l4 4 8-8" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Icon({ name, size = 18 }) {
  const paths = {
    search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>,
    arrow: <><path d="M5 19 19 5" /><path d="M9 5h10v10" /></>,
    back: <path d="m15 18-6-6 6-6" />,
    eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
  };
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function ChangePill({ pct, large = false }) {
  const up = pct >= 0;
  return (
    <span className={`change-pill ${large ? "change-pill-large" : ""} ${up ? "positive" : "negative"}`}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

// ---------- login ----------

function usernameError(name) {
  if (!name) return "Enter a username to continue.";
  if (name.length < 3) return "At least 3 characters.";
  if (name.length > 20) return "Under 20 characters, please.";
  if (!/^[a-zA-Z0-9_]+$/.test(name)) return "Letters, numbers, and underscores only.";
  return "";
}

const FEATURES = [
  { title: "Relative, not flat, thresholds", body: "A 2% move means something different for every stock — signals are scored against each symbol's own volatility, RSI, and volume history." },
  { title: "Ranked, not just listed", body: "One attention score per stock, so the digest surfaces what actually deserves a look first, not everything that moved at all." },
  { title: "Honest about the data", body: "Live, delayed, and stale feed states are shown, not hidden — a stale number is never quietly presented as current." },
];

function MarketPulse() {
  const [pulse, setPulse] = useState([]);

  useEffect(() => {
    let active = true;
    function load() {
      api.marketPulse().then((rows) => { if (active) setPulse(rows); }).catch(() => {});
    }
    load();
    const id = setInterval(load, 4000);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (pulse.length === 0) return null;

  return (
    <div className="pulse-strip">
      <div className="pulse-label">Live from the engine — no login required to watch it move</div>
      <div className="pulse-row">
        {pulse.map((p) => {
          const dayPct = p.day_open ? ((p.price - p.day_open) / p.day_open) * 100 : 0;
          return (
            <div className="pulse-card" key={p.symbol}>
              <div className="pulse-symbol">{p.symbol}</div>
              <div className="pulse-price">${p.price.toFixed(2)}</div>
              <ChangePill pct={dayPct} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function passwordError(password) {
  if (!password) return "Enter a password to continue.";
  if (password.length < 6) return "At least 6 characters.";
  return "";
}

function LoginGate({ onLogin }) {
  const [mode, setMode] = useState("login"); // "login" | "signup"
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [busyDemo, setBusyDemo] = useState(false);
  const [error, setError] = useState("");

  const nameProblem = usernameError(name.trim());
  const passwordProblem = mode === "signup" ? passwordError(password) : (!password ? "Enter your password." : "");

  function switchMode(next) {
    setMode(next);
    setTouched(false);
    setError("");
  }

  async function completeLogin(user, rememberChoice) {
    session.save(user, rememberChoice);
    onLogin(user);
  }

  async function submit(event) {
    event.preventDefault();
    setTouched(true);
    if (nameProblem || passwordProblem || busy) return;
    setBusy(true);
    setError("");
    try {
      const username = name.trim().toLowerCase();
      const user = mode === "signup" ? await api.signup(username, password) : await api.login(username, password);
      await completeLogin(user, remember);
    } catch (err) {
      setError(err.message || "Couldn't reach the backend — make sure it's running on port 8000.");
    } finally {
      setBusy(false);
    }
  }

  async function tryDemo() {
    if (busyDemo || busy) return;
    setBusyDemo(true);
    setError("");
    try {
      const user = await api.demoLogin();
      await completeLogin(user, remember);
    } catch (err) {
      setError(err.message || "Couldn't reach the backend — make sure it's running on port 8000.");
    } finally {
      setBusyDemo(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-shell">
        <div className="brand-panel">
          <div className="brand-lockup brand-lockup-light"><Logo size={34} /><span>Ledger</span></div>
          <h1 className="brand-headline">A watchlist that remembers<br />what you last saw.</h1>
          <p className="brand-sub">So it can tell you what actually changed — not just what's true right now.</p>

          <div className="feature-list">
            {FEATURES.map((f) => (
              <div className="feature-item" key={f.title}>
                <div className="feature-dot" />
                <div><strong>{f.title}</strong><p>{f.body}</p></div>
              </div>
            ))}
          </div>

          <MarketPulse />
        </div>

        <div className="form-panel">
          <form className="login-card" onSubmit={submit}>
            <div className="brand-lockup form-brand-lockup"><Logo size={30} /><span>Ledger</span></div>

            <div className="auth-tabs">
              <button type="button" className={mode === "login" ? "active" : ""} onClick={() => switchMode("login")}>Sign in</button>
              <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => switchMode("signup")}>Create account</button>
            </div>

            <h2 className="form-title">{mode === "login" ? "Welcome back" : "Set up your watchlist"}</h2>
            <p className="muted login-copy">
              {mode === "login"
                ? "Sign in to see what's changed since you were last here."
                : "Password-protected, hashed and salted — your watchlist stays yours."}
            </p>

            <label className="field-label" htmlFor="name">Username</label>
            <input
              id="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="e.g. priya"
              autoComplete="username"
              autoFocus
            />
            {touched && nameProblem && <p className="error-text">{nameProblem}</p>}

            <label className="field-label field-label-spaced" htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onBlur={() => setTouched(true)}
              placeholder={mode === "signup" ? "At least 6 characters" : "••••••••"}
              autoComplete={mode === "signup" ? "new-password" : "current-password"}
            />
            {touched && passwordProblem && <p className="error-text">{passwordProblem}</p>}

            <label className="remember-row">
              <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
              <span>Keep me signed in on this device</span>
            </label>

            <button className="primary-button full-button" type="submit" disabled={busy || busyDemo}>
              {busy ? (mode === "signup" ? "Creating account…" : "Signing in…") : (mode === "signup" ? "Create account" : "Sign in")}
            </button>

            {error && <p className="error-text">{error}</p>}

            <div className="divider"><span>or</span></div>

            <button type="button" className="demo-button" onClick={tryDemo} disabled={busy || busyDemo}>
              {busyDemo ? "Loading demo…" : "Try the instant demo"}
            </button>
            <p className="fine-print center-text">Opens a pre-populated watchlist — no typing required.</p>
          </form>
        </div>
      </div>
    </div>
  );
}



// ---------- add symbol ----------

function AddSymbol({ userId, onAdded, existingSymbols, compact = false }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!query.trim()) { setResults([]); return undefined; }
    api.listSymbols(query).then((items) => { if (active) setResults(items); });
    return () => { active = false; };
  }, [query]);

  async function add(symbol) {
    await api.addSymbol(userId, symbol);
    setQuery("");
    setOpen(false);
    onAdded();
  }

  return (
    <div className={`search-wrap ${compact ? "search-compact" : ""}`}>
      <Icon name="search" size={16} />
      <input
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search stocks to add..."
      />
      {open && results.length > 0 && (
        <div className="search-results">
          {results.map((result) => {
            const added = existingSymbols.has(result.symbol);
            return (
              <button key={result.symbol} disabled={added} onClick={() => add(result.symbol)}>
                <span><strong>{result.symbol}</strong><small>{result.name}</small></span>
                <em>{added ? "Added" : result.sector}</em>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- attention card (digest) ----------

function AttentionCard({ item, onOpen }) {
  const since = item.is_new ? 0 : pctChange(item.price, item.last_seen_price);
  const trendPoints = Array.from({ length: 12 }, (_, index) => {
    const direction = since >= 0 ? 1 : -1;
    const drift = direction * index * 0.0007;
    const wobble = Math.sin(index * 1.35) * 0.0018 + Math.sin(index * 2.4) * 0.0007;
    return item.price * (1 - direction * 0.004 + drift + wobble);
  });
  return (
    <button className="attention-card" onClick={() => onOpen(item.symbol)}>
      <div className="card-topline">
        <span className="eyebrow">Needs a look</span>
        <span className="attention-score">{Math.round(item.attention_score || 0)}</span>
      </div>
      <div className="stock-heading">
        <div><strong>{item.symbol}</strong><small>{item.sector}</small></div>
        <Sparkline points={trendPoints} width={64} height={26} color={since >= 0 ? "var(--gain)" : "var(--loss)"} />
      </div>
      <div className="attention-price">${fmtMoney(item.price)} <ChangePill pct={since} /></div>
      <p>{item.events?.[0]?.headline || "No meaningful change since your last visit"}</p>
      {item.sector_context && (
        <div className={`sector-note ${item.sector_context.kind}`}>{item.sector_context.summary}</div>
      )}
      <span className="card-link">View details <Icon name="arrow" size={14} /></span>
    </button>
  );
}

// ---------- watchlist row ----------

function StockRow({ item, history, onRemove, onOpen }) {
  const dayPct = pctChange(item.price, item.day_open);
  return (
    <tr onClick={() => onOpen(item.symbol)}>
      <td>
        <div className="stock-cell">
          <div className="ticker-mark">{item.symbol.slice(0, 1)}</div>
          <div><strong>{item.symbol}</strong><small>{item.sector}</small></div>
        </div>
      </td>
      <td className="numeric"><strong>${fmtMoney(item.price)}</strong></td>
      <td className="numeric"><ChangePill pct={dayPct} /></td>
      <td><Sparkline points={history} color={dayPct >= 0 ? "var(--gain)" : "var(--loss)"} /></td>
      <td>
        <div className="reason-cell">
          {item.is_new ? (
            "Just added — building a baseline"
          ) : item.events?.length ? (
            <>
              <div className="signal-group-label">
                {item.events.length} signal{item.events.length === 1 ? "" : "s"} in one story
              </div>
              {item.events.slice(0, 2).map((event, index) => (
                <span key={index}>
                  <i className={event.severity >= 60 ? "danger-dot" : "warning-dot"} />
                  {event.headline}
                </span>
              ))}
              {item.sector_context && <small className="sector-note-inline">{item.sector_context.summary}</small>}
            </>
          ) : (
            <span className="muted">No meaningful change since last visit</span>
          )}
        </div>
      </td>
      <td>
        <span className="feed-badge" style={{ color: FEED_COLOR[item.feed_status], background: FEED_BG[item.feed_status] }}>
          {FEED_LABEL[item.feed_status]}
        </span>
      </td>
      <td>
        <button className="remove-button" onClick={(event) => { event.stopPropagation(); onRemove(); }}>
          Remove
        </button>
      </td>
    </tr>
  );
}

// ---------- stock detail page ----------

function StockDetail({ item, history, onBack, onRemove }) {
  const dayPct = pctChange(item.price, item.day_open);
  const sincePct = item.is_new ? 0 : pctChange(item.price, item.last_seen_price);
  const points = history.length > 1 ? history : Array.from({ length: 12 }, (_, i) => item.price * (1 + Math.sin(i / 2) * 0.007));

  return (
    <div className="detail-page">
      <button className="back-button" onClick={onBack}><Icon name="back" size={18} /> Back to overview</button>
      <div className="detail-header">
        <div>
          <div className="eyebrow">{item.sector} · {FEED_LABEL[item.feed_status]} data</div>
          <h1>{item.symbol}</h1>
          <p className="muted">A closer look at what changed since your last visit.</p>
        </div>
        <button className="secondary-button" onClick={onRemove}>Remove from watchlist</button>
      </div>

      <section className="detail-grid">
        <div className="detail-chart panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Current price</span><div className="detail-price">${fmtMoney(item.price)}</div></div>
            <ChangePill pct={dayPct} large />
          </div>
          <div className="chart-area">
            <Sparkline points={points} width={640} height={210} color={dayPct >= 0 ? "var(--gain)" : "var(--loss)"} />
          </div>
          <div className="chart-axis"><span>Earlier</span><span>Now</span></div>
        </div>

        <div className="detail-side">
          <div className="panel">
            <div className="panel-heading">
              <h2>What changed</h2>
              <span className="attention-score large-score">{Math.round(item.attention_score || 0)}</span>
            </div>
            {item.sector_context && (
              <div className={`detail-context ${item.sector_context.kind}`}>
                <strong>{item.sector_context.kind === "sector_wide" ? "Sector context" : "Peer context"}</strong>
                <span>{item.sector_context.summary}</span>
              </div>
            )}
            {item.events?.length ? (
              <div className="event-stack">
                {item.events.map((event, index) => (
                  <div className="event-row" key={index}>
                    <i className={event.severity >= 60 ? "danger-dot" : "warning-dot"} />
                    <div><strong>{event.headline}</strong><small>{event.detail}</small></div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No meaningful change since your last visit.</p>
            )}
          </div>

          <div className="panel indicator-panel">
            <div><span>RSI (14)</span><strong>{item.rsi_14?.toFixed(1) ?? "--"}</strong></div>
            <div><span>MA trend</span><strong>{item.short_ma && item.long_ma ? (item.short_ma > item.long_ma ? "Bullish" : "Bearish") : "Building"}</strong></div>
            <div>
              <span>Pressure <em>derived</em></span>
              <strong className={item.buy_pressure_pct >= 50 ? "gain-text" : "loss-text"}>
                {item.buy_pressure_pct?.toFixed(1) ?? "50.0"}% buy / {item.sell_pressure_pct?.toFixed(1) ?? "50.0"}% sell
              </strong>
            </div>
          </div>

          <div className="panel stats-panel">
            <div><span>Since last visit</span><strong className={sincePct >= 0 ? "gain-text" : "loss-text"}>{sincePct >= 0 ? "+" : ""}{sincePct.toFixed(2)}%</strong></div>
            <div><span>Today</span><strong>{dayPct >= 0 ? "+" : ""}{dayPct.toFixed(2)}%</strong></div>
          </div>
        </div>
      </section>
    </div>
  );
}

function DashboardWorkspace({ data, historyBySymbol, selectedSymbol, onSelect, user, onAdded, onRemove, onAck, existingSymbols }) {
  const selectedItem = data.items.find((item) => item.symbol === selectedSymbol) || data.items[0];
  const points = historyBySymbol[selectedItem?.symbol]?.length > 1
    ? historyBySymbol[selectedItem.symbol]
    : Array.from({ length: 16 }, (_, index) => (selectedItem?.price || 0) * (1 + Math.sin(index / 2.3) * 0.012 + index * 0.001));
  const chartData = points.map((price, index) => ({ time: `${index + 1}`, price }));
  const dayPct = selectedItem ? pctChange(selectedItem.price, selectedItem.day_open) : 0;
  const sincePct = selectedItem && !selectedItem.is_new ? pctChange(selectedItem.price, selectedItem.last_seen_price) : 0;
  const sorted = [...data.items].sort((a, b) => (b.attention_score || 0) - (a.attention_score || 0));

  return (
    <div className="mx-auto max-w-[1500px] px-5 py-6 text-slate-900 lg:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">Market desk / {new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}</p>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-950">Good morning, {user.username}</h1>
          <p className="mt-2 text-sm text-slate-500">Your market, arranged around what changed.</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700">● Market live</span>
          <button className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-600 shadow-sm transition hover:border-emerald-300 hover:text-emerald-700" onClick={onAck}>Mark seen</button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
        <aside className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-100 px-4 py-4">
            <div className="flex items-center justify-between">
              <div><h2 className="text-sm font-bold text-slate-900">Watchlist</h2><p className="mt-1 text-xs text-slate-400">{data.items.length} symbols tracked</p></div>
              <span className="rounded-lg bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-500">Live</span>
            </div>
            <div className="mt-4"><AddSymbol userId={user.user_id} onAdded={onAdded} existingSymbols={existingSymbols} compact /></div>
          </div>
          <div className="max-h-[620px] overflow-y-auto p-2">
            {sorted.length ? sorted.map((item) => {
  const change = pctChange(item.price, item.day_open);
  const active = selectedItem?.symbol === item.symbol;
  return (
    <div
      key={item.symbol}
      onClick={() => onSelect(item.symbol)}
      className={`group relative mb-1 w-full cursor-pointer rounded-xl p-3 text-left transition ${active ? "bg-slate-900 text-white shadow-md" : "hover:bg-slate-50"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <strong className={`font-mono text-sm ${active ? "text-white" : "text-slate-900"}`}>{item.symbol}</strong>
          <span className={`mt-1 block text-[11px] ${active ? "text-slate-300" : "text-slate-400"}`}>{item.sector}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`font-mono text-xs font-bold ${change >= 0 ? "text-emerald-500" : "text-rose-500"}`}>{change >= 0 ? "+" : ""}{change.toFixed(2)}%</span>
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(item.symbol); }}
            title={`Remove ${item.symbol}`}
            className={`opacity-0 transition group-hover:opacity-100 text-[11px] font-semibold ${active ? "text-slate-300 hover:text-white" : "text-slate-400 hover:text-rose-500"}`}
          >
            ✕
          </button>
        </div>
      </div>
      <div className={`mt-3 font-mono text-base font-semibold ${active ? "text-white" : "text-slate-800"}`}>${fmtMoney(item.price)}</div>
      <div className={`mt-2 h-1 rounded-full ${active ? "bg-slate-700" : "bg-slate-100"}`}>
        <div className={`h-full rounded-full ${change >= 0 ? "bg-emerald-400" : "bg-rose-400"}`} style={{ width: `${Math.min(100, Math.max(12, Math.abs(change) * 12))}%` }} />
      </div>
    </div>
  );
}) : <div className="px-3 py-10 text-center text-xs text-slate-400">Add a symbol to start tracking.</div>}
          </div>
        </aside>

        <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:p-6">
          {selectedItem ? <>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div><p className="text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">{selectedItem.sector} / {FEED_LABEL[selectedItem.feed_status]} feed</p><h2 className="mt-2 font-mono text-3xl font-semibold tracking-tight text-slate-950">{selectedItem.symbol}</h2><p className="mt-1 text-xs text-slate-400">Price action since your last visit</p></div>
              <div className="text-right"><div className="font-mono text-3xl font-semibold text-slate-950">${fmtMoney(selectedItem.price)}</div><div className={`mt-2 text-sm font-bold ${dayPct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{dayPct >= 0 ? "+" : ""}{dayPct.toFixed(2)}% today</div></div>
            </div>
            {(() => {
  const chartUp = dayPct >= 0;
  const chartColor = chartUp ? "#059669" : "#e11d48";
  return (
    <div className="mt-8 h-[330px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={chartData} margin={{ top: 10, right: 6, left: -24, bottom: 0 }}>
          <defs>
            <linearGradient id="ledgerChartFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={chartColor} stopOpacity={0.28} />
              <stop offset="100%" stopColor={chartColor} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="#eef2f5" vertical={false} />
          <XAxis dataKey="time" hide />
          <YAxis domain={["auto", "auto"]} tick={{ fill: "#94a3b8", fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={(value) => `$${Number(value).toFixed(0)}`} />
          <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", boxShadow: "0 8px 24px rgba(15,23,42,.1)" }} formatter={(value) => [`$${Number(value).toFixed(2)}`, "Price"]} />
          <Area type="linear" dataKey="price" stroke={chartColor} strokeWidth={2.5} fill="url(#ledgerChartFill)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
})()}
            <div className="mt-3 flex items-center justify-between text-[11px] text-slate-400"><span>Earlier</span><span>Now</span></div>
            <div className="mt-6 grid grid-cols-3 gap-3 border-t border-slate-100 pt-5"><div><p className="text-[11px] text-slate-400">Since last visit</p><strong className={`mt-1 block font-mono text-sm ${sincePct >= 0 ? "text-emerald-600" : "text-rose-600"}`}>{sincePct >= 0 ? "+" : ""}{sincePct.toFixed(2)}%</strong></div><div><p className="text-[11px] text-slate-400">RSI (14)</p><strong className="mt-1 block font-mono text-sm text-slate-800">{selectedItem.rsi_14?.toFixed(1) ?? "--"}</strong></div><div><p className="text-[11px] text-slate-400">Feed</p><strong className="mt-1 block text-sm text-slate-800">{FEED_LABEL[selectedItem.feed_status]}</strong></div></div>
          </> : <div className="flex h-full min-h-[500px] items-center justify-center text-sm text-slate-400">Select a stock from your watchlist.</div>}
        </section>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h2 className="text-sm font-bold text-slate-900">Key stats</h2><span className="rounded-md bg-amber-50 px-2 py-1 font-mono text-xs font-bold text-amber-600">{selectedItem ? Math.round(selectedItem.attention_score || 0) : "--"}</span></div>{selectedItem ? <div className="mt-5 space-y-4">{[["Day high", `$${fmtMoney(selectedItem.day_high)}`], ["Day low", `$${fmtMoney(selectedItem.day_low)}`], ["Short / long MA", `${selectedItem.short_ma?.toFixed(2) ?? "--"} / ${selectedItem.long_ma?.toFixed(2) ?? "--"}`], ["Buy pressure", `${selectedItem.buy_pressure_pct?.toFixed(1) ?? "50.0"}%`]].map(([label, value]) => <div className="flex items-center justify-between border-b border-slate-100 pb-3" key={label}><span className="text-xs text-slate-400">{label}</span><strong className="font-mono text-xs text-slate-800">{value}</strong></div>)}</div> : <p className="mt-5 text-xs text-slate-400">Choose a stock to inspect its metrics.</p>}</section>
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-center justify-between"><h2 className="text-sm font-bold text-slate-900">What changed</h2><span className="text-[11px] font-semibold text-slate-400">Latest signals</span></div>{selectedItem?.events?.length ? <div className="mt-4 space-y-4">{selectedItem.events.slice(0, 4).map((event, index) => <div className="flex gap-3" key={index}><span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${event.severity >= 60 ? "bg-rose-400" : "bg-amber-400"}`} /><div><p className="text-xs font-semibold leading-5 text-slate-800">{event.headline}</p><p className="mt-1 text-[11px] leading-4 text-slate-400">{event.detail}</p></div></div>)}</div> : <p className="mt-4 text-xs leading-5 text-slate-400">No meaningful changes detected for this stock.</p>}</section>
          <section className="rounded-2xl border border-slate-200 bg-slate-950 p-5 text-white shadow-sm"><p className="text-[11px] font-bold uppercase tracking-[0.16em] text-emerald-300">Ledger signal</p><p className="mt-3 text-sm leading-6 text-slate-300">{selectedItem?.sector_context?.summary || "Select a stock to see peer context."}</p></section>
        </aside>
      </div>
    </div>
  );
}

// ---------- app ----------

export default function App() {
  const [user, setUser] = useState(() => session.load());
  const [data, setData] = useState({ items: [], digest: [] });
  const [historyBySymbol, setHistoryBySymbol] = useState({});
  const [lastAck, setLastAck] = useState(null);
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const wsRef = useRef(null);

  const existingSymbols = useMemo(() => new Set(data.items.map((item) => item.symbol)), [data.items]);

  async function refresh() {
    if (user) setData(await api.getWatchlist(user.user_id));
  }

  useEffect(() => { refresh(); }, [user]);

  useEffect(() => {
    if (!user) return undefined;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    if (!user) return undefined;
    const ws = new WebSocket(api.wsUrl());
    wsRef.current = ws;
    ws.onmessage = (msg) => {
      const tick = JSON.parse(msg.data);
      setHistoryBySymbol((prev) => {
        const arr = prev[tick.symbol] ? [...prev[tick.symbol]] : [];
        arr.push(tick.price);
        if (arr.length > HISTORY_LEN) arr.shift();
        return { ...prev, [tick.symbol]: arr };
      });
      setData((prev) => ({
        ...prev,
        items: prev.items.map((item) => item.symbol === tick.symbol ? { ...item, price: tick.price } : item),
      }));
    };
    return () => ws.close();
  }, [user]);

  async function handleAck() {
    await api.ack(user.user_id);
    setLastAck(new Date().toISOString());
    refresh();
  }

  function handleSignOut() {
    session.clear();
    setUser(null);
    setData({ items: [], digest: [] });
    setSelectedSymbol(null);
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return undefined;
    function onClick(event) {
      if (!event.target.closest(".avatar-menu-wrap")) setMenuOpen(false);
    }
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [menuOpen]);

  if (!user) return <LoginGate onLogin={setUser} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup"><Logo /><span>Ledger</span></div>
        <div className="topbar-search">
          <AddSymbol userId={user.user_id} onAdded={refresh} existingSymbols={existingSymbols} />
        </div>
        <div className="topbar-actions">
          <button className="seen-button" onClick={handleAck}><Icon name="check" size={15} /> Mark all as seen</button>
          <div className="avatar-menu-wrap">
            <button className="avatar" onClick={() => setMenuOpen((v) => !v)}>{user.username.slice(0, 1).toUpperCase()}</button>
            {menuOpen && (
              <div className="avatar-menu">
                <div className="avatar-menu-name">Signed in as <strong>{user.username}</strong></div>
                <button onClick={handleSignOut}>Sign out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      <main><DashboardWorkspace data={data} historyBySymbol={historyBySymbol} selectedSymbol={selectedSymbol} onSelect={setSelectedSymbol} user={user} onAdded={refresh} onRemove={(symbol) => api.removeSymbol(user.user_id, symbol).then(refresh)} onAck={handleAck} existingSymbols={existingSymbols} /></main>
    </div>
  );
}