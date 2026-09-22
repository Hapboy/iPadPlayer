import test from 'node:test';
import assert from 'node:assert/strict';
import { DeviceStateManager } from '../server/state.js';

test('DeviceStateManager - Initialization of 42 slots', () => {
  const manager = new DeviceStateManager(42);
  assert.equal(manager.totalDevices, 42);
  assert.equal(manager.slots.size, 42);

  const slot1 = manager.slots.get(1);
  assert.ok(slot1);
  assert.equal(slot1.id, 1);
  assert.equal(slot1.name, 'iPad #01');
  assert.equal(slot1.connected, false);

  const slot42 = manager.slots.get(42);
  assert.ok(slot42);
  assert.equal(slot42.id, 42);
  assert.equal(slot42.name, 'iPad #42');
  assert.equal(slot42.connected, false);
});

test('DeviceStateManager - Client registration and validation', () => {
  const manager = new DeviceStateManager(42);
  const mockWs = { readyState: 1, send: () => {} };

  // Valid slot #7
  const slot = manager.registerClient(mockWs, 'sock_123', {
    id: 7,
    name: 'iPad #07',
    fileLoaded: true,
    fileName: 'intro_07.mp4',
    fileDuration: 120.5,
    isArmed: true
  });

  assert.ok(slot);
  assert.equal(slot.id, 7);
  assert.equal(slot.connected, true);
  assert.equal(slot.fileName, 'intro_07.mp4');
  assert.equal(slot.fileDuration, 120.5);
  assert.equal(slot.isArmed, true);

  // Invalid slots
  assert.equal(manager.registerClient(mockWs, 'sock_inv1', { id: 0 }), null);
  assert.equal(manager.registerClient(mockWs, 'sock_inv2', { id: 43 }), null);
  assert.equal(manager.registerClient(mockWs, 'sock_inv3', { id: 'invalid' }), null);
});

test('DeviceStateManager - Telemetry updates and summary calculation', () => {
  const manager = new DeviceStateManager(42);
  const mockWs1 = { readyState: 1, send: () => {} };
  const mockWs2 = { readyState: 1, send: () => {} };

  manager.registerClient(mockWs1, 'sock_1', { id: 1 });
  manager.registerClient(mockWs2, 'sock_2', { id: 2 });

  manager.updateTelemetry('sock_1', {
    isArmed: true,
    fileLoaded: true,
    fileName: 'clip_01.mp4',
    fileDuration: 60,
    currentTime: 10.5,
    isPlaying: true,
    driftMs: -15,
    latencyMs: 8,
    batteryLevel: 94
  });

  manager.updateTelemetry('sock_2', {
    isArmed: true,
    fileLoaded: true,
    fileName: 'clip_02.mp4',
    fileDuration: 60,
    currentTime: 10.55,
    isPlaying: true,
    driftMs: 35,
    latencyMs: 12,
    batteryLevel: 88
  });

  const snapshot = manager.getAdminSnapshot();
  assert.equal(snapshot.summary.connected, 2);
  assert.equal(snapshot.summary.armed, 2);
  assert.equal(snapshot.summary.fileLoaded, 2);
  assert.equal(snapshot.summary.totalConfigured, 42);
  assert.equal(snapshot.summary.maxDriftMs, 35);
  assert.equal(snapshot.devices.length, 42);

  const dev1 = snapshot.devices.find(d => d.id === 1);
  assert.equal(dev1.connected, true);
  assert.equal(dev1.fileName, 'clip_01.mp4');
  assert.equal(dev1.batteryLevel, 94);
});

test('DeviceStateManager - Global playback and timeline calculation', () => {
  const manager = new DeviceStateManager(42);
  manager.globalPlayback.expectedDuration = 100;

  // Stopped
  assert.equal(manager.getCurrentGlobalPosition(), 0);

  // Play from position 10 at time T
  const startTime = Date.now() - 5000; // 5 seconds ago
  manager.setPlay(startTime, 10);
  assert.equal(manager.globalPlayback.status, 'playing');

  const currentPos = manager.getCurrentGlobalPosition();
  // Expect approximately 15 seconds (10 + 5)
  assert.ok(currentPos >= 14.9 && currentPos <= 15.5);

  // Pause
  manager.setPause(15.2);
  assert.equal(manager.globalPlayback.status, 'paused');
  assert.equal(manager.getCurrentGlobalPosition(), 15.2);

  // Stop
  manager.setStop();
  assert.equal(manager.globalPlayback.status, 'stopped');
  assert.equal(manager.getCurrentGlobalPosition(), 0);
});

test('DeviceStateManager - Socket unregistration and cleanup', () => {
  const manager = new DeviceStateManager(42);
  const mockWs = { readyState: 1, send: () => {} };

  manager.registerClient(mockWs, 'sock_10', { id: 10, isArmed: true });
  assert.equal(manager.slots.get(10).connected, true);

  const unregisteredId = manager.unregisterSocket('sock_10');
  assert.equal(unregisteredId, 10);
  assert.equal(manager.slots.get(10).connected, false);
  assert.equal(manager.slots.get(10).isArmed, false);
});

test('DeviceStateManager - syncMode switching and loop boundary auto-sync', () => {
  const manager = new DeviceStateManager(42);
  assert.equal(manager.globalPlayback.syncMode, 'free_run');

  manager.setSyncMode('active_sync');
  assert.equal(manager.globalPlayback.syncMode, 'active_sync');

  manager.setSyncMode('free_run');
  assert.equal(manager.globalPlayback.syncMode, 'free_run');

  // Loop boundary test
  manager.globalPlayback.expectedDuration = 10; // 10s video
  const startTime = Date.now() - 9000; // 9s ago (1s remaining before 10s mark)
  manager.setPlay(startTime, 0);

  // Check boundary with 1.2s lead time (1s <= 1.2s lead time)
  const boundary = manager.checkLoopBoundary(1200);
  assert.ok(boundary, 'Boundary should be detected');
  assert.equal(boundary.nextCycleIndex, 2);
  assert.equal(boundary.syncMode, 'free_run');
  assert.ok(boundary.targetServerTime > Date.now());

  // Second check should not duplicate broadcast
  const duplicate = manager.checkLoopBoundary(1200);
  assert.equal(duplicate, null, 'Should not duplicate broadcast for the same cycle');
});

test('DeviceStateManager - Startup latency tracking and median calculation', () => {
  const manager = new DeviceStateManager(42);
  const mockWs = { readyState: 1, send: () => {} };

  // Register 3 devices with different startup latencies
  manager.registerClient(mockWs, 's1', { id: 1 });
  manager.registerClient(mockWs, 's2', { id: 2 });
  manager.registerClient(mockWs, 's3', { id: 3 });

  manager.updateTelemetry('s1', { startupLatencyMs: 380, driftMs: 10 });
  manager.updateTelemetry('s2', { startupLatencyMs: 440, driftMs: -15 });
  manager.updateTelemetry('s3', { startupLatencyMs: 420, driftMs: 5 });

  // Median of [380, 420, 440] is 420
  assert.equal(manager.getMedianStartupLatency(), 420);

  // Default fallback when no connected devices
  const emptyManager = new DeviceStateManager(42);
  assert.equal(emptyManager.getMedianStartupLatency(), 420);
});

test('DeviceStateManager - Startup grace period masks transient desync in snapshot', () => {
  const manager = new DeviceStateManager(42);
  const mockWs = { readyState: 1, send: () => {} };
  manager.registerClient(mockWs, 's1', { id: 1, isArmed: true });

  // Start playback right now
  const now = Date.now();
  manager.setPlay(now, 0);

  // Client reports temporary startup latency / drift of -440ms
  manager.updateTelemetry('s1', { driftMs: -440, currentTime: 0.1 });

  // During grace period (now - startServerTime < 1800ms)
  const snapshotGrace = manager.getAdminSnapshot();
  assert.equal(snapshotGrace.summary.isStartingUp, true);
  assert.equal(snapshotGrace.summary.maxDriftMs, 0, 'Summary drift should be masked to 0 during startup');
  assert.equal(snapshotGrace.devices[0].driftMs, 0, 'Device card drift should be masked to 0 during startup');

  // After grace period passes
  manager.globalPlayback.startServerTime = now - 2000;
  const snapshotAfterGrace = manager.getAdminSnapshot();
  assert.equal(snapshotAfterGrace.summary.isStartingUp, false);
  assert.equal(snapshotAfterGrace.summary.maxDriftMs, -440);
  assert.equal(snapshotAfterGrace.devices[0].driftMs, -440);
});

