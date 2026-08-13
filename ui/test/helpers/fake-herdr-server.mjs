import { once } from 'node:events';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

function timeoutError() {
  const error = new Error('Timed out waiting for a fake Herdr request');
  error.code = 'ERR_TEST_TIMEOUT';
  return error;
}

export async function createFakeHerdrServer() {
  const tempRoot = existsSync('/private/tmp') ? '/private/tmp' : realpathSync(tmpdir());
  const directory = mkdtempSync(join(tempRoot, 'hod-herdr-fake-'));
  const socketPath = join(directory, 'herdr.sock');
  const connections = new Set();
  const requests = [];
  const requestWaiters = [];

  const enqueueRequest = (request) => {
    const waiter = requestWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(request);
    } else {
      requests.push(request);
    }
  };

  const server = createServer((socket) => {
    connections.add(socket);
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      let newline;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          enqueueRequest(JSON.parse(line.toString('utf8')));
        } catch {
          // The client tests only use this parser for valid outgoing requests.
        }
      }
    });
    socket.once('close', () => connections.delete(socket));
  });

  try {
    server.listen(socketPath);
    await once(server, 'listening');
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }

  const getSocket = () => [...connections][0];
  const sendRaw = (data, socket = getSocket()) => {
    if (!socket || socket.destroyed) throw new Error('Fake Herdr socket is not connected');
    socket.write(data);
  };
  const send = (envelope, socket) => sendRaw(`${JSON.stringify(envelope)}\n`, socket);
  const waitForRequest = (timeoutMs = 1_000) => {
    if (requests.length > 0) return Promise.resolve(requests.shift());
    return new Promise((resolve, reject) => {
      const waiter = { resolve, timer: setTimeout(() => {
        const index = requestWaiters.indexOf(waiter);
        if (index >= 0) requestWaiters.splice(index, 1);
        reject(timeoutError());
      }, timeoutMs) };
      requestWaiters.push(waiter);
    });
  };
  const destroyConnection = (socket = getSocket()) => socket?.destroy();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of connections) socket.destroy();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  };

  return {
    directory,
    socketPath,
    server,
    connections,
    getSocket,
    waitForRequest,
    send,
    sendRaw,
    destroyConnection,
    close,
  };
}
