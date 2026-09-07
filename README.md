# Ledger — a watchlist that tells you what changed, not just what's true

Built for CODE 2026 (Groww).

## Live deployment

- ✅ GitHub — latest code pushed
- ✅ Render — FastAPI backend live
- ✅ Finnhub — API key configured
- ✅ Vercel — frontend live
- ✅ `VITE_API_URL` — correctly points to Render
- ✅ Login/API connection — verified working end to end

**Live app:** [https://ledger-zeta-eosin.vercel.app/](https://ledger-zeta-eosin.vercel.app/)

## The bet this build makes

Every obvious version of this brief renders a table of current prices and calls the "what changed" requirement done with a green/red arrow. That's not actually answering the question — it's showing state, not change, and it treats every stock's moves as equally meaningful. This build treats "what deserves your attention" as the actual product, and current price as supporting detail.

## What counts as a "meaningful change" (`backend/app/change_engine.py`)

Seven signal types, each scored against the symbol's own recent behavior, not a flat threshold:

| Signal | Why relative, not absolute |
|---|---|
| **Price move since last seen** | A 2% move means nothing for a small-cap that swings 4% on a quiet day, and everything for a low-volatility utility stock. Severity is the move expressed in multiples of that symbol's own typical tick-to-tick volatility, not a fixed percentage. |
| **Volume spike** | Compared against that symbol's own trailing average volume (flags above 1.4x), not a fixed number. |
| **Level cross** | Crossing yesterday's close, or a period high/low, is structurally meaningful regardless of the percentage — it's a threshold other market participants also watch. |
| **Feed reliability** | If the data itself went delayed or stale, that's information the user needs even if the price looks unchanged — silently showing a stale number as if it were live is its own kind of misleading. |
| **RSI regime change** | Flags the *moment* RSI(14) freshly crosses into overbought (≥70) or oversold (≤30) since the user's last visit — not "it's currently overbought," which would re-flag every visit for as long as it stays there. |
| **Moving-average cross** | A golden cross (10-period MA crossing above the 30-period) or death cross (crossing below) since last seen — a classic trend-change signal. |
| **Buy-pressure shift** | A derived buy/sell pressure proxy (from tick direction × volume) that only fires when the skew is both significant (≥15 points from 50/50) *and new* since the last visit — a stock that was already skewed the same direction last time isn't re-flagged. |

These combine into one 0–100 attention score per symbol: the single strongest signal, plus a diminishing (25%) contribution from every other signal present, so three weak signals don't outrank one strong one. New watchlist additions score 0 until there's a baseline to compare against. The "Since you last checked" digest is this score, ranked, filtered to ≥25 — not a chronological feed, not every stock that moved at all.

**Sector context**, shown alongside each stock's own signals: whether its move is shared by its sector peers (e.g. "Sector-wide move: 4 of 5 Technology names are moving up") or unusual for its sector. Peers don't have a personal "last seen" snapshot for the current viewer, so their direction is approximated from their own short/long moving-average trend — a deliberately separate, self-consistent basis from the viewer's own "since you checked" comparison, rather than silently mixing two different timeframes.

Deliberately not included: a persistent order book, cross-asset correlation, and alerts firing on every tick — all real extensions, cut to keep the shipped signal set legible and testable rather than a black box.

## What information is surfaced

Per row: price, today's % change, a trend line, and — the actual point of the app — the specific reason(s) it's flagged, in plain language ("down 9.9% since you last checked — 2.3x this symbol's usual move"), not just a number. The digest strip answers "what should I look at first"; the main dashboard answers "what's the full picture," with a dedicated detail view per stock showing RSI, moving-average trend, derived buy/sell pressure, and sector context.

## Auth and how state persists across sessions/devices

Users authenticate with a **username and password** (bcrypt-hashed, never stored or logged in plaintext). All state lives server-side in SQLite, keyed by that identity:

- the watchlist itself
- the last snapshot the user actually saw per symbol (price, volume, RSI, moving averages, buy pressure, timestamp)

Critically, the "last seen" snapshot only advances on an explicit **"Mark all as seen"** action, not on every page load — if it updated on load, refreshing the page would silently erase the diff you came back to see. Sign in with the same account on any device and the watchlist and its "since you last checked" state both follow you.

A one-click **"Try the instant demo"** button is also available for fast access (opens a pre-populated watchlist under a fixed demo account) — it does not bypass the real auth path, it only ever controls that single account.

Known, deliberate scope limit: requests after login aren't re-verified against a signed token (e.g. JWT) — the `user_id` is trusted as-is on each call, the same way an unsigned session cookie would be. Bearer-token issuance and verification middleware is the natural next increment, kept separate rather than silently bundled in.

## Live market data, and handling stale/delayed/conflicting data

Two data modes, switched automatically by whether `FINNHUB_API_KEY` is set (`backend/app/price_engine.py`):

- **With a Finnhub key**: real quotes (price, previous close, day open/high/low) are polled per symbol on a configurable interval (`FINNHUB_REFRESH_SECONDS`, default 30s).
- **Without one**: an in-memory simulator drives all 25 symbols across 6 sectors, so the app is fully runnable with zero external dependencies or signup friction.

Honest caveat: Finnhub's free tier doesn't return trading volume, so **volume-based signals (volume spike, buy-pressure shift) reflect the simulator's figures even in live mode** rather than real market volume. This is a deliberate trade-off for a free-tier data source, not an oversight — worth saying so out loud rather than letting a judge notice.

Whichever mode is active, every symbol's feed is classified as **live / delayed (>12s since last confirmed update) / stale (>40s)**, shown as a badge per row and folded directly into the attention score — so a stale price is never silently treated as a real market move. In simulator mode, feed problems are deliberately injected (each symbol has an independent random chance of lagging or dropping ticks) specifically to exercise this path in a demo.

Not implemented, and why: multi-source reconciliation (two feeds disagreeing) was scoped out to keep the shipped mechanism honest and testable rather than simulate a problem class a free data source can't actually produce. The staleness/delay handling generalizes directly to that case — a second feed disagreeing by more than its own noise band is the same "distrust this number and say so" pattern, with a comparison step added.

## How this scales

- Price data is O(symbols), not O(symbols × users) — one background loop updates an in-memory dict shared by everyone; watchlists just reference it. Adding the 10,000th user costs nothing extra here.
- Change computation is O(watchlist size), computed at read time per user. Cheap enough that it doesn't need pre-computation at this scale; the natural next step for very large user counts is a cache keyed by symbol (attention signals are identical for every user watching the same stock — only the "since you personally last saw it" comparison is per-user), computed once per tick and personalized at read time.
- Live prices push over one WebSocket topic, fanned out to all connected clients — adding a viewer adds load only to broadcast, the cheap part, not to the price engine itself.
- Not built: horizontal scaling, Redis pub-sub, a real message bus. The correct next step at real scale, deliberately not built for a hackathon demo running on one process — the architecture doesn't fight it, it just isn't needed yet.

## Where complexity was added vs. deliberately avoided

**Added:** relative (not absolute) thresholds for meaningfulness across seven distinct signal types, sector/peer context, feed-health tracking baked into the attention score, real password auth with hashed security-question recovery, an explicit ack/seen model instead of auto-marking on view.

**Avoided:** JWT/session-token verification, multi-source data reconciliation, a persistent order book / trading features, notifications/push, email-based password recovery — all real, all out of scope for "does this system understand what changed and say so clearly."

## Running it

**Backend**

```
cd backend
python -m venv venv && venv\Scripts\activate      # (source venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
```

Create a `.env` file in `backend/` (optional — the simulator runs fine without it):

```
FINNHUB_API_KEY=your_free_finnhub_key_here
FINNHUB_REFRESH_SECONDS=30
```

```
uvicorn app.main:app --reload --port 8001
```

**Frontend** (separate terminal)

```
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`). Create an account (or use "Try the instant demo"), add a few symbols, hit "Mark all as seen," then just wait — prices move on their own (live from Finnhub if configured, simulated otherwise). Refresh the page or come back later and the "Since you last checked" digest lights up. `POST /api/admin/roll-day` rolls the simulated trading day forward on demand, to demo the prior-close-cross signal without waiting.

## Known limitations at time of submission

- Dark mode has been designed (CSS variables + Tailwind `dark:` variants) but is **not yet merged** into the running app — the UI currently only renders in light mode.
- Volume-derived signals reflect simulated figures even when live Finnhub pricing is active (see "Live market data" above).
- Session trust is `user_id`-based, not a signed token — see "Auth" above for the scope decision.
- Backend endpoints for security-question-based password recovery exist (`/api/auth/forgot-password/question`, `/api/auth/reset-password`) but are not currently wired into the frontend signup/login forms — not a shipped feature yet, just groundwork.
