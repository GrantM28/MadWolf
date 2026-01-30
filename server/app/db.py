import os
from sqlmodel import SQLModel, create_engine, Session

def get_db_path() -> str:
    config_dir = os.getenv("MADWOLF_CONFIG_DIR", "/config")
    os.makedirs(config_dir, exist_ok=True)
    return os.path.join(config_dir, "madwolf.sqlite")

engine = create_engine(f"sqlite:///{get_db_path()}", connect_args={"check_same_thread": False})

def init_db() -> None:
    SQLModel.metadata.create_all(engine)

def session() -> Session:
    return Session(engine)
