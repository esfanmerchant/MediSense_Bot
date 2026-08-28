"""Google Gemini client.

Used for vision extraction now (Phase 7) and the health assistant later
(Phase 8). Two properties hold for every call made through this module.

**Structured output is enforced by the provider, not parsed out of prose.**
Requests carry a `responseSchema`, so the model returns JSON matching a shape we
declared rather than a paragraph someone has to regex. That removes a whole
class of failure where a model "helpfully" explains its answer and the parser
takes the explanation for data.

**Temperature is zero and nothing is retried on a different prompt.** For a
clinical document, two runs disagreeing is a defect, not variety.

The API key is server-side only. It is sent as a header, never logged, and
provider error bodies are summarised rather than echoed — Google's errors quote
request context back, which is the most likely place for a key to leak into a
log.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import settings
from app.core.errors import AppError, ErrorCode
from app.core.logging import logger

BASE_URL = "https://generativelanguage.googleapis.com/v1beta"


class AiUnavailableError(AppError):
    def __init__(self, message: str = "The AI service is unavailable. Try again shortly.") -> None:
        super().__init__(503, ErrorCode.SERVICE_UNAVAILABLE, message)


@dataclass(frozen=True)
class AiResponse:
    data: Any
    model: str
    #: Provider-reported token counts, for cost visibility. Never any content.
    prompt_tokens: int | None = None
    output_tokens: int | None = None


def availability() -> tuple[bool, str]:
    """Whether AI calls can be made, and why not when they cannot."""
    if not settings.AI_ENABLED:
        return False, "AI features are disabled on this server (AI_ENABLED=false)."
    if not settings.AI_API_KEY:
        return False, "No AI API key is configured on this server."
    return True, ""


def is_available() -> bool:
    return availability()[0]


def _safe_detail(response: httpx.Response) -> str:
    """Summarise a provider error without echoing the request back."""
    try:
        error = response.json().get("error", {})
    except ValueError:
        return f"status={response.status_code}"
    return (
        f"status={response.status_code} reason={error.get('status')} "
        f"message={str(error.get('message'))[:160]}"
    )


async def generate_json(
    *,
    prompt: str,
    schema: dict[str, Any],
    image: tuple[bytes, str] | None = None,
    system_instruction: str | None = None,
    max_output_tokens: int = 2048,
) -> AiResponse:
    """Ask the model for JSON matching ``schema``.

    ``image`` is (bytes, mime_type). Passing one makes this a vision call.
    """
    ready, reason = availability()
    if not ready:
        raise AiUnavailableError(reason)

    import base64

    parts: list[dict[str, Any]] = [{"text": prompt}]
    if image is not None:
        content, mime_type = image
        parts.append(
            {
                "inline_data": {
                    "mime_type": mime_type,
                    "data": base64.b64encode(content).decode("ascii"),
                }
            }
        )

    payload: dict[str, Any] = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            # Deterministic: for a clinical document, two runs disagreeing is a
            # defect rather than variety.
            "temperature": 0,
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "maxOutputTokens": max_output_tokens,
        },
    }
    if system_instruction:
        payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    url = f"{BASE_URL}/models/{settings.AI_MODEL}:generateContent"

    try:
        async with httpx.AsyncClient(timeout=settings.AI_TIMEOUT_SECONDS) as client:
            response = await client.post(
                url,
                headers={
                    "x-goog-api-key": settings.AI_API_KEY,
                    "Content-Type": "application/json",
                },
                json=payload,
            )
    except httpx.HTTPError as exc:
        logger.error("ai_request_failed", error=type(exc).__name__)
        raise AiUnavailableError() from exc

    if response.status_code >= 400:
        detail = _safe_detail(response)
        logger.error("ai_request_rejected", detail=detail)
        if response.status_code == 429:
            raise AppError(
                429, ErrorCode.RATE_LIMITED, "The AI service is busy. Try again in a moment."
            )
        raise AiUnavailableError()

    body = response.json()
    candidates = body.get("candidates") or []
    if not candidates:
        # A blocked prompt returns no candidate. Say so plainly rather than
        # producing an empty result that looks like "nothing found".
        reason = (body.get("promptFeedback") or {}).get("blockReason")
        logger.warning("ai_no_candidate", reason=reason)
        raise AiUnavailableError("The AI service could not process that document.")

    try:
        text = candidates[0]["content"]["parts"][0]["text"]
        data = json.loads(text)
    except (KeyError, IndexError, ValueError) as exc:
        logger.error("ai_response_unparsable", error=type(exc).__name__)
        raise AiUnavailableError("The AI service returned an unusable response.") from exc

    usage = body.get("usageMetadata") or {}
    return AiResponse(
        data=data,
        model=settings.AI_MODEL,
        prompt_tokens=usage.get("promptTokenCount"),
        output_tokens=usage.get("candidatesTokenCount"),
    )
