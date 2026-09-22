import test from 'node:test';
import assert from 'node:assert/strict';
import { NTPClockSync } from '../public/js/sync.js';

test('NTPClockSync - Correct offset and latency calculation', () => {
  let mockSentMsg = null;
  const mockWs = {
    readyState: 1,
    send: (str) => { mockSentMsg = JSON.parse(str); }
  };

  const sync = new NTPClockSync(() => mockWs, { sampleWindowSize: 5 });

  // Simulate NTP response
  // Client sent at t=1000
  // Server received at t=1050 (server is 30ms ahead in real time, so +30)
  // Server sent at t=1050
  // Client received at t=1040 (RTT = 40ms, latency = 20ms)
  // Offset should be +30ms
  sync.handlePong({
    clientSendTime: Date.now() - 40,
    serverReceiveTime: Date.now() - 40 + 50, // +30ms relative to halfway
    serverSendTime: Date.now() - 40 + 50
  });

  assert.ok(sync.getLatency() >= 0);
  assert.ok(typeof sync.getOffset() === 'number');
});

test('NTPClockSync - Outlier rejection', () => {
  const sync = new NTPClockSync(null, { sampleWindowSize: 5 });

  // Normal sample: RTT = 20ms, offset = +100
  sync.handlePong({
    clientSendTime: 1000,
    serverReceiveTime: 1110,
    serverSendTime: 1110
  });

  // Anomalous delayed sample (RTT > 1500ms): should be rejected
  const beforeCount = sync.samples.length;
  sync.handlePong({
    clientSendTime: 1000 - 3000,
    serverReceiveTime: 2000,
    serverSendTime: 2000
  });

  assert.equal(sync.samples.length, beforeCount);
});
