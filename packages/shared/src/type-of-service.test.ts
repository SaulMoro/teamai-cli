import net from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ignoreTypeOfServiceRefusal } from './type-of-service.js';

let server: net.Server;
let url: string;

beforeEach(async () => {
  // A peer that resets each connection as it accepts it, as an app's server does when it stops under a request.
  server = net.createServer((socket) => { socket.resetAndDestroy(); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  url = `http://127.0.0.1:${address !== null && typeof address === 'object' ? address.port : 0}/`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Node's fetch sets the type of service as each socket connects, and a socket the peer reset first refuses it with
// EINVAL, about once in 2000 requests on macOS: 20000 make the refusal near certain, and it ended the process.
it('lets every fetch to a peer that resets its connections fail as a request, with nothing thrown past it', async () => {
  ignoreTypeOfServiceRefusal();
  let rejected = 0;

  for (let round = 0; round < 500; round += 1) {
    await Promise.all(Array.from({ length: 40 }, () => fetch(url, { method: 'POST', body: '{}' }).catch(() => { rejected += 1; })));
  }

  expect(rejected).toBe(20_000);
}, 60_000);
