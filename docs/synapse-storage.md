# Synapse storage: Postgres, history caps and media (issue 451)

Messenger's bridged chats (Telegram, WhatsApp, Signal, Slack, LINE, Instagram and the rest) pass through a private
Synapse homeserver inside the app. This page says where that data lives and why.

## Database: SQLite, then Postgres once the owner says so

Synapse documents SQLite as fit for testing only. Switch `synapse-postgres` (Messenger's Try new features, or the
Tracker card) moves it to Postgres:

- Turning the switch on changes nothing at once. The next time Messenger starts (its next update or a restart),
  unified-init wakes the `postgres` container (it only waits for `data/postgres/enabled` until then) and puts
  `synapse_start.py` (a copy of `synapse_postgres.py`) next to Synapse's data.
- `synapse_start.py` runs inside Synapse's own container right before Synapse, so no Synapse can be writing the
  SQLite file during the move. It runs `PRAGMA integrity_check` on `homeserver.db`, makes a backup with SQLite's
  backup API (`homeserver.db.pre-postgres`), checks the backup and its row counts, empties Postgres, runs the
  image's own `synapse_port_db` from the backup, checks the backup again, then compares the row count of every
  table the port tool carries. It then settles the stream sequences the port tool leaves at `RESTART WITH max + 1`:
  Synapse reads such a sequence's `last_value` as its current position, one ahead of what is stored, and a client
  that syncs from its old token (Messenger) then never gets the first new event of each stream. Only when every
  count matches does homeserver.yaml name Postgres; then the old `homeserver.db` is removed and the backup stays.
- Any failure keeps SQLite: Synapse starts as before and `data/matrix/postgres-move.json` says why. It tries again on
  the next start, at most 3 times. Turning the switch off and on again gives it 3 more tries.
- Once moved, Synapse stays on Postgres even with the switch off, because the SQLite backup would miss every message
  that arrived since. `postgres-move.json` (`state: moved`, tables, rows, seconds) and `postgres-move.log` record
  the move.
- The Postgres password is in `data/postgres/password` and Synapse's libpq passfile `data/matrix/postgres.pass`
  (both 0600). homeserver.yaml never holds it. Postgres sits on its own internal network (`postgres-lane`) that only
  Synapse shares.
- Synapse keeps its 768 MB limit; Postgres has 256 MB.
- Synapse's healthcheck allows a 20 minute start period so the one-time move is not cut short. Messenger shows its
  updating screen (issue 439) while it waits.

## History caps

With the switch on, setup raises the caps the bridges and Messenger use for history. The bridges' configs are
written before Synapse's container moves the database (the bridges only start once Synapse answers), so they count
on the move; after a failed move they are back to the SQLite caps until a move succeeds:

| | SQLite | Postgres |
|---|---|---|
| Telegram chats bridged on login (`create_limit`, `login_sync_limit`) | 50 | 200 |
| First messages per new chat (`backfill.max_initial_messages`) | 200 Telegram, 100 others | 500 |
| First messages per new thread | 50 | 100 |
| Messages Messenger imports from a chat it meets for the first time | 500 | 1000 |

Stock Synapse can't put older messages into a chat that already exists: the bridges' backward backfill queue needs
batch sending, which only Beeper's homeserver has. So the higher caps reach chats that are new or rebuilt (Telegram
chats 51 to 200 on the next start, an account that is disconnected and connected again, a new chat). Chats that are
already there keep the history they have. WhatsApp sends its history only while pairing, as before.

## Media: why there are two copies

- The bridges upload every incoming photo, video, voice note and file to Synapse's media store
  (`data/matrix/media`). The networks don't keep their copies for ever (WhatsApp's servers hold a file only for a
  limited time) and direct media is off, so Synapse's store is the only lasting copy of bridged media on the box.
- Messenger's own database (`data/unified/people.sqlite3`) holds message text and media details (type, size, name,
  the Matrix content address), never the files.
- Messenger's `data/unified/media-cache` is a cache of files it fetched from Synapse (opened, or fetched as photos
  arrive), plus its own thumbnails and screen-size copies. It is capped
  (`MESSENGER_MEDIA_CACHE_MB`, 2048 by default) and drops the least recently used files first: originals, then
  view copies, then thumbnails.

So the policy is: Synapse keeps every file for good, and Messenger's copy is a bounded cache that can be thrown
away at any time (it is fetched again from Synapse when needed). Deleting files from Synapse (for example Synapse's
`media_retention`) would lose a photo for good as soon as the cache lets it go, so Messenger does not set it. The
second copy costs at most the cache cap.
