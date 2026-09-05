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
    # z-score of this move against the symbol's own typical tick volatility.
    # return_vol is a per-tick stddev; treat the move as ~ sum of ticks since
    # last view, so scale loosely — this is intentionally a heuristic, not
    # a rigorous stats model, tuned to feel right rather than be exact.
    baseline = max(return_vol, 0.003) * 4  # rough "typical move since last check"
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
    # Nothing can be "crossed" without a prior snapshot to compare against —
    # for a brand-new watchlist item this must stay silent, not fire on the
    # first observation just because last_seen_price is unset.
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

    events.sort(key=lambda ev: -ev.severity)
    return events


def attention_score(events: list[ChangeEvent], is_new: bool) -> int:
    if is_new:
        return 0  # never-seen symbols aren't "changed", just new — kept out of the diff ranking
    if not events:
        return 0
    # Diminishing-returns combine so 3 medium signals don't outrank 1 huge one unfairly,
    # but still push a multi-signal symbol above a single-signal one of similar size.
    top = events[0].severity
    rest = sum(e.severity for e in events[1:]) * 0.25
    return _clip(round(top + rest))


def events_to_dicts(events: list[ChangeEvent]):
    return [asdict(e) for e in events]
