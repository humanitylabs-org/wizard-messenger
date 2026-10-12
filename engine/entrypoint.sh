#!/bin/sh
set -eu
umask 077
# No host bus/keychain socket is used. Unlock is an authenticated API action.
mkdir -p "${XDG_RUNTIME_DIR:-/run/messenger}"
exec dbus-run-session -- python3 /app/server.py
