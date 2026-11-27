import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TeidLifecycle } from '../src/teid-lifecycle.js';

test('TEID 重用：释放后的标识被新承载复用，迟到的旧报文被误投', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-1', address: '10.2.0.1' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-1', bearerId: 'b-1', teid: 7 },
    { t: 2, type: 'teid.release', nodeId: 'upf-1', teid: 7, sessionId: 'pdu-1', bearerId: 'b-1' },
    // 分配器从释放池复用 TEID 7 给新会话
    { t: 3, type: 'session.create', sessionId: 'pdu-2', nodeId: 'upf-1', bearerId: 'b-1' },
  ]);

  // t=3 时间片：TEID 7 已指向 pdu-2
  const mapping = sim.mappingAt(3).get('upf-1');
  assert.equal(mapping.get(7).sessionId, 'pdu-2');

  // 旧会话迟到的报文命中复用后的 TEID，被误投到 pdu-2
  sim.apply({ t: 4, type: 'packet', nodeId: 'upf-1', teid: 7, forSessionId: 'pdu-1', forBearerId: 'b-1' });
  const mis = sim.misdeliveries();
  assert.equal(mis.length, 1);
  assert.equal(mis[0].reason, 'wrong-bearer');
  assert.equal(mis[0].actual.sessionId, 'pdu-2');

  // 新会话自己的报文正常投递，不计入误投
  sim.apply({ t: 5, type: 'packet', nodeId: 'upf-1', teid: 7, forSessionId: 'pdu-2', forBearerId: 'b-1' });
  assert.equal(sim.misdeliveries().length, 1);
});

test('TEID 重用：释放到复用之间到达的报文因无绑定被丢弃', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-1', address: '10.2.0.1' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-1', bearerId: 'b-1', teid: 9 },
    { t: 2, type: 'teid.release', nodeId: 'upf-1', teid: 9, sessionId: 'pdu-1', bearerId: 'b-1' },
    { t: 3, type: 'packet', nodeId: 'upf-1', teid: 9, forSessionId: 'pdu-1', forBearerId: 'b-1' },
  ]);
  const mis = sim.misdeliveries();
  assert.equal(mis.length, 1);
  assert.equal(mis[0].reason, 'no-binding');
});

test('TEID 重用：echo 丢失期间在新节点复用相同标识会记录 defer-reuse', () => {
  const sim = new TeidLifecycle();
  sim.applyAll([
    { t: 0, type: 'endpoint.add', nodeId: 'upf-old', address: '10.2.1.1' },
    { t: 0, type: 'endpoint.add', nodeId: 'upf-new', address: '10.2.1.2' },
    { t: 1, type: 'session.create', sessionId: 'pdu-1', nodeId: 'upf-old', bearerId: 'b-1', teid: 50 },
    // 新节点曾持有 TEID 60，释放后进入可复用池
    { t: 1, type: 'session.create', sessionId: 'pdu-0', nodeId: 'upf-new', bearerId: 'b-1', teid: 60 },
    { t: 2, type: 'teid.release', nodeId: 'upf-new', teid: 60, sessionId: 'pdu-0', bearerId: 'b-1' },
    { t: 2, type: 'echo.loss', nodeId: 'upf-new' },
    // echo 丢失期间发生路径切换，分配器从释放池复用 TEID 60
    { t: 3, type: 'path.switch', sessionId: 'pdu-1', bearerId: 'b-1', fromNodeId: 'upf-old', toNodeId: 'upf-new' },
  ]);

  // pdu-1 在新节点复用了刚释放的 TEID 60
  const newTable = sim.mappingAt(3).get('upf-new');
  assert.equal(newTable.get(60).sessionId, 'pdu-1');

  // echo 丢失期间的复用被标记为 defer-reuse
  const defer = sim.cleanupOrder().find((c) => c.action === 'defer-reuse');
  assert.ok(defer);
  assert.equal(defer.nodeId, 'upf-new');
  assert.equal(defer.teid, 60);

  // pdu-0 迟到的报文命中复用的 TEID 60，被误投到 pdu-1
  sim.apply({ t: 4, type: 'packet', nodeId: 'upf-new', teid: 60, forSessionId: 'pdu-0', forBearerId: 'b-1' });
  const mis = sim.misdeliveries();
  assert.equal(mis.length, 1);
  assert.equal(mis[0].reason, 'wrong-bearer');
  assert.equal(mis[0].actual.sessionId, 'pdu-1');
});
