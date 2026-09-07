import asyncio
import secrets
from datetime import datetime

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Depends, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sqlalchemy import select

from . import db as dbm
from .schemas import (
    SignupRequest, LoginRequest, WatchlistAdd,
    ForgotPasswordQuestionRequest, SecurityQuestionResponse,
    ResetPasswordRequest, OkResponse,
)
from .price_engine import engine as price_engine
from .change_engine import compute_events, attention_score, events_to_dicts, sector_context
from .security import hash_password, verify_password

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


def get_or_error_user(db: Session, user_id: int) -> dbm.User:
    user = db.get(dbm.User, user_id)
    if not user:
        raise HTTPException(404, "user not found")
    return user


def build_item_payload(item: dbm.WatchlistItem, snap: dict, all_snaps: list[dict]) -> dict:
    is_new = item.last_seen_at is None
    last_seen = None
    if not is_new:
        last_seen = {
            "price": item.last_seen_price,
            "volume": item.last_seen_volume,
            "rsi_14": item.last_seen_rsi,
            "short_ma": item.last_seen_short_ma,
            "long_ma": item.last_seen_long_ma,
            "buy_pressure_pct": item.last_seen_buy_pressure,
        }
    events = compute_events(last_seen, snap)
    score = attention_score(events, is_new)
    # Sector context is its own field, not glued onto every event's text —
    # a feed-delay event and an RSI event have nothing to do with "3 of 5
    # sector peers are trending up", so it's surfaced separately in the UI
    # rather than concatenated into unrelated event descriptions.
    # Pass the SAME "since you checked" move used above so the direction
    # word here can never contradict the price_move event's own headline.
    own_move_pct = None
    if not is_new and item.last_seen_price:
        own_move_pct = (snap["price"] - item.last_seen_price) / item.last_seen_price
    peer_context = sector_context(snap, all_snaps, own_move_pct)
    return {
        **snap,
        "watchlist_item_id": item.id,
        "added_at": item.added_at.isoformat() if item.added_at else None,
        "is_new": is_new,
        "last_seen_price": item.last_seen_price,
        "last_seen_at": item.last_seen_at.isoformat() if item.last_seen_at else None,
        "last_seen_rsi": item.last_seen_rsi,
        "events": events_to_dicts(events),
        "sector_context": peer_context,
        "attention_score": score,
    }


USERNAME_MIN, USERNAME_MAX = 3, 20
PASSWORD_MIN = 6

# Fixed list so the frontend dropdown and backend validation always agree.
# If you add/remove a question here, update the matching array in the
# frontend signup form too.
SECURITY_QUESTIONS = [
    "What was the name of your first pet?",
    "What city were you born in?",
    "What was the name of your first school?",
    "What is your mother's maiden name?",
    "What was your childhood nickname?",
]


def _validate_username(username: str) -> str:
    username = username.strip().lower()
    if not (USERNAME_MIN <= len(username) <= USERNAME_MAX) or not username.replace("_", "").isalnum():
        raise HTTPException(400, f"Username must be {USERNAME_MIN}-{USERNAME_MAX} characters: letters, numbers, underscores.")
    return username


def _normalize_answer(answer: str) -> str:
    # Case/whitespace-insensitive so "Fluffy" and "fluffy " both verify —
    # people don't reliably remember how they capitalized an answer months ago.
    return answer.strip().lower()


def _seed_demo_watchlist(db: Session, user: dbm.User):
    for symbol in ("AAPL", "JPM", "XOM", "JNJ", "WMT"):
        if symbol in price_engine.symbols():
            snap = price_engine.snapshot(symbol)
            # Seeded already "acknowledged" (unlike a genuinely new watchlist
            # item) purely so the demo digest has real signals within moments
            # of logging in, rather than an empty first visit.
            db.add(dbm.WatchlistItem(
                user_id=user.id, symbol=symbol,
                last_seen_price=snap["price"], last_seen_volume=snap["volume_today"],
                last_seen_rsi=snap["rsi_14"], last_seen_short_ma=snap["short_ma"],
                last_seen_long_ma=snap["long_ma"], last_seen_buy_pressure=snap["buy_pressure_pct"],
                last_seen_at=datetime.utcnow(),
            ))
    db.commit()


@app.post("/api/auth/signup")
def signup(payload: SignupRequest, db: Session = Depends(dbm.get_session)):
    username = _validate_username(payload.username)
    if len(payload.password) < PASSWORD_MIN:
        raise HTTPException(400, f"Password must be at least {PASSWORD_MIN} characters.")

    security_question = None
    security_answer_hash = None
    if payload.security_question or payload.security_answer:
        # Only enforce these rules if the user is actually trying to set up
        # a security question — don't demand it when both fields are absent.
        if payload.security_question not in SECURITY_QUESTIONS:
            raise HTTPException(400, "Please choose one of the listed security questions.")
        if not payload.security_answer or not payload.security_answer.strip():
            raise HTTPException(400, "Security answer can't be empty.")
        security_question = payload.security_question
        security_answer_hash = hash_password(_normalize_answer(payload.security_answer))

    existing = db.execute(select(dbm.User).where(dbm.User.username == username)).scalar_one_or_none()
    if existing:
        raise HTTPException(409, "That username is already taken.")

    user = dbm.User(
        username=username,
        password_hash=hash_password(payload.password),
        security_question=security_question,
        security_answer_hash=security_answer_hash,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    if username == "demo":
        _seed_demo_watchlist(db, user)
    return {"user_id": user.id, "username": user.username}


@app.post("/api/auth/login")
def login(payload: LoginRequest, db: Session = Depends(dbm.get_session)):
    username = payload.username.strip().lower()
    user = db.execute(select(dbm.User).where(dbm.User.username == username)).scalar_one_or_none()
    # Deliberately identical error for "no such user" and "wrong password" —
    # a distinct message for each would let an attacker enumerate which
    # usernames exist on the system.
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(401, "Incorrect username or password.")
    return {"user_id": user.id, "username": user.username}


@app.post("/api/auth/forgot-password/question", response_model=SecurityQuestionResponse)
def get_security_question(payload: ForgotPasswordQuestionRequest, db: Session = Depends(dbm.get_session)):
    username = payload.username.strip().lower()
    user = db.execute(select(dbm.User).where(dbm.User.username == username)).scalar_one_or_none()
    if not user or not user.security_question:
        # Same error either way — don't reveal whether the username exists
        # vs. exists-but-never-set-a-question.
        raise HTTPException(404, "No security question found for that username.")
    return {"security_question": user.security_question}


@app.post("/api/auth/reset-password", response_model=OkResponse)
def reset_password(payload: ResetPasswordRequest, db: Session = Depends(dbm.get_session)):
    username = payload.username.strip().lower()
    user = db.execute(select(dbm.User).where(dbm.User.username == username)).scalar_one_or_none()

    if (
        not user
        or not user.security_answer_hash
        or not verify_password(_normalize_answer(payload.security_answer), user.security_answer_hash)
    ):
        raise HTTPException(400, "That answer doesn't match our records.")

    if len(payload.new_password) < PASSWORD_MIN:
        raise HTTPException(400, f"Password must be at least {PASSWORD_MIN} characters.")

    user.password_hash = hash_password(payload.new_password)
    db.commit()
    return {"ok": True}


@app.post("/api/auth/demo")
def demo_login(db: Session = Depends(dbm.get_session)):
    """One-click convenience for presenting/judging this project — NOT a
    bypass of the real auth path above. It only ever controls the single,
    fixed 'demo' account (auto-created on first call with a server-side
    password nobody needs to know), never an arbitrary user's account."""
    user = db.execute(select(dbm.User).where(dbm.User.username == "demo")).scalar_one_or_none()
    if not user:
        user = dbm.User(
            username="demo",
            password_hash=hash_password(secrets.token_hex(16)),
            security_question=SECURITY_QUESTIONS[0],
            security_answer_hash=hash_password(_normalize_answer(secrets.token_hex(8))),
        )
        db.add(user)
        db.commit()
        db.refresh(user)
        _seed_demo_watchlist(db, user)
    return {"user_id": user.id, "username": user.username}


# Curated, diverse-sector sample used only for the pre-login "market pulse"
# preview — deliberately public/unauthenticated since it's not anyone's
# personal watchlist, just a live demonstration that the feed is real.
PULSE_SYMBOLS = ["AAPL", "JPM", "XOM", "WMT"]


@app.get("/api/market-pulse")
def market_pulse():
    return [price_engine.snapshot(sym) for sym in PULSE_SYMBOLS if sym in price_engine.symbols()]


@app.get("/api/symbols")
def list_symbols(q: str = ""):
    results = []
    for sym in price_engine.symbols():
        meta = price_engine.meta(sym)
        if q and q.upper() not in sym.upper() and q.lower() not in meta["name"].lower():
            continue
        results.append({"symbol": sym, "name": meta["name"], "sector": meta["sector"]})
    return results


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
    user = get_or_error_user(db, user_id)
    items = db.execute(
        select(dbm.WatchlistItem).where(dbm.WatchlistItem.user_id == user.id)
    ).scalars().all()
    now = datetime.utcnow()
    for item in items:
        snap = price_engine.snapshot(item.symbol)
        item.last_seen_price = snap["price"]
        item.last_seen_volume = snap["volume_today"]
        item.last_seen_rsi = snap["rsi_14"]
        item.last_seen_short_ma = snap["short_ma"]
        item.last_seen_long_ma = snap["long_ma"]
        item.last_seen_buy_pressure = snap["buy_pressure_pct"]
        item.last_seen_at = now
    db.commit()
    return {"ok": True, "acknowledged_at": now.isoformat()}


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


@app.post("/api/admin/roll-day")
def roll_day():
    price_engine.roll_new_day()
    return {"ok": True}


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "symbols": len(price_engine.symbols()),
        "provider": "finnhub" if price_engine.finnhub_api_key else "simulator",
    }