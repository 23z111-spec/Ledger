"""
Password hashing + JWT helpers for real email/password auth.

Requires: pip install bcrypt pyjwt

Set a real JWT_SECRET via environment variable in production —
the fallback here is fine for local dev only.
"""
import os
import time
import secrets

import bcrypt
import jwt

JWT_SECRET = os.environ.get("JWT_SECRET", "dev-secret-change-me-before-deploying")
JWT_ALG = "HS256"
JWT_EXPIRY_SECONDS = 60 * 60 * 24 * 7  # 7 days


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        # Covers malformed/missing hashes (e.g. legacy no-password users)
        # instead of raising and turning a bad login attempt into a 500.
        return False


def create_token(user_id: int) -> str:
    payload = {"sub": str(user_id), "exp": int(time.time()) + JWT_EXPIRY_SECONDS}
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)


def decode_token(token: str) -> int:
    """Raises jwt.PyJWTError (expired, invalid signature, malformed) on failure —
    callers should catch that and return a 401."""
    payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    return int(payload["sub"])


def generate_otp() -> str:
    """6-digit numeric code, e.g. '042817'. Zero-padded so it's always 6 digits."""
    return f"{secrets.randbelow(1_000_000):06d}"


# Reuse the same bcrypt hashing as passwords — an OTP is a secret the same
# way a password is, so it shouldn't sit in the database in plaintext.
def hash_otp(otp: str) -> str:
    return hash_password(otp)


def verify_otp(otp: str, otp_hash: str) -> bool:
    return verify_password(otp, otp_hash)