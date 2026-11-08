import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHmac } from 'node:crypto'
import { sign, ownerFromWhois, createSigner, PROOF_HEADER, DOMAIN } from '../tools/owner_signer.mjs'

const key = Buffer.alloc(32, 9)
const cfg = { owner_login: 'owner@example.com', owner_nodes: ['nPHONE', 'nDESK'] }
const whois = (stable, over = {}) => ({ Node: { StableID: stable, User: 7, Tags: null, ...over.node }, UserProfile: { ID: 7, LoginName: 'owner@example.com', ...over.user } })

test('signature matches the Messenger verifier format (domain, app id, timestamp, nonce, method, target)', () => {
  const nonce = 'ab'.repeat(24)
  const value = sign({ key, method: 'GET', target: '/api/view/session?x=1', now: 1_700_000_000_000, nonce })
  const [ts, n, sig] = value.split('.')
  assert.equal(ts, '1700000000'); assert.equal(n, nonce)
  const expect = createHmac('sha256', key).update([DOMAIN, 'messenger', ts, n, 'GET', '/api/view/session?x=1'].join('\n')).digest('hex')
  assert.equal(sig, expect)
  assert.equal(DOMAIN, 'wizard-app-owner-v1')
})

test('only an untagged, owner-login node on the enrolled list is an owner device', () => {
  assert.ok(ownerFromWhois(whois('nPHONE'), cfg))
  assert.equal(ownerFromWhois(whois('nSERVER'), cfg), null, 'not enrolled (an agent server)')
  assert.equal(ownerFromWhois(whois('nPHONE', { node: { Tags: ['tag:server'] } }), cfg), null, 'tagged')
  assert.equal(ownerFromWhois(whois('nPHONE', { user: { LoginName: 'other@example.com' } }), cfg), null, 'other login')
  assert.equal(ownerFromWhois(whois('nPHONE', { node: { User: 8 } }), cfg), null, 'node not owned by profile')
  assert.equal(ownerFromWhois(whois(undefined), cfg), null, 'no stable id')
  assert.equal(ownerFromWhois(null, cfg), null)
})

async function rig(lookup) {
  const seen = []
  const backend = http.createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'text/plain', connection: 'keep-alive' }); res.end('ok') })
  await new Promise(r => backend.listen(0, '127.0.0.1', r))
  const logs = []
  const signer = createSigner({ cfg, key, lookup, backend: { host: '127.0.0.1', port: backend.address().port }, log: (...a) => logs.push(a.join(' ')) })
  await new Promise(r => signer.listen(0, '127.0.0.1', r))
  const call = (headers, { method = 'GET', path = '/api/view/trusted-owner' } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: signer.address().port, method, path, headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)) })
    req.on('error', reject); req.end()
  })
  return { seen, logs, call, close: () => { signer.close(); backend.close(); signer.closeAllConnections?.(); backend.closeAllConnections?.() } }
}

test('owner device gets exactly one fresh proof; forged identity headers never reach Messenger', async () => {
  const r = await rig(async ip => (ip === '100.80.1.1' ? whois('nPHONE') : whois('nSERVER')))
  try {
    const forged = { 'x-private-peer': '100.80.1.1', 'x-wizard-app-owner-proof': 'forged', 'x-messenger-owner-proof': 'forged', 'tailscale-user-login': 'owner@example.com', 'x-wizard-owner': '1' }
    assert.equal(await r.call(forged), 200)
    const h = r.seen.at(-1)
    assert.match(h[PROOF_HEADER], /^\d{10}\.[0-9a-f]{48}\.[0-9a-f]{64}$/)
    assert.notEqual(h[PROOF_HEADER], 'forged')
    for (const n of ['x-messenger-owner-proof', 'x-wizard-owner', 'tailscale-user-login', 'x-private-peer']) assert.equal(h[n], undefined, n)
    const [ts, nonce, sig] = h[PROOF_HEADER].split('.')
    assert.equal(sig, createHmac('sha256', key).update([DOMAIN, 'messenger', ts, nonce, 'GET', '/api/view/trusted-owner'].join('\n')).digest('hex'))
    await r.call(forged); assert.notEqual(r.seen.at(-1)[PROOF_HEADER].split('.')[1], nonce, 'nonce is never reused')
  } finally { r.close() }
})

test('everyone else is forwarded unsigned: unenrolled node, bearer, cross-site, no peer, bad peer, failed whois', async () => {
  const r = await rig(async ip => { if (ip === '100.80.9.9') throw new Error('whois down'); return ip === '100.80.1.1' ? whois('nPHONE') : whois('nSERVER') })
  try {
    const cases = [
      [{ 'x-private-peer': '100.80.2.2' }, 'unenrolled server'],
      [{ 'x-private-peer': '100.80.1.1', authorization: 'Bearer abc' }, 'bearer from an owner device'],
      [{ 'x-private-peer': '100.80.1.1', 'sec-fetch-site': 'cross-site' }, 'cross-site'],
      [{}, 'no peer header'],
      [{ 'x-private-peer': '8.8.8.8' }, 'non-tailnet peer'],
      [{ 'x-private-peer': '127.0.0.1' }, 'loopback'],
      [{ 'x-private-peer': '100.80.9.9' }, 'whois failure'],
    ]
    for (const [headers, label] of cases) {
      assert.equal(await r.call(headers), 200, label)
      assert.equal(r.seen.at(-1)[PROOF_HEADER], undefined, label)
    }
    assert.equal(r.seen.at(-1).authorization, undefined)
    await r.call({ 'x-private-peer': '100.80.1.1', authorization: 'Bearer abc' })
    assert.equal(r.seen.at(-1).authorization, 'Bearer abc', 'bearer is passed through untouched for Messenger to judge')
  } finally { r.close() }
})

test('logs never carry query strings or long ids', async () => {
  const r = await rig(async () => whois('nPHONE'))
  try {
    await r.call({ 'x-private-peer': '100.80.1.1' }, { path: '/api/chats/0123456789abcdef0123/messages?secret=1' })
    assert.ok(r.logs.at(-1).includes('/api/chats/:id/messages'))
    assert.ok(!r.logs.at(-1).includes('secret'))
  } finally { r.close() }
})
