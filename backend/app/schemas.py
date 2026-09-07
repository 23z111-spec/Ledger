from typing import Optional

from pydantic import BaseModel


class SignupRequest(BaseModel):
    username: str
    password: str
    security_question: Optional[str] = None
    security_answer: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class WatchlistAdd(BaseModel):
    symbol: str


class ForgotPasswordQuestionRequest(BaseModel):
    username: str


class SecurityQuestionResponse(BaseModel):
    security_question: str


class ResetPasswordRequest(BaseModel):
    username: str
    security_answer: str
    new_password: str


class OkResponse(BaseModel):
    ok: bool