// public/snow.js — Schneefall & Schneehauben fuer den Christmas-Skin.
//
// Geladen wird dieses Modul NUR, solange der Skin aktiv ist: theme-init.js
// stellt beim Boot den Erstzustand her, router.js (applySkin) die spaeteren
// Wechsel - beide rufen start()/stop() ueber den dynamischen Import auf.
// `start()` baut die Overlay-Leinwand auf und haengt jedem registrierten Ziel
// (Primaerknoepfe, Icon-Knoepfe, angedockte New-Knoepfe, untere Werkzeug-
// leiste des Handys) eine Schneehaube an, `stop()` baut alles wieder ab,
// inklusive der position:relative-Korrekturen.
//
// Das Vorbild ist das urspruengliche snow.js des Projekts (unicode-Flocken,
// Gauss'sche Akkumulation) - nur akkumuliert der Schnee hier auf Knoepfen und
// am unteren Rand (breite Bildschirme). Geschmolzen wird nichts mehr: Sind
// alle Hauben voll, liegt der Schnee und der Nachschub stellt sich ein.

// ███ ALLE STELLSCHRAUBEN STEHEN IN DIESEM CONFIG-BLOCK. ███
export const CONFIG = {
  // ── Fallender Schnee ────────────────────────────────────────────────────
  flakeCharacters: ['❄', '*', '❉', '❃', '❅'], // Zeichen, mit denen gezeichnet wird
  flakeColor: '#FDFEFF',
  flakeMinSize: 5, // px: kleinste Flocken-Groesse
  flakeMaxSize: 15, // px: groesste Flocken-Groesse
  flakeMinSpeed: 0.4, // px pro Frame (bei 60 fps) - Fallgeschwindigkeit
  flakeMaxSpeed: 1.4,
  flakeStartOpacity: 0.55,
  desktopBreakpoint: 1000, // px: darunter gilt der Bildschirm als Handy
  mobileFrameDivisor: 8, // auf Handys entsteht nur jede 8. Frame eine Flocke
  bottomFadeZone: 24, // px: Flocken ohne Landeflaeche loesen sich hier auf

  // ── Schneehauben (Akkumulation auf dem oberen Rand der Ziele) ───────────
  // Nur Knoepfe. Die Seiten-Toolbar (.page-toolbar) ist bewusst KEIN Ziel:
  // ihre fast randbreite Haube auf dem klebenden Kopf las sich als weisse,
  // schwebende Linie ueber dem Kopf, nicht als Schnee auf einer Flaeche.
  // Der ANGEDOCKTE New-Knopf (.page-fab--docked) ist ein Ziel, der schwebende
  // Kreis nicht; .nav-bottom__items ist die untere Werkzeugleiste des Handys - sichtbar nur dort, damit deckt die Sichtbarkeitspruefung die Geraetegrenze ab.
  targetSelector: '.btn--primary, .btn--icon, .page-fab--docked, .nav-bottom__items',
  capMaxHeight: 8, // px: maximale Haubenhoehe - danach bleibt sie liegen
  depositPerFlake: 0.2, // px Haubenhoehe pro gelandeter Flocke (skaliert mit Groesse)
  capGrowEase: 0.08, // 0..1: wie schnell die angezeigte Hoehe nachwächst
  skipCircular: true, // runde Knoepfe (Kreisform) bekommen keine Haube
  capInsetPadding: 2, // px: Hauben-Einrueckung = Eckenradius + dieses Polster
  shakeTargets: '.btn--primary, .btn--icon, .page-fab--docked', // schuetteln bei Druck (NICHT die schmale Werkzeugleiste)

  // ── Abgeworfener Schnee (canvas-confetti-Brocken) ─────────────────────
  // Die Haube zerfaellt beim Schuetteln in Bissen, die in alle Richtungen
  // stieben - nicht ein Stueck, das wegrotiert. Geladen wird derselbe
  // vendierte Renderer wie im Belohnungsmodul (utils/confetti.js ist dort
  // der Wrapper, hier ist der Konsument direkter).
  scatterCount: 26, // Bissen pro Wurf - skaliert mit der Haubenhoehe
  scatterScalar: 0.55, // Groesse eines Bissens (1 = Standard-Konfetti)
  scatterStartVelocity: 26, // Abflug-Elan
  scatterSpread: 65, // Grad: Oeffnungswinkel um die Abflugrichtung
  scatterTicks: 70, // Lebensdauer eines Bissens
  scatterGrav: 0.5, // Fall-Beschleunigung wie im Renderer-Default

  // ── Boden-Wehe am unteren Rand (nur breite Bildschirme) ─────────────────
  groundBreakpoint: 1024, // px: ab dieser Breite liegt die Wehe am Bildschirmrand
  groundMaxHeight: 12, // px: maximale Wehenhoehe (pro Spalte)
  groundDepositPerFlake: 0.25, // px Wehenhoehe pro gelandeter Flocke (skaliert mit Groesse)
  groundColumnWidth: 3, // px Breite einer Wehen-Spalte (kleiner = bugeliger, feiner)
  groundSmoothing: 50, // Gauss-Falloff der Ablagerung: groesser = sanftere Huegel
  groundCornerRise: 15, // px: wie weit die Ecken ueber die Basis-Kante aufwehen
  groundCornerFalloff: 1, // px: Abstand vom Rand, ueber den die Aufwehung abklingt

  // ── prefers-reduced-motion: kein Fall, alles liegt statisch ─────────────
  staticCapHeight: 4, // px: feste Haubenhoehe ohne jede Animation
};

const state = {
  running: false,
  reduced: false,
  rafId: 0,
  lastFrame: 0,
  counter: 0,
  flakes: [],
  targets: new Map(), // Element -> { cap, level, shown, applied }
  ground: { shown: 0, columns: null }, // Boden-Wehe (Spalten-Array)
  overlay: null,
  canvas: null,
  ctx: null,
  observer: null,
  rescanTimer: 0,
  width: 0,
  height: 0,
  onResize: null,
  onVisibility: null,
};

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// ── Schneebrocken (canvas-confetti) ─────────────────────────────────────
// Derselbe Renderer wie der Jubel im Belohnungsmodul (public/vendor/
// canvas-confetti), hier als direkter Konsument fuer den Abwurf: die Haube
// zerfaellt in weisse Runde, die in alle Richtungen stieben. Dekoration,
// nie Pflicht: faellt der Import aus, fliegt nichts - Knopf, Schuettel und
// Pegel laufen unberuehrt weiter. Die Promise wird zwischengespeichert
// (dasselbe Muster wie loadConfetti in utils/confetti.js), ein Fehlschlag
// wirft sie weg, damit ein spaeterer Wurf erneut versuchen kann.
let confettiPromise = null;

function loadConfetti() {
  if (!confettiPromise) {
    confettiPromise = import('/vendor/canvas-confetti/confetti.module.mjs')
      .then((mod) => mod.default)
      .catch((err) => {
        confettiPromise = null;
        throw err;
      });
  }
  return confettiPromise;
}

// Ein Schwung weisser Bissen aus der OBERKANTE des Knopfs: ein breiter
// Kegel um die Senkrechte streut sie nach links, rechts und oben - nur
// nicht nach unten, dort liegt der Knopf. Die Bissen skalieren mit der
// Schneemenge, die der Knopf trug; zIndex haelt sie unter Meldungen,
// ueber der Boden-Wehe (dieselbe Schicht wie das Overlay).
async function scatterSnowCrumbs(el, capLevel) {
  try {
    const confetti = await loadConfetti();
    const r = el.getBoundingClientRect();
    const fullness = Math.min(1, Math.max(0.25, capLevel / CONFIG.capMaxHeight));
    const zIndex = (parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue('--z-nav'), 10) || 100) + 10;
    confetti({
      particleCount: Math.round(CONFIG.scatterCount * fullness),
      spread: CONFIG.scatterSpread,
      angle: 270, // nach oben; der Kegel um die Senkrechte streut seitwaerts
      startVelocity: CONFIG.scatterStartVelocity,
      ticks: CONFIG.scatterTicks,
      gravity: CONFIG.scatterGrav,
      scalar: CONFIG.scatterScalar * (0.7 + fullness * 0.3),
      shapes: ['circle'],
      colors: [CONFIG.flakeColor],
      origin: {
        x: (r.left + r.width / 2) / window.innerWidth,
        y: (r.top - 4) / window.innerHeight,
      },
      zIndex,
      disableForReducedMotion: true,
    });
  } catch {
    // Dekoration, keine Pflicht.
  }
}

// ── Zielregistrierung ───────────────────────────────────────────────────────

// Wirksamer Eckenradius: border-radius kann als Prozentangabe oder als
// --radius-full (9999px) kommen - beides stumpft auf halbe Kante ab, mehr
// Rundung als ein Kreis gibt es nicht.
function effectiveRadius(el, rect) {
  const radius = getComputedStyle(el).borderRadius;
  const min = Math.min(rect.width, rect.height);
  if (radius.includes('%')) return min / 2;
  return Math.min(parseFloat(radius) || 0, min / 2);
}

// Einem Ziel eine Haube spendieren. position:relative ist die Voraussetzung
// dafuer; war das Element static, wird das hier gesetzt und beim Abbau
// zurueckgenommen (was schon sticky/absolute war, bleibt unangetastet).
function attachCap(el, rect) {
  const cap = document.createElement('span');
  cap.className = 'kp-snow-cap';
  cap.setAttribute('aria-hidden', 'true');
  // Einrueckung nach Mass: Eckenradius plus Polster, als CSS-Variable am
  // Element (skins.css liest sie). Eine feste Prozentzahl ragte an schmalen
  // Knoepfen ueber die Rundung hinaus - der Knopf entscheidet, nicht der Satz.
  cap.style.setProperty('--kp-snow-inset', `${Math.round(effectiveRadius(el, rect) + CONFIG.capInsetPadding)}px`);
  // Der Anker fuer die absolut positionierte Haube ist eine KLASSE (Regel
  // in skins.css), und sie wird NUR an ein STATISCHES Ziel gehaengt.
  // Erstens bleibt eine Klasse restlos entfernbar - ein Inline-Stil liess
  // den undockenden Page-FAB an den Bildschirmrand springen, weil die Shell
  // seine fixed-Geometrie nicht mehr durchsetzen konnte. Zweitens haette
  // die Klasse auf einem Ziel MIT eigener Positionierung diese
  // ueberschrieben: der sticky Seiten-Kopf (.page-toolbar) verloere sein
  // Sticky. Statische Ziele dagegen sind durch relative im Fluss unveraendert.
  // (Der angedockte New-Knopf hat seine EIGENE Ankerregel in skins.css, die
  // die Offsets von .page-fab stilllegt.)
  if (getComputedStyle(el).position === 'static') {
    el.classList.add('kp-snow-host');
  }
  el.appendChild(cap);
  state.targets.set(el, { cap, level: 0, shown: 0, applied: 0 });
  // SCHUETTELN STATT KIPPPEN: .btn:active skal­i­ert den Knopf (die
  // „Kipp"-Wirkung), die schmale Werkzeugleiste waere bei jedem
  // Navigationstipp ein zitterndes Menue. Angehaengt wird der Zuhoerer nur
  // an Schuettel-Ziele mit Haube - er feuert nicht ohne Schnee.
  if (el.matches(CONFIG.shakeTargets)) {
    el.addEventListener('pointerdown', onShakePress);
  }
  if (state.reduced) {
    const t = state.targets.get(el);
    t.level = t.shown = t.applied = CONFIG.staticCapHeight;
    t.cap.style.height = `${CONFIG.staticCapHeight}px`;
  }
}

// Der Hund schuettelt sich: bei pointerdown auf einem Ziel MIT Haube...
function onShakePress(event) {
  const el = event.currentTarget;
  const t = state.targets.get(el);
  if (!t || t.level < 0.5 || state.reduced) return; // ohne Schnee kein Schuetteln
  // ...zittert der Knopf kurz, der Schnee zerfaellt in Bissen und stiebt
  // in alle Richtungen davon, und der Pegel beginnt bei 0 - der Schnee
  // muss neu fallen.
  el.classList.add('kp-snow-shake');
  // FLACKER-FALLE: das blosse Entfernen der Schuettel-Klasse liess die
  // berechnete animation auf den Eintritts-Runner zurueckfallen, den die
  // angedockten New-Knoepfe als .page-fab tragen (fab-in: scale(0.5),
  // opacity 0 -> 1). Ein Wechsel des animation-Werts startet eine NEUE
  // Animation - der Knopf spultte nach jedem Schuetteln seinen Eintritt
  // neu auf und flackerte 420 ms aus. kp-snow-shake-done pinnt die
  // Animation danach auf none (Regel in skins.css); die naechste
  // Schuettel-Runde gewinnt darueber ueber die Quellordnung.
  // Pruefen tut das Ende den NAMEN: animationend BLUBBERT, und der Wurf
  // der Haube (420 ms) feuert dasselbe Ereignis auch auf dem Knopf - ein
  // nackter once-Listener wuerde von jedem aufsteigenden Fremd-Ereignis
  // verbraucht.
  const onShakeEnd = (e) => {
    if (e.animationName !== 'kp-snow-shake') return;
    el.classList.remove('kp-snow-shake');
    el.classList.add('kp-snow-shake-done');
    el.removeEventListener('animationend', onShakeEnd);
  };
  el.addEventListener('animationend', onShakeEnd);
  // Der Abwurf: BROCKEN statt einem Stueck. Die Haube verschwindet sofort
  // (das korrekte Bild ist der schneefreie Knopf, um den die Bissen
  // fliegen), und die Bissen nehmen ihren Platz ein - gestreut, mit Fall
  // und Drall, wie Schnee, den ein Hund abschuettelt. capLevel steht noch
  // auf dem alten Wert: Anzahl und Groesse der Bissen skalieren mit der
  // Schneemenge, die der Knopf eben noch trug.
  scatterSnowCrumbs(el, t.level);
  t.level = 0;
  t.shown = 0;
  t.applied = 0;
  t.cap.style.height = '0px';
}

// Nur der KREIS bleibt ohne Haube. Auf ihm waere die Haube ein schwebender
// Bogen statt Schnee (der schwebende FAB ist das bekannteste Beispiel). Die
// KAPSEL dagegen traegt sie: im Shell-Design ist jeder .btn eine Kapsel
// (--radius-full in layout.css), die Kurve sitzt nur in den Ecken, und die
// radiusbasierte Einrueckung der Haube laeuft vor ihr Halt. Vor dieser
// Unterscheidung galt jede Kapsel als Kreis - die Haube fehlte an jedem
// Primaerknopf.
function isCircular(el, rect) {
  const min = Math.min(rect.width, rect.height);
  if (effectiveRadius(el, rect) < min / 2 - 0.5) return false; // nicht voll gerundet
  return Math.abs(rect.width - rect.height) <= 2; // voll gerundet: nur der Kreis bleibt ohne
}

// Ein Ziel mit .page-fab-Klasse ist nur brauchbar, wenn es ANGEDOCKT ist:
// die schwebende Variante ist ein Kreis ausserhalb jeder Hauben-Geometrie,
// und ihre Position gehoert allein der Shell. .page-fab--docked im Selektor
// schliesst sie aus; dieser Doppelcheck schuetzt gegen die Reihenfolge, in
// der die Shell Klassen entfernt.
function isEligible(el) {
  if (!el.matches(CONFIG.targetSelector)) return false;
  if (el.classList.contains('page-fab') && !el.classList.contains('page-fab--docked')) return false;
  return true;
}

function registerTargets() {
  document.querySelectorAll(CONFIG.targetSelector).forEach((el) => {
    if (state.targets.has(el) || !el.isConnected) return;
    if (!isEligible(el)) return; // schwebender FAB u. a.
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return; // unsichtbar / zu klein
    if (CONFIG.skipCircular && isCircular(el, rect)) return; // Kreis: keine Haube
    attachCap(el, rect);
  });
}

// Abgeraeumt werden Ziele, die aus dem DOM fielen (Routenwechsel) ODER keine
// Ziele mehr sind - der zweite Fall ist der Lebenszyklus des angedockten
// New-Knopfs: er verliert beim Undocken seine btn--primary-Klasse und wird
// wieder position:fixed. Bliebe er registriert, hielte ihn die kp-snow-host-
// Klasse im Flow der FAB-Ebene gefangen.
function pruneTargets() {
  for (const [el, t] of state.targets) {
    if (!el.isConnected || !isEligible(el)) {
      t.cap.remove();
      el.classList.remove('kp-snow-host');
      el.removeEventListener('pointerdown', onShakePress);
      state.targets.delete(el);
    }
  }
}

function rescan() {
  if (!state.running) return;
  pruneTargets();
  registerTargets();
}

function scheduleRescan() {
  clearTimeout(state.rescanTimer);
  state.rescanTimer = setTimeout(rescan, 150);
}

// ── Leinwand ────────────────────────────────────────────────────────────────

function ensureOverlay() {
  state.overlay = document.createElement('div');
  state.overlay.id = 'kp-snow-layer';
  state.overlay.setAttribute('aria-hidden', 'true');
  // SCHICHT: unter Meldungen (--z-toast 300) und dem Offline-Banner (+1),
  // ueber allem anderen. Die Basis ist --z-nav (100): die Boden-Wehe deckt
  // die Diagonal-Streifen von body/.app-content ab - die Streifen sind der
  // Frostschimmer des Skins auf dem Seitenhintergrund, und Schnee, der den
  // Boden aufweht, liegt VOR dem Boden, nicht dahinter. (Die Knopf-Hauben
  // haben das Problem nicht: sie haengen im Ziel selbst und erben dessen
  // Schicht.) Skip-Link (400) und Fokus-Ringe bleiben unangetastet darueber;
  // +10 statt +1, damit die Wehe auch vor kuenftigen nav-Nachbarn liegt.
  state.overlay.style.cssText =
    'position:fixed;inset:0;pointer-events:none;user-select:none;'
    + 'z-index:calc(var(--z-nav, 100) + 10);';
  state.canvas = document.createElement('canvas');
  state.canvas.style.cssText = 'display:block;width:100%;height:100%;';
  state.overlay.appendChild(state.canvas);
  document.body.appendChild(state.overlay);
  state.ctx = state.canvas.getContext('2d');
  resizeCanvas();
}

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  state.width = window.innerWidth;
  state.height = window.innerHeight;
  state.canvas.width = Math.round(state.width * dpr);
  state.canvas.height = Math.round(state.height * dpr);
  state.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  // Spalten an die neue Breite anpassen: ein Resize innerhalb der Wehe
  // haette sonst Landungen auf Spalten berechnet, die es nicht mehr gibt.
  ensureGroundColumns();
}

// ── Boden-Wehe (breite Bildschirme) ─────────────────────────────────────────

// Unter der Geraetegrenze traegt die untere Werkzeugleiste des Handys den
// Schnee als Haube (sie ist ein Ziel wie jeder Knopf); darueber weht er als
// bugeliges Band am unteren Bildschirmrand - KEIN flaches Div mehr, sondern
// pro Spalte akkumuliert und jede Frame auf die Leinwand gezeichnet, genau
// wie das Vorbild (snowLevels + smoothAccumulation im urspruenglichen
// snow.js). Nur die LAENGSTE Spalte zaehlt als Pegel fuer allFull().
function groundActive() {
  return window.innerWidth >= CONFIG.groundBreakpoint;
}

function groundColumnCount() {
  return Math.max(1, Math.ceil(state.width / CONFIG.groundColumnWidth));
}

function ensureGroundColumns() {
  const count = groundColumnCount();
  if (!state.ground.columns || state.ground.columns.length !== count) {
    state.ground.columns = new Array(count).fill(0);
  }
}

// Hoechster Wehenpegel - der Massstab fuer die Lande-Hoehe.
function groundPeak() {
  let peak = 0;
  const cols = state.ground.columns;
  if (cols) for (let i = 0; i < cols.length; i += 1) if (cols[i] > peak) peak = cols[i];
  return peak;
}

// Pegel der MITTE fuer allFull(): die Ecken wehen absichtlich frueh ueber
// die Basis-Kante (groundCornerRise) - gemessen am PEAK stuende der Schnee
// "voll", lange bevor die Mitte gefuellt ist, und der Nachschub stellte
// sich mitten im Aufbau ein. Massstab ist deshalb der Innenraum; sind die
// Ecken darueber hinaus gewachsen, ist das der gewollte Zustand, kein Rest.
function groundInteriorPeak() {
  let peak = 0;
  const cols = state.ground.columns;
  if (!cols) return 0;
  const margin = Math.ceil((CONFIG.groundCornerFalloff * 3) / CONFIG.groundColumnWidth);
  for (let i = margin; i < cols.length - margin; i += 1) {
    if (cols[i] > peak) peak = cols[i];
  }
  // Sehr schmale Fenster, deren Innenraum leer bliebe: dann gilt der
  // gewoehnliche Peak, sonst schneit es dort nie zu Ende.
  if (cols.length <= margin * 2) return groundPeak();
  return peak;
}

// Ecken-Profil: 1 direkt am Bildschirmrand, klingt gaussfoermig gegen 0
// zur Mitte ab. Ecken wehen auf wie im Wind - Schnee, der nirgendwo
// entlangweht, sammelt sich an den Kanten.
function edgeProfile(idx) {
  const x = idx * CONFIG.groundColumnWidth;
  const dist = Math.min(x, state.width - x);
  return Math.exp(-dist / CONFIG.groundCornerFalloff);
}

// Spalten-Decke: Basis-Kante PLUS Aufwehung am Rand - die Ecken duerfen
// ueber groundMaxHeight hinaus wachsen, der Rest nicht.
function groundCeiling(idx) {
  return CONFIG.groundMaxHeight + CONFIG.groundCornerRise * edgeProfile(idx);
}

// Ablagerung wie im Vorbild: Gauss'scher Falloff rund um die Lande-Stelle,
// damit die Wehe Huegel bildet statt einer gleichmaessigen Kante. Nahe den
// Ecken faellt MEHR (Wind staucht den Schnee an die Kanten) und die Decke
// liegt hoeher - beides aus demselben Profil, damit Aufwehung und Nachschub
// zusammengehren.
function depositGround(flake) {
  ensureGroundColumns();
  const cols = state.ground.columns;
  if (!cols.length) return;
  const center = Math.floor(flake.x / CONFIG.groundColumnWidth);
  const width = Math.max(1, Math.ceil(flake.size / 2) * 2);
  const amount = CONFIG.groundDepositPerFlake * (flake.size / 10);
  for (let i = -width; i <= width; i += 1) {
    const idx = center + i;
    if (idx < 0 || idx >= cols.length) continue;
    const falloff = Math.exp(-Math.abs(i) / CONFIG.groundSmoothing);
    const ceiling = groundCeiling(idx);
    if (cols[idx] < ceiling) {
      const wind = 1 + (CONFIG.groundCornerRise / CONFIG.groundMaxHeight) * edgeProfile(idx);
      cols[idx] += amount * falloff * wind;
    }
  }
}

// Glattlaufen wie das smoothAccumulation() des Vorbilds: jede Spalte zieht
// gegen das Mittel ihrer Nachbarn, Huegel und Luecken wandern sanft.
function smoothGround() {
  const cols = state.ground.columns;
  if (!cols || cols.length < 3) return;
  for (let i = 1; i < cols.length - 1; i += 1) {
    cols[i] = (cols[i - 1] + cols[i] + cols[i + 1]) / 3;
  }
}

// Dunkel-Modus: dieselbe Kuehlung, die die Div-Wehe einst in skins.css
// trug. JE Frame gelesen, nicht einmal beim start(): der Wechsel zwischen
// Hell und Dunkel ist ein Attribut-Dreh ohne Reload, und eine beim Start
// gezogene Farbe stuende danach falsch herum an der Wehe.
function groundDark() {
  const root = document.documentElement;
  if (root.dataset.theme === 'light') return false;
  if (root.dataset.theme === 'dark') return true;
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

// Jede Frame auf die Leinwand - als EIN zusammenhaengender Pfad, nicht als
// einzelne Spalten-Rechtecke: zwei aneinandergrenzende fillRect bekommen
// JEDE Kante einzeln anti-aliasiert, und an der geteilten Kante zweier
// Spalten bleibt eine halbtransparente Haarlinie - das las sich als
// hellgrauer Umriss um jede Spalte. Ein einzelner gefuellter Pfad hat
// keine inneren Kanten und damit keine Naht. Die Treppe ueber die Spalten-
// Hoehen bleibt: ein Zug pro Spaltenrand.
function drawGround(ctx) {
  const cols = state.ground.columns;
  if (!cols) return;
  const shown = state.ground.shown;
  if (shown < 0.5) return;
  const colW = CONFIG.groundColumnWidth;
  ctx.fillStyle = groundDark() ? '#E9EFF7' : CONFIG.flakeColor;
  ctx.beginPath();
  ctx.moveTo(0, state.height);
  for (let i = 0; i < cols.length; i += 1) {
    const h = Math.min(cols[i], shown);
    ctx.lineTo(i * colW, state.height - h);
    ctx.lineTo((i + 1) * colW, state.height - h);
  }
  ctx.lineTo(state.width, state.height);
  ctx.closePath();
  ctx.fill();
}

// ── Flocken ─────────────────────────────────────────────────────────────────

function spawnFlake() {
  state.flakes.push({
    x: Math.random() * state.width,
    y: -12,
    size: CONFIG.flakeMinSize + Math.random() * (CONFIG.flakeMaxSize - CONFIG.flakeMinSize),
    speed: CONFIG.flakeMinSpeed + Math.random() * (CONFIG.flakeMaxSpeed - CONFIG.flakeMinSpeed),
    opacity: CONFIG.flakeStartOpacity,
    character: CONFIG.flakeCharacters[(Math.random() * CONFIG.flakeCharacters.length) | 0],
  });
}

function deposit(target, flake) {
  target.level = Math.min(
    CONFIG.capMaxHeight,
    target.level + CONFIG.depositPerFlake * (flake.size / 10),
  );
}

// ── Liegt alles? ────────────────────────────────────────────────────────────

// Es gibt kein Schmelzen mehr: sind alle Hauben (und die Wehe) voll, liegt
// der Schnee - der Nachschub stellt sich dann selbst ein. Ohne jedes Ziel
// und ohne Wehe schneit es weiter, sonst stuerbe der Fall auf einer ziel-
// losen Seite still. Massstab der Wehe ist ihr PEAK: die hoechste Spalte.
function allFull() {
  if (state.targets.size === 0 && !groundActive()) return false;
  for (const t of state.targets.values()) {
    if (t.level < CONFIG.capMaxHeight * 0.98) return false;
  }
  if (groundActive() && groundInteriorPeak() < CONFIG.groundMaxHeight * 0.98) return false;
  return true;
}

// ── Animation ────────────────────────────────────────────────────────────────

function frame(now) {
  if (!state.running || state.reduced) return;
  const dt = Math.min((now - state.lastFrame) / 1000, 0.05);
  state.lastFrame = now;

  // Spawn: Desktop jede Frame eine Flocke, Handy jede N-te. Liegt alles,
  // stellt sich der Nachschub selbst ein (kein Schmelzen mehr).
  if (!allFull()) {
    const rate = window.innerWidth > CONFIG.desktopBreakpoint ? 1 : CONFIG.mobileFrameDivisor;
    if (state.counter % rate === 0) spawnFlake();
  }
  state.counter += 1;

  const ctx = state.ctx;
  ctx.clearRect(0, 0, state.width, state.height);

  // Zielrechtecke einmal pro Frame einsammeln (Scroll geht damit gratis).
  // Ziele, die seit dem letzten Frame keine mehr sind, fliegen gleich mit
  // raus: das Debounce der Umbenennung (scheduleRescan) wartet 150 ms, und
  // so lange darf ein undockender Page-FAB nicht mit der kp-snow-host-
  // Klasse im Flow der FAB-Ebene haengen.
  const rects = [];
  const dropped = [];
  for (const [el, t] of state.targets) {
    if (!el.isConnected || !isEligible(el)) {
      dropped.push([el, t]);
      continue;
    }
    const r = el.getBoundingClientRect();
    if (r.width > 8 && r.height > 8) {
      rects.push({ t, left: r.left, right: r.right, top: r.top });
    }
  }
  for (const [el, t] of dropped) {
    t.cap.remove();
    el.classList.remove('kp-snow-host');
    state.targets.delete(el);
  }

  ctx.fillStyle = CONFIG.flakeColor;
  for (let i = state.flakes.length - 1; i >= 0; i -= 1) {
    const f = state.flakes[i];
    let landed = false;

    f.y += f.speed * dt * 60;
    // Landung auf einer Haube: die Flocke verschwindet, die Haube waechst.
    for (const r of rects) {
      if (f.x >= r.left && f.x <= r.right && f.y >= r.top - CONFIG.capMaxHeight && f.y <= r.top + 8) {
        deposit(r.t, f);
        landed = true;
        break;
      }
    }
    // Landung auf der Boden-Wehe (nur breite Bildschirme): Flocke landet auf
    // der Hoehe IHRER Spalte, nicht auf einer geraden Kante - so entstehen
    // Luecken und Huegel statt einer gleichmaessigen Linie. Decke ist die
    // SPALTEN-Decke (Ecken wehen auf), nicht die flache Basis-Kante.
    if (!landed && groundActive()) {
      ensureGroundColumns();
      const idx = Math.min(
        state.ground.columns.length - 1,
        Math.max(0, Math.floor(f.x / CONFIG.groundColumnWidth)),
      );
      const col = state.ground.columns[idx];
      if (col < groundCeiling(idx) && f.y >= state.height - col) {
        depositGround(f);
        landed = true;
      }
    }
    // Ohne Landeflaeche: unten sanft aufloesen statt einen Boden zu bilden.
    if (!landed && !groundActive() && f.y > state.height - CONFIG.bottomFadeZone) f.opacity *= 0.9;

    if (landed || f.opacity < 0.04 || f.y > state.height + 20) {
      state.flakes.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = f.opacity;
    ctx.font = `${f.size}px sans-serif`;
    ctx.fillText(f.character, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  // Wehe: jede Frame glaetten und zeichnen. shown steigt weich auf den
  // Peak - ein harter Sprung beim ersten Flocken-Fall wuerde die Huegel
  // als Ganzes aus dem Boden stampfen. Unter der Geraetegrenze faellt sie
  // nicht mehr auf 0 (das Band ist einfach aus, groundActive() regelt das
  // oben) - ein Geraetewechsel raeumt beim resizeCanvas neu auf.
  smoothGround();
  if (groundActive()) {
    state.ground.shown += (groundPeak() - state.ground.shown) * CONFIG.capGrowEase;
    drawGround(ctx);
  }

  // Angezeigte Haubenhoehe der Ist-Hoehe weich nachfuehren lassen.
  for (const t of state.targets.values()) {
    t.shown += (t.level - t.shown) * CONFIG.capGrowEase;
    const next = Math.max(t.shown, 0);
    if (Math.abs(next - t.applied) > 0.25 || (next === 0 && t.applied !== 0)) {
      t.applied = next;
      t.cap.style.height = `${next.toFixed(2)}px`;
    }
  }

  // Dasselbe fuer die Wehe: unterhalb der Geraetegrenze faellt sie auf 0.
  const g = state.ground;
  if (g.el) {
    g.shown += ((groundActive() ? g.level : 0) - g.shown) * CONFIG.capGrowEase;
    const gnext = Math.max(g.shown, 0);
    if (Math.abs(gnext - g.applied) > 0.25 || (gnext === 0 && g.applied !== 0)) {
      g.applied = gnext;
      g.el.style.height = `${gnext.toFixed(2)}px`;
    }
  }

  state.rafId = requestAnimationFrame(frame);
}

// ── Start/Stop ───────────────────────────────────────────────────────────────

export function start() {
  if (state.running) return;
  // theme-init.js laeuft im <head>, bevor ein <body> existiert.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => start(), { once: true });
    return;
  }
  state.running = true;
  state.reduced = prefersReducedMotion();
  state.lastFrame = performance.now();
  registerTargets();

  // SPA: der Router ersetzt Seiteninhalte, der Beobachter bringt neue Ziele
  // (und raeumt alte ab), ohne dass jemand hier etwas anmelden muesste.
  state.observer = new MutationObserver(scheduleRescan);
  state.observer.observe(document.body, { childList: true, subtree: true });

  state.onResize = () => {
    if (state.canvas) resizeCanvas();
    rescan();
  };
  window.addEventListener('resize', state.onResize);

  state.onVisibility = () => {
    if (state.reduced) return;
    if (document.hidden) {
      cancelAnimationFrame(state.rafId);
      state.rafId = 0;
    } else if (state.running) {
      state.lastFrame = performance.now();
      state.rafId = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', state.onVisibility);

  if (state.reduced) return; // Statische Hauben, kein Regen, kein rAF.

  ensureOverlay();
  ensureGroundColumns();
  state.rafId = requestAnimationFrame(frame);
}

export function stop() {
  state.running = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  state.rafId = 0;
  clearTimeout(state.rescanTimer);
  if (state.observer) state.observer.disconnect();
  state.observer = null;
  if (state.onResize) window.removeEventListener('resize', state.onResize);
  state.onResize = null;
  if (state.onVisibility) document.removeEventListener('visibilitychange', state.onVisibility);
  state.onVisibility = null;
  for (const [el, t] of state.targets) {
    t.cap.remove();
    el.classList.remove('kp-snow-host');
    el.classList.remove('kp-snow-shake', 'kp-snow-shake-done');
    el.removeEventListener('pointerdown', onShakePress);
  }
  state.targets.clear();
  state.flakes.length = 0;
  state.counter = 0;
  if (state.overlay) state.overlay.remove();
  state.overlay = null;
  state.canvas = null;
  state.ctx = null;
  // Die Wehen-Pegel zaehlt stop() bewusst mit zurueck, damit ein erneutes
  // start() bei 0 beginnt.
  state.ground.columns = null;
  state.ground.shown = 0;
}

// Router und theme-init greifen ueber dieses Handle zu, ohne das Modul zweimal
// importieren zu muessen: nach dem ersten dynamischen Import kennt das Fenster
// start/stop, und der Wechsel zurueck auf default/Middle-earth kann abbauen.
if (typeof window !== 'undefined') {
  window.__kpSnow = { start, stop };
}
