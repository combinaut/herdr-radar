'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const ipc = require('../lib/ipc');

function endpoint() {
  const name = `herdr-radar-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`);
}

// `server.close()` only calls back once every connection it accepted has ended,
// and on a Windows pipe the server's half of a connection the client destroyed
// can stay open, so the test's own teardown waited forever. Every accepted
// socket is tracked and destroyed first.
function serve(t, onConnection) {
  const at = endpoint();
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    onConnection(socket);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return new Promise((resolve) => server.listen(at, () => resolve(at)));
}

// A promise that never settles would, with nothing else pending, let the
// process exit 0 in the middle of the test. Racing it against a deadline turns
// "hung" into a plain failure.
function within(ms, promise) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still unsettled after ${ms}ms`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function useEndpoint(t, at) {
  const previous = process.env.HERDR_SOCKET_PATH;
  // pipePath adds the Windows pipe prefix itself.
  process.env.HERDR_SOCKET_PATH = process.platform === 'win32' ? at.slice(9) : at;
  t.after(() => {
    if (previous === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = previous;
  });
}

test('IPC reads a reply before close', async (t) => {
  const at = await serve(t, (socket) => socket.on('data', () => socket.end('{"ok":true}\n')));
  useEndpoint(t, at);
  assert.deepEqual(await within(1500, ipc.call('test', {})), { ok: true });
});

test('IPC close without a reply settles promptly and releases waiting calls', async (t) => {
  let accepted = 0;
  const at = await serve(t, (socket) => {
    accepted += 1;
    socket.on('data', () => socket.end());
  });
  useEndpoint(t, at);
  const started = performance.now();
  const replies = await within(1500, Promise.all(Array.from({ length: 17 }, () => ipc.call('test', {}))));
  assert.deepEqual(replies, Array(17).fill(null));
  assert.equal(accepted, 17, 'the call waiting beyond the 16-slot cap also ran');
  assert.ok(performance.now() - started < 1000, 'close settled before the four-second idle timeout');
});
