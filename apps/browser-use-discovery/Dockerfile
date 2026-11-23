# Disposable Browser Use discovery runner. One container per run, started by the launcher with:
#   --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 (see launcher.py)
# The image holds no credentials; model calls leave only through the launcher's broker (container stdin/stdout).
#
#   docker build -t vtp-browser-use-discovery:1.0.6 apps/browser-use-discovery
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    BH_CHROME_PATH=/usr/bin/chromium \
    DISCOVERY_FIXTURE_DIR=/app/fixture/site \
    ANONYMIZED_TELEMETRY=false \
    BH_TELEMETRY=0

# Debian's Chromium (not Snap): Browser Use 1.0.6 launches it locally over CDP.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/* \
    # Debian's wrapper exports the distro's Google API keys into Chromium's environment; nothing here needs them
    && rm -f /etc/chromium.d/apikeys

WORKDIR /app
# Hash-locked dependencies exported from uv.lock (uv export --no-dev --format requirements-txt).
COPY requirements.lock /app/requirements.lock
RUN pip install --require-hashes --no-deps -r /app/requirements.lock \
    && python -c "import browser_use, pydantic_ai; print('browser-use import ok')"

COPY fixture/site /app/fixture/site
COPY src /app/src
RUN python -m compileall -q /app/src \
    && useradd --uid 10001 --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin agent \
    && chmod -R a-w /app

USER 10001:10001
# The runner is PID 1 on purpose: it must be the ONLY process holding the container's stdin/stdout (the broker
# channel). A wrapper such as docker-init or timeout(1) would keep those pipes open in a dumpable process that agent
# code could reach through /proc/1/fd. The runner bounds its own lifetime (210 s self-kill, and exit on stdin EOF).
ENTRYPOINT ["python", "-P", "-m", "discovery_service.runner"]
