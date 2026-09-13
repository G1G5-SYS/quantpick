/* 预测快照服务端存储(台账)测试
 * 覆盖三层:
 *   A. 纯本地模式(未注入传输):功能不受影响,离线可用
 *   B. 注入模拟传输:写入去抖上传、对账迁移本地独有快照
 *   C. 真实服务器端到端:写入 → 读取 → 去重 → 删除 → 清理
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const { BASE } = require('./test-env');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
const dom = new JSDOM(html, { url: BASE + '/', runScripts: 'dangerously', pretendToBeVisual: true });
const w = dom.window;
w.localStorage = (function () {
  const m = {};
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; } };
})();
['js/data.js', 'js/predict.js'].forEach(f => w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8')));

const P = w.QP.predict;
const results = [];
function check(name, cond, extra) { results.push((cond ? 'PASS' : 'FAIL') + ' | ' + name + (extra ? ' | ' + extra : '')); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
function mkSnap(id, label, ver, at) {
  return { id: id, label: label, modelVersion: ver || 'QP-PRED-1.0', at: at || new Date().toISOString(),
    top: [{ code: '600519', name: '贵州茅台', p5: 60, p10: 65, p20: 70, ret5: 3, ret10: 5, ret20: 8 }] };
}
async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method: method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, json: await r.json() };
}

(async () => {
  // ============ A. 纯本地模式 ============
  check('未注入传输时 snapshotSyncState.ok=null', P.snapshotSyncState().ok === null, JSON.stringify(P.snapshotSyncState()));
  P.saveSnapshots([mkSnap('L1', '2026-09-01'), mkSnap('L2', '2026-09-02')]);
  check('本地写入后读回 2 条', P.loadSnapshots().length === 2, '实际 ' + P.loadSnapshots().length);
  check('本地写入不触发远端同步', P.snapshotSyncState().ok === null, '');

  // ============ B. 注入模拟传输 ============
  const calls = { push: [], pull: 0, del: [] };
  let store = [];                       // 模拟服务端台账
  P.setSyncTransport({
    pull: async () => { calls.pull++; return store.slice(); },
    push: async list => {
      calls.push.push(list.length);
      const key = s => s.label + '|' + (s.modelVersion || '');
      const m = new Map(store.map(s => [key(s), s]));
      list.forEach(s => m.set(key(s), s));
      store = Array.from(m.values()).sort((a, b) => String(b.label).localeCompare(String(a.label)));
      return store.slice();
    },
    del: async id => { calls.del.push(id); store = store.filter(s => s.id !== id); return store.slice(); }
  });
  P.saveSnapshots([mkSnap('S1', '2026-09-10')]);
  check('写入后 800ms 内不立即上传(去抖)', calls.push.length === 0, '已上传 ' + calls.push.length + ' 次');
  await sleep(1200);
  check('去抖后自动上传一次', calls.push.length === 1, '上传 ' + calls.push.length + ' 次,条数 ' + calls.push.join(','));
  check('上传后服务端台账有 1 条', store.length === 1, '实际 ' + store.length);
  check('同步状态标记为成功', P.snapshotSyncState().ok === true, JSON.stringify(P.snapshotSyncState()));

  // 去重:同 label+modelVersion 覆盖,不新增
  P.saveSnapshots([mkSnap('S1b', '2026-09-10', 'QP-PRED-1.0', new Date(Date.now() + 5000).toISOString())]);
  await sleep(1200);
  check('同 label 覆盖不新增(仍 1 条)', store.length === 1, '实际 ' + store.length);

  // 对账迁移:本地独有(服务端没有)的快照应被上传
  store = [];
  const hy = await P.hydrateSnapshots();
  check('hydrate 拉取并迁移本地独有快照', Array.isArray(hy) && store.length >= 1, '上传后服务端 ' + store.length + ' 条');
  check('hydrate 后本地镜像与服务端一致', P.loadSnapshots().length === store.length, '本地 ' + P.loadSnapshots().length + ' vs 服务端 ' + store.length);

  // 删除:显式通知服务端
  const delId = store[0].id;
  P.removeSnapshot(delId);
  await sleep(300);
  check('删除同步到服务端', calls.del.indexOf(delId) >= 0 && store.length === 0, 'del=' + JSON.stringify(calls.del) + ' 剩余=' + store.length);

  // 传输失败时不影响本地
  P.setSyncTransport({ pull: async () => { throw new Error('网络不可用'); }, push: async () => { throw new Error('网络不可用'); }, del: async () => { throw new Error('网络不可用'); } });
  P.saveSnapshots([mkSnap('F1', '2026-09-05')]);
  await sleep(1200);
  check('传输失败:本地仍保留数据', P.loadSnapshots().some(s => s.id === 'F1'), '');
  check('传输失败:状态标记为失败', P.snapshotSyncState().ok === false, P.snapshotSyncState().error);
  const hyFail = await P.hydrateSnapshots();
  check('传输失败:hydrate 返回 null 不抛错', hyFail === null, '');
  P.setSyncTransport(null);

  // ============ C. 真实服务器端到端 ============
  /* 注意:其他 UI 测试(如 predict-ui)也会向同一实例推送快照。
     因此这里只清理"本测试自己创建"的 E2E* 数据,并验证未误删他人数据。 */
  const snapAll = async () => (await api('GET', '/api/snapshots')).json.data.snapshots;
  const beforeIds = new Set((await snapAll()).map(s => s.id));
  check('服务器台账初始可读', typeof beforeIds.size === 'number', '现有 ' + beforeIds.size + ' 条');
  const w1 = await api('POST', '/api/snapshots', { snapshots: [mkSnap('E2E1', '2026-08-20')] });
  check('端到端写入成功', w1.status === 200 && w1.json.data.added === 1, 'HTTP ' + w1.status + ' added=' + w1.json.data.added);
  const g1 = await snapAll();
  check('端到端读回', g1.some(s => s.id === 'E2E1'), '共 ' + g1.length + ' 条');
  const bad = await api('POST', '/api/snapshots', { snapshots: [{ id: 'E2EBAD', label: 'BAD', top: [] }] });
  check('非法快照被拒(不入账)', !bad.json.data.snapshots.some(s => s.id === 'E2EBAD'), '');
  const dup = await api('POST', '/api/snapshots', { snapshots: [mkSnap('E2E2', '2026-08-20')] });
  check('端到端同 label 去重', dup.json.data.snapshots.filter(s => s.label === '2026-08-20').length === 1,
    '该 label 条数 ' + dup.json.data.snapshots.filter(s => s.label === '2026-08-20').length);
  const dl = await api('POST', '/api/snapshots/delete', { id: 'E2E2' });
  check('端到端删除成功', dl.json.data.removed === 1, 'removed=' + dl.json.data.removed);
  // 只清理本测试创建的 E2E* 数据
  let cleaned = 0;
  for (const s of await snapAll()) {
    if (String(s.id).indexOf('E2E') === 0) { const r = await api('POST', '/api/snapshots/delete', { id: s.id }); cleaned += r.json.data.removed; }
  }
  const afterIds = new Set((await snapAll()).map(s => s.id));
  check('本测试数据已清理(E2E* 全部移除)', !Array.from(afterIds).some(id => String(id).indexOf('E2E') === 0), '清理 ' + cleaned + ' 条');
  check('未误删其他测试/用户的数据', Array.from(beforeIds).every(id => afterIds.has(id)),
    '保留 ' + afterIds.size + '/' + beforeIds.size + ' 条');


  report();
})().catch(e => { console.error('崩溃:', e); report(); process.exit(2); });

function report() {
  console.log('\n================ 预测快照台账测试 ================');
  results.forEach(r => console.log(r));
  const fails = results.filter(r => r.startsWith('FAIL'));
  console.log('--------------------------------------');
  console.log('总计:' + results.length + ' 项,失败:' + fails.length);
  process.exit(fails.length ? 1 : 0);
}
