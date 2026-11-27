/**
 * GTP-U TEID 生命周期验证器（纯模拟，不产生任何真实网络报文）。
 *
 * 输入事件流（每个事件带时间片 t）：
 *   endpoint.add    { nodeId, address }
 *   session.create  { sessionId, nodeId, bearerId, teid? }
 *   bearer.update   { sessionId, bearerId, state }
 *   echo.request    { nodeId }
 *   echo.response   { nodeId }
 *   echo.loss       { nodeId }
 *   path.switch     { sessionId, bearerId, fromNodeId, toNodeId, teid? }
 *   session.migrate { sessionId, fromNodeId, toNodeId }
 *   teid.release    { nodeId, teid, sessionId, bearerId }
 *   packet          { nodeId, teid, forSessionId, forBearerId }
 *
 * 输出：
 *   mappingAt(t)     每个时间片的有效 TEID 映射
 *   conflicts()      冲突隧道（同一 TEID 在不同节点同时指向不同承载）
 *   misdeliveries()  误投报文
 *   cleanupOrder()   清理顺序
 */
const CLEANUP_PRIORITY = {
  'stop-forward': 0,
  release: 1,
  'await-echo': 2,
  'reuse-allowed': 3,
  'defer-reuse': 4,
};

class NodeState {
  constructor(nodeId, address) {
    this.nodeId = nodeId;
    this.address = address;
    /** teid -> binding */
    this.bindings = new Map();
    this.nextTeid = 1;
    /** 已释放、可重用的 TEID 池（FIFO） */
    this.releasedPool = [];
    this.echoOutstanding = 0;
    this.echoLost = false;
    /** echo 丢失期间被推迟的释放事件 */
    this.deferredReleases = [];
  }

  allocateTeid(preferred) {
    if (preferred !== undefined && !this.bindings.has(preferred)) {
      return preferred;
    }
    while (this.releasedPool.length > 0) {
      const candidate = this.releasedPool.shift();
      if (!this.bindings.has(candidate)) return candidate;
    }
    while (this.bindings.has(this.nextTeid)) this.nextTeid += 1;
    return this.nextTeid++;
  }
}

export class TeidLifecycle {
  constructor() {
    this.nodes = new Map();
    /** sessionId -> { bearers: Map<bearerId, {nodeId, teid, state}> } */
    this.sessions = new Map();
    /** t -> snapshot (Map nodeId -> Map teid -> {sessionId, bearerId, state}) */
    this.history = new Map();
    this.lastTick = 0;
    this._conflicts = [];
    this._openConflicts = new Map();
    this._misdeliveries = [];
    this._cleanup = [];
    this._releaseRaces = [];
    this._orphanReleases = [];
  }

  apply(event) {
    const t = event.t ?? this.lastTick;
    this.lastTick = Math.max(this.lastTick, t);
    switch (event.type) {
      case 'endpoint.add':
        this._addEndpoint(event);
        break;
      case 'session.create':
        this._createSession(event, t);
        break;
      case 'bearer.update':
        this._updateBearer(event);
        break;
      case 'echo.request':
        this._node(event.nodeId).echoOutstanding += 1;
        break;
      case 'echo.response':
        this._echoResponse(event, t);
        break;
      case 'echo.loss':
        this._echoLoss(event, t);
        break;
      case 'path.switch':
        this._pathSwitch(event, t);
        break;
      case 'session.migrate':
        this._migrateSession(event, t);
        break;
      case 'teid.release':
        this._release(event, t);
        break;
      case 'packet':
        this._deliver(event, t);
        break;
      default:
        throw new Error(`unknown event type: ${event.type}`);
    }
    this._detectConflicts(t);
    this._snapshot(t);
    return this;
  }

  applyAll(events) {
    for (const event of events) this.apply(event);
    return this;
  }

  _addEndpoint({ nodeId, address }) {
    if (!this.nodes.has(nodeId)) {
      this.nodes.set(nodeId, new NodeState(nodeId, address));
    }
  }

  _node(nodeId) {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`unknown node: ${nodeId}`);
    return node;
  }

  _bind(node, teid, sessionId, bearerId, t) {
    const binding = {
      teid,
      sessionId,
      bearerId,
      state: 'active',
      generation: (node.lastGeneration ?? 0) + 1,
      allocatedAt: t,
    };
    node.lastGeneration = binding.generation;
    node.bindings.set(teid, binding);
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = { bearers: new Map() };
      this.sessions.set(sessionId, session);
    }
    session.bearers.set(bearerId, { nodeId: node.nodeId, teid, state: 'active' });
    return binding;
  }

  _createSession({ sessionId, nodeId, bearerId, teid }, t) {
    const node = this._node(nodeId);
    const assigned = node.allocateTeid(teid);
    this._bind(node, assigned, sessionId, bearerId, t);
    return assigned;
  }

  _updateBearer({ sessionId, bearerId, state }) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const bearer = session.bearers.get(bearerId);
    if (!bearer) throw new Error(`unknown bearer: ${bearerId}`);
    bearer.state = state;
    const node = this.nodes.get(bearer.nodeId);
    const binding = node?.bindings.get(bearer.teid);
    if (binding && binding.sessionId === sessionId && binding.bearerId === bearerId) {
      binding.state = state;
    }
  }

  _echoResponse({ nodeId }, t) {
    const node = this._node(nodeId);
    node.echoOutstanding = Math.max(0, node.echoOutstanding - 1);
    if (node.echoLost && node.echoOutstanding === 0) {
      node.echoLost = false;
      const pending = node.deferredReleases.splice(0);
      for (const release of pending) this._release(release, t);
    }
  }

  _echoLoss({ nodeId }, t) {
    const node = this._node(nodeId);
    node.echoLost = true;
    node.echoOutstanding += 1;
    this._cleanup.push({ t, action: 'await-echo', nodeId });
  }

  _pathSwitch({ sessionId, bearerId, fromNodeId, toNodeId, teid }, t) {
    const from = this._node(fromNodeId);
    const to = this._node(toNodeId);
    const poolBefore = new Set(to.releasedPool);
    const newTeid = to.allocateTeid(teid);
    // echo 丢失期间从释放池复用 TEID：对端无法确认旧绑定已清理，复用必须推迟确认
    const reusedWhileEchoLost = to.echoLost && poolBefore.has(newTeid);
    this._bind(to, newTeid, sessionId, bearerId, t);
    for (const binding of from.bindings.values()) {
      if (binding.sessionId === sessionId && binding.bearerId === bearerId) {
        binding.state = 'stale';
        this._cleanup.push({
          t,
          action: 'stop-forward',
          nodeId: fromNodeId,
          teid: binding.teid,
          sessionId,
          bearerId,
        });
      }
    }
    if (reusedWhileEchoLost) {
      this._cleanup.push({ t, action: 'defer-reuse', nodeId: toNodeId, teid: newTeid });
    }
    return newTeid;
  }

  _migrateSession({ sessionId, fromNodeId, toNodeId }, t) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`unknown session: ${sessionId}`);
    const from = this._node(fromNodeId);
    const to = this._node(toNodeId);
    for (const [bearerId, bearer] of session.bearers) {
      if (bearer.nodeId !== fromNodeId) continue;
      const oldBinding = from.bindings.get(bearer.teid);
      if (oldBinding) oldBinding.state = 'stale';
      const newTeid = to.allocateTeid(undefined);
      this._bind(to, newTeid, sessionId, bearerId, t);
      this._cleanup.push({
        t,
        action: 'stop-forward',
        nodeId: fromNodeId,
        teid: bearer.teid,
        sessionId,
        bearerId,
      });
    }
  }

  _release({ nodeId, teid, sessionId, bearerId }, t) {
    const node = this._node(nodeId);
    if (node.echoLost) {
      node.deferredReleases.push({ nodeId, teid, sessionId, bearerId });
      return;
    }
    const binding = node.bindings.get(teid);
    if (!binding) {
      this._orphanReleases.push({ t, nodeId, teid, sessionId, bearerId });
      return;
    }
    if (binding.sessionId !== sessionId || binding.bearerId !== bearerId) {
      this._releaseRaces.push({
        t,
        nodeId,
        teid,
        stale: { sessionId, bearerId },
        current: { sessionId: binding.sessionId, bearerId: binding.bearerId },
      });
      return;
    }
    node.bindings.delete(teid);
    node.releasedPool.push(teid);
    this._cleanup.push({ t, action: 'release', nodeId, teid, sessionId, bearerId });
    this._cleanup.push({ t, action: 'reuse-allowed', nodeId, teid });
    const session = this.sessions.get(sessionId);
    const bearer = session?.bearers.get(bearerId);
    if (bearer && bearer.nodeId === nodeId && bearer.teid === teid) {
      bearer.state = 'released';
    }
  }

  _deliver({ nodeId, teid, forSessionId, forBearerId }, t) {
    const node = this._node(nodeId);
    const binding = node.bindings.get(teid);
    if (!binding) {
      this._misdeliveries.push({
        t,
        nodeId,
        teid,
        intended: { sessionId: forSessionId, bearerId: forBearerId },
        reason: 'no-binding',
      });
      return;
    }
    if (binding.sessionId !== forSessionId || binding.bearerId !== forBearerId) {
      this._misdeliveries.push({
        t,
        nodeId,
        teid,
        intended: { sessionId: forSessionId, bearerId: forBearerId },
        actual: { sessionId: binding.sessionId, bearerId: binding.bearerId },
        reason: binding.state === 'stale' ? 'stale-binding' : 'wrong-bearer',
      });
    }
  }

  _detectConflicts(t) {
    const byTeid = new Map();
    for (const node of this.nodes.values()) {
      for (const binding of node.bindings.values()) {
        if (binding.state === 'released') continue;
        let list = byTeid.get(binding.teid);
        if (!list) byTeid.set(binding.teid, (list = []));
        list.push({ nodeId: node.nodeId, binding });
      }
    }
    const seen = new Set();
    for (const [teid, entries] of byTeid) {
      for (let i = 0; i < entries.length; i += 1) {
        for (let j = i + 1; j < entries.length; j += 1) {
          const a = entries[i];
          const b = entries[j];
          if (a.nodeId === b.nodeId) continue;
          const key = `${teid}|${a.nodeId}|${b.nodeId}|${a.binding.bearerId}|${b.binding.bearerId}`;
          seen.add(key);
          if (!this._openConflicts.has(key)) {
            const conflict = {
              teid,
              tunnels: [
                { nodeId: a.nodeId, sessionId: a.binding.sessionId, bearerId: a.binding.bearerId },
                { nodeId: b.nodeId, sessionId: b.binding.sessionId, bearerId: b.binding.bearerId },
              ],
              from: t,
              to: null,
            };
            this._openConflicts.set(key, conflict);
            this._conflicts.push(conflict);
          }
        }
      }
    }
    for (const [key, conflict] of this._openConflicts) {
      if (!seen.has(key)) {
        conflict.to = t;
        this._openConflicts.delete(key);
      }
    }
  }

  _snapshot(t) {
    const snap = new Map();
    for (const node of this.nodes.values()) {
      const table = new Map();
      for (const [teid, binding] of node.bindings) {
        table.set(teid, {
          sessionId: binding.sessionId,
          bearerId: binding.bearerId,
          state: binding.state,
        });
      }
      snap.set(node.nodeId, table);
    }
    this.history.set(t, snap);
  }

  /** 时间片 t（取最近一个不晚于 t 的快照）的有效 TEID 映射 */
  mappingAt(t) {
    let best = null;
    for (const tick of this.history.keys()) {
      if (tick <= t && (best === null || tick > best)) best = tick;
    }
    if (best === null) return new Map();
    const snap = this.history.get(best);
    const out = new Map();
    for (const [nodeId, table] of snap) {
      out.set(nodeId, new Map([...table].map(([teid, b]) => [teid, { ...b }])));
    }
    return out;
  }

  conflicts() {
    return this._conflicts.map((c) => ({ ...c, tunnels: c.tunnels.map((x) => ({ ...x })) }));
  }

  misdeliveries() {
    return this._misdeliveries.map((m) => ({ ...m }));
  }

  releaseRaces() {
    return this._releaseRaces.map((r) => ({ ...r }));
  }

  orphanReleases() {
    return this._orphanReleases.map((r) => ({ ...r }));
  }

  /** 清理顺序：按时间片与动作优先级排序 */
  cleanupOrder() {
    return this._cleanup
      .map((c) => ({ ...c }))
      .sort(
        (a, b) =>
          a.t - b.t ||
          CLEANUP_PRIORITY[a.action] - CLEANUP_PRIORITY[b.action] ||
          String(a.nodeId).localeCompare(String(b.nodeId)) ||
          (a.teid ?? 0) - (b.teid ?? 0),
      );
  }
}
