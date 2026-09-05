import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import Sparkline from "./Sparkline";

const POLL_MS = 6000;
const HISTORY_LEN = 40;

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
  return <div className="logo" style={{ width: size, height: size, borderRadius: size * 0.3 }}><svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none"><path d="M3 15 9 9l4 4 8-8" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg></div>;
}

function ChangePill({ pct, large = false }) {
  const up = pct >= 0;
  return <span className={`change-pill ${large ? "change-pill-large" : ""} ${up ? "positive" : "negative"}`}>{up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%</span>;
}

function LoginGate({ onLogin }) {
  const [name, setName] = useState("");
  async function submit(event) { event.preventDefault(); if (!name.trim()) return; const user = await api.createUser(name.trim()); localStorage.setItem("watchlist_user", JSON.stringify(user)); onLogin(user); }
  return <div className="login-page"><form className="login-card" onSubmit={submit}><div className="brand-lockup"><Logo size={36} /><span>Ledger</span></div><p className="muted login-copy">A watchlist that remembers what you last saw, so it can tell you what actually changed.</p><label className="field-label" htmlFor="name">Pick a name to sign in with</label><input id="name" value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. priya" /><button className="primary-button full-button" type="submit">Continue</button><p className="fine-print">No password. This identifies your watchlist so it follows you across devices.</p></form></div>;
}

function AddSymbol({ userId, onAdded, existingSymbols, compact = false }) {
  const [query, setQuery] = useState(""); const [results, setResults] = useState([]); const [open, setOpen] = useState(false);
  useEffect(() => { let active = true; if (!query.trim()) { setResults([]); return undefined; } api.listSymbols(query).then((items) => { if (active) setResults(items); }); return () => { active = false; }; }, [query]);
  async function add(symbol) { await api.addSymbol(userId, symbol); setQuery(""); setOpen(false); onAdded(); }
  return <div className={`search-wrap ${compact ? "search-compact" : ""}`}><Icon name="search" size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search stocks to add..." />{open && results.length > 0 && <div className="search-results">{results.map((result) => { const added = existingSymbols.has(result.symbol); return <button key={result.symbol} disabled={added} onClick={() => add(result.symbol)}><span><strong>{result.symbol}</strong><small>{result.name}</small></span><em>{added ? "Added" : result.sector}</em></button>; })}</div>}</div>;
}

/* stale digest implementation retained below only as a source reference
      {open && results.length > 0 && (
        <div style={{
          position: "absolute", top: "calc(100% + 6px)", left: 0, right: 0, zIndex: 10,
          background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 10,
          maxHeight: 280, overflowY: "auto", boxShadow: "0 12px 28px rgba(23,26,33,0.12)",
        }}>
          {results.map((r) => {
            const already = existingSymbols.has(r.symbol);
            return (
              <button
                key={r.symbol}
                disabled={already}
                onClick={() => add(r.symbol)}
                style={{
                  display: "flex", justifyContent: "space-between", width: "100%", padding: "10px 14px",
                  background: "transparent", border: "none", textAlign: "left", cursor: already ? "default" : "pointer",
                  color: already ? "var(--text-faint)" : "var(--text)", fontSize: 13.5, borderBottom: "1px solid var(--border-soft)",
                }}
              >
                <span><strong style={{ fontFamily: "var(--font-mono)" }}>{r.symbol}</strong> — {r.name}</span>
                <span style={{ color: already ? "var(--text-faint)" : "var(--brand-dark)", fontWeight: 500, fontSize: 12 }}>
                  {already ? "Added" : r.sector}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

*/

// ---------- digest strip (Groww "index card" style) ----------

function DigestCard({ item, onFocusSymbol }) {
  const top = item.events[0];
  const sincePct = item.is_new ? 0 : pctChange(item.price, item.last_seen_price);
  return (
    <button
      onClick={() => onFocusSymbol(item.symbol)}
      style={{
        flex: "0 0 auto", width: 236, textAlign: "left", cursor: "pointer",
        background: "var(--panel)", border: "1px solid var(--border)",
        borderRadius: 12, padding: "16px 18px", boxShadow: "var(--shadow-card)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono)" }}>{item.symbol}</div>
          <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>{item.sector}</div>
        </div>
        <Sparkline points={Array.from({ length: 8 }, (_, i) => item.price * (1 + (i - 4) * 0.002))} width={56} height={22} color="var(--brand)" />
      </div>
      <div style={{ fontSize: 19, fontWeight: 700, marginBottom: 6 }}>₹{fmtMoney(item.price)}</div>
      <ChangePill pct={sincePct} />
      <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.4 }}>
        {top ? top.headline : "changed since you last checked"}
      </div>
    </button>
  );
}

function DigestStrip({ items, onFocusSymbol }) {
  if (items.length === 0) return null;
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 13.5, color: "var(--text)", fontWeight: 600, marginBottom: 12 }}>
        Since you last checked
        <span style={{ fontWeight: 400, color: "var(--text-muted)" }}> — ranked by what deserves attention</span>
      </div>
      <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 4 }}>
        {items.map((it) => <DigestCard key={it.symbol} item={it} onFocusSymbol={onFocusSymbol} />)}
      </div>
    </div>
  );
}

// ---------- watchlist table ----------

function Row({ item, history, onRemove, highlighted, rowRef }) {
  const dayPct = pctChange(item.price, item.day_open);
  const sparkColor = dayPct >= 0 ? "var(--gain)" : "var(--loss)";

  return (
    <tr ref={rowRef} style={{
      borderBottom: "1px solid var(--border-soft)",
      background: highlighted ? "var(--brand-tint)" : "transparent",
      transition: "background 1.2s ease",
    }}>
      <td style={{ padding: "14px 12px" }}>
        <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 14 }}>{item.symbol}</div>
        <div style={{ fontSize: 12, color: "var(--text-faint)" }}>{item.sector}</div>
      </td>
      <td style={{ padding: "14px 12px", textAlign: "right", fontFamily: "var(--font-mono)", fontWeight: 600, fontSize: 14 }}>
        ₹{fmtMoney(item.price)}
      </td>
      <td style={{ padding: "14px 12px", textAlign: "right" }}>
        <ChangePill pct={dayPct} />
      </td>
      <td style={{ padding: "14px 12px" }}>
        <Sparkline points={history} color={sparkColor} />
      </td>
      <td style={{ padding: "14px 12px", maxWidth: 320 }}>
        {item.is_new ? (
          <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>Just added — nothing to compare yet</span>
        ) : item.events.length === 0 ? (
          <span style={{ fontSize: 12.5, color: "var(--text-faint)" }}>No meaningful change since last visit</span>
        ) : (
          <div>
            {item.events.slice(0, 2).map((e, i) => (
              <div key={i} style={{ fontSize: 12.5, color: "var(--text)", marginBottom: 3, display: "flex", alignItems: "flex-start", gap: 6 }}>
                <span style={{
                  display: "inline-block", width: 6, height: 6, borderRadius: 3, marginTop: 5, flexShrink: 0,
                  background: e.severity >= 60 ? "var(--loss)" : e.severity >= 30 ? "var(--amber)" : "var(--text-faint)",
                }} />
                {e.headline}
              </div>
            ))}
          </div>
        )}
      </td>
      <td style={{ padding: "14px 12px" }}>
        <span style={{
          fontSize: 11.5, fontWeight: 600, padding: "4px 10px", borderRadius: 20,
          color: FEED_COLOR[item.feed_status], background: FEED_BG[item.feed_status],
        }}>
          {FEED_LABEL[item.feed_status]}
        </span>
      </td>
      <td style={{ padding: "14px 12px", textAlign: "right" }}>
        <button onClick={onRemove} style={{
          background: "transparent", border: "none", color: "var(--text-faint)", cursor: "pointer", fontSize: 13, fontWeight: 500,
        }} aria-label={`Remove ${item.symbol}`}>
          Remove
        </button>
      </td>
    </tr>
  );
}

function Icon({ name, size = 18 }) {
  const paths = { search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></>, arrow: <><path d="M5 19 19 5" /><path d="M9 5h10v10" /></>, back: <path d="m15 18-6-6 6-6" />, eye: <><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" /></>, check: <path d="m5 12 4 4L19 6" /> };
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}

function AttentionCard({ item, onOpen }) {
  const since = item.is_new ? 0 : pctChange(item.price, item.last_seen_price);
  const trendPoints = Array.from({ length: 12 }, (_, index) => {
    const direction = since >= 0 ? 1 : -1;
    const drift = direction * index * 0.0007;
    const movement = Math.sin(index * 1.35) * 0.0018 + Math.sin(index * 2.4) * 0.0007;
    return item.price * (1 - direction * 0.004 + drift + movement);
  });
  return <button className="attention-card" onClick={() => onOpen(item.symbol)}><div className="card-topline"><span className="eyebrow">{item.is_new ? "New on watchlist" : "Needs a look"}</span><span className="attention-score">{Math.round(item.attention_score || 0)}</span></div><div className="stock-heading"><div><strong>{item.symbol}</strong><small>{item.sector}</small></div><Sparkline points={trendPoints} width={64} height={26} color={since >= 0 ? "var(--gain)" : "var(--loss)"} /></div><div className="attention-price">₹{fmtMoney(item.price)} <ChangePill pct={since} /></div><p>{item.events?.[0]?.headline || "No meaningful change since your last visit"}</p>{item.sector_context && <div className={`sector-note ${item.sector_context.kind}`}>{item.sector_context.summary}</div>}<span className="card-link">View details <Icon name="arrow" size={14} /></span></button>;
}

function StockRow({ item, history, onRemove, onOpen }) {
  const dayPct = pctChange(item.price, item.day_open);
  return <tr onClick={() => onOpen(item.symbol)}><td><div className="stock-cell"><div className="ticker-mark">{item.symbol.slice(0, 1)}</div><div><strong>{item.symbol}</strong><small>{item.sector}</small></div></div></td><td className="numeric"><strong>₹{fmtMoney(item.price)}</strong></td><td className="numeric"><ChangePill pct={dayPct} /></td><td><Sparkline points={history} color={dayPct >= 0 ? "var(--gain)" : "var(--loss)"} /></td><td><div className="reason-cell">{item.is_new ? "Just added — building a baseline" : item.events?.length ? <><div className="signal-group-label">{item.events.length} signal{item.events.length === 1 ? "" : "s"} in one story</div>{item.events.slice(0, 2).map((event, index) => <span key={index}><i className={event.severity >= 60 ? "danger-dot" : "warning-dot"} />{event.headline}</span>)}{item.sector_context && <small className="sector-note-inline">{item.sector_context.summary}</small>}</> : <span className="muted">No meaningful change since last visit</span>}</div></td><td><span className="feed-badge" style={{ color: FEED_COLOR[item.feed_status], background: FEED_BG[item.feed_status] }}>{FEED_LABEL[item.feed_status]}</span></td><td><button className="remove-button" onClick={(event) => { event.stopPropagation(); onRemove(); }}>Remove</button></td></tr>;
}

function StockDetail({ item, history, onBack, onRemove }) {
  const dayPct = pctChange(item.price, item.day_open); const sincePct = item.is_new ? 0 : pctChange(item.price, item.last_seen_price); const points = history.length > 1 ? history : Array.from({ length: 12 }, (_, i) => item.price * (1 + Math.sin(i / 2) * 0.007));
  return <div className="detail-page"><button className="back-button" onClick={onBack}><Icon name="back" size={18} /> Back to overview</button><div className="detail-header"><div><div className="eyebrow">{item.sector} · {FEED_LABEL[item.feed_status]} data</div><h1>{item.symbol}</h1><p className="muted">A closer look at what changed since your last visit.</p></div><button className="secondary-button" onClick={onRemove}>Remove from watchlist</button></div><section className="detail-grid"><div className="detail-chart panel"><div className="panel-heading"><div><span className="eyebrow">Current price</span><div className="detail-price">₹{fmtMoney(item.price)}</div></div><ChangePill pct={dayPct} large /></div><div className="chart-area"><Sparkline points={points} width={640} height={210} color={dayPct >= 0 ? "var(--gain)" : "var(--loss)"} /></div><div className="chart-axis"><span>Earlier</span><span>Now</span></div></div><div className="detail-side"><div className="panel"><div className="panel-heading"><h2>What changed</h2><span className="attention-score large-score">{Math.round(item.attention_score || 0)}</span></div>{item.sector_context && <div className={`detail-context ${item.sector_context.kind}`}><strong>{item.sector_context.kind === "sector_wide" ? "Sector context" : "Peer context"}</strong><span>{item.sector_context.summary}</span></div>}{item.events?.length ? <div className="event-stack">{item.events.map((event, index) => <div className="event-row" key={index}><i className={event.severity >= 60 ? "danger-dot" : "warning-dot"} /><div><strong>{event.headline}</strong><small>{event.detail}</small></div></div>)}</div> : <p className="muted">No meaningful change since your last visit.</p>}</div><div className="panel stats-panel"><div><span>Since last visit</span><strong className={sincePct >= 0 ? "gain-text" : "loss-text"}>{sincePct >= 0 ? "+" : ""}{sincePct.toFixed(2)}%</strong></div><div><span>Today</span><strong>{dayPct >= 0 ? "+" : ""}{dayPct.toFixed(2)}%</strong></div></div></div></section></div>;
}

// ---------- app ----------

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("watchlist_user");
    return saved ? JSON.parse(saved) : null;
  });
  const [data, setData] = useState({ items: [], digest: [] });
  const [historyBySymbol, setHistoryBySymbol] = useState({});
  const [lastAck, setLastAck] = useState(null);
  const [selectedSymbol, setSelectedSymbol] = useState(null);
  const wsRef = useRef(null);
  const existingSymbols = useMemo(() => new Set(data.items.map((item) => item.symbol)), [data.items]);
  async function refresh() { if (user) setData(await api.getWatchlist(user.user_id)); }
  useEffect(() => { refresh(); }, [user]);
  useEffect(() => { if (!user) return undefined; const id = setInterval(refresh, POLL_MS); return () => clearInterval(id); }, [user]);
  useEffect(() => {
    if (!user) return undefined;
    const ws = new WebSocket(api.wsUrl()); wsRef.current = ws;
    ws.onmessage = (msg) => { const tick = JSON.parse(msg.data); setHistoryBySymbol((prev) => { const arr = prev[tick.symbol] ? [...prev[tick.symbol]] : []; arr.push(tick.price); if (arr.length > HISTORY_LEN) arr.shift(); return { ...prev, [tick.symbol]: arr }; }); setData((prev) => ({ ...prev, items: prev.items.map((item) => item.symbol === tick.symbol ? { ...item, price: tick.price } : item) })); };
    return () => ws.close();
  }, [user]);
  async function handleAck() { await api.ack(user.user_id); setLastAck(new Date().toISOString()); refresh(); }
  if (!user) return <LoginGate onLogin={setUser} />;
  const sorted = [...data.items].sort((a, b) => (b.attention_score || 0) - (a.attention_score || 0));
  const selectedItem = data.items.find((item) => item.symbol === selectedSymbol);
  const attentionCount = data.items.filter((item) => (item.attention_score || 0) > 30).length;
  return <div className="app-shell"><header className="topbar"><div className="brand-lockup"><Logo /><span>Ledger</span></div><div className="topbar-search"><AddSymbol userId={user.user_id} onAdded={refresh} existingSymbols={existingSymbols} /></div><div className="topbar-actions"><button className="seen-button" onClick={handleAck}><Icon name="check" size={15} /> Mark all as seen</button><div className="avatar">{user.username.slice(0, 1).toUpperCase()}</div></div></header>
    <main className="dashboard-content">{selectedItem ? <StockDetail item={selectedItem} history={historyBySymbol[selectedItem.symbol] || []} onBack={() => setSelectedSymbol(null)} onRemove={() => api.removeSymbol(user.user_id, selectedSymbol).then(() => { setSelectedSymbol(null); refresh(); })} /> : <>
      <section className="welcome-row"><div><div className="eyebrow">{new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div><h1>Welcome back, {user.username}</h1><p className="muted">Here’s what moved while you were away.</p></div><div className="welcome-stat"><span>Tracking</span><strong>{data.items.length} <small>stocks</small></strong></div></section>
      <section className="summary-banner"><div className="summary-icon"><Icon name="eye" size={21} /></div><div><strong>{attentionCount ? `${attentionCount} ${attentionCount === 1 ? "stock needs" : "stocks need"} your attention` : "Your watchlist is calm"}</strong><p>{attentionCount ? "Ranked by the significance of their movement since your last visit." : "No meaningful changes have been detected since your last visit."}</p></div><button className="text-button" onClick={handleAck}>Mark everything seen <Icon name="arrow" size={14} /></button></section>
      <div className="section-heading"><div><h2>Attention needed</h2><p>Signals ranked by what deserves a closer look.</p></div><span className="section-count">{data.digest.length} signals</span></div>
      {data.digest.length ? <section className="attention-grid">{data.digest.slice(0, 4).map((item) => <AttentionCard key={item.symbol} item={item} onOpen={setSelectedSymbol} />)}</section> : <div className="empty-state">Your watchlist is quiet. Add stocks below to start tracking meaningful changes.</div>}
      <section className="watchlist-section"><div className="section-heading"><div><h2>Your watchlist</h2><p>Current prices and the reason behind every flag.</p></div><AddSymbol userId={user.user_id} onAdded={refresh} existingSymbols={existingSymbols} compact /></div>
        {data.items.length ? <div className="table-wrap"><table><thead><tr>{["Stock", "Price", "Today", "Trend", "Since you checked", "Feed", ""].map((head, i) => <th className={i === 1 || i === 2 ? "numeric" : ""} key={head}>{head}</th>)}</tr></thead><tbody>{sorted.map((item) => <StockRow key={item.symbol} item={item} history={historyBySymbol[item.symbol] || []} onOpen={setSelectedSymbol} onRemove={() => api.removeSymbol(user.user_id, item.symbol).then(refresh)} />)}</tbody></table></div> : null}
        <div className="table-footer">{data.items.length} symbol{data.items.length === 1 ? "" : "s"} tracked · last marked as seen {lastAck ? timeAgo(lastAck) : "not yet"}</div>
      </section>
    </>}</main></div>;
  }
  /*
  const [lastAck, setLastAck] = useState(null);
  const [highlightSymbol, setHighlightSymbol] = useState(null);
  const rowRefs = useRef({});
  const wsRef = useRef(null);

  const existingSymbols = useMemo(() => new Set(data.items.map((i) => i.symbol)), [data.items]);

  async function refresh() {
    if (!user) return;
    const res = await api.getWatchlist(user.user_id);
    setData(res);
  }

  useEffect(() => { refresh(); }, [user]);

  useEffect(() => {
    if (!user) return;
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [user]);

  useEffect(() => {
    if (!user) return;
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
        items: prev.items.map((it) => it.symbol === tick.symbol ? { ...it, price: tick.price } : it),
      }));
    };
    return () => ws.close();
  }, [user]);

  async function handleAck() {
    await api.ack(user.user_id);
    setLastAck(new Date().toISOString());
    refresh();
  }

  function focusSymbol(sym) {
    setHighlightSymbol(sym);
    rowRefs.current[sym]?.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => setHighlightSymbol(null), 1600);
  }

  if (!user) return <LoginGate onLogin={setUser} />;

  const sorted = [...data.items].sort((a, b) => b.attention_score - a.attention_score);

  return (
    <div style={{ minHeight: "100vh", background: "var(--canvas)" }}>
      <header style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 32px", height: 64, background: "var(--panel)", borderBottom: "1px solid var(--border)",
        position: "sticky", top: 0, zIndex: 5,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo />
          <span style={{ fontSize: 18, fontWeight: 700 }}>Ledger</span>
        </div>
        <AddSymbol userId={user.user_id} onAdded={refresh} existingSymbols={existingSymbols} />
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <button
            onClick={() => api.rollDay().then(refresh)}
            style={{
              padding: "8px 14px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent",
              color: "var(--text-muted)", fontSize: 12.5, fontWeight: 500, cursor: "pointer",
            }}
            title="Demo helper: simulates the start of a new trading session"
          >
            Simulate new day
          </button>
          <button onClick={handleAck} style={{
            padding: "9px 18px", borderRadius: 8, border: "none", background: "var(--brand)",
            color: "#ffffff", fontWeight: 600, fontSize: 13.5, cursor: "pointer", whiteSpace: "nowrap",
          }}>
            Mark all as seen
          </button>
          <div style={{
            width: 32, height: 32, borderRadius: "50%", background: "var(--brand-tint)", color: "var(--brand-dark)",
            display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 13,
          }}>
            {user.username.slice(0, 1).toUpperCase()}
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1180, margin: "0 auto", padding: "28px 32px" }}>
        <div style={{ marginBottom: 22 }}>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Your watchlist</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
            Prices update continuously from a simulated live feed. "Since you last checked" only moves forward once you mark it seen.
          </div>
        </div>

        <DigestStrip items={data.digest} onFocusSymbol={focusSymbol} />

        {data.items.length === 0 ? (
          <div style={{
            border: "1px dashed var(--border)", borderRadius: 12, padding: "48px 24px", textAlign: "center",
            color: "var(--text-muted)", fontSize: 14, background: "var(--panel)",
          }}>
            Your watchlist is empty. Search for a symbol above to start tracking it.
          </div>
        ) : (
          <div style={{
            background: "var(--panel)", borderRadius: 12, border: "1px solid var(--border)",
            boxShadow: "var(--shadow-card)", overflow: "hidden",
          }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Symbol", "Price", "Today", "Trend", "Since you checked", "Feed", ""].map((h, i) => (
                    <th key={i} style={{
                      textAlign: i === 1 || i === 2 ? "right" : "left", padding: "12px 12px",
                      fontSize: 12, color: "var(--text-faint)", fontWeight: 600, background: "var(--canvas)",
                    }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sorted.map((item) => (
                  <Row
                    key={item.symbol}
                    item={item}
                    history={historyBySymbol[item.symbol] || []}
                    highlighted={highlightSymbol === item.symbol}
                    rowRef={(el) => { rowRefs.current[item.symbol] = el; }}
                    onRemove={() => api.removeSymbol(user.user_id, item.symbol).then(refresh)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ marginTop: 18, fontSize: 12, color: "var(--text-faint)" }}>
          {data.items.length} symbol{data.items.length === 1 ? "" : "s"} tracked · last marked as seen {lastAck ? timeAgo(lastAck) : "not yet"}
        </div>
      </main>
    </div>
  );
}
*/