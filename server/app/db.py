import os
from contextlib import contextmanager

from sqlmodel import SQLModel, Session, create_engine
from sqlalchemy import event

DB_PATH = os.getenv("MADWOLF_DB", "/config/madwolf.db")
os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)

DATABASE_URL = f"sqlite:///{DB_PATH}"

engine = create_engine(
    DATABASE_URL,
    connect_args={
        "check_same_thread": False,
        # how long sqlite will wait for a lock before erroring
        "timeout": 30,
    },
    pool_pre_ping=True,
)

@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_connection, _):
    # These run on every new DB connection.
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL;")
    cursor.execute("PRAGMA synchronous=NORMAL;")
    cursor.execute("PRAGMA foreign_keys=ON;")
    cursor.execute("PRAGMA busy_timeout=30000;")  # 30s
    cursor.close()

def init_db():
    # Import models so SQLModel.metadata is populated
    from . import models  # noqa: F401
    SQLModel.metadata.create_all(engine)

@contextmanager
def session():
    with Session(engine) as s:
        yield s
