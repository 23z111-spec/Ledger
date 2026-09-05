"""
Simulated market data feed.

Why simulated: real free market data APIs are heavily rate-limited and go
stale/behind paywalls fast, which would make the "handle stale/delayed
data" requirement fake (there'd be nothing to actually be stale). Instead
we simulate a realistic feed: each symbol has its own volatility regime,
occasional volume spikes, and a random chance of the feed for that symbol
lagging or dropping ticks entirely — so "staleness" is a real, testable
condition, not a hypothetical.

Everything here lives in-memory (fast, O(num_symbols) per tick, independent
of how many users or watchlists exist — see README for the scaling
rationale). Daily bars get flushed to SQLite periodically so restart
doesn't lose the volatility baseline.
"""
import asyncio
import random
import statistics
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone


SECTORS = {
    "Technology": ["NEBUX", "QUARK", "PIXNL", "CIRRA", "VOLTA"],
    "Finance": ["LEDGR", "TRUFI", "ASSET", "COINX"],
    "Healthcare": ["MEDIX", "GENOM", "CURAL"],
    "Energy": ["SOLEV", "HYDRA", "PETRX"],
    "Consumer": ["BREWD", "URBNW", "FRESH", "NOMAD"],
    "Industrials": ["FORGE", "TRACK", "STEEL"],
}

# Base volatility regime per symbol: (annualized-ish vol factor, base_price, avg_daily_volume)
random.seed(7)
UNIVERSE = {}
for sector, syms in SECTORS.items():
    for sym in syms:
        UNIVERSE[sym] = {
            "name": f"{sym.title()} {sector.split()[0]} Corp",
            "sector": sector,
            "base_price": round(random.uniform(15, 480), 2),
            "vol": round(random.uniform(0.006, 0.035), 4),  # per-tick stddev as fraction of price
            "avg_volume": random.randint(200_000, 8_000_000),
        }


@dataclass
class SymbolState:
    symbol: str
    price: float
    prev_close: float
    day_open: float
    day_high: float
    day_low: float
    period_high: float   # highest price seen since server start (stand-in for 52w high)
    period_low: float    # lowest price seen since server start
    volume_today: float = 0.0
    last_tick_volume: float = 0.0
    updated_at: float = field(default_factory=time.time)
    recent_returns: deque = field(default_factory=lambda: deque(maxlen=60))
    recent_volumes: deque = field(default_factory=lambda: deque(maxlen=30))
    feed_status: str = "live"      # live | delayed | stale
    feed_delay_until: float = 0.0  # if set, feed is "delayed" until this timestamp


class PriceEngine:
    def __init__(self):
        self.state: dict[str, SymbolState] = {}
        self._lock = asyncio.Lock()
        self._subscribers: list[asyncio.Queue] = []
        for sym, meta in UNIVERSE.items():
            p = meta["base_price"]
            self.state[sym] = SymbolState(
                symbol=sym, price=p, prev_close=p, day_open=p,
                day_high=p, day_low=p, period_high=p, period_low=p,
            )

    def symbols(self):
        return list(UNIVERSE.keys())

    def meta(self, symbol: str):
        return UNIVERSE.get(symbol)

    def snapshot(self, symbol: str) -> dict:
        s = self.state[symbol]
        meta = UNIVERSE[symbol]
        avg_vol = statistics.fmean(s.recent_volumes) if s.recent_volumes else meta["avg_volume"]
        vol_of_returns = statistics.pstdev(s.recent_returns) if len(s.recent_returns) >= 5 else meta["vol"]
        age = time.time() - s.updated_at
        status = s.feed_status
        if status == "live" and age > 12:
            status = "delayed"
        if status == "live" and age > 40:
            status = "stale"
        return {
            "symbol": symbol,
            "name": meta["name"],
            "sector": meta["sector"],
            "price": round(s.price, 2),
            "prev_close": round(s.prev_close, 2),
            "day_open": round(s.day_open, 2),
            "day_high": round(s.day_high, 2),
            "day_low": round(s.day_low, 2),
            "period_high": round(s.period_high, 2),
            "period_low": round(s.period_low, 2),
            "volume_today": round(s.volume_today),
            "avg_volume": round(avg_vol),
            "return_volatility": round(vol_of_returns, 5),
            "updated_at": datetime.fromtimestamp(s.updated_at, tz=timezone.utc).isoformat(),
            "feed_status": status,
            "age_seconds": round(age, 1),
        }

    def all_snapshots(self):
        return [self.snapshot(s) for s in self.state]

    async def subscribe(self) -> asyncio.Queue:
        q = asyncio.Queue(maxsize=200)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue):
        if q in self._subscribers:
            self._subscribers.remove(q)

    async def _broadcast(self, tick: dict):
        for q in list(self._subscribers):
            if not q.full():
                q.put_nowait(tick)

    async def run_forever(self, interval: float = 2.0):
        """Background loop: advance every symbol by one tick."""
        while True:
            await self._tick_all()
            await asyncio.sleep(interval)

    async def _tick_all(self):
        now = time.time()
        for sym, meta in UNIVERSE.items():
            s = self.state[sym]

            # --- simulate feed reliability: small chance a symbol's feed
            # starts lagging or drops out for a while, independent of price.
            if s.feed_status == "live" and random.random() < 0.004:
                s.feed_status = "delayed"
                s.feed_delay_until = now + random.uniform(15, 45)
            elif s.feed_status in ("delayed", "stale") and now > s.feed_delay_until:
                s.feed_status = "live"

            if s.feed_status != "live" and random.random() < 0.7:
                # skip updating this symbol's price this round -> it visibly ages/staleness
                continue

            # --- random-walk price with occasional fat-tail jump (news-like shock)
            shock = 1.0
            if random.random() < 0.015:
                shock = random.choice([3.5, 4.5])  # occasional outsized move
            pct_move = random.gauss(0, meta["vol"]) * shock
            new_price = max(0.5, s.price * (1 + pct_move))
            s.recent_returns.append(pct_move)

            s.price = new_price
            s.day_high = max(s.day_high, new_price)
            s.day_low = min(s.day_low, new_price)
            s.period_high = max(s.period_high, new_price)
            s.period_low = min(s.period_low, new_price)

            # --- volume: baseline + spike probability correlated with big moves
            base_tick_vol = meta["avg_volume"] / 200  # rough per-tick share of a day
            spike_factor = 1.0
            if abs(pct_move) > meta["vol"] * 2.2 or random.random() < 0.03:
                spike_factor = random.uniform(2.5, 6.0)
            tick_vol = max(0, random.gauss(base_tick_vol, base_tick_vol * 0.3)) * spike_factor
            s.last_tick_volume = tick_vol
            s.volume_today += tick_vol
            s.recent_volumes.append(tick_vol * 200)  # scale back to "daily-equivalent" for averaging

            s.updated_at = now

            await self._broadcast({
                "type": "tick",
                "symbol": sym,
                "price": round(s.price, 2),
                "pct_move": round(pct_move * 100, 3),
                "feed_status": s.feed_status,
                "ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
            })

    def roll_new_day(self):
        """Reset day_open/high/low to simulate a new trading session (called
        on a timer or manually via /api/admin/roll-day for demo purposes)."""
        for sym, s in self.state.items():
            s.prev_close = s.price
            s.day_open = s.price
            s.day_high = s.price
            s.day_low = s.price
            s.volume_today = 0.0


engine = PriceEngine()
