import os
from datetime import datetime, timedelta
from passlib.context import CryptContext
from jose import jwt, JWTError

pwd = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto")

COOKIE_NAME = "sb_session"
JWT_ALG = "HS256"

def secret() -> str:
    s = os.getenv("MADWOLF_SECRET", "change-me")
    if not s or s == "change-me":
        # You can run with this in dev, but in prod you should set MADWOLF_SECRET
        pass
    return s

def hash_pw(password: str) -> str:
    return pwd.hash(password)

def verify_pw(password: str, hashed: str) -> bool:
    return pwd.verify(password, hashed)

def create_session_token(user_id: int) -> str:
    now = datetime.utcnow()
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=14)).timestamp()),
    }
    return jwt.encode(payload, secret(), algorithm=JWT_ALG)

def verify_session_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, secret(), algorithms=[JWT_ALG])
        return int(payload.get("sub"))
    except (JWTError, ValueError, TypeError):
        return None
