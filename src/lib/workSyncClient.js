import { applySyncOperations, diffSyncDocument, rebaseSyncDocument, WORK_SYNC_INTERVAL } from './workSyncDocument.js';

const PREFIX = '/__atlas/work-sync';

// One client per browser tab. The adapter is intentionally independent of React
// so delayed replies, lease expiry and retries can be exercised without a UI.
export class WorkSyncClient {
  constructor({ adapter, onChange = () => {}, request = globalThis.fetch.bind(globalThis),
    openSocket = globalThis.location ? (path) => {
      const url = new URL(path, globalThis.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return new WebSocket(url);
    } : null }) {
    this.adapter = adapter; this.onChange = onChange; this.request = request;
    this.openSocket = openSocket; this.listenLocal = false; this.projectSignature = null;
    this.token = null; this.context = null; this.epoch = 0; this.running = false; this.timer = null;
    this.working = false; this.preparing = false; this.controllers = new Set();
    this.blockedLinks = new Set(); this.disconnecting = false; this.statusVersion = -1;
    this.state = { role: 'peer', phase: 'starting', requests: [], pending: false, link: null, error: '', lastSync: null };
  }
  emit(changes = {}) {
    this.state = { ...this.state, ...changes };
    if (this.running) this.onChange(this.state);
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.emit({ phase: 'starting', link: null, pending: false, requests: [], deciding: false, error: '', reason: '', lastSync: null });
    const epoch = this.epoch;
    // Remote browsers only discover their role once. No registration, polling
    // or project reads occur until the user presses Synchronize.
    this.starting = this.api('/capabilities', { method: 'GET' }).then(async ({ local }) => {
      if (!this.valid(epoch)) return;
      this.listenLocal = local;
      this.emit({ phase: 'idle', error: '' });
      if (local) { await this.tick(); await this.projectChanged(); this.updateActivity(); }
    }).catch((error) => { if (this.valid(epoch)) this.emit({ phase: 'idle', error: error.message }); });
  }
  stop() {
    this.running = false; this.epoch += 1;
    clearInterval(this.timer); clearTimeout(this.expiration);
    this.timer = null; this.closeEvents();
    for (const controller of this.controllers) controller.abort();
    if (this.token) this.request(`${PREFIX}/leave`, { method: 'POST', keepalive: true,
      headers: { Authorization: `Bearer ${this.token}` } }).catch(() => {});
    this.token = null; this.context = null; this.statusVersion = -1;
    this.working = false; this.preparing = false;
  }
  closeEvents() {
    clearTimeout(this.reconnect);
    const socket = this.events; this.events = null;
    socket?.close();
  }
  updateActivity() {
    const linked = this.running && this.state.link?.expiresAt > Date.now();
    if (linked && !this.timer) this.timer = setInterval(() => this.tick(), WORK_SYNC_INTERVAL);
    if (!linked) { clearInterval(this.timer); this.timer = null; }
    const listening = this.running && (this.listenLocal || this.state.pending || linked);
    if (!listening) { this.closeEvents(); return; }
    if (!this.token || !this.openSocket || this.events) return;
    const socket = this.openSocket(`${PREFIX}/events?token=${encodeURIComponent(this.token)}`);
    this.events = socket;
    socket.onmessage = ({ data }) => {
      if (this.events !== socket || !this.running) return;
      try {
        this.acceptStatus({ ...JSON.parse(data), clientStartedAt: Date.now() });
        if (this.state.role === 'peer' && this.state.link?.ready && !this.context) this.tick();
      } catch { /* Ignore malformed notifications; HTTP remains authoritative. */ }
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (this.events !== socket) return;
      this.events = null;
      // Reconnect only after a failed notification connection, not as an idle
      // polling loop. This channel carries authorization/status, never poses.
      this.reconnect = setTimeout(async () => {
        if (!this.running || !(this.listenLocal || this.state.pending || this.state.link)) return;
        await this.tick();
        if (this.listenLocal && !this.token) await this.tick();
        this.updateActivity();
      }, 30_000);
    };
  }
  async projectChanged() {
    if (!this.running || !this.listenLocal || !this.token) return;
    const project = this.adapter.project();
    const signature = JSON.stringify(project);
    if (signature === this.projectSignature) return;
    this.projectSignature = signature;
    const epoch = this.epoch;
    try {
      const result = await this.api('/status', { data: { project } });
      if (this.valid(epoch)) this.acceptStatus(result);
    } catch (error) {
      this.projectSignature = null;
      if (this.valid(epoch)) this.emit({ error: error.message });
    }
  }
  async api(route, { method = 'POST', data = {}, binary, download = false } = {}) {
    const clientStartedAt = Date.now();
    const controller = new AbortController(); this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), download || binary ? 240_000 : 30_000);
    try {
      const response = await this.request(`${PREFIX}${route}`, { method, signal: controller.signal,
        headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(method !== 'GET' ? { 'Content-Type': binary ? 'application/zip' : 'application/json' } : {}) },
        ...(method !== 'GET' ? { body: binary || JSON.stringify(data) } : {}) });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw Object.assign(new Error(payload.error || `同步请求失败（${response.status}）`), { status: response.status });
      }
      return download ? new Uint8Array(await response.arrayBuffer()) : { ...await response.json(), clientStartedAt };
    } finally { clearTimeout(timer); this.controllers.delete(controller); }
  }
  valid(epoch) { return this.running && this.epoch === epoch; }
  active(context, epoch) {
    return this.valid(epoch) && this.context === context && this.state.link?.id === context.id
      && this.state.link.expiresAt > Date.now();
  }
  acceptStatus(result) {
    // A heartbeat started before approval must not undo a newer approval reply.
    if (result.statusVersion < this.statusVersion) return;
    this.statusVersion = result.statusVersion;
    const { token, document, operations, revision, clientStartedAt, ...status } = result;
    if (status.link && this.blockedLinks.has(status.link.id)) status.link = null;
    if (status.link && Number.isFinite(status.serverTime)) status.link = { ...status.link,
      expiresAt: (clientStartedAt || Date.now()) + Math.max(0, status.link.expiresAt - status.serverTime) };
    if (this.context && status.link?.id !== this.context.id) this.context = null;
    clearTimeout(this.expiration);
    this.emit({ ...status, phase: status.link ? (this.context ? 'connected' : 'preparing') : status.pending ? 'pending' : 'idle', error: '' });
    if (status.link) {
      const id = status.link.id;
      this.expiration = setTimeout(() => {
        if (this.state.link?.id === id) this.disconnect('授权已到期，请重新申请');
      }, Math.max(0, status.link.expiresAt - Date.now()));
    }
    this.updateActivity();
  }
  async checkpoint(context) {
    await this.adapter.saveCheckpoint?.({ projectKey: context.projectKey, localIdentity: context.localIdentity, document: context.base });
  }
  async disconnect(message = '连接已断开，本地结果已保留') {
    const link = this.state.link;
    if (link) this.blockedLinks.add(link.id);
    this.disconnecting = true;
    this.epoch += 1; this.context = null; this.preparing = false;
    clearTimeout(this.expiration);
    for (const controller of this.controllers) controller.abort();
    this.emit({ link: null, pending: false, phase: 'idle', reason: message, error: '', requests: [] });
    this.updateActivity();
    await Promise.allSettled([this.adapter.persist?.(), link ? this.api(`/links/${link.id}/disconnect`) : undefined]);
    this.disconnecting = false;
  }
  async requestAuthorization() {
    if (this.disconnecting) return;
    await this.starting;
    if (!this.token) { await this.tick(); if (!this.token) return; }
    const epoch = this.epoch;
    try {
      const result = await this.api('/requests');
      if (this.valid(epoch)) this.acceptStatus(result);
    } catch (error) { if (this.valid(epoch)) this.emit({ error: error.message }); }
  }
  async decide(requestId, allow) {
    if (this.preparing) return;
    const epoch = this.epoch;
    this.preparing = true; this.emit({ deciding: true, error: '' });
    try {
      if (!allow || this.state.link) {
        const result = await this.api('/decision', { data: { requestId, allow } });
        if (this.valid(epoch)) this.acceptStatus(result);
        return;
      }
      const initial = await this.adapter.buildInitial((progress) => this.emit({ progress }));
      if (!this.valid(epoch)) return;
      if (this.adapter.identity() !== initial.localIdentity) throw new Error('工程已变化，请重新申请同步');
      const result = await this.api('/decision', { data: { requestId, allow: true, document: initial.document } });
      if (!this.valid(epoch)) return;
      this.context = { id: result.link.id, projectKey: result.link.project.key, localIdentity: initial.localIdentity,
        base: initial.document, revision: 0, sequence: 0, flight: null };
      this.acceptStatus(result);
      const uploaded = await this.api(`/links/${result.link.id}/bundle`, { method: 'PUT', binary: initial.bytes });
      if (this.valid(epoch)) { this.acceptStatus(uploaded); if (this.context) await this.checkpoint(this.context); }
    } catch (error) {
      if (this.valid(epoch)) {
        if (this.context) await this.disconnect('初始工程传输未完成，可重新申请');
        this.emit({ error: error.message });
      }
    } finally {
      this.preparing = false; this.emit({ deciding: false, progress: null });
    }
  }
  async initialize(link, epoch) {
    this.emit({ phase: 'receiving' });
    const initial = await this.api(`/links/${link.id}/bootstrap`, { method: 'GET' });
    if (!this.valid(epoch)) return;
    const previous = await this.adapter.loadCheckpoint?.(link.project.key);
    if (!this.valid(epoch)) return;
    if (previous?.projectKey === link.project.key && previous.localIdentity === this.adapter.identity()) {
      const merged = rebaseSyncDocument(initial.document, previous.document, this.adapter.readDocument());
      this.adapter.applyDocument(merged);
    } else {
      const bytes = await this.api(`/links/${link.id}/bundle`, { method: 'GET', download: true });
      if (!this.valid(epoch) || link.expiresAt <= Date.now()) return;
      await this.adapter.installInitial(bytes, link.project, () => this.valid(epoch) && link.expiresAt > Date.now());
      if (!this.valid(epoch)) return;
    }
    this.context = { id: link.id, projectKey: link.project.key, localIdentity: this.adapter.identity(),
      base: initial.document, revision: 0, sequence: 0, flight: null };
    this.emit({ phase: 'connected' });
    await this.checkpoint(this.context);
  }
  async exchange(context, epoch) {
    if (this.adapter.identity() !== context.localIdentity) { await this.disconnect('当前工程已切换，同步已断开'); return; }
    if (!this.adapter.ready()) return;
    // Keep the same sequence and payload when a response is lost. Edits made
    // during a retry remain local and are sent in the next exchange.
    context.flight ||= { sequence: ++context.sequence, since: context.revision,
      sent: this.adapter.readDocument() };
    const flight = context.flight;
    const result = await this.api(`/links/${context.id}/exchange`, { data: {
      sequence: flight.sequence, since: flight.since, operations: diffSyncDocument(context.base, flight.sent),
    } });
    if (!this.active(context, epoch)) return;
    if (this.adapter.identity() !== context.localIdentity) { await this.disconnect('当前工程已切换，同步已断开'); return; }
    const remote = result.document || applySyncOperations(context.base, result.operations);
    const local = this.adapter.readDocument();
    const merged = rebaseSyncDocument(remote, flight.sent, local);
    if (diffSyncDocument(local, merged).length) this.adapter.applyDocument(merged);
    const changed = context.revision !== result.revision;
    context.base = remote; context.revision = result.revision; context.flight = null;
    this.acceptStatus(result); this.emit({ lastSync: Date.now() });
    if (changed) await this.checkpoint(context);
  }
  async tick() {
    if (!this.running || this.working || this.disconnecting) return;
    this.working = true;
    const epoch = this.epoch;
    try {
      if (!this.token) {
        const project = this.adapter.project();
        const result = await this.api('/clients', { data: { name: this.adapter.deviceName, project } });
        if (!this.valid(epoch)) {
          this.request(`${PREFIX}/leave`, { method: 'POST', headers: { Authorization: `Bearer ${result.token}` } }).catch(() => {});
          return;
        }
        this.token = result.token; this.projectSignature = JSON.stringify(project); this.acceptStatus(result);
      } else {
        const result = await this.api('/status', { data: { project: this.adapter.project() } });
        if (!this.valid(epoch)) return;
        if (result.link && this.blockedLinks.has(result.link.id)) {
          await this.api(`/links/${result.link.id}/disconnect`);
          if (!this.valid(epoch)) return;
        }
        this.acceptStatus(result);
      }
      if (this.preparing) return;
      const link = this.state.link;
      if (!link) return;
      if (!this.context && this.state.role === 'peer' && link.ready && this.adapter.ready()) await this.initialize(link, epoch);
      if (this.context && this.active(this.context, epoch)) await this.exchange(this.context, epoch);
    } catch (error) {
      if (this.valid(epoch)) {
        if (error.status === 401) {
          this.closeEvents(); this.token = null; this.statusVersion = -1;
          await this.disconnect('同步会话已重置，可重新申请');
        }
        else if (error.status === 403) await this.disconnect('授权已到期或连接已断开');
        this.emit({ error: error.name === 'AbortError' ? '通讯暂时中断，正在重试，本地结果已保留' : error.message });
      }
    } finally { this.working = false; }
  }
}
