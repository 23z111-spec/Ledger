"""
Persistence layer.

Design decision: a user is identified by a simple username (no password —
this is a demo/hackathon auth model). The client stores a `user_token`
locally and sends it on every request. All state that needs to survive
across sessions/devices lives here in SQLite, keyed by that token:

  - which symbols are on the watchlist
  - the LAST SNAPSHOT the user actually saw for each symbol (price, volume,
    period high/low, timestamp) — this is what "since you last checked"
    is computed against. It only advances when the client explicitly
    acknowledges (POST /ack), not on every page load, so refreshing the
    page doesn't erase the diff.

Daily OHLC bars are persisted too, so period-high/low and volatility
baselines survive a server restart instead of resetting to whatever the
in-memory simulator happens to have.
"""
from datetime import datetime
from sqlalchemy import (
    create_engine, Column, Integer, String, Float, DateTime, ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.orm import declarative_base, sessionmaker, relationship

DATABASE_URL = "sqlite:///./watchlist.db"

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False, index=True)
    created_at = Column(DateTime, default=datetime.utcnow)

    items = relationship("WatchlistItem", back_populates="user", cascade="all, delete-orphan")


class WatchlistItem(Base):
    """A symbol on a user's watchlist, plus the snapshot of what they last saw."""
    __tablename__ = "watchlist_items"
    __table_args__ = (UniqueConstraint("user_id", "symbol", name="uq_user_symbol"),)

    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    symbol = Column(String, nullable=False, index=True)
    added_at = Column(DateTime, default=datetime.utcnow)

    # Snapshot as of the last time the user acknowledged/viewed this symbol.
    # NULL until the first ack — before that, everything is "new", not "changed".
    last_seen_price = Column(Float, nullable=True)
    last_seen_volume = Column(Float, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)

    user = relationship("User", back_populates="items")


class DailyBar(Base):
    """One row per symbol per simulated trading day. Used to reconstruct
    period high/low and a rolling volatility baseline after a restart,
    instead of losing that history when the in-memory simulator resets."""
    __tablename__ = "daily_bars"
    __table_args__ = (UniqueConstraint("symbol", "trading_day", name="uq_symbol_day"),)

    id = Column(Integer, primary_key=True)
    symbol = Column(String, nullable=False, index=True)
    trading_day = Column(String, nullable=False)  # ISO date string (simulated calendar)
    open = Column(Float)
    high = Column(Float)
    low = Column(Float)
    close = Column(Float)
    volume = Column(Float)


def init_db():
    Base.metadata.create_all(bind=engine)


def get_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
