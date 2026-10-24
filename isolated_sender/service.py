"""Independent owner authority. No Wizard imports, tickets, proxy, or provider network calls."""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import time
from urllib.parse import urlsplit
from typing import NoReturn

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field
from webauthn import (
    generate_authentication_options, generate_registration_options,
    options_to_json, verify_authentication_response, verify_registration_response,
)
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria, PublicKeyCredentialDescriptor,
    ResidentKeyRequirement, UserVerificationRequirement,
)


def canonical(value):
    # Versioned ASCII JSON; no Unicode normalization or whitespace/body rewriting.
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


def deny(message="not authorized", code=403) -> NoReturn:
    raise HTTPException(code, message)


class Config(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    origin: str
    rp_id: str
    database: str
    agent_key_sha256: str
    accounts: list[str] = Field(min_length=1)
    backend: str = "test-ledger"
    allow_full_access: bool = False  # owner-only local file, not remotely writable
    independently_administered: bool = False
    challenge_seconds: int = Field(default=120, ge=15, le=300)

    def checked(self):
        u = urlsplit(self.origin)
        if (u.scheme != "https" or not u.hostname or u.username or u.password
                or u.path or u.query or u.fragment or u.port not in (None, 443)
                or self.rp_id != u.hostname or self.rp_id in ("localhost", "127.0.0.1")):
            raise ValueError("exact dedicated HTTPS origin with matching rp_id required")
        if not self.independently_administered:
            raise ValueError("owner must configure an independently administered host; do not deploy on Wizard")
        if self.backend != "test-ledger":
            raise ValueError("only test-ledger is implemented; there is NO production send backend")
        if len(self.agent_key_sha256) != 64 or any(c not in "0123456789abcdef" for c in self.agent_key_sha256):
            raise ValueError("configure a SHA256 digest of a random draft-only key")
        if not Path(self.database).is_absolute():
            raise ValueError("absolute database path required")
        return self


class Attachment(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=200)
    media_type: str = Field(min_length=1, max_length=100)
    data_base64: str = Field(max_length=350000)


class Draft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(min_length=16, max_length=128)
    account: str = Field(min_length=1, max_length=200)
    recipient: str = Field(min_length=1, max_length=500)
    body: str = Field(max_length=20000)
    attachments: list[Attachment] = Field(default_factory=list, max_length=8)

    def exact(self):
        items = []
        total = 0
        for a in self.attachments:
            try:
                raw = base64.b64decode(a.data_base64, validate=True)
            except ValueError:
                deny("invalid attachment encoding", 422)
            total += len(raw)
            if total > 1000000:
                deny("attachments exceed 1MB", 413)
            items.append({"name": a.name, "media_type": a.media_type,
                          "sha256": hashlib.sha256(raw).hexdigest(), "size": len(raw),
                          "data_base64": base64.b64encode(raw).decode()})
        return {"version": 1, "account": self.account, "recipient": self.recipient,
                "body": self.body, "attachments": items}


class Assertion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    challenge_id: str
    credential: dict


class Begin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: str
    draft_id: str | None = None
    mode: str | None = None


SCHEMA = """
CREATE TABLE IF NOT EXISTS authority(id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL,
 epoch INTEGER NOT NULL, bootstrap TEXT);
INSERT OR IGNORE INTO authority VALUES(1,'draft-only',0,NULL);
CREATE TABLE IF NOT EXISTS credentials(id BLOB PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL,
 payload TEXT NOT NULL, hash TEXT NOT NULL, status TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY, challenge BLOB NOT NULL,
 action TEXT NOT NULL, payload TEXT NOT NULL, epoch INTEGER NOT NULL,
 expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires REAL NOT NULL);
CREATE TABLE IF NOT EXISTS test_deliveries(draft_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
 payload_hash TEXT NOT NULL, result TEXT NOT NULL);
"""


class Authority:
    def __init__(self, config: Config):
        self.config = config.checked()
        with self.connect() as db:
            db.executescript(SCHEMA)

    def connect(self):
        db = sqlite3.connect(self.config.database, timeout=15, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA busy_timeout=15000")
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA synchronous=FULL")
        return db

    @contextmanager
    def transaction(self):
        db = self.connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def state(self, db):
        return db.execute("SELECT * FROM authority WHERE id=1").fetchone()

    def bootstrap(self):
        with self.transaction() as db:
            if db.execute("SELECT 1 FROM credentials").fetchone():
                raise ValueError("owner already enrolled; no remotely available reset")
            token = secrets.token_urlsafe(32)
            db.execute("UPDATE authority SET bootstrap=? WHERE id=1", (digest(token),))
            db.execute("DELETE FROM challenges")
            return token

    def check_bootstrap(self, db, token):
        expected = self.state(db)["bootstrap"]
        if (not expected or not hmac.compare_digest(digest(token), expected)
                or db.execute("SELECT 1 FROM credentials").fetchone()):
            deny()

    def challenge(self, db, action, payload):
        epoch = self.state(db)["epoch"]
        binding = canonical({"action": action, "payload": payload, "epoch": epoch})
        challenge = secrets.token_bytes(32) + hashlib.sha256(binding.encode()).digest()
        cid = secrets.token_urlsafe(24)
        db.execute("INSERT INTO challenges VALUES(?,?,?,?,?,?,0)",
                   (cid, challenge, action, canonical(payload), epoch,
                    time.time() + self.config.challenge_seconds))
        return cid, challenge

    def pending(self, db, cid, action=None):
        row = db.execute("SELECT * FROM challenges WHERE id=?", (cid,)).fetchone()
        if (not row or row["used"] or row["expires"] <= time.time()
                or row["epoch"] != self.state(db)["epoch"]
                or (action and row["action"] != action)):
            deny("expired, consumed or invalidated challenge")
        return row

    def assert_owner(self, db, row, credential):
        # No hand-written signature, authenticatorData, rpId or UV verification.
        try:
            cid = base64.urlsafe_b64decode(credential["rawId"] + "=" * (-len(credential["rawId"]) % 4))
            owner = db.execute("SELECT * FROM credentials WHERE id=?", (cid,)).fetchone()
            if not owner:
                deny("unknown credential")
            verified = verify_authentication_response(
                credential=credential, expected_challenge=row["challenge"],
                expected_rp_id=self.config.rp_id, expected_origin=self.config.origin,
                credential_public_key=owner["public_key"],
                credential_current_sign_count=owner["counter"], require_user_verification=True,
            )
        except HTTPException:
            raise
        except Exception:
            deny("invalid owner assertion")
        db.execute("UPDATE credentials SET counter=? WHERE id=?", (verified.new_sign_count, cid))
        db.execute("UPDATE challenges SET used=1 WHERE id=? AND used=0", (row["id"],))

    def deliver_test(self, db, draft_id):
        # Explicitly a local test backend: no messages leave this host. SQLite UNIQUE
        # and the approval transaction give real crash/concurrency-safe idempotency.
        row = db.execute("SELECT * FROM drafts WHERE id=?", (draft_id,)).fetchone()
        if not row or digest(row["payload"]) != row["hash"]:
            deny("draft integrity failure")
        result = {"backend": "test-ledger", "production_send": False,
                  "test_delivery_id": draft_id, "payload_hash": row["hash"]}
        db.execute("INSERT OR IGNORE INTO test_deliveries VALUES(?,?,?,?)",
                   (draft_id, row["payload"], row["hash"], canonical(result)))
        db.execute("UPDATE drafts SET status='test-delivered' WHERE id=?", (draft_id,))
        return result


def create_app(config: Config):
    authority = Authority(config)
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    app.state.authority = authority

    @app.middleware("http")
    async def perimeter(request, call_next):
        # TLS terminates here on the independently controlled host. Ignore
        # X-Forwarded-* entirely: they must never promote a plain HTTP connection.
        if request.url.scheme != "https" or request.headers.get("host") != config.rp_id:
            return JSONResponse({"detail": "trusted TLS and exact Host required"}, status_code=403)
        if request.method not in ("GET", "HEAD") and request.headers.get("origin") != config.origin:
            # Server-side draft producers may omit Origin, but cannot call owner routes.
            if not (request.url.path.startswith("/agent/") and not request.headers.get("origin")):
                return JSONResponse({"detail": "exact owner Origin required"}, status_code=403)
        length = request.headers.get("content-length")
        if length and (not length.isdigit() or int(length) > 1600000):
            return JSONResponse({"detail": "request too large"}, status_code=413)
        if request.method == "POST":
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 1600000:
                    return JSONResponse({"detail": "request too large"}, status_code=413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers.update({
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
            "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
            "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
            "Cache-Control": "no-store", "Permissions-Policy": "publickey-credentials-get=(self), publickey-credentials-create=(self)",
            "X-Frame-Options": "DENY",
        })
        return response

    def bearer(request):
        prefix = "Bearer "
        value = request.headers.get("authorization", "")
        return value[len(prefix):] if value.startswith(prefix) else ""

    def agent(request):
        if not hmac.compare_digest(digest(bearer(request)), config.agent_key_sha256):
            deny()

    def owner(db, request):
        token = digest(request.cookies.get("owner", ""))
        row = db.execute("SELECT 1 FROM sessions WHERE token=? AND expires>?", (token, time.time())).fetchone()
        if not row:
            deny("owner login required", 401)

    @app.get("/")
    def ui():
        return FileResponse(Path(__file__).with_name("owner.html"))

    @app.get("/owner.js")
    def javascript():
        return FileResponse(Path(__file__).with_name("owner.js"), media_type="text/javascript")

    @app.get("/owner.css")
    def stylesheet():
        return FileResponse(Path(__file__).with_name("owner.css"), media_type="text/css")

    @app.get("/health")
    def health():
        return {"service": "independent-owner-authority", "backend": config.backend,
                "production_send": False}

    @app.post("/agent/drafts")
    def draft(value: Draft, request: Request):
        agent(request)
        if value.account not in config.accounts:
            deny("account not configured")
        payload = canonical(value.exact())
        with authority.transaction() as db:
            old = db.execute("SELECT * FROM drafts WHERE request_id=?", (value.request_id,)).fetchone()
            if old:
                if old["payload"] != payload:
                    deny("idempotency key conflicts with exact payload", 409)
                return dict(old)
            did = secrets.token_urlsafe(24)
            db.execute("INSERT INTO drafts VALUES(?,?,?,?, 'pending')", (did, value.request_id, payload, digest(payload)))
            return dict(db.execute("SELECT * FROM drafts WHERE id=?", (did,)).fetchone())

    @app.get("/agent/drafts/{did}")
    def draft_status(did: str, request: Request):
        agent(request)
        with authority.transaction() as db:
            row = db.execute("SELECT * FROM drafts WHERE id=?", (did,)).fetchone()
            if not row:
                deny("not found", 404)
            return dict(row)

    @app.post("/agent/full-send/{did}")
    def full_send(did: str, request: Request):
        agent(request)
        with authority.transaction() as db:
            if not config.allow_full_access or authority.state(db)["mode"] != "full-access":
                deny("draft-only: owner approval required")
            return authority.deliver_test(db, did)

    @app.post("/owner/register/begin")
    def register_begin(request: Request):
        with authority.transaction() as db:
            authority.check_bootstrap(db, bearer(request))
            cid, challenge = authority.challenge(db, "register", {})
            options = generate_registration_options(
                rp_id=config.rp_id, rp_name="Independent Messenger Owner",
                user_name="owner", user_id=b"isolated-messenger-owner",
                challenge=challenge, authenticator_selection=AuthenticatorSelectionCriteria(
                    resident_key=ResidentKeyRequirement.REQUIRED,
                    user_verification=UserVerificationRequirement.REQUIRED),
            )
            return {"challenge_id": cid, "publicKey": json.loads(options_to_json(options))}

    @app.post("/owner/register/finish")
    def register_finish(value: Assertion, request: Request):
        with authority.transaction() as db:
            authority.check_bootstrap(db, bearer(request))
            row = authority.pending(db, value.challenge_id, "register")
            try:
                verified = verify_registration_response(
                    credential=value.credential, expected_challenge=row["challenge"],
                    expected_rp_id=config.rp_id, expected_origin=config.origin,
                    require_user_verification=True,
                )
            except Exception:
                deny("invalid registration")
            db.execute("INSERT INTO credentials VALUES(?,?,?)", (
                verified.credential_id, verified.credential_public_key, verified.sign_count))
            db.execute("UPDATE authority SET bootstrap=NULL, epoch=epoch+1 WHERE id=1")
            db.execute("DELETE FROM challenges")
            return {"enrolled": True}

    @app.post("/owner/begin")
    def begin(value: Begin, request: Request):
        with authority.transaction() as db:
            creds = db.execute("SELECT id FROM credentials").fetchall()
            if not creds:
                deny("owner not enrolled")
            if value.action == "login":
                if value.draft_id is not None or value.mode is not None:
                    deny("invalid login fields", 422)
                payload = {}
            else:
                owner(db, request)
                if value.action == "send" and value.draft_id and value.mode is None:
                    row = db.execute("SELECT * FROM drafts WHERE id=?", (value.draft_id,)).fetchone()
                    if not row or row["status"] != "pending":
                        deny("draft not pending", 409)
                    payload = {"draft_id": row["id"], "hash": row["hash"], "exact": json.loads(row["payload"])}
                elif value.action == "mode" and value.mode in ("draft-only", "full-access") and value.draft_id is None:
                    if value.mode == "full-access" and not config.allow_full_access:
                        deny("full access not enabled in owner-only configuration")
                    payload = {"mode": value.mode}
                else:
                    deny("unsupported action", 422)
            cid, challenge = authority.challenge(db, value.action, payload)
            opts = generate_authentication_options(
                rp_id=config.rp_id, challenge=challenge,
                allow_credentials=[PublicKeyCredentialDescriptor(id=r["id"]) for r in creds],
                user_verification=UserVerificationRequirement.REQUIRED,
            )
            return {"challenge_id": cid, "publicKey": json.loads(options_to_json(opts)),
                    "binding": payload, "action": value.action}

    @app.post("/owner/finish")
    def finish(value: Assertion, request: Request):
        with authority.transaction() as db:
            row = authority.pending(db, value.challenge_id)
            if row["action"] not in ("login", "send", "mode"):
                deny("wrong challenge type")
            if row["action"] != "login":
                owner(db, request)
            authority.assert_owner(db, row, value.credential)
            payload = json.loads(row["payload"])
            if row["action"] == "login":
                token = secrets.token_urlsafe(32)
                db.execute("INSERT INTO sessions VALUES(?,?)", (digest(token), time.time() + 900))
                response = JSONResponse({"logged_in": True})
                response.set_cookie("owner", token, max_age=900, secure=True, httponly=True, samesite="strict", path="/")
                return response
            if row["action"] == "mode":
                if payload["mode"] == "full-access" and not config.allow_full_access:
                    deny("full access disabled by operator")
                db.execute("UPDATE authority SET mode=?,epoch=epoch+1 WHERE id=1", (payload["mode"],))
                return {"mode": payload["mode"]}
            current = db.execute("SELECT * FROM drafts WHERE id=?", (payload["draft_id"],)).fetchone()
            if (not current or current["status"] != "pending" or current["hash"] != payload["hash"]
                    or current["payload"] != canonical(payload["exact"])):
                deny("approved draft changed", 409)
            return authority.deliver_test(db, current["id"])

    @app.get("/owner/drafts")
    def owner_drafts(request: Request):
        with authority.transaction() as db:
            owner(db, request)
            return {"drafts": [dict(r) for r in db.execute("SELECT * FROM drafts ORDER BY rowid DESC LIMIT 100")],
                    "mode": authority.state(db)["mode"], "allow_full_access": config.allow_full_access,
                    "backend": config.backend}

    @app.post("/owner/logout")
    def logout(request: Request):
        with authority.transaction() as db:
            db.execute("DELETE FROM sessions WHERE token=?", (digest(request.cookies.get("owner", "")),))
            response = JSONResponse({"logged_out": True})
            response.delete_cookie("owner", secure=True, httponly=True, samesite="strict")
            return response

    return app


def load_config(path):
    return Config.model_validate_json(Path(path).read_text()).checked()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["init-owner", "serve", "check"])
    parser.add_argument("--config", required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=9443)
    parser.add_argument("--tls-cert")
    parser.add_argument("--tls-key")
    args = parser.parse_args()
    os.umask(0o077)
    config = load_config(args.config)
    if args.command == "init-owner":
        print(Authority(config).bootstrap())  # Owner's independent physical/SSH console ONLY.
    elif args.command == "check":
        print("Configuration valid; independence is an owner trust gate, NOT machine-verifiable. Test backend only.")
    else:
        if not args.tls_cert or not args.tls_key:
            parser.error("direct trusted TLS certificate and private key required (no forwarded-header trust)")
        import uvicorn
        uvicorn.run(create_app(config), host=args.host, port=args.port,
                    ssl_certfile=args.tls_cert, ssl_keyfile=args.tls_key,
                    proxy_headers=False, access_log=False)


if __name__ == "__main__":
    main()
