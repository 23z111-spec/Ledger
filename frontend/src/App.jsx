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
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const FEED_LABEL = { live: "Live", delayed: "Delayed", stale: "Stale" };
const FEED_COLOR = { live: "var(--gain)", delayed: "var(--amber)", stale: "var(--loss)" };
const FEED_BG = { live: "var(--gain-tint)", delayed: "var(--amber-tint)", stale: "var(--loss-tint)" };

function Logo({ size = 30 }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: size * 0.3, background: "var(--brand)",
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
    }}>
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none">
        <path d="M3 15 L9 9 L13 13 L21 5" stroke="white" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function ChangePill({ pct }) {
  const up = pct >= 0;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12.5, fontWeight: 600,
      padding: "3px 8px", borderRadius: 6, color: up ? "var(--gain)" : "var(--loss)",
      background: up ? "var(--gain-tint)" : "var(--loss-tint)",
    }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

// ---------- login ----------

function LoginGate({ onLogin }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setErr("");
    try {
      const user = await api.createUser(name.trim());
      localStorage.setItem("watchlist_user", JSON.stringify(user));
      onLogin(user);
    } catch (e2) {
      setErr("Couldn't reach the backend — is it running on port 8000?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
      background: "var(--canvas)", padding: 24,
    }}>
      <form onSubmit={submit} style={{
        width: 380, textAlign: "left", background: "var(--panel)", borderRadius: 14,
        padding: "36px 32px", boxShadow: "var(--shadow-card)", border: "1px solid var(--border)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 20 }}>
          <Logo size={34} />
          <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)" }}>Ledger</span>
        </div>
        <p style={{ color: "var(--text-muted)", fontSize: 14, lineHeight: 1.5, marginTop: 0, marginBottom: 24 }}>
          A watchlist that remembers what you last saw, so it can tell you what actually changed.
        </p>
        <label style={{ display: "block", fontSize: 13, color: "var(--text-muted)", marginBottom: 6, fontWeight: 500 }}>
          Pick a name to sign in with
        </label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. priya"
          style={{
            width: "100%", padding: "11px 14px", borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--canvas)", fontSize: 15, marginBottom: 14,
          }}
        />
        <button type="submit" disabled={busy} style={{
          width: "100%", padding: "11px 12px", borderRadius: 8, border: "none",
          background: "var(--brand)", color: "#ffffff", fontWeight: 600, fontSize: 14.5, cursor: "pointer",
        }}>
          {busy ? "Signing in…" : "Continue"}
        </button>
        {err && <p style={{ color: "var(--loss)", fontSize: 13, marginTop: 10 }}>{err}</p>}
        <p style={{ color: "var(--text-faint)", fontSize: 12, marginTop: 18, lineHeight: 1.5 }}>
          No password — this identifies your watchlist so it follows you across devices.
          Sign in with the same name anywhere to pick up where you left off.
        </p>
      </form>
    </div>
  );
}

// ---------- add symbol ----------

function AddSymbol({ userId, onAdded, existingSymbols }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    if (!q.trim()) { setResults([]); return; }
    api.listSymbols(q).then((r) => { if (active) setResults(r); });
    return () => { active = false; };
  }, [q]);

  async function add(sym) {
    await api.addSymbol(userId, sym);
    setQ("");
    setOpen(false);
    onAdded();
  }

  return (
    <div style={{ position: "relative", width: 320 }}>
      <div style={{ position: "relative" }}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" style={{
          position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none",
        }}>
          <circle cx="11" cy="11" r="7" stroke="#9aa0ab" strokeWidth="2" />
          <path d="M20 20L16.5 16.5" stroke="#9aa0ab" strokeWidth="2" strokeLinecap="round" />
        </svg>
        <input
          value={q}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Search & add a symbol"
          style={{
            width: "100%", padding: "9px 14px 9px 34px", borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--canvas)", fontSize: 13.5,
          }}
        />
      </div>
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

// ---------- app ----------

export default function App() {
  const [user, setUser] = useState(() => {
    const saved = localStorage.getItem("watchlist_user");
    return saved ? JSON.parse(saved) : null;
  });
  const [data, setData] = useState({ items: [], digest: [] });
  const [historyBySymbol, setHistoryBySymbol] = useState({});
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