# Messenger 0.1.2-beta.1 — private test installation

Two-person encrypted text, dedicated identities, explicit invite acceptance, and encrypted history retained after restart. No root Wizard identity import. The box is the encryption endpoint; relays see traffic metadata. This is a beta, not a Signal security claim.

## Required access and software

- Linux Docker/Compose on arm64 or amd64 (Mac uses its existing Linux Docker VM). No new guest image is required.
- GitHub login with read access to `humanitylabs-org/wizard-messenger`. Images are private release assets: GHCR package scopes are **not** needed.
- A private HTTPS Wizard origin and app gateway; its shared `/wizard-os-home/core/app-client.js` must implement WizardApp v1. Do not copy a fake client into the app.
- Outbound DNS and WSS to the default relays listed in `engine.py`; no paid provider or API key.
- A fresh app-owned persistent directory. Never point a beta rehearsal at an existing owner's data.

## Exact package

Use the `v0.1.2-beta.1` private release. Download `messenger-linux-arm64.tar.gz` **or** `messenger-linux-amd64.tar.gz` plus `SHA256SUMS` into an empty directory on the build/data disk. The source tag and image IDs are recorded in `release-images.json`.

```sh
gh release download v0.1.2-beta.1 -R humanitylabs-org/wizard-messenger \
  -p messenger-linux-arm64.tar.gz -p SHA256SUMS -p release-images.json
# Check the downloaded architecture's entry against SHA256SUMS before loading.
sha256sum messenger-linux-arm64.tar.gz
gzip -dc messenger-linux-arm64.tar.gz | docker load
```

Never use a mutable `latest` tag or skip checksum verification. Select amd64 on x86 Linux; select arm64 on Apple Silicon.

## App-owned install, usable independently of catalog rollout

Clone the tagged source from the private repo and run the helper with **this Wizard's** HTTPS URL. Substitute paths and origin; examples are not a public relay/proxy service.

```sh
python3 tools/beta.py configure --root "$APP_ROOT" \
  --base-url "https://YOUR-WIZARD/apps/messenger/" --port 9245
docker compose -p messenger-beta --project-directory "$APP_ROOT" -f "$APP_ROOT/compose.json" up -d
```

`configure` generates the app-only capability, exact allowed origin, Secure cookie path, loopback-only Compose deployment, gateway fragment and route mapping. Re-running with the same target preserves all data and the capability. It refuses a different target or an unowned nonempty directory. Keep `.env`, `data/`, and `owner-setup-url.txt` private.

The installing agent must apply `$APP_ROOT/route.caddy` **inside the existing private HTTPS site's routing** (Caddy syntax), or the equivalent prefix-stripping route in its gateway. `/apps/messenger/*` goes to `http://127.0.0.1:9245/*`. The existing Wizard gateway continues serving the real shared client at `/wizard-os-home/core/app-client.js`. Do not expose port 9245 publicly. Check both HTTPS resources return the expected JavaScript/HTML before setup. Merge only the `messenger` entry in `route.json` into the Wizard's route registry; never replace the entire registry. App-specific route generation is automatic; activation remains the gateway owner's action, not an undocumented patch.

```sh
python3 tools/beta.py setup --root "$APP_ROOT"
```

The helper writes the one-use bootstrap URL to a mode-0600 file, **not stdout**. Give it only to the local owner, never into release evidence. Open it in that Wizard, create a dedicated account and passphrase, then save the public address. Do not send messages or invitations as another person. The setup token is removed from the browser URL; after account creation the normal route is enough. If setup expires, rerun `setup`. It does not reset an existing identity.

## Wizard App Manager variant

After loading the matching image, the same package is admissible through the unchanged checker and private-repo install path:

```sh
wam install humanitylabs-org/wizard-messenger \
  --set MESSENGER_ALLOWED_ORIGINS=https://YOUR-WIZARD \
  --set MESSENGER_PUBLIC_PATH=/apps/messenger/
```

WAM generates the integration capability. It must retain the skill and project the configured same-origin route. Do **not** run both Compose and WAM backends against one data directory. A shared WAM enhancement to derive the route, configure its gateway and issue first-run setup is tracked in `wizard-app-manager#30`; this release supplies the app helper and explicit contract rather than patching WAM. Private source access does not prove a private catalog card exists.

## Acceptance / restart / update

Use two fresh installations and disposable identities. Exchange public contact codes, invite explicitly, accept on the recipient, send one message each way, and confirm recipient plaintext. “Sent” means relay publication, not peer read. Restart each app, prove a wrong passphrase fails, unlock correctly, and read both prior messages exactly once before sending another. Rerun `configure` and `compose up -d`, checking identity and history remain. API/MCP access exposes only documented capabilities; MCP intentionally has no private send/read tools.

Stop/start: `docker compose -p messenger-beta --project-directory "$APP_ROOT" -f "$APP_ROOT/compose.json" stop` / `start`. Stop preserves data. An upgrade loads the new verified image and recreates the service with the same mount; unlock after restart. Never delete `data/` or run `down -v` as an update. Keep an encrypted whole-app-data backup for rollback; an npub alone is not a history backup. Recipient target gateway/access checks remain explicit; do not claim installation on Miguel's machine until it is actually run there.

## Not included

Groups, attachments, calls, phone push, private-key import, agent message access, public index listing, recipient invitations or messaging as the owner. Contact and access grants are separate human actions; this package does not send any.
