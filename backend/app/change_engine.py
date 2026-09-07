"""
"What counts as a meaningful change" — the core decision of this whole build.

The lazy version of this feature is a flat threshold: "flag if price moved
> 2%". That's wrong because a 2% move means something completely different
for a low-volatility utility stock than for a small-cap that moves 2% on a
quiet Tuesday. So instead every signal here is scored RELATIVE TO THE
SYMBOL'S OWN RECENT BEHAVIOR (a z-score against its own return volatility /
average volume), not an absolute cutoff. A move has to be unusual FOR THAT
STOCK to count as meaningful.

Four signal types, each produces an Event with a 0-100 severity:
  1. price_move   — price change since the user's last-seen snapshot,
                     expressed in standard deviations of that symbol's
                     typical tick-to-tick return.
  2. volume_spike — today's volume vs its own trailing average.
  3. level_cross  — price crossed its period high/low or yesterday's close
                     (a "structural" event that matters regardless of %).
  4. feed_issue   — the data itself became unreliable (delayed/stale),
                     which is information the user needs even if nothing
                     about the price is unusual.

Events are combined into one 0-100 "attention score" per symbol so the
"since you last checked" digest can be ranked instead of just listed.
"""
from dataclasses import dataclass, asdict


@dataclass
class ChangeEvent:
    type: str
    severity: int          # 0-100
    headline: str
    detail: str


def _clip(x, lo=0, hi=100):
    return max(lo, min(hi, x))


def price_move_event(last_seen_price, current_price, return_vol) -> ChangeEvent | None:
    if last_seen_price is None or last_seen_price <= 0:
        return None
    pct = (current_price - last_seen_price) / last_seen_price
    if abs(pct) < 0.0005:
        return None
    baseline = max(return_vol, 0.003) * 4
    z = abs(pct) / baseline
    severity = _clip(round(z * 35))
    direction = "up" if pct > 0 else "down"
    return ChangeEvent(
        type="price_move",
        severity=severity,
        headline=f"{direction} {abs(pct)*100:.1f}% since you last checked",
        detail=(
            f"That's {z:.1f}x this symbol's usual move for the period — "
            f"{'unusually large' if z > 2 else 'a normal-sized move'} for this name."
        ),
    )


def volume_spike_event(volume_today, avg_volume) -> ChangeEvent | None:
    if not avg_volume or avg_volume <= 0:
        return None
    ratio = volume_today / avg_volume
    if ratio < 1.4:
        return None
    severity = _clip(round((ratio - 1) * 40))
    return ChangeEvent(
        type="volume_spike",
        severity=severity,
        headline=f"Volume running {ratio:.1f}x average",
        detail="Unusually high trading activity today relative to its own recent norm.",
    )


def level_cross_event(last_seen_price, current_price, period_high, period_low, prev_close) -> ChangeEvent | None:
    if last_seen_price is None:
        return None
    events = []
    crossed_up = last_seen_price < prev_close <= current_price
    crossed_down = last_seen_price > prev_close >= current_price
    if crossed_up or crossed_down:
        events.append(("prior close", 45))
    if current_price >= period_high and last_seen_price < period_high:
        events.append(("period high", 70))
    if current_price <= period_low and last_seen_price > period_low:
        events.append(("period low", 70))
    if not events:
        return None
    label, sev = max(events, key=lambda e: e[1])
    return ChangeEvent(
        type="level_cross",
        severity=sev,
        headline=f"Crossed its {label}",
        detail=f"Price is now through a level worth knowing about ({label}).",
    )


def feed_issue_event(feed_status, age_seconds) -> ChangeEvent | None:
    if feed_status == "live":
        return None
    severity = 55 if feed_status == "delayed" else 80
    return ChangeEvent(
        type="feed_issue",
        severity=severity,
        headline=f"Data feed {feed_status}",
        detail=f"Last confirmed update was {age_seconds:.0f}s ago — treat the current price with caution.",
    )


def rsi_regime_event(last_rsi, current_rsi) -> ChangeEvent | None:
    if last_rsi is None or current_rsi is None:
        return None
    if last_rsi < 70 <= current_rsi:
        return ChangeEvent("rsi_overbought", 62, "Freshly entered overbought territory", f"RSI(14) moved from {last_rsi:.0f} to {current_rsi:.0f}, above the 70 threshold since your last visit.")
    if last_rsi > 30 >= current_rsi:
        return ChangeEvent("rsi_oversold", 62, "Freshly entered oversold territory", f"RSI(14) moved from {last_rsi:.0f} to {current_rsi:.0f}, below the 30 threshold since your last visit.")
    return None


def moving_average_cross_event(last_short, last_long, current_short, current_long) -> ChangeEvent | None:
    if None in (last_short, last_long, current_short, current_long):
        return None
    if last_short <= last_long and current_short > current_long:
        return ChangeEvent("golden_cross", 68, "Short-term trend crossed above long-term trend", f"MA(10) crossed above MA(30): {current_short:.2f} vs {current_long:.2f}.")
    if last_short >= last_long and current_short < current_long:
        return ChangeEvent("death_cross", 68, "Short-term trend crossed below long-term trend", f"MA(10) crossed below MA(30): {current_short:.2f} vs {current_long:.2f}.")
    return None


def buy_pressure_shift_event(last_pressure, current_pressure) -> ChangeEvent | None:
    """Flags a MEANINGFUL shift in the derived buy/sell pressure proxy since
    the user's last visit — not just 'pressure is currently skewed', but
    'it moved into a skew it wasn't in last time you looked'. Kept separate
    from the raw stat (which is always shown) so a persistently-skewed but
    unchanged stock doesn't get re-flagged every visit."""
    if last_pressure is None or current_pressure is None:
        return None
    was_skewed = abs(last_pressure - 50) >= 15
    is_skewed = abs(current_pressure - 50) >= 15
    if not is_skewed:
        return None
    if was_skewed and (last_pressure - 50) * (current_pressure - 50) > 0:
        return None  # already skewed the same direction last time you checked — not new
    label = "buying" if current_pressure > 50 else "selling"
    severity = _clip(round(abs(current_pressure - 50) * 1.8))
    return ChangeEvent(
        type="buy_pressure_shift",
        severity=severity,
        headline=f"{label.capitalize()} pressure building ({current_pressure:.0f}% {label})",
        detail="Derived from recent tick direction x volume — a simulated order-flow proxy, not real order-book data.",
    )


def compute_events(last_seen: dict | None, current: dict) -> list[ChangeEvent]:
    events = []
    last_price = last_seen["price"] if last_seen else None

    e = price_move_event(last_price, current["price"], current["return_volatility"])
    if e:
        events.append(e)

    e = volume_spike_event(current["volume_today"], current["avg_volume"])
    if e:
        events.append(e)

    e = level_cross_event(last_price, current["price"], current["period_high"], current["period_low"], current["prev_close"])
    if e:
        events.append(e)

    e = feed_issue_event(current["feed_status"], current["age_seconds"])
    if e:
        events.append(e)

    e = rsi_regime_event(last_seen.get("rsi_14") if last_seen else None, current.get("rsi_14"))
    if e:
        events.append(e)

    e = moving_average_cross_event(
        last_seen.get("short_ma") if last_seen else None,
        last_seen.get("long_ma") if last_seen else None,
        current.get("short_ma"),
        current.get("long_ma"),
    )
    if e:
        events.append(e)

    e = buy_pressure_shift_event(
        last_seen.get("buy_pressure_pct") if last_seen else None,
        current.get("buy_pressure_pct"),
    )
    if e:
        events.append(e)

    events.sort(key=lambda ev: -ev.severity)
    return events


def attention_score(events: list[ChangeEvent], is_new: bool) -> int:
    if is_new:
        return 0
    if not events:
        return 0
    top = events[0].severity
    rest = sum(e.severity for e in events[1:]) * 0.25
    return _clip(round(top + rest))


def events_to_dicts(events: list[ChangeEvent]):
    return [asdict(e) for e in events]


def _peer_trend_up(peer: dict) -> bool | None:
    """A peer's recent direction, using its own short/long moving average —
    available for every symbol regardless of whether the viewer tracks it
    (unlike 'since you personally last checked', which only exists for
    symbols on THIS user's watchlist)."""
    if peer.get("short_ma") is None or peer.get("long_ma") is None:
        return None
    return peer["short_ma"] >= peer["long_ma"]


def sector_context(current: dict, peers: list[dict], own_move_pct: float | None = None) -> dict:
    """Explain whether this symbol's move is shared by its sector peers.

    `own_move_pct` should be the SAME "since you last checked" move used in
    the price_move event for this symbol, so the direction word here never
    contradicts that event (e.g. "up 6.5%" next to "moving down"). Peers
    don't have a personal last-seen snapshot for this viewer, so their
    direction is approximated from their own short/long moving-average
    trend instead — a different but self-consistent basis, made explicit
    here rather than silently mixed with a third timeframe (today's
    prev_close move), which is what caused the original mismatch.
    """
    same_sector = [peer for peer in peers if peer.get("sector") == current.get("sector") and peer.get("symbol") != current.get("symbol")]
    if own_move_pct is None:
        own_move_pct = (current["price"] - current["prev_close"]) / current["prev_close"] if current.get("prev_close") else 0
    direction = "up" if own_move_pct >= 0 else "down"

    peer_trends = [(peer, _peer_trend_up(peer)) for peer in same_sector]
    movers = [peer for peer, trend in peer_trends if trend is not None]
    aligned = [peer for peer, trend in peer_trends if trend is not None and trend == (own_move_pct >= 0)]
    sector = current.get("sector", "the sector")
    total = len(same_sector) + 1

    if not same_sector:
        summary = f"No {sector} peers are available for comparison yet."
        kind = "no_peers"
    elif len(aligned) >= max(1, (len(same_sector) + 1) // 2):
        summary = f"Sector-wide move: {len(aligned)} of {total} {sector} names are moving {direction}."
        kind = "sector_wide"
    else:
        summary = f"Stock-specific move: only {len(aligned)} of {total} {sector} names are moving {direction}."
        kind = "stock_specific"

    return {
        "kind": kind,
        "summary": summary,
        "sector": sector,
        "peer_count": len(same_sector),
        "aligned_count": len(aligned),
        "movers_count": len(movers),
        "total_count": total,
    }