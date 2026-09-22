import test from 'node:test';
import assert from 'node:assert/strict';
import { NTPClockSync, VideoSyncController } from '../public/js/sync.js';

test('NTPClockSync - Correct offset and latency calculation', () => {
  let mockSentMsg = null;
  const mockWs = {
    readyState: 1,
    send: (str) => { mockSentMsg = JSON.parse(str); }
  };

  const sync = new NTPClockSync(() => mockWs, { sampleWindowSize: 5 });

  // Simulate NTP response
  sync.handlePong({
    clientSendTime: Date.now() - 40,
    serverReceiveTime: Date.now() - 40 + 50,
    serverSendTime: Date.now() - 40 + 50
  });

  assert.ok(sync.getLatency() >= 0);
  assert.ok(typeof sync.getOffset() === 'number');
});

test('NTPClockSync - Outlier rejection', () => {
  const sync = new NTPClockSync(null, { sampleWindowSize: 5 });

  sync.handlePong({
    clientSendTime: 1000,
    serverReceiveTime: 1110,
    serverSendTime: 1110
  });

  const beforeCount = sync.samples.length;
  sync.handlePong({
    clientSendTime: 1000 - 3000,
    serverReceiveTime: 2000,
    serverSendTime: 2000
  });

  assert.equal(sync.samples.length, beforeCount);
});

test('VideoSyncController - Mode 1 (free_run) maintains 1.0x native rate without drift tampering', () => {
  const mockVideo = {
    currentTime: 10.0,
    duration: 60.0,
    paused: false,
    playbackRate: 1.0,
    play: async () => {},
    pause: () => {},
    addEventListener: () => {}
  };

  const mockClock = {
    getServerTime: () => 11000,
    toLocalTime: (t) => t
  };

  const controller = new VideoSyncController(mockVideo, mockClock, { syncMode: 'free_run' });
  controller.playServerStartTime = 1000; // expected elapsed: (11000 - 1000) / 1000 = 10.0s
  controller.playStartPosition = 0;

  // Simulate video drifting ahead (10.5s instead of expected 10.0s)
  mockVideo.currentTime = 10.5;
  controller.correctDrift();

  // In free_run mode, rate MUST remain exactly 1.0x
  assert.equal(mockVideo.playbackRate, 1.0);
});

test('VideoSyncController - Mode 2 (active_sync) applies smooth rate adjustment with EMA filtering', () => {
  const mockVideo = {
    currentTime: 10.0,
    duration: 60.0,
    paused: false,
    playbackRate: 1.0,
    play: async () => {},
    pause: () => {},
    addEventListener: () => {}
  };

  const mockClock = {
    getServerTime: () => 11000,
    toLocalTime: (t) => t
  };

  const controller = new VideoSyncController(mockVideo, mockClock, { syncMode: 'active_sync' });
  controller.playServerStartTime = 1000; // expected elapsed: 10.0s
  controller.playStartPosition = 0;

  // Simulate moderate drift: video is 10.2s (200ms ahead)
  mockVideo.currentTime = 10.2;
  controller.correctDrift();

  // Rate should smoothly slow down (< 1.0) and stay within safe [0.95, 1.05] window
  assert.ok(mockVideo.playbackRate < 1.0, 'Video ahead should slow down');
  assert.ok(mockVideo.playbackRate >= 0.95, 'Rate should stay within safe corridor');

  // Within deadband (< 25ms drift)
  mockVideo.currentTime = 10.01;
  controller.smoothedDriftMs = 10;
  controller.correctDrift();
  assert.equal(mockVideo.playbackRate, 1.0, 'Within deadband rate must be 1.0');
});

test('VideoSyncController - handleLoopRestart seamlessly schedules cycle boundary', () => {
  const mockVideo = {
    currentTime: 59.5,
    duration: 60.0,
    paused: false,
    playbackRate: 1.0,
    play: async () => {},
    pause: () => {},
    addEventListener: () => {}
  };

  const mockClock = {
    getServerTime: () => Date.now(),
    toLocalTime: (t) => t
  };

  const controller = new VideoSyncController(mockVideo, mockClock);
  const targetTime = Date.now() + 500; // starts in 500ms
  controller.handleLoopRestart(targetTime, 'free_run');

  assert.equal(controller.playServerStartTime, targetTime);
  assert.equal(controller.playStartPosition, 0);
  assert.equal(controller.syncMode, 'free_run');
});

test('VideoSyncController - Initial micro-catchup window catches residual startup lag in free_run', () => {
  const mockVideo = {
    currentTime: 0.1,
    duration: 60.0,
    paused: false,
    playbackRate: 1.0,
    play: async () => {},
    pause: () => {},
    addEventListener: () => {}
  };

  const mockClock = {
    getServerTime: () => 1500, // 500ms elapsed since startServerTime
    toLocalTime: (t) => t
  };

  const controller = new VideoSyncController(mockVideo, mockClock, { syncMode: 'free_run' });
  controller.playServerStartTime = 1000;
  controller.playStartPosition = 0;
  // Activate initial micro-catchup window
  controller.initialCatchupUntil = Date.now() + 2000;

  // Expected position: 0.5s. Actual: 0.1s (-400ms lag)
  mockVideo.currentTime = 0.1;
  controller.correctDrift();

  // In free_run, DURING initial catchup window, playback rate should increase to 1.08 to eliminate start lag
  assert.equal(mockVideo.playbackRate, 1.08, 'Should temporarily speed up during initial startup catchup');

  // After initial catchup window expires
  controller.initialCatchupUntil = Date.now() - 100;
  controller.correctDrift();
  // Must return strictly to 1.0x native rate in free_run
  assert.equal(mockVideo.playbackRate, 1.0, 'Must lock to 1.0x once initial catchup window ends');
});

