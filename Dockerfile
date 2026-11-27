ARG MDK_BUILD_IMAGE=rust:1.97.1-bookworm
ARG MESSENGER_RUNTIME_BASE=debian:bookworm-slim
FROM ${MDK_BUILD_IMAGE} AS mdk
USER root
WORKDIR /build/mdk
ARG CARGO_JOBS=1
ENV CARGO_BUILD_JOBS=${CARGO_JOBS} CARGO_HOME=/build/cache CARGO_TARGET_DIR=/build/target CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_DEV_INCREMENTAL=false
COPY engine/patches/0001-rustls-0.23.46.patch engine/patches/0002-relay-plane-drop.patch /engine-patches/
# The default path builds the exact upstream source with the tracked security overlay.
# Prebuilt wn/wnd carriers are refused until their rustls 0.23.46 provenance is audited.
RUN --mount=type=cache,target=/build/cache --mount=type=cache,target=/build/target \
    mkdir -p /out && \
    if [ -e /usr/local/bin/wn ] || [ -e /usr/local/bin/wnd ]; then \
      echo 'unproven prebuilt wn/wnd carrier refused; use the source-build path with the rustls security overlay' >&2; exit 1; \
    fi && \
    apt-get update && apt-get install -y --no-install-recommends git pkg-config libssl-dev ca-certificates && \
    git init . && git remote add origin https://github.com/marmot-protocol/mdk.git && \
    git fetch --depth=1 origin 122bd90ffac60bb6311346e228d0f609a18521ee && \
    git checkout --detach FETCH_HEAD && \
    test "$(git rev-parse HEAD)" = 122bd90ffac60bb6311346e228d0f609a18521ee && \
    printf '%s\n' 'c245642970ffd60b0a8c5e9264a8b8d2695ad8f2c08c290a42a3d1ef2b47604b  Cargo.lock' | sha256sum -c - && \
    git apply --check /engine-patches/0001-rustls-0.23.46.patch && \
    git apply --whitespace=error /engine-patches/0001-rustls-0.23.46.patch && \
    printf '%s\n' 'dac950e433d49280ebb9f8c46cfe4432287e0812186115e077bf83fee953377a  Cargo.lock' | sha256sum -c - && \
    git -c user.name=build -c user.email=build@localhost am /engine-patches/0002-relay-plane-drop.patch && \
    cargo build --locked -p wn-cli --bins -j${CARGO_JOBS} && \
    cp /build/target/debug/wn /build/target/debug/wnd /out/

# Issue 445 (switch calls): Element Call, the call screen, from its pinned embedded release (relative paths, so it is
# served from any address). Source maps are dropped; call_door.py serves it only while the calls switch is on.
FROM ${MESSENGER_RUNTIME_BASE} AS element-call
ADD --checksum=sha256:044161bf227914dd2fcf47fea0be2638cbacff96c922ccf6f588232680af53e9 https://github.com/element-hq/element-call/releases/download/v0.29.0/element-call-embedded-0.29.0.tar.gz /tmp/element-call.tar.gz
RUN mkdir -p /opt/element-call && tar -xzf /tmp/element-call.tar.gz -C /opt/element-call --strip-components=1 --no-same-owner && \
    find /opt/element-call -name '*.map' -delete && test -f /opt/element-call/index.html

FROM ${MESSENGER_RUNTIME_BASE} AS runtime
USER root
RUN if ! command -v gnome-keyring-daemon >/dev/null; then \
      apt-get update && apt-get install -y --no-install-recommends python3 dbus gnome-keyring libglib2.0-bin ca-certificates && rm -rf /var/lib/apt/lists/*; \
    fi && \
    (getent passwd 1000 >/dev/null || useradd --uid 1000 --create-home messenger) && \
    mkdir -p /app /data /run/messenger && chown 1000:1000 /data /run/messenger
COPY --from=mdk /out/wn /out/wnd /usr/local/bin/
RUN test "$(wn --version)" = 'wn 0.12.0'
# Issue 445 (switch calls): LiveKit's token service for Matrix (element-hq lk-jwt-service), run by the recipe's
# call-auth container from this image only while the calls switch is on. Static binary from the pinned official image.
COPY --from=ghcr.io/element-hq/lk-jwt-service:0.10.0@sha256:b821befeb148929825f1a9059253d9faa0764991f45c07a91db5ad21a81c2dde /lk-jwt-service /usr/local/bin/lk-jwt-service
COPY --from=element-call /opt/element-call /opt/element-call
COPY owner_unix.py /app/owner_unix.py
COPY engine.py server.py web.py trusted_owner.py passkey.py messenger_addresses.py unified.py group_features.py unified_setup.py synapse_postgres.py calls.py call_door.py telegram_application.py translation.py private_translation.py catchup.py history_cursor.py permissions.py agent_keys.py agent_tools.py wizard_agents.py drafts.py switches.py start_chat.py group_create.py network_contact.py draft_watch.py agent_chat.py agent_inbox_door.py phone_notify.py voice_archive.py inbox_feed.py private_unread.py remote_authority.py contacts_link.py tinfoil_link.py API-contract.json /app/
RUN apt-get update && apt-get install -y --no-install-recommends python3-cryptography python3-pil python3-pypdf opus-tools mkvtoolnix libheif-examples && rm -rf /var/lib/apt/lists/*
# Issue 209 (on for everyone): the translator that runs on the box (Argos models, CTranslate2). Its own folder,
# imported only by the translation worker; models are downloaded on first use into the worker's /models volume.
RUN apt-get update && apt-get install -y --no-install-recommends python3-venv && \
    python3 -m venv /opt/argos && /opt/argos/bin/pip install --no-cache-dir ctranslate2==4.9.0 sentencepiece==0.2.1 && \
    rm -rf /var/lib/apt/lists/* && /opt/argos/bin/python -c "import ctranslate2, sentencepiece"
COPY connector_setup.py connectors.py connector_inbox.py connector_web.py connector_sender.py browser_signin.py /app/
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
LABEL org.opencontainers.image.title="Wizard Messenger" org.opencontainers.image.version="0.2.0-unified.16.35" org.opencontainers.image.licenses="MIT" org.wizardos.messenger.mdk-revision="122bd90ffac60bb6311346e228d0f609a18521ee" org.wizardos.messenger.mdk-patches="rustls-0.23.46,relay-plane-drop" org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-messenger"
ENTRYPOINT ["/app/entrypoint.sh"]
