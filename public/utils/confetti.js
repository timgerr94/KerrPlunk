/**
 * Modul: Konfetti-Wrapper (Einloese-Jubel im Belohnungsmodul)
 * Zweck: Projektweit einheitliche Kapselung von canvas-confetti (vendored unter
 *        /vendor/canvas-confetti/) fuer den Jubel-Moment, wenn eine Belohnung
 *        eingeloesst oder eine Anfrage freigegeben wird.
 * Abhaengigkeiten: /vendor/canvas-confetti/confetti.module.mjs (lazy)
 *
 * Konfetti ist Dekoration, nie Pflicht: faellt der Import oder ein Aufruf
 * weg, bleibt der Toast die einzige Wahrheit ueber den Erfolg. Deshalb
 * schluckt celebrate() jeden Fehler still - ein fehlendes `/vendor/`-File
 * (z. B. nach einem unvollstaendigen Update) darf die Einloesung nicht
 * unuebersetzt scheinen lassen.
 *
 * REDUZIERTE BEWEGUNG IST DOPPELT GEDECKT: einmal hier (der Haushalt soll
 * eine Einstellung aendern koennen, ohne die System-Einstellung zu kennen),
 * einmal durch canvas-confettis eigenes `disableForReducedMotion`.
 */
let confettiPromise = null;

function loadConfetti() {
  if (!confettiPromise) {
    confettiPromise = import('/vendor/canvas-confetti/confetti.module.mjs')
      .then((mod) => mod.default)
      .catch((err) => {
        // Fehlgeschlagenen Import nicht dauerhaft cachen: sonst liefert jeder
        // spaetere Aufruf dieselbe abgelehnte Promise und der globale
        // unhandledrejection-Handler (router.js) zeigt bei jedem Einloesen
        // einen Fehler-Toast. Zuruecksetzen erlaubt einen erneuten Versuch.
        // (Dasselbe Lehrstueck wie loadSortable in utils/sortable.js.)
        confettiPromise = null;
        throw err;
      });
  }
  return confettiPromise;
}

/** Systemweite Bewegungsreduzierung - derselbe Check wie in ux.js. */
function prefersReducedMotion() {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Der z-Index der Modale, gelesen aus derselben CSS-Variablen. */
function modalZIndex() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--z-modal')
    .trim();
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 1000;
}

// Die drei Jubel-Arten, die der Haushalt in den Belohnungs-Einstellungen
// waehlen kann. Die Schluessel stehen 1:1 in sync_config
// (`rewards_celebration`), der Server validiert dieselbe Liste
// (routes/preferences.js).
const PRESETS = {
  // Der Klassiker: ein Schwung aus beiden unteren Ecken.
  confetti: (confetti, zIndex) => {
    confetti({ particleCount: 90, spread: 70, origin: { x: 0.2, y: 0.7 }, zIndex });
    confetti({ particleCount: 90, spread: 70, origin: { x: 0.8, y: 0.7 }, zIndex });
  },
  // Mehrere kleine Buendel nacheinander, verteilt ueber den Bildschirm.
  fireworks: (confetti, zIndex) => {
    const shots = [
      { x: 0.5, y: 0.4 }, { x: 0.25, y: 0.3 }, { x: 0.75, y: 0.3 },
      { x: 0.35, y: 0.5 }, { x: 0.65, y: 0.5 },
    ];
    shots.forEach((origin, i) => {
      setTimeout(() => {
        confetti({ particleCount: 45, startVelocity: 32, spread: 360, ticks: 90, origin, zIndex });
      }, i * 180);
    });
  },
  // Goldene Sterne aus der Mitte - kleiner und leiser als die anderen.
  stars: (confetti, zIndex) => {
    const defaults = { particleCount: 60, spread: 75, startVelocity: 38, zIndex };
    confetti({ ...defaults, shapes: ['star'], scalar: 0.9, colors: ['#FFC700', '#FFD86B', '#E8A200'] });
  },
};

/**
 * Jubelt eine eingeloesste Belohnung im gewaehlten Stil. `mode` ist der
 * Rohwert aus sync_config (`off` | `confetti` | `fireworks` | `stars`);
 * `off` und unbekannte Werte tun nichts. Fehlschlaege werden still
 * geschluckt - der Erfolgstonst (Toast) bleibt unberuehrt.
 *
 * @param {string} mode
 * @returns {Promise<void>}
 */
export async function celebrate(mode) {
  if (!PRESETS[mode] || prefersReducedMotion()) return;
  try {
    const confetti = await loadConfetti();
    PRESETS[mode](confetti, modalZIndex());
  } catch {
    // Dekoration, keine Pflicht (siehe Modulkopf).
  }
}
