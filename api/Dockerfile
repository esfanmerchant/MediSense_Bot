# syntax=docker/dockerfile:1

# =============================================================================
# MediSense API
#
# Two stages. The first has a compiler and pip's cache and produces a virtual
# environment; the second has neither and produces the image that ships. The
# split is not tidiness — a build toolchain left in a running container is a
# toolchain an attacker who reaches that container also has.
#
# The build context is this directory, so `.dockerignore` beside this file is
# the one in force:
#
#   docker build -t medisense-api ./api
#   docker run --env-file .env -p 4000:4000 medisense-api
#
# Nothing secret is baked in. Every value the API needs is read from the
# environment at boot and validated by app/core/config.py, which refuses to
# start on a missing or malformed one rather than failing later inside a login.
# =============================================================================

ARG PYTHON_VERSION=3.13


# --- build -------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS builder

# asyncpg and psycopg ship wheels for this Python, so nothing here should need
# to compile — but "should" is carrying a lot of weight in a dependency tree
# that changes, and a build that fails for want of gcc is a bad way to find out.
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential \
    && rm -rf /var/lib/apt/lists/*

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Only the metadata first, so editing application code does not reinstall the
# dependency tree. This is the layer worth caching; everything after it is
# seconds. The package's __init__.py comes along because pip needs to see the
# package it is being asked to build, and nothing else about it.
WORKDIR /src
COPY pyproject.toml ./pyproject.toml
COPY app/__init__.py ./app/__init__.py

# Local OCR is off by default, deliberately: PaddlePaddle is a ~500 MB
# dependency and the deployed reading path is the vision model. It stays a build
# argument rather than a fork of this file, because a deployment that genuinely
# cannot send documents to an external provider does need the fallback:
#
#   docker build --build-arg INSTALL_OCR=true -t medisense-api ./api
ARG INSTALL_OCR=false
RUN if [ "$INSTALL_OCR" = "true" ]; then pip install ".[ocr]"; else pip install "."; fi

# The dependencies are what this venv is for. The project itself is uninstalled
# again so the image holds exactly one copy of the application — the source tree
# copied below — rather than a second, stale one in site-packages quietly
# shadowing it whenever the working directory changes.
RUN pip uninstall -y --no-input medisense-api


# --- run ---------------------------------------------------------------------
FROM python:${PYTHON_VERSION}-slim AS runtime

# PYTHONDONTWRITEBYTECODE: the filesystem is read-mostly and .pyc files written
# at runtime are noise in a diff of the container.
# PYTHONUNBUFFERED: without it structlog's output sits in a pipe buffer, and the
# logs of a container that dies say nothing about why.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH"

# curl is here for the healthcheck below and nothing else — a deliberate
# addition rather than an accident of a fatter base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 medisense

COPY --from=builder /opt/venv /opt/venv

# The layout mirrors the repository on purpose. app/core/config.py resolves the
# repository root three directories up from itself and looks there for a .env,
# so `api` sitting under `/app` means a mounted /app/.env behaves exactly as it
# does on a developer's machine. In normal operation there is no such file and
# the environment supplies everything.
WORKDIR /app/api
COPY --chown=medisense:medisense . /app/api/

USER medisense

EXPOSE 4000

# Liveness only, and /api/health answers without touching the database — which
# is the right question here. An orchestrator acts on a failed liveness probe by
# restarting, and restarting a healthy API because Postgres was briefly
# unreachable turns one outage into two. /api/health/ready is the readiness
# probe and belongs in the orchestrator's configuration, not baked in here.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl --fail --silent http://127.0.0.1:4000/api/health || exit 1

# Migrations are not run on start, and that is a decision rather than an
# omission: every replica booting at once would race the same ALTER, and a
# schema change on a live clinical database is something a person should be
# watching. Run it as a one-off, against DIRECT_URL — the pooler cannot run DDL:
#
#   docker compose run --rm api alembic upgrade head
#
# One worker. The notification dispatcher runs inside the application's
# lifespan, so a second worker is a second dispatcher sending every email twice.
# Scale with replicas, not with workers.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "4000", "--workers", "1"]
