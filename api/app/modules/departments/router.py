"""Departments — administered by ADMIN, readable by anyone signed in.

Department names are not patient data: a patient booking an appointment needs
the list to choose a specialty, so read is open to any authenticated user while
every write requires the administrative permission.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select

from app.api.deps import CurrentAuth, DbSession, client_ip, require_permission
from app.api.responses import Page, ok, pagination
from app.core.errors import conflict, not_found
from app.db.base import new_id
from app.db.enums import AuditAction
from app.db.models import Department, Doctor
from app.modules.audit.service import AuditEntry, record_audit
from app.modules.auth.rbac import Permission

router = APIRouter(prefix="/departments", tags=["departments"])

RequireDepartmentAdmin = Annotated[
    object, Depends(require_permission(Permission.DEPARTMENT_MANAGE))
]


class DepartmentCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: Annotated[str, Field(min_length=2, max_length=120)]
    code: Annotated[str, Field(min_length=2, max_length=16, pattern=r"^[A-Z0-9_]+$")]
    description: str | None = None
    location: str | None = None


class DepartmentUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    name: Annotated[str, Field(min_length=2, max_length=120)] | None = None
    description: str | None = None
    location: str | None = None
    active: bool | None = None


def _serialize(department: Department, doctor_count: int | None = None) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "id": department.id,
        "name": department.name,
        "code": department.code,
        "description": department.description,
        "location": department.location,
        "active": department.active,
    }
    if doctor_count is not None:
        payload["doctorCount"] = doctor_count
    return payload


@router.get("")
async def list_departments(
    auth: CurrentAuth,
    db: DbSession,
    page: Annotated[Page, Depends(pagination)],
    include_inactive: bool = False,
) -> dict[str, Any]:
    stmt = select(Department, func.count(Doctor.id)).outerjoin(
        Doctor, Doctor.department_id == Department.id
    )
    if not include_inactive:
        stmt = stmt.where(Department.active.is_(True))
    stmt = stmt.group_by(Department.id).order_by(Department.name)

    count_stmt = select(func.count(Department.id))
    if not include_inactive:
        count_stmt = count_stmt.where(Department.active.is_(True))
    total = (await db.execute(count_stmt)).scalar_one()

    rows = (await db.execute(stmt.limit(page.limit).offset(page.offset))).all()
    return ok(
        [_serialize(department, count) for department, count in rows],
        page.meta(total),
    )


@router.post("", status_code=201)
async def create_department(
    payload: DepartmentCreate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireDepartmentAdmin,
) -> dict[str, Any]:
    existing = (
        await db.execute(
            select(Department.id).where(
                (Department.code == payload.code) | (Department.name == payload.name)
            )
        )
    ).first()
    if existing:
        raise conflict("A department with that name or code already exists.")

    department = Department(
        id=new_id(),
        name=payload.name,
        code=payload.code,
        description=payload.description,
        location=payload.location,
    )
    db.add(department)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Department",
            entity_id=department.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            metadata={"operation": "create", "code": payload.code},
        ),
    )
    return ok(_serialize(department))


@router.patch("/{department_id}")
async def update_department(
    department_id: str,
    payload: DepartmentUpdate,
    request: Request,
    auth: CurrentAuth,
    db: DbSession,
    _: RequireDepartmentAdmin,
) -> dict[str, Any]:
    department = (
        await db.execute(select(Department).where(Department.id == department_id))
    ).scalar_one_or_none()
    if department is None:
        raise not_found("Department")

    changed = payload.model_dump(exclude_none=True)
    for field, value in changed.items():
        setattr(department, field, value)
    await db.flush()

    await record_audit(
        db,
        AuditEntry(
            action=AuditAction.CONFIG_CHANGED,
            user_id=auth.user_id,
            actor_role=auth.role,
            entity_type="Department",
            entity_id=department.id,
            ip_address=client_ip(request),
            request_id=getattr(request.state, "request_id", None),
            # Field names only, never the values.
            metadata={"operation": "update", "fields": sorted(changed)},
        ),
    )
    return ok(_serialize(department))
