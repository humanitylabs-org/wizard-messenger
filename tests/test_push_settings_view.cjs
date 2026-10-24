'use strict';
const assert = require('node:assert/strict');
const {notificationSettings} = require('../static/unified.js');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
}
(async () => {
  let permission = 0, registered = 0, subscribed = 0, revoked = 0;
  const calls = [];
  const subscription = {toJSON: () => ({endpoint: 'fixture'}), unsubscribe: async () => {revoked++; return true;}};
  const registration = {scope:'https://wizard.example/apps/messenger/', active:{scriptURL:'https://wizard.example/apps/messenger/push-service-worker.js'}, pushManager:{getSubscription: async () => null, subscribe:async options => {assert.equal(options.userVisibleOnly, true); subscribed++; return subscription;}}};
  const env = {document:{createElement:tag => new Element(tag)}, isSecureContext:true, Notification:{requestPermission:async () => {permission++; return 'granted';}}, PushManager: {}, atob: s => Buffer.from(s,'base64').toString('binary'), location:{origin:'https://wizard.example'}, navigator:{serviceWorker:{getRegistration:async () => null, register:async (url, options) => {assert.equal(url, registration.active.scriptURL); assert.equal(options.scope, registration.scope); assert.equal(options.updateViaCache,'none'); registered++; return registration;}}}};
  let config = {enabled:true,public_key:'YWJj',scope:'/apps/messenger/',worker:'/apps/messenger/push-service-worker.js'};
  let failRevoke = false;
  const api = async (path, options) => {calls.push([path, options]); if (!options) return config; if (path.endsWith('unsubscribe') && failRevoke) throw Error('Server revoke failed'); return {id:'fixture-id'};};
  const sheet = new Element('section'); const sibling = new Element('sibling'); sheet.append(sibling);
  await notificationSettings(sheet, api, env);
  assert.equal(sheet.children[0], sibling); assert.equal(permission,0); assert.equal(registered,0);
  const [button,status] = sheet.children[1].children;
  assert.equal(button.textContent,'Enable notifications'); await button.onclick();
  assert.equal(permission,1); assert.equal(registered,1); assert.equal(subscribed,1); assert.equal(button.textContent,'Disable notifications');
  failRevoke = true; await button.onclick(); assert.equal(revoked,0); assert.equal(button.textContent,'Disable notifications'); assert.equal(status.textContent,'Server revoke failed');
  failRevoke = false; await button.onclick(); assert.equal(revoked,1); assert.equal(button.textContent,'Enable notifications');
  env.navigator.serviceWorker.getRegistration = async () => ({...registration, active:{scriptURL:'https://wizard.example/unrelated.js'}});
  await button.onclick(); assert.equal(registered,1); assert.match(status.textContent,/Another service worker/);
  config = {enabled:false}; const dormant = new Element('section'); await notificationSettings(dormant,api,env); assert.equal(dormant.children[0].children.length,0);
  console.log('Push settings synthetic DOM: explicit gesture, enable/revoke, failure, worker scope conflict, dormant, sibling preservation PASS');
})().catch(e => {console.error(e); process.exit(1);});
