ARG MDK_BUILD_IMAGE=rust:1.97.1-bookworm
ARG MESSENGER_RUNTIME_BASE=debian:bookworm-slim
FROM ${MDK_BUILD_IMAGE} AS mdk
USER root
WORKDIR /build/mdk
ENV CARGO_BUILD_JOBS=1 CARGO_HOME=/build/cache CARGO_TARGET_DIR=/build/target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false
# A received, hash-audited prebuilt binary image may be supplied for packaging.
# The default path always builds the exact upstream source and Cargo.lock.
RUN --mount=type=cache,target=/build/cache --mount=type=cache,target=/build/target \
    mkdir -p /out && \
    if [ -x /usr/local/bin/wn ] && [ -x /usr/local/bin/wnd ]; then \
      cp /usr/local/bin/wn /usr/local/bin/wnd /out/; \
    else \
      apt-get update && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates && \
      git init . && git remote add origin https://github.com/marmot-protocol/mdk.git && \
      git fetch --depth=1 origin 122bd90ffac60bb6311346e228d0f609a18521ee && \
      git checkout --detach FETCH_HEAD && \
      test "$(git rev-parse HEAD)" = 122bd90ffac60bb6311346e228d0f609a18521ee && \
      printf '%s\n' 'c245642970ffd60b0a8c5e9264a8b8d2695ad8f2c08c290a42a3d1ef2b47604b  Cargo.lock' | sha256sum -c - && \
      cargo build --locked -p wn-cli --bins -j1 && \
      cp /build/target/debug/wn /build/target/debug/wnd /out/; \
    fi

FROM ${MESSENGER_RUNTIME_BASE} AS runtime
USER root
RUN if ! command -v gnome-keyring-daemon >/dev/null; then \
      apt-get update && apt-get install -y --no-install-recommends python3 dbus gnome-keyring libglib2.0-bin ca-certificates && rm -rf /var/lib/apt/lists/*; \
    fi && \
    (getent passwd 1000 >/dev/null || useradd --uid 1000 --create-home messenger) && \
    mkdir -p /app /data /run/messenger && chown 1000:1000 /data /run/messenger
COPY --from=mdk /out/wn /out/wnd /usr/local/bin/
RUN test "$(wn --version)" = 'wn 0.12.0'
COPY owner_unix.py /app/owner_unix.py
COPY engine.py server.py web.py trusted_owner.py passkey.py messenger_addresses.py unified.py unified_setup.py telegram_application.py translation.py history_cursor.py permissions.py drafts.py remote_authority.py API-contract.json /app/
RUN apt-get update && apt-get install -y --no-install-recommends python3-cryptography && rm -rf /var/lib/apt/lists/*
COPY connector_setup.py connectors.py connector_inbox.py connector_web.py connector_sender.py /app/
COPY readiness/search.py readiness/__init__.py /app/readiness/
COPY push_notifications /app/push_notifications
ARG MESSENGER_BUILD_PUSH=0
RUN if [ "$MESSENGER_BUILD_PUSH" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3-venv && \
      python3 -m venv --system-site-packages /opt/push && /opt/push/bin/pip install --no-cache-dir -r /app/push_notifications/requirements.txt && \
      rm -rf /var/lib/apt/lists/*; fi
ENV PATH="/opt/push/bin:${PATH}"
COPY plumbing /app/plumbing
COPY vendor /app/vendor
COPY static /app/static
COPY favicon.svg icon.png icon-192.png /app/static/
COPY engine/entrypoint.sh /app/entrypoint.sh
COPY engine/upstream-license.txt engine/provenance.json engine/Cargo.lock /app/upstream/
RUN chmod 755 /app/entrypoint.sh
ENV MESSENGER_DATA=/data MESSENGER_PORT=8765 XDG_DATA_HOME=/data XDG_RUNTIME_DIR=/run/messenger WN_SECRET_STORE=keychain WN_KEYCHAIN_SERVICE=org.wizardos.messenger.marmot.v1 PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 1000:1000
WORKDIR /app
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python3 -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8765/healthz', timeout=3)"
LABEL org.opencontainers.image.title="Wizard Messenger" org.opencontainers.image.version="0.2.0-unified.1" org.opencontainers.image.licenses="MIT" org.wizardos.messenger.mdk-revision="122bd90ffac60bb6311346e228d0f609a18521ee"
ENTRYPOINT ["/app/entrypoint.sh"]
