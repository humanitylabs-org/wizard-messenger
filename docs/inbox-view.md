# Inbox view: Chats or Compact (0.2.0-unified.16.27)

James (6 Nov 2026): the 16.x list had no message preview line, which broke the chat feel.

Cause: 15.12 (the Miguel list-and-detail release on the shared 16.x line) made the compact row the default and put previews behind Settings > "Message previews in the list" (off). The 15.15.1 line James had been using never had that switch: its rows always showed the last message.

Now: Settings > Inbox view, saved at once on this device (localStorage `messenger.inboxView`).
- Chats (default): picture, name, last message (a group names the sender, your own reads "You:"), time, unread badge. The row code is the same one 15.15.1 used; tests/inbox_view_browser.cjs dumps the rows and `STATIC_ROOT=<15.15.1 static>` produces the 15.15.1 rows to diff.
- Compact: the 16.x denser row (name, time, badge).
One renderer in unified.js drawList(); the old `messenger.previews` key is no longer read.

## Drafts at top (#133, off by default)

Miguel (7 Nov 2026): an agent draft in a weeks-old chat sat far down the list. Settings > Drafts at top (Off/On, absent = Off). Since #150 it is saved on the box for the owner, not per device: `switches.json` in Messenger's data dir, served at `GET/POST api/view/switches` (also `api/switches`) in the `wizard.app-switches/1` shape, so the WizardOS Tracker's Try it toggle, this Settings row and every device agree; the Inbox re-reads it every 5 s while visible. POST needs the owner session, the box's own Origin and `X-Wizard-Switch: 1`; bearers and agent keys are refused. A device that still had the old localStorage `messenger.draftsFirst=1` moves it to the box once and drops the key. On: chats with a waiting draft (yours or your Wizard's, from `api/drafts` or this device's composer) lead the Inbox, newest draft first, then the usual pinned/last-message order. The row keeps its existing "Draft: <first line>" marker. Folders and filters (Low priority, Unread, networks) still apply. Order lives in `chatOrder()` (unified.js; tests/test_drafts_first.cjs, tests/drafts_first_browser.cjs). Not yet: a Drafts filter chip and naming who wrote the draft.
