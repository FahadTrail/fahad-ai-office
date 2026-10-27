import test from 'node:test';
import assert from 'node:assert/strict';
import { sameOrigin } from '../src/hub-server.js';

const request = (headers) => ({ headers });

test('writes are accepted only from the Hub itself (or from non-browser callers)', () => {
  assert.equal(sameOrigin(request({ host: 'office.trimedia.me', origin: 'https://office.trimedia.me' })), true);
  assert.equal(sameOrigin(request({ host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' })), true);
  assert.equal(sameOrigin(request({ host: 'office.trimedia.me' })), true, 'no Origin: not a browser page; auth still applies');
  assert.equal(sameOrigin(request({ host: 'office.trimedia.me', origin: 'https://evil.trimedia.me' })), false, 'a sibling subdomain is same-site but not same-origin');
  assert.equal(sameOrigin(request({ host: 'office.trimedia.me', origin: 'null' })), false);
});
