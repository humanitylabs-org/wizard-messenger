#!/bin/sh
set -eu
umask 077
# App managers (Runtipi) create the app-data folder as root. When started as root
# with only CHOWN/SETUID/SETGID, take ownership of /data, then drop permanently to
# the unprivileged app user with an empty capability set. Never stay root.
if [ "$(id -u)" = 0 ]; then
  owner="$(stat -c %u:%g /data)"
  # chmod while root still owns it (no CAP_FOWNER), then hand it over.
  if [ "$owner" != 1000:1000 ]; then chmod 700 /data; chown 1000:1000 /data; fi
  exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all -- "$0" "$@"
fi
# No host bus/keychain socket is used. Unlock is an authenticated API action.
mkdir -p "${XDG_RUNTIME_DIR:-/run/messenger}"
chmod 700 "${XDG_RUNTIME_DIR:-/run/messenger}"
exec dbus-run-session -- python3 /app/web.py
