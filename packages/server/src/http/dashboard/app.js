/* global WebSocket, localStorage */

const API = window.location.origin;
const WS_URL = `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`;

let token = localStorage.getItem('banana_token') || '';
let ws = null;
let sessions = {};
let activeSessionId = localStorage.getItem('banana_active_session') || null;
let outputs = {};
let unread = {}; // sessionId → true if has unread output
let hubChannels = [];
let hubMessages = {}; // channelId → HubMessage[]
let activeChannelId = null;
let hubVisible = false;
let hubViewMode = 'messages'; // 'messages' | 'tasks' | 'docs'
let channelTasks = {}; // channelId → ChannelTask[]
let channelDocs = {}; // channelId → ChannelDoc[]
let currentDocId = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const authPanel = document.getElementById('auth-panel');
const mainPanel = document.getElementById('main');
const tokenInput = document.getElementById('token-input');
const wsStatus = document.getElementById('ws-status');
const sessionList = document.getElementById('session-list');
const contentTitle = document.getElementById('content-title');
const outputDiv = document.getElementById('output');
const promptInput = document.getElementById('prompt-input');
const sendBtn = document.getElementById('send-btn');
const killBtn = document.getElementById('kill-btn');
const clearQueueBtn = document.getElementById('clear-queue-btn');
const stopBtn = document.getElementById('stop-btn');

// ── localStorage output cache ─────────────────────────────────────────────────
let _savePending = {};

function saveOutputs(sessionId) {
  // Debounce: save at most once per second per session
  if (_savePending[sessionId]) return;
  _savePending[sessionId] = true;
  setTimeout(() => {
    _savePending[sessionId] = false;
    try {
      if (outputs[sessionId]) {
        localStorage.setItem(`banana_out_${sessionId}`, JSON.stringify(outputs[sessionId]));
      }
    } catch (e) {
      // localStorage quota exceeded — not fatal
    }
  }, 1000);
}

function restoreOutputs(sessionId) {
  if (outputs[sessionId]) return; // already in memory
  try {
    const raw = localStorage.getItem(`banana_out_${sessionId}`);
    if (raw) outputs[sessionId] = JSON.parse(raw);
  } catch (e) {
    // corrupt cache — ignore
  }
}

// ── Auth ───────────────────────────────────────────────────────────────────────
if (token) tryConnect();
else showAuth();

function showAuth() {
  authPanel.style.display = 'flex';
  mainPanel.style.display = 'none';
}

function showMain() {
  authPanel.style.display = 'none';
  mainPanel.style.display = 'flex';
  // Restore last active session from localStorage immediately (before API loads)
  if (activeSessionId) {
    restoreOutputs(activeSessionId);
    if (outputs[activeSessionId]) {
      updateInputState();
      renderOutput();
    }
  }
  setupNotifications();
}

// ── Notifications ─────────────────────────────────────────────────────────────
let notifyMode = localStorage.getItem('banana_notify_mode') || 'local';

function notify(title, body) {
  // Always show in-app toast
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.innerHTML = `<strong>${esc(title)}</strong><div class="toast-body">${esc(body)}</div>`;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    setTimeout(() => toast.remove(), 300);
  }, 4000);

  // Local browser notification (no external services)
  if (notifyMode === 'local' && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: '🍌' }); } catch {}
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

const pushBanner = document.getElementById('push-banner');

function showPushBanner(html, onclick) {
  pushBanner.innerHTML = html;
  pushBanner.style.display = 'block';
  if (onclick) pushBanner.querySelector('button')?.addEventListener('click', onclick);
}

function hidePushBanner() {
  pushBanner.style.display = 'none';
}

async function setupNotifications() {
  console.log('[notify] mode:', notifyMode);
  hidePushBanner();

  if (notifyMode === 'off') return;

  if (typeof Notification === 'undefined') {
    console.warn('[notify] Notification API not available');
    return;
  }

  const permission = Notification.permission;

  if (permission === 'denied') {
    showPushBanner(
      `<span>🔕 Notifications are blocked for this site.</span>
       <strong>To fix:</strong> click the 🔒 icon in the address bar → Permissions → Notifications → Allow, then reload.`,
      null
    );
    return;
  }

  if (permission === 'default') {
    showPushBanner(
      `<span>🔔 Enable notifications to get alerted when Claude finishes.</span>
       <button class="btn btn-sm">Enable</button>`,
      () => requestNotificationPermission()
    );
    return;
  }

  // permission === 'granted'
  if (notifyMode === 'push') {
    await setupWebPush();
  }
}

async function requestNotificationPermission() {
  hidePushBanner();
  try {
    const result = await Notification.requestPermission();
    if (result !== 'granted') {
      showPushBanner(
        `<span>🔕 Notifications not granted (${result}). Click the 🔒 icon → Notifications → Allow, then reload.</span>`,
        null
      );
      return;
    }
    if (notifyMode === 'push') await setupWebPush();
  } catch (e) {
    console.error('[notify] Permission request failed:', e);
  }
}

async function setupWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('[push] Service worker / PushManager not supported — falling back to local');
    return;
  }
  await doSubscribe();
}

async function doSubscribe() {
  hidePushBanner();
  try {
    console.log('[push] Requesting permission…');
    const permission = await Notification.requestPermission();
    console.log('[push] Permission result:', permission);

    if (permission !== 'granted') {
      showPushBanner(
        `<span>🔕 Notifications not granted (${permission}). Click the 🔒 icon → Notifications → Allow, then reload.</span>`,
        null
      );
      return;
    }

    console.log('[push] Registering service worker…');
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    console.log('[push] Service worker ready');

    const { publicKey } = await apiFetch('/api/push/vapid-key');
    console.log('[push] Got VAPID public key');

    // Re-subscribe if VAPID key changed
    const existing = await reg.pushManager.getSubscription();
    const storedKey = localStorage.getItem('banana_vapid_key');
    if (existing && storedKey !== publicKey) {
      console.log('[push] VAPID key changed — unsubscribing old subscription');
      await existing.unsubscribe();
    }

    const sub = (storedKey === publicKey && existing)
      ? existing
      : await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) });

    localStorage.setItem('banana_vapid_key', publicKey);
    await apiFetch('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    console.log('[push] ✅ Subscribed successfully');
  } catch (e) {
    console.error('[push] Subscribe failed:', e);
    showPushBanner(
      `<span>❌ Push setup failed: ${esc(String(e))}. <button class="btn btn-sm">Retry</button></span>`,
      () => doSubscribe()
    );
  }
}

document.getElementById('auth-btn').addEventListener('click', () => {
  token = tokenInput.value.trim();
  if (!token) return;
  localStorage.setItem('banana_token', token);
  tryConnect();
});
tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('auth-btn').click(); });

// ── WebSocket ──────────────────────────────────────────────────────────────────
function tryConnect() {
  ws = new WebSocket(WS_URL);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'DASHBOARD_CONNECT', token })));
  ws.addEventListener('message', e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'DASHBOARD_ACK') {
      showMain(); setStatus('connected'); loadMachines(); loadSessions();
      if (hubVisible && activeChannelId) selectHubChannel(activeChannelId);
      return;
    }
    if (msg.type === 'DASHBOARD_REJECT') { alert('Invalid token'); localStorage.removeItem('banana_token'); showAuth(); return; }
    if (msg.type === 'DASHBOARD_EVENT') handleEvent(msg);
    if (msg.type === 'DASHBOARD_EVENT') handleHubEvent(msg);
  });
  ws.addEventListener('close', () => { setStatus('disconnected'); setTimeout(tryConnect, 3000); });
  ws.addEventListener('error', () => setStatus('disconnected'));
}

function setStatus(s) {
  wsStatus.textContent = s === 'connected' ? '● connected' : '○ disconnected';
  wsStatus.className = s;
}

// ── Unread tracking ──────────────────────────────────────────────────────────
let _unreadRenderPending = false;

function markUnread(sessionId) {
  if (sessionId === activeSessionId) return;
  if (unread[sessionId]) return; // already marked, skip sidebar rebuild
  unread[sessionId] = true;
  // Debounce sidebar re-renders from unread changes
  if (!_unreadRenderPending) {
    _unreadRenderPending = true;
    requestAnimationFrame(() => {
      _unreadRenderPending = false;
      renderSidebar();
    });
  }
}

function markRead(sessionId) {
  if (unread[sessionId]) {
    delete unread[sessionId];
    // Just remove the dot instead of full sidebar rebuild
    const item = sessionList.querySelector(`.session-item[data-id="${sessionId}"] .unread-dot`);
    if (item) item.remove();
  }
}

// ── Events from server ────────────────────────────────────────────────────────
function handleEvent(msg) {
  const { event, sessionId } = msg;

  if (event === 'SESSION_CONNECTED') {
    sessions[sessionId] = { sessionId, clientId: msg.clientId, hostname: msg.hostname, workdir: msg.workdir, status: 'connected' };
    renderSidebar();
    if (sessionId === activeSessionId) updateInputState();
    return;
  }

  if (event === 'SESSION_DISCONNECTED') {
    if (sessions[sessionId]) sessions[sessionId].status = 'disconnected';
    renderSidebar();
    if (sessionId === activeSessionId) updateInputState();
    return;
  }

  if (event === 'JOB_QUEUED') {
    // A job was queued for this session — ensure we track it as running
    ensureOutput(sessionId, msg.jobId);
    updateSessionSpinner(sessionId);
    refreshJobsBadge();
    return;
  }

  if (event === 'OUTPUT_CHUNK') {
    ensureOutput(sessionId, msg.jobId);
    outputs[sessionId][msg.jobId].chunks.push(msg.chunk);
    saveOutputs(sessionId);
    markUnread(sessionId);
    if (sessionId === activeSessionId) renderOutput();
    // Real-time badge: at least 1 job running
    refreshJobsBadge();
    updateSessionSpinner(sessionId);
    // Refresh jobs modal if open so running jobs appear immediately
    if (document.getElementById('jobs-modal').style.display !== 'none') {
      debouncedLoadActiveJobs();
    }
    return;
  }

  if (event === 'OUTPUT_DONE') {
    ensureOutput(sessionId, msg.jobId);
    outputs[sessionId][msg.jobId].done = true;
    outputs[sessionId][msg.jobId].exitCode = msg.exitCode;
    saveOutputs(sessionId);
    markUnread(sessionId);
    if (sessionId === activeSessionId) { renderOutput(); updateInputState(); }
    const s = sessions[sessionId];
    const host = s?.hostname ?? sessionId.slice(0, 8);
    const folder = s?.workdir?.split('/').pop() ?? '';
    const dur = fmtDuration(msg.durationMs ?? 0);
    const prompt = outputs[sessionId][msg.jobId].prompt.slice(0, 80);
    const title = msg.exitCode === 0
      ? `✅ ${host} finished in ${dur}`
      : `⚠️ ${host} failed · exit ${msg.exitCode} · ${dur}`;
    notify(title, `${folder} · "${prompt}"`);
    // Real-time badge: a job just finished
    refreshJobsBadge();
    updateSessionSpinner(sessionId);
    // Refresh jobs modal if open
    if (document.getElementById('jobs-modal').style.display !== 'none') {
      loadActiveJobs();
      loadRecentJobs();
    }
    return;
  }

  if (event === 'OUTPUT_ERROR') {
    ensureOutput(sessionId, msg.jobId);
    outputs[sessionId][msg.jobId].error = msg.error;
    saveOutputs(sessionId);
    markUnread(sessionId);
    if (sessionId === activeSessionId) { renderOutput(); updateInputState(); }
    const s = sessions[sessionId];
    const host = s?.hostname ?? sessionId.slice(0, 8);
    const folder = s?.workdir?.split('/').pop() ?? '';
    notify(`❌ ${host} couldn't start`, `${folder} · ${String(msg.error).slice(0, 100)}`);
    // Real-time badge
    refreshJobsBadge();
    updateSessionSpinner(sessionId);
    if (document.getElementById('jobs-modal').style.display !== 'none') {
      loadActiveJobs();
      loadRecentJobs();
    }
    return;
  }
}

function ensureOutput(sessionId, jobId) {
  if (!outputs[sessionId]) outputs[sessionId] = {};
  if (!outputs[sessionId][jobId]) {
    outputs[sessionId][jobId] = { prompt: jobId, chunks: [], done: false };
  }
}

// ── REST helpers ──────────────────────────────────────────────────────────────
async function apiFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  return res.json();
}

async function loadSessions() {
  const data = await apiFetch('/api/sessions');
  if (!Array.isArray(data)) return;
  for (const s of data) sessions[s.sessionId] = s;
  renderSidebar();

  if (activeSessionId) {
    // Always try to sync the active session from server (even if it's in sessions map or not)
    await selectSession(activeSessionId);
  } else if (data.length === 1) {
    await selectSession(data[0].sessionId);
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
// Check if a session has any running (not done, not errored) job
function isSessionRunning(sessionId) {
  const jobs = outputs[sessionId];
  if (!jobs) return false;
  return Object.values(jobs).some(j => !j.done && !j.error);
}

// Incrementally update spinner for a single session (no full sidebar re-render)
function updateSessionSpinner(sessionId) {
  const item = sessionList.querySelector(`.session-item[data-id="${sessionId}"]`);
  if (!item) return;
  const running = isSessionRunning(sessionId);
  const nameRow = item.querySelector('.session-name-row');
  if (!nameRow) return;
  let spinner = nameRow.querySelector('.session-spinner');
  if (running && !spinner) {
    spinner = document.createElement('span');
    spinner.className = 'session-spinner';
    const dot = nameRow.querySelector('.unread-dot');
    if (dot) nameRow.insertBefore(spinner, dot);
    else nameRow.appendChild(spinner);
  } else if (!running && spinner) {
    spinner.remove();
  }
}

// Track which channel group is expanded (null = none, string = channel name)
let expandedChannelGroup = null;

function renderSessionItem(s) {
  const displayName = s.name || s.hostname || '?';
  const hasUnread = unread[s.sessionId];
  const running = isSessionRunning(s.sessionId);
  const sid8 = s.sessionId.slice(0, 8);
  const machine = machines.find(m => m.id === s.machineId);
  const isPersistent = !!machine?.persistentMode;

  // Build tooltip commands — show both resume + tmux attach when available
  let tooltipHtml = '';
  const isLocal = !machine?.ip || machine?.ip === 'localhost' || machine?.ip === '127.0.0.1';
  const sshPrefix = isLocal ? '' : `ssh ${machine?.username || 'root'}@${machine?.ip} -t `;
  if (s.claudeSessionId) {
    const resumeCmd = `${sshPrefix}claude --resume ${s.claudeSessionId}`;
    tooltipHtml += `<div class="session-tooltip-label">Resume session</div>
      <div class="session-tooltip-cmd"><code>${esc(resumeCmd)}</code><button class="session-tooltip-copy" data-copy="${esc(resumeCmd)}" title="Copy">⧉</button></div>`;
  }
  if (isPersistent) {
    const tmuxCmd = `${sshPrefix}tmux attach -t banana-${sid8}`;
    tooltipHtml += `<div class="session-tooltip-label">Attach tmux</div>
      <div class="session-tooltip-cmd"><code>${esc(tmuxCmd)}</code><button class="session-tooltip-copy" data-copy="${esc(tmuxCmd)}" title="Copy">⧉</button></div>`;
  }

  return `
    <div class="session-item ${s.sessionId === activeSessionId ? 'active' : ''}" data-id="${s.sessionId}">
      <div class="session-top-row">
        <div class="session-name-row">
          ${s.name ? `<span class="session-name">${esc(s.name)}</span>` : `<span class="session-host-name">${esc(displayName)}</span>`}
          ${running ? '<span class="session-spinner"></span>' : ''}
          ${hasUnread ? '<span class="unread-dot"></span>' : ''}
        </div>
        <button class="session-edit-btn" data-edit-session="${s.sessionId}" title="Edit session">&#9998;</button>
      </div>
      <div class="session-id">${sid8}${s.screenName ? ` · ${esc(s.screenName)}` : ''}</div>
      ${s.role ? `<div class="session-role-badge">${esc(s.role)}</div>` : ''}
      ${s.name ? `<div class="session-host">${esc(s.hostname || '')}</div>` : ''}
      <div class="session-dir">${esc(s.workdir || s.remoteWorkdir || '')}</div>
      ${tooltipHtml ? `<div class="session-tooltip">${tooltipHtml}</div>` : ''}
    </div>`;
}

function renderSidebar() {
  const items = Object.values(sessions).sort((a, b) => {
    const nameA = (a.name || '').toLowerCase();
    const nameB = (b.name || '').toLowerCase();
    if (nameA && !nameB) return -1;
    if (!nameA && nameB) return 1;
    return nameA.localeCompare(nameB);
  });
  document.getElementById('session-count').textContent = items.length ? `(${items.length})` : '';
  if (items.length === 0) {
    sessionList.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:11px;">No sessions yet</div>';
    return;
  }

  // Group sessions by channel — a session appears in each channel it subscribes to.
  // Sessions with no channels go into "Ungrouped".
  const groups = {};
  const ungrouped = [];
  for (const s of items) {
    const channels = s.channels && s.channels.length > 0 ? s.channels : null;
    if (!channels) {
      ungrouped.push(s);
    } else {
      for (const ch of channels) {
        if (!groups[ch]) groups[ch] = [];
        groups[ch].push(s);
      }
    }
  }

  const channelNames = Object.keys(groups).sort();

  // If no channels exist at all, render flat list (backward compat)
  if (channelNames.length === 0) {
    sessionList.innerHTML = items.map(renderSessionItem).join('');
    _bindSidebarEvents();
    return;
  }

  // Auto-expand: if active session is in a group, expand that group
  if (activeSessionId && !expandedChannelGroup) {
    const activeSession = sessions[activeSessionId];
    if (activeSession?.channels?.length > 0) {
      expandedChannelGroup = activeSession.channels[0];
    }
  }

  let html = '';

  for (const ch of channelNames) {
    const sessionsInGroup = groups[ch];
    const isExpanded = expandedChannelGroup === ch;
    const runningCount = sessionsInGroup.filter(s => isSessionRunning(s.sessionId)).length;
    const unreadCount = sessionsInGroup.filter(s => unread[s.sessionId]).length;

    html += `<div class="channel-group${isExpanded ? ' expanded' : ''}" data-channel="${esc(ch)}">`;
    html += `<div class="channel-group-header" data-channel-toggle="${esc(ch)}">`;
    html += `<span class="channel-group-arrow">${isExpanded ? '▾' : '▸'}</span>`;
    html += `<span class="channel-group-name">${esc(ch)}</span>`;
    html += `<span class="channel-group-count">${sessionsInGroup.length}</span>`;
    if (runningCount > 0) html += `<span class="session-spinner"></span>`;
    if (unreadCount > 0) html += `<span class="unread-dot"></span>`;
    html += `</div>`;
    if (isExpanded) {
      html += `<div class="channel-group-body">`;
      html += sessionsInGroup.map(renderSessionItem).join('');
      html += `</div>`;
    }
    html += `</div>`;
  }

  // Ungrouped sessions at the bottom
  if (ungrouped.length > 0) {
    const isExpanded = expandedChannelGroup === '__ungrouped__';
    html += `<div class="channel-group${isExpanded ? ' expanded' : ''}" data-channel="__ungrouped__">`;
    html += `<div class="channel-group-header" data-channel-toggle="__ungrouped__">`;
    html += `<span class="channel-group-arrow">${isExpanded ? '▾' : '▸'}</span>`;
    html += `<span class="channel-group-name" style="font-style:italic">Ungrouped</span>`;
    html += `<span class="channel-group-count">${ungrouped.length}</span>`;
    html += `</div>`;
    if (isExpanded) {
      html += `<div class="channel-group-body">`;
      html += ungrouped.map(renderSessionItem).join('');
      html += `</div>`;
    }
    html += `</div>`;
  }

  sessionList.innerHTML = html;

  // Bind channel group toggle
  sessionList.querySelectorAll('.channel-group-header').forEach(el => {
    el.addEventListener('click', () => {
      const ch = el.dataset.channelToggle;
      expandedChannelGroup = expandedChannelGroup === ch ? null : ch;
      renderSidebar();
    });
  });

  _bindSidebarEvents();
}

function _bindSidebarEvents() {
  sessionList.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-edit-btn')) return;
      if (e.target.closest('.session-tooltip-copy')) return;
      selectSession(el.dataset.id);
    });
    // Tooltip positioning (fixed, escapes sidebar overflow)
    const tip = el.querySelector('.session-tooltip');
    if (tip) {
      let tipHideTimer = null;
      const showTip = () => {
        clearTimeout(tipHideTimer);
        const rect = el.getBoundingClientRect();
        tip.style.left = (rect.right + 4) + 'px';
        tip.style.top = rect.top + 'px';
        tip.style.display = 'block';
        tip.style.pointerEvents = 'auto';
      };
      const hideTip = () => {
        tipHideTimer = setTimeout(() => {
          tip.style.display = 'none';
          tip.style.pointerEvents = 'none';
        }, 150);
      };
      el.addEventListener('mouseenter', showTip);
      el.addEventListener('mouseleave', hideTip);
      tip.addEventListener('mouseenter', () => clearTimeout(tipHideTimer));
      tip.addEventListener('mouseleave', hideTip);
    }
  });
  sessionList.querySelectorAll('.session-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openSessionEditModal(btn.dataset.editSession);
    });
  });
  sessionList.querySelectorAll('.session-tooltip-copy').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 1000);
    });
  });
}

function buildContentTitle(s, id) {
  const name = s?.name;
  const prefix = id.slice(0, 8);
  const host = s?.hostname || '?';
  const dir = s?.workdir || s?.remoteWorkdir || '';
  return name ? `${name} — ${prefix}` : `${prefix} — ${host} ${dir}`;
}

async function selectSession(id) {
  activeSessionId = id;
  localStorage.setItem('banana_active_session', id);
  markRead(id);
  _lastRenderedJobKey = ''; // force full re-render on session switch

  // Auto-expand the channel group containing the selected session
  const sel = sessions[id];
  if (sel?.channels?.length > 0) {
    expandedChannelGroup = sel.channels[0];
  }

  // 1. Restore from localStorage immediately — zero-latency render
  restoreOutputs(id);
  const s = sessions[id];
  contentTitle.textContent = buildContentTitle(s, id);
  killBtn.style.display = 'inline-block';
  // Show Clear Queue button if session has queued hub messages
  const hasQueue = s && Array.isArray(s.hubQueue) && s.hubQueue.length > 0;
  clearQueueBtn.style.display = hasQueue ? 'inline-block' : 'none';
  renderSidebar();
  updateInputState();
  renderOutput();

  // 2. Fetch full history from API and merge (server is source of truth)
  try {
    const detail = await apiFetch(`/api/sessions/${id}`);
    if (detail && Array.isArray(detail.jobs)) {
      if (!sessions[id] && detail.sessionId) {
        sessions[id] = detail;
      } else if (sessions[id]) {
        // Merge server metadata into local copy
        Object.assign(sessions[id], {
          name: detail.name, type: detail.type, machineId: detail.machineId,
          claudeSessionId: detail.claudeSessionId, remoteWorkdir: detail.remoteWorkdir,
          hostname: detail.hostname, workdir: detail.workdir, status: detail.status,
        });
      }
      contentTitle.textContent = buildContentTitle(sessions[id], id);
      renderSidebar();
      if (!outputs[id]) outputs[id] = {};
      for (const job of detail.jobs) {
        outputs[id][job.jobId] = {
          prompt: job.prompt,
          chunks: job.chunks || [],
          done: job.finishedAt != null,
          exitCode: job.exitCode,
          error: job.error,
        };
      }
      saveOutputs(id);
      updateInputState();
      renderOutput();
    }
  } catch (e) {
    console.error('Failed to load session history', e);
  }
}

// ── Input state ───────────────────────────────────────────────────────────────
function isJobRunning() {
  const jobs = outputs[activeSessionId];
  if (!jobs) return false;
  return Object.values(jobs).some(j => !j.done && !j.error);
}

function updateInputState() {
  promptInput.disabled = false;
  sendBtn.disabled = false;
  promptInput.placeholder = 'Send a prompt...';
  const running = isJobRunning();
  stopBtn.style.display = running ? 'inline-block' : 'none';
}

// ── Output ────────────────────────────────────────────────────────────────────
let _renderPending = false;
let _lastRenderedJobKey = ''; // tracks which jobs we've already built DOM for

function renderOutput() {
  // Throttle: during streaming, limit to ~10 renders/sec
  if (_renderPending) return;
  _renderPending = true;
  requestAnimationFrame(() => {
    _renderPending = false;
    _doRenderOutput();
  });
}

function _doRenderOutput() {
  const jobs = outputs[activeSessionId];
  if (!jobs || Object.keys(jobs).length === 0) {
    outputDiv.innerHTML = '<div class="empty-state"><div class="big">🍌</div><div>No output yet</div></div>';
    _lastRenderedJobKey = '';
    return;
  }

  const entries = Object.entries(jobs);
  const jobKey = activeSessionId + ':' + entries.map(e => e[0]).join(',');

  // If the set of jobs hasn't changed, do an incremental update on the last job
  if (jobKey === _lastRenderedJobKey && entries.length > 0) {
    const [jobId, job] = entries[entries.length - 1];
    const block = document.getElementById('job-' + jobId);
    if (block) {
      // Update status in header
      const statusEl = block.querySelector('.job-status');
      if (statusEl) statusEl.innerHTML = _jobStatus(job);
      // Update body content
      const body = block.querySelector('.output-body');
      if (body) {
        const wasAtBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 30;
        body.innerHTML = renderChunks(job.chunks) || '<span style="color:var(--muted);font-size:11px;">(no output)</span>';
        if (wasAtBottom) body.scrollTop = body.scrollHeight;
      }
      // Keep outer scroll at bottom if it was there
      const outerAtBottom = outputDiv.scrollHeight - outputDiv.scrollTop - outputDiv.clientHeight < 50;
      if (outerAtBottom) outputDiv.scrollTop = outputDiv.scrollHeight;
      return;
    }
  }

  // Full render (new jobs or first render)
  const html = entries.map(([jobId, job]) => `
    <div class="output-block" id="job-${jobId}">
      <div class="output-header">
        <span class="job-id">${jobId.slice(0, 8)}</span>
        <span class="job-prompt">${esc(job.prompt)}</span>
        <span class="job-status">${_jobStatus(job)}</span>
      </div>
      <div class="output-body">${renderChunks(job.chunks) || '<span style="color:var(--muted);font-size:11px;">(no output)</span>'}</div>
    </div>`).join('');

  outputDiv.innerHTML = html;
  _lastRenderedJobKey = jobKey;

  // Scroll outer container and last job body to bottom
  outputDiv.scrollTop = outputDiv.scrollHeight;
  const bodies = outputDiv.querySelectorAll('.output-body');
  if (bodies.length) {
    const lastBody = bodies[bodies.length - 1];
    lastBody.scrollTop = lastBody.scrollHeight;
  }
}

function _jobStatus(job) {
  if (job.error) return `<span style="color:var(--red)">error: ${esc(job.error)}</span>`;
  if (job.done)  return `<span style="color:var(--green)">done (exit ${job.exitCode ?? 0})</span>`;
  return `<span style="color:var(--accent)">running…</span>`;
}

function renderChunks(chunks) {
  return chunks.map(c => {
    if (!c || typeof c !== 'object') return '';

    // ── stream_event (Claude streaming API envelope) ────────────────────
    if (c.type === 'stream_event') {
      const evt = c.event;
      if (!evt) return '';
      if (evt.type === 'content_block_delta') {
        const d = evt.delta;
        if (d?.type === 'text_delta' && d.text) return `<span class="chunk-text">${esc(d.text)}</span>`;
        if (d?.type === 'input_json_delta' && d.partial_json) return `<span class="chunk-tool">${esc(d.partial_json)}</span>`;
        return '';
      }
      if (evt.type === 'content_block_start') {
        const cb = evt.content_block;
        if (cb?.type === 'tool_use') return `<span class="chunk-tool">\n⚙ ${esc(cb.name)}(</span>`;
        return '';
      }
      if (evt.type === 'content_block_stop') {
        return `<span class="chunk-tool">)</span>\n`;
      }
      // message_start, message_delta, message_stop, ping — skip
      return '';
    }

    // ── assistant (full message snapshot) ───────────────────────────────
    if (c.type === 'assistant') {
      const content = c.message?.content;
      if (!Array.isArray(content)) return '';
      return content.map(b => {
        if (b.type === 'text') return `<span class="chunk-text">${esc(b.text)}</span>`;
        if (b.type === 'tool_use') return `<span class="chunk-tool">\n⚙ ${esc(b.name)}(${esc(JSON.stringify(b.input))})</span>\n`;
        return '';
      }).join('');
    }
    if (c.type === 'tool_result') return `<span class="chunk-result">\n→ ${esc(JSON.stringify(c.content)).slice(0, 200)}</span>\n`;
    if (c.type === 'result') return c.is_error ? `<span class="chunk-stderr">Error: ${esc(c.result || '')}</span>` : '';
    if (c.type === 'system') return '';
    if (c.type === 'stderr') return `<span class="chunk-stderr">${esc(c.text)}</span>`;
    return `<span class="chunk-raw">${esc(JSON.stringify(c))}</span>`;
  }).join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────
sendBtn.addEventListener('click', sendPrompt);
promptInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendPrompt(); } });

async function sendPrompt() {
  const prompt = promptInput.value.trim();
  if (!prompt || !activeSessionId) return;
  promptInput.value = '';
  // Use the session's stored model, falling back to the header dropdown selection.
  const session = sessions[activeSessionId];
  const model = session?.model || document.getElementById('model-select')?.value || '';
  const sendBody = { prompt };
  if (model) sendBody.model = model;
  const data = await apiFetch(`/api/sessions/${activeSessionId}/send`, {
    method: 'POST',
    body: JSON.stringify(sendBody),
  });
  if (data.jobId) {
    if (!outputs[activeSessionId]) outputs[activeSessionId] = {};
    outputs[activeSessionId][data.jobId] = { prompt, chunks: [], done: false };
    saveOutputs(activeSessionId);
    updateInputState();
    renderOutput();
    updateSessionSpinner(activeSessionId);
  }
}

// ── Stop (abort running job) ──────────────────────────────────────────────────
stopBtn.addEventListener('click', stopJob);

async function stopJob() {
  if (!activeSessionId || !isJobRunning()) return;
  stopBtn.disabled = true;
  stopBtn.textContent = 'Stopping…';
  await apiFetch(`/api/sessions/${activeSessionId}/abort`, { method: 'POST' });
  stopBtn.disabled = false;
  stopBtn.textContent = 'Stop';
  // The OUTPUT_DONE/ERROR event from the server will update the UI via handleEvent
}

killBtn.addEventListener('click', async () => {
  if (!activeSessionId) return;
  if (!confirm(`Kill session ${activeSessionId.slice(0, 8)}?`)) return;
  await apiFetch(`/api/sessions/${activeSessionId}`, { method: 'DELETE' });
  localStorage.removeItem(`banana_out_${activeSessionId}`);
  delete sessions[activeSessionId];
  activeSessionId = null;
  localStorage.removeItem('banana_active_session');
  contentTitle.textContent = 'Select a session';
  killBtn.style.display = 'none';
  clearQueueBtn.style.display = 'none';
  renderSidebar();
  outputDiv.innerHTML = '<div class="empty-state"><div class="big">🍌</div><div>Select a session</div></div>';
});

clearQueueBtn.addEventListener('click', async () => {
  if (!activeSessionId) return;
  clearQueueBtn.disabled = true;
  clearQueueBtn.textContent = 'Clearing…';
  const r = await apiFetch(`/api/sessions/${activeSessionId}/clear-queue`, { method: 'POST' });
  const data = await r.json();
  clearQueueBtn.disabled = false;
  clearQueueBtn.textContent = 'Clear Queue';
  if (data.cleared > 0) {
    clearQueueBtn.style.display = 'none';
  }
});

// ── Utils ─────────────────────────────────────────────────────────────────────
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function esc(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Modal helpers ─────────────────────────────────────────────────────────────
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }

document.querySelectorAll('.modal-close').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});
document.querySelectorAll('.modal').forEach(modal => {
  modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
});

// ── Session Edit Modal ───────────────────────────────────────────────────────
async function openSessionEditModal(sessionId) {
  const s = sessions[sessionId];
  if (!s) return;
  if (machines.length === 0) await loadMachines();
  document.getElementById('se-id').value = sessionId;
  document.getElementById('se-session-id').textContent = sessionId;
  document.getElementById('se-name').value = s.name || '';
  document.getElementById('se-role').value = s.role || '';
  document.getElementById('se-screen-name').value = s.screenName || '';
  document.getElementById('se-interests').value = (s.interests || []).join(', ');
  document.getElementById('se-channels').value = (s.channels || []).join(', ');
  document.getElementById('se-role-prompt').value = s.rolePrompt || '';
  document.getElementById('se-model').value = s.model || '';
  document.getElementById('se-workdir').value = s.remoteWorkdir || s.workdir || '';

  // Populate machine dropdown
  const sel = document.getElementById('se-machine');
  sel.innerHTML = '<option value="">(none)</option>' +
    machines.map(m => `<option value="${m.id}" ${m.id === s.machineId ? 'selected' : ''}>${esc(m.name)} (${esc(m.alias)})</option>`).join('');

  // Populate claude session id
  document.getElementById('se-claude-session').value = s.claudeSessionId || '';

  // Reset claude session lock
  const csInput = document.getElementById('se-claude-session');
  const csLock = document.getElementById('se-claude-lock');
  csInput.disabled = true;
  csInput.style.opacity = '0.6';
  csLock.innerHTML = '&#128274;';
  csLock.title = 'Unlock to edit';

  // Reset workdir lock
  const wdInput = document.getElementById('se-workdir');
  const wdLock = document.getElementById('se-workdir-lock');
  wdInput.disabled = true;
  wdInput.style.opacity = '0.6';
  wdLock.innerHTML = '&#128274;';
  wdLock.title = 'Unlock to edit';

  document.getElementById('se-status').textContent = '';
  openModal('session-edit-modal');
}

document.getElementById('se-workdir-lock').addEventListener('click', () => {
  const wdInput = document.getElementById('se-workdir');
  const wdLock = document.getElementById('se-workdir-lock');
  const locked = wdInput.disabled;
  wdInput.disabled = !locked;
  wdInput.style.opacity = locked ? '1' : '0.6';
  wdLock.innerHTML = locked ? '&#128275;' : '&#128274;';
  wdLock.title = locked ? 'Lock to prevent edits' : 'Unlock to edit';
  if (locked) wdInput.focus();
});

document.getElementById('se-claude-lock').addEventListener('click', () => {
  const csInput = document.getElementById('se-claude-session');
  const csLock = document.getElementById('se-claude-lock');
  const locked = csInput.disabled;
  csInput.disabled = !locked;
  csInput.style.opacity = locked ? '1' : '0.6';
  csLock.innerHTML = locked ? '&#128275;' : '&#128274;';
  csLock.title = locked ? 'Lock to prevent edits' : 'Unlock to edit';
  if (locked) csInput.focus();
});

document.getElementById('se-save').addEventListener('click', async () => {
  const sessionId = document.getElementById('se-id').value;
  const name = document.getElementById('se-name').value.trim();
  const role = document.getElementById('se-role').value.trim();
  const screenName = document.getElementById('se-screen-name').value.trim();
  const interests = document.getElementById('se-interests').value.split(',').map(s => s.trim()).filter(Boolean);
  const channels = document.getElementById('se-channels').value.split(',').map(s => s.trim()).filter(Boolean);
  const rolePrompt = document.getElementById('se-role-prompt').value.trim();
  const model = document.getElementById('se-model').value;

  const remoteWorkdir = document.getElementById('se-workdir').value.trim();
  const claudeSessionId = document.getElementById('se-claude-session').value.trim();
  const patchBody = { name, role, screenName, interests, channels, rolePrompt, model, remoteWorkdir, claudeSessionId };
  await apiFetch(`/api/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify(patchBody),
  });

  if (sessions[sessionId]) {
    Object.assign(sessions[sessionId], { name, role, screenName, interests, channels, rolePrompt, model, remoteWorkdir, claudeSessionId });
  }

  renderSidebar();
  if (sessionId === activeSessionId) {
    contentTitle.textContent = buildContentTitle(sessions[sessionId], sessionId);
  }

  closeModal('session-edit-modal');
});

// ── Header model selector ─────────────────────────────────────────────────────
// Persists in localStorage. Used as the default `model` for newly created
// sessions; existing sessions keep their stored model unless edited.
(function initModelSelect() {
  const sel = document.getElementById('model-select');
  if (!sel) return;
  sel.value = localStorage.getItem('banana_model') || '';
  sel.addEventListener('change', () => {
    localStorage.setItem('banana_model', sel.value);
  });
})();

// ── Machine Management ────────────────────────────────────────────────────────
let machines = [];

document.getElementById('machines-btn').addEventListener('click', () => {
  loadMachines();
  openModal('machines-modal');
});

async function loadMachines() {
  machines = await apiFetch('/api/machines');
  if (!Array.isArray(machines)) machines = [];
  renderMachinesList();
}

function renderMachinesList() {
  const list = document.getElementById('machines-list');
  if (machines.length === 0) {
    list.innerHTML = '<div style="color:var(--muted);font-size:11px;">No machines configured</div>';
    return;
  }
  list.innerHTML = machines.map(m => {
    const rtBadges = (m.runtimes && m.runtimes.length > 0)
      ? m.runtimes.map(r => `<span class="rt-badge rt-${r.runtime}">${esc(r.runtime)} ${esc(r.version)}</span>`).join(' ')
      : '<span class="rt-badge rt-unknown">not detected</span>';
    const claudeBadge = m.claudePath
      ? `<span class="rt-badge rt-node">claude</span>`
      : '';
    const si = m.systemInfo || {};
    const sysLine = si.os
      ? `${esc(si.os)} | ${esc(si.cpu || '?')} (${si.cpuCores || '?'} cores) | RAM ${esc(si.memoryTotal || '?')} | Disk ${esc(si.diskUsed || '?')}/${esc(si.diskTotal || '?')}`
      : '';
    return `
    <div class="machine-row">
      <div class="machine-info">
        <div class="machine-top">
          <span class="machine-name">${esc(m.name)}</span>
          <span class="machine-alias">${esc(m.alias)}</span>
          <span class="machine-host">${esc(m.username)}@${esc(m.ip)}:${m.port}</span>
        </div>
        ${sysLine ? `<div class="machine-sys">${sysLine}</div>` : ''}
      </div>
      <span class="machine-runtimes">${rtBadges} ${claudeBadge}</span>
      <button class="btn btn-sm btn-setup" data-setup="${m.id}">Setup</button>
      <button class="btn btn-sm" data-detect="${m.id}">Detect</button>
      <button class="btn btn-sm" data-edit="${m.id}">Edit</button>
      <button class="btn btn-sm btn-danger" data-del="${m.id}">Del</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-setup]').forEach(btn => {
    btn.addEventListener('click', () => setupMachine(btn.dataset.setup));
  });
  list.querySelectorAll('[data-detect]').forEach(btn => {
    btn.addEventListener('click', () => detectMachineRuntimes(btn.dataset.detect));
  });
  list.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => editMachine(btn.dataset.edit));
  });
  list.querySelectorAll('[data-del]').forEach(btn => {
    btn.addEventListener('click', () => deleteMachine(btn.dataset.del));
  });
}

function showMachineForm(machine) {
  document.getElementById('machine-form').style.display = 'block';
  document.getElementById('machine-form-title').textContent = machine ? 'Edit Machine' : 'Add Machine';
  document.getElementById('mf-id').value = machine?.id || '';
  document.getElementById('mf-name').value = machine?.name || '';
  document.getElementById('mf-alias').value = machine?.alias || '';
  document.getElementById('mf-ip').value = machine?.ip || '';
  document.getElementById('mf-port').value = machine?.port || 22;
  document.getElementById('mf-username').value = machine?.username || '';
  document.getElementById('mf-password').value = '';
  document.getElementById('mf-sshkey').value = machine?.sshKeyPath || '';
  document.getElementById('mf-passphrase').value = '';
  document.getElementById('mf-workdir').value = machine?.defaultWorkdir || '';
  document.getElementById('mf-os').value = machine?.os || '';
  document.getElementById('mf-mac').value = machine?.macAddress || '';
  document.getElementById('mf-shell').value = machine?.localShell || '';
  document.getElementById('mf-notes').value = machine?.notes || '';
  const skipPerms = machine?.skipPermissions !== false; // default true
  document.getElementById('mf-skip-perms').checked = skipPerms;
  document.getElementById('mf-perm-settings-row').style.display = skipPerms ? 'none' : '';
  document.getElementById('mf-perm-settings').value = machine?.permissionSettings
    ? JSON.stringify(machine.permissionSettings, null, 2) : '';
  document.getElementById('mf-persistent').checked = !!machine?.persistentMode;
  document.getElementById('mf-status').textContent = '';

  // Show runtime/system info if available
  const infoPanel = document.getElementById('mf-runtime-info');
  const infoContent = document.getElementById('mf-runtime-content');
  const hasInfo = machine && (machine.runtimes?.length || machine.claudePath || machine.systemInfo?.os);
  if (hasInfo) {
    const lines = [];
    const si = machine.systemInfo || {};
    if (si.os) lines.push(`<div><strong>OS:</strong> ${esc(si.os)}${si.kernel ? ` (${esc(si.kernel)})` : ''}</div>`);
    if (si.cpu) lines.push(`<div><strong>CPU:</strong> ${esc(si.cpu)} (${si.cpuCores || '?'} cores)</div>`);
    if (si.memoryTotal) lines.push(`<div><strong>RAM:</strong> ${esc(si.memoryTotal)}</div>`);
    if (si.diskTotal) lines.push(`<div><strong>Disk:</strong> ${esc(si.diskUsed || '?')} / ${esc(si.diskTotal)}</div>`);
    if (machine.runtimes?.length) {
      const rts = machine.runtimes.map(r => `${esc(r.runtime)} ${esc(r.version)} <span style="color:var(--muted)">(${esc(r.path)})</span>`).join(', ');
      lines.push(`<div><strong>Runtimes:</strong> ${rts}</div>`);
    }
    if (machine.claudePath) lines.push(`<div><strong>Claude:</strong> ${esc(machine.claudePath)}</div>`);
    if (machine.runtimeDetectedAt) lines.push(`<div style="color:var(--muted);margin-top:4px">Detected: ${new Date(machine.runtimeDetectedAt).toLocaleString()}</div>`);
    infoContent.innerHTML = lines.join('');
    infoPanel.style.display = 'block';
  } else {
    infoPanel.style.display = 'none';
  }
}

function hideMachineForm() {
  document.getElementById('machine-form').style.display = 'none';
}

document.getElementById('add-machine-btn').addEventListener('click', () => showMachineForm(null));
document.getElementById('mf-cancel').addEventListener('click', hideMachineForm);
document.getElementById('mf-skip-perms').addEventListener('change', (e) => {
  document.getElementById('mf-perm-settings-row').style.display = e.target.checked ? 'none' : '';
});

function editMachine(id) {
  const m = machines.find(x => x.id === id);
  if (m) showMachineForm(m);
}

async function detectMachineRuntimes(id) {
  const btn = document.querySelector(`[data-detect="${id}"]`);
  if (btn) { btn.textContent = 'Detecting…'; btn.disabled = true; }
  try {
    await apiFetch(`/api/machines/${id}/detect`, { method: 'POST' });
    await loadMachines();
  } catch (e) {
    console.error('Detection failed', e);
  }
  if (btn) { btn.textContent = 'Detect'; btn.disabled = false; }
}

async function setupMachine(id) {
  const btn = document.querySelector(`[data-setup="${id}"]`);
  if (btn) { btn.textContent = 'Setting up…'; btn.disabled = true; }
  try {
    const res = await apiFetch(`/api/machines/${id}/setup`, { method: 'POST' });
    if (res.error) {
      notify('Setup failed', res.error);
    } else {
      const steps = res.steps || [];
      const summary = steps.map(s => `${s.phase}: ${s.message}`).join('\n');
      notify('Setup complete', summary.slice(0, 200));
    }
    await loadMachines();
  } catch (e) {
    console.error('Setup failed', e);
    notify('Setup error', String(e));
  }
  if (btn) { btn.textContent = 'Setup'; btn.disabled = false; }
}

async function deleteMachine(id) {
  if (!confirm('Delete this machine?')) return;
  await apiFetch(`/api/machines/${id}`, { method: 'DELETE' });
  await loadMachines();
}

document.getElementById('mf-save').addEventListener('click', async () => {
  const id = document.getElementById('mf-id').value;
  const body = {
    name: document.getElementById('mf-name').value,
    alias: document.getElementById('mf-alias').value,
    ip: document.getElementById('mf-ip').value,
    port: parseInt(document.getElementById('mf-port').value) || 22,
    username: document.getElementById('mf-username').value,
    sshKeyPath: document.getElementById('mf-sshkey').value || undefined,
    defaultWorkdir: document.getElementById('mf-workdir').value || undefined,
    os: document.getElementById('mf-os').value || undefined,
    macAddress: document.getElementById('mf-mac').value || undefined,
    localShell: document.getElementById('mf-shell').value || undefined,
    notes: document.getElementById('mf-notes').value || undefined,
    skipPermissions: document.getElementById('mf-skip-perms').checked,
    persistentMode: document.getElementById('mf-persistent').checked,
  };
  // Parse permission settings JSON if provided
  const permSettingsRaw = document.getElementById('mf-perm-settings').value.trim();
  if (!body.skipPermissions && permSettingsRaw) {
    try {
      body.permissionSettings = JSON.parse(permSettingsRaw);
    } catch (e) {
      document.getElementById('mf-status').textContent = 'Invalid permission settings JSON';
      return;
    }
  }
  if (body.skipPermissions) body.permissionSettings = undefined;
  const pw = document.getElementById('mf-password').value;
  if (pw) body.password = pw;
  const pp = document.getElementById('mf-passphrase').value;
  if (pp) body.passphrase = pp;

  if (!body.name) {
    document.getElementById('mf-status').textContent = 'Name is required';
    return;
  }

  if (id) {
    await apiFetch(`/api/machines/${id}`, { method: 'PUT', body: JSON.stringify(body) });
  } else {
    await apiFetch('/api/machines', { method: 'POST', body: JSON.stringify(body) });
  }
  hideMachineForm();
  await loadMachines();
});

document.getElementById('mf-test').addEventListener('click', async () => {
  const id = document.getElementById('mf-id').value;
  const status = document.getElementById('mf-status');
  if (!id) { status.textContent = 'Save the machine first before testing'; return; }
  status.textContent = 'Testing…';
  status.style.color = 'var(--muted)';
  const res = await apiFetch(`/api/machines/${id}/test`, { method: 'POST' });
  if (res.ok) {
    status.textContent = `Connected: ${res.output}`;
    status.style.color = 'var(--green)';
    // Refresh machine list to show detected runtimes
    await loadMachines();
  } else {
    status.textContent = `Failed: ${res.error}`;
    status.style.color = 'var(--red)';
  }
});

// ── New Remote Session ────────────────────────────────────────────────────────
document.getElementById('new-session-btn').addEventListener('click', async () => {
  await loadMachines();
  const sel = document.getElementById('ns-machine');
  sel.innerHTML = machines.length === 0
    ? '<option value="">No machines — add one first</option>'
    : machines.map(m => `<option value="${m.id}">${esc(m.name)} (${esc(m.alias)})</option>`).join('');
  document.getElementById('ns-name').value = '';
  document.getElementById('ns-workdir').value = '';
  openModal('new-session-modal');
});

document.getElementById('ns-create').addEventListener('click', async () => {
  const machineId = document.getElementById('ns-machine').value;
  if (!machineId) return;
  const name = document.getElementById('ns-name').value.trim();
  const workdir = document.getElementById('ns-workdir').value.trim();
  const role = document.getElementById('ns-role').value.trim();
  const screenName = document.getElementById('ns-screen-name').value.trim();
  const interests = document.getElementById('ns-interests').value.split(',').map(s => s.trim()).filter(Boolean);
  const channels = document.getElementById('ns-channels').value.split(',').map(s => s.trim()).filter(Boolean);
  const rolePrompt = document.getElementById('ns-role-prompt').value.trim();
  const body = { machineId };
  if (name) body.name = name;
  if (workdir) body.workdir = workdir;
  if (role) body.role = role;
  if (screenName) body.screenName = screenName;
  if (interests.length) body.interests = interests;
  if (channels.length) body.channels = channels;
  if (rolePrompt) body.rolePrompt = rolePrompt;
  // Inherit the header model dropdown as the per-session default.
  const headerModel = document.getElementById('model-select')?.value || '';
  if (headerModel) body.model = headerModel;
  const session = await apiFetch('/api/sessions', { method: 'POST', body: JSON.stringify(body) });
  if (session.sessionId) {
    sessions[session.sessionId] = session;
    renderSidebar();
    await selectSession(session.sessionId);
  }
  closeModal('new-session-modal');
});

// ── Running Jobs Modal ────────────────────────────────────────────────────────
let jobsRefreshTimer = null;
let jobsSourceFilter = 'all'; // 'all' | 'adhoc' | 'hub-all'

document.getElementById('jobs-btn').addEventListener('click', () => {
  loadActiveJobs();
  loadRecentJobs();
  openModal('jobs-modal');
  // Auto-refresh every 3s while modal is open
  jobsRefreshTimer = setInterval(() => { loadActiveJobs(); loadRecentJobs(); }, 3000);
});

// Stop auto-refresh when modal closes
document.querySelector('[data-close="jobs-modal"]').addEventListener('click', () => {
  if (jobsRefreshTimer) { clearInterval(jobsRefreshTimer); jobsRefreshTimer = null; }
});

// Tab click handler
document.getElementById('jobs-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.jobs-tab');
  if (!tab) return;
  document.querySelectorAll('.jobs-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  jobsSourceFilter = tab.dataset.source;
  loadActiveJobs();
  loadRecentJobs();
});

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

const HUB_SOURCES = new Set(['hub', 'trigger', 'self-trigger', 'talking']);
function filterJobsBySource(allJobs) {
  if (jobsSourceFilter === 'all') return allJobs;
  if (jobsSourceFilter === 'hub-all') return allJobs.filter(j => HUB_SOURCES.has(j.source || ''));
  return allJobs.filter(j => (j.source || 'adhoc') === jobsSourceFilter);
}

function sourceBadge(source) {
  const s = source || 'adhoc';
  const labels = { adhoc: 'Ad-hoc', hub: 'Hub', trigger: 'Trigger', 'self-trigger': 'Self-trigger', talking: 'Talking' };
  return `<span class="job-source-badge job-source-${s}">${labels[s] || s}</span>`;
}

async function loadActiveJobs() {
  const allJobs = await apiFetch('/api/jobs/active');
  const el = document.getElementById('jobs-list');
  if (!Array.isArray(allJobs)) { el.innerHTML = ''; return; }
  updateJobsBadge(allJobs.length);
  const jobs = filterJobsBySource(allJobs);
  if (jobs.length === 0) {
    el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:20px">No running jobs</div>';
    return;
  }
  el.innerHTML = jobs.map(j => `
    <div class="job-card" data-session-id="${esc(j.sessionId)}" data-job-id="${esc(j.jobId)}">
      <div class="job-card-header">
        ${sourceBadge(j.source)}
        <span class="job-session-name">${esc(j.sessionName)}</span>
        <span class="job-model">${j.model ? esc(j.model) : 'default'}</span>
        <span class="job-elapsed">${fmtElapsed(j.elapsedMs)}</span>
        <span class="job-chunks">${j.chunkCount} chunks</span>
      </div>
      <div class="job-prompt">${esc(j.prompt || '(no prompt)')}</div>
      ${j.lastText ? `<div class="job-last-text">${esc(j.lastText)}</div>` : ''}
      <div class="job-card-actions">
        <button class="btn btn-sm job-detail-btn" data-session-id="${esc(j.sessionId)}" data-job-id="${esc(j.jobId)}">Detail</button>
        <button class="btn btn-sm job-abort-btn" data-session-id="${esc(j.sessionId)}" style="background:var(--red);color:#000">Abort</button>
      </div>
    </div>
  `).join('');

  // Wire detail buttons
  el.querySelectorAll('.job-detail-btn').forEach(btn => {
    btn.addEventListener('click', () => openJobDetail(btn.dataset.sessionId, btn.dataset.jobId));
  });
  // Wire abort buttons
  el.querySelectorAll('.job-abort-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Abort this job?')) return;
      await apiFetch(`/api/sessions/${btn.dataset.sessionId}/abort`, { method: 'POST' });
      loadActiveJobs();
    });
  });
}

function updateJobsBadge(count) {
  const badge = document.getElementById('jobs-count');
  if (count > 0) {
    badge.textContent = count;
    badge.style.display = 'inline';
  } else {
    badge.style.display = 'none';
  }
}

/** Debounced active-jobs refresh — called on OUTPUT_CHUNK when modal is open. */
let _activeJobsRefreshTimer = null;
function debouncedLoadActiveJobs() {
  if (_activeJobsRefreshTimer) return;
  _activeJobsRefreshTimer = setTimeout(() => {
    _activeJobsRefreshTimer = null;
    loadActiveJobs();
  }, 500);
}

/** Debounced badge refresh via API — called on every WS job event. */
let _badgeRefreshTimer = null;
function refreshJobsBadge() {
  if (_badgeRefreshTimer) return; // already scheduled
  _badgeRefreshTimer = setTimeout(async () => {
    _badgeRefreshTimer = null;
    try {
      const jobs = await apiFetch('/api/jobs/active');
      if (Array.isArray(jobs)) updateJobsBadge(jobs.length);
    } catch {}
  }, 300);
}

async function loadRecentJobs() {
  const el = document.getElementById('jobs-recent-list');
  if (!el) return;
  try {
    const allJobs = await apiFetch('/api/jobs/recent?limit=20');
    if (!Array.isArray(allJobs) || allJobs.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:10px;font-size:12px">No recent jobs</div>';
      return;
    }
    const jobs = filterJobsBySource(allJobs);
    if (jobs.length === 0) {
      el.innerHTML = '<div style="color:var(--muted);text-align:center;padding:10px;font-size:12px">No recent jobs</div>';
      return;
    }
    const statusColors = { done: 'var(--green)', failed: 'var(--yellow)', error: 'var(--red)' };
    el.innerHTML = jobs.map(j => {
      const color = statusColors[j.status] || 'var(--muted)';
      const dur = j.durationMs != null ? fmtElapsed(j.durationMs) : '-';
      const ago = fmtElapsed(Date.now() - new Date(j.finishedAt).getTime()) + ' ago';
      const icon = j.status === 'done' ? '✓' : j.status === 'error' ? '✗' : '⚠';
      return `
      <div class="job-card job-card-recent" data-session-id="${esc(j.sessionId)}" data-job-id="${esc(j.jobId)}">
        <div class="job-card-header">
          <span style="color:${color};font-weight:bold;margin-right:4px">${icon}</span>
          ${sourceBadge(j.source)}
          <span class="job-session-name">${esc(j.sessionName)}</span>
          <span class="job-model">${j.model ? esc(j.model) : ''}</span>
          <span class="job-elapsed">${dur}</span>
          <span class="job-chunks" title="${esc(j.finishedAt)}">${ago}</span>
        </div>
        <div class="job-prompt">${esc(j.prompt || '(no prompt)')}</div>
        ${j.error ? `<div class="job-error">${esc(j.error)}</div>` : ''}
        ${j.lastText ? `<div class="job-last-text">${esc(j.lastText)}</div>` : ''}
      </div>`;
    }).join('');
    // Wire click to open detail
    el.querySelectorAll('.job-card-recent').forEach(card => {
      card.style.cursor = 'pointer';
      card.addEventListener('click', () => openJobDetail(card.dataset.sessionId, card.dataset.jobId));
    });
  } catch { el.innerHTML = ''; }
}

async function openJobDetail(sessionId, jobId) {
  document.getElementById('job-detail-title').textContent = 'Job Detail';
  const session = sessions[sessionId];
  const jobData = outputs[sessionId]?.[jobId];

  let infoHtml = `<b>Session:</b> ${esc(session?.name || sessionId)}<br>`;
  infoHtml += `<b>Job:</b> ${esc(jobId)}<br>`;
  if (session?.model) infoHtml += `<b>Model:</b> ${esc(session.model)}<br>`;

  // Extract text from chunks for output preview
  let outputText = '';
  if (jobData?.chunks) {
    for (const c of jobData.chunks) {
      if (c?.type === 'stream_event' && c?.event?.type === 'content_block_delta' && c?.event?.delta?.text) {
        outputText += c.event.delta.text;
      } else if (c?.type === 'assistant' && c?.message?.content) {
        // Don't add assistant snapshots if we already have stream text — avoid duplication
      } else if (c?.type === 'stderr') {
        outputText += `\n[stderr] ${c.text || ''}`;
      }
    }
  }
  if (!outputText && jobData?.chunks?.length) {
    outputText = `(${jobData.chunks.length} chunks, no text extracted)`;
  }

  document.getElementById('job-detail-info').innerHTML = infoHtml;
  document.getElementById('job-detail-output').textContent = outputText || '(no output yet)';

  // Wire abort button
  const abortBtn = document.getElementById('job-detail-abort');
  abortBtn.onclick = async () => {
    if (!confirm('Abort this job?')) return;
    await apiFetch(`/api/sessions/${sessionId}/abort`, { method: 'POST' });
    closeModal('job-detail-modal');
    loadActiveJobs();
  };

  openModal('job-detail-modal');
}

// Fallback badge poll (60s) in case WS events are missed; primary updates
// are real-time via refreshJobsBadge() called from OUTPUT_DONE/ERROR/CHUNK.
setInterval(async () => {
  try {
    const jobs = await apiFetch('/api/jobs/active');
    if (Array.isArray(jobs)) updateJobsBadge(jobs.length);
  } catch {}
}, 60000);

// ── Settings Modal ───────────────────────────────────────────────────────────
document.getElementById('settings-btn').addEventListener('click', async () => {
  try {
    const settings = await apiFetch('/api/settings');
    document.getElementById('set-compact-tokens').value = settings.compactTokenThreshold ?? 80000;
    document.getElementById('set-hub-concurrent').value = settings.hubMaxConcurrentJobs ?? 10;
    document.getElementById('set-hub-cooldown').value = settings.hubCooldownMs ?? 10000;
    document.getElementById('set-hub-talk-rounds').value = settings.hubMaxTalkRounds ?? 10;
    document.getElementById('set-hub-chain-depth').value = settings.hubMaxChainDepth ?? 5;
    document.getElementById('set-ssh-idle').value = settings.sshIdleTimeoutMs ?? 1800000;
    document.getElementById('set-notify-mode').value = notifyMode;
    document.getElementById('set-status').textContent = '';
  } catch (e) {
    document.getElementById('set-status').textContent = 'Failed to load settings';
  }
  // Load jump host config
  try {
    const jhCfg = await apiFetch('/api/jumphosts');
    document.getElementById('jh-enabled').checked = jhCfg.enabled;
    renderJumpHosts(jhCfg.hosts);
    renderJumpChainPreview(jhCfg.hosts, jhCfg.enabled);
  } catch (e) {
    renderJumpHosts([]);
  }
  document.getElementById('jh-form').style.display = 'none';
  document.getElementById('jh-test-status').textContent = '';
  openModal('settings-modal');
});

document.getElementById('set-save').addEventListener('click', async () => {
  // Save client-only notification preference
  const newMode = document.getElementById('set-notify-mode').value;
  if (newMode !== notifyMode) {
    notifyMode = newMode;
    localStorage.setItem('banana_notify_mode', notifyMode);
    setupNotifications();
  }
  const body = {
    compactTokenThreshold: Number(document.getElementById('set-compact-tokens').value),
    hubMaxConcurrentJobs: Number(document.getElementById('set-hub-concurrent').value),
    hubCooldownMs: Number(document.getElementById('set-hub-cooldown').value),
    hubMaxTalkRounds: Number(document.getElementById('set-hub-talk-rounds').value),
    hubMaxChainDepth: Number(document.getElementById('set-hub-chain-depth').value),
    sshIdleTimeoutMs: Number(document.getElementById('set-ssh-idle').value),
  };
  try {
    await apiFetch('/api/settings', { method: 'PATCH', body: JSON.stringify(body) });
    document.getElementById('set-status').textContent = 'Saved';
    document.getElementById('set-status').style.color = 'var(--green)';
    setTimeout(() => closeModal('settings-modal'), 600);
  } catch (e) {
    document.getElementById('set-status').textContent = 'Save failed: ' + e;
    document.getElementById('set-status').style.color = 'var(--red)';
  }
});

// ── Jump Hosts UI ─────────────────────────────────────────────────────────────
let _jhHosts = []; // cached list from server

function renderJumpHosts(hosts) {
  _jhHosts = hosts;
  const list = document.getElementById('jh-host-list');
  if (!hosts.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:11px;padding:4px 0">No jump hosts configured</div>';
    return;
  }
  list.innerHTML = hosts.map((h, i) => `<div style="display:flex;align-items:center;gap:6px;padding:4px 0;border-bottom:1px solid var(--border);font-size:12px" data-id="${esc(h.id)}">
    <span style="color:var(--muted);min-width:16px">${i + 1}.</span>
    <span style="flex:1">${esc(h.label || '')} <span style="color:var(--accent)">${esc(h.username)}@${esc(h.host)}:${h.port}</span></span>
    ${i > 0 ? `<button class="btn btn-sm jh-up" data-id="${esc(h.id)}" title="Move up" style="padding:0 4px;font-size:10px">&#9650;</button>` : ''}
    ${i < hosts.length - 1 ? `<button class="btn btn-sm jh-down" data-id="${esc(h.id)}" title="Move down" style="padding:0 4px;font-size:10px">&#9660;</button>` : ''}
    <button class="btn btn-sm jh-edit" data-id="${esc(h.id)}" style="padding:0 6px;font-size:10px">Edit</button>
    <button class="btn btn-sm jh-del" data-id="${esc(h.id)}" style="padding:0 6px;font-size:10px;color:var(--red)">&#10005;</button>
  </div>`).join('');

  // Bind events
  list.querySelectorAll('.jh-del').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const cfg = await apiFetch(`/api/jumphosts/hosts/${id}`, { method: 'DELETE' });
    renderJumpHosts(cfg.hosts);
    renderJumpChainPreview(cfg.hosts, cfg.enabled);
  }));
  list.querySelectorAll('.jh-edit').forEach(btn => btn.addEventListener('click', () => {
    const id = btn.dataset.id;
    const h = _jhHosts.find(x => x.id === id);
    if (!h) return;
    showJhForm(h);
  }));
  list.querySelectorAll('.jh-up').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const ids = _jhHosts.map(h => h.id);
    const idx = ids.indexOf(id);
    if (idx <= 0) return;
    [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
    const cfg = await apiFetch('/api/jumphosts/reorder', { method: 'PUT', body: JSON.stringify({ ids }) });
    renderJumpHosts(cfg.hosts);
    renderJumpChainPreview(cfg.hosts, cfg.enabled);
  }));
  list.querySelectorAll('.jh-down').forEach(btn => btn.addEventListener('click', async () => {
    const id = btn.dataset.id;
    const ids = _jhHosts.map(h => h.id);
    const idx = ids.indexOf(id);
    if (idx < 0 || idx >= ids.length - 1) return;
    [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
    const cfg = await apiFetch('/api/jumphosts/reorder', { method: 'PUT', body: JSON.stringify({ ids }) });
    renderJumpHosts(cfg.hosts);
    renderJumpChainPreview(cfg.hosts, cfg.enabled);
  }));
}

function renderJumpChainPreview(hosts, enabled) {
  const el = document.getElementById('jh-chain-preview');
  if (!hosts.length) { el.style.display = 'none'; return; }
  const chain = ['You'].concat(hosts.map(h => `${h.username}@${h.host}`)).concat(['[target]']);
  el.textContent = (enabled ? '' : '(disabled) ') + chain.join(' \u2192 ');
  el.style.display = 'block';
  el.style.color = enabled ? 'var(--green)' : 'var(--muted)';
}

function showJhForm(existing) {
  const form = document.getElementById('jh-form');
  form.style.display = 'block';
  document.getElementById('jh-edit-id').value = existing ? existing.id : '';
  document.getElementById('jh-label').value = existing ? (existing.label || '') : '';
  document.getElementById('jh-host').value = existing ? existing.host : '';
  document.getElementById('jh-port').value = existing ? existing.port : 22;
  document.getElementById('jh-username').value = existing ? existing.username : '';
  document.getElementById('jh-sshkey').value = existing ? (existing.sshKeyPath || '') : '';
  document.getElementById('jh-password').value = '';
  document.getElementById('jh-passphrase').value = '';
}

document.getElementById('jh-add-btn').addEventListener('click', () => showJhForm(null));
document.getElementById('jh-form-cancel').addEventListener('click', () => {
  document.getElementById('jh-form').style.display = 'none';
});

document.getElementById('jh-form-save').addEventListener('click', async () => {
  const editId = document.getElementById('jh-edit-id').value;
  const data = {
    label: document.getElementById('jh-label').value.trim(),
    host: document.getElementById('jh-host').value.trim(),
    port: Number(document.getElementById('jh-port').value) || 22,
    username: document.getElementById('jh-username').value.trim(),
    sshKeyPath: document.getElementById('jh-sshkey').value.trim() || undefined,
    password: document.getElementById('jh-password').value || undefined,
    passphrase: document.getElementById('jh-passphrase').value || undefined,
  };
  if (!data.host || !data.username) { alert('Host and username required'); return; }
  try {
    let cfg;
    if (editId) {
      cfg = await apiFetch(`/api/jumphosts/hosts/${editId}`, { method: 'PUT', body: JSON.stringify(data) });
    } else {
      cfg = await apiFetch('/api/jumphosts/hosts', { method: 'POST', body: JSON.stringify(data) });
    }
    renderJumpHosts(cfg.hosts);
    renderJumpChainPreview(cfg.hosts, cfg.enabled);
    document.getElementById('jh-form').style.display = 'none';
  } catch (e) {
    alert('Save failed: ' + e);
  }
});

document.getElementById('jh-enabled').addEventListener('change', async (e) => {
  try {
    await apiFetch('/api/jumphosts/enabled', { method: 'PATCH', body: JSON.stringify({ enabled: e.target.checked }) });
    renderJumpChainPreview(_jhHosts, e.target.checked);
  } catch (err) {
    e.target.checked = !e.target.checked; // revert
  }
});

document.getElementById('jh-test-btn').addEventListener('click', async () => {
  const status = document.getElementById('jh-test-status');
  status.textContent = 'Testing chain...';
  status.style.color = 'var(--muted)';
  try {
    const result = await apiFetch('/api/jumphosts/test', { method: 'POST' });
    if (result.ok) {
      status.textContent = 'Chain OK: ' + (result.output || '');
      status.style.color = 'var(--green)';
    } else {
      status.textContent = 'Chain failed: ' + (result.error || '');
      status.style.color = 'var(--red)';
    }
  } catch (e) {
    status.textContent = 'Test failed: ' + e;
    status.style.color = 'var(--red)';
  }
});

// ── Hub ───────────────────────────────────────────────────────────────────────
document.getElementById('hub-btn').addEventListener('click', () => {
  hubVisible = !hubVisible;
  document.getElementById('main').style.display = hubVisible ? 'none' : 'flex';
  document.getElementById('hub-panel').style.display = hubVisible ? 'flex' : 'none';
  document.getElementById('hub-btn').style.background = hubVisible ? 'var(--accent)' : 'var(--blue)';
  if (hubVisible) {
    loadHubChannels();
    if (activeChannelId) renderHubMessages();
  }
});

async function loadHubChannels() {
  hubChannels = await apiFetch('/api/hub/channels');
  if (!Array.isArray(hubChannels)) hubChannels = [];
  renderHubChannels();
}

function renderHubChannels() {
  const list = document.getElementById('hub-channel-list');
  const showArchived = document.getElementById('hub-archived-toggle')?.checked;
  const visible = hubChannels.filter(ch => showArchived ? true : !ch.archived);
  if (visible.length === 0) {
    list.innerHTML = '<div style="padding:12px;color:var(--muted);font-size:11px;">No channels yet</div>';
    return;
  }
  list.innerHTML = visible.map(ch => `
    <div class="hub-channel-item ${ch.id === activeChannelId ? 'active' : ''} ${ch.archived ? 'archived' : ''}" data-channel="${esc(ch.id)}">
      <span class="hub-channel-name" style="${ch.archived ? 'opacity:0.5' : ''}">${esc(ch.name)}${ch.archived ? ' (archived)' : ''}</span>
      ${ch.description ? `<span class="hub-channel-desc">${esc(ch.description)}</span>` : ''}
      <span class="hub-channel-actions-inline" style="margin-left:auto;display:flex;gap:2px">
        ${ch.archived
          ? `<button class="btn btn-sm hub-restore-btn" data-channel="${esc(ch.id)}" title="Restore channel" style="font-size:10px;padding:0 4px">Restore</button>`
          : `<button class="btn btn-sm hub-edit-ch-btn" data-channel="${esc(ch.id)}" title="Edit channel" style="font-size:10px;padding:0 4px;background:transparent;color:var(--muted)">&#9881;</button>`
        }
      </span>
    </div>
  `).join('');
  list.querySelectorAll('.hub-channel-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.hub-edit-ch-btn') || e.target.closest('.hub-restore-btn')) return;
      selectHubChannel(el.dataset.channel);
    });
  });
  list.querySelectorAll('.hub-edit-ch-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openEditChannelModal(btn.dataset.channel);
    });
  });
  list.querySelectorAll('.hub-restore-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await apiFetch(`/api/hub/channels/${btn.dataset.channel}/restore`, { method: 'POST' });
      await loadHubChannels();
    });
  });
}

async function selectHubChannel(channelId) {
  activeChannelId = channelId;
  currentDocId = null;
  renderHubChannels();
  const ch = hubChannels.find(c => c.id === channelId);
  document.getElementById('hub-channel-title').textContent = ch?.name ?? channelId;
  const msgs = await apiFetch(`/api/hub/channels/${channelId}/messages`);
  hubMessages[channelId] = Array.isArray(msgs) ? msgs : [];
  renderHubMessages();
  // Clear doc body on channel switch so stale content from previous channel doesn't persist
  document.getElementById('hub-doc-body').innerHTML = '<div style="color:var(--muted);padding:16px">Select a doc</div>';
  // Refresh whatever view is currently active
  if (hubViewMode === 'tasks') loadChannelTasks(channelId);
  if (hubViewMode === 'docs') loadChannelDocs(channelId);
}

function renderHubMessages() {
  const container = document.getElementById('hub-messages');
  const msgs = hubMessages[activeChannelId] ?? [];
  if (msgs.length === 0) {
    container.innerHTML = '<div class="empty-state"><div>No messages</div></div>';
    return;
  }
  // Friendly label for a sessionId — prefers screenName, then name, then short id.
  const labelFor = sid => {
    const s = sessions[sid];
    return s?.screenName || s?.name || sid.slice(0, 6);
  };
  container.innerHTML = msgs.map(m => {
    const indent = Math.min(m.depth, 5) * 16;
    const dispatches = m.dispatches ?? [];
    const colors = { queued: 'var(--muted)', running: 'var(--blue)', acted: 'var(--green)', skipped: 'var(--muted)', error: 'var(--red)', aborted: 'var(--yellow, orange)' };
    const dispBadges = dispatches.map(d =>
      `<span class="hub-dispatch-badge" style="color:${colors[d.status] || 'var(--muted)'}" title="${esc(d.sessionId)}">${esc(labelFor(d.sessionId))}:${d.status}</span>`
    ).join(' ');

    // While the message is not yet 'complete', surface any in-flight workers
    // (running + queued) prominently with a spinner so it's obvious WHO we're
    // waiting on right now. The high-level msg.status is 'pending' before any
    // dispatch is added and 'dispatched' once at least one is in flight; we
    // care about both.
    const inFlight = m.status !== 'complete'
      ? dispatches.filter(d => d.status === 'running' || d.status === 'queued')
      : [];
    const inFlightBlock = inFlight.length > 0
      ? `<div class="hub-msg-inflight">
           <span class="hub-spinner">⏳</span>
           <span class="hub-inflight-label">processing:</span>
           ${inFlight.map(d => `<span class="hub-inflight-agent hub-inflight-${d.status}" title="${esc(d.sessionId)} — ${d.status}">${esc(labelFor(d.sessionId))}${d.status === 'queued' ? ' (queued)' : ''}</span>`).join('')}
         </div>`
      : '';

    const tagBadges = m.tags.map(t => `<span class="hub-tag">${esc(t)}</span>`).join('');
    const mentionBadges = m.mentions.map(n => `<span class="hub-mention">@${esc(n)}</span>`).join('');

    // Detect [SKIP][#REASON] messages for special rendering
    const skipMatch = m.content.match(/^\[SKIP\]\[#([A-Z0-9_]+)\]\s*(.*)/is);
    const isSkipMsg = !!skipMatch;
    const skipReason = skipMatch ? skipMatch[1] : '';
    const skipExplanation = skipMatch ? skipMatch[2].trim() : '';
    const skipBadge = isSkipMsg
      ? `<span class="hub-skip-badge" title="${esc(skipExplanation || skipReason)}">SKIP #${esc(skipReason)}</span>`
      : '';
    const contentHtml = isSkipMsg
      ? (skipExplanation ? `<span class="hub-skip-text">${esc(skipExplanation)}</span>` : '')
      : esc(m.content);

    return `
    <div class="hub-msg${isSkipMsg ? ' hub-msg-skip' : ''}" style="margin-left:${indent}px" data-msg-id="${m.id}">
      <div class="hub-msg-header">
        <button class="hub-retry-btn" data-retry="${m.id}" title="Retry / continue — re-dispatch a session that previously ran on this message (e.g. after rate limit reset)">↻</button>
        <span class="hub-msg-from" data-session-id="${m.from}">${esc(m.fromName)}</span>
        ${skipBadge}
        <span class="hub-msg-time">${new Date(m.timestamp).toLocaleTimeString()}</span>
        <span class="hub-msg-status hub-status-${m.status}">${m.status}</span>
        <button class="hub-trigger-btn" data-trigger="${m.id}" title="Trigger a session to act on this message">▶ Trigger</button>
      </div>
      <div class="hub-msg-content">${contentHtml}</div>
      ${inFlightBlock}
      <div class="hub-msg-meta">${tagBadges} ${mentionBadges} ${dispBadges}</div>
    </div>`;
  }).join('');
  container.scrollTop = container.scrollHeight;
  container.querySelectorAll('.hub-trigger-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openTriggerPicker(btn.dataset.trigger, btn);
    });
  });
  container.querySelectorAll('.hub-retry-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      openRetryPicker(btn.dataset.retry, btn);
    });
  });
  // Tooltip hover for agent name — shows tmux commands in a floating popup
  container.querySelectorAll('.hub-msg-from').forEach(el => {
    const sessionId = el.dataset.sessionId;
    if (!sessionId) return;
    el.addEventListener('mouseenter', () => {
      clearTimeout(_hubFromHideTimer);
      showHubFromTooltip(el, sessionId);
    });
    el.addEventListener('mouseleave', () => {
      _hubFromHideTimer = setTimeout(hideHubFromTooltip, 150);
    });
  });
}

// ── Hub "from" tooltip (floating, shared, with copy buttons) ──────────────
let _hubFromTip = null;
let _hubFromAnchor = null;
let _hubFromHideTimer = null;

function showHubFromTooltip(anchor, sessionId) {
  const s = sessions[sessionId];
  const machine = s?.machineId ? machines.find(x => x.id === s.machineId) : null;
  if (!s || !machine?.persistentMode) return;

  const sid8 = s.sessionId.slice(0, 8);
  const isLocal = !machine.ip || machine.ip === 'localhost' || machine.ip === '127.0.0.1';
  const sshPrefix = isLocal ? '' : `ssh ${machine.username || 'root'}@${machine.ip} -t `;
  const workCmd = `${sshPrefix}tmux attach -t banana-${sid8}`;
  const hubCmd = `${sshPrefix}tmux attach -t banana-${sid8}-hub`;

  if (!_hubFromTip) {
    _hubFromTip = document.createElement('div');
    _hubFromTip.className = 'session-tooltip hub-from-tooltip';
    _hubFromTip.addEventListener('mouseenter', () => clearTimeout(_hubFromHideTimer));
    _hubFromTip.addEventListener('mouseleave', () => {
      _hubFromHideTimer = setTimeout(hideHubFromTooltip, 150);
    });
    document.body.appendChild(_hubFromTip);
  }

  _hubFromAnchor = anchor;
  _hubFromTip.innerHTML = `
    <div class="session-tooltip-label">Work tmux</div>
    <div class="session-tooltip-cmd"><code>${esc(workCmd)}</code><button class="session-tooltip-copy" data-copy="${esc(workCmd)}">⧉</button></div>
    <div class="session-tooltip-label">Hub tmux</div>
    <div class="session-tooltip-cmd"><code>${esc(hubCmd)}</code><button class="session-tooltip-copy" data-copy="${esc(hubCmd)}">⧉</button></div>`;

  _hubFromTip.querySelectorAll('.session-tooltip-copy').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = '✓';
      setTimeout(() => { btn.textContent = '⧉'; }, 1000);
    };
  });

  const rect = anchor.getBoundingClientRect();
  _hubFromTip.style.left = rect.left + 'px';
  _hubFromTip.style.top = (rect.bottom + 4) + 'px';
  _hubFromTip.style.display = 'block';
  _hubFromTip.style.pointerEvents = 'auto';
}

function hideHubFromTooltip() {
  if (_hubFromTip) {
    _hubFromTip.style.display = 'none';
    _hubFromTip.style.pointerEvents = 'none';
  }
  _hubFromAnchor = null;
}

let _triggerPickerEl = null;

function closeTriggerPicker() {
  if (_triggerPickerEl) {
    _triggerPickerEl.remove();
    _triggerPickerEl = null;
    document.removeEventListener('click', _onDocClickClosePicker);
  }
}

function _onDocClickClosePicker(e) {
  if (_triggerPickerEl && !_triggerPickerEl.contains(e.target)) closeTriggerPicker();
}

function openTriggerPicker(messageId, anchorEl) {
  closeTriggerPicker();
  const remoteSessions = Object.values(sessions).filter(s => s.type === 'remote' && s.machineId);
  if (remoteSessions.length === 0) {
    alert('No remote sessions available to trigger.');
    return;
  }
  const picker = document.createElement('div');
  picker.className = 'hub-trigger-picker';
  picker.innerHTML = `
    <div class="hub-trigger-picker-header">Trigger which session?</div>
    ${remoteSessions.map(s => {
      const label = s.screenName || s.name || s.sessionId.slice(0, 8);
      const role = s.role ? ` <span class="hub-trigger-picker-role">${esc(s.role)}</span>` : '';
      return `<div class="hub-trigger-picker-item" data-session="${s.sessionId}">${esc(label)}${role}</div>`;
    }).join('')}
  `;
  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  picker.style.left = (rect.left + window.scrollX) + 'px';
  _triggerPickerEl = picker;
  picker.querySelectorAll('.hub-trigger-picker-item').forEach(el => {
    el.addEventListener('click', async () => {
      const sessionId = el.dataset.session;
      closeTriggerPicker();
      try {
        const result = await apiFetch(`/api/hub/messages/${messageId}/trigger`, {
          method: 'POST',
          body: JSON.stringify({ sessionId }),
        });
        if (result?.error) alert('Trigger failed: ' + result.error);
      } catch (err) {
        alert('Trigger failed: ' + err.message);
      }
    });
  });
  setTimeout(() => document.addEventListener('click', _onDocClickClosePicker), 0);
}

function openRetryPicker(messageId, anchorEl) {
  closeTriggerPicker();
  const msg = (hubMessages[activeChannelId] ?? []).find(m => m.id === messageId);
  if (!msg) {
    alert('Message not found.');
    return;
  }
  // Build candidate list: prefer sessions that previously dispatched on this message
  // (errored/timed-out first), then fall back to all remote sessions.
  const dispatches = msg.dispatches ?? [];
  const statusOrder = { error: 0, running: 1, queued: 2, aborted: 3, acted: 4, skipped: 5 };
  const dispatchedSessions = dispatches
    .map(d => ({ d, s: sessions[d.sessionId] }))
    .filter(x => x.s && x.s.type === 'remote' && x.s.machineId)
    .sort((a, b) => (statusOrder[a.d.status] ?? 9) - (statusOrder[b.d.status] ?? 9));
  const dispatchedIds = new Set(dispatchedSessions.map(x => x.s.sessionId));
  const otherRemote = Object.values(sessions)
    .filter(s => s.type === 'remote' && s.machineId && !dispatchedIds.has(s.sessionId));

  if (dispatchedSessions.length === 0 && otherRemote.length === 0) {
    alert('No remote sessions available to retry.');
    return;
  }

  const picker = document.createElement('div');
  picker.className = 'hub-trigger-picker';
  const header = `<div class="hub-trigger-picker-header">Retry / continue — pick session</div>`;
  const previousItems = dispatchedSessions.map(({ d, s }) => {
    const label = s.screenName || s.name || s.sessionId.slice(0, 8);
    const role = s.role ? ` <span class="hub-trigger-picker-role">${esc(s.role)}</span>` : '';
    const badge = ` <span class="hub-trigger-picker-role" style="color:${d.status === 'error' ? 'var(--red)' : 'var(--muted)'}">${d.status}</span>`;
    return `<div class="hub-trigger-picker-item" data-session="${s.sessionId}">${esc(label)}${role}${badge}</div>`;
  }).join('');
  const divider = (dispatchedSessions.length > 0 && otherRemote.length > 0)
    ? `<div class="hub-trigger-picker-header" style="font-size:10px;opacity:0.6">other sessions</div>`
    : '';
  const otherItems = otherRemote.map(s => {
    const label = s.screenName || s.name || s.sessionId.slice(0, 8);
    const role = s.role ? ` <span class="hub-trigger-picker-role">${esc(s.role)}</span>` : '';
    return `<div class="hub-trigger-picker-item" data-session="${s.sessionId}">${esc(label)}${role}</div>`;
  }).join('');
  picker.innerHTML = header + previousItems + divider + otherItems;
  document.body.appendChild(picker);
  const rect = anchorEl.getBoundingClientRect();
  picker.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  picker.style.left = (rect.left + window.scrollX) + 'px';
  _triggerPickerEl = picker;
  picker.querySelectorAll('.hub-trigger-picker-item').forEach(el => {
    el.addEventListener('click', async () => {
      const sessionId = el.dataset.session;
      closeTriggerPicker();
      try {
        const result = await apiFetch(`/api/hub/messages/${messageId}/trigger`, {
          method: 'POST',
          body: JSON.stringify({ sessionId }),
        });
        if (result?.error) alert('Retry failed: ' + result.error);
      } catch (err) {
        alert('Retry failed: ' + err.message);
      }
    });
  });
  setTimeout(() => document.addEventListener('click', _onDocClickClosePicker), 0);
}

function handleHubEvent(msg) {
  if (msg.event === 'HUB_MESSAGE' && msg.message) {
    const m = msg.message;
    if (!hubMessages[m.channelId]) hubMessages[m.channelId] = [];
    hubMessages[m.channelId].push(m);
    if (m.channelId === activeChannelId) renderHubMessages();
    // Auto-add channel if not known
    if (!hubChannels.find(c => c.id === m.channelId)) {
      loadHubChannels();
    }
  }
  if (msg.event === 'HUB_DISPATCH_UPDATE' && msg.messageId) {
    // Patch the in-memory copy of the message so the "processing: <agent>"
    // indicator updates without refetching the whole channel.
    const list = hubMessages[msg.channelId];
    if (list) {
      const target = list.find(x => x.id === msg.messageId);
      if (target) {
        target.dispatches = msg.dispatches;
        if (msg.status) target.status = msg.status;
        if (msg.channelId === activeChannelId) renderHubMessages();
      }
    }
  }
  if (msg.event === 'TASKS_CHANGED' && msg.channelId === activeChannelId && hubVisible) {
    loadChannelTasks(msg.channelId);
  }
  if (msg.event === 'DOCS_CHANGED' && msg.channelId === activeChannelId && hubVisible) {
    loadChannelDocs(msg.channelId);
  }
  if (msg.event === 'CHANNEL_COMPACTED') {
    // Drop the old in-memory message list — the server has archived them.
    delete hubMessages[msg.channelId];
    if (msg.channelId === activeChannelId && hubVisible) {
      selectHubChannel(msg.channelId);
    }
  }
  if (msg.event === 'HUB_COMPACT_PROGRESS' && msg.channelId === activeChannelId) {
    // Update the visible compaction status banner with chunk progress.
    const statusEl = document.getElementById('hub-compact-status');
    if (statusEl && statusEl.style.display !== 'none') {
      statusEl.className = 'hub-compact-status running';
      statusEl.textContent = msg.totalParts > 1
        ? `⏳ ${msg.message} — part ${msg.partIdx}/${msg.totalParts}`
        : `⏳ ${msg.message}`;
    }
  }
}

// ── Hub tab switching ─────────────────────────────────────────────────────
function switchHubView(view) {
  hubViewMode = view;
  document.querySelectorAll('.hub-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.view === view);
  });
  document.getElementById('hub-messages-view').style.display = view === 'messages' ? 'flex' : 'none';
  document.getElementById('hub-tasks-view').style.display = view === 'tasks' ? 'flex' : 'none';
  document.getElementById('hub-docs-view').style.display = view === 'docs' ? 'flex' : 'none';
  if (!activeChannelId) return;
  if (view === 'tasks') loadChannelTasks(activeChannelId);
  if (view === 'docs') loadChannelDocs(activeChannelId);
}

document.querySelectorAll('.hub-tab').forEach(btn => {
  btn.addEventListener('click', () => switchHubView(btn.dataset.view));
});

// ── Channel compaction ───────────────────────────────────────────────────
document.getElementById('hub-compact-btn')?.addEventListener('click', async () => {
  if (!activeChannelId) {
    alert('Select a channel first.');
    return;
  }
  const msgs = hubMessages[activeChannelId] ?? [];
  if (msgs.length === 0) {
    alert('Channel has no messages to compact.');
    return;
  }
  const ok = confirm(
    `Compact #${activeChannelId}?\n\n` +
    `This will:\n` +
    `  • Run an LLM to summarize all ${msgs.length} message(s)\n` +
    `  • Archive the originals into the channel chat-log (recoverable via History)\n` +
    `  • Replace the live channel with a single seed message containing the summary\n\n` +
    `Continue?`
  );
  if (!ok) return;

  const btn = document.getElementById('hub-compact-btn');
  const historyBtn = document.getElementById('hub-history-btn');
  const statusEl = document.getElementById('hub-compact-status');
  const originalLabel = btn.textContent;
  btn.disabled = true;
  if (historyBtn) historyBtn.disabled = true;
  btn.textContent = '⏳ compacting…';
  if (statusEl) {
    statusEl.style.display = 'inline-flex';
    statusEl.className = 'hub-compact-status running';
    statusEl.textContent = `⏳ summarizing ${msgs.length} messages — this may take 30–90s`;
  }
  const startedAt = Date.now();
  try {
    const result = await apiFetch(`/api/hub/channels/${activeChannelId}/compact`, {
      method: 'POST',
      body: JSON.stringify({ by: 'user' }),
    });
    // apiFetch does not throw on HTTP errors — surface backend errors here.
    if (result && typeof result === 'object' && result.error) {
      throw new Error(result.error);
    }
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    if (statusEl) {
      statusEl.className = 'hub-compact-status ok';
      statusEl.textContent = `✓ compacted in ${elapsed}s`;
      setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }
    // The CHANNEL_COMPACTED ws event will reload the channel; trigger it now too
    // in case the WS is dropped or the user has the modal blocking the event.
    delete hubMessages[activeChannelId];
    await selectHubChannel(activeChannelId);
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'hub-compact-status error';
      statusEl.textContent = `✗ ${err.message}`;
    }
    alert('Compact failed: ' + err.message);
  } finally {
    btn.disabled = false;
    if (historyBtn) historyBtn.disabled = false;
    btn.textContent = originalLabel;
  }
});

document.getElementById('hub-history-btn')?.addEventListener('click', async () => {
  if (!activeChannelId) {
    alert('Select a channel first.');
    return;
  }
  await openCompactionHistory(activeChannelId);
});

async function openCompactionHistory(channelId) {
  let compactions;
  try {
    compactions = await apiFetch(`/api/hub/channels/${channelId}/compactions`);
  } catch (err) {
    alert('Failed to load history: ' + err.message);
    return;
  }
  if (compactions && typeof compactions === 'object' && compactions.error) {
    alert('Failed to load history: ' + compactions.error);
    return;
  }
  const modal = document.getElementById('compaction-history-modal');
  const titleEl = document.getElementById('ch-title');
  const listEl = document.getElementById('ch-list');
  const emptyEl = document.getElementById('ch-empty');
  const channel = hubChannels.find(c => c.id === channelId);
  titleEl.textContent = `Compactions for ${channel?.name ?? channelId} (${Array.isArray(compactions) ? compactions.length : 0})`;
  if (!Array.isArray(compactions) || compactions.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = 'block';
  } else {
    emptyEl.style.display = 'none';
    listEl.innerHTML = compactions.map((c, i) => `
      <div class="compaction-row">
        <div class="compaction-row-header">
          <span class="compaction-id">${esc(c.id)}</span>
          <span class="compaction-meta">${new Date(c.createdAt).toLocaleString()} · by ${esc(c.createdBy)} · ${c.messageIds.length} msgs</span>
          <button class="btn btn-sm compaction-redo-btn" data-compact-id="${esc(c.id)}" data-channel-id="${esc(c.channelId)}" title="Re-run the LLM summarizer for this compaction (e.g. after an API auth error)">Redo</button>
        </div>
        <details>
          <summary>Summary</summary>
          <pre class="compaction-summary">${esc(c.summary)}</pre>
        </details>
        <details>
          <summary>Original messages (${c.messages.length})</summary>
          <div class="compaction-originals">
            ${c.messages.map(m => `
              <div class="compaction-original-msg">
                <div class="compaction-original-header">
                  <strong>${esc(m.fromName)}</strong>
                  <span style="color:var(--muted)">${new Date(m.timestamp).toLocaleString()}</span>
                  <span style="color:var(--muted)">depth ${m.depth}</span>
                </div>
                <pre class="compaction-original-content">${esc(m.content)}</pre>
              </div>
            `).join('')}
          </div>
        </details>
      </div>
    `).join('');
    // Attach redo button handlers
    listEl.querySelectorAll('.compaction-redo-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const compactId = btn.dataset.compactId;
        const chId = btn.dataset.channelId;
        const ok = confirm(
          `Redo compaction ${compactId}?\n\n` +
          `This will re-run the LLM summarizer on the ${btn.closest('.compaction-row').querySelector('.compaction-meta').textContent.match(/\d+ msgs/)?.[0] ?? 'archived'} messages ` +
          `and replace the current summary.\n\nContinue?`
        );
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Redoing...';
        try {
          const result = await apiFetch(`/api/hub/channels/${chId}/compactions/${compactId}/redo`, {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (result && result.error) throw new Error(result.error);
          btn.textContent = 'Done';
          btn.style.background = 'var(--green)';
          btn.style.color = '#000';
          // Reload the history modal and channel messages
          setTimeout(async () => {
            await openCompactionHistory(chId);
            if (chId === activeChannelId) {
              delete hubMessages[activeChannelId];
              await selectHubChannel(activeChannelId);
            }
          }, 500);
        } catch (err) {
          btn.textContent = 'Failed';
          btn.style.background = 'var(--red)';
          alert('Redo failed: ' + err.message);
          setTimeout(() => { btn.textContent = 'Redo'; btn.style.background = ''; btn.disabled = false; }, 2000);
        }
      });
    });
  }
  modal.style.display = 'flex';
}

// ── Tasks ────────────────────────────────────────────────────────────────
// ── Task view mode: list vs board ─────────────────────────────────────────
let taskViewMode = localStorage.getItem('banana_task_view') || 'board';

async function loadChannelTasks(channelId) {
  const params = new URLSearchParams();
  const status = document.getElementById('hub-task-status-filter').value;
  if (status) params.set('status', status);
  const q = document.getElementById('hub-task-search').value.trim();
  if (q) params.set('q', q);
  const qs = params.toString();
  const tasks = await apiFetch(`/api/hub/channels/${channelId}/tasks${qs ? `?${qs}` : ''}`);
  channelTasks[channelId] = Array.isArray(tasks) ? tasks : [];
  renderTasks();
}

function renderTaskCard(t, compact) {
  const tags = t.tags.map(tag => `<span class="task-tag-chip">${esc(tag)}</span>`).join('');
  const assignee = t.assignee ? `<span class="task-assignee-chip">@${esc(t.assignee)}</span>` : '';
  const prio = t.priority ? `<span class="task-priority-${t.priority}">!${t.priority}</span>` : '';
  if (compact) {
    // Board card — vertical, no status badge (column implies status)
    return `
      <div class="task-card task-board-card" data-task-id="${esc(t.id)}">
        <div class="task-board-card-header">
          <span class="task-card-id">${esc(t.id)}</span>
          ${prio}
        </div>
        <span class="task-card-title">${esc(t.title)}</span>
        <div class="task-card-meta">${assignee}${tags}</div>
      </div>`;
  }
  // List card — horizontal
  return `
    <div class="task-card" data-task-id="${esc(t.id)}">
      <span class="task-card-id">${esc(t.id)}</span>
      <span class="task-card-title">${esc(t.title)}</span>
      <div class="task-card-meta">
        <span class="task-status-badge task-status-${t.status}">${esc(t.status)}</span>
        ${assignee}${tags}${prio}
      </div>
    </div>`;
}

function renderTasks() {
  const listContainer = document.getElementById('hub-task-list');
  const boardContainer = document.getElementById('hub-task-board');
  const tasks = channelTasks[activeChannelId] ?? [];

  if (taskViewMode === 'board') {
    listContainer.style.display = 'none';
    boardContainer.style.display = 'flex';
    renderTaskBoard(boardContainer, tasks);
  } else {
    boardContainer.style.display = 'none';
    listContainer.style.display = '';
    renderTaskList(listContainer, tasks);
  }
}

function renderTaskList(container, tasks) {
  if (tasks.length === 0) {
    container.innerHTML = '<div class="empty-state"><div>No tasks</div></div>';
    return;
  }
  container.innerHTML = tasks.map(t => renderTaskCard(t, false)).join('');
  container.querySelectorAll('.task-card').forEach(el => {
    el.addEventListener('click', () => openTaskModal(el.dataset.taskId));
  });
}

const BOARD_COLUMNS = [
  { key: 'open',        label: 'Open',        statuses: ['open'] },
  { key: 'in_progress', label: 'In Progress',  statuses: ['in_progress'] },
  { key: 'qa_test',     label: 'QA / Test',    statuses: ['qa_test'] },
  { key: 'blocked',     label: 'Blocked',      statuses: ['blocked'] },
  { key: 'done',        label: 'Done',         statuses: ['done', 'wontfix'] },
];

function renderTaskBoard(container, tasks) {
  let html = '';
  for (const col of BOARD_COLUMNS) {
    const colTasks = tasks.filter(t => col.statuses.includes(t.status));
    html += `<div class="board-column board-col-${col.key}">`;
    html += `<div class="board-column-header">`;
    html += `<span class="board-column-title">${col.label}</span>`;
    html += `<span class="board-column-count">${colTasks.length}</span>`;
    html += `</div>`;
    html += `<div class="board-column-body">`;
    if (colTasks.length === 0) {
      html += `<div class="board-empty">—</div>`;
    } else {
      html += colTasks.map(t => renderTaskCard(t, true)).join('');
    }
    html += `</div></div>`;
  }
  container.innerHTML = html;
  container.querySelectorAll('.task-card').forEach(el => {
    el.addEventListener('click', () => openTaskModal(el.dataset.taskId));
  });
}

// View toggle button
document.getElementById('hub-task-view-toggle').addEventListener('click', () => {
  taskViewMode = taskViewMode === 'list' ? 'board' : 'list';
  localStorage.setItem('banana_task_view', taskViewMode);
  updateViewToggleIcon();
  renderTasks();
});

function updateViewToggleIcon() {
  const btn = document.getElementById('hub-task-view-toggle');
  btn.innerHTML = taskViewMode === 'list' ? '&#9638;' : '&#9776;';
  btn.title = taskViewMode === 'list' ? 'Switch to board view' : 'Switch to list view';
}
updateViewToggleIcon();

document.getElementById('hub-task-status-filter').addEventListener('change', () => {
  if (activeChannelId) loadChannelTasks(activeChannelId);
});
document.getElementById('hub-task-search').addEventListener('input', debounce(() => {
  if (activeChannelId) loadChannelTasks(activeChannelId);
}, 300));

document.getElementById('hub-new-task-btn').addEventListener('click', () => {
  if (!activeChannelId) { alert('Select a channel first'); return; }
  openTaskModal(null);
});

let _editingTaskId = null;
async function openTaskModal(taskId) {
  _editingTaskId = taskId;
  let task = null;
  if (taskId) {
    task = await apiFetch(`/api/hub/tasks/${taskId}`);
    document.getElementById('te-title').textContent = `${task.id} — ${task.title}`;
  } else {
    document.getElementById('te-title').textContent = 'New Task';
  }
  document.getElementById('te-title-input').value = task?.title ?? '';
  document.getElementById('te-description').value = task?.description ?? '';
  document.getElementById('te-status').value = task?.status ?? 'open';
  document.getElementById('te-assignee').value = task?.assignee ?? '';
  document.getElementById('te-tags').value = (task?.tags ?? []).join(',');
  document.getElementById('te-priority').value = task?.priority ?? '';
  document.getElementById('te-comment').value = '';
  document.getElementById('te-delete').style.display = taskId ? '' : 'none';
  const activityEl = document.getElementById('te-activity');
  if (task && task.activity?.length) {
    activityEl.innerHTML = task.activity.map(a => {
      const time = new Date(a.at).toLocaleString();
      let line = `${time} · ${esc(a.by)} · ${esc(a.kind)}`;
      if (a.from !== undefined || a.to !== undefined) line += `: ${esc(a.from ?? '∅')} → ${esc(a.to ?? '∅')}`;
      if (a.text) line += `: ${esc(a.text)}`;
      return `<div>${line}</div>`;
    }).join('');
  } else {
    activityEl.innerHTML = '';
  }
  openModal('task-edit-modal');
}

document.getElementById('te-save').addEventListener('click', async () => {
  const body = {
    title: document.getElementById('te-title-input').value.trim(),
    description: document.getElementById('te-description').value,
    status: document.getElementById('te-status').value,
    assignee: document.getElementById('te-assignee').value.trim() || undefined,
    tags: document.getElementById('te-tags').value.split(',').map(s => s.trim()).filter(Boolean),
    priority: document.getElementById('te-priority').value || undefined,
  };
  if (!body.title) { alert('Title required'); return; }
  if (_editingTaskId) {
    await apiFetch(`/api/hub/tasks/${_editingTaskId}`, { method: 'PATCH', body: JSON.stringify(body) });
    const cmt = document.getElementById('te-comment').value.trim();
    if (cmt) {
      await apiFetch(`/api/hub/tasks/${_editingTaskId}/comments`, { method: 'POST', body: JSON.stringify({ text: cmt }) });
    }
  } else {
    await apiFetch(`/api/hub/channels/${activeChannelId}/tasks`, { method: 'POST', body: JSON.stringify(body) });
  }
  closeModal('task-edit-modal');
  loadChannelTasks(activeChannelId);
});

document.getElementById('te-delete').addEventListener('click', async () => {
  if (!_editingTaskId) return;
  if (!confirm('Delete this task?')) return;
  await apiFetch(`/api/hub/tasks/${_editingTaskId}`, { method: 'DELETE' });
  closeModal('task-edit-modal');
  loadChannelTasks(activeChannelId);
});

// ── Docs ─────────────────────────────────────────────────────────────────
async function loadChannelDocs(channelId) {
  const params = new URLSearchParams();
  const q = document.getElementById('hub-doc-search').value.trim();
  if (q) params.set('q', q);
  const qs = params.toString();
  const docs = await apiFetch(`/api/hub/channels/${channelId}/docs${qs ? `?${qs}` : ''}`);
  channelDocs[channelId] = Array.isArray(docs) ? docs : [];
  renderDocs();
}

function renderDocs() {
  const container = document.getElementById('hub-doc-list');
  const docs = channelDocs[activeChannelId] ?? [];
  if (docs.length === 0) {
    container.innerHTML = '<div class="empty-state"><div>No docs</div></div>';
    document.getElementById('hub-doc-body').innerHTML = '<div style="color:var(--muted);padding:16px">No docs yet.</div>';
    return;
  }
  container.innerHTML = docs.map(d => `
    <div class="doc-row${d.id === currentDocId ? ' active' : ''}${d.archived ? ' doc-archived' : ''}" data-doc-id="${esc(d.id)}">
      <div class="doc-row-title">${esc(d.title)}${d.archived ? ' <span style="color:var(--red);font-size:10px">[archived]</span>' : ''}</div>
      <div class="doc-row-meta">${esc(d.id)} · v${d.version} · ${esc(d.author)}</div>
    </div>
  `).join('');
  container.querySelectorAll('.doc-row').forEach(el => {
    el.addEventListener('click', () => showDoc(el.dataset.docId));
  });
  if (currentDocId && docs.find(d => d.id === currentDocId)) {
    showDoc(currentDocId);
  }
}

// ── Markdown rendering toggle ─────────────────────────────────────────────
let docRenderMd = (localStorage.getItem('banana_doc_md') ?? 'true') === 'true';

/** Lightweight markdown → HTML. Handles headers, bold, italic, code, links, lists, hrs, blockquotes. */
function renderMarkdown(src) {
  // Escape HTML first, then apply markdown transformations
  let html = esc(src);

  // Code blocks (``` ... ```) — must be before inline transforms
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) =>
    `<pre class="md-codeblock"><code>${code}</code></pre>`);

  // Split into lines for block-level processing
  const lines = html.split('\n');
  const out = [];
  let inList = false;
  let listType = '';

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Skip lines inside code blocks (already handled)
    if (line.includes('<pre class="md-codeblock">')) {
      // Collect until closing </pre>
      let block = line;
      while (!block.includes('</pre>') && i + 1 < lines.length) {
        i++;
        block += '\n' + lines[i];
      }
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push(block);
      continue;
    }

    // HR
    if (/^[-*_]{3,}\s*$/.test(line)) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push('<hr class="md-hr"/>');
      continue;
    }

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (hMatch) {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      const level = hMatch[1].length;
      out.push(`<h${level} class="md-h">${applyInline(hMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (line.startsWith('&gt; ') || line === '&gt;') {
      if (inList) { out.push(`</${listType}>`); inList = false; }
      out.push(`<blockquote class="md-bq">${applyInline(line.replace(/^&gt;\s?/, ''))}</blockquote>`);
      continue;
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[*\-+]\s+(.+)/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        if (inList) out.push(`</${listType}>`);
        out.push('<ul class="md-list">');
        inList = true;
        listType = 'ul';
      }
      out.push(`<li>${applyInline(ulMatch[2])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        if (inList) out.push(`</${listType}>`);
        out.push('<ol class="md-list">');
        inList = true;
        listType = 'ol';
      }
      out.push(`<li>${applyInline(olMatch[2])}</li>`);
      continue;
    }

    // Close list if not a list line
    if (inList) { out.push(`</${listType}>`); inList = false; }

    // Empty line → paragraph break
    if (line.trim() === '') {
      out.push('<br/>');
      continue;
    }

    // Normal paragraph
    out.push(`<p class="md-p">${applyInline(line)}</p>`);
  }
  if (inList) out.push(`</${listType}>`);
  return out.join('\n');
}

/** Apply inline markdown: bold, italic, code, links, strikethrough. */
function applyInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

async function showDoc(docId) {
  currentDocId = docId;
  const chParam = activeChannelId ? `?channelId=${encodeURIComponent(activeChannelId)}` : '';
  const doc = await apiFetch(`/api/hub/docs/${docId}${chParam}`);
  const bodyEl = document.getElementById('hub-doc-body');
  const archivedBadge = doc.archived
    ? `<span style="background:var(--red);color:#000;padding:1px 5px;border-radius:3px;font-size:10px;margin-left:6px">ARCHIVED</span>` : '';
  const restoreBtn = doc.archived
    ? `<button class="btn btn-sm" id="hub-doc-restore-btn" style="background:var(--green);color:#000">Restore</button>` : '';
  const mdToggleLabel = docRenderMd ? 'Raw' : 'Rendered';
  const bodyHtml = docRenderMd
    ? `<div class="md-body">${renderMarkdown(doc.body)}</div>`
    : `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:12px">${esc(doc.body)}</pre>`;
  bodyEl.innerHTML = `
    <div style="margin-bottom:12px">
      <div style="font-size:14px;font-weight:600">${esc(doc.title)}${archivedBadge}</div>
      <div style="font-size:11px;color:var(--muted)">${esc(doc.id)} · v${doc.version} · ${esc(doc.author)} · ${new Date(doc.updatedAt).toLocaleString()}</div>
      <div style="margin-top:6px;display:flex;gap:6px">
        <button class="btn btn-sm" id="hub-doc-edit-btn">Edit</button>
        <button class="btn btn-sm" id="hub-doc-md-toggle" style="background:var(--surface);color:var(--text);border:1px solid var(--border)">${mdToggleLabel}</button>
        <button class="btn btn-sm" id="hub-doc-history-btn" style="background:var(--surface);color:var(--text);border:1px solid var(--border)">History (v${doc.version})</button>
        ${restoreBtn}
      </div>
    </div>
    ${bodyHtml}
  `;
  document.getElementById('hub-doc-edit-btn').addEventListener('click', () => openDocModal(docId));
  document.getElementById('hub-doc-md-toggle').addEventListener('click', () => {
    docRenderMd = !docRenderMd;
    localStorage.setItem('banana_doc_md', String(docRenderMd));
    showDoc(docId);
  });
  document.getElementById('hub-doc-history-btn').addEventListener('click', () => showDocHistory(docId));
  document.getElementById('hub-doc-restore-btn')?.addEventListener('click', async () => {
    const chP = activeChannelId ? `?channelId=${encodeURIComponent(activeChannelId)}` : '';
    await apiFetch(`/api/hub/docs/${docId}/restore${chP}`, { method: 'POST' });
    loadChannelDocs(activeChannelId);
    showDoc(docId);
  });
  // Re-render list to update active highlight
  document.querySelectorAll('.doc-row').forEach(el => {
    el.classList.toggle('active', el.dataset.docId === docId);
  });
}

async function showDocHistory(docId) {
  const chParam2 = activeChannelId ? `?channelId=${encodeURIComponent(activeChannelId)}` : '';
  const history = await apiFetch(`/api/hub/docs/${docId}/history${chParam2}`);
  const doc = await apiFetch(`/api/hub/docs/${docId}${chParam2}`);
  const bodyEl = document.getElementById('hub-doc-body');
  if (!Array.isArray(history) || history.length === 0) {
    bodyEl.innerHTML = `
      <div style="margin-bottom:8px"><button class="btn btn-sm doc-back-btn">Back</button> <b>${esc(doc.title)}</b> — Version History</div>
      <div style="color:var(--muted);padding:20px;text-align:center">No prior versions</div>
    `;
    bodyEl.querySelector('.doc-back-btn').addEventListener('click', () => showDoc(docId));
    return;
  }
  // Show current version + all history versions, newest first
  const versions = [
    { version: doc.version, at: doc.updatedAt, by: doc.author, body: doc.body, current: true },
    ...history.slice().reverse(),
  ];
  bodyEl.innerHTML = `
    <div style="margin-bottom:8px"><button class="btn btn-sm doc-back-btn">Back</button> <b>${esc(doc.title)}</b> — Version History (${versions.length} versions)</div>
    <div class="doc-history-list">
      ${versions.map(v => `
        <div class="doc-history-entry" data-version="${v.version}">
          <div class="doc-history-header">
            <span style="font-weight:600">v${v.version}${v.current ? ' (current)' : ''}</span>
            <span style="color:var(--muted);font-size:11px">${esc(v.by)} · ${new Date(v.at).toLocaleString()}</span>
          </div>
          <pre class="doc-history-body">${esc(v.body)}</pre>
        </div>
      `).join('')}
    </div>
  `;
  bodyEl.querySelector('.doc-back-btn').addEventListener('click', () => showDoc(docId));
}

document.getElementById('hub-doc-search').addEventListener('input', debounce(() => {
  if (activeChannelId) loadChannelDocs(activeChannelId);
}, 300));

document.getElementById('hub-new-doc-btn').addEventListener('click', () => {
  if (!activeChannelId) { alert('Select a channel first'); return; }
  openDocModal(null);
});

let _editingDocId = null;
async function openDocModal(docId) {
  _editingDocId = docId;
  let doc = null;
  if (docId) {
    const chP3 = activeChannelId ? `?channelId=${encodeURIComponent(activeChannelId)}` : '';
    doc = await apiFetch(`/api/hub/docs/${docId}${chP3}`);
    document.getElementById('de-title').textContent = `${doc.id} v${doc.version}`;
    document.getElementById('de-version').textContent = `Version ${doc.version} — saving will create v${doc.version + 1}`;
  } else {
    document.getElementById('de-title').textContent = 'New Doc';
    document.getElementById('de-version').textContent = '';
  }
  document.getElementById('de-title-input').value = doc?.title ?? '';
  document.getElementById('de-tags').value = (doc?.tags ?? []).join(',');
  document.getElementById('de-body').value = doc?.body ?? '';
  document.getElementById('de-delete').style.display = docId ? '' : 'none';
  openModal('doc-edit-modal');
}

document.getElementById('de-save').addEventListener('click', async () => {
  const title = document.getElementById('de-title-input').value.trim();
  const body = document.getElementById('de-body').value;
  const tags = document.getElementById('de-tags').value.split(',').map(s => s.trim()).filter(Boolean);
  if (!title) { alert('Title required'); return; }
  if (_editingDocId) {
    const chP4 = activeChannelId ? `?channelId=${encodeURIComponent(activeChannelId)}` : '';
    await apiFetch(`/api/hub/docs/${_editingDocId}${chP4}`, {
      method: 'PATCH',
      body: JSON.stringify({ title, body, tags }),
    });
  } else {
    await apiFetch(`/api/hub/channels/${activeChannelId}/docs`, {
      method: 'POST',
      body: JSON.stringify({ title, body, tags }),
    });
  }
  closeModal('doc-edit-modal');
  loadChannelDocs(activeChannelId);
});

document.getElementById('de-delete').addEventListener('click', async () => {
  if (!_editingDocId) return;
  if (!confirm('Delete this doc?')) return;
  const chP5 = activeChannelId ? `?channelId=${encodeURIComponent(activeChannelId)}` : '';
  await apiFetch(`/api/hub/docs/${_editingDocId}${chP5}`, { method: 'DELETE' });
  closeModal('doc-edit-modal');
  if (currentDocId === _editingDocId) currentDocId = null;
  loadChannelDocs(activeChannelId);
});

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

document.getElementById('hub-post-btn').addEventListener('click', hubPost);
document.getElementById('hub-content-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') { e.preventDefault(); hubPost(); }
});

async function hubPost() {
  const content = document.getElementById('hub-content-input').value.trim();
  if (!content || !activeChannelId) return;
  const tags = document.getElementById('hub-tags-input').value.split(',').map(s => s.trim()).filter(Boolean);
  const mentions = document.getElementById('hub-mentions-input').value.split(',').map(s => s.trim().replace(/^@/, '')).filter(Boolean);
  document.getElementById('hub-content-input').value = '';
  document.getElementById('hub-tags-input').value = '';
  document.getElementById('hub-mentions-input').value = '';
  await apiFetch('/api/hub/messages', {
    method: 'POST',
    body: JSON.stringify({ channelIds: [activeChannelId], content, tags, mentions }),
  });
}

document.getElementById('hub-new-channel-btn').addEventListener('click', () => openModal('new-channel-modal'));

document.getElementById('nc-create').addEventListener('click', async () => {
  const id = document.getElementById('nc-id').value.trim();
  const name = document.getElementById('nc-name').value.trim();
  const desc = document.getElementById('nc-desc').value.trim();
  if (!id || !name) return;
  await apiFetch('/api/hub/channels', {
    method: 'POST',
    body: JSON.stringify({ id, name, description: desc || undefined }),
  });
  closeModal('new-channel-modal');
  await loadHubChannels();
  selectHubChannel(id);
});

// ── Edit Channel Modal ────────────────────────────────────────────────────────

function openEditChannelModal(channelId) {
  const ch = hubChannels.find(c => c.id === channelId);
  if (!ch) return;
  document.getElementById('ec-id').value = ch.id;
  document.getElementById('ec-id-display').textContent = ch.id;
  document.getElementById('ec-name').value = ch.name;
  document.getElementById('ec-desc').value = ch.description || '';
  openModal('edit-channel-modal');
}

document.getElementById('ec-save').addEventListener('click', async () => {
  const id = document.getElementById('ec-id').value;
  const name = document.getElementById('ec-name').value.trim();
  const description = document.getElementById('ec-desc').value.trim();
  if (!name) return;
  await apiFetch(`/api/hub/channels/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name, description }),
  });
  closeModal('edit-channel-modal');
  await loadHubChannels();
  if (activeChannelId === id) {
    document.getElementById('hub-channel-title').textContent = name;
  }
});

document.getElementById('ec-archive').addEventListener('click', async () => {
  const id = document.getElementById('ec-id').value;
  const ch = hubChannels.find(c => c.id === id);
  if (!confirm(`Archive channel "${ch?.name || id}"? It can be restored later.`)) return;
  await apiFetch(`/api/hub/channels/${id}`, { method: 'DELETE' });
  closeModal('edit-channel-modal');
  if (activeChannelId === id) activeChannelId = null;
  await loadHubChannels();
});

document.getElementById('hub-archived-toggle').addEventListener('change', () => renderHubChannels());

// ── Inline Session Rename ─────────────────────────────────────────────────────
contentTitle.addEventListener('click', () => {
  if (!activeSessionId) return;
  const s = sessions[activeSessionId];
  const currentName = s?.name || '';

  const input = document.createElement('input');
  input.className = 'rename-input';
  input.value = currentName;
  input.placeholder = 'Session name';

  contentTitle.textContent = '';
  contentTitle.appendChild(input);
  input.focus();
  input.select();

  async function save() {
    const newName = input.value.trim();
    contentTitle.textContent = buildContentTitle(s, activeSessionId);

    if (newName !== currentName) {
      await apiFetch(`/api/sessions/${activeSessionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: newName }),
      });
      if (sessions[activeSessionId]) sessions[activeSessionId].name = newName;
      contentTitle.textContent = buildContentTitle(sessions[activeSessionId], activeSessionId);
      renderSidebar();
    }
  }

  input.addEventListener('blur', save, { once: true });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = currentName; input.blur(); }
  });
});
