import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  forgetOfflineSession,
  isInstalledIosApp,
  readOfflineSession,
  rememberOfflineSession,
} from '../public/utils/offline-session.js';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const storage = new Map();

function setDevice({ ios = true, standalone = true } = {}) {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      userAgent: ios ? 'iPhone' : 'Mozilla',
      platform: ios ? 'iPhone' : 'Win32',
      standalone,
      maxTouchPoints: 0,
    },
  });
  globalThis.window = { matchMedia: () => ({ matches: standalone }) };
  globalThis.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
}

function restoreEnvironment() {
  storage.clear();
  for (const [key, descriptor] of [
    ['navigator', originalNavigator],
    ['window', originalWindow],
    ['localStorage', originalStorage],
  ]) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
}

const snapshot = {
  user: { id: 17, username: 'family' },
  permissions: { admin: false, modules: { shopping: 'read', pantry: 'write' } },
  preferences: { disabled_modules: [], hidden_modules: [] },
};

test('remembers and restores a session only in the installed iOS app', (t) => {
  t.after(restoreEnvironment);
  setDevice();

  assert.equal(isInstalledIosApp(), true);
  assert.equal(rememberOfflineSession(snapshot), true);
  assert.deepEqual(readOfflineSession(), { version: 1, ...snapshot });

  setDevice({ ios: false });
  assert.equal(isInstalledIosApp(), false);
  assert.equal(readOfflineSession(), null);
});

test('does not remember a browser tab and can forget a saved session', (t) => {
  t.after(restoreEnvironment);
  setDevice({ standalone: false });

  assert.equal(rememberOfflineSession(snapshot), false);
  assert.equal(storage.size, 0);

  setDevice();
  assert.equal(rememberOfflineSession(snapshot), true);
  forgetOfflineSession();
  assert.equal(readOfflineSession(), null);
});

test('rejects malformed saved session data', (t) => {
  t.after(restoreEnvironment);
  setDevice();
  storage.set('yuvomi-offline-session', JSON.stringify({ version: 1, user: { id: 1 } }));

  assert.equal(readOfflineSession(), null);
});
