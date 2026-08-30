"""Profile pictures, against a real database and real Supabase Storage.

Three properties are worth proving end to end, and none of them can be proved
without the bucket:

* **Nothing is orphaned.** Replacing a picture removes the old object; removing
  a picture clears the column *and* deletes the object. A unit test can assert
  that the code calls ``storage.remove``; only this can assert the object is
  actually gone.
* **The bucket stays private.** The link is signed, expires, and the object
  refuses an unsigned request — the same rule documents live under.
* **There is no other person's picture to reach.** No endpoint here takes a user
  id, so the test for cross-account access is that the *only* thing a second
  account's request can touch is its own row.

Every row this suite writes is put back. The demo accounts live only in Supabase
and there is no seed script, so a test that leaves ``avatarPath`` set has done
permanent damage to somebody's demo data — the ``pictures`` fixture restores the
value each account started with and deletes every object it caused to exist.
Audit entries are kept; the log is append-only by design.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.db.models import AuditLog, User
from app.db.session import SessionFactory
from app.services import storage
from app.services.avatars import MAX_AVATAR_BYTES
from app.services.storage import StorageUnavailableError
from tests.conftest import requires_db

pytestmark = requires_db

DEMO_PASSWORD = "Demo@Pass123"

PATIENT = "patient@example.com"
OTHER_PATIENT = "patient3@example.com"
DOCTOR = "doctor@example.com"

BUCKET = settings.SUPABASE_AVATARS_BUCKET

PADDING = b"\x00" * 512
PNG = b"\x89PNG\r\n\x1a\n" + PADDING
JPEG = b"\xff\xd8\xff\xe0" + PADDING
PDF = b"%PDF-1.7\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n" + PADDING


def sign_in(client: TestClient, email: str) -> dict[str, Any]:
    client.cookies.clear()
    response = client.post("/api/auth/login", json={"email": email, "password": DEMO_PASSWORD})
    assert response.status_code == 200, f"{email}: {response.text}"
    return response.json()["data"]["user"]


async def user_id_for(email: str) -> str:
    async with SessionFactory() as session:
        return (await session.execute(select(User.id).where(User.email == email))).scalar_one()


async def stored_path_for(email: str) -> str | None:
    async with SessionFactory() as session:
        return (
            await session.execute(select(User.avatar_path).where(User.email == email))
        ).scalar_one()


async def object_exists(path: str) -> bool:
    """Ask storage directly, bypassing the application entirely."""
    try:
        await storage.download(BUCKET, path)
    except StorageUnavailableError:
        return False
    return True


class Pictures:
    """Remembers what each account had before a test touched it."""

    def __init__(self) -> None:
        self.original: dict[str, str | None] = {}

    async def watch(self, email: str) -> None:
        if email not in self.original:
            self.original[email] = await stored_path_for(email)


@pytest.fixture
async def pictures() -> AsyncIterator[Pictures]:
    registry = Pictures()
    yield registry
    if not registry.original:
        return
    async with SessionFactory() as session:
        for email, was in registry.original.items():
            user = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one()
            now = user.avatar_path
            if now and now != was:
                await storage.remove(BUCKET, now)
            user.avatar_path = was
        await session.commit()


def put(client: TestClient, content: bytes = PNG, name: str = "me.png", mime: str = "image/png") -> Any:
    return client.post("/api/account/avatar", files={"file": (name, content, mime)})


async def upload_for(client: TestClient, pictures: Pictures, email: str) -> str:
    """Sign in, watch the account, upload, and return the stored key."""
    await pictures.watch(email)
    sign_in(client, email)
    response = put(client)
    assert response.status_code == 200, response.text
    path = await stored_path_for(email)
    assert path is not None
    return path


class TestSetting:
    async def test_an_account_starts_with_no_picture(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        await pictures.watch(PATIENT)
        sign_in(client, PATIENT)
        client.delete("/api/account/avatar")

        body = client.get("/api/account/avatar").json()["data"]
        client.cookies.clear()

        assert body["avatarUrl"] is None
        # Null rather than zero: there is nothing to schedule a refresh from.
        assert body["expiresInSeconds"] is None

    async def test_an_upload_is_stored_under_its_owners_id(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        path = await upload_for(client, pictures, PATIENT)
        client.cookies.clear()

        assert path.startswith(f"{await user_id_for(PATIENT)}/")
        assert await object_exists(path)

    async def test_the_response_carries_a_signed_expiring_link(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        await pictures.watch(PATIENT)
        sign_in(client, PATIENT)
        body = put(client).json()["data"]
        client.cookies.clear()

        assert body["avatarUrl"].startswith(settings.SUPABASE_URL)
        assert "token=" in body["avatarUrl"]
        assert body["expiresInSeconds"] == settings.SUPABASE_SIGNED_URL_TTL_SECONDS

    async def test_the_signed_link_actually_serves_the_image(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        import httpx

        await pictures.watch(PATIENT)
        sign_in(client, PATIENT)
        url = put(client).json()["data"]["avatarUrl"]
        client.cookies.clear()

        async with httpx.AsyncClient(timeout=30.0) as fetcher:
            fetched = await fetcher.get(url)

        assert fetched.status_code == 200
        assert fetched.content == PNG

    async def test_the_bucket_refuses_an_unsigned_request(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        """Knowing the key is not access. A face is private like a chart is."""
        import httpx

        path = await upload_for(client, pictures, PATIENT)
        client.cookies.clear()

        async with httpx.AsyncClient(timeout=30.0) as fetcher:
            direct = await fetcher.get(
                f"{settings.SUPABASE_URL}/storage/v1/object/public/{BUCKET}/{path}"
            )

        assert direct.status_code >= 400

    async def test_the_picture_reaches_every_session_response(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        """Set once, visible everywhere — the rail, the header, the profile menu.

        ``/auth/me`` stands in for all of them: login, email verification and
        the second factor build the same payload through the same helper.
        """
        await upload_for(client, pictures, PATIENT)
        me = client.get("/api/auth/me").json()["data"]["user"]
        # A fresh sign-in mints its own link rather than reusing that one.
        signed_in = sign_in(client, PATIENT)
        client.cookies.clear()

        assert me["avatarUrl"] and me["avatarUrl"].startswith(settings.SUPABASE_URL)
        assert signed_in["avatarUrl"] and signed_in["avatarUrl"].startswith(settings.SUPABASE_URL)

    async def test_uploading_again_replaces_the_object(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        """The old object must not survive its replacement, or the bucket grows
        a copy of every picture anybody ever had."""
        first = await upload_for(client, pictures, PATIENT)

        assert put(client, JPEG, "me.jpg", "image/jpeg").status_code == 200
        second = await stored_path_for(PATIENT)
        client.cookies.clear()

        assert second is not None
        assert second != first
        assert second.endswith(".jpg")
        assert not await object_exists(first)
        assert await object_exists(second)


class TestRefusals:
    async def test_a_pdf_is_refused(self, client: TestClient, pictures: Pictures) -> None:
        await pictures.watch(PATIENT)
        sign_in(client, PATIENT)
        response = put(client, PDF, "cv.pdf", "application/pdf")
        client.cookies.clear()

        assert response.status_code == 400
        assert "JPEG, PNG or WebP" in response.json()["error"]["message"]
        assert await stored_path_for(PATIENT) is None

    async def test_an_oversized_image_is_refused_with_the_limit_named(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        await pictures.watch(PATIENT)
        sign_in(client, PATIENT)
        oversized = PNG + b"\x00" * (MAX_AVATAR_BYTES - len(PNG) + 1)
        response = put(client, oversized)
        client.cookies.clear()

        assert response.status_code == 400
        assert "5 MB" in response.json()["error"]["message"]
        assert await stored_path_for(PATIENT) is None

    async def test_a_refused_upload_stores_nothing(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        """A rejection must not disturb the picture already on the account."""
        good = await upload_for(client, pictures, PATIENT)

        assert put(client, PDF, "cv.pdf", "application/pdf").status_code == 400
        client.cookies.clear()

        assert await stored_path_for(PATIENT) == good
        assert await object_exists(good)

    async def test_a_signed_out_caller_cannot_upload(self, client: TestClient) -> None:
        client.cookies.clear()
        assert put(client).status_code == 401


class TestRemoval:
    async def test_removing_clears_the_column_and_deletes_the_object(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        path = await upload_for(client, pictures, PATIENT)

        removed = client.delete("/api/account/avatar")
        after = client.get("/api/account/avatar").json()["data"]
        me = client.get("/api/auth/me").json()["data"]["user"]
        client.cookies.clear()

        assert removed.status_code == 200
        assert removed.json()["data"]["removed"] is True
        assert await stored_path_for(PATIENT) is None
        assert not await object_exists(path)
        assert after["avatarUrl"] is None
        assert me["avatarUrl"] is None

    async def test_removing_a_picture_that_is_not_there_is_not_an_error(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        await pictures.watch(PATIENT)
        sign_in(client, PATIENT)
        client.delete("/api/account/avatar")

        again = client.delete("/api/account/avatar")
        client.cookies.clear()

        assert again.status_code == 200
        assert again.json()["data"]["removed"] is False


class TestOneAccountCannotTouchAnother:
    async def test_a_second_account_sees_none_of_the_first_ones_picture(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        await upload_for(client, pictures, PATIENT)

        await pictures.watch(OTHER_PATIENT)
        sign_in(client, OTHER_PATIENT)
        client.delete("/api/account/avatar")
        theirs = client.get("/api/account/avatar").json()["data"]
        client.cookies.clear()

        assert theirs["avatarUrl"] is None

    async def test_a_second_accounts_delete_leaves_the_first_ones_alone(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        """There is no user id in the path, so this is the whole attack surface:
        the endpoint acts on the session's own row and there is nothing to aim
        it at somebody else."""
        mine = await upload_for(client, pictures, PATIENT)

        await pictures.watch(OTHER_PATIENT)
        sign_in(client, OTHER_PATIENT)
        client.delete("/api/account/avatar")
        client.cookies.clear()

        assert await stored_path_for(PATIENT) == mine
        assert await object_exists(mine)

    async def test_a_second_accounts_upload_lands_under_its_own_prefix(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        mine = await upload_for(client, pictures, PATIENT)
        theirs = await upload_for(client, pictures, DOCTOR)
        client.cookies.clear()

        assert theirs.startswith(f"{await user_id_for(DOCTOR)}/")
        assert not theirs.startswith(f"{await user_id_for(PATIENT)}/")
        assert await object_exists(mine)
        assert await object_exists(theirs)


class TestAudit:
    async def test_setting_and_removing_are_both_recorded(
        self, client: TestClient, pictures: Pictures
    ) -> None:
        from app.db.enums import AuditAction

        user_id = await user_id_for(PATIENT)
        await upload_for(client, pictures, PATIENT)
        client.delete("/api/account/avatar")
        client.cookies.clear()

        async with SessionFactory() as session:
            rows = (
                (
                    await session.execute(
                        select(AuditLog)
                        .where(
                            AuditLog.action == AuditAction.USER_UPDATED,
                            AuditLog.user_id == user_id,
                            AuditLog.entity_id == user_id,
                        )
                        .order_by(AuditLog.timestamp.desc())
                        .limit(2)
                    )
                )
                .scalars()
                .all()
            )

        changes = [(row.audit_metadata or {}).get("change") for row in rows]
        assert changes == ["REMOVED", "SET"]
        # References only: the field that moved, the type and the size — never
        # the file's name, which people set to their own.
        stored = rows[1].audit_metadata or {}
        assert stored["field"] == "avatarPath"
        assert stored["mimeType"] == "image/png"
        assert stored["fileSize"] == len(PNG)
        assert "fileName" not in stored
