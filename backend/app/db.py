"""
Persistence layer.

Design decision: a user authenticates with a username + password (hashed,
never stored or logged in plaintext — see security.py). The client stores
the resulting {user_id, username} locally after login and sends the
user_id on every subsequent request. That user_id is NOT itself a secret
credential — it identifies whose data to fetch, the same role a session ID
would play. The password check happens once, at login.

Password recovery: rather than emailing a reset code (this app never
collects an email address), each user picks one security question at
signup and answers it. The answer is hashed the same way a password is
(see security.py) — it's a secret the same way a password is, so it
never sits in the database in plaintext either. Case/whitespace are
normalized before hashing so "Fluffy" and "fluffy " both match.

All state that needs to survive across sessions/devices lives here in
SQLite, keyed by that identity:

  - which symbols are on the watchlist
  - the LAST SNAPSHOT the user actually saw for each symbol (price, volume,
    RSI, moving averages, buy-pressure, timestamp) — this is what "since
    you last checked" is computed against. It only advances when the
    client explicitly acknowledges (POST /ack), not on every page load,
    so refreshing the page doesn't erase the diff.

Known, deliberate scope limit: requests after login aren't re-verified
against a signed token (e.g. JWT) — the user_id is trusted as-is on each
call. That's the natural next increment beyond "add password auth" and a
clearly separate piece of work (bearer-token issuance + verification
middleware on every route), not silently bundled in here.
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
    password_hash = Column(String, nullable=True)  # nullable only to keep pre-existing dev rows loadable
    security_question = Column(String, nullable=True)  # nullable: pre-existing users haven't set one yet
    security_answer_hash = Column(String, nullable=True)
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

    last_seen_price = Column(Float, nullable=True)
    last_seen_volume = Column(Float, nullable=True)
    last_seen_at = Column(DateTime, nullable=True)
    last_seen_rsi = Column(Float, nullable=True)
    last_seen_short_ma = Column(Float, nullable=True)
    last_seen_long_ma = Column(Float, nullable=True)
    last_seen_buy_pressure = Column(Float, nullable=True)

    user = relationship("User", back_populates="items")


def init_db():
    Base.metadata.create_all(bind=engine)
    # Keep a pre-existing demo db.db compatible after schema additions;
    # create_all does not alter existing tables.
    with engine.begin() as connection:
        item_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(watchlist_items)")}
        for name in ("last_seen_rsi", "last_seen_short_ma", "last_seen_long_ma", "last_seen_buy_pressure"):
            if name not in item_columns:
                connection.exec_driver_sql(f"ALTER TABLE watchlist_items ADD COLUMN {name} FLOAT")
        user_columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(users)")}
        if "password_hash" not in user_columns:
            connection.exec_driver_sql("ALTER TABLE users ADD COLUMN password_hash VARCHAR")
        for name in ("security_question", "security_answer_hash"):
            if name not in user_columns:
                connection.exec_driver_sql(f"ALTER TABLE users ADD COLUMN {name} VARCHAR")


def get_session():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()