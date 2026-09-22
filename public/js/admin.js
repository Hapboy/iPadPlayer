/**
 * Admin Dashboard Control Center for 42 iPad Video Player
 */

class AdminDashboard {
  constructor() {
    this.ws = null;
    this.reconnectTimer = null;
    this.serverState = null;
    this.isScrubbing = false;
    this.devicesContainer = document.getElementById('deviceGrid');
    this.totalDevices = 42;

    this._initUI();
    this._fetchServerInfo();
    this.connectWebSocket();
    this._startLocalClockTicker();
  }

  async _fetchServerInfo() {
    try {
      const res = await fetch('/api/info');
      const data = await res.json();
      const ipList = document.getElementById('serverIpList');
      if (ipList && data.clientUrls) {
        ipList.innerHTML = data.clientUrls.map(url => `<code>${url}</code>`).join(' &nbsp;|&nbsp; ');
      }
    } catch (e) {
      console.warn('Failed to fetch /api/info:', e);
    }
  }

  _initUI() {
    // Master Playback Buttons
    document.getElementById('btnMasterPlay').addEventListener('click', () => this.sendMasterCommand('play'));
    document.getElementById('btnMasterPause').addEventListener('click', () => this.sendMasterCommand('pause'));
    document.getElementById('btnMasterStop').addEventListener('click', () => this.sendMasterCommand('stop'));
    document.getElementById('btnMasterRewind').addEventListener('click', () => {
      this.sendMasterCommand('seek', { position: 0 });
    });

    // Master Timeline Slider
    const timeline = document.getElementById('masterTimeline');
    timeline.addEventListener('mousedown', () => { this.isScrubbing = true; });
    timeline.addEventListener('touchstart', () => { this.isScrubbing = true; });

    timeline.addEventListener('input', (e) => {
      const pos = parseFloat(e.target.value);
      this._updateTimelineLabels(pos, this._getExpectedDuration());
    });

    timeline.addEventListener('change', (e) => {
      this.isScrubbing = false;
      const pos = parseFloat(e.target.value);
      this.sendMasterCommand('seek', { position: pos });
    });

    // Global Tool Buttons
    document.getElementById('btnIdentifyAll').addEventListener('click', () => {
      this.sendMasterCommand('identify', { targetId: 'all', durationMs: 6000 });
    });

    document.getElementById('btnCheckArm').addEventListener('click', () => {
      this.sendMasterCommand('check_arm');
    });

    document.getElementById('btnReloadAll').addEventListener('click', () => {
      if (confirm('Перезагрузить все 42 iPad клиента?')) {
        this.sendMasterCommand('reload', { targetId: 'all' });
      }
    });

    const loopBtn = document.getElementById('btnToggleLoop');
    loopBtn.addEventListener('click', () => {
      const currentLoop = this.serverState?.globalPlayback?.loop ?? true;
      this.sendMasterCommand('loop', { loop: !currentLoop });
    });

    let blackoutActive = false;
    const blackoutBtn = document.getElementById('btnToggleBlackout');
    blackoutBtn.addEventListener('click', () => {
      blackoutActive = !blackoutActive;
      blackoutBtn.classList.toggle('active', blackoutActive);
      this.sendMasterCommand('blackout', { enabled: blackoutActive, targetId: 'all' });
    });

    // Build initial 42 slot cards in DOM
    this._renderEmptyGrid();
  }

  _renderEmptyGrid() {
    this.devicesContainer.innerHTML = '';
    for (let i = 1; i <= this.totalDevices; i++) {
      const card = document.createElement('div');
      card.className = 'device-card offline';
      card.id = `card-device-${i}`;
      card.innerHTML = `
        <div class="device-header">
          <div class="device-title">
            <span class="status-indicator"></span>
            <span class="device-id">#${String(i).padStart(2, '0')}</span>
          </div>
          <span class="device-badge badge-offline">ОФЛАЙН</span>
        </div>
        <div class="device-file" title="Файл не загружен">—</div>
        <div class="device-progress">
          <div class="progress-bar-fill" style="width: 0%"></div>
        </div>
        <div class="device-metrics">
          <span class="metric-time">00:00.0</span>
          <span class="metric-drift">дрифт: —</span>
          <span class="metric-ping">пинг: —</span>
        </div>
        <div class="device-actions">
          <button class="btn-action-identify" title="Мигнуть экраном">💡</button>
          <button class="btn-action-reload" title="Перезагрузить">🔄</button>
        </div>
      `;

      // Event listeners for individual actions
      const btnId = card.querySelector('.btn-action-identify');
      btnId.addEventListener('click', () => {
        this.sendMasterCommand('identify', { targetId: i, durationMs: 4000 });
      });

      const btnRel = card.querySelector('.btn-action-reload');
      btnRel.addEventListener('click', () => {
        this.sendMasterCommand('reload', { targetId: i });
      });

      this.devicesContainer.appendChild(card);
    }
  }

  connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      document.getElementById('serverConnectionStatus').textContent = 'Подключено к серверу';
      document.getElementById('serverConnectionStatus').className = 'status-tag online';

      this.ws.send(JSON.stringify({
        type: 'register',
        role: 'admin'
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'admin_state') {
          this.handleStateUpdate(data);
        }
      } catch (e) {
        console.error('Error parsing admin message:', e);
      }
    };

    this.ws.onclose = () => {
      document.getElementById('serverConnectionStatus').textContent = 'Отключено от сервера';
      document.getElementById('serverConnectionStatus').className = 'status-tag offline';

      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connectWebSocket(), 2000);
    };

    this.ws.onerror = (e) => {
      console.error('Admin WS error:', e);
    };
  }

  sendMasterCommand(action, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      alert('Сервер недоступен! Проверьте подключение.');
      return;
    }

    this.ws.send(JSON.stringify({
      type: 'admin_command',
      action,
      ...params
    }));
  }

  handleStateUpdate(state) {
    this.serverState = state;
    this._updateSummaryHeader(state.summary, state.globalPlayback);
    this._updateDeviceCards(state.devices);
    this._updateGlobalTimeline(state.globalPlayback);
  }

  _updateSummaryHeader(summary, playback) {
    document.getElementById('statConnected').textContent = `${summary.connected} / ${summary.totalConfigured}`;
    document.getElementById('statArmed').textContent = `${summary.armed} / ${summary.totalConfigured}`;
    document.getElementById('statLoaded').textContent = `${summary.fileLoaded} / ${summary.totalConfigured}`;

    const driftEl = document.getElementById('statMaxDrift');
    const maxDrift = Math.abs(summary.maxDriftMs || 0);
    driftEl.textContent = `${summary.maxDriftMs > 0 ? '+' : ''}${summary.maxDriftMs || 0} мс`;
    if (maxDrift > 100) {
      driftEl.style.color = '#ff4d4f';
    } else if (maxDrift > 35) {
      driftEl.style.color = '#faad14';
    } else {
      driftEl.style.color = '#52c41a';
    }

    const stateBadge = document.getElementById('playbackStateBadge');
    if (playback.status === 'playing') {
      stateBadge.textContent = 'ВОСПРОИЗВЕДЕНИЕ';
      stateBadge.className = 'status-badge playing';
    } else if (playback.status === 'paused') {
      stateBadge.textContent = 'ПАУЗА';
      stateBadge.className = 'status-badge paused';
    } else {
      stateBadge.textContent = 'ОСТАНОВЛЕНО';
      stateBadge.className = 'status-badge stopped';
    }

    const loopBtn = document.getElementById('btnToggleLoop');
    loopBtn.classList.toggle('active', !!playback.loop);
  }

  _updateDeviceCards(devices) {
    for (const dev of devices) {
      const card = document.getElementById(`card-device-${dev.id}`);
      if (!card) continue;

      const badge = card.querySelector('.device-badge');
      const fileEl = card.querySelector('.device-file');
      const fillBar = card.querySelector('.progress-bar-fill');
      const timeEl = card.querySelector('.metric-time');
      const driftEl = card.querySelector('.metric-drift');
      const pingEl = card.querySelector('.metric-ping');

      if (!dev.connected) {
        card.className = 'device-card offline';
        badge.textContent = 'ОФЛАЙН';
        badge.className = 'device-badge badge-offline';
        fileEl.textContent = '—';
        fillBar.style.width = '0%';
        timeEl.textContent = '00:00.0';
        driftEl.textContent = 'дрифт: —';
        pingEl.textContent = 'пинг: —';
        continue;
      }

      // Online card states
      let cardStatusClass = 'online';
      if (!dev.fileLoaded) {
        cardStatusClass = 'warning';
        badge.textContent = 'НЕТ ФАЙЛА';
        badge.className = 'device-badge badge-warning';
      } else if (!dev.isArmed) {
        cardStatusClass = 'warning';
        badge.textContent = 'НЕ НА ВЗВОДЕ';
        badge.className = 'device-badge badge-warning';
      } else if (Math.abs(dev.driftMs) > 100) {
        cardStatusClass = 'error';
        badge.textContent = 'РАССИНХРОН';
        badge.className = 'device-badge badge-error';
      } else if (dev.isPlaying) {
        cardStatusClass = 'playing';
        badge.textContent = 'ИГРАЕТ';
        badge.className = 'device-badge badge-playing';
      } else {
        cardStatusClass = 'ready';
        badge.textContent = 'ГОТОВ';
        badge.className = 'device-badge badge-ready';
      }

      card.className = `device-card ${cardStatusClass}`;

      fileEl.textContent = dev.fileName || 'Файл не выбран';
      fileEl.title = dev.fileName || '';

      // Progress
      const duration = dev.fileDuration || this._getExpectedDuration();
      const current = dev.currentTime || 0;
      const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
      fillBar.style.width = `${pct}%`;

      timeEl.textContent = this._formatTime(current);

      const absDrift = Math.abs(dev.driftMs || 0);
      driftEl.textContent = `${dev.driftMs > 0 ? '+' : ''}${dev.driftMs || 0}мс`;
      if (absDrift > 100) driftEl.style.color = '#ff4d4f';
      else if (absDrift > 35) driftEl.style.color = '#faad14';
      else driftEl.style.color = '#52c41a';

      const batteryStr = dev.batteryLevel !== null ? ` | 🔋${dev.batteryLevel}%` : '';
      pingEl.textContent = `${dev.latencyMs}мс${batteryStr}`;
    }
  }

  _getExpectedDuration() {
    return this.serverState?.globalPlayback?.expectedDuration || 0;
  }

  _updateGlobalTimeline(playback) {
    if (this.isScrubbing) return;

    const timeline = document.getElementById('masterTimeline');
    const duration = playback.expectedDuration || 0;
    const current = playback.currentEstimatedPosition || 0;

    timeline.max = duration > 0 ? duration : 100;
    timeline.value = current;

    this._updateTimelineLabels(current, duration);
  }

  _updateTimelineLabels(current, duration) {
    document.getElementById('lblCurrentTime').textContent = this._formatTimeDetailed(current);
    document.getElementById('lblTotalDuration').textContent = this._formatTimeDetailed(duration);
  }

  _startLocalClockTicker() {
    // Smooth timeline update between server states (every 60ms)
    setInterval(() => {
      if (!this.serverState || this.isScrubbing) return;

      const playback = this.serverState.globalPlayback;
      if (playback.status === 'playing') {
        const elapsed = (Date.now() - playback.startServerTime) / 1000;
        let pos = playback.position + elapsed;
        const dur = playback.expectedDuration;

        if (dur > 0 && pos >= dur) {
          pos = playback.loop ? (pos % dur) : dur;
        }

        const timeline = document.getElementById('masterTimeline');
        timeline.value = pos;
        this._updateTimelineLabels(pos, dur);
      }
    }, 60);
  }

  _formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00.0';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${ms}`;
  }

  _formatTimeDetailed(seconds) {
    if (isNaN(seconds) || seconds < 0) return '00:00:00.000';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.adminDashboard = new AdminDashboard();
});
