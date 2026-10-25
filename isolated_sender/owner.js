'use strict';
const $ = id => document.getElementById(id);
const decode = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const encode = a => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const ascii = value => JSON.stringify(value, null, 2).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
async function api(path, body, token) {
  const response = await fetch(path, {method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', headers: {'Content-Type': 'application/json', ...(token ? {Authorization: 'Bearer ' + token} : {})}, body: body === undefined ? undefined : JSON.stringify(body)});
  const result = await response.json();
  if (!response.ok) throw new Error(result.detail || 'Request refused');
  return result;
}
function options(raw) {
  const p = {...raw, challenge: decode(raw.challenge)};
  if (p.user) p.user = {...p.user, id: decode(p.user.id)};
  for (const key of ['allowCredentials', 'excludeCredentials']) if (p[key]) p[key] = p[key].map(c => ({...c, id: decode(c.id)}));
  return p;
}
function serialize(c) {
  const r = c.response;
  const response = {clientDataJSON: encode(r.clientDataJSON)};
  for (const k of ['attestationObject', 'authenticatorData', 'signature', 'userHandle']) if (r[k]) response[k] = encode(r[k]);
  if (r.getTransports) response.transports = r.getTransports();
  return {id: c.id, rawId: encode(c.rawId), type: c.type, response, authenticatorAttachment: c.authenticatorAttachment, clientExtensionResults: c.getClientExtensionResults()};
}
async function assert(challenge) {
  const credential = await navigator.credentials.get({publicKey: options(challenge.publicKey)});
  return api('/owner/finish', {challenge_id: challenge.challenge_id, credential: serialize(credential)});
}
async function refresh() {
  const result = await api('/owner/drafts');
  $('mode').textContent = 'Authoritative mode: ' + result.mode + ' | Backend: ' + result.backend;
  $('backendWarning').textContent = result.backend === 'matrix' ? 'REAL MATRIX BACKEND — approvals can send real text and attachments. Matrix acceptance is not bridge/network delivery confirmation. A resumed draft may already be partially sent.' : 'TEST BACKEND ONLY — approvals record local test deliveries, not provider messages.';
  $('fullMode').hidden = !result.allow_full_access;
  $('drafts').replaceChildren();
  for (const draft of result.drafts) {
    const article = document.createElement('article');
    const pre = document.createElement('pre');
    pre.textContent = ascii({id: draft.id, status: draft.status, hash: draft.hash, exact: JSON.parse(draft.payload)});
    article.append(pre);
    if (['pending', 'matrix-queued'].includes(draft.status)) {
      const button = document.createElement('button');
      button.textContent = 'Review this exact draft';
      button.onclick = () => run(() => review({action: 'send', draft_id: draft.id}));
      article.append(button);
    }
    $('drafts').append(article);
  }
}
let pending = null;
async function review(action) {
  pending = await api('/owner/begin', action);
  $('reviewTitle').textContent = pending.action === 'mode' ? 'Change sending authority' : (pending.binding.exact.destination ? 'Approve exact Matrix send / resume (partial delivery possible)' : 'Approve exact TEST delivery');
  $('binding').textContent = ascii(pending.binding);
  $('review').showModal();
}
async function run(fn) {
  try { await fn(); $('status').textContent = 'Completed.'; }
  catch (e) { $('status').textContent = String(e.message); }
}
$('origin').textContent = 'Trusted approval origin: ' + location.origin;
$('enroll').onclick = () => run(async () => {
  const token = $('bootstrap').value;
  $('bootstrap').value = '';
  const ch = await api('/owner/register/begin', {}, token);
  const credential = await navigator.credentials.create({publicKey: options(ch.publicKey)});
  await api('/owner/register/finish', {challenge_id: ch.challenge_id, credential: serialize(credential)}, token);
});
$('login').onclick = () => run(async () => { await assert(await api('/owner/begin', {action: 'login'})); await refresh(); });
$('refresh').onclick = () => run(refresh);
$('logout').onclick = () => run(async () => { await api('/owner/logout', {}); $('drafts').replaceChildren(); $('mode').textContent = 'Signed out'; });
$('draftMode').onclick = () => run(() => review({action: 'mode', mode: 'draft-only'}));
$('fullMode').onclick = () => run(() => review({action: 'mode', mode: 'full-access'}));
$('cancel').onclick = () => { pending = null; $('review').close(); };
$('review').addEventListener('cancel', () => { pending = null; });
$('confirm').onclick = () => run(async () => {
  if (!pending) throw new Error('No pending approval');
  const frozen = pending; pending = null; $('review').close();
  await assert(frozen); await refresh();
});
