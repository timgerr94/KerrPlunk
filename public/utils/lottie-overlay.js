/**
 * Modul: Lottie-Overlay (zusaetzlicher Jubel beim Einloesen)
 * Zweck: Einmaliges, zufaellig gewaehltes Lottie als Vollbild-Overlay ueber
 *        der Belohnungsseite, wenn eine Einloesung erfuellt wird. Haengt am
 *        SEPARATEN Haushaltsschalter `rewards_lottie` (an/aus) und laeuft
 *        damit ZUSAETZLICH zum Konfetti-Stil - beide zusammen sind erlaubt.
 * Abhaengigkeiten: /vendor/lottie/lottie.min.js (lazy, nur fuer JSON-
 *        Animationen), /assets/lottie/*.json + *.gif/*.webp (als <img>)
 *
 * DAS VERZEICHNIS IST DIE AUSWAHLLISTE. Ein Haushalt (oder nur dessen Admin)
 * legt Lottie-JSONs von https://lottiefiles.com in /assets/lottie/ ab, und
 * jede Datei nimmt mit dem naechsten Einloesen am Zufall teil. GIFs und
 * animierte WebPs nehmen EBENSO teil: sie spielen ohne den Player als
 * schlichtes <img> und brauchen keine Umwandlung in ein JSON - die Moonb-
 * Konvertierungen im Bestand zeigen, dass ein solches JSON meist GROESSER
 * ist als das GIF, aus dem es entstand. Der Server listet das Verzeichnis
 * einmal pro Uebersicht-Aufruf (GET /rewards/overview, routes/rewards.js)
 * und laesst nur die drei Endungen durch - nichts ist hartkodiert.
 *
 * WIE ALLE JUBEL-BAUSTEINE: Dekoration, nie Pflicht. Fehlt der Player, fehlen
 * die Dateien oder wirft der Player, bleibt der Toast die Wahrheit - jedes
 * awaiting dieser Funktion loest trotzdem auf.
 */

let lottiePromise = null;

function loadLottie() {
  if (!lottiePromise) {
    lottiePromise = import('/vendor/lottie/lottie.min.js')
      .then((mod) => {
        // lottie.min.js ist ein UMD-Bundle: im Browser haengt es sich an
        // globalThis.lottie statt ein ES-Modul zu exportieren (der default
        // Export existiert nur in den .mjs-Varianten, die wir nicht
        // vendoren). Beide Zugriffe bleiben - aendert das Bundle sein
        // Exportverhalten, faellt der andere nicht still ins Leere.
        const lib = mod?.default ?? globalThis.lottie;
        if (typeof lib?.loadAnimation !== 'function') throw new Error('lottie not loadable');
        return lib;
      })
      .catch((err) => {
        // Fehlgeschlagenen Import nicht dauerhaft cachen (sortable.js-
        // Lehrstueck): sonst liefert jeder spaetere Aufruf dieselbe abgelehnte
        // Promise, und der unhandledrejection-Handler (router.js) meldet bei
        // jedem Einloesen einen Fehler. Zuruecksetzen erlaubt einen neuen Versuch.
        lottiePromise = null;
        throw err;
      });
  }
  return lottiePromise;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/* Die Mindestdauer des Overlays - fuer beide Spielformen. Manche Sticker
 * enden nach 1-2 Sekunden; als Jubel wirken sie wie ein Zucken. */
const MIN_PLAY_MS = 4000;

/* Dateien, die der Browser selbst spielt (utils/lottie-overlay.js bekommt
 * die Liste gefiltert vom Server - die Endung entscheidet die Spielform). */
const IMAGE_FILE_RE = /\.(gif|webp)$/i;

/** Der z-Index der Modale aus derselben CSS-Variablen - der Jubel liegt darueber. */
function modalZIndex() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--z-modal')
    .trim();
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 1000;
}

/* GIF/WEBP: DER BROWSER IST DER PLAYER. Diese Formate spielen von selbst,
 * als schlichtes <img> im Dauerschleife - kein lottie.min.js noetig, keine
 * Umwandlung in ein JSON. `decode()` wartet auf das erste decodierte Bild und
 * wirft bei einer kaputten Datei; der aeussere catch faengt beides. Ein GIF
 * kennt kein "natuerliches Ende" - das Overlay laeuft daher schlicht die
 * Mindestdauer und loest dann auf.
 */
async function playImageOverlay(stage, name) {
  const img = document.createElement('img');
  img.src = `/assets/lottie/${encodeURIComponent(name)}`;
  img.alt = '';
  stage.appendChild(img);
  await img.decode();
  await new Promise((resolve) => { setTimeout(resolve, MIN_PLAY_MS); });
}

/* JSON: der Lottie-Player wie bisher. KURZE ANIMATIONEN SPIELEN SICH LOOPEND
 * BIS ZUR MINDESTDauer: der Loop laeuft, bis sie erreicht ist, und endet dann
 * mit dem NATUERLICHEN Rahmen des jeweiligen Durchlaufs - ein harter Stopp
 * mitten in der Bewegung saehe aus wie ein Fehler. Was ohnehin laenger
 * laeuft, merkt vom Loop nichts.
 */
async function playJsonOverlay(stage, name) {
  const lottie = await loadLottie();
  const startedAt = performance.now();
  const playedLongEnough = () => performance.now() - startedAt >= MIN_PLAY_MS;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { anim.destroy(); } catch { /* destroy ist idempotent genug */ }
      resolve();
    };
    const anim = lottie.loadAnimation({
      container: stage,
      renderer: 'svg',
      loop: true,
      autoplay: true,
      path: `/assets/lottie/${encodeURIComponent(name)}`,
    });
    // JEDES NATUERLICHE ENDE ENTSCHEIDET EINZELN: ist die Mindestdauer
    // noch nicht um, startet der naechste Durchlauf; sonst endet das
    // Overlay HIER, am sauberen Rahmen - nicht per Timer mitten in der
    // Bewegung. `loopComplete` feuert am Ende JEDES Durchlaufs (nicht nur
    // des ersten), `complete` nur bei loop:false - hier also unbenutzt,
    // aber der Fallback-Timer unten deckt den Fall ab, dass ein JSON mit
    // loop-Metadaten die Ereignisse verwirrt.
    anim.addEventListener('loopComplete', () => {
      if (playedLongEnough()) finish();
    });
    anim.addEventListener('data_failed', finish);
    // Sicherheitsnetz in zwei Rollen: es stoppt Animationen, die NIE ein
    // Ende melden (endlose JSONs, Event-Spaenen), und deckt dabei die
    // Mindestdauer ab - die Schleife endet dann eben getaktet statt am
    // Rahmen, aber nur im Ausnahmefall.
    setTimeout(finish, MIN_PLAY_MS + 20000);
  });
}

/**
 * Spielt EINE zufaellige Animation aus `files` als Overlay. `files` kommt aus
 * GET /rewards/overview (`lottie_files`) - der Server garantiert Dateinamen
 * ohne Pfad und nur mit den Endungen .json/.gif/.webp (siehe routes/rewards.js);
 * hier entsteht aus einem davon erst die URL. `on` ist der Haushaltsschalter:
 * false oder leere Liste tut nichts.
 *
 * NACH ENDUNG, NICHT NACH INHALT: .json spielt der Lottie-Player, .gif/.webp
 * spielt der Browser selbst - dieselbe Buehne, derselbe Rahmen drumherum.
 *
 * @param {boolean} on
 * @param {string[]} files
 * @returns {Promise<void>} loest immer auf (auch bei Fehlern - still)
 */
export async function playLottieOverlay(on, files) {
  if (!on || !Array.isArray(files) || files.length === 0) return;
  if (prefersReducedMotion()) return;

  const name = files[Math.floor(Math.random() * files.length)];

  const overlay = document.createElement('div');
  overlay.className = 'rw-lottie-overlay';
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.zIndex = String(modalZIndex() + 1);
  const stage = document.createElement('div');
  stage.className = 'rw-lottie-overlay__stage';
  overlay.appendChild(stage);
  document.body.appendChild(overlay);

  try {
    if (IMAGE_FILE_RE.test(name)) await playImageOverlay(stage, name);
    else await playJsonOverlay(stage, name);
  } catch {
    // Dekoration, keine Pflicht - der Toast bleibt die Wahrheit.
  } finally {
    overlay.remove();
  }
}
