"""Validated application settings.

Every value the API needs is declared here and checked at import time. A
missing or malformed required value stops the process at startup rather than
surfacing later as a 500 during a login.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

from pydantic import ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The repo keeps one .env at the root, shared by the API and the tooling.
REPO_ROOT = Path(__file__).resolve().parents[3]
ENV_FILE = REPO_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ENV_FILE,
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # --- Runtime ---------------------------------------------------------
    NODE_ENV: str = "development"
    PORT: int = 4000
    CLIENT_ORIGIN: str = "http://localhost:3000"
    #: Wall-clock zone of the clinic. Appointment times are stored in UTC, but a
    #: doctor's published "09:00-17:00" means nine in the morning where the
    #: patient arrives — so windows are interpreted in this zone and converted
    #: at the boundary. An IANA name; an unknown one falls back to UTC rather
    #: than taking booking offline.
    CLINIC_TIMEZONE: str = "Asia/Karachi"

    # --- Billing ---------------------------------------------------------
    INVOICE_CURRENCY: str = "PKR"
    #: Tax applied to a consultation fee, as a percentage. Configuration rather
    #: than a literal: rates differ by jurisdiction and change, and a number
    #: compiled into the billing code is one nobody can correct without a
    #: deployment. Zero means the fee is billed and nothing else — an honest
    #: default for a deployment that has not been told its local rate.
    INVOICE_TAX_PERCENT: float = 0.0

    # --- Database --------------------------------------------------------
    DATABASE_URL: str = ""
    DIRECT_URL: str = ""

    # --- Authentication --------------------------------------------------
    JWT_SECRET: str = ""
    SESSION_SECRET: str = ""
    SESSION_IDLE_TIMEOUT_SECONDS: int = 120
    SESSION_ABSOLUTE_TIMEOUT_SECONDS: int = 43_200

    # --- Supabase Storage ------------------------------------------------
    SUPABASE_URL: str = ""
    SUPABASE_PUBLISHABLE_KEY: str = ""
    SUPABASE_SERVICE_ROLE_KEY: str = ""
    SUPABASE_DOCUMENTS_BUCKET: str = "medical-documents"
    SUPABASE_AVATARS_BUCKET: str = "avatars"
    #: Credentials a doctor uploads with their registration — a licence
    #: certificate, a degree, a national ID. Its own private bucket rather than
    #: a prefix inside the clinical one, so nothing that grants access to
    #: patient documents can reach an applicant's identity papers.
    SUPABASE_CREDENTIALS_BUCKET: str = "doctor-credentials"
    #: Screenshots a patient uploads to evidence a transfer. Private, like
    #: every other bucket here: a payment proof shows a bank balance and a
    #: name, and is nobody's business but the payer's and the reviewer's.
    SUPABASE_PAYMENT_PROOFS_BUCKET: str = "payment-proofs"
    #: Delivery URLs are signed per request, after the access check. Short
    #: enough that a leaked link is stale before it travels (conflict C8).
    SUPABASE_SIGNED_URL_TTL_SECONDS: int = 300
    #: Must not exceed the bucket's own file_size_limit, or an upload the API
    #: accepts would be rejected by storage after the patient waited for it.
    MAX_UPLOAD_BYTES: int = 20 * 1024 * 1024
    STORAGE_TIMEOUT_SECONDS: float = 30.0

    # --- AI provider -----------------------------------------------------
    AI_API_KEY: str = ""
    AI_MODEL: str = "gemini-3.6-flash"
    AI_ENABLED: bool = True
    AI_TIMEOUT_SECONDS: float = 60.0
    #: Vision extraction sends the document to an external provider, so it runs
    #: only for patients who have granted AI consent (conflict C2). Turning this
    #: off keeps every document on local OCR regardless of consent.
    AI_VISION_OCR_ENABLED: bool = True

    # --- OCR -------------------------------------------------------------
    OCR_ENABLED: bool = True
    OCR_DET_MODEL: str = "PP-OCRv5_mobile_det"
    OCR_REC_MODEL: str = "PP-OCRv5_mobile_rec"
    # PaddlePaddle 3.3.1 on Windows CPU crashes in the oneDNN executor with
    # "ConvertPirAttribute2RuntimeAttribute not support". Plain kernels work.
    OCR_ENABLE_MKLDNN: bool = False
    # Below this, a field is always sent for human review regardless of type.
    OCR_CONFIDENCE_REVIEW_THRESHOLD: float = 0.90

    # --- Email -----------------------------------------------------------
    SMTP_HOST: str = "smtp.gmail.com"
    SMTP_PORT: int = 587
    SMTP_SECURE: bool = False
    SMTP_USER: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = "MediSense <no-reply@medisense.local>"
    EMAIL_ENABLED: bool = False

    # --- Derived ---------------------------------------------------------

    @property
    def is_production(self) -> bool:
        return self.NODE_ENV == "production"

    @property
    def is_test(self) -> bool:
        return self.NODE_ENV == "test"

    @property
    def storage_configured(self) -> bool:
        return bool(self.SUPABASE_URL and self.SUPABASE_SERVICE_ROLE_KEY)

    @property
    def ai_configured(self) -> bool:
        return self.AI_ENABLED and bool(self.AI_API_KEY)

    @property
    def email_configured(self) -> bool:
        return self.EMAIL_ENABLED and bool(self.SMTP_USER and self.SMTP_PASSWORD)

    @property
    def async_database_url(self) -> str:
        """Runtime URL for SQLAlchemy's asyncpg driver.

        Supabase's transaction-mode pooler speaks the ``pgbouncer=true`` query
        flag, which asyncpg does not understand, so it is stripped here and the
        prepared-statement cache is disabled instead (see ``db/session.py``).
        """
        return _to_asyncpg(self.DATABASE_URL)

    @property
    def migration_database_url(self) -> str:
        """Sync URL for Alembic, over the direct (session-mode) connection.

        The transaction pooler cannot run DDL, so migrations must not use it.
        """
        base = self.DIRECT_URL or self.DATABASE_URL
        return _to_psycopg(base)

    @field_validator("JWT_SECRET", "SESSION_SECRET")
    @classmethod
    def _secret_long_enough(cls, value: str, info: ValidationInfo) -> str:
        # Tests supply their own; only a real run must have a real secret.
        import os

        if os.getenv("NODE_ENV") == "test":
            return value or ("test" * 10)
        if len(value) < 32:
            raise ValueError(
                f"{info.field_name} must be at least 32 characters. "
                'Generate one with: python -c "import secrets;print(secrets.token_urlsafe(48))"'
            )
        return value


def _strip_query_key(url: str, key: str) -> str:
    parts = urlsplit(url)
    if not parts.query:
        return url
    kept = [q for q in parts.query.split("&") if not q.startswith(f"{key}=")]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(kept), parts.fragment))


def _swap_scheme(url: str, scheme: str) -> str:
    parts = urlsplit(url)
    return urlunsplit((scheme, parts.netloc, parts.path, parts.query, parts.fragment))


def _to_asyncpg(url: str) -> str:
    if not url:
        return ""
    return _swap_scheme(_strip_query_key(url, "pgbouncer"), "postgresql+asyncpg")


def _to_psycopg(url: str) -> str:
    if not url:
        return ""
    return _swap_scheme(_strip_query_key(url, "pgbouncer"), "postgresql+psycopg")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
