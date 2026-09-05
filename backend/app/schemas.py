from pydantic import BaseModel


class UserCreate(BaseModel):
    username: str


class WatchlistAdd(BaseModel):
    symbol: str
