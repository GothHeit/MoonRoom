# MoonRoom

An anime app for you and your friends: track your list, watch episodes and watch together. Private, invite-only, free.
Available in English and Portuguese (pt-BR).

## Features

- Catalog and list sync (MyAnimeList)
- Player with pluggable video sources
- Watch together in rooms
- Friends, profiles and notifications
- Works on iPhone, with Add to Home Screen

## Layout

```
apps/api/             FastAPI + PostgreSQL
apps/web/             Next.js + TypeScript
packages/api-client/  TypeScript client generated from the API's OpenAPI spec
deploy/               production stack
legacy/               the original version, kept for reference
```

## Running locally

Requirements: Docker, [uv](https://docs.astral.sh/uv/), Node 22, pnpm.

```bash
docker compose up -d db

cd apps/api
cp .env.example .env              # fill JWT_SECRET, TOKEN_ENCRYPTION_KEY and the MAL keys
uv sync
uv run alembic upgrade head
uv run python -m app.cli invite   # invite code for the first account
uv run uvicorn app.main:app --reload   # http://localhost:8000/docs

pnpm install
pnpm dev:web                      # http://localhost:3000
```

After registering: `uv run python -m app.cli promote <username>` makes you an admin. `uv run python -m app.cli reset-2fa <username>` turns off two-factor login for someone locked out.

Tests: `cd apps/api && uv run pytest`, `pnpm lint && pnpm typecheck`, `pnpm --filter web build`.

## Deploying

Production and auto-deploy: [deploy/README.md](deploy/README.md).
