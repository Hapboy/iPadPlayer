/**
 * High-Precision NTP Clock Synchronization & Video Drift Controller
 */

export class NTPClockSync {
  constructor(wsProvider, options = {}) {
    this.wsProvider = wsProvider; // Function or object returning active WebSocket
    this.sampleWindowSize = options.sampleWindowSize || 15;
    this.pingIntervalMs = options.pingIntervalMs || 2500;
    this.samples = [];
    this.clockOffset = 0; // serverTime = localTime + clockOffset
    this.roundTripLatency = 0;
    this.isCalibrated = false;
    this.timer = null;
    this.onSyncUpdate = options.onSyncUpdate || null;
  }

  start() {
    this.stop();
    // Burst of initial pings for quick calibration
    this._sendPing();
    setTimeout(() => this._sendPing(), 200);
    setTimeout(() => this._sendPing(), 500);
    setTimeout(() => this._sendPing(), 1000);

    // Regular background heartbeat sync
    this.timer = setInterval(() => {
      this._sendPing();
    }, this.pingIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  _sendPing() {
    const ws = typeof this.wsProvider === 'function' ? this.wsProvider() : this.wsProvider;
    if (!ws || ws.readyState !== 1) return;

    const clientSendTime = Date.now();
    ws.send(JSON.stringify({
      type: 'sync_ping',
      clientSendTime
    }));
  }

  handlePong(data) {
    const clientReceiveTime = Date.now();
    const { clientSendTime, serverReceiveTime, serverSendTime } = data;

    const rtt = clientReceiveTime - clientSendTime;
    if (rtt < 0 || rtt > 1500) return; // Drop anomalous delays

    // NTP offset formula: ((serverReceive - clientSend) + (serverSend - clientReceive)) / 2
    const offset = ((serverReceiveTime - clientSendTime) + (serverSendTime - clientReceiveTime)) / 2;

    this.samples.push({ offset, rtt });
    if (this.samples.length > this.sampleWindowSize) {
      this.samples.shift();
    }

    // Sort by lowest RTT (best quality samples) and take median offset
    const sortedSamples = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    // Take best 50% samples
    const bestSamples = sortedSamples.slice(0, Math.max(1, Math.ceil(sortedSamples.length / 2)));
    
    // Median of the best samples
    bestSamples.sort((a, b) => a.offset - b.offset);
    const medianIdx = Math.floor(bestSamples.length / 2);
    this.clockOffset = bestSamples[medianIdx].offset;
    this.roundTripLatency = bestSamples[medianIdx].rtt;
    this.isCalibrated = this.samples.length >= 3;

    if (this.onSyncUpdate) {
      this.onSyncUpdate({
        offset: this.clockOffset,
        latency: Math.round(this.roundTripLatency / 2),
        isCalibrated: this.isCalibrated
      });
    }
  }

  getOffset() {
    return this.clockOffset;
  }

  getLatency() {
    return Math.round(this.roundTripLatency / 2);
  }

  getServerTime() {
    return Date.now() + this.clockOffset;
  }

  toLocalTime(serverTime) {
    return serverTime - this.clockOffset;
  }
}

export class VideoSyncController {
  constructor(videoElement, clockSync, options = {}) {
    this.video = videoElement;
    this.clockSync = clockSync;
    this.options = options;

    this.playServerStartTime = 0;
    this.playStartPosition = 0;
    this.isPlayScheduled = false;
    this.scheduledTimerId = null;
    this.scheduledRafId = null;
    this.driftMonitorTimer = null;
    this.loopEnabled = true;

    this.lastDriftMs = 0;
    this.lastHardSeekTime = 0;
    this.hardSeekCooldownMs = 3000;
    this.onDriftChange = options.onDriftChange || null;

    this._setupVideoEvents();
  }

  _setupVideoEvents() {
    this.video.addEventListener('ended', () => {
      if (this.loopEnabled && this.playServerStartTime > 0) {
        // Rewind and prepare next loop iteration seamlessly
        this.video.currentTime = 0;
        this.video.play().catch(e => console.warn('Video loop play warning:', e));
      }
    });
  }

  setLoop(enabled) {
    this.loopEnabled = !!enabled;
  }

  /**
   * High-precision scheduled play command
   */
  schedulePlay(targetServerTime, startPosition = 0) {
    this.cancelScheduled();

    this.playServerStartTime = targetServerTime;
    this.playStartPosition = Math.max(0, startPosition);
    this.isPlayScheduled = true;
    this.lastHardSeekTime = Date.now(); // Reset cooldown on new play

    const targetLocalTime = this.clockSync.toLocalTime(targetServerTime);
    const nowLocal = Date.now();
    const waitMs = targetLocalTime - nowLocal;

    // Set video position ahead of time so the first frame is pre-buffered
    try {
      this.video.currentTime = this.playStartPosition;
    } catch (e) {
      console.warn('Initial seek failed:', e);
    }

    if (waitMs > 25) {
      // Coarse wait with setTimeout, then fine-wait with requestAnimationFrame
      this.scheduledTimerId = setTimeout(() => {
        this._fineTunePlay(targetLocalTime);
      }, waitMs - 20);
    } else if (waitMs > 0) {
      this._fineTunePlay(targetLocalTime);
    } else {
      // Late arrival: compute elapsed time and start immediately
      const elapsedSec = Math.abs(waitMs) / 1000;
      const targetPos = this.playStartPosition + elapsedSec;
      this._startImmediatePlay(targetPos);
    }

    this._startDriftMonitoring();
  }

  _fineTunePlay(targetLocalTime) {
    const step = () => {
      const remaining = targetLocalTime - Date.now();
      if (remaining <= 2) {
        this.video.currentTime = this.playStartPosition;
        this.video.playbackRate = 1.0;
        this.video.play().catch(err => {
          console.error('Play execution error (Autoplay policy?):', err);
        });
        this.isPlayScheduled = false;
        this.scheduledRafId = null;
      } else {
        this.scheduledRafId = requestAnimationFrame(step);
      }
    };
    this.scheduledRafId = requestAnimationFrame(step);
  }

  _startImmediatePlay(seekPosition) {
    const duration = this.video.duration;
    let pos = seekPosition;
    if (duration && duration > 0 && pos >= duration) {
      pos = this.loopEnabled ? (pos % duration) : duration;
    }
    
    try {
      this.video.currentTime = pos;
    } catch (e) {}

    this.video.playbackRate = 1.0;
    this.video.play().catch(err => console.error('Immediate play failed:', err));
    this.isPlayScheduled = false;
  }

  pause(position) {
    this.cancelScheduled();
    this.stopDriftMonitoring();
    this.video.pause();
    this.video.playbackRate = 1.0;

    if (typeof position === 'number' && !isNaN(position)) {
      try {
        this.video.currentTime = position;
      } catch (e) {}
    }
    this.lastDriftMs = 0;
  }

  stop() {
    this.cancelScheduled();
    this.stopDriftMonitoring();
    this.video.pause();
    this.video.playbackRate = 1.0;
    try {
      this.video.currentTime = 0;
    } catch (e) {}
    this.playServerStartTime = 0;
    this.playStartPosition = 0;
    this.lastDriftMs = 0;
  }

  seek(targetServerTime, position, autoPlay = true) {
    this.cancelScheduled();
    this.playStartPosition = position;
    this.playServerStartTime = targetServerTime;
    this.lastHardSeekTime = Date.now();

    try {
      this.video.currentTime = position;
    } catch (e) {}

    if (autoPlay) {
      this.schedulePlay(targetServerTime, position);
    } else {
      this.pause(position);
    }
  }

  cancelScheduled() {
    if (this.scheduledTimerId) {
      clearTimeout(this.scheduledTimerId);
      this.scheduledTimerId = null;
    }
    if (this.scheduledRafId) {
      cancelAnimationFrame(this.scheduledRafId);
      this.scheduledRafId = null;
    }
    this.isPlayScheduled = false;
  }

  _startDriftMonitoring() {
    this.stopDriftMonitoring();
    // Check drift every 250ms during playback (gives decoder stability)
    this.driftMonitorTimer = setInterval(() => {
      this.correctDrift();
    }, 250);
  }

  stopDriftMonitoring() {
    if (this.driftMonitorTimer) {
      clearInterval(this.driftMonitorTimer);
      this.driftMonitorTimer = null;
    }
  }

  correctDrift() {
    if (this.video.paused || this.isPlayScheduled || this.playServerStartTime <= 0) {
      return;
    }

    const currentServerTime = this.clockSync.getServerTime();
    const elapsedSec = (currentServerTime - this.playServerStartTime) / 1000;
    let expectedPosition = this.playStartPosition + elapsedSec;

    const duration = this.video.duration;
    if (duration && duration > 0 && expectedPosition >= duration) {
      if (this.loopEnabled) {
        expectedPosition = expectedPosition % duration;
      } else {
        this.video.pause();
        this.video.currentTime = duration;
        return;
      }
    }

    const driftSec = this.video.currentTime - expectedPosition;
    const driftMs = Math.round(driftSec * 1000);
    this.lastDriftMs = driftMs;

    if (this.onDriftChange) {
      this.onDriftChange(driftMs);
    }

    const absDrift = Math.abs(driftMs);
    const now = Date.now();
    const timeSinceLastSeek = now - this.lastHardSeekTime;

    // Smooth multi-tier sync logic to prevent decoder stutter:
    if (absDrift < 35) {
      // In-sync zone (< 1-2 frames): normal 1.0 playback
      if (this.video.playbackRate !== 1.0) {
        this.video.playbackRate = 1.0;
      }
    } else if (absDrift <= 100) {
      // Micro-drift: imperceptible pitch-neutral adjustment (±2%)
      this.video.playbackRate = driftMs > 0 ? 0.98 : 1.02;
    } else if (absDrift <= 300) {
      // Moderate drift: gentle catchup without any audio pop (±6%)
      this.video.playbackRate = driftMs > 0 ? 0.94 : 1.06;
    } else if (absDrift < 700) {
      // Significant drift (300ms - 700ms): smooth accelerated catchup (±12%)
      // This catches up 350ms in ~3 seconds with ZERO decoder stalls!
      this.video.playbackRate = driftMs > 0 ? 0.88 : 1.12;
    } else {
      // Gross desync (>= 700ms): perform a hard seek ONLY if cooldown has passed
      if (timeSinceLastSeek > this.hardSeekCooldownMs) {
        try {
          this.video.currentTime = expectedPosition;
        } catch (e) {}
        this.video.playbackRate = 1.0;
        this.lastHardSeekTime = now;
      } else {
        // Under cooldown: keep accelerated rate to allow decoder buffer to stabilize
        this.video.playbackRate = driftMs > 0 ? 0.85 : 1.15;
      }
    }
  }

  getDriftMs() {
    return this.lastDriftMs;
  }
}
