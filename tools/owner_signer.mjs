// Messenger owner signer for a box whose private gateway (Caddy + tailscaled userspace node) already knows the real
// peer. It is the "authenticated Wizard gateway" TRUSTED-WIZARD-OWNER.md asks for, built for a box where the App
// Manager owner edge cannot run (tailscaled is not root there).
//
//   phone/desktop -> private gateway (Caddy, PROXY v1 peer) -> THIS signer (private Unix socket, 0600)
//                 -> Messenger 127.0.0.1:<port>
//
// Per request, and only for a caller that proves all of these, it adds one fresh `X-Wizard-App-Owner-Proof`:
//   1. the peer address came from the gateway on the 0600 socket (a local process needs the same uid as the keys);
//   2. tailscaled whois says the node is untagged, owned by the pinned owner login, and its stable node id is on the
//      owner-device list (phones and the owner's own computers, never the servers agents run on);
//   3. there is no Authorization header (agents and bearers are never signed, and are forwarded untouched);
//   4. Sec-Fetch-Site is not cross-site.
// Everything else is forwarded WITHOUT a proof, so Messenger's own fail-closed rules answer it. Client-supplied proof,
// identity and peer headers are always removed. Nothing about a request body is read or logged.
import http from 'node:http'
import fs from 'node:fs'
import { createHmac, randomBytes } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const PROOF_HEADER = 'x-wizard-app-owner-proof'
export const DOMAIN = 'wizard-app-owner-v1'
const STRIP = new Set([PROOF_HEADER, 'x-messenger-owner-proof', 'x-wizard-owner-proof', 'x-wizard-owner', 'x-private-peer',
  'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic', 'tailscale-headers-info', 'x-wizard-store-proof'])
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export function sign({ key, appId = 'messenger', method, target, now = Date.now(), nonce = randomBytes(24).toString('hex') }) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_owner_key')
  if (typeof target !== 'string' || !target.startsWith('/') || /[\r\n]/u.test(target)) throw new Error('invalid_target')
  const timestamp = String(Math.floor(now / 1000))
  const message = [DOMAIN, appId, timestamp, nonce, method, target].join('\n')
  return [timestamp, nonce, createHmac('sha256', key).update(message).digest('hex')].join('.')
}

export function readKey(path) {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const st = fs.fstatSync(fd)
    if (!st.isFile() || (st.mode & 0o077)) throw new Error('owner key must be a private regular file')
    const buf = Buffer.alloc(33); const n = fs.readSync(fd, buf, 0, 33, 0)
    if (n !== 32) throw new Error('owner key must be exactly 32 bytes')
    return buf.subarray(0, 32)
  } finally { fs.closeSync(fd) }
}

// Owner device = untagged node, owned by the pinned login, whose stable id is enrolled. Anything unresolved is no.
export function ownerFromWhois(data, cfg) {
  const node = data?.Node, user = data?.UserProfile
  if (!node || (node.Tags && node.Tags.length) || !user || node.User !== user.ID) return null
  if (user.LoginName !== cfg.owner_login) return null
  const id = node.StableID
  if (typeof id !== 'string' || !id || !cfg.owner_nodes.includes(id)) return null
  return { login: user.LoginName, node: id }
}

export function lookupPeer(ip, socketPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath, path: '/localapi/v0/whois?addr=' + encodeURIComponent(ip), headers: { Host: 'local-tailscaled.sock' }, timeout: 2000 }, res => {
      let body = ''
      res.on('data', d => { body += d; if (body.length > 131072) req.destroy(new Error('too large')) })
      res.on('end', () => { try { if (res.statusCode !== 200) throw new Error('whois'); resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.on('timeout', () => req.destroy(new Error('whois timeout')))
    req.on('error', reject)
  })
}

function tailnetPeer(ip) {
  if (typeof ip !== 'string') return false
  const m = /^100\.(\d+)\.\d+\.\d+$/u.exec(ip)
  return (m && +m[1] >= 64 && +m[1] <= 127) || ip.toLowerCase().startsWith('fd7a:115c:a1e0:')
}

export function createSigner({ cfg, key, lookup, backend, log = () => {}, appId = 'messenger', cacheMs = 10000 }) {
  const cache = new Map()
  async function owner(ip) {
    const hit = cache.get(ip)
    if (hit && hit.until > Date.now()) return hit.owner
    let result = null
    try { result = ownerFromWhois(await lookup(ip), cfg) } catch { result = null }
    cache.set(ip, { owner: result, until: Date.now() + (result ? cacheMs : 2000) })
    if (cache.size > 256) cache.delete(cache.keys().next().value)
    return result
  }
  return http.createServer(async (req, res) => {
    const headers = {}
    const raw = req.rawHeaders
    for (let i = 0; i < raw.length; i += 2) {
      const name = raw[i].toLowerCase()
      if (STRIP.has(name) || HOP.has(name)) continue
      headers[name] = headers[name] === undefined ? raw[i + 1] : [].concat(headers[name], raw[i + 1])
    }
    const peers = req.headers['x-private-peer']
    let verdict = 'unsigned'
    if (typeof peers === 'string' && tailnetPeer(peers) && !req.headers.authorization && req.headers['sec-fetch-site'] !== 'cross-site' &&
        (req.headers['x-forwarded-host'] === undefined || typeof req.headers['x-forwarded-host'] === 'string')) {
      const who = await owner(peers)
      if (who) {
        try { headers[PROOF_HEADER] = sign({ key, appId, method: req.method, target: req.url }); verdict = 'signed' } catch { verdict = 'unsigned' }
      } else verdict = 'not-owner-device'
    } else if (req.headers.authorization) verdict = 'bearer'
    log(req.method, req.url.split('?')[0].replace(/[0-9a-f]{16,}/giu, ':id'), verdict)
    const up = http.request({ ...backend, method: req.method, path: req.url, headers }, upstream => {
      const out = {}
      for (const [k, v] of Object.entries(upstream.headers)) if (!HOP.has(k)) out[k] = v
      res.writeHead(upstream.statusCode, out)
      upstream.pipe(res)
      upstream.on('error', () => res.destroy())
    })
    up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); res.end('Messenger is restarting') } else res.destroy() })
    res.on('close', () => up.destroy())
    req.pipe(up)
  })
}

function main() {
  const env = process.env
  const dir = env.MESSENGER_OWNER_DIR
  const cfg = JSON.parse(fs.readFileSync(`${dir}/signer.json`, 'utf8'))
  if (typeof cfg.owner_login !== 'string' || !Array.isArray(cfg.owner_nodes) || !cfg.owner_nodes.length) throw new Error('signer.json needs owner_login and owner_nodes')
  const key = readKey(`${dir}/proof`)
  const sock = `${dir}/signer.sock`
  try { fs.unlinkSync(sock) } catch { /* none */ }
  const server = createSigner({
    cfg, key,
    lookup: ip => lookupPeer(ip, env.TAILSCALE_SOCKET || '/run/user/1000/tailscale-private-gateway.sock'),
    backend: { host: '127.0.0.1', port: Number(env.MESSENGER_PORT || 9245) },
    log: (m, p, v) => console.log(new Date().toISOString(), m, p, v),
  })
  const old = process.umask(0o177)
  server.listen(sock, () => { process.umask(old); fs.chmodSync(sock, 0o600); console.log('owner signer listening', sock) })
}
// realpath: the unit runs it through a `current` symlink
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) main()
