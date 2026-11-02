"""Send the Wizard OS inbox feed to Notifications whenever it changes (instant phone notifications, no Google).

Messenger declares `uses: [notifications]`; the App Manager then puts it on the link network where Notifications
answers as `notifications`. This thread POSTs the same feed `GET /api/inbox` serves (inbox_feed.feed: unread chats
the badge counts) to Notifications' phone router, which decides per the owner's Settings choice (Chats / Badge / Off)
what reaches the Wizard OS Android app, and over the owner's Tailscale only.

- Wakes on the same in-process change signal as the view and the shell (UnifiedInbox.cond + store.seq); no polling.
  A write the feed doesn't show (outgoing, muted, receipts) changes no version and sends nothing.
- Re-sends the current feed every REFRESH seconds even when unchanged, so a restarted or reinstalled Notifications
  catches up by itself (the router diffs; an unchanged feed makes no phone event).
- Notifications not installed (name doesn't resolve) or down: quiet backoff 5 s .. 5 min. Never blocks Messenger.
- Off with MESSENGER_NOTIFICATIONS_FEED=off. Nothing leaves the box: the URL must be the box-local service name.
"""
import json
import os
import threading
import time
import urllib.error
import urllib.request

import inbox_feed

URL = os.environ.get('MESSENGER_NOTIFICATIONS_FEED_URL', 'http://notifications:8080/notifications/api/app-feed')
REFRESH = 600.0
SETTLE = 0.15
BACKOFF = (5, 15, 60, 300)


def enabled():
    return os.environ.get('MESSENGER_NOTIFICATIONS_FEED', 'on').strip().lower() not in ('off', '0', 'false', 'no')


def _post(url, payload, timeout=10):
    req = urllib.request.Request(url, data=json.dumps(payload, separators=(',', ':')).encode(), method='POST',
                                 headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, json.loads(r.read() or b'{}')


class FeedPusher:
    def __init__(self, unified, url=URL, post=_post, refresh=REFRESH, backoff=BACKOFF):
        self.unified, self.url, self.post, self.refresh, self.backoff = unified, url, post, refresh, backoff
        self.sent = None          # version Notifications last accepted
        self.sent_at = 0.0
        self.failures = 0
        self.last = None          # last outcome, for status/tests: 'sent', 'unchanged', 'unreachable', 'refused'
        self.thread = None

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, name='notifications-feed', daemon=True)
            self.thread.start()
        return self

    def once(self):
        """Send the feed if it changed (or is due a refresh). Returns the seq it covers, or None after a failure."""
        store = self.unified.store
        seq = store.seq
        current = inbox_feed.feed(self.unified)
        if current['version'] == self.sent and time.monotonic() - self.sent_at < self.refresh:
            self.last = 'unchanged'
            return seq
        try:
            status, body = self.post(self.url, {'inbox': 1, 'items': current['items'], 'version': current['version']})
        except urllib.error.HTTPError as e:
            # 403: the link isn't there (yet), 4xx: the router refused this feed. Retry later, never spin.
            self.last = 'refused'
            self.failures += 1
            if self.failures == 1:
                print('notifications feed: refused (HTTP %d)' % e.code, flush=True)
            return None
        except (OSError, ValueError):
            self.last = 'unreachable'
            self.failures += 1
            return None
        self.sent, self.sent_at, self.failures, self.last = current['version'], time.monotonic(), 0, 'sent'
        return seq

    def run(self):
        u = self.unified
        while not u.stop.is_set():
            seen = self.once()
            if seen is None:
                u.stop.wait(self.backoff[min(self.failures, len(self.backoff)) - 1])
                continue
            deadline = time.monotonic() + self.refresh
            with u.cond:
                while u.store.seq == seen and not u.stop.is_set():
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    u.cond.wait(remaining)
            u.stop.wait(SETTLE)   # a new message is several writes (message, identity, translation)
