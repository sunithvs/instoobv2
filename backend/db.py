from datetime import datetime
from typing import Optional

from sqlmodel import Field, Session, SQLModel, create_engine

from config import DB_PATH

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


class OAuthToken(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    provider: str = Field(index=True, unique=True)
    refresh_token_enc: bytes
    channel_id: Optional[str] = None
    channel_title: Optional[str] = None
    email: Optional[str] = None
    updated_at: datetime = Field(default_factory=datetime.utcnow)


class Upload(SQLModel, table=True):
    id: Optional[int] = Field(default=None, primary_key=True)
    instagram_url: str
    uploader: Optional[str] = None
    title: Optional[str] = None
    youtube_video_id: Optional[str] = None
    status: str = Field(index=True)  # "success" | "failed"
    error_message: Optional[str] = None
    created_at: datetime = Field(default_factory=datetime.utcnow, index=True)


def init_db() -> None:
    SQLModel.metadata.create_all(engine)


def get_session() -> Session:
    return Session(engine)
