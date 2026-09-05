# Ledger — a watchlist that tells you what changed, not just what's true

Built for CODE 2026 (Groww).

## The bet this build makes

Every obvious version of this brief renders a table of current prices and calls the
"what changed" requirement done with a green/red arrow. That's not actually answering
the question — it's showing *state*, not *change*, and it treats every stock's moves
as equally meaningful. This build treats "what deserves your attention" as the actual
product, and current price as supporting detail.

## What counts as a "meaningful change" (`backend/app/change_engine.py`)

Four signal types, each scored against **the symbol's own recent behavior**, not a
flat threshold:

| Signal | Why relative, not absolute |
|---|---|
| **Price move since last seen** | A 2% move means nothing for a small-cap that swings 4% on a quiet day, and everything for a low-volatility utility stock. Severity is a z-score of the move against that symbol's own recent volatility. |
| **Volume spike** | Compared against that symbol's own trailing average volume, not a fixed number — 2x average means something different for a thinly-traded name vs. a mega-cap. |
| **Level cross** | Crossing yesterday's close or a period high/low is structurally meaningful regardless of the percentage — it's a threshold other market participants also watch. |
| **Feed reliability** | If the data itself went stale or delayed, that's information the user needs *even if the price looks unchanged* — silently showing a stale number as if it were live is its own kind of misleading. |

These combine into one 0–100 **attention score** per symbol (top signal + diminishing
contribution from the rest, so three weak signals don't outrank one strong one). The
"Since you last checked" digest at the top of the screen is this score, ranked —
not a chronological feed, not every stock that moved at all.

Deliberately *not* included: sentiment/news scoring, cross-asset correlation, and
alerts firing on every tick — all real extensions, cut to keep the actually-shipped
signal set legible and testable rather than a black box.

## What information is surfaced

Per row: price, today's % change, a short trend line, and — the actual point of the
app — the specific reason(s) it's flagged, in plain language ("down 9.9% since you
last checked — 2.3x this symbol's usual move"), not just a number. The digest strip
answers "what should I look at first"; the table answers "what's the full picture."

## How state persists across sessions/devices

A user is identified by a plain username (no password — intentionally out of scope
for a data/product hackathon, not overlooked). All state lives server-side in SQLite,
keyed off that identity:

- the watchlist itself
- **the last snapshot the user actually saw** per symbol (price, volume, timestamp)

Critically, the "last seen" snapshot only advances on an explicit **"Mark all as
seen"** action, not on every page load. If it updated on load, refreshing the page
would silently erase the diff you came back to see — the entire point of the feature
would disappear the moment you looked at it. Sign in with the same username on any
device and the watchlist and its "since you last checked" state both follow you.

*Production extension:* swap the username for real auth (JWT/OAuth); the schema
doesn't change.

## Handling stale, delayed, and conflicting data

Rather than assume a data feed is always clean, the simulator deliberately injects
feed problems: each symbol has an independent, random chance of its feed lagging or
dropping ticks entirely (`price_engine.py`). The system tracks the age of each
symbol's last real update and classifies it as `live` / `delayed` (>12s old) /
`stale` (>40s old), shown as a badge per row and folded into the attention score —
so a stale price doesn't get silently treated as a real market move.

*Not implemented, and why:* multi-source reconciliation (two feeds disagreeing) was
scoped out to keep the shipped mechanism honest and testable in a demo rather than
simulate a problem class that free data sources for a hackathon can't actually
produce. The staleness/delay handling generalizes directly to that case — a second
feed disagreeing by more than its own noise band is the same "distrust this number
and say so" pattern, just with a comparison step added.

## How this scales

- **Price simulation is O(symbols), not O(symbols × users).** One background loop
  updates an in-memory dict shared by everyone; watchlists just reference it. Adding
  the 10,000th user costs nothing extra here.
- **Change computation is O(watchlist size)**, computed at read time per user. Cheap
  enough that it doesn't need pre-computation at this scale, but the natural next
  step for very large user counts is a cache keyed by *symbol* (attention signals
  are the same for every user watching NEBUX; only the "since you personally last
  saw it" comparison is per-user) — computed once per tick, personalized at read
  time.
- **Live prices push over one WebSocket topic**, fanned out to all connected
  clients — adding a viewer doesn't add load on the price engine, only on
  broadcast, which is the cheap part.
- Not built: horizontal scaling / Redis pub-sub / a real message bus. Correct next
  step at real scale, deliberately not built for a hackathon demo running on one
  process — the architecture doesn't fight it, it just isn't needed yet.

## Where complexity was added vs. deliberately avoided

**Added:** relative (not absolute) thresholds for meaningfulness, feed-health
tracking, an explicit ack/seen model instead of auto-marking on view.
**Avoided:** real auth, multi-source data reconciliation, a persistent order book /
trading features, notifications/push — all real, all out of scope for "does this
system understand what changed and say so clearly."

## Running it

**Backend**
```bash
cd backend
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend** (separate terminal)
```bash
cd frontend
npm install
npm run dev
```

Open the frontend URL Vite prints (typically `http://localhost:5173`). Sign in with
any name, add a few symbols (try `NEBUX`, `VOLTA`, `TRUFI`), hit **"Mark all as
seen,"** then just wait — prices move on their own. Refresh the page or come back
later and the "Since you last checked" strip lights up. Use **"Simulate new trading
day"** in the sidebar to demo the prior-close-cross signal on demand.
