// Opt-in integration for the trusted Wizard gateway, NOT a public auth endpoint.
// Call with principal supplied by the gateway's real authenticated-owner resolver.
// Never derive principal from request headers, loopback, Origin or auth-mode none.
import { createHmac, randomBytes } from 'node:crypto'

export function messengerOwnerHeaders({ principal, method, target, headers, key, now = Date.now() }) {
  const forwarded = Object.fromEntries(Object.entries(headers || {}).filter(([name]) =>
    !['x-messenger-owner-proof', 'x-wizard-owner', 'x-wizard-owner-proof'].includes(name.toLowerCase())))
  const bearer = Object.keys(forwarded).some(name => name.toLowerCase() === 'authorization')
  if (principal?.kind !== 'owner' || !['proxy_proof', 'access_verifier'].includes(principal?.via) || bearer) {
    // Fail closed; agent traffic must take the existing machine-capability route.
    throw new Error('authenticated_wizard_owner_required')
  }
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('invalid_messenger_owner_key')
  if (!['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'HEAD'].includes(method) || typeof target !== 'string' || !target.startsWith('/') || /[\r\n]/u.test(target)) {
    throw new Error('invalid_messenger_forward_target')
  }
  const timestamp = String(Math.floor(now / 1000)), nonce = randomBytes(24).toString('hex')
  const message = ['wizard-messenger-owner-v1', timestamp, nonce, method, target].join('\n')
  const signature = createHmac('sha256', key).update(message).digest('hex')
  forwarded['X-Messenger-Owner-Proof'] = [timestamp, nonce, signature].join('.')
  return forwarded
}
