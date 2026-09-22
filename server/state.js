/**
 * State Manager for 42 iPad Synchronized Player
 */

export class DeviceStateManager {
  constructor(totalDevices = 42) {
    this.totalDevices = totalDevices;
    // Map of device slot ID (1..totalDevices) -> device state
    this.slots = new Map();
    // Map of socketId -> device slot ID or client meta
    this.socketToDevice = new Map();
    // Admin sockets set
    this.adminSockets = new Set();

    // Global playback state
    this.globalPlayback = {
      status: 'stopped', // 'stopped' | 'playing' | 'paused'
      position: 0,       // Current or paused position in seconds
      startServerTime: 0, // Server timestamp when playback started
      expectedDuration: 0,
      loop: true,
      lastUpdated: Date.now()
    };

    // Initialize all 42 slots
    for (let i = 1; i <= this.totalDevices; i++) {
      this.slots.set(i, this._createEmptySlot(i));
    }
  }

  _createEmptySlot(id) {
    return {
      id,
      name: `iPad #${String(id).padStart(2, '0')}`,
      connected: false,
      socketId: null,
      ws: null,
      isArmed: false,
      fileLoaded: false,
      fileName: null,
      fileDuration: 0,
      currentTime: 0,
      isPlaying: false,
      playbackRate: 1.0,
      driftMs: 0,
      latencyMs: 0,
      batteryLevel: null,
      isCharging: null,
      isFullscreen: false,
      lastPing: 0,
      error: null
    };
  }

  registerAdmin(ws) {
    this.adminSockets.add(ws);
    return () => this.adminSockets.delete(ws);
  }

  getAdminSockets() {
    return Array.from(this.adminSockets).filter(ws => ws.readyState === 1); // OPEN
  }

  registerClient(ws, socketId, payload = {}) {
    const requestedId = parseInt(payload.id, 10);
    const validId = (!isNaN(requestedId) && requestedId >= 1 && requestedId <= this.totalDevices) 
      ? requestedId 
      : null;

    if (validId) {
      const slot = this.slots.get(validId);
      
      // If another socket is already connected to this slot, close or replace it
      if (slot.ws && slot.ws !== ws && slot.ws.readyState === 1) {
        try {
          slot.ws.send(JSON.stringify({
            type: 'warning',
            message: `Слот #${validId} занят новым подключением. Соединение разорвано.`
          }));
          slot.ws.close();
        } catch (e) {
          // ignore
        }
      }

      slot.connected = true;
      slot.socketId = socketId;
      slot.ws = ws;
      slot.name = payload.name || `iPad #${String(validId).padStart(2, '0')}`;
      slot.lastPing = Date.now();
      slot.error = null;

      if (payload.fileLoaded !== undefined) slot.fileLoaded = !!payload.fileLoaded;
      if (payload.fileName !== undefined) slot.fileName = payload.fileName;
      if (payload.fileDuration !== undefined) {
        slot.fileDuration = Number(payload.fileDuration) || 0;
        this._updateExpectedDuration();
      }
      if (payload.isArmed !== undefined) slot.isArmed = !!payload.isArmed;

      this.socketToDevice.set(socketId, validId);
      return slot;
    }

    // Unassigned device
    this.socketToDevice.set(socketId, null);
    return null;
  }

  updateTelemetry(socketId, data) {
    const deviceId = this.socketToDevice.get(socketId);
    if (!deviceId) return null;

    const slot = this.slots.get(deviceId);
    if (!slot) return null;

    slot.lastPing = Date.now();
    slot.connected = true;

    if (typeof data.isArmed === 'boolean') slot.isArmed = data.isArmed;
    if (typeof data.fileLoaded === 'boolean') slot.fileLoaded = data.fileLoaded;
    if (data.fileName !== undefined) slot.fileName = data.fileName;
    if (typeof data.fileDuration === 'number') {
      slot.fileDuration = data.fileDuration;
      this._updateExpectedDuration();
    }
    if (typeof data.currentTime === 'number') slot.currentTime = data.currentTime;
    if (typeof data.isPlaying === 'boolean') slot.isPlaying = data.isPlaying;
    if (typeof data.playbackRate === 'number') slot.playbackRate = data.playbackRate;
    if (typeof data.driftMs === 'number') slot.driftMs = data.driftMs;
    if (typeof data.latencyMs === 'number') slot.latencyMs = data.latencyMs;
    if (data.batteryLevel !== undefined) slot.batteryLevel = data.batteryLevel;
    if (data.isCharging !== undefined) slot.isCharging = data.isCharging;
    if (typeof data.isFullscreen === 'boolean') slot.isFullscreen = data.isFullscreen;
    if (data.error !== undefined) slot.error = data.error;

    return slot;
  }

  unregisterSocket(socketId) {
    this.adminSockets.delete(socketId);
    const deviceId = this.socketToDevice.get(socketId);
    this.socketToDevice.delete(socketId);

    if (deviceId && this.slots.has(deviceId)) {
      const slot = this.slots.get(deviceId);
      if (slot.socketId === socketId) {
        slot.connected = false;
        slot.socketId = null;
        slot.ws = null;
        slot.isPlaying = false;
        slot.isArmed = false;
        return deviceId;
      }
    }
    return null;
  }

  _updateExpectedDuration() {
    // Determine overall expected duration from max/median of loaded files
    const durations = [];
    for (const slot of this.slots.values()) {
      if (slot.connected && slot.fileLoaded && slot.fileDuration > 0) {
        durations.push(slot.fileDuration);
      }
    }
    if (durations.length > 0) {
      durations.sort((a, b) => a - b);
      this.globalPlayback.expectedDuration = durations[Math.floor(durations.length / 2)];
    }
  }

  getCurrentGlobalPosition() {
    if (this.globalPlayback.status === 'playing') {
      const elapsed = (Date.now() - this.globalPlayback.startServerTime) / 1000;
      let pos = this.globalPlayback.position + elapsed;
      if (this.globalPlayback.expectedDuration > 0 && pos >= this.globalPlayback.expectedDuration) {
        if (this.globalPlayback.loop) {
          pos = pos % this.globalPlayback.expectedDuration;
        } else {
          pos = this.globalPlayback.expectedDuration;
        }
      }
      return pos;
    }
    return this.globalPlayback.position;
  }

  setPlay(startServerTime, position) {
    this.globalPlayback.status = 'playing';
    this.globalPlayback.startServerTime = startServerTime;
    this.globalPlayback.position = position;
    this.globalPlayback.lastUpdated = Date.now();
  }

  setPause(position) {
    this.globalPlayback.status = 'paused';
    this.globalPlayback.position = position;
    this.globalPlayback.lastUpdated = Date.now();
  }

  setStop() {
    this.globalPlayback.status = 'stopped';
    this.globalPlayback.position = 0;
    this.globalPlayback.lastUpdated = Date.now();
  }

  setSeek(position, startServerTime) {
    this.globalPlayback.position = position;
    if (this.globalPlayback.status === 'playing') {
      this.globalPlayback.startServerTime = startServerTime;
    }
    this.globalPlayback.lastUpdated = Date.now();
  }

  setLoop(loop) {
    this.globalPlayback.loop = !!loop;
  }

  getConnectedClientSockets() {
    const list = [];
    for (const slot of this.slots.values()) {
      if (slot.connected && slot.ws && slot.ws.readyState === 1) {
        list.push({ id: slot.id, ws: slot.ws });
      }
    }
    return list;
  }

  getClientSocket(id) {
    const slot = this.slots.get(id);
    if (slot && slot.connected && slot.ws && slot.ws.readyState === 1) {
      return slot.ws;
    }
    return null;
  }

  getAdminSnapshot() {
    const devices = [];
    let connectedCount = 0;
    let armedCount = 0;
    let fileLoadedCount = 0;
    let maxDrift = 0;

    for (let i = 1; i <= this.totalDevices; i++) {
      const slot = this.slots.get(i);
      const copy = { ...slot };
      delete copy.ws; // Remove non-serializable socket

      if (copy.connected) {
        connectedCount++;
        if (copy.isArmed) armedCount++;
        if (copy.fileLoaded) fileLoadedCount++;
        if (Math.abs(copy.driftMs) > Math.abs(maxDrift)) {
          maxDrift = copy.driftMs;
        }
      }
      devices.push(copy);
    }

    return {
      type: 'admin_state',
      serverTime: Date.now(),
      globalPlayback: {
        ...this.globalPlayback,
        currentEstimatedPosition: this.getCurrentGlobalPosition()
      },
      summary: {
        totalConfigured: this.totalDevices,
        connected: connectedCount,
        armed: armedCount,
        fileLoaded: fileLoadedCount,
        maxDriftMs: maxDrift
      },
      devices
    };
  }

  cleanStaleConnections(timeoutMs = 10000) {
    const now = Date.now();
    const disconnected = [];
    for (const slot of this.slots.values()) {
      if (slot.connected && (now - slot.lastPing > timeoutMs)) {
        slot.connected = false;
        slot.socketId = null;
        slot.ws = null;
        slot.isPlaying = false;
        slot.isArmed = false;
        disconnected.push(slot.id);
      }
    }
    return disconnected;
  }
}
