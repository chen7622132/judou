/* IndexedDB 封装，带内存兜底（某些 WebView 里 indexedDB 会抛错） */

const DB_NAME = 'judou';
const VER = 1;
const STORES = { docs: 'id', cards: 'id', logs: 'id', kv: 'k' };

let _db = null;
let _mem = null;

function memFallback() {
  if (!_mem) _mem = { docs: new Map(), cards: new Map(), logs: new Map(), kv: new Map() };
  return _mem;
}

export function open() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    let rq;
    try {
      rq = indexedDB.open(DB_NAME, VER);
    } catch (e) {
      console.warn('indexedDB 不可用，切内存模式', e);
      return resolve(null);
    }
    rq.onupgradeneeded = () => {
      const db = rq.result;
      for (const [name, kp] of Object.entries(STORES)) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: kp });
      }
    };
    rq.onsuccess = () => { _db = rq.result; resolve(_db); };
    rq.onerror = () => { console.warn('indexedDB 打开失败，切内存模式', rq.error); resolve(null); };
    rq.onblocked = () => resolve(null);
  });
}

function req2p(req) {
  return new Promise((res, rej) => {
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

export async function put(store, val) {
  const db = await open();
  if (!db) { memFallback()[store].set(val[STORES[store]], val); return val; }
  const tx = db.transaction(store, 'readwrite');
  await req2p(tx.objectStore(store).put(val));
  return val;
}

export async function get(store, key) {
  const db = await open();
  if (!db) return memFallback()[store].get(key) || null;
  return (await req2p(db.transaction(store).objectStore(store).get(key))) || null;
}

export async function all(store) {
  const db = await open();
  if (!db) return [...memFallback()[store].values()];
  return (await req2p(db.transaction(store).objectStore(store).getAll())) || [];
}

export async function del(store, key) {
  const db = await open();
  if (!db) { memFallback()[store].delete(key); return; }
  const tx = db.transaction(store, 'readwrite');
  await req2p(tx.objectStore(store).delete(key));
}

export async function clear(store) {
  const db = await open();
  if (!db) { memFallback()[store].clear(); return; }
  const tx = db.transaction(store, 'readwrite');
  await req2p(tx.objectStore(store).clear());
}

/** 一个事务里批量写，用于导入 */
export async function writeMany(ops) {
  const db = await open();
  if (!db) {
    for (const { store, val } of ops) memFallback()[store].set(val[STORES[store]], val);
    return;
  }
  const names = [...new Set(ops.map((o) => o.store))];
  const tx = db.transaction(names, 'readwrite');
  for (const { store, val } of ops) tx.objectStore(store).put(val);
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
