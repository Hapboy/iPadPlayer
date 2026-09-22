import { videoDB } from './db.js';
import { NTPClockSync, VideoSyncController } from './sync.js';

class iPadPlayerClient {
  constructor() {
    this.deviceId = this._loadSavedDeviceId();
    this.videoElement = document.getElementById('mainVideo');
    this.armOverlay = document.getElementById('armOverlay');
    this.armButton = document.getElementById('armButton');
    this.settingsModal = document.getElementById('settingsModal');
    this.identifyOverlay = document.getElementById('identifyOverlay');
    this.blackoutOverlay = document.getElementById('blackoutOverlay');
    this.statusBadge = document.getElementById('statusBadge');
    this.infoOverlay = document.getElementById('infoOverlay');

    this.ws = null;
    this.reconnectTimer = null;
    this.telemetryTimer = null;
    this.wakeLock = null;
    this.isArmed = false;
    this.currentFileRecord = null;
    this.currentObjectUrl = null;

    this.clockSync = new NTPClockSync(() => this.ws, {
      onSyncUpdate: (stats) => this._onSyncUpdate(stats)
    });

    this.startupLatencyMs = 420; // Default hardware lead estimate for iPad AVFoundation

    this.syncController = new VideoSyncController(this.videoElement, this.clockSync, {
      onDriftChange: (driftMs) => this._onDriftChange(driftMs),
      onStartupCalibrated: (calibratedLeadMs) => {
        this.startupLatencyMs = calibratedLeadMs;
        this.sendTelemetry();
      }
    });

    this.battery = null;
    this._initBattery();
    this._initUI();
    this._initWakeLock();
    this._initIndexedDBFile();
    this.connectWebSocket();
  }

  _loadSavedDeviceId() {
    const saved = localStorage.getItem('ipad_player_device_id');
    const parsed = parseInt(saved, 10);
    return (!isNaN(parsed) && parsed >= 1 && parsed <= 42) ? parsed : null;
  }

  _saveDeviceId(id) {
    this.deviceId = id;
    if (id) {
      localStorage.setItem('ipad_player_device_id', String(id));
    } else {
      localStorage.removeItem('ipad_player_device_id');
    }
  }

  async _initBattery() {
    if ('getBattery' in navigator) {
      try {
        this.battery = await navigator.getBattery();
      } catch (e) {
        console.warn('Battery API error:', e);
      }
    }
  }

  async _initWakeLock() {
    if ('wakeLock' in navigator) {
      document.addEventListener('visibilitychange', async () => {
        if (this.wakeLock !== null && document.visibilityState === 'visible') {
          await this.requestWakeLock();
        }
      });
    }
  }

  async requestWakeLock() {
    if ('wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
        console.log('Screen Wake Lock acquired');
      } catch (err) {
        console.warn('Wake Lock request error:', err);
      }
    }
  }

  async _initIndexedDBFile() {
    if (!this.deviceId) {
      this._updateStatus('Требуется настройка слота', 'warning');
      this.openSettings();
      return;
    }

    try {
      const record = await videoDB.getVideo(this.deviceId);
      if (record && record.blob) {
        this._loadVideoBlob(record);
      } else {
        this._updateStatus(`iPad #${this.deviceId}: Видео не выбрано`, 'warning');
        this.openSettings();
      }
    } catch (err) {
      console.error('Error loading video from DB:', err);
      this._updateStatus('Ошибка чтения базы данных', 'error');
    }
  }

  _loadVideoBlob(record) {
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
    }
    this.currentFileRecord = record;
    this.currentObjectUrl = URL.createObjectURL(record.blob);

    this.videoElement.src = this.currentObjectUrl;
    this.videoElement.load();

    this.videoElement.onloadedmetadata = () => {
      this._updateStatus(`iPad #${this.deviceId}: Готов (${record.name})`, 'ready');
      this._updateSettingsInfo();
      this.sendTelemetry();
    };

    this.videoElement.onerror = (e) => {
      console.error('Video load error:', e);
      this._updateStatus('Ошибка декодирования видеофайла', 'error');
    };
  }

  _initUI() {
    // Arm button click (user gesture: enter fullscreen, acquire wake lock, unlock audio/video)
    this.armButton.addEventListener('click', async () => {
      await this.armDevice();
    });

    // Settings open/close buttons
    document.getElementById('btnOpenSettings').addEventListener('click', () => this.openSettings());
    document.getElementById('btnCloseSettings').addEventListener('click', () => this.closeSettings());
    document.getElementById('btnSaveSettings').addEventListener('click', () => this.saveSettings());
    document.getElementById('btnDeleteFile').addEventListener('click', () => this.deleteCurrentVideo());
    document.getElementById('btnToggleFullscreen').addEventListener('click', () => this.toggleFullscreen());
    document.getElementById('btnTestPlay').addEventListener('click', () => this.testPlay());

    // File input change
    const fileInput = document.getElementById('videoFileInput');
    fileInput.addEventListener('change', (e) => this._onFileSelected(e));

    // Fill device selector options (1 to 42)
    const select = document.getElementById('deviceIdSelect');
    select.innerHTML = '<option value="">-- Выберите слот (1 - 42) --</option>';
    for (let i = 1; i <= 42; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `iPad #${String(i).padStart(2, '0')}`;
      select.appendChild(opt);
    }
    if (this.deviceId) {
      select.value = this.deviceId;
    }

    // Touch tap on player shows temporary info bar
    let hideInfoTimeout = null;
    this.videoElement.parentElement.addEventListener('click', () => {
      this.infoOverlay.classList.remove('hidden');
      if (hideInfoTimeout) clearTimeout(hideInfoTimeout);
      hideInfoTimeout = setTimeout(() => {
        if (!this.settingsModal.classList.contains('active')) {
          this.infoOverlay.classList.add('hidden');
        }
      }, 4000);
    });
  }

  async armDevice() {
    try {
      await this.requestWakeLock();
    } catch (e) {}

    // Enter fullscreen
    try {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        await document.documentElement.webkitRequestFullscreen();
      }
    } catch (e) {
      console.warn('Fullscreen request bypassed:', e);
    }

    // Unlock video/audio context and calibrate hardware spin-up latency
    try {
      this.videoElement.muted = true; // start muted for guarantee
      const t0 = performance.now();
      await this.videoElement.play();
      const tPlay = performance.now();
      this.videoElement.pause();
      this.videoElement.currentTime = 0;
      this.videoElement.muted = false; // unmute after unlocking

      const measuredStartup = Math.round(tPlay - t0);
      if (measuredStartup >= 150 && measuredStartup <= 900) {
        this.startupLatencyMs = measuredStartup;
        this.syncController.hardwareLeadMs = measuredStartup;
        console.log(`[Arm] Calibrated hardware spin-up latency: ${measuredStartup}ms`);
      }
    } catch (e) {
      console.warn('Video unlock play attempt:', e);
    }

    this.isArmed = true;
    this.armOverlay.classList.add('hidden');
    this._updateStatus(`iPad #${this.deviceId || '?'}: Готов к синхронизации`, 'ready');
    this.sendTelemetry();
  }

  async toggleFullscreen() {
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      } else if (document.documentElement.webkitRequestFullscreen) {
        await document.documentElement.webkitRequestFullscreen();
      }
    } else {
      if (document.exitFullscreen) {
        await document.exitFullscreen();
      } else if (document.webkitExitFullscreen) {
        await document.webkitExitFullscreen();
      }
    }
  }

  openSettings() {
    const select = document.getElementById('deviceIdSelect');
    if (this.deviceId) select.value = this.deviceId;
    this._updateSettingsInfo();
    this.settingsModal.classList.add('active');
    this.infoOverlay.classList.remove('hidden');
  }

  closeSettings() {
    this.settingsModal.classList.remove('active');
  }

  async saveSettings() {
    const select = document.getElementById('deviceIdSelect');
    const selectedId = parseInt(select.value, 10);
    if (!selectedId) {
      alert('Пожалуйста, выберите номер слота для этого iPad (от 1 до 42)');
      return;
    }

    this._saveDeviceId(selectedId);
    this.closeSettings();
    await this._initIndexedDBFile();
    this._registerWithServer();
  }

  async _onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!this.deviceId) {
      const select = document.getElementById('deviceIdSelect');
      const val = parseInt(select.value, 10);
      if (!val) {
        alert('Сначала укажите номер устройства (1-42) выше!');
        event.target.value = '';
        return;
      }
      this._saveDeviceId(val);
    }

    const fileStatus = document.getElementById('fileUploadStatus');
    fileStatus.textContent = 'Шаг 1/3: Чтение видеофайла из медиатеки iOS...';

    try {
      // Calculate video duration by temporary element
      const tempVideo = document.createElement('video');
      tempVideo.preload = 'metadata';
      const tempUrl = URL.createObjectURL(file);
      tempVideo.src = tempUrl;

      await new Promise((resolve) => {
        tempVideo.onloadedmetadata = () => {
          URL.revokeObjectURL(tempUrl);
          resolve();
        };
        tempVideo.onerror = () => {
          URL.revokeObjectURL(tempUrl);
          resolve();
        };
      });

      const duration = tempVideo.duration || 0;

      await videoDB.saveVideo(this.deviceId, file, duration, (stage) => {
        if (stage === 'reading') {
          fileStatus.textContent = 'Шаг 1/3: Подготовка бинарных данных видео...';
        } else if (stage === 'storing') {
          fileStatus.textContent = 'Шаг 2/3: Запись в постоянную память IndexedDB...';
        }
      });

      fileStatus.textContent = `Шаг 3/3: Успешно сохранено: ${file.name} (${Math.round(file.size / (1024 * 1024))} МБ, ${duration.toFixed(1)} сек)`;
      
      // Load into player
      const record = await videoDB.getVideo(this.deviceId);
      this._loadVideoBlob(record);
      this._updateSettingsInfo();
    } catch (err) {
      console.error('Error saving file:', err);
      fileStatus.textContent = 'Ошибка сохранения файла: ' + (err.message || err);
    }
  }

  async deleteCurrentVideo() {
    if (!this.deviceId) return;
    if (!confirm('Вы действительно хотите удалить локальное видео для этого устройства?')) return;

    await videoDB.deleteVideo(this.deviceId);
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.currentFileRecord = null;
    this.videoElement.src = '';
    this._updateSettingsInfo();
    this._updateStatus('Файл удален', 'warning');
    this.sendTelemetry();
  }

  async testPlay() {
    try {
      if (this.videoElement.paused) {
        await this.videoElement.play();
        setTimeout(() => this.videoElement.pause(), 3000);
      } else {
        this.videoElement.pause();
      }
    } catch (e) {
      alert('Ошибка тестового воспроизведения: ' + e.message);
    }
  }

  async _updateSettingsInfo() {
    const currentNameSpan = document.getElementById('currentFileName');
    const storageQuotaSpan = document.getElementById('storageQuota');
    const serverUrlSpan = document.getElementById('serverUrlDisplay');

    if (this.currentFileRecord) {
      const mb = (this.currentFileRecord.size / (1024 * 1024)).toFixed(1);
      const dur = this.currentFileRecord.duration ? `${this.currentFileRecord.duration.toFixed(1)}с` : '—';
      currentNameSpan.textContent = `${this.currentFileRecord.name} (${mb} МБ, ${dur})`;
    } else {
      currentNameSpan.textContent = 'Не выбрано';
    }

    const storage = await videoDB.getStorageEstimate();
    if (storage) {
      storageQuotaSpan.textContent = `Занято: ${storage.usageMB} МБ из ~${storage.quotaMB} МБ`;
    }

    if (serverUrlSpan) {
      serverUrlSpan.textContent = window.location.origin;
    }
  }

  // WebSocket Networking
  connectWebSocket() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('WebSocket connected to server');
      this.clockSync.start();
      this._registerWithServer();
      this._startTelemetry();
      this._updateStatus(`Подключено к серверу (Слот: ${this.deviceId || '?'})`, 'ready');
    };

    this.ws.onmessage = (event) => {
      this._handleServerMessage(event.data);
    };

    this.ws.onclose = () => {
      console.warn('WebSocket disconnected, reconnecting in 2s...');
      this.clockSync.stop();
      this._stopTelemetry();
      this._updateStatus('Связь с сервером потеряна...', 'error');
      
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2000);
    };

    this.ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };
  }

  _registerWithServer() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    this.ws.send(JSON.stringify({
      type: 'register',
      role: 'client',
      id: this.deviceId,
      name: this.deviceId ? `iPad #${String(this.deviceId).padStart(2, '0')}` : 'Unassigned iPad',
      isArmed: this.isArmed,
      fileLoaded: !!this.currentFileRecord,
      fileName: this.currentFileRecord ? this.currentFileRecord.name : null,
      fileDuration: this.currentFileRecord ? (this.currentFileRecord.duration || 0) : 0
    }));
  }

  _handleServerMessage(rawData) {
    let msg;
    try {
      msg = JSON.parse(rawData);
    } catch (e) {
      return;
    }

    if (msg.type === 'sync_pong') {
      this.clockSync.handlePong(msg);
      return;
    }

    if (msg.type === 'registered') {
      console.log('Registered on server:', msg);
      if (msg.globalPlayback && msg.globalPlayback.status === 'playing') {
        // Late joiner sync
        this.syncController.schedulePlay(
          msg.globalPlayback.startServerTime,
          msg.globalPlayback.position
        );
      }
      return;
    }

    if (msg.type === 'command') {
      this._executeCommand(msg);
      return;
    }

    if (msg.type === 'warning') {
      alert(msg.message);
    }
  }

  _executeCommand(cmd) {
    console.log('Received command:', cmd);

    switch (cmd.action) {
      case 'play':
        this.syncController.schedulePlay(cmd.targetServerTime, cmd.startPosition, cmd.syncMode, cmd.hardwareLeadMs);
        this._updateStatusBadgeMode();
        break;

      case 'retrigger':
        this.syncController.schedulePlay(cmd.targetServerTime, 0, cmd.syncMode, cmd.hardwareLeadMs);
        this._updateStatusBadgeMode();
        break;

      case 'loop_restart':
        this.syncController.handleLoopRestart(cmd.targetServerTime, cmd.syncMode, cmd.hardwareLeadMs);
        break;

      case 'set_sync_mode':
        this.syncController.setSyncMode(cmd.mode);
        this._updateStatusBadgeMode();
        break;

      case 'pause':
        this.syncController.pause(cmd.position);
        break;

      case 'seek':
        this.syncController.seek(cmd.targetServerTime, cmd.position, cmd.autoPlay, cmd.syncMode);
        break;

      case 'stop':
        this.syncController.stop();
        break;

      case 'loop':
        this.syncController.setLoop(cmd.loop);
        break;

      case 'identify':
        this.triggerIdentify(cmd.durationMs || 5000);
        break;

      case 'reload':
        window.location.reload();
        break;

      case 'blackout':
        if (cmd.enabled) {
          this.blackoutOverlay.classList.remove('hidden');
        } else {
          this.blackoutOverlay.classList.add('hidden');
        }
        break;

      case 'check_arm':
        if (!this.isArmed) {
          this.armOverlay.classList.remove('hidden');
        }
        break;
    }

    this.sendTelemetry();
  }

  _updateStatusBadgeMode() {
    const modeName = this.syncController.syncMode === 'active_sync' ? 'Активная синхро' : 'Свободный ход';
    const baseText = `iPad #${this.deviceId || '?'}: Готов (${modeName})`;
    this._updateStatus(baseText, 'ready');
  }

  triggerIdentify(durationMs = 5000) {
    const idBadge = document.getElementById('identifyId');
    const fileBadge = document.getElementById('identifyFile');

    idBadge.textContent = this.deviceId ? `#${String(this.deviceId).padStart(2, '0')}` : 'НЕ НАЗНАЧЕН';
    fileBadge.textContent = this.currentFileRecord ? this.currentFileRecord.name : 'Видео не загружено';

    this.identifyOverlay.classList.remove('hidden');
    this.identifyOverlay.classList.add('flash-animation');

    setTimeout(() => {
      this.identifyOverlay.classList.add('hidden');
      this.identifyOverlay.classList.remove('flash-animation');
    }, durationMs);
  }

  _startTelemetry() {
    this._stopTelemetry();
    this.telemetryTimer = setInterval(() => {
      this.sendTelemetry();
    }, 600);
  }

  _stopTelemetry() {
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
  }

  sendTelemetry() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    let batteryLevel = null;
    let isCharging = null;
    if (this.battery) {
      batteryLevel = Math.round(this.battery.level * 100);
      isCharging = this.battery.charging;
    }

    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);

    this.ws.send(JSON.stringify({
      type: 'telemetry',
      id: this.deviceId,
      isArmed: this.isArmed,
      fileLoaded: !!this.currentFileRecord,
      fileName: this.currentFileRecord ? this.currentFileRecord.name : null,
      fileDuration: this.videoElement.duration || (this.currentFileRecord ? this.currentFileRecord.duration : 0),
      currentTime: this.videoElement.currentTime,
      isPlaying: !this.videoElement.paused && !this.videoElement.ended,
      playbackRate: this.videoElement.playbackRate,
      driftMs: this.syncController.getDriftMs(),
      latencyMs: this.clockSync.getLatency(),
      startupLatencyMs: this.startupLatencyMs,
      batteryLevel,
      isCharging,
      isFullscreen
    }));
  }

  _onSyncUpdate(stats) {
    const latencyEl = document.getElementById('infoLatency');
    if (latencyEl) {
      latencyEl.textContent = `${stats.latency} мс`;
    }
  }

  _onDriftChange(driftMs) {
    const driftEl = document.getElementById('infoDrift');
    if (driftEl) {
      driftEl.textContent = `${driftMs > 0 ? '+' : ''}${driftMs} мс`;
      if (Math.abs(driftMs) > 100) {
        driftEl.style.color = '#ff4d4f';
      } else if (Math.abs(driftMs) > 35) {
        driftEl.style.color = '#faad14';
      } else {
        driftEl.style.color = '#52c41a';
      }
    }
  }

  _updateStatus(text, level = 'info') {
    if (!this.statusBadge) return;
    this.statusBadge.textContent = text;
    this.statusBadge.className = `status-badge ${level}`;
  }
}

// Initialize on DOM ready
window.addEventListener('DOMContentLoaded', () => {
  window.ipadClient = new iPadPlayerClient();
});
