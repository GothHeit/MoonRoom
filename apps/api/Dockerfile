FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.8 /uv /usr/local/bin/uv

WORKDIR /srv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
RUN uv sync --frozen --no-dev

ENV PATH="/srv/.venv/bin:$PATH"
RUN useradd --system --no-create-home app \
    && mkdir -p /data/avatars /data/manga-pages && chown app /data/avatars /data/manga-pages
ENV AVATAR_DIR=/data/avatars MANGA_CACHE_DIR=/data/manga-pages
USER app
EXPOSE 8000
CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
