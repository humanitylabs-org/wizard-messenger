# Upstream beeper/line Dockerfile at 72c7a51a44f344966b916bd2f42a734381061186 (MIT).
# Differences: pinned bases, bounded compiler, optimizer disabled ONLY for the
# huge generated ltsm crypto package to avoid compiler memory/GC collapse.
# Build with tools/build_line_connector.py; this repository is NOT the context.
# syntax=docker/dockerfile:1.22
FROM golang:1.26-alpine3.23@sha256:0525c952defebc693cdaf62cdf43afa32be5a7f377e99260642ea19c240c708e AS builder
RUN apk add --no-cache git build-base olm-dev
WORKDIR /build
ENV GOPATH=/go GOMODCACHE=/go/pkg/mod GOCACHE=/root/.cache/go-build
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod go mod download
COPY cmd ./cmd
COPY pkg ./pkg
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build GOMAXPROCS=2 GOMEMLIMIT=1536MiB go build -p 2 -gcflags='github.com/beeper/line/pkg/ltsm=-N -l' -o matrix-line ./cmd/matrix-line
FROM alpine:3.23@sha256:ff7f0c727dd796aa36787bfcd9a64bf35a6ce72a73451b3359fde849b6703d63
ENV UID=1337 GID=1337
RUN apk add --no-cache ffmpeg su-exec ca-certificates bash jq curl yq-go olm
COPY --from=builder /build/matrix-line /usr/bin/matrix-line
COPY ./docker-run.sh /docker-run.sh
RUN chmod +x /docker-run.sh
ENV BRIDGEV2=1
WORKDIR /data
CMD ["/docker-run.sh"]
