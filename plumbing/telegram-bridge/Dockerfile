# Build from the Messenger repository root:
# docker build -f plumbing/telegram-bridge/Dockerfile -t wizard-telegram-bridge:0.2610.0-albums1 .
FROM golang:1-alpine3.24@sha256:b8c9b82affbbb82a020bbcf998dad2ba9516944ac7e883524642a481a9505e9c AS builder
RUN apk add --no-cache git ca-certificates build-base su-exec olm-dev
WORKDIR /build
RUN git clone --branch v0.2610.0 --depth 1 https://github.com/mautrix/telegram.git . && test "$(git rev-parse HEAD)" = 6991248e6a573489d2d38d603b5dbed1627113bc
COPY plumbing/telegram-bridge/albums.patch /albums.patch
RUN git apply /albums.patch
RUN go test ./pkg/connector/... && go vet ./pkg/connector/... && ./build.sh
FROM dock.mau.dev/mautrix/telegram:v0.2610.0@sha256:ed3f3b39289fae425a875311d8875729271c24f88ba03209bd1bfbaf31e6c78f
RUN apk add --no-cache olm
COPY --from=builder /build/mautrix-telegram /usr/bin/mautrix-telegram
RUN /usr/bin/mautrix-telegram --version
LABEL org.opencontainers.image.source="https://github.com/humanitylabs-org/wizard-messenger" \
      org.wizard.telegram.upstream="6991248e6a573489d2d38d603b5dbed1627113bc" \
      org.wizard.telegram.patch="albums1"
