/**
 * Modul: OCR-Route (Import From Photo)
 * Zweck: REST-API-Endpunkt fuer den Foto-Import mit OCR.
 *        Nimmt ein Bild (base64 data URL) entgegen, leitet es an den
 *        OCR-Service weiter und liefert den erkannten Text zurueck.
 * Abhaengigkeiten: express, server/services/ocr-service.js,
 *                  server/middleware/validate.js
 */

import express from 'express';
import { createLogger } from '../logger.js';
import * as db from '../db.js';
import { HttpOcrService, NvidiaRecipeImportProvider } from '../services/ocr-service.js';

const log = createLogger('OCR');
const router = express.Router();

// Singleton-Service-Instanz fuer Notizen-OCR (wie bei anderen Routen im Projekt)
const ocrService = new HttpOcrService();

// Service-Instanz fuer Event-OCR (anderer Endpunkt)
const ocrEventService = new HttpOcrService(process.env.OCR_EVENT_ENDPOINT || 'http://host.docker.internal:8001/analyze/event');

// Service-Instanz fuer Recipe-OCR (Local Pipeline, localhost:8001/analyze/recipe)
const ocrRecipeService = new HttpOcrService(process.env.OCR_RECIPE_ENDPOINT || 'http://host.docker.internal:8001/analyze/recipe');

/**
 * Liest eine Einstellung aus der sync_config-Tabelle.
 */
function cfgGet(key) {
  const row = db.get().prepare('SELECT value FROM sync_config WHERE key = ?').get(key);
  return row ? row.value : null;
}

/**
 * Zentrale Fehlerbehandlung fuer OCR-Routen.
 */
function ocrErrorResponse(res, error) {
  if (error instanceof Error && error.statusCode !== undefined) {
    return res.status(error.statusCode).json({
      error: error.message,
      code: error.code || 'OCR_ERROR',
    });
  }
  log.error('OCR route:', error);
  return res.status(500).json({ error: 'Internal server error.', code: 500 });
}

/**
 * POST /api/v1/ocr/import
 *
 * Body (JSON):
 *   {
 *     "file": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
 *     "fileName": "photo.jpg"
 *   }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "ocrText": "...",
 *     "analysis": {
 *       "title": "Camping List",
 *       "body": "- [ ] Sleeping Bag\\n- [ ] Pillow"
 *     }
 *   }
 *
 * Response (400):
 *   { "error": "...", "code": 400 }
 *
 * Response (413):
 *   { "error": "Image may be at most 5 MB.", "code": 413 }
 *
 * Response (502):
 *   { "error": "OCR service is not reachable...", "code": 502 }
 */
router.post('/import', async (req, res) => {
  try {
    const { file, fileName } = req.body;

    // Validierung: file muss vorhanden sein
    if (!file || typeof file !== 'string') {
      return res.status(400).json({
        error: 'No image file provided.',
        code: 400,
      });
    }

    // Data-URL parsen: data:<mime>;base64,<data>
    const match = file.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid image format. Expected a base64 data URL (data:image/jpeg;base64,...).',
        code: 400,
      });
    }

    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s/g, '');
    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length) {
      return res.status(400).json({
        error: 'Image is empty.',
        code: 400,
      });
    }

    const originalName = fileName || 'photo.jpg';

    // An den OCR-Service delegieren (Pruefung von Typ, Groesse, Weiterleitung)
    const result = await ocrService.extractText(buffer, mimeType, originalName);

    log.info('Final OCR response to frontend:', JSON.stringify(result));
    res.json(result);
  } catch (err) {
    ocrErrorResponse(res, err);
  }
});

/**
 * POST /api/v1/ocr/import-event
 *
 * Body (JSON):
 *   {
 *     "file": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
 *     "fileName": "photo.jpg"
 *   }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "ocrText": "...",
 *     "analysis": {
 *       "title": "Soccer Tournament",
 *       "description": "",
 *       "start_datetime": "2026-11-14T09:00",
 *       "end_datetime": "2026-11-14T10:00",
 *       "location": "",
 *       "assigned_to": [6]
 *     }
 *   }
 *
 * Response (400):
 *   { "error": "...", "code": 400 }
 *
 * Response (502):
 *   { "error": "OCR service is not reachable...", "code": 502 }
 */
router.post('/import-event', async (req, res) => {
  log.info('OCR import-event request received');
  try {
    const { file, fileName } = req.body;

    // Validierung: file muss vorhanden sein
    if (!file || typeof file !== 'string') {
      return res.status(400).json({
        error: 'No image file provided.',
        code: 400,
      });
    }

    // Data-URL parsen: data:<mime>;base64,<data>
    const match = file.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid image format. Expected a base64 data URL (data:image/jpeg;base64,...).',
        code: 400,
      });
    }

    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s/g, '');
    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length) {
      return res.status(400).json({
        error: 'Image is empty.',
        code: 400,
      });
    }

    const originalName = fileName || 'photo.jpg';

    // An den Event-OCR-Service delegieren
    const result = await ocrEventService.extractText(buffer, mimeType, originalName);

    log.info('OCR import-event response received:', JSON.stringify(result));
    res.json(result);
  } catch (err) {
    ocrErrorResponse(res, err);
  }
});

/**
 * POST /api/v1/ocr/import-recipe
 *
 * Body (JSON):
 *   {
 *     "file": "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ...",
 *     "fileName": "photo.jpg"
 *   }
 *
 * Response (200):
 *   {
 *     "success": true,
 *     "ocrText": "...",
 *     "analysis": {
 *       "title": "Chocolate Chip Cookies",
 *       "servings": "24 cookies",
 *       "prepTime": "15 min",
 *       "cookTime": "12 min",
 *       "diet": ["Vegetarian"],
 *       "ingredients": [
 *         { "section": "", "name": "Flour", "quantity": "2", "unit": "cups", "note": "" }
 *       ],
 *       "notes": ["Mix ingredients.", "Bake at 350°F for 12 minutes."]
 *     }
 *   }
 *
 * Response (400):
 *   { "error": "...", "code": 400 }
 *
 * Response (502):
 *   { "error": "OCR service is not reachable...", "code": 502 }
 */
router.post('/import-recipe', async (req, res) => {
  log.info('OCR import-recipe request received');
  try {
    const { file, fileName } = req.body;

    // Validierung: file muss vorhanden sein
    if (!file || typeof file !== 'string') {
      return res.status(400).json({
        error: 'No image file provided.',
        code: 400,
      });
    }

    // Data-URL parsen: data:<mime>;base64,<data>
    const match = file.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) {
      return res.status(400).json({
        error: 'Invalid image format. Expected a base64 data URL (data:image/jpeg;base64,...).',
        code: 400,
      });
    }

    const mimeType = match[1].toLowerCase();
    const base64 = match[2].replace(/\s/g, '');
    const buffer = Buffer.from(base64, 'base64');

    if (!buffer.length) {
      return res.status(400).json({
        error: 'Image is empty.',
        code: 400,
      });
    }

    const originalName = fileName || 'photo.jpg';

    // Engine-Auswahl aus sync_config (Default: Local)
    const engine = cfgGet('recipe_import_engine') || 'Local';
    log.info(`Recipe import engine: ${engine}`);

    let result;
    const startTime = Date.now();

    if (engine === 'Nvidia') {
      const apiKey = cfgGet('recipe_import_nvidia_api_key') || '';
      const model = cfgGet('recipe_import_nvidia_model') || 'meta/llama-3.2-90b-vision-instruct';
      const textModel = cfgGet('recipe_import_text_model') || 'meta/llama-3.1-70b-instruct';

      if (!apiKey) {
        return res.status(400).json({
          error: 'NVIDIA API key is not configured. Please set it in Settings > Integrations > Recipe Import.',
          code: 400,
        });
      }

      const nvidiaProvider = new NvidiaRecipeImportProvider(apiKey, model, textModel);
      result = await nvidiaProvider.importRecipe(buffer, mimeType, originalName);
    } else {
      // Local Pipeline: OCR + LLM via localhost:8001/analyze/recipe
      result = await ocrRecipeService.extractText(buffer, mimeType, originalName);
    }

    const endTime = Date.now();
    const responseTimeMs = endTime - startTime;

    // Diagnostics-Log
    if (result && result.analysis) {
      log.info(
        `Recipe Engine: ${engine}\n` +
        `Model: ${engine === 'Nvidia' ? (cfgGet('recipe_import_nvidia_model') || 'meta/llama-3.2-90b-vision-instruct') : 'localhost:8001/analyze/recipe'}\n` +
        `Time: ${responseTimeMs}ms\n` +
        `Ingredients: ${result.analysis.ingredients?.length ?? 0}\n` +
        `Title: ${result.analysis.title ?? ''}`
      );
    }

    log.info('OCR import-recipe response received:', JSON.stringify(result));
    res.json(result);
  } catch (err) {
    ocrErrorResponse(res, err);
  }
});

export default router;
