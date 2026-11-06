/**
 * Modul: Settings – Recipe Import
 * Zweck: Konfiguration des Rezept-Import-Engines (Local / NVIDIA Vision).
 * Abhaengigkeiten: /api.js, /i18n.js, /utils/html.js
 */

import { api } from '/api.js';
import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { createInlineError, createRetryState } from '/settings/components.js';

function toast(message, tone = 'default') {
  window.yuvomi?.showToast(message, tone);
}

const DEFAULTS = {
  engine: 'Local',
  nvidiaApiKey: '',
  nvidiaModel: 'meta/llama-3.2-90b-vision-instruct',
  nvidiaTextModel: 'meta/llama-3.1-70b-instruct',
};

function renderForm(container, cfg) {
  const engine = cfg.recipe_import_engine || DEFAULTS.engine;
  const nvidiaApiKey = cfg.recipe_import_nvidia_api_key || '';
  const nvidiaModel = cfg.recipe_import_nvidia_model || DEFAULTS.nvidiaModel;
  const nvidiaTextModel = cfg.recipe_import_text_model || DEFAULTS.nvidiaTextModel;
  const isNvidia = engine === 'Nvidia';

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <div class="settings-card">
        <p class="settings-card-description">${esc(t('settings.pageRecipeImportDescription'))}</p>
        <form class="settings-form" id="recipe-import-form" novalidate autocomplete="off">
          <div class="form-group">
            <label class="form-label" for="recipe-import-engine">${esc(t('settings.recipeImportEngineLabel'))}</label>
            <select class="form-input" id="recipe-import-engine" name="engine">
              <option value="Local" ${engine === 'Local' ? 'selected' : ''}>${esc(t('settings.recipeImportEngineLocal'))}</option>
              <option value="Nvidia" ${engine === 'Nvidia' ? 'selected' : ''}>${esc(t('settings.recipeImportEngineNvidia'))}</option>
            </select>
            <p class="form-hint">${esc(t('settings.recipeImportEngineHint'))}</p>
          </div>

          <div class="form-group" id="recipe-import-nvidia-fields" ${!isNvidia ? 'hidden' : ''}>
            <label class="form-label" for="recipe-import-nvidia-api-key">${esc(t('settings.recipeImportNvidiaApiKeyLabel'))}</label>
            <input class="form-input" id="recipe-import-nvidia-api-key" name="nvidiaApiKey" type="password"
              autocomplete="new-password" placeholder="${nvidiaApiKey ? '••••••••' : ''}" />
            <p class="form-hint">${esc(t('settings.recipeImportNvidiaApiKeyHint'))}</p>
          </div>
          <div class="form-group" id="recipe-import-nvidia-model-fields" ${!isNvidia ? 'hidden' : ''}>
            <label class="form-label" for="recipe-import-nvidia-model">${esc(t('settings.recipeImportNvidiaModelLabel'))}</label>
            <input class="form-input" id="recipe-import-nvidia-model" name="nvidiaModel" type="text"
              value="${esc(nvidiaModel)}" />
            <p class="form-hint">${esc(t('settings.recipeImportNvidiaModelHint'))}</p>
          </div>
          <div class="form-group" id="recipe-import-nvidia-text-model-fields" ${!isNvidia ? 'hidden' : ''}>
            <label class="form-label" for="recipe-import-nvidia-text-model">${esc(t('settings.recipeImportNvidiaTextModelLabel'))}</label>
            <input class="form-input" id="recipe-import-nvidia-text-model" name="nvidiaTextModel" type="text"
              value="${esc(nvidiaTextModel)}" />
            <p class="form-hint">${esc(t('settings.recipeImportNvidiaTextModelHint'))}</p>
          </div>

          <div id="recipe-import-error"></div>
          <div class="settings-form-actions">
            <button class="btn btn--primary" type="submit">${esc(t('common.save'))}</button>
          </div>
        </form>
      </div>
    </section>
  `);

  const form = container.querySelector('#recipe-import-form');
  const errorHost = container.querySelector('#recipe-import-error');
  const engineSelect = form.elements.engine;
  const nvidiaFields = container.querySelector('#recipe-import-nvidia-fields');
  const nvidiaModelFields = container.querySelector('#recipe-import-nvidia-model-fields');
  const nvidiaTextModelFields = container.querySelector('#recipe-import-nvidia-text-model-fields');

  // NVIDIA-Felder ein-/ausblenden abhaengig vom gewaehlten Engine
  const toggleNvidiaFields = () => {
    const isNvidia = engineSelect.value === 'Nvidia';
    nvidiaFields.hidden = !isNvidia;
    nvidiaModelFields.hidden = !isNvidia;
    nvidiaTextModelFields.hidden = !isNvidia;
  };

  engineSelect.addEventListener('change', toggleNvidiaFields);
  toggleNvidiaFields();

  const collect = () => {
    const result = { recipe_import_engine: engineSelect.value };
    if (engineSelect.value === 'Nvidia') {
      const apiKey = form.elements.nvidiaApiKey.value.trim();
      if (apiKey) result.recipe_import_nvidia_api_key = apiKey;
      const model = form.elements.nvidiaModel.value.trim();
      if (model) result.recipe_import_nvidia_model = model;
      const textModel = form.elements.nvidiaTextModel.value.trim();
      if (textModel) result.recipe_import_text_model = textModel;
    }
    return result;
  };

  const save = async () => {
    errorHost.replaceChildren();
    await api.put('/preferences', collect());
    // API key Feld NICHT leeren - der Nutzer soll sehen, dass etwas gespeichert ist.
    // Beim nächsten Laden wird der Wert aus der DB zurückgelesen.
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    try {
      await save();
      toast(t('settings.recipeImportSaved'), 'success');
    } catch (error) {
      errorHost.replaceChildren(createInlineError(error.message || t('common.errorGeneric')));
    } finally {
      button.disabled = false;
    }
  });
}

export async function render(container) {
  try {
    const response = await api.get('/preferences');
    renderForm(container, response.data || {});
  } catch (error) {
    container.replaceChildren(createRetryState({
      message: error.message || t('common.errorGeneric'),
      onRetry: () => render(container),
    }));
  }
}
