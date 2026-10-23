/**
 * Modul: Rezepte (Recipes)
 * Zweck: Gespeicherte Rezepte verwalten und in den Essensplan uebernehmen
 */

import { api } from '/api.js';
import { t, formatDate, formatDateInput, parseDateInput, isDateInputValid } from '/i18n.js';
import { esc } from '/utils/html.js';
import { openModal as openSharedModal, closeModal as closeSharedModal, advancedSection, wireBlurValidation, reportFieldError, refocusAfterRender } from '/components/modal.js';
import { DEFAULT_CATEGORY_NAME } from '/utils/shopping-categories.js';
import { renderKitchenTabsBar } from '/utils/kitchen-tabs.js';
import { resolveShoppingTarget, announceTransfer, mayTransferRecipeToShopping } from '/utils/kitchen-transfer.js';
import { popoverMenuHtml, installPopoverMenus } from '/utils/popover-menu.js';
import { ingredientRowHTML } from '/utils/ingredient-row.js';
import { scheduleUndoableDelete, expandIn, collapseOut } from '/utils/ux.js';
import { normalizeRecipeMealTypes, RECIPE_MEAL_TYPE_KEYS } from '/utils/recipe-meal-types.js';
import { RECIPE_DIET_KEYS, recipeDietLabelKey } from '/utils/recipe-diets.js';
import { NUTRIENTS } from '/utils/health-nutrition.js';
import { mealPayloadFromRecipe } from '/utils/recipe-to-meal.js';
import { todayKey } from '/utils/date.js';
import '/components/datepicker.js';
import { renderSkeletonList } from '/utils/skeleton.js';
import { mountEmptyState, mountLoadError } from '/utils/empty-state.js';
import { renderPageSearch, wirePageSearch } from '/utils/page-search.js';
import { mealTypeList, ensureMealTypeNames } from '/utils/meal-types.js';
import { recipeThumbEl } from '/utils/recipe-thumb.js';
import { navModuleAccess } from '/permissions.js';
import { mountMasterDetail, splitViewDetailHtml, detailPaneHeaderEl } from '/utils/master-detail.js';
import { attachOverlay, dropOverlay } from '/utils/overlay-history.js';

let _container = null;
/** Handle des geteilten Suchfelds (setValue/clear), gesetzt in render(). */
let _search = null;
/** Handle von Liste + Detail (utils/master-detail.js), gesetzt in render(). */
let _md = null;
/* Das offene Rezept-Vollbild ({ id, overlay, body, overlayToken, onKeydown,
 * trigger }) oder null - ein Handle je Seite, ein zweites Oeffnen raeumt das
 * erste ab (openRecipeFullscreen). */
let _fullscreen = null;

/* TEILWAHL DER ZUTATEN FUER DEN EINKAUF (2026-10-21): je Rezept die IDs der
 * angekreuzten Zeilen. Die Checkboxen stehen nur auf der Seite (Aufklapper
 * und Detailspalte) - beide teilen dieselbe Karte, damit die Auswahl nie
 * auseinanderlaeuft; das Vollbild zeigt weder Checkboxen noch den Knopf.
 * Karte statt Felder am Markup: renderIngredientSections() baut jeden
 * Abschnitt neu (Vorrats-Zuordnung speichern), und die Kaetzchen lesen ihre
 * Markierung aus der Karte zurueck, nicht aus sich selbst.
 * SELBSTHEILUNG: ein PUT ersetzt die Zutatenzeilen samt IDs. selected-
 * IngredientIds() schneidet die Auswahl am Bestand zurueck, statt IDs zu
 * senden, die kein Rezept mehr hergibt - der Server wiese sie mit 400 zurueck,
 * und der Nutzer haette nichts dafuer getan. */
const _selectedIngredients = new Map();

/** Die gewaehlten IDs eines Rezepts, am Bestand geschnitten (Selbstheilung). */
function selectedIngredientIds(recipe) {
  const stored = _selectedIngredients.get(Number(recipe.id));
  if (!stored?.size) return [];
  const existing = new Set((recipe.ingredients ?? [])
    .map((i) => Number(i?.id))
    .filter(Number.isFinite));
  const alive = [...stored].filter((v) => existing.has(v));
  if (alive.length !== stored.size) {
    if (alive.length) {
      stored.clear();
      for (const v of alive) stored.add(v);
    } else {
      _selectedIngredients.delete(Number(recipe.id));
    }
  }
  return alive;
}

/** Ein Kaetzchen an/aus - leer bleibt keine leere Menge in der Karte. */
function toggleIngredientSelection(recipeId, ingredientId, checked) {
  const key = Number(recipeId);
  if (!Number.isFinite(key)) return;
  if (checked) {
    if (!_selectedIngredients.has(key)) _selectedIngredients.set(key, new Set());
    _selectedIngredients.get(key).add(Number(ingredientId));
  } else {
    const set = _selectedIngredients.get(key);
    if (!set) return;
    set.delete(Number(ingredientId));
    if (!set.size) _selectedIngredients.delete(key);
  }
}

/** Die Auswahl eines Rezepts verwerfen - nach jedem erfolgreichen Transfer. */
function clearIngredientSelection(recipeId) {
  _selectedIngredients.delete(Number(recipeId));
}

/** Beschriftung des Einkaufsknopfs: „Alles", solange nichts gewaehlt ist. */
function shoppingButtonLabel(recipe) {
  const n = selectedIngredientIds(recipe).length;
  return n > 0
    ? t('recipes.toShoppingSelected', { count: n })
    : t('recipes.toShoppingAll');
}

/** Alle Einkaufsknoepfe eines Rezepts (Aufklapper UND Spalte) auf die Auswahl. */
function updateShoppingButtons(recipe) {
  const label = shoppingButtonLabel(recipe);
  for (const btn of _container?.querySelectorAll(
    `[data-action="to-shopping"][data-id="${recipe.id}"]`) ?? []) {
    btn.textContent = label;
  }
}

const state = {
  recipes: [],
  categories: [],
  // Einkaufslisten für „Auf die Einkaufsliste": nur die Auswahl, keine Artikel.
  lists: [],
  query: '',
  /** Gefangener Fehler des letzten Rezept-Ladevorgangs, sonst null. */
  loadError: null,
  // 'all' | 'native' | 'mealie' | 'tandoor' | ... - Filter-Pille ist nur
  // sichtbar, sobald mindestens ein gespiegeltes Rezept existiert (siehe
  // renderSourceFilter).
  sourceFilter: 'all',
  // Rezept-IDs, die im Wochenplan der AKTUELLEN Woche stehen (loadPlannedRecipes).
  plannedRecipeIds: new Set(),
};

// Client-seitige Suche über Titel, Notizen, Zutaten, Küche und Diet (Audit A1-21):
// die Rezeptliste ist vollständig geladen, ein Server-Roundtrip wäre Umweg.
function filteredRecipes() {
  const q = state.query.toLowerCase();
  return state.recipes.filter((r) => {
    if (state.sourceFilter !== 'all' && r.source !== state.sourceFilter) return false;
    if (!q) return true;
    return r.title?.toLowerCase().includes(q)
      || r.notes?.toLowerCase().includes(q)
      || (r.ingredients ?? []).some((i) => i.name?.toLowerCase().includes(q))
      || r.cuisine?.toLowerCase().includes(q)
      || (r.diet ?? []).some((d) => String(d).toLowerCase().includes(q));
  });
}

function mealCategories() {
  return state.categories.filter((c) => c.name !== 'Haushalt' && c.name !== 'Drogerie');
}

// Kleines Badge für gespiegelte Rezepte (source: 'mealie'/'tandoor'/...). Der
// Account-Name als Tooltip hilft bei mehreren Accounts desselben Providers zu
// unterscheiden.
function sourceBadge(recipe) {
  const badge = document.createElement('span');
  badge.className = `source-badge source-badge--${recipe.source}`;
  badge.textContent = t(`recipes.source${recipe.source[0].toUpperCase()}${recipe.source.slice(1)}`);
  if (recipe.provider_account_name) badge.title = recipe.provider_account_name;
  return badge;
}

// Vorschaubild fuer ein gespiegeltes Rezept. Die beiden Faelle - kein Bild beim
// Provider, Bild seit dem letzten Sync verschwunden - stehen samt Begruendung in
// utils/recipe-thumb.js; seit #1059 zeigen auch Planer und Uebersichtskachel
// dasselbe Bild und teilen sich denselben Ruecksturz.
function recipeThumb(recipe) {
  return recipeThumbEl({
    recipeId: recipe.id,
    hasImage: recipe.provider_has_image,
    hasOwnImage: recipe.has_own_image,
    className: 'recipe-row__thumb',
  });
}

function mealTypeOptions() {
  return mealTypeList().map(({ key, label }) => ({ key, label }));
}

/**
 * Der Ladefehler bleibt im Modul, statt aus `render()` heraus zu propagieren.
 *
 * Vorher hatte diese Funktion als einzige der vier Küchen-Loader kein
 * try/catch: ein HTTP 500 auf `/recipes` riss die gesamte App in den globalen
 * Fehlerbildschirm - Navigation weg, die drei anderen Tabs unerreichbar, obwohl
 * nur eine Liste fehlte (Critique P0, 2026-07-30). Ein Modul, das seine Daten
 * nicht bekommt, darf höchstens sich selbst verlieren.
 */
async function loadRecipes() {
  try {
    const res = await api.get('/recipes');
    state.recipes = res.data ?? [];
    state.loadError = null;
  } catch (err) {
    console.error('[Recipes] loadRecipes Fehler:', err);
    state.recipes = [];
    state.loadError = err;
  }
}

async function loadCategories() {
  try {
    const res = await api.get('/shopping/categories');
    state.categories = res.data;
  } catch {
    state.categories = [];
  }
}

// Ist das Einkaufsmodul deaktiviert oder gibt es keine Liste, bleibt state.lists
// leer und die Karte zeigt die Übernahme-Aktion gar nicht erst an.
async function loadShoppingLists() {
  if (window.yuvomi?.isModuleDisabled?.('shopping')) {
    state.lists = [];
    return;
  }
  try {
    const res = await api.get('/shopping');
    state.lists = res.data ?? [];
  } catch {
    state.lists = [];
  }
}

// „Diese Woche geplant": die Rezepteliste kannte ihren eigenen Wochenplan
// nicht - die Verbindung der beiden Kuechen-Raeume war nur im Meals-Tab
// sichtbar, und die Liste las sich als kontextlose CRUD-Ablage (Critique
// 2026-08-27, P2). Die Zuordnung steht laengst in meals.recipe_id; der Server
// liefert ohne week-Parameter die aktuelle Woche. Ein Fehler laesst die
// Angabe schlicht weg - die Liste haengt nicht an ihr.
async function loadPlannedRecipes() {
  if (window.yuvomi?.isModuleDisabled?.('meals')) {
    state.plannedRecipeIds = new Set();
    return;
  }
  try {
    const res = await api.get('/meals');
    state.plannedRecipeIds = new Set((res.data ?? []).map((m) => m.recipe_id).filter(Boolean));
  } catch {
    state.plannedRecipeIds = new Set();
  }
}

/**
 * Oeffnet das per ?open=<id> benannte Rezept, wenn es in der geladenen Liste steht.
 *
 * Aufklappen statt Bearbeiten: wer aus dem Essensplan kommt, will kochen, nicht
 * aendern - dieselbe Entscheidung wie beim Antippen einer Zeile.
 *
 * Ein Rezept ohne Detailinhalt (keine Zutaten, keine Notiz, keine Quelle) hat
 * gar kein Aufklapp-Panel. Dann bleibt das Scrollen als das, was zu holen ist:
 * die Zeile zeigen, statt still nichts zu tun.
 */
function openRecipeFromQuery() {
  const raw = new URLSearchParams(window.location.search).get('open');
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(id)) return;

  const row = _container?.querySelector(`.recipe-row-item[data-id="${id}"]`);
  if (!row) return;

  // In der Detailspalte hat der Baustein das Rezept beim Einhaengen schon
  // ausgewaehlt - er liest denselben Parameter (`param: 'open'` in
  // mountRecipeDetail). Aufzuklappen gibt es dort nichts: die Liste zeigt
  // keine Aufklapper, das Detail steht rechts.
  if (_md?.isSplit()) {
    row.scrollIntoView({ block: 'nearest' });
    return;
  }

  const toggle = row.querySelector('[data-action="toggle-detail"]');
  const panel = _container.querySelector(`#recipe-detail-${id}`);
  if (toggle && panel) {
    toggle.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
  }
  row.scrollIntoView({ block: 'nearest' });
}

export async function render(container, { signal } = {}) {
  _container = container;
  _md = null;

  // `state` ueberlebt den Seitenwechsel. Wer zuletzt nach "Suppe" gesucht oder
  // auf Mealie gefiltert hat, kaeme sonst per Deep-Link auf eine Liste zurueck,
  // in der das verlangte Rezept gar nicht steht - und der Sprung endete
  // wortlos im Nichts. Ein benanntes Ziel schlaegt einen alten Filter, also
  // faellt der weg, und zwar VOR dem Bau des Suchfelds, damit die Zeile darueber
  // nicht einen Begriff zeigt, nach dem die Liste nicht mehr filtert (#936).
  if (new URLSearchParams(window.location.search).has('open')) {
    state.query = '';
    state.sourceFilter = 'all';
  }

  const page = document.createElement('div');
  // `app-page--list-detail`: Regime „Liste + Detail" der Breitenregel
  // (DESIGN.md). Unter der Schwelle bleibt es Lesemass, ab 65rem Modulflaeche
  // steht rechts das ausgewaehlte Rezept (utils/master-detail.js).
  page.className = 'recipes-page app-page app-page--reading app-page--list-detail page-measure--narrow';
  page.dataset.composition = 'reading';

  // sr-only Titel: die geteilte Kitchen-Tabs-Leiste labelt das Modul bereits
  // sichtbar — konsistent mit Mahlzeiten/Einkauf. Der FAB ist die einzige
  // Create-Affordanz (kein redundanter sichtbarer Kopf-Titel mehr).
  const title = document.createElement('h1');
  title.className = 'sr-only';
  title.textContent = t('nav.recipes');

  // Suchfeld über der Liste: Rezepte waren als einziges Kitchen-Modul nicht
  // durchsuchbar (Audit A1-21).
  // Kanonischer Kopf in der Gruppen-Variante: --in-group gibt Akzentstreifen und
  // oberste Sticky-Position an die .kitchen-tabs-bar darüber ab, die beides schon
  // trägt. Genau der Doppelstreifen aus Issue #577 war der Grund, warum diese
  // Zeile vorher als eigene .recipes-toolbar gebaut war - mit dem Ergebnis, dass
  // alle vier Küchen-Tabs eine andere Kopf-Grammatik hatten (Critique
  // 2026-07-29). Die Variante löst den Konflikt, ohne den Kopf zu meiden.
  const toolbar = document.createElement('div');
  // Kein --narrow (Re-Critique 2026-09-27, D3): der Kuechenkopf gehoert der
  // Kuechen-Leiste und endet an ihrer Kante wie in den drei Geschwister-Tabs -
  // sonst sprang die angedockte Primaeraktion beim Tabwechsel zwischen
  // Lesemass (x 865) und Leistenkante (x 1288). Test: test-meals.js (D3).
  toolbar.className = 'page-toolbar page-toolbar--in-group';
  // Geteilter Baustein (utils/page-search.js) statt eines eigenen Inputs. Er
  // bringt Lupe, Leeren-Knopf, `<label for>` und die mobilen Eingabe-Attribute
  // mit; der Nachbau hatte keines davon und ließ den Placeholder die
  // Beschriftung tragen, die beim ersten Zeichen verschwindet.
  // Die Suche IST der Center-Slot (Re-Critique 2026-09-27, D4): Breite und
  // Stelle traegt page-search.css, wie in Dokumenten - kein Wrapper, keine
  // Modulbreite.
  toolbar.insertAdjacentHTML('beforeend', renderPageSearch({
    id: 'recipes-search',
    // Label und Placeholder aus demselben Key, wie im Vorrat und in den drei
    // Referenzmodulen: „Rezepte durchsuchen" benennt das Feld vollständig.
    label: t('recipes.searchPlaceholder'),
    placeholder: t('recipes.searchPlaceholder'),
    value: state.query,
    clearLabel: t('common.searchClear'),
    className: 'recipes-search page-toolbar__center',
  }));

  // Trigger im __actions-Slot statt einer eigenen Pillen-Zeile darunter -
  // dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat (btn--icon im
  // Kopf, kein zusätzliches Kopf-Element). Die frühere Chip-Reihe brauchte auf
  // schmalen Bildschirmen eine ganze eigene Zeile, nur für drei Optionen, von
  // denen fast immer "Alle" aktiv ist. Nur sichtbar, sobald mindestens ein
  // gespiegeltes Rezept existiert (renderSourceFilter füllt/versteckt sie nach
  // dem Laden).
  //
  // SLOT UND FILTER SIND ZWEI KNOTEN. In `.page-toolbar__actions` dockt der
  // Router auf dem Desktop den FAB an (dockFabIntoToolbar in router.js). Solange
  // der Slot selbst der Filter war, stand der „Neues Rezept"-Knopf ohne
  // gespiegelte Rezepte in einem `hidden`-Container, und mit ihnen warf
  // renderSourceFilter() ihn per replaceChildren() aus dem DOM. Der Slot wird
  // deshalb nie ausgeblendet und nie geleert; der Filter hat seinen eigenen
  // Container darin (test:hidden-cascade haelt beides).
  const actions = document.createElement('div');
  actions.className = 'page-toolbar__actions';
  const sourceFilter = document.createElement('div');
  sourceFilter.className = 'recipes-source-filter';
  sourceFilter.id = 'recipes-source-filter';
  sourceFilter.hidden = true;
  actions.appendChild(sourceFilter);
  toolbar.appendChild(actions);

  const list = document.createElement('div');
  list.className = 'list-scroller page-scrollport recipes-list split-view__list';
  list.id = 'recipes-list';
  // Lade-Skeleton bis loadRecipes() aufgelöst ist (Router blendet den Wrapper
  // bereits vor dem Daten-await ein).
  list.setAttribute('aria-busy', 'true');
  list.insertAdjacentHTML('beforeend', renderSkeletonList({ rows: 5, lines: 2 }));
  // Kein wireScrollFade mehr: die Liste kachelt nicht länger mit 320px-Mindest-
  // breite, sondern ist eine Zeilenliste in der 720er-Lesespalte. Der frühere
  // 32px-Überlauf bei 320px war eine Eigenschaft des Rasters und ist mit ihm weg.

  const fab = document.createElement('button');
  fab.className = 'page-fab';
  fab.type = 'button';
  fab.id = 'fab-new-recipe';
  fab.setAttribute('aria-label', t('recipes.addRecipe'));
  fab.dataset.dockLabel = t('newLabel.recipes');
  const fabIcon = document.createElement('i');
  fabIcon.dataset.lucide = 'plus';
  fabIcon.setAttribute('aria-hidden', 'true');
  fab.appendChild(fabIcon);

  // Liste + Detail: der Scrollport wird `.split-view__list` und steht mit der
  // Detailspalte in einer Huelle an seinem bisherigen Platz. Unter der
  // Schwelle ist die Spalte `display: none` und die Huelle eine Flex-Spalte -
  // die Liste steht wie vorher. Der Kuechenkopf (kitchen-tabs) sitzt ausserhalb
  // der Seitenwurzel und laeuft damit ueber beide Spalten.
  const split = document.createElement('div');
  split.className = 'split-view';
  split.appendChild(list);
  split.insertAdjacentHTML('beforeend', splitViewDetailHtml({
    id: 'recipes',
    label: t('recipes.detailPaneLabel'),
    empty: { icon: 'book-text', title: t('recipes.pickOne'), hint: t('recipes.pickOneHint') },
  }));

  page.append(title, toolbar, split, fab);
  container.replaceChildren(page);
  renderKitchenTabsBar(container, '/recipes');
  // Positionierung und Schliessen der Zeilen-Ueberlaufmenues. Idempotent, haengt an
  // der stabilen Seitenwurzel - die Liste darin wird bei jedem Filter neu gebaut.
  installPopoverMenus(page);

  if (window.lucide) window.lucide.createIcons({ el: container });

  await Promise.all([loadRecipes(), loadCategories(), loadShoppingLists(), loadPlannedRecipes(), ensureMealTypeNames()]);
  // Ein Seitenwechsel waehrend des Ladens: die Seite ist schon abgebaut, ein
  // Einhaengen jetzt schriebe in eine fremde Adresse.
  if (signal?.aborted || !page.isConnected) return;
  renderSourceFilter();
  // VOR dem ersten Listenbau: der Baustein loest `?open=` beim Einhaengen ein
  // und braucht dafuer die geladenen Rezepte, nicht die Zeilen -
  // renderRecipeList() setzt danach die Markierung (refresh).
  _md = mountRecipeDetail(split, signal);
  renderRecipeList();

  // Deep-Link: ?open=<id> klappt das Rezept auf und scrollt es ins Bild.
  // Dieselbe Schreibweise wie in Kontakten und auf der Startseite, damit nicht
  // jedes Modul seinen eigenen Parameter erfindet.
  //
  // Gebraucht wird er von den Essenskarten (#936): ein Essen liess sich mit
  // einem Rezept verknuepfen, aber die Verknuepfung hatte keinen Ausgang - der
  // Aktionsknopf gab es nur fuer eine externe `recipe_url`, nicht fuer ein
  // Rezept aus dem eigenen Haus.
  openRecipeFromQuery();

  fab.addEventListener('click', () => openRecipeModal('create'));

  // Handle im Modul halten: der Zurücksetzen-Pfad des Suchtreffer-Leerzustands
  // braucht `clear()`, nicht nur `input.value = ''` - sonst bliebe der
  // Leeren-Knopf über einem leeren Feld stehen.
  _search = wirePageSearch(toolbar, {
    id: 'recipes-search',
    onQuery: (value) => {
      state.query = value.trim();
      renderRecipeList();
    },
  });

  // An der Huelle, nicht an der Liste: die Kreislauf-Ausgaenge und die
  // Vorrats-Zuordnung stehen in der Spalten-Darstellung in der Detailspalte,
  // mit denselben `data-action`-Knoepfen wie im Aufklapper - und im Vollbild
  // (openRecipeFullscreen) haengt derselbe Delegierte am Overlay.
  split.addEventListener('click', async (e) => {
    // Der Hauptknopf der Zeile: in der Spalte waehlt er aus, darunter klappt
    // er auf oder oeffnet das Formular - der Baustein entscheidet ueber open().
    const main = e.target.closest('.recipe-row__toggle');
    if (main && list.contains(main)) {
      if (_md) _md.open(main.dataset.id, main);
      else openRecipeNarrow(main.dataset.id, main);
      return;
    }

    await handleDetailAction(e);
  });

  // DIE CHECKBOXEN DER TEILWAHL laufen ueber change an derselben Huelle wie
  // die Knöpfe: Aufklapper und Detailspalte haengen beide darin, und ein
  // Handler je Kaetzchen verstünde den Neuaufbau (renderIngredientSections)
  // nicht. Der Vollbild-Abschnitt traegt keine Checkboxen - hier findet sein
  // Neuaufbau nie ein Ziel.
  split.addEventListener('change', (e) => {
    const check = e.target?.closest?.('.recipe-detail__ingredient-check');
    if (!check) return;
    const section = check.closest('.recipe-detail__ingredients-section');
    const recipeId = Number(section?.dataset.recipeId);
    const ingredientId = Number(check.getAttribute('data-ingredient-id'));
    if (!recipeId || !ingredientId) return;
    const recipe = state.recipes.find((r) => r.id === recipeId);
    if (!recipe) return;
    toggleIngredientSelection(recipeId, ingredientId, check.checked);
    updateShoppingButtons(recipe);
  });

  // Kein eigener keydown-Handler mehr: das Aufklappen sitzt auf einem echten
  // <button>, der Enter und Space von sich aus verarbeitet. Der frühere Handler
  // gehörte zur Karte, die role="button" trug und damit ein Bedienelement mit
  // Bedienelementen darin war.
}

// Mehrwege-Filter (Alle/Nativ/pro Provider) als Trigger + Popover-Menü im
// __actions-Slot, dieselbe Behandlung wie „Lagerorte verwalten" im Vorrat -
// ein btn--icon im Kopf statt einer eigenen Zeile, die auf schmalen
// Bildschirmen für wenige Optionen (fast immer "Alle" aktiv) eine ganze
// Kopf-Zeile kostete. Bleibt versteckt, solange kein Provider-Account
// gespiegelte Rezepte liefert - der Filter wäre sonst leere Ornamentik.
function renderSourceFilter() {
  const el = _container.querySelector('#recipes-source-filter');
  if (!el) return;

  const hasMirrored = state.recipes.some((r) => r.source !== 'native');
  if (!hasMirrored) {
    el.hidden = true;
    state.sourceFilter = 'all';
    return;
  }

  el.hidden = false;
  const options = [
    { value: 'all', label: t('recipes.sourceAll') },
    { value: 'native', label: t('recipes.sourceNative') },
    ...[...new Set(state.recipes.map((r) => r.source).filter((s) => s !== 'native'))].sort().map((s) => ({
      value: s, label: t(`recipes.source${s[0].toUpperCase()}${s.slice(1)}`),
    })),
  ];
  const activeLabel = options.find((o) => o.value === state.sourceFilter)?.label ?? '';

  el.replaceChildren();
  el.insertAdjacentHTML('beforeend', `
    <button type="button" class="btn btn--ghost btn--icon popover-menu__trigger"
            popovertarget="recipes-source-filter-menu" aria-haspopup="menu" aria-expanded="false"
            aria-label="${esc(t('recipes.sourceFilterLabel'))}: ${esc(activeLabel)}"
            title="${esc(t('recipes.sourceFilterLabel'))}: ${esc(activeLabel)}">
      <i data-lucide="filter" class="icon-md" aria-hidden="true"></i>
    </button>
    <div class="popover-menu recipes-source-filter-menu" id="recipes-source-filter-menu" popover role="menu"
         aria-label="${esc(t('recipes.sourceFilterLabel'))}">
      ${options.map((opt) => {
        const active = state.sourceFilter === opt.value;
        return `
          <button type="button" role="menuitemradio" aria-checked="${active}"
                  class="popover-menu__item" data-source-value="${esc(opt.value)}">
            <i data-lucide="check" class="icon-md popover-menu__item-check${active ? '' : ' popover-menu__item-check--hidden'}" aria-hidden="true"></i>
            <span>${esc(opt.label)}</span>
          </button>`;
      }).join('')}
    </div>`);

  for (const btn of el.querySelectorAll('[data-source-value]')) {
    btn.addEventListener('click', () => {
      const value = btn.dataset.sourceValue;
      if (state.sourceFilter === value) return;
      state.sourceFilter = value;
      renderSourceFilter();
      renderRecipeList();
    });
  }
  if (window.lucide) window.lucide.createIcons({ el });
}

/**
 * Baut die Liste neu und gleicht danach Liste + Detail ab - auf JEDEM Weg,
 * auch dem Leer-, Fehler- und Kein-Treffer-Zustand: sonst stuende rechts ein
 * Rezept, das die Liste links gerade nicht mehr zeigt.
 *
 * `repaint` nach dem Speichern: das Detail rechts zeigte sonst den Stand vor
 * dem Formular.
 */
function renderRecipeList({ repaint = false } = {}) {
  buildRecipeList();
  syncRowMode();
  _md?.refresh({ repaint });
  // Das Vollbild steht ausserhalb der Spaltenwurzel: ein Neuaufbau der Liste
  // haelt es mit (sonst zeigte es den Stand vor dem Speichern im Formular).
  refreshFullscreenDetail();
}

/* LISTE + DETAIL (Breitenregel, Regime 2 - DESIGN.md)
 *
 * Ab 65rem Modulflaeche steht links die Liste, rechts das ausgewaehlte Rezept
 * mit eigenem Kopf (Titel, Bearbeiten, Duplizieren, Loeschen) und dem
 * Aufklapper-Inhalt darunter - wie Notizen und Erinnerungen auf dem Mac.
 * Darunter bleibt alles, wie es war: die Zeile klappt auf, und ein Rezept
 * ohne Detail oeffnet das Formular.
 *
 * DER PARAMETER IST `open` (Standard des Bausteins, hier ausdruecklich).
 * `/recipes?open=<id>` ist der Deep-Link, den die Essenskarten schon setzen
 * (#936). Die Auswahl schreibt
 * dieselbe Schreibweise, damit ein Rezept genau EINE Adresse hat - ein
 * zweiter Parameter hiesse zwei Adressen fuer dieselbe Sache und einen Link
 * aus dem Essensplan, der rechts nichts auswaehlt.
 */
function mountRecipeDetail(root, signal) {
  const md = mountMasterDetail({
    root,
    param: 'open',
    signal,
    renderDetail: (id, body) => renderRecipePane(id, body),
    openNarrow: (id, trigger) => openRecipeNarrow(id, trigger),
    // Unter der Schwelle loest openRecipeFromQuery() den Link ein, NACH dem
    // Listenbau - beim Einhaengen gibt es noch keine Zeile zum Aufklappen.
    deepLinkNarrow: false,
    // Darunter ist die Zeile ein Aufklapper, kein Blatt: mehrere Rezepte
    // stehen offen, und Aufklappen schreibt keine Adresse.
    narrow: 'accordion',
    // Und bei Zurueck/Vor auf `?open=` (Eintraege aus der Spalte, Fenster
    // inzwischen schmal) dieselbe Einloesung: die Zeilen stehen, der
    // Aufklapper geht auf (Codex an #1477).
    onNarrowSync: () => openRecipeFromQuery(),
  });
  // Der Moduswechsel (Fenster, Seitenleiste) aendert, was der Hauptknopf der
  // Zeile IST: Aufklapper darunter, Auswahl in der Spalte. Seine ARIA-Angaben
  // ziehen hier nach; die Geometrie entscheidet das CSS.
  if (typeof ResizeObserver === 'function') {
    let last = md.isSplit();
    const ro = new ResizeObserver(() => {
      const now = md.isSplit();
      if (now === last) return;
      last = now;
      syncRowMode();
    });
    ro.observe(root);
    signal?.addEventListener('abort', () => ro.disconnect(), { once: true });
  }
  return md;
}

/**
 * Das ausgewaehlte Rezept in der Detailspalte. `false` heisst: diese ID gibt es
 * (nicht mehr) - der Baustein faellt dann auf den Leerzustand zurueck.
 */
function renderRecipePane(id, body) {
  const recipe = state.recipes.find((r) => String(r.id) === String(id));
  if (!recipe) return false;

  const detail = document.createElement('div');
  detail.className = 'recipe-detail recipe-detail--pane';
  fillRecipeDetail(detail, recipe);
  body.replaceChildren(
    detailPaneHeaderEl({ title: recipe.title, actions: detailHeaderActions(recipe) }),
    detail,
  );
  return undefined;
}

/**
 * Die Kopf-Aktionen eines Rezeptdetails - EINE Quelle fuer Spalte und Vollbild,
 * damit beide Koepfe dieselben Ausgaenge fuehren und keine Flaeche eine eigene
 * Version entwickelt, die auseinanderlaufen koennte. Gespiegelte Rezepte sind
 * schreibgeschuetzt (dieselbe Regel wie die Zeilenaktionen).
 *
 * DOPPELTE GEWICHTE IN DER SPALTE: Duplizieren und Loeschen verwalten das
 * Rezept als Datensatz - sie gehoeren an die Liste, ueber der man den
 * Ueberblick behaelt. Das Vollbild ist die Leseflaeche zum Kochen; sein Kopf
 * fuehrt deshalb nur Bearbeiten (gespiegelte Rezepte: keins). Den Schliess-
 * Knopf haengt openRecipeFullscreen selbst an. Ein Rezept, das aus anderem
 * Grund verschwindet (Live-Feed, Loeschen aus der Spalte hinter dem
 * Vollbild), nimmt refreshFullscreenDetail() die Ansicht mit - derselbe Weg,
 * kein zweiter im Kopf.
 */
function detailHeaderActions(recipe, { fullscreen = false } = {}) {
  const isMirrored = recipe.source !== 'native';
  return [
    !isMirrored && {
      label: t('common.edit'), icon: 'pencil', id: fullscreen ? 'recipe-fullscreen-edit' : 'recipes-detail-edit',
      onClick: () => openRecipeModal('edit', recipe),
    },
    !fullscreen && {
      label: t('recipes.fullscreenLabel'), icon: 'maximize', variant: 'ghost', iconOnly: true,
      id: 'recipes-detail-fullscreen',
      onClick: ({ button }) => openRecipeFullscreen(recipe.id, button),
    },
    !fullscreen && {
      label: t('recipes.duplicate'), icon: 'copy', variant: 'ghost', iconOnly: true,
      onClick: () => duplicateRecipe(recipe),
    },
    !fullscreen && !isMirrored && {
      label: t('common.delete'), icon: 'trash-2', variant: 'ghost', iconOnly: true,
      onClick: () => removeRecipe(recipe),
    },
  ].filter(Boolean);
}

/**
 * Ein Klick auf einen `data-action`-Knopf des Detailinhalts: EIN delegierter
 * Handler fuer alle Orte desselben Inhalts - Aufklapper, Detailspalte,
 * Vollbild. Der Zeilen-Hauptknopf gehoert ihm nicht: der entscheidet zwischen
 * Spalte (auswaehlen) und Aufklapper (aufklappen) und bleibt am split-view.
 * Der Zweig 'fullscreen' ist der Ausgang des AUFKLAPPERS (schmale Fenster,
 * Knopf in dessen Kopfleiste): in der Spalte sitzt derselbe Ausgang im Kopf
 * (detailHeaderActions), und das Vollbild selbst hat keinen.
 */
async function handleDetailAction(e) {
  const actionBtn = e.target.closest('[data-action]');
  if (!actionBtn) return;

  const recipeId = Number(actionBtn.dataset.id);
  const recipe = state.recipes.find((r) => r.id === recipeId);
  if (!recipe) return;

  if (actionBtn.dataset.action === 'edit') {
    openRecipeModal('edit', recipe);
    return;
  }

  if (actionBtn.dataset.action === 'delete') {
    await removeRecipe(recipe);
    return;
  }

  if (actionBtn.dataset.action === 'duplicate') {
    await duplicateRecipe(recipe);
    return;
  }

  if (actionBtn.dataset.action === 'to-shopping') {
    await transferRecipe(recipe, actionBtn);
    return;
  }

  if (actionBtn.dataset.action === 'fullscreen') {
    openRecipeFullscreen(recipe.id, actionBtn);
    return;
  }

  if (actionBtn.dataset.action === 'add-to-meals') {
    await planRecipe(recipe, actionBtn);
  }
}

/* VOLLBILD DES REZEPTS - die Leseflaeche ueber der Seite.
 *
 * Die Detailspalte ist schmal, und ein Rezept liest sich beim Kochen besser
 * ohne Liste daneben: der Ausgang im Spaltenkopf (`maximize`) hebt dasselbe
 * Detail auf die ganze Flaeche. Das ist KEIN zweiter Weg zur Information -
 * der Kanon, der openRecipeReadModal einriss, gilt weiter: der Inhalt kommt
 * aus fillRecipeDetail, derselbe Baustein wie im Aufklapper und in der
 * Spalte; nur die Flaeche ist eine andere.
 *
 * Der Kopf fuehrt nur Bearbeiten und Schliessen (detailHeaderActions mit
 * `fullscreen: true` - Duplizieren und Loeschen bleiben an der Liste, wo der
 * Ueberblick ist); der Aktionsknopf im Koerper (Einplanen) laeuft ueber
 * denselben Delegierten (handleDetailAction). Der Einkaufs-Ausgang steht
 * hier NICHT (2026-10-21): die Teilwahl gehoert auf die Seite, wo Aufklapper
 * und Spalte dieselbe Auswahl teilen - das Vollbild ist die Leseflaeche
 * zum Kochen, nicht der Ort, an dem eingekauft wird. Die Zurueck-Geste
 * schliesst das Vollbild statt die Seite zu verlassen (#871), Escape ebenso,
 * der Fokus kehrt zum Ausloeser zurueck, und jeder Neuaufbau der Liste haelt
 * die Ansicht auf dem Stand der Seite (refreshFullscreenDetail).
 */
function openRecipeFullscreen(id, trigger) {
  // Ein vorheriges geht zuerst zu, wie openModal nur ein Modal kennt.
  closeRecipeFullscreen({ focus: false });
  const recipe = state.recipes.find((r) => String(r.id) === String(id));
  if (!recipe) return;

  const overlay = document.createElement('div');
  overlay.className = 'recipe-fullscreen';
  overlay.id = 'recipe-fullscreen';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  // Der Rezepttitel benennt die Ansicht - dasselbe Wort, das im Kopf steht.
  overlay.setAttribute('aria-label', recipe.title);

  const head = detailPaneHeaderEl({
    title: recipe.title,
    actions: [
      ...detailHeaderActions(recipe, { fullscreen: true }),
      {
        label: t('common.close'), icon: 'x', variant: 'ghost', iconOnly: true,
        id: 'recipe-fullscreen-close',
        onClick: () => closeRecipeFullscreen(),
      },
    ],
  });
  head.classList.add('recipe-fullscreen__head');

  const body = document.createElement('div');
  body.className = 'recipe-fullscreen__body';
  fillFullscreenBody(body, recipe);

  overlay.append(head, body);
  document.body.appendChild(overlay);

  const onKeydown = (e) => {
    if (e.key === 'Escape') closeRecipeFullscreen();
  };
  document.addEventListener('keydown', onKeydown);
  // Der Anschluss der Zurueck-Geste (#871): derselbe wie bei den
  // Modul-Overlays nebenan. Das Token meldet closeRecipeFullscreen selbst ab;
  // der Beobachter von attachOverlay faengt jeden anderen Weg, auf dem der
  // Knoten aus dem Dokument faellt.
  const overlayToken = attachOverlay(overlay, () => closeRecipeFullscreen());
  overlay.addEventListener('click', handleDetailAction);

  _fullscreen = {
    id: String(id), overlay, body,
    overlayToken, onKeydown,
    trigger: trigger ?? document.activeElement,
  };
  if (window.lucide) window.lucide.createIcons({ el: overlay });
  overlay.querySelector('#recipe-fullscreen-close')?.focus();
}

/** Der Koerper des Vollbilds: das Detail des Rezepts, wie es Spalte und
 * Aufklapper zeigen - ein Baustein, drei Flaechen.
 *
 * KOCHBUCH-GESTALT: ab 60rem stehen die Zutaten in einer eigenen, ruhigen
 * Spalte links und der Rest (Notizen, Naehrwerte, Planen/Einkauf) rechts -
 * dieselbe Teilung wie ein aufgeschlagenes Kochbuch, jede Flaeche scrollt
 * fuer sich, und eine lange Zutatenliste laeuft nicht vom Zubereitungstext
 * weg. Das geschieht hier durch UMSIEDELN, nicht durch einen zweiten Builder:
 * fillRecipeDetail baut das Detail als Ganzes (der Kanon - keine zweite
 * Quelle fuer denselben Inhalt), und Knoten wandern in die linke Flaeche;
 * renderIngredientSections() sucht den Abschnitt per querySelector und
 * findet ihn in jeder Tiefe weiter.
 *
 * DIE KOPF-ZEILEN WANDERN MIT: die Mahlzeit-Chips und die Angaben zu
 * Portionen, Zeiten, Kueche und Diets stehen im Aufklapper und in der
 * Spalte UEBER den Zutaten - der Kochvorgang liest sich von oben: WANN
 * wird daraus eine Mahlzeit, WIE VIEL Portionen, WIE LANG dauert es, und
 * DANN die Zutaten. Unter 60rem ist die linke Flaeche die ganze Seite;
 * liesse man die Zeilen rechts, stuenden sie UNTER dem, was sie einleiten
 * sollen. Sie wandern deshalb mit den Zutaten zusammen in die linke
 * Flaeche, ueber ihnen - dieselben Klassen, dieselbe Reihenfolge, nur ein
 * anderer Traeger.
 *
 * Ohne Zutaten gibt es keine linke Flaeche: zurueck kommt das Detail allein,
 * und der Koerper bleibt der eine Scrollport im Lesemass.
 */
function recipeFullscreenDetail(recipe) {
  const detail = document.createElement('div');
  detail.className = 'recipe-detail recipe-detail--fullscreen';
  fillRecipeDetail(detail, recipe, { fullscreen: true });

  const ingredients = detail.querySelector('.recipe-detail__ingredients-section');
  if (!ingredients) return detail;

  const left = document.createElement('div');
  left.className = 'recipe-fullscreen__ingredients';
  /* Die Kopf-Zeilen VOR dem Zutaten-Abschnitt sind alles, was die linke
   * Flaeche ausser den Zutaten fuehrt: Mahlzeit-Chips (.recipe-card__meal-types)
   * und die Meta-Zeilen (.recipe-detail__meta). Rueckwaerts sammeln und
   * vorwaerts anhaengen - appendChild vorwaerts abgeraeumt wuerde die
   * Reihenfolge drehen. */
  const headRows = [];
  let node = ingredients.previousElementSibling;
  while (node && (node.classList.contains('recipe-card__meal-types')
    || node.classList.contains('recipe-detail__meta'))) {
    headRows.unshift(node);
    node = node.previousElementSibling;
  }
  for (const row of headRows) left.appendChild(row);
  left.appendChild(ingredients);

  const right = document.createElement('div');
  right.className = 'recipe-fullscreen__rest';
  right.appendChild(detail);

  const panes = document.createDocumentFragment();
  panes.append(left, right);
  return panes;
}

/** Setzt den Koerper des Vollbilds auf ein Rezept und merkt die Gestalt am
 * Koerper an: die Teilung in zwei Flaechen traegt das CSS an der Klasse
 * (`--split`, ab 60rem zwei Spalten mit eigenem Lauf), nicht an einem
 * Zustand, den ein Renderer vergessen koennte. Beide Wege - das Oeffnen und
 * der Neuaufbau (refreshFullscreenDetail) - laufen darueber. */
function fillFullscreenBody(body, recipe) {
  const content = recipeFullscreenDetail(recipe);
  const split = content.nodeType === Node.DOCUMENT_FRAGMENT_NODE;
  body.replaceChildren(content);
  body.classList.toggle('recipe-fullscreen__body--split', split);
}

function closeRecipeFullscreen({ focus = true } = {}) {
  const fs = _fullscreen;
  if (!fs) return;
  _fullscreen = null;
  dropOverlay(fs.overlayToken);
  document.removeEventListener('keydown', fs.onKeydown);
  fs.overlay.remove();
  // Den Ausloeser zurueckholen, wenn er noch steht - ein Renderer kann ihn
  // inzwischen ersetzt haben (dasselbe Warum wie der Fokus-Restore in
  // modal.js: `.focus()` auf einem abgehaengten Knoten ist ein stilles No-op).
  if (focus && fs.trigger?.isConnected) fs.trigger.focus();
}

/**
 * Haelt das offene Vollbild auf dem Stand der Seite. Jeder Neuaufbau der
 * Liste (Speichern im Formular, Filterwahl) zeichnet die Spalte neu - das
 * Vollbild haengt ausserhalb ihrer Wurzel und wuerde sonst den Stand von
 * vor der Aenderung zeigen. Ein Rezept, das die Liste nicht mehr fuehrt,
 * nimmt die Ansicht ganz mit (Loeschen laeuft ueber die Spalte hinter dem
 * Vollbild; dieser Weg faengt jeden anderen ab).
 */
function refreshFullscreenDetail() {
  const fs = _fullscreen;
  if (!fs) return;
  // Ein Renderer oder die Navigation haben das Overlay schon abgeraeumt -
  // nur das Handle steht noch. Sein Token ist dann laengst abgemeldet.
  if (!fs.overlay.isConnected) {
    _fullscreen = null;
    dropOverlay(fs.overlayToken);
    return;
  }
  const recipe = state.recipes.find((r) => String(r.id) === fs.id);
  if (!recipe) {
    closeRecipeFullscreen();
    return;
  }
  fillFullscreenBody(fs.body, recipe);
  if (window.lucide) window.lucide.createIcons({ el: fs.body });
}

/**
 * Unter der Schwelle: der bisherige Weg der Zeile. Aufklappen, wenn es ein
 * Detail gibt, sonst das Formular - ein gespiegeltes Rezept ohne Detail tut
 * nichts (siehe buildRecipeList).
 */
function openRecipeNarrow(id, trigger) {
  const btn = trigger
    ?? _container?.querySelector(`.recipe-row__toggle[data-id="${CSS.escape(String(id))}"]`);
  if (!btn) return;

  // Aufklappen: der Zustand lebt am Button (aria-expanded) und am Panel
  // (hidden). `hidden` statt max-height-Transition, weil ein per Transition
  // versteckter Inhalt in headless-Renderern und auf inaktiven Tabs nie
  // erscheint - der Reveal muss einen sichtbaren Default verbessern, nicht
  // Sichtbarkeit an eine Animation binden.
  // BEWEGUNG OBENDRAUF (Re-Critique 2026-09-28, A4 P2-8): der Aufklapper
  // oeffnete hart. Der Zustand bleibt `hidden` (siehe oben), die Bewegung kommt
  // aus dem geteilten Paar expandIn/collapseOut (utils/ux.js, reduzierte
  // Bewegung springt): Oeffnen macht sichtbar und zieht auf, Schliessen klappt
  // erst ein und versteckt dann.
  if (btn.dataset.action === 'toggle-detail') {
    const panel = _container?.querySelector(`#recipe-detail-${btn.dataset.id}`);
    if (!panel) return;
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    if (!open) {
      panel.getAnimations?.().forEach((a) => a.cancel());
      panel.hidden = false;
      expandIn(panel);
      return;
    }
    collapseOut(panel).then(() => {
      // Nur verstecken, wenn inzwischen niemand wieder aufgeklappt hat.
      if (btn.getAttribute('aria-expanded') !== 'true') panel.hidden = true;
      // collapseOut haelt die Hoehe 0 (fill: forwards) - verwerfen, sonst
      // oeffnete das Panel beim naechsten Mal auf Hoehe 0.
      panel.getAnimations?.().forEach((a) => a.cancel());
      panel.style.overflow = '';
    });
    return;
  }

  if (btn.dataset.action === 'edit') {
    const recipe = state.recipes.find((r) => String(r.id) === String(id));
    if (recipe) openRecipeModal('edit', recipe);
  }
}

/**
 * ARIA des Hauptknopfs je Darstellung. Unter der Schwelle ist er ein
 * Aufklapper (`aria-expanded` + `aria-controls` aufs Panel); in der Spalte
 * waehlt er aus - ein „eingeklappt", das nie aufklappt, waere eine falsche
 * Ansage. Dort zeigt `aria-controls` auf die Detailspalte, und die Auswahl
 * traegt der Baustein als `aria-current`.
 */
function syncRowMode() {
  const list = _container?.querySelector('#recipes-list');
  if (!list) return;
  const split = _md?.isSplit() ?? false;
  // Die Klasse traegt die Darstellung ins Stylesheet (Aufklapper und Chevron
  // weg, recipes.css). Sie folgt der gerechneten Darstellung der Spalte statt
  // einer eigenen Abfrage: eine zweite `@container`-Schwelle hier liefe der in
  // layout.css davon, und PAGE-019 bewacht nur die eine.
  list.classList.toggle('recipes-list--split', split);
  for (const btn of list.querySelectorAll('.recipe-row__toggle')) {
    if (split) {
      btn.removeAttribute('aria-expanded');
      btn.setAttribute('aria-controls', 'recipes-detail');
    } else if (btn.dataset.action === 'toggle-detail') {
      const panelId = `recipe-detail-${btn.dataset.id}`;
      const panel = list.querySelector(`#${CSS.escape(panelId)}`);
      btn.setAttribute('aria-expanded', String(Boolean(panel && !panel.hidden)));
      btn.setAttribute('aria-controls', panelId);
    } else {
      btn.removeAttribute('aria-controls');
    }
    if ('narrowInert' in btn.dataset) {
      btn.tabIndex = split ? 0 : -1;
      btn.classList.toggle('list-row__main--interactive', split);
    }
  }
}

function buildRecipeList() {
  const list = _container.querySelector('#recipes-list');
  if (!list) return;
  list.removeAttribute('aria-busy');

  list.replaceChildren();

  // Fehlerzustand vor Leerzustand: nach einem Fehler ist `state.recipes`
  // ebenfalls leer, und nur die Reihenfolge trennt „nichts angelegt" von
  // „nicht geladen".
  if (state.loadError) {
    mountLoadError(list, {
      title: t('recipes.loadError'),
      description: t('common.loadErrorDescription'),
      error: state.loadError,
      retryLabel: t('common.retry'),
      onRetry: async () => {
        list.setAttribute('aria-busy', 'true');
        await loadRecipes();
        renderRecipeList();
      },
    });
    return;
  }

  if (!state.recipes.length) {
    // Geteilter Renderer (utils/empty-state.js): erzwingt Reihenfolge und
    // ARIA-Rolle. Vorher fehlte hier als einzigem Küchen-Leerzustand das Icon.
    mountEmptyState(list, {
      icon: 'book-text',
      title: t('recipes.emptyTitle'),
      description: t('recipes.emptyDescription'),
      hint: t('emptyHint.recipes'),
      action: {
        label: t('recipes.emptyAction'),
        icon: 'plus',
        onClick: () => document.querySelector('.page-fab')?.click(),
      },
    });
    return;
  }

  const visible = filteredRecipes();
  if (!visible.length) {
    // Geteilter Renderer, Variante 'no-results' (role="status", sekundärer CTA).
    // Vorher war das hier ein nacktes <p class="recipes-search-empty"> - die eine
    // Stelle im Modul, die den erzwingenden Baustein umging, während die
    // Schwester im Vorrat im identischen Zustand Icon, Überschrift, den
    // Suchbegriff und einen Zurücksetzen-Pfad lieferte (Critique 2026-07-30).
    mountEmptyState(list, {
      variant: 'no-results',
      title: t('recipes.noResultsTitle'),
      description: t('recipes.searchNoResults'),
      hint: state.query ? `„${state.query}"` : undefined,
      action: {
        // Geteilter Key: „Suche leeren" existiert in allen 23 Locales. Der
        // Vorrat sagt „Suche und Filter zurücksetzen", weil er beides hat -
        // Rezepte haben nur die Suche, und das Label soll nicht mehr versprechen
        // als es tut.
        label: t('common.searchClear'),
        onClick: () => {
          state.query = '';
          // clear() versteckt zugleich den Leeren-Knopf; ein blankes
          // `value = ''` ließe ihn über dem leeren Feld stehen.
          _search?.clear();
          renderRecipeList();
          _search?.input.focus();
        },
      },
    });
    return;
  }

  // Eine Zeilenliste, keine Kacheln: das Kartenraster war der letzte Tab mit
  // eigener Zeilen-Grammatik (20px Radius, 408px Höhe, drei CTA-Grundlinien,
  // 48px Bodenversatz in derselben Rasterzeile). Als Zeile teilt es Fläche,
  // Trennlinie, Textspalte und Bedienzone mit Einkauf und Vorrat.
  const rows = document.createElement('ul');
  rows.className = 'row-carrier';

  for (const recipe of visible) {
    // Mirror-Rezepte sind read-only (der Provider bleibt Quelle der Wahrheit); steuert
    // weiter unten sowohl die Zeilenaktionen als auch das Aufklapp-Detail.
    const isMirrored = recipe.source !== 'native';
    const ingredients = recipe.ingredients ?? [];
    const detailId = `recipe-detail-${recipe.id}`;
    // Die neuen Felder zaehlen mit: ein Rezept, das nur Kueche/Portionen/Zeiten
    // traegt, hat ein Detail Worth showing - ohne sie bliebe unter der
    // Schmalbreite kein Aufklapper, obwohl das Detail nicht leer waere.
    const hasDetail = Boolean(
      ingredients.length || recipe.notes || recipe.recipe_url
      || recipe.cuisine || recipe.servings || recipe.cookTime || recipe.prepTime
      || recipe.nutrition
    );

    const li = document.createElement('li');
    li.className = 'recipe-row-item';
    li.dataset.id = String(recipe.id);
    // Liste + Detail: die Zeile ist auswaehlbar, ihr Hauptknopf traegt den Fokus
    // der Pfeiltasten (utils/master-detail.js).
    li.dataset.mdId = String(recipe.id);

    const row = document.createElement('div');
    row.className = 'list-row recipe-row';

    // Kanonisches Accordion-Muster: Überschrift umschließt den Button. Die
    // Überschrift trägt die Dokumentstruktur, der Button den Zustand - vorher
    // war die ganze Karte ein role="button" MIT Buttons darin, was für
    // Hilfsmittel ein verschachteltes Bedienelement ist.
    const heading = document.createElement('h2');
    heading.className = 'list-row__main recipe-row__heading';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'list-row__main--interactive recipe-row__toggle';
    toggle.dataset.action = 'toggle-detail';
    toggle.dataset.id = String(recipe.id);
    toggle.dataset.mdFocus = "";

    // Herkunft ist Teil der Identität der Zeile, nicht erst ein Detail: wer
    // durch eine gemischte Liste scrollt, muss vor dem Aufklappen sehen können,
    // welche Rezepte gespiegelt (und schreibgeschützt) sind, nicht erst
    // danach.
    if (isMirrored) toggle.appendChild(recipeThumb(recipe));

    const name = document.createElement('span');
    name.className = 'list-row__name';
    name.textContent = recipe.title;
    toggle.appendChild(name);

    if (isMirrored) {
      // Eigener, unsichtbarer Slot statt das Badge selbst als Flex-Item zu
      // verwenden: unter der Container-Query unten braucht das Badge eine
      // erzwungene eigene Zeile (wie die Zutatenzahl), aber ein `flex-basis:
      // 100%` DIREKT am Badge würde die Pille selbst auf volle Zeilenbreite
      // dehnen (sie trägt einen sichtbaren Hintergrund, anders als der reine
      // Text der Zutatenzahl). Der Slot dehnt sich, die Pille darin bleibt
      // ihrer Inhaltsbreite treu.
      const badgeSlot = document.createElement('span');
      badgeSlot.className = 'recipe-row__badge-slot';
      badgeSlot.appendChild(sourceBadge(recipe));
      toggle.appendChild(badgeSlot);
    }

    // Die Zutatenzahl ersetzt das frühere „+N": dort stand ein <li> mit
    // cursor: pointer, ohne role, ohne tabindex, ohne aria-expanded, dessen
    // Klick nachweislich nichts tat (Kartenhöhe 408 → 408px an sechs Karten
    // gemessen, Critique 2026-07-30). Jetzt ist die Zahl die Beschriftung
    // dessen, was das Aufklappen zeigt.
    //
    // IMMER gerendert, auch bei 0: die Mindestbreite von .list-row__meta
    // (15ch, siehe recipes.css) hält alles davor - das Mealie/Tandoor-Badge -
    // an derselben Stelle. Fehlte das Element ganz, würde der Name per
    // flex-grow den freiwerdenden Platz schlucken und das Badge nach rechts
    // schieben, sobald ein Rezept ganz ohne Zutaten in der Liste steht.
    const meta = document.createElement('span');
    meta.className = 'list-row__meta';
    meta.textContent = t('meals.ingredientCount', { count: ingredients.length });
    // Zutatenzahl und „Diese Woche geplant" teilen sich einen Slot: breit
    // nimmt er per `display: contents` nicht am Layout teil, schmal wird er
    // die zweite Zeile unter dem Namen - BEIDE Angaben darin, statt dass die
    // zweite allein neben dem Namen haengen bleibt (recipes.css).
    const sub = document.createElement('span');
    sub.className = 'recipe-row__sub';
    sub.appendChild(meta);

    // Zweite Meta-Angabe, getrennt ueber den Mittelpunkt des +-Kombinators
    // (Hausform, Vorrat): neutraler Sekundaertext, keine Flaeche - der
    // Zustand ist eine Meldung, keine Identitaet (Skalen-Regel).
    if (state.plannedRecipeIds.has(recipe.id)) {
      const planned = document.createElement('span');
      planned.className = 'recipe-row__planned';
      planned.textContent = t('recipes.plannedThisWeek');
      sub.appendChild(planned);
    }
    toggle.appendChild(sub);

    if (hasDetail) {
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-controls', detailId);
      toggle.insertAdjacentHTML('beforeend',
        '<i data-lucide="chevron-down" class="icon-sm recipe-row__chevron" aria-hidden="true"></i>');
    } else if (!isMirrored) {
      // Ohne Detail kein Versprechen: kein Chevron, kein aria-expanded. Der
      // Button öffnet dann direkt das Bearbeiten-Formular.
      toggle.dataset.action = 'edit';
    } else {
      // Gespiegelt UND ohne Detail (kein Slug-Link, keine Zutaten, keine
      // Notiz - selten, aber möglich, wenn Mealies /users/self keinen
      // groupSlug liefert): weder aufklappbar noch bearbeitbar. Der Button
      // bliebe sonst interaktiv aussehend, ohne dass ein Klick etwas täte -
      // oder schlimmer, er würde über den generischen edit-Handler ein
      // Bearbeitungsformular öffnen, dessen Speichern serverseitig ohnehin
      // mit 403 abgewiesen wird (provider_account_id-Guard, routes/recipes.js).
      delete toggle.dataset.action;
      toggle.classList.remove('list-row__main--interactive');
      toggle.tabIndex = -1;
      // Nur unter der Schwelle stumm: in der Spalte zeigt auch dieses Rezept
      // sein Detail rechts, also ist die Zeile dort ein Knopf wie jede andere
      // (syncRowMode).
      toggle.dataset.narrowInert = "";
      // Trotzdem einen (unsichtbaren) Chevron-Platzhalter einfügen: sonst
      // wächst der Name per flex-grow um genau dessen Breite, und das Badge
      // vor ihm rutscht gegenüber jeder anderen gespiegelten Zeile nach
      // rechts - derselbe Mechanismus wie bei der Zutatenzahl oben.
      toggle.insertAdjacentHTML('beforeend',
        '<i data-lucide="chevron-down" class="icon-sm recipe-row__chevron recipe-row__chevron--placeholder" aria-hidden="true"></i>');
    }

    heading.appendChild(toggle);
    row.appendChild(heading);

    // Mirror-Rezepte sind read-only (der Provider bleibt Quelle der Wahrheit) - Edit
    // und Delete entfallen, Duplizieren bleibt: das legt eine eigenständige,
    // frei bearbeitbare Kopie an (duplicateRecipe() postet immer als natives
    // Rezept, unabhängig von der Quelle des Originals). Eine Liste speist
    // sowohl die Inline-Buttons als auch das Überlaufmenü weiter unten, damit
    // beide Fassungen nie auseinanderlaufen.
    const ROW_ACTIONS = [
      !isMirrored && { action: 'edit',      icon: 'pencil',  label: t('common.edit') },
      { action: 'duplicate', icon: 'copy',    label: t('recipes.duplicate') },
      !isMirrored && { action: 'delete',    icon: 'trash-2', label: t('common.delete'), danger: true },
    ].filter(Boolean);

    const actions = document.createElement('div');
    actions.className = 'list-row__actions';

    // Drei Zeilenaktionen kosten 152px von 262px Zeilenbreite bei 320px - 58% der
    // Zeile für Sekundäraktionen. Für den Namen blieben 98px, und weil er in einem
    // Flex-Elternteil steht, fiel er auf min-content: 8px, Zeilenhöhe 448px
    // (Critique 2026-07-30, P0).
    //
    // Unter 30rem Zeilenbreite wandern sie deshalb in dasselbe Überlaufmenü, das der
    // Einkaufs-Kopf benutzt - mit Labels, und ein 48px-Trigger statt drei Knöpfen.
    // Die Container-Query dazu steht in recipes.css; hier stehen beide Fassungen im
    // DOM, CSS entscheidet. Dieselbe Mechanik wie beim Kopf: `display: none` nimmt
    // die ungenutzte Fassung auch aus der Tabfolge.
    const inline = document.createElement('div');
    inline.className = 'recipe-row__inline-actions';
    for (const a of ROW_ACTIONS) {
      const btn = document.createElement('button');
      btn.className = `row-action${a.danger ? ' row-action--danger' : ''}`;
      btn.type = 'button';
      btn.dataset.action = a.action;
      btn.dataset.id = String(recipe.id);
      btn.setAttribute('aria-label', `${a.label}: ${recipe.title}`);
      btn.title = a.label;
      btn.insertAdjacentHTML('beforeend',
        `<i data-lucide="${a.icon}" class="icon-md" aria-hidden="true"></i>`);
      inline.appendChild(btn);
    }
    actions.appendChild(inline);

    const more = document.createElement('div');
    more.className = 'recipe-row__more';
    more.insertAdjacentHTML('beforeend', popoverMenuHtml({
      id: `recipe-menu-${recipe.id}`,
      label: t('common.moreActions'),
      triggerClass: 'row-action',
      items: ROW_ACTIONS.map((a) => ({ ...a, id: recipe.id })),
    }));
    actions.appendChild(more);

    row.appendChild(actions);
    li.appendChild(row);

    if (hasDetail) {
      const detail = document.createElement('div');
      detail.className = 'recipe-detail';
      detail.id = detailId;
      detail.hidden = true;

      // shoppingIn: 'none' - der Einkaufs-Ausgang des Aufklappers haengt
      // in der Kopfleiste (unten), nicht im Abschnittskopf wie in der Spalte:
      // unter der Schwelle sind es zwei Daumenwege in EINER Zeile statt
      // einer zweiten, die der Daumen erst suchen muesste.
      fillRecipeDetail(detail, recipe, { shoppingIn: 'none' });
      // DER AUSGANG INS VOLLBILD AM TELEFON: unter der Schwelle ist der
      // Aufklapper die Detailflaeche, und er bekommt denselben Ausgang, den
      // der Spaltenkopf ab der Schwelle fuehrt - sonst waere das Vollbild
      // eine Desktop-Angelegenheit, obwohl gerade dort beim Kochen der
      // Platz knapp ist. DER KNOPF STEHT OBEN, nicht unten: der Aufklapper
      // ist eine Vorschau, und der Ausgang zur grossen Leseflaeche gehoert
      // an ihren Anfang - wer bis zur Aktionszeile liest, hat ihn schon
      // gefunden, und die unten bleibt dem Einplanen vorbehalten, das das
      // Rezept in den eigenen Plan traegt.
      // Er haengt nicht in fillRecipeDetail: der Baustein dient auch der
      // Spalte (ihren Ausgang traegt der Kopf) und dem Vollbild selbst (ein
      // Ausgang dorthin, wo man schon ist, waere der zweite Weg zur selben
      // Flaeche), und er laeuft ueber denselben Delegierten wie Einplanen
      // und Einkaufsliste (handleDetailAction, Zweig 'fullscreen').
      // Zurueck aus dem Vollbild landet der Fokus auf ihm.
      const fullscreenBar = document.createElement('div');
      fullscreenBar.className = 'recipe-detail__fullscreen-bar';
      // DER EINKAUFS-AUSGANG AM LINKEN RAND DERSELBEN LEISTE, klein
      // (.btn--sm, layout.css): zwei Daumenwege in einer Zeile statt zweier
      // - und dieselben Riegel wie an jeder Stelle (shoppingTransferButton:
      // Liste, Zutaten, Schreibrechte; ohne sie stünde ein toter Knopf).
      // Das CSS haelt ihn links und den Vollbild-Ausgang rechts; fehlt er,
      // steht der Einzelne rechts, wie die Leiste vorher stand.
      const addToShopping = shoppingTransferButton(recipe, recipe.ingredients ?? []);
      if (addToShopping) {
        addToShopping.classList.add('btn--sm');
        fullscreenBar.appendChild(addToShopping);
      }
      const fullscreenBtn = document.createElement('button');
      fullscreenBtn.className = 'btn btn--ghost';
      fullscreenBtn.type = 'button';
      fullscreenBtn.dataset.action = 'fullscreen';
      fullscreenBtn.dataset.id = String(recipe.id);
      fullscreenBtn.setAttribute('aria-label', `${t('recipes.fullscreenLabel')}: ${recipe.title}`);
      fullscreenBtn.insertAdjacentHTML('beforeend',
        '<i data-lucide="maximize" class="icon-sm" aria-hidden="true"></i>');
      const fullscreenLabel = document.createElement('span');
      fullscreenLabel.textContent = t('recipes.fullscreenLabel');
      fullscreenBtn.appendChild(fullscreenLabel);
      fullscreenBar.appendChild(fullscreenBtn);
      detail.prepend(fullscreenBar);
      li.appendChild(detail);
    }

    rows.appendChild(li);
  }

  list.appendChild(rows);

  if (window.lucide) window.lucide.createIcons({ el: list });
}

/**
 * Der Inhalt eines Rezeptdetails: Mahlzeit-Chips, Zutaten samt Vorrats-
 * Zuordnung und Checkboxen der Teilwahl, Notizen und die Kreislauf-Ausgaenge.
 * EINE Quelle fuer drei Flaechen - den Aufklapper der Zeile (unter der
 * Schwelle), die Detailspalte (Liste + Detail) und das Vollbild - damit keine
 * eine eigene Version entwickelt, die auseinanderlaufen koennte. EIN
 * Unterschied gehoert zum Vertrag: das Vollbild (fullscreen: true) ist die
 * Leseflaeche und fuehrt weder die Checkboxen der Teilwahl noch den
 * Einkaufsknopf - die Auswahl wird auf der Seite getroffen, wo beide
 * Wurzeln dieselbe Karte teilen.
 *
 * ZWEI ORTE DES EINKAUFSKNOPFS (2026-10-23): er gehoert neben die Zutaten,
 * die er benennt, nicht unter die ganze Karte. shoppingIn entscheidet:
 * 'ingredients-head' (Default) setzt ihn in den Kopf des Zutaten-Abschnitts
 * - der Weg der Detailspalte -, 'none' laesst ihn hier weg, weil der
 * Aufklapper ihn in seiner Kopfleiste selbst anhaengt (buildRecipeList).
 */
function fillRecipeDetail(detail, recipe, { fullscreen = false, shoppingIn = 'ingredients-head' } = {}) {
  const ingredients = recipe.ingredients ?? [];
  const mealTypes = normalizeRecipeMealTypes(recipe.meal_types);
  // Chips nur, wenn sie unterscheiden: gilt ein Rezept für alle Mahlzeiten,
  // ist die volle Chip-Reihe reine Ornamentik (Audit A1-21). Das
  // Herkunfts-Badge sitzt jetzt schon in der Zeilenüberschrift (immer sichtbar,
  // nicht erst nach dem Aufklappen) und wird hier nicht noch einmal gezeigt.
  const showMealTypeBadges = mealTypes.length && mealTypes.length < mealTypeOptions().length;
  if (showMealTypeBadges) {
    const badges = document.createElement('div');
    badges.className = 'recipe-card__meal-types';
    badges.append(...mealTypeOptions()
      .filter((option) => mealTypes.includes(option.key))
      .map((option) => {
        const badge = document.createElement('span');
        badge.className = `meal-type-badge meal-type-badge--${option.key}`;
        badge.textContent = option.label;
        return badge;
      }));
    detail.appendChild(badges);
  } else if (!mealTypes.length) {
    // Keine Mahlzeit ist eine Aussage und braucht ein Wort: Das Rezept fällt
    // aus Menüplan und Zufallsauswahl heraus (#750). Ohne Hinweis wäre der
    // Zustand von „gilt für alle" nur daran zu unterscheiden, dass hier
    // nichts steht - und genau diese Stille war der gemeldete Fehler.
    const none = document.createElement('div');
    none.className = 'recipe-card__meal-types';
    const badge = document.createElement('span');
    badge.className = 'meal-type-badge meal-type-badge--none';
    badge.textContent = t('recipes.mealTypeNone');
    none.appendChild(badge);
    detail.appendChild(none);
  }

  /* DIE NEUEN FELDER (Portionen, Zubereitungs- und Kochzeit) als EINE
   * Zeile unter den Mahlzeit-Chips - nur was gesetzt ist. Dasselbe Muster wie
   * die Notizen unten: der Server liefert alle Spalten, das Detail zeigt, was
   * da ist, und schweigt sonst (leer ist keine Aussage). */
  const metaParts = [
    recipe.servings && `${t('Servings')}: ${recipe.servings}`,
    recipe.prepTime && `${t('Prep Time')}: ${recipe.prepTime}`,
    recipe.cookTime && `${t('Cook Time')}: ${recipe.cookTime}`
  ].filter(Boolean);
  if (metaParts.length) {
    const meta = document.createElement('p');
    meta.className = 'recipe-detail__meta';
    meta.textContent = metaParts.join(' \u00B7 ');
    detail.appendChild(meta);
  }

  /* KUECHE UND DIET ALS EIGENE ZEILE darunter (v243): Die Kueche benennt die
   * Herkunft des Rezepts, die Diets die Einschraenkungen - dieselbe Frage auf
   * demselben Blatt, deshalb eine Zeile. OHNE LABELS: "Indian · vegan" liest
   * sich selbst (dieselbe Antwort wie bei Menge/Einheit der Zutatenzeile), und
   * die Zeile darueber zeigt den Wert nur mit Praefix, wo das Wort fehlt -
   * Servings und Zeiten brauchen es, eine Kueche nicht. Kuratierte Diets
   * uebersetzt, Importer-Vokabular wortgetreu, Diets mit Komma untereinander,
   * die beiden Gruppen mit Mittelpunkt wie die Werte der Zeile darueber.
   * Nur was gesetzt ist; ohne beide schweigt die Zeile. */
  const dietList = Array.isArray(recipe.diet) ? recipe.diet : [];
  const herkunftParts = [
    recipe.cuisine,
    dietList.length && dietList.map((d) => (RECIPE_DIET_KEYS.includes(d) ? t(recipeDietLabelKey(d)) : d)).join(', '),
  ].filter(Boolean);
  if (herkunftParts.length) {
    const herkunft = document.createElement('p');
    herkunft.className = 'recipe-detail__meta recipe-detail__meta--cuisine';
    herkunft.textContent = herkunftParts.join(' \u00B7 ');
    detail.appendChild(herkunft);
  }

  // VOLLSTÄNDIGE Zutatenliste, nicht die ersten vier: das Kürzen war nur
  // nötig, um die Kartenhöhe zu bändigen. Ein Detail, das sich öffnet, hat
  // keinen Grund, etwas zu verschweigen. Die Checkboxen der Teilwahl fehlen
  // im Vollbild, und der Einkaufs-Ausgang steht im KOPF DIESES ABSCHNITTS,
  // neben dem Wort „Zutaten" - nur in der Spalte (shoppingIn); der Aufklapper
  // fuehrt ihn in seiner Kopfleiste, das Vollbild gar nicht.
  if (ingredients.length) detail.appendChild(ingredientsSectionEl(recipe, {
    withChecks: !fullscreen,
    withShoppingButton: !fullscreen && shoppingIn === 'ingredients-head',
  }));

  if (recipe.notes) {
    const section = detailSectionEl(t('recipes.notesLabel'));
    const notes = document.createElement('p');
    notes.className = 'recipe-detail__notes';
    notes.textContent = recipe.notes;
    section.appendChild(notes);
    detail.appendChild(section);
  }

  /* NAEHRWERTE JE PORTION (v242) - UNTER DEN NOTIZEN, als Abschluss der
   * Zubereitung: die Reihenfolge im Detail folgt dem Kochvorgang - Zutaten
   * erst kaufen, dann nach Notizen zubereiten, was dabei herauskommt steht
   * zuletzt als Zeile. EU-Etiketten-Reihenfolge aus
   * utils/health-nutrition.js#NUTRIENTS (dieselbe Liste wie das
   * Gesundheitsmodul); nur was gesetzt ist, ein Rezept ohne Werte schweigt.
   * Der Server liefert das Feld als Objekt (nutrition: { energy_kcal, ... })
   * oder null - geparst, nicht als JSON-String. */
  const nutrition = recipe.nutrition;
  if (nutrition && typeof nutrition === 'object') {
    const parts = NUTRIENTS
      .map((n) => {
        const v = nutrition[n.key];
        return Number.isFinite(v) ? `${t(n.labelKey)}: ${v} ${t(n.unitKey)}` : null;
      })
      .filter(Boolean);
    if (parts.length) {
      const nutritionEl = document.createElement('p');
      nutritionEl.className = 'recipe-detail__nutrition';
      // JE PAAR EIN SPAN, nicht ein Textknoten: das Flex-Layout unten bricht
      // zwischen den Paaren um, nie mitten in "23 g" - Label, Zahl und
      // Einheit bleiben zusammen.
      const label = document.createElement('span');
      label.className = 'recipe-detail__nutrition-label';
      label.textContent = t('recipes.nutritionLabel');
      nutritionEl.appendChild(label);
      for (const part of parts) {
        const span = document.createElement('span');
        span.textContent = part;
        nutritionEl.appendChild(span);
      }
      detail.appendChild(nutritionEl);
    }
  }

  // Der Kreislauf-Ausgang EINPLANEN steht im Detail, nicht in der Zeile, und
  // ist dort BESCHRIFTET. Grund: derselbe Weg hieß im Modul dreimal etwas
  // anderes - ein 24px-Glyph im Essensplan, ein 48px-Glyph im Vorrat, ein
  // 167px-Pill in den Rezepten (Critique 2026-07-30). Und man entscheidet
  // sich fürs Einplanen, nachdem man gesehen hat, was drin ist. Der Preis
  // ist ein zusätzlicher Tap für den häufigsten Weg; die Zeile bleibt dafür
  // scanbar und auf 393px ohne fünf konkurrierende Bedienelemente.
  const detailActions = document.createElement('div');
  detailActions.className = 'recipe-detail__actions';

  const addToMeals = document.createElement('button');
  addToMeals.className = 'btn btn--primary';
  addToMeals.type = 'button';
  addToMeals.dataset.action = 'add-to-meals';
  addToMeals.dataset.id = String(recipe.id);
  addToMeals.textContent = t('recipes.addToMeals');
  detailActions.appendChild(addToMeals);

  // Der EINKAUFS-AUSGANG steht nicht in dieser Zeile: er gehoert neben die
  // Zutaten, die er benennt - in der Spalte in den Abschnittskopf, im
  // Aufklapper in die Kopfleiste (siehe shoppingIn oben). Das Vollbild bleibt
  // beim Lesen - Einplanen bleibt auch dort, es ist kein Kreislauf zwischen
  // Modulen, sondern eine Notiz in den eigenen Plan.

  if (recipe.recipe_url) {
    const link = document.createElement('a');
    link.className = 'btn btn--ghost';
    link.href = recipe.recipe_url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.insertAdjacentHTML('beforeend',
      '<i data-lucide="external-link" class="icon-sm" aria-hidden="true"></i>');
    const linkLabel = document.createElement('span');
    linkLabel.textContent = t('recipes.openLink');
    link.appendChild(linkLabel);
    detailActions.appendChild(link);
  }

  detail.appendChild(detailActions);
}

/* ABSCHNITTSKOEPFE, DIE MAN ANSPRINGEN KANN (Re-Critique 2026-09-27, W2).
 *
 * Zutaten und Notizen standen als zwei gleich graue 17px-Bloecke untereinander,
 * ohne Wort dafuer, was sie sind - das Detail las sich wie ein Formular-Nachdruck,
 * nicht wie ein Rezept, und die Ueberschriften-Navigation eines Screenreaders
 * fand darin nichts. Jetzt traegt jeder Abschnitt eine echte Ueberschrift in der
 * Bereichsrolle (`u-section-title u-compact`, typography.css). Eine Stufe unter
 * dem Rezepttitel: der ist im Aufklapper wie in der Detailspalte ein <h2>
 * (`recipe-row__heading`, `detailPaneHeaderEl`). Die Worte sind die Feldnamen
 * des Formulars - dieselbe Sache heisst an beiden Stellen gleich. */
/* DER KOPF EINES ABSCHNITTS, MIT PLATZ FUER EINEN KNOPF: ohne `action`
 * bleibt das Markup wie zuvor (die h3 direkt im Abschnitt - Notizen und
 * jede kuenftige Flaeche), mit `action` stehen Titel und Knopf in EINER
 * Zeile (.recipe-detail__section-head): der Einkaufs-Ausgang des Zutaten-
 * Abschnitts gehoert neben das Wort, das er benennt. Das CSS richtet den
 * Knopf rechts aus, auch als Einziger einer Umbruchzeile (margin-inline-
 * start: auto, recipes.css) - ein langes Label weicht in die zweite Zeile
 * aus, statt zu clippen oder den Kopf zu verdraengen.
 */
function detailSectionEl(title, { action = null } = {}) {
  const section = document.createElement('section');
  section.className = 'recipe-detail__section';
  const heading = document.createElement('h3');
  heading.className = 'recipe-detail__section-title u-section-title u-compact';
  heading.textContent = title;
  if (!action) {
    section.appendChild(heading);
    return section;
  }
  const head = document.createElement('div');
  head.className = 'recipe-detail__section-head';
  head.appendChild(heading);
  head.appendChild(action);
  section.appendChild(head);
  return section;
}

/**
 * Der Zutaten-Abschnitt als EIN Element mit Rezept-ID, damit eine geaenderte
 * Zuordnung ihn an allen Flaechen (Aufklapper, Detailspalte, Vollbild) als
 * Ganzes neu bauen kann - samt Checkboxen der Teilwahl, deren Zustand aus
 * der Karte (_selectedIngredients) zurueckkommt, nicht aus dem Markup.
 * withChecks: false laesst die Checkboxen weg - der Weg des Vollbilds, das
 * den Einkaufs-Ausgang nicht kennt. withShoppingButton: true setzt den
 * Einkaufs-Ausgang in den Abschnittskopf (der Weg der DETAILSPALTE) - der
 * Neuaufbau (renderIngredientSections) muss ihn mitbauen, sonst verschwande
 * er mit der ersten Vorrats-Zuordnung; der Aufklapper haengt ihn selbst in
 * seine Kopfleiste, ausserhalb dieses Abschnitts, wo er den Neuaufbau
 * uebersteht.
 */
function ingredientsSectionEl(recipe, { withChecks = true, withShoppingButton = false } = {}) {
  const ingredients = recipe.ingredients ?? [];
  const selected = new Set(selectedIngredientIds(recipe));
  const section = detailSectionEl(t('recipes.ingredientsLabel'), {
    action: withShoppingButton ? shoppingTransferButton(recipe, ingredients) : null,
  });
  section.classList.add('recipe-detail__ingredients-section');
  section.dataset.recipeId = String(recipe.id);
  const ul = document.createElement('ul');
  ul.className = 'recipe-detail__ingredients';
  /* ABSCHNITTE ALS FOLGE (v244): Eine Ueberschrift entsteht, wenn der Wert der
   * Zeile davor ein ANDERER ist - derselbe Name an zwei Stellen ergibt zwei
   * Gruppen, weil der Importer sie so schickte, und eine Zeile ohne Abschnitt
   * hat keine. Die Ordnung ist die der Liste (ORDER BY id ASC auf dem Server),
   * nicht die des Alphabets. */
  let prevSection = '';
  for (const ing of ingredients) {
    const section = ing.section ?? '';
    if (section && section !== prevSection) {
      const group = document.createElement('li');
      group.className = 'recipe-detail__ingredient-group';
      group.textContent = section;
      ul.appendChild(group);
    }
    prevSection = section;
    const item = document.createElement('li');
    item.className = 'recipe-detail__ingredient';
    const label = document.createElement('span');
    label.className = 'recipe-detail__ingredient-name';
    // Menge und Einheit stehen getrennt gespeichert (v237), aber zusammen
    // gelesen wie bisher: "500 g · Mehl". Fehlt die Menge und nur die Einheit
    // ist gesetzt, bleibt die Einheit sichtbar statt zu verschwinden.
    // DIE ZWEITANGABE (v243) IN KLAMMERN DAHINTER - "0.5 cup (48 g)": sie ist
    // dasselbe Mass in einer anderen Zaehlung (Gewicht statt Volumen), kein
    // zweiter Wert daneben. Leere Klammern entstehen nie: die Klammer steht
    // nur, wenn mindestens eine der beiden Angaben gesetzt ist.
    const amount = [ing.quantity, ing.unit].filter(Boolean).join(' ');
    const secondary = [ing.secondary_quantity, ing.secondary_unit].filter(Boolean).join(' ');
    const amountText = amount && secondary ? `${amount} (${secondary})` : amount;
    label.textContent = amountText ? `${amountText} · ${ing.name}` : ing.name;
    // CHECKBOX DER TEILWAHL vor dem Namen - nur wo der Einkaufs-Ausgang
    // ueberhaupt stehen darf (dieselben zwei Riegel wie der Knopf, #1290):
    // ohne Liste oder ohne beide Schreibrechte waere jedes Kaetzchen ein
    // Versprechen auf einen 403er. Der Zustand kommt aus der Karte oben,
    // nicht aus dem Markup - der Neuaufbau (renderIngredientSections)
    // vergisst ihn so nie.
    if (withChecks && ing.id != null && state.lists.length && mayTransferRecipeToShopping(recipe.id)) {
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.className = 'recipe-detail__ingredient-check';
      check.setAttribute('data-ingredient-id', String(ing.id));
      check.setAttribute('aria-label', label.textContent);
      if (selected.has(Number(ing.id))) check.checked = true;
      item.appendChild(check);
    }
    item.appendChild(label);
    // Zubereitungs-Hinweis (v241) - leiser als der Name, wie er im Modal auch
    // nur Kontext des Namens ist. Leer ist keine Aussage und bleibt stumm.
    if (ing.note) {
      const noteEl = document.createElement('span');
      noteEl.className = 'recipe-detail__ingredient-note';
      noteEl.textContent = ing.note;
      item.appendChild(noteEl);
    }
    ul.appendChild(item);
  }
  section.appendChild(ul);
  return section;
}

/** Baut jeden Zutaten-Abschnitt dieses Rezepts neu (Aufklapper + Spalte + Vollbild). */
function renderIngredientSections(recipe) {
  // Beide Wurzeln desselben Inhalts: die Seite (Aufklapper und Spalte) und
  // das Vollbild, das ausserhalb von ihr am Body haengt. Die Checkboxen der
  // Teilwahl stehen nur auf der Seite - der Neuaufbau des Vollbild-Abschnitts
  // laesst sie weg, wie beim ersten Bau (fillRecipeDetail, fullscreen: true).
  const rebuild = (root, withChecks) => {
    const sections = [...root.querySelectorAll(
      `.recipe-detail__ingredients-section[data-recipe-id="${CSS.escape(String(recipe.id))}"]`)];
    for (const el of sections) {
      el.replaceWith(ingredientsSectionEl(recipe, {
        withChecks,
        // Der Knopf im ABSCHNITTSKOPF gehoert nur der Detailspalte - die
        // Wurzel entscheidet, nur sie traegt .recipe-detail--pane: der
        // Aufklapper fuehrt ihn in seiner Kopfleiste (ausserhalb dieses
        // Abschnitts, er ueberlebt den Neuaufbau), das Vollbild gar nicht.
        withShoppingButton: Boolean(el.closest('.recipe-detail--pane')),
      }));
    }
    return sections.length;
  };
  const onPage = _container ? rebuild(_container, true) : 0;
  const inFullscreen = _fullscreen?.body ? rebuild(_fullscreen.body, false) : 0;
  if (onPage + inFullscreen > 0 && window.lucide && _container) {
    window.lucide.createIcons({ el: _container });
  }
}

/* DIE BESTAETIGTE ZUORDNUNG ZU EINER VORRATSZEILE (#1314, Stufe 1).
 *
 * Sie steht im Rezeptdetail, neben der Zutat, und nirgends sonst: eine eigene
 * Zuordnungsseite oeffnet niemand ein zweites Mal (#1314, Punkt 2). Yuvomi
 * schlaegt dabei NICHTS vor - auch dann nicht, wenn eine Vorratszeile genauso
 * heisst. Ein geratener Treffer waere der gepflegte Katalog, eine Ableitung
 * nach der anderen (docs/DECISIONS.md Abschnitt 7).
 *
 * UND DAS WORT ZAEHLT. Eine Zutat ohne Zuordnung heisst „nicht zugeordnet",
 * niemals „fehlt": Stufe 1 weiss nur, worauf der Haushalt gezeigt hat, und
 * nichts ueber den Bestand. Ein „fehlt" waere eine vollstaendige Auskunft auf
 * halber Datenlage - genau das, was der Abschnitt unter „What counts as undoing
 * it" nennt.
 */

/** 'none' | 'read' | 'write' - was dieses Konto mit dem Vorrat darf. */
function pantryAccess() {
  if (window.yuvomi?.isModuleDisabled?.('pantry')) return 'none';
  return navModuleAccess('pantry');
}

/**
 * Der Zuordnungs-Zustand einer Zutat als Element.
 *
 * Bei `read` bleibt der ZUSTAND stehen und nur die HANDLUNG geht (die Regel aus
 * #467): ein Mitglied, das den Vorrat nur ansehen darf, sieht die Zuordnung,
 * kann sie aber nicht aendern. Bei `none` steht hier gar nichts - wer den
 * Vorrat nicht sehen darf, erfaehrt auch nicht, dass es dort eine Zeile gibt.
 *
 * NUR DIE BESTEHENDE ZUORDNUNG STEHT AN DER ZEILE (Re-Critique 2026-09-27, W2).
 * Hier stand an jeder offenen Zutat „Nicht zugeordnet" - sechsmal je Rezept,
 * unterstrichen, lauter als die Menge. Die Zuordnung ist ein Werkzeug fuer den
 * Vorrat, kein Zustand des Rezepts; ihr Fehlen ist der Normalfall und braucht
 * kein Wort je Zeile. Der Weg dorthin stand EINMAL unter der Liste.
 /** Eine Vorratszeile im Auswahlfeld: Name, Ort und MHD unterscheiden Chargen. */
function pantryOptionLabel(item) {
  const teile = [item.name];
  if (item.location_name) teile.push(item.location_name);
  if (item.expires_on) teile.push(formatDate(item.expires_on));
  return teile.join(' · ');
}

/**
  const open = (recipe.ingredients ?? []).filter((ing) => !ing.pantry_item_id);
  if (!open.length) return;

  let items = [];
  try {
    const res = await api.get('/pantry');
    items = res.data ?? [];
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('recipes.ingredientMatchLoadError'), 'danger');
    return;
  }

  const options = items.map((item) => `<option value="${esc(String(item.id))}">${esc(pantryOptionLabel(item))}</option>`).join('');
  const fields = open.map((ing, i) => `
        <div class="form-group">
          <label class="form-label" for="pantry-bulk-match-${i}">${esc([ing.quantity, ing.unit].filter(Boolean).join(' ') ? `${[ing.quantity, ing.unit].filter(Boolean).join(' ')} · ${ing.name}` : ing.name)}</label>
          <select id="pantry-bulk-match-${i}" class="form-input" data-ingredient-index="${i}">
            <option value="">${esc(t('recipes.ingredientMatchNone'))}</option>
            ${options}
          </select>
        </div>`).join('');

  openSharedModal({
    title: t('recipes.ingredientMatchBulkTitle'),
    size: 'sm',
    content: `
      <p class="form-hint">${t('recipes.ingredientMatchBulkHint')}</p>
      ${items.length ? `${fields}
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-bulk-match-cancel" type="button">${t('common.cancel')}</button>
          <button class="btn btn--primary" id="pantry-bulk-match-save" type="button">${t('common.save')}</button>
        </div>
      ` : `
        <p class="form-hint">${t('recipes.ingredientMatchEmpty')}</p>
        <div class="modal-panel__footer modal-panel__footer--plain">
          <button class="btn btn--secondary" id="pantry-bulk-match-cancel" type="button">${t('common.close')}</button>
        </div>
      `}
    `,
    onSave(panel) {
      panel.querySelector('#pantry-bulk-match-cancel')?.addEventListener('click', () => closeSharedModal());
      const save = panel.querySelector('#pantry-bulk-match-save');
      save?.addEventListener('click', async () => {
        const chosen = [...panel.querySelectorAll('select[data-ingredient-index]')]
          .filter((sel) => sel.value !== '')
          .map((sel) => ({ ing: open[Number(sel.dataset.ingredientIndex)], pantryItemId: Number(sel.value) }));
        if (!chosen.length) { closeSharedModal({ force: true }); return; }
        save.disabled = true;
        let saved = 0;
        try {
          for (const { ing, pantryItemId } of chosen) {
            const res = await api.put(`/recipes/${recipe.id}/ingredient-match`, { name: ing.name, pantryItemId });
            ing.pantry_item_id = res.data.pantry_item_id;
            ing.pantry_item_name = res.data.pantry_item_name;
            saved += 1;
          }
          closeSharedModal({ force: true });
          renderIngredientSections(recipe);
          refocusAfterRender();
          window.yuvomi?.showToast(t('recipes.ingredientMatchSaved'), 'success');
        } catch (err) {
          // Was bis zum Fehler gespeichert ist, bleibt gespeichert und steht
          // gleich in der Liste; der Dialog bleibt fuer den Rest offen.
          if (saved) renderIngredientSections(recipe);
          save.disabled = false;
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
        }
      });
    },
  });
}

/* ENTFERNT: openRecipeReadModal (Nur-Lese-Modal fürs Kochen, Audit A1-21).
 *
 * Es zeigte volle Zutatenliste, Notizen und Link - genau das, was jetzt das
 * Aufklapp-Detail der Zeile zeigt, nur ohne Kontextverlust, ohne Overlay und
 * ohne einen zweiten Weg zur selben Information (Kriterium aus distill:
 * „wenn es woanders steht, wiederhole es nicht"). Sein Auslöser war zusätzlich
 * eine Karte mit role="button", die Buttons enthielt.
 *
 * Der Zweck bleibt erfüllt: Lesen erzwingt weiter kein Bearbeiten-Formular. Das
 * Herkunfts-Badge, das hier stand, sitzt jetzt in der Zeilenüberschrift selbst -
 * sichtbar, bevor man überhaupt aufklappt (siehe sourceBadge() weiter oben).
 */

/**
 * Fuss des Rezept-Dialogs nach dem Kanon `[Loeschen links] ... [Abbrechen]
 * [Primaer]` (R8 H10). Loeschen gab es bis dahin nur im Detailkopf und im
 * Zeilenmenue. Gespiegelte Rezepte bleiben ohne: sie gehoeren dem Provider,
 * dieselbe Regel wie in `ROW_ACTIONS`.
 */
function recipeModalFooterHtml(isEdit, recipe) {
  const canDelete = isEdit && recipe?.source === 'native';
  return `
      <div class="modal-panel__footer modal-panel__footer--plain">
        ${canDelete ? `<button type="button" class="btn btn--danger-outline" id="recipe-delete" style="margin-inline-end:auto"><i data-lucide="trash-2" class="icon-md" aria-hidden="true"></i>${esc(t('common.delete'))}</button>` : ''}
        <button class="btn btn--secondary" id="recipe-cancel">${t('common.cancel')}</button>
        <button class="btn btn--primary" id="recipe-save">${isEdit ? t('common.save') : t('common.add')}</button>
      </div>`;
}

function openRecipeModal(mode, recipe = null) {
  const isEdit = mode === 'edit';

  openSharedModal({
    title: isEdit ? t('recipes.editRecipe') : t('recipes.addRecipe'),
    size: 'md',
    content: `
      <div class="form-group">
        <label class="form-label" for="recipe-title">${t('common.nameLabel')}</label>
        <input id="recipe-title" class="form-input" type="text" required placeholder="${t('recipes.titlePlaceholder')}">
      </div>
      <div class="form-group">
        <span class="form-label" id="recipe-meal-types-label">${t('meals.mealTypeLabel')}</span>
        <!-- UMSCHALT-CHIPS STATT CHECKBOX PLUS BADGE (Re-Critique 2026-09-28,
             A4 P2-7): jede Option trug eine native Checkbox UND ein Farbbadge -
             zwei Zeichen fuer eine Wahl; der Kanon fuehrt die native Checkbox
             fuer Mehrfachauswahl unter "Nicht mehr". -->
        <div class="recipe-meal-types" id="recipe-meal-types" role="group" aria-labelledby="recipe-meal-types-label">
          ${mealTypeOptions().map((option) => `
            <button type="button" class="filter-chip recipe-meal-types__chip" data-meal-type="${option.key}" aria-pressed="false">${esc(option.label)}</button>
          `).join('')}
          <input type="hidden" id="recipe-meal-types-value" value="">
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('recipes.ingredientsLabel')}</label>
        <div class="recipe-ingredient-list" id="recipe-ingredient-list"></div>
        <button class="btn btn--secondary recipe-add-ingredient" type="button" id="recipe-add-ingredient"><i data-lucide="plus" class="icon-md" aria-hidden="true"></i>${t('meals.addIngredient')}</button>
      </div>
      <div class="form-group">
        <label class="form-label" for="recipe-cookTime">${t('Cook Time')}</label>
        <input id="recipe-cookTime" class="form-input" type="text" placeholder="${t('e.g. 10 minutes')}">
      </div>
      <div class="form-group">
        <label class="form-label" for="recipe-prepTime">${t('Prep Time')}</label>
        <input id="recipe-prepTime" class="form-input" type="text" placeholder="${t('e.g. 5 minutes')}">
      </div>
      <div class="form-group">
        <label class="form-label" for="recipe-servings">${t('Servings')}</label>
        <input id="recipe-servings" class="form-input" type="number" min="1" placeholder="${t('# of servings')}">
      </div>
      ${advancedSection(`
        <div class="form-group">
          <label class="form-label" for="recipe-notes">${t('recipes.notesLabel')}</label>
          <textarea id="recipe-notes" class="form-input" rows="3" placeholder="${t('recipes.notesPlaceholder')}"></textarea>
        </div>
        ${/* Ein eigenes Bild (#1059, Schritt 2) - fuer gespiegelte Rezepte
            * ausgeblendet: die sind hier ohnehin schreibgeschuetzt, ihr Inhalt
            * gehoert dem Provider. */ ''}
        <div class="form-group" id="recipe-image-group"${isEdit && recipe?.source !== 'native' ? ' hidden' : ''}>
          <label class="form-label">${t('recipes.imageLabel')}</label>
          <div class="recipe-image-editor">
            <button type="button" class="recipe-image-preview" id="recipe-image-preview"
                    aria-label="${esc(t('recipes.imageLabel'))}"></button>
            <input class="sr-only" id="recipe-image" type="file" accept="image/png,image/jpeg,image/webp"
                   aria-label="${esc(t('recipes.imageLabel'))}" tabindex="-1">
            <button type="button" class="btn btn--secondary btn--sm" id="recipe-image-pick">${t('recipes.imageChoose')}</button>
            <button type="button" class="btn btn--ghost btn--sm" id="recipe-image-remove">${t('recipes.imageRemove')}</button>
          </div>
          <p class="form-hint">${t('recipes.imageHint')}</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="recipe-cuisine">${t('Cuisine')}</label>
          <input id="recipe-cuisine" class="form-input" type="text" placeholder="${t('Cuisine')}">
        </div>
        <div class="form-group">
          <span class="form-label" id="recipe-diet-label">${t('recipes.dietLabel')}</span>
          <!-- UMSCHALT-CHIPS WIE BEI DEN MAHLZEITEN darueber - dieselbe Frage
               ("trifft alles zu, was passt"), dieselbe Grammatik
               (.filter-chip + aria-pressed). Die chips des kuratierten Sechser-
               Sets kommen aus RECIPE_DIET_KEYS (utils/recipe-diets.js); ein
               gespeicherter Wert AUSSERHALB dessen (Importer-Vokabular, das
               die Normalisierung nicht kannte) kommt beim Bearbeiten als
               eigener gepresster Chip dazu - desselbe Muster laesst ihn
               sichtbar, speicherbar und abwaehlbar, ohne ihn zu verlieren. -->
          <div class="recipe-diet-chips" id="recipe-diet" role="group" aria-labelledby="recipe-diet-label"></div>
        </div>
        <div class="form-group">
          <label class="form-label" for="recipe-url">${t('recipes.urlLabel')}</label>
          <input id="recipe-url" class="form-input" type="url" placeholder="${t('recipes.urlPlaceholder')}">
        </div>`,
        { open: isEdit && (!!recipe.notes || !!recipe.recipe_url) })}
      ${recipeModalFooterHtml(isEdit, recipe)}
    `,
    onSave(panel) {
      panel.querySelector('#recipe-title').value = isEdit ? recipe.title : '';
      panel.querySelector('#recipe-notes').value = isEdit && recipe.notes ? recipe.notes : '';
      panel.querySelector('#recipe-url').value = isEdit && recipe.recipe_url ? recipe.recipe_url : '';
      // Neue Felder: beim Bearbeiten die gespeicherten Werte zeigen - der Server
      // traegt sie (GET /recipes liefert alle Spalten), nur die Felder blieben leer.
      panel.querySelector('#recipe-cuisine').value = isEdit && recipe.cuisine ? recipe.cuisine : '';
      panel.querySelector('#recipe-cookTime').value = isEdit && recipe.cookTime ? recipe.cookTime : '';
      panel.querySelector('#recipe-prepTime').value = isEdit && recipe.prepTime ? recipe.prepTime : '';
      panel.querySelector('#recipe-servings').value = isEdit && recipe.servings ? recipe.servings : '';

      /* DIET: das kuratierte Sechser-Set als Chips, gespeicherte Werte dahinter,
       * die ausserhalb davon liegen (der Server speichert jedes Importer-Vokabular
       * wortgetreu). Ein Wert, der doppelt vorkommt - normalisiert AND gespeichert,
       * wie "gluten-free" neben "gf" vor der Server-Normalisierung -, belegt nur
       * den Chip, der schon da ist. */
      const dietWrap = panel.querySelector('#recipe-diet');
      const savedDiet = isEdit && Array.isArray(recipe.diet) ? recipe.diet : [];
      const extraDiets = savedDiet.filter((d) => !RECIPE_DIET_KEYS.includes(d));
      const dietChipLabel = (d) => (RECIPE_DIET_KEYS.includes(d) ? t(recipeDietLabelKey(d)) : d);
      if (dietWrap) {
        dietWrap.insertAdjacentHTML('beforeend', [...RECIPE_DIET_KEYS, ...extraDiets].map((d) => `
          <button type="button" class="filter-chip recipe-diet-chips__chip${savedDiet.includes(d) ? ' filter-chip--active' : ''}" data-diet="${esc(d)}" aria-pressed="${savedDiet.includes(d) ? 'true' : 'false'}">${esc(dietChipLabel(d))}</button>
        `).join(''));
        dietWrap.addEventListener('click', (e) => {
          const chip = e.target.closest('[data-diet]');
          if (!chip) return;
          const on = chip.getAttribute('aria-pressed') !== 'true';
          chip.setAttribute('aria-pressed', String(on));
          // OPTISCHER AKTIVZUSTAND WIE BEI DEN MAHLZEIT-CHIPS darueber: der
          // Kanon traegt ihn an der Klasse .filter-chip--active (filter-chip.css),
          // nicht am aria-Attribut - die Mahlzeiten setzen beide zusammen, und
          // ohne die Klasse bleibt ein gepresster Diet-Chip im Ruhezustand stehen.
          chip.classList.toggle('filter-chip--active', on);
        });
      }

      /* BILD (#1059, Schritt 2) - dasselbe Vorgehen wie beim Gegenstandsfoto:
       * Auswahl, Zuschnitt und Groessenpruefung macht `pickCroppedImage`.
       *
       * `bildStand` traegt DREI Zustaende, und die dritte ist der Grund fuer die
       * Fallunterscheidung beim Speichern: `undefined` heisst "nicht angefasst"
       * (der Server laesst das gespeicherte Bild stehen), `null` heisst "entfernt",
       * eine Data-URL heisst "das hier". Ohne den Unterschied schickte jedes
       * Speichern eines bebilderten Rezepts entweder null (Bild weg) oder muesste
       * die ganze Data-URL erneut hochladen. */
      let bildStand;
      const bildVorschau = panel.querySelector('#recipe-image-preview');
      const bildInput = panel.querySelector('#recipe-image');
      const zeigeBild = () => {
        if (!bildVorschau) return;
        bildVorschau.replaceChildren();
        // Beim Bearbeiten kommt das gespeicherte Bild ueber die Route, nicht aus
        // den Listendaten - dort steht nur das Flag (die Data-URL waere zu gross).
        const quelle = bildStand !== undefined
          ? bildStand
          : (isEdit && recipe?.has_own_image ? `/api/v1/recipes/${recipe.id}/image` : null);
        if (quelle) {
          const img = document.createElement('img');
          img.className = 'recipe-image-preview__img';
          img.src = quelle;
          img.alt = '';
          bildVorschau.appendChild(img);
        } else {
          bildVorschau.insertAdjacentHTML('beforeend', '<i data-lucide="image-plus" class="icon-md" aria-hidden="true"></i>');
          if (window.lucide) window.lucide.createIcons({ el: bildVorschau });
        }
      };
      zeigeBild();
      bildVorschau?.addEventListener('click', () => bildInput?.click());
      panel.querySelector('#recipe-image-pick')?.addEventListener('click', () => bildInput?.click());
      bildInput?.addEventListener('change', async (e) => {
        const datei = e.target.files?.[0];
        // Sofort zuruecksetzen: sonst feuert dieselbe Datei nach einem
        // abgebrochenen Zuschnitt kein zweites `change`.
        e.target.value = '';
        try {
          const { pickCroppedImage } = await import('/utils/avatar-crop.js');
          const zugeschnitten = await pickCroppedImage(datei, {
            messageKeys: { dataTooLarge: 'recipes.imageTooLarge' },
          });
          if (zugeschnitten === undefined) return; // abgebrochen
          bildStand = zugeschnitten;
          zeigeBild();
        } catch (err) {
          window.yuvomi?.showToast(err.message, 'danger');
        }
      });
      panel.querySelector('#recipe-image-remove')?.addEventListener('click', () => {
        bildStand = null;
        zeigeBild();
      });
      panel.dataset.bildGesetzt = '';
      panel._bildStand = () => bildStand;
      const selectedMealTypes = normalizeRecipeMealTypes(isEdit ? recipe.meal_types : RECIPE_MEAL_TYPE_KEYS);
      // Der Dialog vergleicht fuer "Aenderungen verwerfen?" die Werte seiner
      // Felder (modal.js); ein Knopf hat keinen. Das versteckte Feld traegt die
      // Auswahl als Wert - ohne es verwarf Schliessen eine geaenderte Auswahl still.
      const typesValue = panel.querySelector('#recipe-meal-types-value');
      const syncTypesValue = () => {
        typesValue.value = [...panel.querySelectorAll('#recipe-meal-types [aria-pressed="true"]')]
          .map((chip) => chip.dataset.mealType).join(',');
      };
      panel.querySelectorAll('#recipe-meal-types [data-meal-type]').forEach((chip) => {
        const setPressed = (on) => {
          chip.setAttribute('aria-pressed', String(on));
          chip.classList.toggle('filter-chip--active', on);
        };
        setPressed(selectedMealTypes.includes(chip.dataset.mealType));
        chip.addEventListener('click', () => {
          setPressed(chip.getAttribute('aria-pressed') !== 'true');
          syncTypesValue();
        });
      });
      syncTypesValue();

      const ingList = panel.querySelector('#recipe-ingredient-list');
      if (isEdit && recipe.ingredients?.length) {
        /* ABSCHNITTS-TITEL ZWISCHEN DEN ZEILEN (v244): Die Ueberschrift entsteht
         * an jedem FOLGEWECHSEL des section-Werts (run-grouping, gleiche Regel
         * wie im Detail) - derselbe Name an zwei Stellen ergibt zwei Titel,
         * weil der Importer zwei Gruppen meinte. Nicht editierbar: kein Feld,
         * nur Text. Die Zeile darunter traegt den Wert als data-Attribut und
         * reicht ihn beim Speichern mit (dasselbe wie die Zweitangabe, siehe
         * saveRecipe). */
        const rowsHtml = [];
        let prevSection = '';
        for (const i of recipe.ingredients) {
          const section = i.section ?? '';
          if (section && section !== prevSection) {
            rowsHtml.push(`<div class="recipe-section-heading" role="presentation">${esc(section)}</div>`);
          }
          prevSection = section;
          rowsHtml.push(ingredientRowHTML({
            name: i.name,
            quantity: i.quantity ?? '',
            unit: i.unit ?? '',
            note: i.note ?? '',
            section,
            secondaryQuantity: i.secondary_quantity ?? '',
            secondaryUnit: i.secondary_unit ?? '',
            category: i.category ?? DEFAULT_CATEGORY_NAME,
            categories: mealCategories(),
            withUnit: true,
            withNote: true,
          }));
        }
        ingList.insertAdjacentHTML('beforeend', rowsHtml.join(''));
      }

      panel.querySelector('#recipe-add-ingredient')?.addEventListener('click', () => {
        ingList.insertAdjacentHTML('beforeend', ingredientRowHTML({ categories: mealCategories(), withUnit: true, withNote: true }));
        if (window.lucide) window.lucide.createIcons({ el: ingList });
      });

      ingList.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action="remove-ingredient"]');
        if (!btn) return;
        btn.closest('.ingredient-row')?.remove();
        // Ein Abschnitts-Titel, dessen letzte Zeile verschwand, haengt leer:
        // auessere ihn. Ein Titel zaehlt als leer, wenn unmittelbar nach ihm
        // wieder ein Titel oder das Ende der Liste kommt.
        [...ingList.children()].forEach((el) => {
          if (el.classList.contains('recipe-section-heading')
            && (!el.nextElementSibling || el.nextElementSibling.classList.contains('recipe-section-heading'))) {
            el.remove();
          }
        });
      });

      panel.querySelector('#recipe-cancel')?.addEventListener('click', closeModal);
      panel.querySelector('#recipe-delete')?.addEventListener('click', () => {
        closeModal({ force: true });
        removeRecipe(recipe);
      });
      panel.querySelector('#recipe-save')?.addEventListener('click', () => saveRecipe(panel, mode, recipe));
      // Pflichtfelder melden sich beim Verlassen inline (geteiltes Muster).
      wireBlurValidation(panel);

      if (window.lucide) window.lucide.createIcons({ el: panel });
    },
  });
}

function closeModal({ force = false } = {}) {
  closeSharedModal({ force });
}

async function saveRecipe(panel, mode, recipe) {
  const saveBtn = panel.querySelector('#recipe-save');
  const title = panel.querySelector('#recipe-title')?.value.trim() || '';
  const notes = panel.querySelector('#recipe-notes')?.value.trim() || null;
  const recipe_url = panel.querySelector('#recipe-url')?.value.trim() || null;
  const meal_types = [...panel.querySelectorAll('#recipe-meal-types [aria-pressed="true"]')].map((chip) => chip.dataset.mealType);
  const cuisine = panel.querySelector('#recipe-cuisine')?.value.trim() || null;
  const cookTime = panel.querySelector('#recipe-cookTime')?.value.trim() || null;
  const prepTime = panel.querySelector('#recipe-prepTime')?.value.trim() || null;
  const servings = panel.querySelector('#recipe-servings')?.value.trim() || null;
  // Diet: alle gepressten Chips (kuratiert + Importer-Extras) in Klickreihen-
  // folge des Nutzers; der Server normalisiert ohnehin und zieht Dubletten zusammen.
  const diet = [...panel.querySelectorAll('#recipe-diet [aria-pressed="true"]')].map((chip) => chip.dataset.diet);
  
  if (!title) {
    // Fehler am Feld statt als ortloser Toast (geteiltes Muster, Critique P1).
    reportFieldError(panel.querySelector('#recipe-title'), t('common.nameRequired'));
    return;
  }

  const ingredients = [];
  /* ZWEITANGABE UND ABSCHNITT (v243/v244) HABEN KEIN FELD IM MODAL - aber der
   * PUT ersetzt die ganze Zutatenliste, und ohne Mitgeben fielen sie bei jedem
   * Speichern weg. Sie reisen als DATA-ATTRIBUT AN DER ZEILE (gerendert beim
   * Oeffnen, ingredient-row.js), nicht an einem Namens-Lookup: der Anker ist
   * die Zeile selbst, und damit sind DUPLETTE NAMEN kein Fehler - "hot water"
   * kann in zwei Abschnitten mit verschiedenen Zweitangaben stehen, und jede
   * Zeile behaelt ihre eigene. Eine NEUE Zeile (+ Zutat) hat keine Attribute
   * und speichert folglich ohne Zweitangabe und ohne Abschnitt. */
  panel.querySelectorAll('.ingredient-row').forEach((row) => {
    const name = row.querySelector('.ingredient-row__name')?.value.trim() || '';
    const quantity = row.querySelector('.ingredient-row__qty')?.value.trim() || null;
    const unit = row.querySelector('.ingredient-row__unit')?.value.trim() || null;
    // Zubereitungs-Hinweis ("thinly sliced") - nur im Rezept-Modal vorhanden,
    // optionales `?.` haelt eine fremde Zeile (Mahlzeiten) ohne das Feld gueltig.
    const note = row.querySelector('.ingredient-row__note')?.value.trim() || null;
    const category = row.querySelector('.ingredient-row__cat')?.value || DEFAULT_CATEGORY_NAME;
    // dataset ist camelCase: data-secondary-quantity -> secondaryQuantity.
    const secondaryQuantity = row.dataset.secondaryQuantity || null;
    const secondaryUnit = row.dataset.secondaryUnit || null;
    const section = row.dataset.section || null;
    if (name) ingredients.push({ name, quantity, unit, note, category, secondaryQuantity, secondaryUnit, section });
  });

  // Nur mitschicken, wenn der Nutzer das Bild angefasst hat: ein fehlendes Feld
  // laesst das gespeicherte stehen (#1059).
  const bildStand = panel._bildStand?.();
  const bildFeld = bildStand === undefined ? {} : { image_data: bildStand };

  saveBtn.disabled = true;

  try {
    let createdId = null;
    if (mode === 'create') {
      const res = await api.post('/recipes', { title, notes, recipe_url, meal_types, ingredients, cuisine, cookTime, prepTime, servings, diet, ...bildFeld });
      state.recipes.push(res.data);
      createdId = res.data?.id ?? null;
    } else {
      const res = await api.put(`/recipes/${recipe.id}`, { title, notes, recipe_url, meal_types, ingredients, cuisine, cookTime, prepTime, servings, diet, ...bildFeld });
      const idx = state.recipes.findIndex((r) => r.id === recipe.id);
      if (idx >= 0) state.recipes[idx] = res.data;
    }

    closeModal({ force: true });
    renderRecipeList({ repaint: true });
    // In der Spalte steht das neue Rezept gleich rechts - wie eine neue Notiz
    // in Notizen. Darunter bleibt die Liste, wie sie war.
    if (createdId != null) selectOwnRecipe(createdId);
    window.yuvomi?.showToast(mode === 'create' ? t('recipes.created') : t('recipes.updated'), 'success');
  } catch (err) {
    saveBtn.disabled = false;
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

// --------------------------------------------------------
// Zutaten → Einkaufsliste
// --------------------------------------------------------

/**
 * Übernimmt die Zutaten eines Rezepts auf eine Einkaufsliste. Bei genau einer
 * Liste ohne Rückfrage, sonst über die geteilte Auswahl - dasselbe Muster wie
 * transferMeal() im Essensplan, damit sich der Weg in beiden Modulen gleich
 * anfühlt. Der Server überspringt Zutaten, die schon unabgehakt auf der Liste
 * liegen; die Rückmeldung nennt beide Zahlen.
 */
/**
 * Rezept in den Essensplan übernehmen: fragt „Für wann?" hier und legt die
 * Mahlzeit direkt an.
 *
 * Vorher navigierte dieser Weg auf `/meals?recipe=<id>`, wo ein Formular mit 27
 * Feldern aufging - Titel „Mahlzeit hinzufügen" ohne das Rezept zu nennen, das
 * Datumsfeld leer, 42 % des Dialogs unter der Sichtkante. Nach Escape blieb
 * `?recipe=` in der URL und ein Reload öffnete das Formular erneut, beliebig oft
 * (Critique 2026-07-29). Als einziger der fünf Transfers folgte er nicht dem
 * Muster der anderen.
 *
 * Jetzt zwei Entscheidungen statt neun Feldern, kein Seitenwechsel, und der
 * Query-Parameter existiert nicht mehr - der Zombie ist damit strukturell weg,
 * nicht per `replaceState` kaschiert. Details lassen sich danach im Essensplan
 * bearbeiten, wie bei jeder anderen Mahlzeit.
 */
async function planRecipe(recipe, btn) {
  const declared = normalizeRecipeMealTypes(recipe.meal_types);
  // Erklärt das Rezept keine Mahlzeit, stehen hier trotzdem alle zur Wahl: Der
  // leere Zustand hält es aus der Zufallsauswahl heraus (#750), nicht aus dem
  // Menüplan. Ohne diesen Rückgriff bliebe das Auswahlfeld leer und der Dialog
  // hätte nichts anzubieten, was der Nutzer bestätigen könnte.
  const types = declared.length ? declared : RECIPE_MEAL_TYPE_KEYS.slice();
  // Vorauswahl: erklärt das Rezept genau einen Typ, ist die Sache klar. Erklärt
  // es mehrere - was der Default ist, wenn niemand etwas gesetzt hat -, dann
  // stand bisher „Frühstück" da, weil es in der Liste zuerst kommt: der Dialog
  // schlug für ein Curry das Frühstück vor (Critique 2026-07-30). Ohne Signal
  // vom Rezept ist das Abendessen die ehrlichere Annahme, es ist die Mahlzeit,
  // die Haushalte am häufigsten planen.
  const vorauswahl = types.length === 1 ? types[0] : (types.includes('dinner') ? 'dinner' : types[0]);
  const typeOpts = mealTypeOptions()
    .filter(({ key }) => types.includes(key))
    .map(({ key, label }) =>
      `<option value="${key}"${key === vorauswahl ? ' selected' : ''}>${esc(label)}</option>`)
    .join('');

  const today = todayKey();

  openSharedModal({
    title: t('recipes.planTitle', { name: recipe.title }),
    size: 'sm',
    content: `
      <div class="form-group">
        <label class="form-label" for="plan-date">${t('meals.dateLabel')}</label>
        <yuvomi-datepicker type="date" id="plan-date" value="${esc(formatDateInput(today))}"></yuvomi-datepicker>
      </div>
      <div class="form-group">
        <label class="form-label" for="plan-type">${t('meals.mealTypeLabel')}</label>
        <select class="form-input" id="plan-type">${typeOpts}</select>
      </div>
      <div class="modal-panel__footer modal-panel__footer--plain">
        <button type="button" class="btn btn--secondary" data-action="close-modal">${esc(t('common.cancel'))}</button>
        <!-- „Übernehmen", nicht die Wiederholung des Auslöser-Labels: die drei
             anderen Transfer-Dialoge bestätigen genauso, und der Dialogtitel
             nennt Rezept und Ziel bereits (Critique 2026-07-30). -->
        <button type="button" class="btn btn--primary" id="plan-confirm">${esc(t('common.apply'))}</button>
      </div>`,
    onSave(panel) {
      panel.querySelector('#plan-confirm').addEventListener('click', async (e) => {
        const confirmBtn = e.currentTarget;
        const dateField = panel.querySelector('#plan-date');
        if (!isDateInputValid(dateField.value)) {
          reportFieldError(dateField, t('calendar.invalidDate'));
          return;
        }
        const date = parseDateInput(dateField.value);
        const mealType = panel.querySelector('#plan-type').value;

        confirmBtn.disabled = true;
        try {
          await api.post('/meals', mealPayloadFromRecipe(recipe, date, mealType));
          closeSharedModal({ force: true });
          window.yuvomi?.showToast(
            t('recipes.planSuccess', { name: recipe.title, date: formatDate(date) }),
            'success',
          );
        } catch (err) {
          window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
          confirmBtn.disabled = false;
        }
      });
    },
  });

  if (btn) btn.blur();
}

/**
 * Der Knopf „Auf die Einkaufsliste" im Rezeptdetail - oder `null`, wenn er
 * nichts ausloesen koennte: ohne Liste, ohne Zutaten, oder weil der Server ihn
 * abwiese. Das sind ZWEI Riegel (#1290): `/recipes` misst der Pfad-Guard als
 * `meals`, die Route verlangt dazu `shopping`. Mit `shopping: read` laedt
 * `state.lists` trotzdem - die Liste allein ist also keine Erlaubnis.
 */
function shoppingTransferButton(recipe, ingredients) {
  if (!state.lists.length || !ingredients.length) return null;
  if (!mayTransferRecipeToShopping(recipe.id)) return null;
  const btn = document.createElement('button');
  btn.className = 'btn btn--secondary';
  btn.type = 'button';
  btn.dataset.action = 'to-shopping';
  btn.dataset.id = String(recipe.id);
  // Der Knopf benennt, was er uebernimmt: „Alles auf die Einkaufsliste",
  // solange kein Kaetzchen steht, und „<n> auf die Einkaufsliste" fuer jede
  // Teilwahl - dasselbe Verhalten wie vorher im ersten Fall, im zweiten ein
  // Vertrag, der nur die gewaehlten Zeilen meint.
  btn.textContent = shoppingButtonLabel(recipe);
  return btn;
}

async function transferRecipe(recipe, btn) {
  // Zweite Linie hinter dem Markup (Regel 2 in utils/module-access.js).
  if (!mayTransferRecipeToShopping(recipe.id)) return;
  // Vorprüfung, Listenwahl und die Antwort auf „es gibt keine Liste" liegen im
  // geteilten Baustein. Vorher lieh sich diese Stelle `meals.noShoppingLists` -
  // der Text der Rezepte hing damit an einem fremden Modul, und ein Refactor im
  // Essensplan hätte ihn stillschweigend mitgenommen (Audit 2026-07-30, P1-A).
  const target = await resolveShoppingTarget(state.lists);
  if (!target) return;

  if (btn) btn.disabled = true;
  try {
    // TEILWAHL: stehen Kaetzchen an Zutaten, wandert NUR diese Auswahl. Ein
    // leeres Feld fehlt ganz (kein `ingredientIds: []`) - der Weg faellt auf
    // die ganze Liste zurueck, derselbe Vertrag wie vor den Checkboxen, und
    // jeder bestaehende Client und Token bleibt unberuehrt.
    const selected = selectedIngredientIds(recipe);
    const res = await api.post(`/recipes/${recipe.id}/to-shopping-list`, {
      listId: target.id,
      ...(selected.length ? { ingredientIds: selected } : {}),
    });
    const added = res.data?.transferred ?? 0;
    const skipped = res.data?.skipped ?? 0;

    if (added > 0) {
      // t() wählt die _one-Form selbst, sobald count numerisch ist (i18n.js).
      // `list` nennt das Ziel: „5 Zutaten übernommen." sagte nicht, in welche der
      // Listen (Critique 2026-07-30, P1).
      //
      // Rücknahme über den geteilten Baustein: dieser Pfad überträgt am meisten
      // auf einmal - eine ganze Zutatenliste - in eine Liste, die der Nutzer
      // gerade nicht ansieht (Audit 2026-07-30, P1-B).
      announceTransfer({
        message: t('recipes.toShoppingSuccess', { count: added, list: target.name }),
        addedIds: res.data?.added_ids ?? [],
      });
    } else if (skipped > 0) {
      window.yuvomi?.showToast(t('recipes.toShoppingAllPresent'), 'info');
    } else {
      window.yuvomi?.showToast(t('recipes.toShoppingNoIngredients'), 'info');
    }
    // Die Auswahl antwortete auf EINEN Einkauf: nach jedem erfolgreichen
    // Transfer faellt der Knopf auf „Alles" zurueck - auch „steht schon
    // drauf" ist ein erledigter Einkauf. Ein FEHLER haelt die Auswahl, der
    // Weg laesst sich sofort wieder versuchen.
    clearIngredientSelection(recipe.id);
    updateShoppingButtons(recipe);
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeRecipe(recipe) {
  const itemEl = _container.querySelector(`.recipe-row-item[data-id="${recipe.id}"]`);
  if (itemEl) itemEl.style.display = 'none';
  // Steht das Rezept rechts in der Detailspalte, geht es dort mit: sonst
  // zeigte die Spalte ein Rezept, das die Liste schon nicht mehr fuehrt.
  // Rueckgaengig waehlt es wieder aus.
  const wasSelected = _md?.selectedId() === String(recipe.id);
  if (wasSelected) {
    _md.clear({ history: 'replace' });
    _container?.querySelector('#recipes-detail')?.focus();
  }

  // Track whether the API delete has already executed to prevent double-deletes
  let deleteExecuted = false;

  scheduleUndoableDelete({
    message: t('recipes.deleted'),
    commit: async ({ keepalive }) => {
      // Prevent double-execution if fallback timeout also fires
      if (deleteExecuted) return;
      deleteExecuted = true;
      await api.delete(`/recipes/${recipe.id}`, { keepalive });
      if (keepalive) return; // Seite verschwindet — kein UI-Refresh mehr
      state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
      renderRecipeList();
    },
    restore: (err) => {
      // Only restore if the delete actually failed (err is truthy)
      // AND the delete hasn't already completed via the fallback timeout
      if (err && !deleteExecuted) {
        if (itemEl) itemEl.style.display = '';
        if (wasSelected && _md?.isSplit()) _md.select(recipe.id, { history: 'replace' });
        if (err) window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
    },
  });

  // Fallback: ensure API delete executes after 30s, even if toast dismisses first
  // and clears scheduleUndoableDelete's timer. This prevents recipes from
  // staying in a "half-deleted" state (hidden in UI but still in DB).
  setTimeout(async () => {
    if (!deleteExecuted) {
      deleteExecuted = true;
      try {
        await api.delete(`/recipes/${recipe.id}`, { keepalive: true });
        state.recipes = state.recipes.filter((r) => r.id !== recipe.id);
        renderRecipeList();
      } catch (err) {
        // Delete failed - restore UI so user can retry
        if (itemEl) itemEl.style.display = '';
        if (wasSelected && _md?.isSplit()) _md.select(recipe.id, { history: 'replace' });
        window.yuvomi?.showToast(err.data?.error ?? t('common.unknownError'), 'danger');
      }
    }
  }, 30000);
}

/**
 * Waehlt in der Spalte ein Rezept aus, das die Seite gerade selbst angelegt
 * hat (Neu, Duplizieren).
 *
 * Ein benanntes Ziel schlaegt einen alten Filter (#936, dort fuer den
 * Deep-Link). Die Kopie eines Mealie-Rezepts ist nativ und faellt aus dem
 * Quellenfilter "Mealie"; ein neues Rezept passt nicht zwingend zur Suche.
 * Unbedingt ausgewaehlt stand rechts ein Rezept ohne Zeile links (Codex an
 * #1477). Also fallen Suche und Filter weg, BEVOR ausgewaehlt wird - und nur
 * dann, wenn das Rezept sonst fehlte: wer unter "Suppe" eine Suppe anlegt,
 * behaelt seine Suche.
 */
function selectOwnRecipe(id) {
  if (!_md?.isSplit()) return;
  if (!filteredRecipes().some((r) => String(r.id) === String(id))) {
    state.query = '';
    state.sourceFilter = 'all';
    _search?.clear();
    renderSourceFilter();
    renderRecipeList();
  }
  _md.select(id);
}

async function duplicateRecipe(recipe) {
  const copySuffix = t('recipes.copySuffix');
  const title = `${recipe.title} (${copySuffix})`;
  const notes = recipe.notes || null;
  const recipe_url = recipe.recipe_url || null;
  const ingredients = (recipe.ingredients || []).map((ing) => ({
    name: ing.name,
    quantity: ing.quantity || null,
    category: ing.category || DEFAULT_CATEGORY_NAME,
  }));

  try {
    const res = await api.post('/recipes', { title, notes, recipe_url, ingredients });
    state.recipes.push(res.data);
    renderRecipeList();
    // Die Kopie ist das, was man als Naechstes bearbeitet: in der Spalte steht
    // sie deshalb gleich rechts.
    if (res.data?.id != null) selectOwnRecipe(res.data.id);
    window.yuvomi?.showToast(t('recipes.duplicated'), 'success');
  } catch (err) {
    window.yuvomi?.showToast(err.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

export const __test = {
  // #1290: der Transfer in den Einkauf braucht BEIDE Schreibrechte - Knopf und
  // Handler werden als Programm gefahren (test-kitchen-transfer-ui.js).
  state,
  shoppingTransferButton,
  transferRecipe,
  // Die Teilwahl (2026-10-21): Auswahl-Karte, ihre Helfer und die beiden
  // Renderer, an denen Checkboxen bzw. ihr Fehlen gemessen werden.
  selectedIngredientIds,
  toggleIngredientSelection,
  clearIngredientSelection,
  shoppingButtonLabel,
  ingredientsSectionEl,
  fillRecipeDetail,
  // R8 H10: Loeschen links im Dialogfuss.
  recipeModalFooterHtml,
};
