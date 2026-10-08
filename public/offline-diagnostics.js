const report = document.getElementById('report');

function yesNo(value) {
  return value ? 'yes' : 'no';
}

async function cacheDetails(cacheName, prefixes) {
  if (!cacheName) return { available: false, keys: [] };
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    return {
      available: true,
      keys: keys
        .map((request) => {
          const url = new URL(request.url);
          return {
            path: url.pathname,
          };
        })
        .filter(({ path }) => prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))),
    };
  } catch (err) {
    console.warn('[Offline diagnostics] Cache inspection failed:', err);
    return { available: false, keys: [] };
  }
}

async function runDiagnostics() {
  report.textContent = 'Checking…';

  let registration = null;
  let registrationError = 'none';
  if ('serviceWorker' in navigator) {
    try {
      registration = await navigator.serviceWorker.getRegistration();
    } catch (err) {
      console.warn('[Offline diagnostics] Service worker lookup failed:', err);
      registrationError = err?.name || 'lookup failed';
    }
  }

  let cacheNames = [];
  let cacheError = 'none';
  try {
    cacheNames = await caches.keys();
  } catch (err) {
    console.warn('[Offline diagnostics] Cache listing failed:', err);
    cacheError = err?.name || 'lookup failed';
  }

  const shellName = cacheNames.find((name) => name.startsWith('yuvomi-shell-'));
  const apiName = cacheNames.find((name) => name.startsWith('yuvomi-api-'));
  const shell = await cacheDetails(shellName, [
    '/',
    '/index.html',
    '/router.js',
    '/offline-diagnostics.html',
    '/offline-diagnostics.js',
  ]);
  const api = await cacheDetails(apiName, ['/api/v1/shopping', '/api/v1/pantry']);
  const shoppingItemKeys = api.keys.filter(({ path }) => /^\/api\/v1\/shopping\/\d+\/items$/.test(path));
  const standalone = navigator.standalone === true
    || window.matchMedia?.('(display-mode: standalone)').matches === true;
  let rememberedSession = false;
  try {
    const snapshot = JSON.parse(localStorage.getItem('yuvomi-offline-session') || 'null');
    rememberedSession = snapshot?.version === 1 && Boolean(snapshot?.user?.id);
  } catch (err) {
    console.warn('[Offline diagnostics] Remembered session check failed:', err);
  }

  const lines = [
    `Online according to browser: ${navigator.onLine === false ? 'no' : 'yes'}`,
    `Installed/standalone app: ${yesNo(standalone)}`,
    `Service worker supported: ${yesNo('serviceWorker' in navigator)}`,
    `Service worker registered: ${yesNo(Boolean(registration) || Boolean(navigator.serviceWorker?.controller))}`,
    `Service worker controls this page: ${yesNo(Boolean(navigator.serviceWorker?.controller))}`,
    `Service worker active state: ${registration?.active?.state || 'none'}`,
    `Service worker lookup error: ${registrationError}`,
    `Cache API available: ${yesNo(cacheError === 'none')}`,
    `Cache listing error: ${cacheError}`,
    `Yuvomi shell cache found: ${yesNo(Boolean(shellName))}`,
    `Shell cache opened: ${yesNo(shell.available)}`,
    `Shell entries found: ${shell.keys.map(({ path }) => path).join(', ') || 'none'}`,
    `Yuvomi API cache found: ${yesNo(Boolean(apiName))}`,
    `API cache opened: ${yesNo(api.available)}`,
    `Cached shopping list responses: ${api.keys.filter(({ path }) => path === '/api/v1/shopping').length}`,
    `Cached shopping item-list responses: ${shoppingItemKeys.length}`,
    `Cached pantry response: ${yesNo(api.keys.some(({ path }) => path === '/api/v1/pantry'))}`,
    `Remembered offline session found: ${yesNo(rememberedSession)}`,
  ];

  report.textContent = lines.join('\n');
}

document.getElementById('refresh').addEventListener('click', runDiagnostics);
runDiagnostics();
