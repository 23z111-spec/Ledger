"""
Password hashing.

Uses hashlib.pbkdf2_hmac (stdlib, no native extension) rather than bcrypt/
argon2 — those are stronger in principle, but pulling in a package with a
compiled dependency the night before a demo is a real risk (wheel
availability, build tooling) for a marginal security gain at this project's
threat model. PBKDF2-SHA256 with a high iteration count is still
industry-accepted (it's Django's default), salted per-password, and never
reversible.

Stored format: "pbkdf2_sha256$<iterations>$<salt_hex>$<hash_hex>"
— self-describing, so the iteration count can be raised later without
breaking verification of passwords hashed under the old count.
"""
import hashlib
import hmac
import secrets

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 260_000
SALT_BYTES = 16


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, ITERATIONS)
    return f"{ALGORITHM}${ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algorithm, iterations_str, salt_hex, hash_hex = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        iterations = int(iterations_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, AttributeError):
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)  # constant-time, avoids timing attacks