"""
Sends OTP emails via Gmail's SMTP server.

Setup required (one-time, on the Gmail account you want to send from):
  1. Enable 2-Step Verification on that Google account.
  2. Go to https://myaccount.google.com/apppasswords and generate an
     App Password (16 characters, no spaces when you use it).
  3. Set two environment variables before starting the backend:
       GMAIL_ADDRESS=youraddress@gmail.com
       GMAIL_APP_PASSWORD=the16charapppassword
     Regular Gmail passwords will NOT work here — Google blocks plain
     password SMTP auth entirely, this isn't optional.

This is fine for a hackathon demo's volume. If you ever need this in a
real product, switch to a transactional email service (SES, Postmark,
Resend, etc.) — Gmail SMTP has low sending limits and can get an
account flagged if used at any real volume.
"""
import os
import smtplib
from email.mime.text import MIMEText

GMAIL_ADDRESS = os.environ.get("GMAIL_ADDRESS")
GMAIL_APP_PASSWORD = os.environ.get("GMAIL_APP_PASSWORD")


def send_otp_email(to_email: str, otp: str) -> None:
    if not GMAIL_ADDRESS or not GMAIL_APP_PASSWORD:
        # Fail loudly rather than silently pretending the email sent —
        # a swallowed exception here would leave the user staring at a
        # spinner for an email that never arrives.
        raise RuntimeError(
            "GMAIL_ADDRESS / GMAIL_APP_PASSWORD environment variables are not set. "
            "See email_utils.py docstring for setup steps."
        )

    subject = "Your Ledger password reset code"
    body = (
        f"Your one-time code is: {otp}\n\n"
        f"This code expires in 10 minutes. If you didn't request this, "
        f"you can safely ignore this email."
    )

    message = MIMEText(body)
    message["Subject"] = subject
    message["From"] = GMAIL_ADDRESS
    message["To"] = to_email

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as server:
        server.login(GMAIL_ADDRESS, GMAIL_APP_PASSWORD)
        server.sendmail(GMAIL_ADDRESS, [to_email], message.as_string())
