const STORAGE_KEY = 'yuvomi-offline-session';

export function isInstalledIosApp() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent ?? '')
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true;
  return ios && standalone;
}

export function rememberOfflineSession(snapshot) {
  if (!isInstalledIosApp()) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...snapshot }));
    return true;
  } catch (err) {
    console.warn('[Offline] Could not remember this device:', err);
    return false;
  }
}

export function readOfflineSession() {
  if (!isInstalledIosApp()) return null;

  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[Offline] Could not read remembered device:', err);
    return null;
  }
  if (!raw) return null;

  let snapshot;
  try {
    snapshot = JSON.parse(raw);
  } catch (err) {
    console.warn('[Offline] Remembered device data is invalid:', err);
    return null;
  }
  if (
    snapshot?.version !== 1
    || !snapshot.user
    || !Number.isFinite(Number(snapshot.user.id))
    || !snapshot.permissions
    || typeof snapshot.permissions !== 'object'
    || !snapshot.preferences
    || typeof snapshot.preferences !== 'object'
  ) {
    console.warn('[Offline] Remembered device data has an unsupported shape.');
    return null;
  }
  return snapshot;
}

export function forgetOfflineSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('[Offline] Could not forget remembered device:', err);
  }
}
