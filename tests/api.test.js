import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

// Set test port before importing server
process.env.PORT = '3899';
process.env.TOTAL_DEVICES = '42';

const { serverReady, closeServer, stateManager } = await import('../server/server.js');

test('API & WebSocket Integration Test', async (t) => {
  // Await server listening
  await serverReady;

  const baseUrl = 'http://127.0.0.1:3899';
  const wsUrl = 'ws://127.0.0.1:3899';

  // 1. HTTP GET /api/info
  await t.test('GET /api/info returns server info and URLs', async () => {
    const res = await fetch(`${baseUrl}/api/info`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
    assert.equal(data.totalDevices, 42);
    assert.ok(Array.isArray(data.ips));
    assert.ok(Array.isArray(data.clientUrls));
    assert.ok(Array.isArray(data.adminUrls));
  });

  // 2. HTTP GET /api/state
  await t.test('GET /api/state returns admin snapshot with 42 devices', async () => {
    const res = await fetch(`${baseUrl}/api/state`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.type, 'admin_state');
    assert.equal(data.summary.totalConfigured, 42);
    assert.equal(data.devices.length, 42);
  });

  // 3. WebSocket NTP Ping/Pong
  await t.test('WebSocket NTP sync_ping responds with sync_pong', async () => {
    const clientWs = new WebSocket(wsUrl);
    await new Promise((resolve) => clientWs.on('open', resolve));

    const pongPromise = new Promise((resolve) => {
      clientWs.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'sync_pong') resolve(msg);
      });
    });

    const sendTime = Date.now();
    clientWs.send(JSON.stringify({
      type: 'sync_ping',
      clientSendTime: sendTime
    }));

    const pong = await pongPromise;
    assert.equal(pong.type, 'sync_pong');
    assert.equal(pong.clientSendTime, sendTime);
    assert.ok(typeof pong.serverReceiveTime === 'number');
    assert.ok(typeof pong.serverSendTime === 'number');

    clientWs.close();
  });

  // 4. Client Registration and Telemetry
  await t.test('Client registers slot #12 and reports telemetry', async () => {
    const clientWs = new WebSocket(wsUrl);
    await new Promise((resolve) => clientWs.on('open', resolve));

    const regPromise = new Promise((resolve) => {
      clientWs.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'registered') resolve(msg);
      });
    });

    clientWs.send(JSON.stringify({
      type: 'register',
      role: 'client',
      id: 12,
      name: 'iPad #12',
      isArmed: true,
      fileLoaded: true,
      fileName: 'gallery_intro.mp4',
      fileDuration: 180.0
    }));

    const reg = await regPromise;
    assert.equal(reg.type, 'registered');
    assert.equal(reg.id, 12);

    // Verify state in stateManager
    const slot = stateManager.slots.get(12);
    assert.equal(slot.connected, true);
    assert.equal(slot.fileName, 'gallery_intro.mp4');
    assert.equal(slot.isArmed, true);

    // Send telemetry
    clientWs.send(JSON.stringify({
      type: 'telemetry',
      id: 12,
      currentTime: 45.2,
      isPlaying: true,
      driftMs: 12,
      batteryLevel: 98
    }));

    // Wait brief moment for update
    await new Promise(r => setTimeout(r, 60));
    assert.equal(slot.currentTime, 45.2);
    assert.equal(slot.batteryLevel, 98);

    clientWs.close();
  });

  // 5. Admin command broadcasting to clients
  await t.test('Admin broadcast PLAY command reaches iPad client', async () => {
    const clientWs = new WebSocket(wsUrl);
    const adminWs = new WebSocket(wsUrl);

    await Promise.all([
      new Promise((resolve) => clientWs.on('open', resolve)),
      new Promise((resolve) => adminWs.on('open', resolve))
    ]);

    // Register client as slot #3
    clientWs.send(JSON.stringify({
      type: 'register',
      role: 'client',
      id: 3,
      fileLoaded: true,
      fileName: 'screen_3.mp4'
    }));

    // Register admin
    adminWs.send(JSON.stringify({
      type: 'register',
      role: 'admin'
    }));

    await new Promise(r => setTimeout(r, 80));

    // Listen for command on client
    const cmdPromise = new Promise((resolve) => {
      clientWs.on('message', (raw) => {
        const msg = JSON.parse(raw);
        if (msg.type === 'command' && msg.action === 'play') {
          resolve(msg);
        }
      });
    });

    // Admin triggers play
    adminWs.send(JSON.stringify({
      type: 'admin_command',
      action: 'play',
      delayMs: 500,
      position: 10
    }));

    const receivedCmd = await cmdPromise;
    assert.equal(receivedCmd.action, 'play');
    assert.equal(receivedCmd.startPosition, 10);
    assert.ok(receivedCmd.targetServerTime > Date.now());

    clientWs.close();
    adminWs.close();
  });

  // Clean close
  await closeServer();
});
