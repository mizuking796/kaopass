/* KaoPass - IndexedDB CRUD */
const KaoDB = (() => {
  const DB_NAME = 'kaopass';
  const DB_VERSION = 1;
  let db = null;

  function open() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('faces')) {
          d.createObjectStore('faces', { keyPath: 'id', autoIncrement: true });
        }
        if (!d.objectStoreNames.contains('expressions')) {
          d.createObjectStore('expressions', { keyPath: 'id', autoIncrement: true });
        }
        if (!d.objectStoreNames.contains('settings')) {
          d.createObjectStore('settings', { keyPath: 'key' });
        }
      };
      req.onsuccess = e => { db = e.target.result; resolve(db); };
      req.onerror = e => reject(e.target.error);
    });
  }

  function tx(storeName, mode) {
    return db.transaction(storeName, mode).objectStore(storeName);
  }

  function promisify(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function saveFace(data) {
    await open();
    // clear previous face data
    const store = tx('faces', 'readwrite');
    await promisify(store.clear());
    return promisify(tx('faces', 'readwrite').put(data));
  }

  async function getFace() {
    await open();
    const all = await promisify(tx('faces', 'readonly').getAll());
    return all.length > 0 ? all[0] : null;
  }

  async function saveExpression(data) {
    await open();
    const store = tx('expressions', 'readwrite');
    await promisify(store.clear());
    return promisify(tx('expressions', 'readwrite').put(data));
  }

  async function getExpression() {
    await open();
    const all = await promisify(tx('expressions', 'readonly').getAll());
    return all.length > 0 ? all[0] : null;
  }

  async function saveSetting(key, value) {
    await open();
    return promisify(tx('settings', 'readwrite').put({ key, value }));
  }

  async function getSetting(key) {
    await open();
    const r = await promisify(tx('settings', 'readonly').get(key));
    return r ? r.value : null;
  }

  async function clearAll() {
    await open();
    await promisify(tx('faces', 'readwrite').clear());
    await promisify(tx('expressions', 'readwrite').clear());
    await promisify(tx('settings', 'readwrite').clear());
  }

  async function hasRegistration() {
    const face = await getFace();
    const expr = await getExpression();
    return !!(face && expr);
  }

  return { open, saveFace, getFace, saveExpression, getExpression,
           saveSetting, getSetting, clearAll, hasRegistration };
})();
