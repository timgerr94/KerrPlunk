import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { confirmModal } from '/components/modal.js';
import { toggleRowHtml } from '/settings/components.js';
import { getPreferences, savePreferences } from '/settings/preferences-cache.js';

// Spiegelt MAX_POINTS in server/routes/tasks.js.
const MAX_TASK_POINTS = 10000;

// Die Jubel-Arten beim Einloesen - derselbe Wertebereich wie in
// services/rewards.js (Server) und utils/confetti.js (Browser): drei Stellen,
// ein Satz Schluessel, damit keine von ihnen eine eigene Wahrheit entwickelt.
const CELEBRATION_MODES = ['off', 'confetti', 'fireworks', 'stars'];
const CELEBRATION_LABEL_KEYS = {
  off: 'settings.rewardsCelebrationOff',
  confetti: 'settings.rewardsCelebrationConfetti',
  fireworks: 'settings.rewardsCelebrationFireworks',
  stars: 'settings.rewardsCelebrationStars',
};

function celebrationOf(preferences) {
  return CELEBRATION_MODES.includes(preferences.rewards_celebration)
    ? preferences.rewards_celebration
    : 'confetti';
}

// KEIN AN/AUS-SCHALTER MEHR (Re-Critique 2026-09-27, A7 P1-3): "Belohnungen
// aktivieren" stand hier UND in Aktive Module - zwei Schalter fuer denselben
// Eintrag in `disabled_modules`. Das Modul geht nur noch dort an und aus; die
// Statuszeile des Blatts (shell.js) zeigt den Zustand und verlinkt dorthin.

function renderPage(container, preferences) {
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsApprovalTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsApprovalHint')}</p>
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.rewardsApprovalLabel'),
          checked: preferences.rewards_require_approval !== false,
          attrs: { id: 'rewards-require-approval' },
        })}
      </div>
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsCelebrationTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsCelebrationHint')}</p>
        <!-- EIN SPEICHERMODELL AUF DER SEITE: die Auswahl wirkt sofort wie der
             Freigabe-Schalter daneben, ohne eigenen Speichern-Knopf. -->
        <div class="form-group">
          <label class="form-label" for="rewards-celebration">${t('settings.rewardsCelebrationLabel')}</label>
          <select class="form-input" id="rewards-celebration" data-persisted="${esc(celebrationOf(preferences))}">
            ${CELEBRATION_MODES.map((mode) => `<option value="${mode}"${mode === celebrationOf(preferences) ? ' selected' : ''}>${esc(t(CELEBRATION_LABEL_KEYS[mode]))}</option>`).join('')}
          </select>
        </div>
        ${toggleRowHtml({
          control: 'switch',
          label: t('settings.rewardsLottieLabel'),
          checked: preferences.rewards_lottie === true,
          attrs: { id: 'rewards-lottie' },
        })}
        <p class="settings-card-description">${t('settings.rewardsLottieHint')}</p>
      </div>
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsHistoryTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsHistoryHint')}</p>
        <button type="button" class="btn btn--danger-outline" id="rewards-clear-history">${t('settings.rewardsHistoryClear')}</button>
      </div>
      <div class="settings-card">
        <h2 class="settings-card__title">${t('settings.rewardsDefaultPointsTitle')}</h2>
        <p class="form-hint">${t('settings.rewardsDefaultPointsHint')}</p>
        <!-- EIN SPEICHERMODELL AUF DER SEITE (Re-Critique 2026-09-27, A7 P2-8):
             die Schalter daneben speichern sofort, also tut es das Zahlenfeld
             auch - beim Verlassen und mit Enter. Ein eigener Speichern-Knopf nur
             fuer dieses Feld liess offen, ob die Schalter ihn auch brauchen. -->
        <form class="settings-form settings-form--compact" id="rewards-default-points-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="rewards-default-points">${t('settings.rewardsDefaultPointsLabel')}</label>
            <input class="form-input" type="number" id="rewards-default-points" inputmode="numeric"
                   min="0" max="${MAX_TASK_POINTS}" step="1" enterkeyhint="done"
                   aria-describedby="rewards-default-points-off-hint rewards-default-points-error"
                   value="${Number(preferences.tasks_default_points) || 0}">
            <p class="settings-card-description" id="rewards-default-points-off-hint">${t('settings.rewardsDefaultPointsOffHint')}</p>
          </div>
          <div id="rewards-default-points-error" class="form-error" role="alert" hidden></div>
        </form>
      </div>
    </section>
  `);
}

function bindEvents(container, preferences) {
  const approvalToggle = container.querySelector('#rewards-require-approval');
  approvalToggle?.addEventListener('change', async () => {
    approvalToggle.disabled = true;
    try {
      await savePreferences({ rewards_require_approval: approvalToggle.checked });
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      approvalToggle.checked = !approvalToggle.checked;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      approvalToggle.disabled = false;
    }
  });

  const celebrationSelect = container.querySelector('#rewards-celebration');
  celebrationSelect?.addEventListener('change', async () => {
    const previous = celebrationSelect.dataset.persisted || 'confetti';
    const next = celebrationSelect.value;
    celebrationSelect.disabled = true;
    try {
      await savePreferences({ rewards_celebration: next });
      celebrationSelect.dataset.persisted = next;
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      celebrationSelect.value = previous;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      celebrationSelect.disabled = false;
    }
  });

  const lottieToggle = container.querySelector('#rewards-lottie');
  lottieToggle?.addEventListener('change', async () => {
    lottieToggle.disabled = true;
    try {
      await savePreferences({ rewards_lottie: lottieToggle.checked });
      window.yuvomi?.showToast(t('settings.rewardsSaved'), 'success');
    } catch (error) {
      lottieToggle.checked = !lottieToggle.checked;
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      lottieToggle.disabled = false;
    }
  });

  const clearBtn = container.querySelector('#rewards-clear-history');
  clearBtn?.addEventListener('click', async () => {
    clearBtn.disabled = true;
    try {
      // ZWEIMAL FRAGEN, EINMAL LOESCHEN. Die erste Rueckfrage nennt die
      // Konsequenz (alle Salden auf 0), die zweite verlangt das ausdrueckliche
      // Bestätigen - dasselbe Muster wie beim Logout anderer Sessions. Ein
      // einmaliges "OK" soll niemandem die Punkte aller Kinder wegklicken.
      const first = await confirmModal(t('settings.rewardsHistoryConfirm'),
        { confirmLabel: t('settings.rewardsHistoryClear'), danger: true });
      if (!first) return;
      const second = await confirmModal(t('settings.rewardsHistoryConfirm2'),
        { confirmLabel: t('settings.rewardsHistoryClear'), danger: true });
      if (!second) return;
      const res = await api.delete('/rewards/history');
      window.yuvomi?.showToast(
        t('settings.rewardsHistoryCleared', { ledger: res?.data?.ledger ?? 0, redemptions: res?.data?.redemptions ?? 0 }),
        'success');
    } catch (error) {
      window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
    } finally {
      clearBtn.disabled = false;
    }
  });

  bindDefaultPoints(container, preferences);
}

/**
 * Standard-Punkte für neue Aufgaben (#578). Speichert wie die Schalter der
 * Seite ohne eigenen Knopf: beim Verlassen des Feldes und mit Enter
 * (Re-Critique 2026-09-27, H12). Die Rückfrage, ob bestehende Aufgaben
 * mitgezogen werden, folgt dem gespeicherten Wert wie bisher - der Abschluss
 * der Eingabe ist jetzt das Verlassen des Feldes statt eines Klicks.
 *
 * Nicht bei jedem `change`: an Zahlenfeldern feuert er auch für jeden
 * Pfeilschritt, und jeder Zwischenwert wäre ein Schreibzugriff samt Rückfrage.
 * Escape nimmt eine noch nicht gespeicherte Eingabe zurück.
 */
export function bindDefaultPoints(container, preferences) {
  const form     = container.querySelector('#rewards-default-points-form');
  const input    = container.querySelector('#rewards-default-points');
  const errorEl  = container.querySelector('#rewards-default-points-error');
  if (!form || !input) return;

  let persisted = Number(preferences.tasks_default_points) || 0;
  let saving = false;

  const showError = (message) => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    input.setAttribute('aria-invalid', 'true');
  };
  const clearError = () => {
    errorEl.hidden = true;
    input.removeAttribute('aria-invalid');
  };

  async function commit() {
    if (saving) return;
    const raw = String(input.value ?? '').trim();
    const next = Math.trunc(Number(raw));
    if (raw === '' || !Number.isFinite(next) || next < 0 || next > MAX_TASK_POINTS) {
      showError(t('settings.rewardsDefaultPointsInvalid', { max: MAX_TASK_POINTS }));
      return;
    }
    clearError();
    if (next === persisted) {
      input.value = String(next);
      return;
    }

    // Feld sperren, solange der Request laeuft - sonst ueberschreibt der
    // Erfolgspfad eine Eingabe, die waehrenddessen getippt wurde. `readOnly`
    // statt `disabled`: ein deaktiviertes Feld verliert nach Enter den Fokus.
    saving = true;
    input.readOnly = true;
    input.setAttribute('aria-busy', 'true');
    const previous = persisted;
    try {
      await savePreferences({ tasks_default_points: next });
      persisted = next;
      input.value = String(next);
      preferences.tasks_default_points = next;
      window.yuvomi?.showToast(t('settings.rewardsDefaultPointsSaved'), 'success');
    } catch (error) {
      input.value = String(previous); // Rollback
      showError(error.message || t('common.errorGeneric'));
      return;
    } finally {
      saving = false;
      input.readOnly = false;
      input.removeAttribute('aria-busy');
    }

    // Wer das Blatt schon verlassen hat, bekommt die Rueckfrage nicht auf der
    // naechsten Seite: der neue Standard ist gespeichert, das Nachziehen optional.
    if (input.isConnected) await offerRebase(previous, next);
  }

  // Die Handler geben das Versprechen zurueck: dem Browser ist es gleich, ein
  // Test kann so auf den ganzen Speichervorgang warten.
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    return commit();
  });
  input.addEventListener('blur', () => commit());
  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || saving) return;
    input.value = String(persisted);
    clearError();
  });
}

/**
 * Nach einer Änderung anbieten, noch nicht erledigte Aufgaben nachzuziehen, die
 * auf dem alten Standard stehen. Erledigte bleiben außen vor, weil ihre Punkte
 * bereits im Ledger gutgeschrieben sind. Die Anzahl steht im Dialog, damit der
 * Wechsel vor der Bestätigung sichtbar ist.
 */
async function offerRebase(from, to) {
  if (from <= 0) return; // ohne vorherigen Standard gibt es nichts nachzuziehen

  let count = 0;
  try {
    const res = await api.get(`/tasks/points/affected?points=${from}`);
    count = Number(res?.data?.count) || 0;
  } catch {
    return; // Nachziehen ist optional — der neue Standard ist bereits gespeichert
  }
  if (count <= 0) return;

  const confirmed = await confirmModal(
    t('settings.rewardsDefaultPointsRebaseTitle', { count, from, to }),
    {
      confirmLabel: t('settings.rewardsDefaultPointsRebaseConfirm'),
      detail: t('settings.rewardsDefaultPointsRebaseDetail'),
    },
  );
  if (!confirmed) return;

  try {
    const res = await api.post('/tasks/points/rebase', { from, to });
    const updated = Number(res?.data?.updated) || 0;
    window.yuvomi?.showToast(t('settings.rewardsDefaultPointsRebased', { count: updated }), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error.message || t('common.errorGeneric'), 'danger');
  }
}

export async function render(container, { user }) {
  void user;
  const preferences = await getPreferences();
  renderPage(container, preferences);
  bindEvents(container, preferences);
}
