import asyncio
from datetime import datetime

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import select

from . import db as dbm
from .schemas import UserCreate, WatchlistAdd
from .price_engine import engine as price_engine
from .change_engine import compute_events, attention_score, events_to_dicts, sector_context

app = FastAPI(title="Smart Market Watchlist")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup():
    dbm.init_db()
    asyncio.create_task(price_engine.run_forever(interval=2.0))


# ---------- helpers ----------

def get_or_error_user(db: Session, user_id: int) -> dbm.User:
    user = db.get(dbm.User, user_id)
    if not user:
        raise HTTPException(404, "user not found")
    return user


def build_item_payload(item: dbm.WatchlistItem, snap: dict, all_snaps: list[dict]) -> dict:
    is_new = item.last_seen_at is None
    last_seen = None
    if not is_new:
        last_seen = {"price": item.last_seen_price, "volume": item.last_seen_volume}
    events = compute_events(last_seen, snap)
    score = attention_score(events, is_new)
    peer_context = sector_context(snap, all_snaps)
    for event in events:
        event.detail = f"{event.detail} {peer_context['summary']}"
    return {
        **snap,
        "watchlist_item_id": item.id,
        "added_at": item.added_at.isoformat() if item.added_at else None,
        "is_new": is_new,
        "last_seen_price": item.last_seen_price,
        "last_seen_at": item.last_seen_at.isoformat() if item.last_seen_at else None,
        "events": events_to_dicts(events),
        "sector_context": peer_context,
        "attention_score": score,
    }


# ---------- users ----------

@app.post("/api/users")
def create_or_get_user(payload: UserCreate, db: Session = Depends(dbm.get_session)):
    username = payload.username.strip().lower()
    if not username:
        raise HTTPException(400, "username required")
    user = db.execute(select(dbm.User).where(dbm.User.username == username)).scalar_one_or_none()
    if not user:
        user = dbm.User(username=username)
        db.add(user)
        db.commit()
        db.refresh(user)
    return {"user_id": user.id, "username": user.username}


# ---------- symbol universe ----------

@app.get("/api/symbols")
def list_symbols(q: str = ""):
    results = []
    for sym in price_engine.symbols():
        meta = price_engine.meta(sym)
        if q and q.upper() not in sym.upper() and q.lower() not in meta["name"].lower():
            continue
        results.append({"symbol": sym, "name": meta["name"], "sector": meta["sector"]})
    return results


# ---------- watchlist ----------

@app.get("/api/watchlist/{user_id}")
def get_watchlist(user_id: int, db: Session = Depends(dbm.get_session)):
    user = get_or_error_user(db, user_id)
    items = db.execute(
        select(dbm.WatchlistItem).where(dbm.WatchlistItem.user_id == user.id)
    ).scalars().all()

    payload = []
    all_snaps = price_engine.all_snapshots()
    snapshots_by_symbol = {snap["symbol"]: snap for snap in all_snaps}
    for item in items:
        snap = snapshots_by_symbol.get(item.symbol)
        if snap is None:
            continue
        payload.append(build_item_payload(item, snap, all_snaps))

    payload.sort(key=lambda p: -p["attention_score"])
    digest = [p for p in payload if p["attention_score"] >= 25][:5]

    return {"items": payload, "digest": digest}


@app.post("/api/watchlist/{user_id}")
def add_to_watchlist(user_id: int, payload: WatchlistAdd, db: Session = Depends(dbm.get_session)):
    user = get_or_error_user(db, user_id)
    symbol = payload.symbol.strip().upper()
    if symbol not in price_engine.symbols():
        raise HTTPException(400, f"unknown symbol {symbol}")
    existing = db.execute(
        select(dbm.WatchlistItem).where(
            dbm.WatchlistItem.user_id == user.id, dbm.WatchlistItem.symbol == symbol
        )
    ).scalar_one_or_none()
    if existing:
        return {"ok": True, "already_present": True}
    item = dbm.WatchlistItem(user_id=user.id, symbol=symbol)
    db.add(item)
    db.commit()
    return {"ok": True}


@app.delete("/api/watchlist/{user_id}/{symbol}")
def remove_from_watchlist(user_id: int, symbol: str, db: Session = Depends(dbm.get_session)):
    user = get_or_error_user(db, user_id)
    item = db.execute(
        select(dbm.WatchlistItem).where(
            dbm.WatchlistItem.user_id == user.id,
            dbm.WatchlistItem.symbol == symbol.upper(),
        )
    ).scalar_one_or_none()
    if item:
        db.delete(item)
        db.commit()
    return {"ok": True}


@app.post("/api/watchlist/{user_id}/ack")
def acknowledge(user_id: int, db: Session = Depends(dbm.get_session)):
    """Mark the current price/volume as 'seen' for every watchlist item.
    This is what makes 'since you last checked' advance — deliberately a
    separate step from just loading the page, so a page refresh doesn't
    wipe out the diff the user came back to see."""
    user = get_or_error_user(db, user_id)
    items = db.execute(
        select(dbm.WatchlistItem).where(dbm.WatchlistItem.user_id == user.id)
    ).scalars().all()
    now = datetime.utcnow()
    for item in items:
        snap = price_engine.snapshot(item.symbol)
        item.last_seen_price = snap["price"]
        item.last_seen_volume = snap["volume_today"]
        item.last_seen_at = now
    db.commit()
    return {"ok": True, "acknowledged_at": now.isoformat()}


# ---------- live ticks (WebSocket) ----------

@app.websocket("/ws/prices")
async def ws_prices(websocket: WebSocket):
    await websocket.accept()
    queue = await price_engine.subscribe()
    try:
        while True:
            tick = await queue.get()
            await websocket.send_json(tick)
    except WebSocketDisconnect:
        pass
    finally:
        price_engine.unsubscribe(queue)


# ---------- demo/admin ----------

@app.post("/api/admin/roll-day")
def roll_day():
    """Simulate the start of a new trading session (resets day open/high/low).
    Exposed for demo purposes so judges can see prior-close-cross events fire on demand."""
    price_engine.roll_new_day()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {"status": "ok", "symbols": len(price_engine.symbols())}
