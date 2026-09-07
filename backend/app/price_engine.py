"""
Market data feed.

Finnhub is used when FINNHUB_API_KEY is configured. The simulator remains as
a local fallback so the app still runs without credentials.

Everything here lives in-memory (fast, O(num_symbols) per tick, independent
of how many users or watchlists exist).
"""
import asyncio
import os
import random
import statistics
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx


SECTORS = {
    "Technology": ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL"],
    "Finance": ["JPM", "V", "MA", "BAC"],
    "Healthcare": ["JNJ", "PFE", "UNH", "ABBV"],
    "Energy": ["XOM", "CVX", "COP", "NEE"],
    "Consumer": ["KO", "WMT", "COST", "MCD"],
    "Industrials": ["CAT", "GE", "UPS", "HON"],
}

random.seed(7)
UNIVERSE = {}
for sector, syms in SECTORS.items():
    for sym in syms:
        UNIVERSE[sym] = {
            "name": f"{sym.title()} {sector.split()[0]} Corp",
            "sector": sector,
            "base_price": round(random.uniform(15, 480), 2),
            "vol": round(random.uniform(0.006, 0.035), 4),
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
    period_high: float
    period_low: float
    volume_today: float = 0.0
    last_tick_volume: float = 0.0
    updated_at: float = field(default_factory=time.time)
    recent_returns: deque = field(default_factory=lambda: deque(maxlen=60))
    recent_volumes: deque = field(default_factory=lambda: deque(maxlen=30))
    recent_prices: deque = field(default_factory=lambda: deque(maxlen=240))
    up_volume: float = 0.0
    down_volume: float = 0.0
    feed_status: str = "live"
    feed_delay_until: float = 0.0


class PriceEngine:
    def __init__(self):
        self.state: dict[str, SymbolState] = {}
        self._lock = asyncio.Lock()
        self._subscribers: list[asyncio.Queue] = []
        self.finnhub_api_key = os.environ.get("FINNHUB_API_KEY", "").strip()
        self.finnhub_url = "https://finnhub.io/api/v1/quote"
        self.last_finnhub_refresh = 0.0
        self.finnhub_refresh_interval = float(os.environ.get("FINNHUB_REFRESH_SECONDS", "30"))
        for sym, meta in UNIVERSE.items():
            p = meta["base_price"]
            self.state[sym] = SymbolState(
                symbol=sym, price=p, prev_close=p, day_open=p,
                day_high=p, day_low=p, period_high=p, period_low=p,
            )
            self.state[sym].recent_prices.extend([p] * 30)

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

        prices = list(s.recent_prices)
        short_ma = statistics.fmean(prices[-10:]) if len(prices) >= 10 else None
        long_ma = statistics.fmean(prices[-30:]) if len(prices) >= 30 else None

        # RSI(14) — Wilder-style, computed on the trailing 15 prices only
        # (cheap: O(1) window, not the full 240-price buffer).
        window = prices[-15:]
        if len(window) >= 15:
            gains = [max(0, window[i] - window[i - 1]) for i in range(1, len(window))]
            losses = [max(0, window[i - 1] - window[i]) for i in range(1, len(window))]
            avg_gain = statistics.fmean(gains)
            avg_loss = statistics.fmean(losses)
            rsi = 100.0 if avg_loss == 0 and avg_gain > 0 else (
                50.0 if avg_loss == 0 else 100 - (100 / (1 + avg_gain / avg_loss))
            )
        else:
            rsi = 50.0

        pressure_total = s.up_volume + s.down_volume
        buy_pressure = (s.up_volume / pressure_total) * 100 if pressure_total else 50.0

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
            "rsi_14": round(rsi, 1),
            "short_ma": round(short_ma, 2) if short_ma is not None else None,
            "long_ma": round(long_ma, 2) if long_ma is not None else None,
            "buy_pressure_pct": round(buy_pressure, 1),
            "sell_pressure_pct": round(100 - buy_pressure, 1),
            "pressure_is_derived": True,
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
        while True:
            if self.finnhub_api_key:
                await self._refresh_finnhub()
                await asyncio.sleep(max(interval, self.finnhub_refresh_interval))
            else:
                await self._tick_all()
                await asyncio.sleep(interval)

    async def _refresh_finnhub(self):
        now = time.time()
        if now - self.last_finnhub_refresh < self.finnhub_refresh_interval:
            return

        self.last_finnhub_refresh = now
        async with httpx.AsyncClient(timeout=8.0) as client:
            for sym in self.state:
                try:
                    response = await client.get(
                        self.finnhub_url,
                        params={"symbol": sym, "token": self.finnhub_api_key},
                    )
                    response.raise_for_status()
                    quote = response.json()
                    price = float(quote.get("c") or 0)
                    if price <= 0:
                        raise ValueError("Finnhub returned no current price")
                except (httpx.HTTPError, ValueError, TypeError):
                    self.state[sym].feed_status = "stale"
                    continue

                state = self.state[sym]
                previous_price = state.price
                pct_move = (price - previous_price) / previous_price if previous_price else 0.0
                state.price = price
                state.prev_close = float(quote.get("pc") or state.prev_close)
                state.day_open = float(quote.get("o") or state.day_open)
                state.day_high = float(quote.get("h") or state.day_high)
                state.day_low = float(quote.get("l") or state.day_low)
                state.period_high = max(state.period_high, price)
                state.period_low = min(state.period_low, price)
                state.recent_returns.append(pct_move)
                state.recent_prices.append(price)
                state.updated_at = now
                state.feed_status = "live"

                await self._broadcast({
                    "type": "tick",
                    "symbol": sym,
                    "price": round(price, 2),
                    "pct_move": round(pct_move * 100, 3),
                    "feed_status": state.feed_status,
                    "ts": datetime.fromtimestamp(now, tz=timezone.utc).isoformat(),
                })

    async def _tick_all(self):
        now = time.time()
        for sym, meta in UNIVERSE.items():
            s = self.state[sym]

            if s.feed_status == "live" and random.random() < 0.004:
                s.feed_status = "delayed"
                s.feed_delay_until = now + random.uniform(15, 45)
            elif s.feed_status in ("delayed", "stale") and now > s.feed_delay_until:
                s.feed_status = "live"

            if s.feed_status != "live" and random.random() < 0.7:
                continue

            shock = 1.0
            if random.random() < 0.015:
                shock = random.choice([3.5, 4.5])
            pct_move = random.gauss(0, meta["vol"]) * shock
            new_price = max(0.5, s.price * (1 + pct_move))
            s.recent_returns.append(pct_move)

            s.price = new_price
            s.recent_prices.append(new_price)
            s.day_high = max(s.day_high, new_price)
            s.day_low = min(s.day_low, new_price)
            s.period_high = max(s.period_high, new_price)
            s.period_low = min(s.period_low, new_price)

            base_tick_vol = meta["avg_volume"] / 200
            spike_factor = 1.0
            if abs(pct_move) > meta["vol"] * 2.2 or random.random() < 0.03:
                spike_factor = random.uniform(2.5, 6.0)
            tick_vol = max(0, random.gauss(base_tick_vol, base_tick_vol * 0.3)) * spike_factor
            s.last_tick_volume = tick_vol
            s.volume_today += tick_vol
            if pct_move >= 0:
                s.up_volume += tick_vol
            else:
                s.down_volume += tick_vol
            s.recent_volumes.append(tick_vol * 200)

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
        for sym, s in self.state.items():
            s.prev_close = s.price
            s.day_open = s.price
            s.day_high = s.price
            s.day_low = s.price
            s.volume_today = 0.0
            s.up_volume = 0.0
            s.down_volume = 0.0


engine = PriceEngine()