from app.errors import install_error_handlers
from app.ids import INT_MAX
from app.routers import progress
from tests.conftest import make_user

NUL = "\x00"


async def test_huge_ids_are_refused_not_500(client, session):
    _, headers = await make_user(session, "kafka")
    big = INT_MAX + 1
    for method, path, body in [
        ("PUT", f"/me/progress/{big}/1", {"position_seconds": 1}),
        ("PUT", f"/me/progress/1/{big}", {"position_seconds": 1}),
        ("PUT", "/me/progress/1/10001", {"position_seconds": 1}),
        ("PUT", f"/watch/choice/{big}", {"source": "auto", "lang": "sub"}),
        ("PUT", f"/manga/{big}/progress/1", {"page": 0, "pages": 3}),
        ("GET", f"/me/progress/{big}", None),
        ("DELETE", f"/me/progress/{big}/continue", None),
    ]:
        r = await client.request(method, path, json=body, headers=headers)
        assert r.status_code == 422, (path, r.status_code)
        assert r.json()["error"]["code"] == "validation_failed"


async def test_nul_in_names_is_a_validation_error(client, session):
    _, headers = await make_user(session, "kafka")
    login = await client.post("/auth/login", json={"username": f"a{NUL}b", "password": "x"})
    assert login.status_code == 422
    lookup = await client.get("/users/lookup", params={"username": f"a{NUL}b"}, headers=headers)
    assert lookup.status_code == 422
    request = await client.post("/friends/requests", json={"username": f"a{NUL}b"}, headers=headers)
    assert request.status_code == 422
    chapter = await client.put(
        "/manga/1/progress/1%00", json={"page": 0, "pages": 3}, headers=headers
    )
    assert chapter.status_code == 422


async def test_lookup_still_trims_spaces(client, session):
    await make_user(session, "friend")
    _, headers = await make_user(session, "kafka")
    r = await client.get("/users/lookup", params={"username": " Friend "}, headers=headers)
    assert r.status_code == 200


async def test_progress_rows_per_account_are_capped(client, session, monkeypatch):
    monkeypatch.setattr(progress, "MAX_PROGRESS_ROWS", 2)
    _, headers = await make_user(session, "kafka")
    for episode in (1, 2):
        r = await client.put(
            f"/me/progress/5/{episode}", json={"position_seconds": 1}, headers=headers
        )
        assert r.status_code == 200
    over = await client.put("/me/progress/5/3", json={"position_seconds": 1}, headers=headers)
    assert over.status_code == 409
    assert over.json()["error"]["code"] == "progress_limit"
    # An episode already saved can still be updated.
    again = await client.put("/me/progress/5/2", json={"position_seconds": 9}, headers=headers)
    assert again.status_code == 200


async def test_progress_saves_are_rate_limited(client, session):
    _, headers = await make_user(session, "kafka")
    client._transport.app.state.action_limits._limiters["progress_save"]._limit = 3
    codes = [
        (
            await client.put("/me/progress/5/1", json={"position_seconds": i}, headers=headers)
        ).status_code
        for i in range(5)
    ]
    assert codes == [200, 200, 200, 429, 429]


async def test_unexpected_errors_answer_json(client):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    app = FastAPI()
    install_error_handlers(app)

    @app.get("/boom")
    async def boom():
        raise RuntimeError("x")

    async with AsyncClient(
        transport=ASGITransport(app=app, raise_app_exceptions=False), base_url="http://t"
    ) as c:
        r = await c.get("/boom")
    assert r.status_code == 500
    assert r.json()["error"]["code"] == "internal_error"
