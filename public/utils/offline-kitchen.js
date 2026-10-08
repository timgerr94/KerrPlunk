const DB_NAME = 'yuvomi-offline-kitchen';
const DB_VERSION = 1;
const STORE_OPERATIONS = 'operations';
const STORE_MAPPINGS = 'mappings';
const LOCAL_ID_STRIDE = 1_000_000;

let databasePromise;
let syncPromise;
let outboxListenersBound = false;
let activeSync = null;

export function createKitchenClientId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function openDatabase() {
  if (!('indexedDB' in globalThis)) {
    return Promise.reject(new Error('IndexedDB is unavailable; offline kitchen changes cannot be saved.'));
  }
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const operations = db.createObjectStore(STORE_OPERATIONS, { keyPath: 'sequence', autoIncrement: true });
      operations.createIndex('ownerId', 'ownerId');
      db.createObjectStore(STORE_MAPPINGS, { keyPath: 'key' });
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        databasePromise = null;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      databasePromise = null;
      reject(request.error ?? new Error('Could not open the offline kitchen queue.'));
    };
    request.onblocked = () => reject(new Error('The offline kitchen queue is blocked by another app tab.'));
  });
  return databasePromise;
}

function ownerKey(ownerId, entityType, localId) {
  return `${ownerId}:${entityType}:${localId}`;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Offline kitchen storage failed.'));
  });
}

export async function enqueueKitchenOperation(ownerId, operation) {
  const numericOwnerId = Number(ownerId);
  if (!Number.isSafeInteger(numericOwnerId) || numericOwnerId <= 0) {
    throw new Error('A signed-in user is required to queue offline kitchen changes.');
  }
  const db = await openDatabase();
  const tx = db.transaction(STORE_OPERATIONS, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_OPERATIONS);
  const record = {
    ...operation,
    ownerId: numericOwnerId,
    operationId: operation.operationId ?? createKitchenClientId(),
    createdAt: Date.now(),
    status: 'pending',
  };
  const sequence = await requestResult(store.add(record));
  if (operation.localEntityType) {
    record.sequence = sequence;
    record.localId = -(sequence * LOCAL_ID_STRIDE);
    store.put(record);
  } else if (Array.isArray(operation.localEntities)) {
    record.sequence = sequence;
    record.localEntities = operation.localEntities.map((entity, index) => ({
      ...entity,
      localId: -(sequence * LOCAL_ID_STRIDE + index + 1),
    }));
    store.put(record);
  }
  await done;
  window.dispatchEvent(new CustomEvent('kitchen:outbox-changed', { detail: { ownerId: numericOwnerId } }));
  return record;
}

export function isBrowserOffline() {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

export function canQueueOffline(ownerId) {
  const numericOwnerId = Number(ownerId);
  return Number.isSafeInteger(numericOwnerId) && numericOwnerId > 0 && typeof indexedDB !== 'undefined';
}

export async function getKitchenOperations(ownerId) {
  const numericOwnerId = Number(ownerId);
  if (!Number.isSafeInteger(numericOwnerId) || numericOwnerId <= 0 || typeof indexedDB === 'undefined') return [];
  const db = await openDatabase();
  const tx = db.transaction(STORE_OPERATIONS, 'readonly');
  const done = transactionDone(tx);
  const records = await requestResult(tx.objectStore(STORE_OPERATIONS).index('ownerId').getAll(numericOwnerId));
  await done;
  return records.sort((a, b) => a.sequence - b.sequence);
}

export async function projectShoppingOperations(items, ownerId, listId) {
  const projected = [...items];
  const operations = await getKitchenOperations(ownerId);
  for (const operation of operations) {
    if (Number(operation.listId) !== Number(listId)) continue;
    if (operation.type === 'shopping.add' || operation.type === 'shopping.fromPantry') {
      const pendingItems = operation.projection.items ?? [
        { ...operation.projection, clientRef: operation.clientRef },
      ];
      for (const pendingItem of pendingItems) {
        const localId = operation.type === 'shopping.add'
          ? operation.localId
          : operation.localEntities?.find((entity) => entity.clientRef === pendingItem.clientRef)?.localId;
        if (localId == null || projected.some((item) => item.id === localId)) continue;
        projected.push({
          ...pendingItem,
          id: localId,
          pending_sync: true,
          sync_status: operation.status,
        });
      }
    } else if (operation.type === 'shopping.check') {
      const item = projected.find((entry) => Number(entry.id) === Number(operation.entityId));
      if (item) {
        item.is_checked = operation.projection.is_checked;
        item.pending_sync = true;
        item.sync_status = operation.status;
      }
    } else if (operation.type === 'shopping.delete') {
      const index = projected.findIndex((entry) => Number(entry.id) === Number(operation.entityId));
      if (index >= 0) projected.splice(index, 1);
    } else if (operation.type === 'pantry.fromShopping' || operation.type === 'shopping.transferRemove') {
      for (const shoppingId of operation.shoppingIds ?? []) {
        const index = projected.findIndex((entry) => Number(entry.id) === Number(shoppingId));
        if (index >= 0) projected.splice(index, 1);
      }
    }
  }
  return projected;
}

export async function projectPantryOperations(items, ownerId) {
  const projected = items.map((item) => ({ ...item }));
  const operations = await getKitchenOperations(ownerId);
  for (const operation of operations) {
    if (operation.type === 'pantry.quantity') {
      const item = projected.find((entry) => Number(entry.id) === Number(operation.entityId));
      if (item) {
        item.quantity = operation.projection.quantity;
        item.pending_sync = true;
        if (operation.status === 'conflict' || item.sync_status !== 'conflict') {
          item.sync_status = operation.status;
        }
        if (operation.conflictCurrentQuantity != null) {
          item.sync_server_quantity = operation.conflictCurrentQuantity;
        }
      }
    } else if (operation.type === 'shopping.fromPantry') {
      for (const update of operation.projection.pantryUpdates ?? []) {
        const item = projected.find((entry) => Number(entry.id) === Number(update.id));
        if (item) {
          item.quantity = update.quantity;
          item.restock_interval_days = update.restock_interval_days;
          item.pending_sync = true;
          item.sync_status = operation.status;
        }
      }
    } else if (operation.type === 'pantry.fromShopping') {
      for (const change of operation.projection.changes ?? []) {
        if (change.item) {
          const local = operation.localEntities?.find((entity) => entity.clientRef === change.clientRef);
          if (local && !projected.some((entry) => entry.id === local.localId)) {
            projected.push({
              ...change.item,
              id: local.localId,
              pending_sync: true,
              sync_status: operation.status,
            });
          }
        } else {
          const item = projected.find((entry) => Number(entry.id) === Number(change.existingId));
          if (item) {
            item.quantity = change.quantity;
            item.pending_sync = true;
            item.sync_status = operation.status;
          }
        }
      }
    }
  }
  return projected;
}

export async function clearKitchenConflict(ownerId, entityType, entityId) {
  if (typeof indexedDB === 'undefined' || !Number.isSafeInteger(Number(ownerId))) return undefined;
  const db = await openDatabase();
  const tx = db.transaction(STORE_OPERATIONS, 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore(STORE_OPERATIONS);
  const records = await requestResult(store.index('ownerId').getAll(Number(ownerId)));
  let serverValue;
  for (const operation of records) {
    if (
      operation.status === 'conflict'
      && operation.entityType === entityType
      && Number(operation.entityId) === Number(entityId)
    ) {
      serverValue = operation.conflictCurrentQuantity;
      store.delete(operation.sequence);
    }
  }
  await done;
  return serverValue;
}

function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Offline kitchen transaction failed.'));
    tx.onabort = () => reject(tx.error ?? new Error('Offline kitchen transaction was aborted.'));
  });
}

async function readMapping(db, ownerId, entityType, localId) {
  const tx = db.transaction(STORE_MAPPINGS, 'readonly');
  const done = transactionDone(tx);
  const key = ownerKey(ownerId, entityType, localId);
  const result = await requestResult(tx.objectStore(STORE_MAPPINGS).get(key));
  await done;
  return result?.serverId ?? null;
}

async function saveMapping(db, ownerId, entityType, localId, serverId) {
  const tx = db.transaction(STORE_MAPPINGS, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_MAPPINGS).put({
    key: ownerKey(ownerId, entityType, localId),
    ownerId,
    entityType,
    localId,
    serverId: Number(serverId),
  });
  await done;
}

async function resolveId(db, ownerId, entityType, id) {
  const numericId = Number(id);
  if (!Number.isSafeInteger(numericId) || numericId >= 0) return id;
  const mapped = await readMapping(db, ownerId, entityType, numericId);
  if (mapped == null) throw new Error(`An offline ${entityType} item is waiting for an earlier create.`);
  return mapped;
}

async function resolveReferences(db, operation) {
  const ownerId = operation.ownerId;
  let path = operation.path;
  const shoppingMatch = operation.path.match(/^\/shopping\/items\/(-\d+)$/);
  if (shoppingMatch) path = `/shopping/items/${await resolveId(db, ownerId, 'shopping', shoppingMatch[1])}`;
  const pantryMatch = operation.path.match(/^\/pantry\/(-\d+)$/);
  if (pantryMatch) path = `/pantry/${await resolveId(db, ownerId, 'pantry', pantryMatch[1])}`;

  async function walk(value, key = '') {
    if (Array.isArray(value)) {
      if (key === 'ids') return Promise.all(value.map((id) => resolveId(db, ownerId, 'shopping', id)));
      return Promise.all(value.map((entry) => walk(entry)));
    }
    if (!value || typeof value !== 'object') {
      if (key === 'shopping_item_id') return resolveId(db, ownerId, 'shopping', value);
      if (key === 'pantry_item_id') return resolveId(db, ownerId, 'pantry', value);
      return value;
    }
    return Object.fromEntries(await Promise.all(
      Object.entries(value).map(async ([childKey, child]) => [childKey, await walk(child, childKey)]),
    ));
  }

  return { path, body: await walk(operation.body) };
}

async function retainFailure(db, operation, error) {
  const tx = db.transaction(STORE_OPERATIONS, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(STORE_OPERATIONS).put({
    ...operation,
    status: Number(error?.status) === 409 ? 'conflict' : 'failed',
    lastError: String(error?.data?.error ?? error?.message ?? 'Sync failed'),
    conflictCurrentQuantity: error?.data?.current_quantity,
    failedAt: Date.now(),
  });
  await done;
}

function responseCreatedId(operation, response) {
  if (operation.localEntityType === 'shopping') {
    if (operation.type === 'shopping.add') return response?.data?.id;
    if (operation.type === 'shopping.fromPantry') {
      return response?.data?.added_items?.find((entry) => entry.client_ref === operation.clientRef)?.shopping_item_id
        ?? response?.data?.added_ids?.[0];
    }
  }
  if (operation.localEntityType === 'pantry') {
    const transferred = response?.data?.transfers?.find(
      (entry) => entry.client_ref === operation.clientRef,
    );
    return transferred?.pantry_item_id;
  }
  return null;
}

function responseCreatedIds(operation, response) {
  if (!operation.localEntities?.length) {
    return operation.localEntityType
      ? [{ entityType: operation.localEntityType, localId: operation.localId, serverId: responseCreatedId(operation, response) }]
      : [];
  }
  return operation.localEntities.map((entity) => {
    const transferred = operation.type === 'pantry.fromShopping'
      ? response?.data?.transfers?.find((entry) => entry.client_ref === entity.clientRef)
      : response?.data?.added_items?.find((entry) => entry.client_ref === entity.clientRef);
    return {
      entityType: entity.entityType,
      localId: entity.localId,
      serverId: entity.entityType === 'pantry'
        ? transferred?.pantry_item_id
        : transferred?.shopping_item_id,
    };
  });
}

export async function syncKitchenOutbox(ownerId, dispatch) {
  if (syncPromise) return syncPromise;
  syncPromise = (async () => {
    const db = await openDatabase();
    const records = await getKitchenOperations(ownerId);
    const blockedEntities = new Set();
    for (const operation of records) {
      const entityKey = operation.entityType && operation.entityId != null
        ? `${operation.entityType}:${operation.entityId}`
        : null;
      if (operation.status === 'conflict') {
        if (entityKey) blockedEntities.add(entityKey);
        continue;
      }
      if (entityKey && blockedEntities.has(entityKey)) continue;
      let resolved;
      try {
        resolved = await resolveReferences(db, operation);
        const headers = operation.method === 'POST'
          ? { 'Idempotency-Key': `offline-kitchen:${operation.operationId}` }
          : undefined;
        let response;
        try {
          response = await dispatch(operation.method, resolved.path, resolved.body, headers);
        } catch (error) {
          if (operation.method === 'DELETE' && Number(error?.status) === 404) {
            response = {};
          } else {
            throw error;
          }
        }
        if (
          operation.type === 'pantry.fromShopping'
          && operation.deleteChecked
          && Number(response?.data?.added ?? 0) + Number(response?.data?.merged ?? 0) > 0
        ) {
          const ids = await Promise.all(operation.deleteChecked.ids.map(
            (id) => resolveId(db, operation.ownerId, 'shopping', id),
          ));
          await dispatch('DELETE', operation.deleteChecked.path, { ids });
        }
        for (const mapping of responseCreatedIds(operation, response)) {
          if (mapping.serverId != null && mapping.localId < 0) {
            await saveMapping(db, operation.ownerId, mapping.entityType, mapping.localId, mapping.serverId);
          }
        }
        const tx = db.transaction(STORE_OPERATIONS, 'readwrite');
        const done = transactionDone(tx);
        tx.objectStore(STORE_OPERATIONS).delete(operation.sequence);
        await done;
        window.dispatchEvent(new CustomEvent('kitchen:outbox-changed', {
          detail: { ownerId: Number(ownerId), sequence: operation.sequence, synced: true },
        }));
      } catch (error) {
        await retainFailure(db, operation, error);
        window.dispatchEvent(new CustomEvent('kitchen:outbox-error', {
          detail: { ownerId: Number(ownerId), operation, error },
        }));
        if (Number(error?.status) === 409) {
          if (entityKey) blockedEntities.add(entityKey);
          continue;
        }
        break;
      }
    }
  })().finally(() => {
    syncPromise = null;
  });
  return syncPromise;
}

export function startKitchenOutbox(ownerId, dispatch) {
  if (typeof indexedDB === 'undefined' || typeof window === 'undefined') return;
  activeSync = { ownerId: Number(ownerId), dispatch };
  const run = () => {
    if (navigator.onLine && activeSync?.ownerId > 0) {
      syncKitchenOutbox(activeSync.ownerId, activeSync.dispatch).catch((error) => {
        console.error('[Offline kitchen] Queue sync could not start:', error);
      });
    }
  };
  if (!outboxListenersBound) {
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') run();
    });
    outboxListenersBound = true;
  }
  run();
}

export function isOfflineWriteError(error) {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
  return Number(error?.status) === 0 || error instanceof TypeError;
}
