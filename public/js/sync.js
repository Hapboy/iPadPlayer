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

// Cross-environment animation frame helpers (works in iOS Safari, Chrome, and test runners)
const safeRaf = typeof requestAnimationFrame !== 'undefined' 
  ? requestAnimationFrame 
  : (cb) => setTimeout(cb, 16);

const safeCancelRaf = typeof cancelAnimationFrame !== 'undefined' 
  ? cancelAnimationFrame 
  : (id) => clearTimeout(id);

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

    this.syncMode = options.syncMode || 'free_run'; // 'free_run' (Mode 1: Native 1.0x with loop restart) | 'active_sync' (Mode 2: Continuous smooth sync)
    this.lastDriftMs = 0;
    this.smoothedDriftMs = 0;
    this.lastHardSeekTime = 0;
    this.hardSeekCooldownMs = 3000;
    this.onDriftChange = options.onDriftChange || null;

    this._setupVideoEvents();
  }

  _setupVideoEvents() {
    // Preserve pitch on iOS WebKit / Google Chrome
    try {
      this.video.preservesPitch = true;
      this.video.webkitPreservesPitch = true;
    } catch (e) {}

    this.video.addEventListener('ended', () => {
      if (this.loopEnabled && this.playServerStartTime > 0) {
        // Fallback local loop if server command didn't arrive yet
        this.video.currentTime = 0;
        this.video.playbackRate = 1.0;
        this.video.play().catch(e => console.warn('Video loop play warning:', e));
      }
    });
  }

  setSyncMode(mode) {
    this.syncMode = (mode === 'active_sync') ? 'active_sync' : 'free_run';
    if (this.syncMode === 'free_run') {
      this.video.playbackRate = 1.0;
    }
  }

  setLoop(enabled) {
    this.loopEnabled = !!enabled;
  }

  /**
   * High-precision scheduled play command
   */
  schedulePlay(targetServerTime, startPosition = 0, syncMode = null) {
    this.cancelScheduled();

    if (syncMode) {
      this.setSyncMode(syncMode);
    }

    this.playServerStartTime = targetServerTime;
    this.playStartPosition = Math.max(0, startPosition);
    this.isPlayScheduled = true;
    this.lastHardSeekTime = Date.now();
    this.smoothedDriftMs = 0;

    const targetLocalTime = this.clockSync.toLocalTime(targetServerTime);
    const nowLocal = Date.now();
    const waitMs = targetLocalTime - nowLocal;

    // Set video position ahead of time so the first frame is pre-buffered
    try {
      this.video.currentTime = this.playStartPosition;
      this.video.playbackRate = 1.0;
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
        this.scheduledRafId = safeRaf(step);
      }
    };
    this.scheduledRafId = safeRaf(step);
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

  /**
   * Seamless scheduled loop restart at cycle boundary
   * Synchronously resets position to 0 exactly at targetServerTime
   */
  handleLoopRestart(targetServerTime, syncMode = null) {
    if (syncMode) {
      this.setSyncMode(syncMode);
    }

    const targetLocalTime = this.clockSync.toLocalTime(targetServerTime);
    const nowLocal = Date.now();
    const waitMs = targetLocalTime - nowLocal;

    this.playServerStartTime = targetServerTime;
    this.playStartPosition = 0;
    this.smoothedDriftMs = 0;

    if (waitMs > 25) {
      this.scheduledTimerId = setTimeout(() => {
        const step = () => {
          if (Date.now() >= targetLocalTime - 2) {
            this.video.currentTime = 0;
            this.video.playbackRate = 1.0;
            this.video.play().catch(e => console.warn('Loop restart play:', e));
          } else {
            this.scheduledRafId = safeRaf(step);
          }
        };
        this.scheduledRafId = safeRaf(step);
      }, waitMs - 20);
    } else if (waitMs > 0) {
      const step = () => {
        if (Date.now() >= targetLocalTime - 2) {
          this.video.currentTime = 0;
          this.video.playbackRate = 1.0;
          this.video.play().catch(e => console.warn('Loop restart play:', e));
        } else {
          this.scheduledRafId = safeRaf(step);
        }
      };
      this.scheduledRafId = safeRaf(step);
    } else {
      // Past due
      const elapsed = Math.min(this.video.duration || 10, Math.abs(waitMs) / 1000);
      try {
        this.video.currentTime = elapsed;
      } catch (e) {}
      this.video.playbackRate = 1.0;
      this.video.play().catch(e => console.warn('Loop restart late:', e));
    }
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
    this.smoothedDriftMs = 0;
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
    this.smoothedDriftMs = 0;
  }

  seek(targetServerTime, position, autoPlay = true, syncMode = null) {
    this.cancelScheduled();
    this.playStartPosition = position;
    this.playServerStartTime = targetServerTime;
    this.lastHardSeekTime = Date.now();
    this.smoothedDriftMs = 0;

    if (syncMode) {
      this.setSyncMode(syncMode);
    }

    try {
      this.video.currentTime = position;
    } catch (e) {}

    if (autoPlay) {
      this.schedulePlay(targetServerTime, position, syncMode);
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
      safeCancelRaf(this.scheduledRafId);
      this.scheduledRafId = null;
    }
    this.isPlayScheduled = false;
  }

  _startDriftMonitoring() {
    this.stopDriftMonitoring();
    // Check drift every 250ms during playback
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
    const rawDriftMs = Math.round(driftSec * 1000);
    this.lastDriftMs = rawDriftMs;

    // Exponential Moving Average (EMA) to filter out WebKit/Chrome timer jitter
    this.smoothedDriftMs = Math.round(0.25 * rawDriftMs + 0.75 * this.smoothedDriftMs);

    if (this.onDriftChange) {
      this.onDriftChange(rawDriftMs);
    }

    // ===============================================================
    // MODE 1: Free-run with Loop Auto-Sync
    // During playback, NO drift corrections are made (hardware 1.0x native rate)
    // Synchronicity is reset at each loop boundary!
    // ===============================================================
    if (this.syncMode === 'free_run') {
      if (this.video.playbackRate !== 1.0) {
        this.video.playbackRate = 1.0;
      }
      return;
    }

    // ===============================================================
    // MODE 2: Continuous Precision Active Sync
    // Smooth linear proportional rate adjustment in tight safe window [0.95, 1.05]
    // ===============================================================
    const absSmoothed = Math.abs(this.smoothedDriftMs);
    const now = Date.now();
    const timeSinceLastSeek = now - this.lastHardSeekTime;

    // Deadband: within ±25ms (less than 1 frame at 30/60fps), do not adjust
    if (absSmoothed <= 25) {
      if (this.video.playbackRate !== 1.0) {
        this.video.playbackRate = 1.0;
      }
      return;
    }

    if (absSmoothed >= 600) {
      // Gross desync: hard seek only if cooldown has expired
      if (timeSinceLastSeek > this.hardSeekCooldownMs) {
        try {
          this.video.currentTime = expectedPosition;
        } catch (e) {}
        this.video.playbackRate = 1.0;
        this.lastHardSeekTime = now;
        this.smoothedDriftMs = 0;
      } else {
        // In cooldown: apply safe max rate without resetting buffer
        this.video.playbackRate = this.smoothedDriftMs > 0 ? 0.95 : 1.05;
      }
    } else {
      // Proportional linear smooth rate (imperceptible pitch-preserved scaling)
      const delta = (this.smoothedDriftMs / 1000) * 0.12;
      const targetRate = Math.min(1.05, Math.max(0.95, 1.0 - delta));
      this.video.playbackRate = Math.round(targetRate * 1000) / 1000;
    }
  }

  getDriftMs() {
    return this.lastDriftMs;
  }
}
