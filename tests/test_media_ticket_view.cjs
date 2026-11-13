'use strict';
// wizard-os issue 133 (browser boundary): in a window the Wizard sandboxes, Messenger's <img>/<video>/<audio>
// addresses carry the session's media ticket (web.py BrowserAuth.media_ticket); everywhere else they stay as they were.
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {withMediaTicket} = require('../static/unified.js');
const T = 'Tk_' + 'a'.repeat(40);

test('no ticket: the address is unchanged', () => {
  for (const t of ['', null, undefined, 42]) {
    assert.equal(withMediaTicket('api/unified/media/%24a', t), 'api/unified/media/%24a');
    assert.equal(withMediaTicket('api/unified/media/%24a?kind=thumb', t), 'api/unified/media/%24a?kind=thumb');
  }
});

test('the ticket goes first, so kind=thumb still ends the address', () => {
  assert.equal(withMediaTicket('api/unified/media/%24a', T), 'api/unified/media/%24a?t=' + T);
  assert.equal(withMediaTicket('api/unified/media/%24a?kind=thumb', T), 'api/unified/media/%24a?t=' + T + '&kind=thumb');
  assert.ok(withMediaTicket('api/unified/media/%24a?kind=thumb', T).endsWith('kind=thumb'));
  assert.equal(withMediaTicket('api/unified/people/p1/avatar?v=x', 'a b'), 'api/unified/people/p1/avatar?t=a%20b&v=x');
});

// The real mediaURL / ticketed lines from unified.js, run with an opaque and a normal window origin.
function addresses(origin, ticket) {
  const source = fs.readFileSync(path.join(__dirname, '../static/unified.js'), 'utf8');
  const start = source.indexOf('  let mediaTicket = '), end = source.indexOf('\n', source.indexOf('  const mediaURL = '));
  assert.ok(start > 0 && end > start, 'mediaURL block found');
  const box = {self: {origin}, withMediaTicket, encodeURIComponent};
  vm.createContext(box);
  vm.runInContext(source.slice(start, end) + ';mediaTicket = () => ' + JSON.stringify(ticket) + ';this.mediaURL = mediaURL;', box);
  return [box.mediaURL('$p'), box.mediaURL('$p', 'thumb')];
}

test('a sandboxed window (origin "null") adds the ticket; a same-origin window never does', () => {
  assert.deepEqual(addresses('null', T), ['api/unified/media/%24p?t=' + T, 'api/unified/media/%24p?t=' + T + '&kind=thumb']);
  assert.deepEqual(addresses('https://box.example.ts.net', T), ['api/unified/media/%24p', 'api/unified/media/%24p?kind=thumb']);
  assert.deepEqual(addresses('null', ''), ['api/unified/media/%24p', 'api/unified/media/%24p?kind=thumb']);
});
