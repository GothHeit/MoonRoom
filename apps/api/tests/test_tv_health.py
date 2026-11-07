import logging

from tests.conftest import make_user


async def test_tv_health_needs_login(client):
    assert (await client.post("/tv/health", json={})).status_code == 401


async def test_tv_health_is_logged(client, session, caplog):
    _, headers = await make_user(session, "kafka")
    # The test run's migrations switch off loggers made before them.
    logging.getLogger("app.tv_health").disabled = False
    body = {
        "reason": "tick",
        "source": "zoko",
        "anime_id": 339,
        "episode": 3,
        "uptime_s": 1800,
        "buffered_ahead_s": 28.5,
        "js_heap_mb": 210,
        "errors": {"fragLoadTimeOut": 4},
    }
    logger = logging.getLogger("app.tv_health")
    logger.addHandler(caplog.handler)
    try:
        r = await client.post("/tv/health", json=body, headers=headers)
    finally:
        logger.removeHandler(caplog.handler)
    assert r.status_code == 204
    line = caplog.records[-1].getMessage()
    assert "user=kafka" in line and "source=zoko" in line
    assert "heap=210/0MB" in line and "errors=fragLoadTimeOut=4" in line


async def test_tv_health_rejects_odd_text(client, session):
    _, headers = await make_user(session, "kafka")
    r = await client.post("/tv/health", json={"source": "x\nfake log line"}, headers=headers)
    assert r.status_code == 422


async def test_tv_health_is_rate_limited(client, session):
    _, headers = await make_user(session, "kafka")
    for _ in range(60):
        assert (await client.post("/tv/health", json={}, headers=headers)).status_code == 204
    assert (await client.post("/tv/health", json={}, headers=headers)).status_code == 429
