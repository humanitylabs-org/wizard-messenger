#!/bin/sh
set -eu
umask 077
# No host bus/keychain socket is used. Unlock is an authenticated API action.
mkdir -p "${XDG_RUNTIME_DIR:-/run/messenger}"
chmod 700 "${XDG_RUNTIME_DIR:-/run/messenger}"
exec dbus-run-session -- python3 /app/web.py
