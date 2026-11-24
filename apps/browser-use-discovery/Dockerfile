# Disposable Browser Use discovery runner. One container per run, started by the launcher with:
#   --network none --read-only --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 (see launcher.py)
# The image holds no credentials; model calls leave only through the launcher's broker (container stdin/stdout).
#
#   docker build -t vtp-browser-use-discovery:1.0.6 apps/browser-use-discovery
FROM python:3.12-slim-bookworm AS agent

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
COPY image-bin /app/bin
COPY src /app/src
RUN python -m compileall -q /app/src \
    && useradd --uid 10001 --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin agent \
    && chmod -R a-w /app

USER 10001:10001
# The runner is PID 1 on purpose: it must be the ONLY process holding the container's stdin/stdout (the broker
# channel). A wrapper such as docker-init or timeout(1) would keep those pipes open in a dumpable process that agent
# code could reach through /proc/1/fd. The runner bounds its own lifetime (210 s self-kill, and exit on stdin EOF).
ENTRYPOINT ["python", "-P", "-m", "discovery_service.runner"]

# The trusted job service (broker) for a container deployment: the same code and dependencies plus the Docker CLI,
# which it uses to start each job's agent container on the host's Docker (mounted socket). It holds the model key and
# the signing token; agent containers never see either.
FROM docker@sha256:34507eb5069d8be82c95dd3b6987d4250fd5fee49b82e2509b7d7a7030740d6d AS docker-cli

FROM agent AS broker
USER root
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
ENV DISCOVERY_SERVICE_HOST=0.0.0.0
ENTRYPOINT ["python", "-P", "-m", "discovery_service.service"]

# The default target stays the agent image (docker build -t vtp-browser-use-discovery:1.0.6 apps/browser-use-discovery).
FROM agent
