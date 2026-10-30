import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { messengerOwnerHeaders } from '../tools/trusted_owner_gateway.mjs'
const key = Buffer.alloc(32, 7)
const base = { method: 'GET', target: '/api/view/session', headers: {}, key }
test('gateway signs only independently authenticated owner, never agent or box-only', () => {
  for (const principal of [null, {kind: 'agent'}, {kind: 'service'}, {kind: 'anonymous'}, {kind: 'owner'}, {kind: 'owner', via: 'box_only'}]) {
    assert.throws(() => messengerOwnerHeaders({...base, principal}), /authenticated_wizard_owner_required/)
  }
  for (const via of ['proxy_proof', 'access_verifier']) {
    const headers = messengerOwnerHeaders({...base, principal: {kind: 'owner', via}})
    assert.match(headers['X-Messenger-Owner-Proof'], /^\d+\.[a-f0-9]{48}\.[a-f0-9]{64}$/)
  }
})
test('gateway strips attacker proofs and refuses every authorization spelling', () => {
  const principal = {kind: 'owner', via: 'proxy_proof'}
  const headers = messengerOwnerHeaders({...base, principal, headers: {'x-messenger-owner-proof': 'forged', 'X-Wizard-Owner-Proof': 'forged', Cookie: 'fixture=1'}})
  assert.equal(headers['x-messenger-owner-proof'], undefined)
  assert.equal(headers['X-Wizard-Owner-Proof'], undefined)
  assert.equal(headers.Cookie, 'fixture=1')
  for (const name of ['Authorization', 'authorization', 'AUTHORIZATION']) {
    assert.throws(() => messengerOwnerHeaders({...base, principal, headers: {[name]: 'Bearer fixture'}}))
  }
})
test('gateway protocol binds method, exact stripped backend target and query', () => {
  const headers = messengerOwnerHeaders({...base, principal: {kind: 'owner', via: 'proxy_proof'}, target: '/api/contacts?limit=2', now: 1700000000000})
  const [stamp, nonce, signature] = headers['X-Messenger-Owner-Proof'].split('.')
  assert.equal(stamp, '1700000000')
  const expected = createHmac('sha256', key).update(['wizard-messenger-owner-v1', stamp, nonce, 'GET', '/api/contacts?limit=2'].join('\n')).digest('hex')
  assert.equal(signature, expected)
})
