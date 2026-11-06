/**
 * Modul: OCR-Service (Import From Photo)
 * Zweck: Nimmt ein hochgeladenes Bild entgegen, leitet es an den lokalen
 *        OCR-Service (localhost:8001/analyze/note) weiter und liefert den erkannten
 *        Text zurueck.
 * Abhaengigkeiten: server/utils/http.js (safeRequest),
 *                  server/utils/upload-limit.js (MAX_UPLOAD_BYTES)
 * Hinweis: Dies ist eine Node.js/Express-Implementierung (kein ASP.NET Core).
 *          Das HttpClientFactory-Pattern wird durch `safeRequest` abgedeckt,
 *          das einen wiederverwendbaren HTTP-Client mit SSRF-Schutz bereitstellt.
 */

import { safeRequest } from '../utils/http.js';
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_MB } from '../utils/upload-limit.js';
import { createLogger } from '../logger.js';

const log = createLogger('OCR');

const OCR_ENDPOINT = process.env.OCR_ENDPOINT || 'http://host.docker.internal:8001/analyze/note';

// Erlaubte MIME-Typen und Dateiendungen fuer den Import
const ALLOWED_MIME = new Set(['image/jpeg', 'image/jpg', 'image/png']);
const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

/**
 * Fehlerklasse fuer OCR-spezifische Fehler mit HTTP-Status-Code.
 */
export class OcrServiceError extends Error {
  constructor(message, statusCode = 500, code = 'OCR_ERROR') {
    super(message);
    this.name = 'OcrServiceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * OCR-Schnittstelle (Interface).
 * Jede Implementierung muss `extractText` bereitstellen.
 */
export class OcrService {
  /**
   * @param {Buffer} buffer       Bilddaten als Buffer
   * @param {string} mimeType     MIME-Typ (image/jpeg, image/png)
   * @param {string} originalName Originaldateiname
   * @returns {Promise<{ success: boolean, ocrText?: string, analysis?: { title?: string, body?: string }, error?: string }>}
   */
  async extractText(buffer, mimeType, originalName) {
    throw new Error('extractText not implemented');
  }
}

/**
 * Rezept-Import-Schnittstelle (Interface).
 * Jede Implementierung muss `importRecipe` bereitstellen.
 * Zukünftige Provider (z.B. OpenAI, Anthropic) koennen hier einfach hinzugefuegt werden.
 */
export class RecipeImportProvider {
  /**
   * @param {Buffer} buffer       Bilddaten als Buffer
   * @param {string} mimeType     MIME-Typ (image/jpeg, image/png)
   * @param {string} originalName Originaldateiname
   * @returns {Promise<{ success: boolean, ocrText?: string, analysis?: { title?: string, body?: string, servings?: string, prepTime?: string, cookTime?: string, diet?: string[], ingredients?: any[], notes?: string[] }, error?: string }>}
   */
  async importRecipe(buffer, mimeType, originalName) {
    throw new Error('importRecipe not implemented');
  }
}

/**
 * HTTP-Implementierung des OCR-Services.
 * Sendet das Bild als multipart/form-data mit Form-Feld `file` an
 * http://host.docker.internal:8001/analyze/note.
 */
export class HttpOcrService extends OcrService {
  constructor(endpoint = OCR_ENDPOINT) {
    super();
    this.endpoint = endpoint;
  }

  /**
   * Prueft den Upload und leitet ihn an den OCR-Service weiter.
   *
   * @param {Buffer} buffer       Bilddaten
   * @param {string} mimeType     Deklarierter MIME-Typ
   * @param {string} originalName Originaldateiname
   * @returns {Promise<{ success: boolean, ocrText?: string, analysis?: { title?: string, body?: string }, error?: string }>} OCR-Ergebnis
   */
  async extractText(buffer, mimeType, originalName) {
    // 1. Pruefung: Bilddaten vorhanden?
    if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
      throw new OcrServiceError('No image data provided.', 400, 'NO_IMAGE_DATA');
    }

    // 2. Pruefung: Erlaubter MIME-Typ?
    const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(normalizedMime)) {
      throw new OcrServiceError(
        `Unsupported file type: ${mimeType || 'unknown'}. Only JPG, JPEG and PNG are allowed.`,
        400,
        'UNSUPPORTED_FILE_TYPE'
      );
    }

    // 3. Pruefung: Erlaubte Dateiendung?
    const ext = originalName ? originalName.toLowerCase().substring(originalName.lastIndexOf('.')) : '';
    if (ext && !ALLOWED_EXTENSIONS.has(ext)) {
      throw new OcrServiceError(
        `Unsupported file extension: ${ext || 'none'}. Only .jpg, .jpeg and .png are allowed.`,
        400,
        'UNSUPPORTED_FILE_TYPE'
      );
    }

    // 4. Pruefung: Dateigroesse
    if (buffer.length > MAX_UPLOAD_BYTES) {
      throw new OcrServiceError(
        `Image may be at most ${MAX_UPLOAD_MB} MB.`,
        413,
        'IMAGE_TOO_LARGE'
      );
    }

    // 5. Aufbau des multipart/form-data Body mit Form-Feld `file`
    const boundary = `----YuvomiOCRBoundary${Date.now()}`;
    const multipartBody = buildMultipartBody(buffer, normalizedMime, originalName || 'photo.jpg', boundary);

    try {
      const response = await safeRequest(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(Buffer.byteLength(multipartBody)),
        },
        body: multipartBody,
      });

      if (!response.ok) {
        const errorText = await readBodyAsText(response.body);
        log.error(`OCR service returned ${response.status}: ${errorText}`);
        throw new OcrServiceError(
          `OCR service returned status ${response.status}.`,
          response.status >= 500 ? 502 : 400,
          'OCR_SERVICE_ERROR'
        );
      }

      const bodyText = await readBodyAsText(response.body);
      log.info('Raw OCR service response:', bodyText);

      let parsed;
      try {
        parsed = JSON.parse(bodyText);
      } catch {
        throw new OcrServiceError(
          'OCR service returned invalid JSON.',
          502,
          'OCR_INVALID_RESPONSE'
        );
      }

      if (!parsed || parsed.success !== true) {
        const errMsg = parsed?.error || 'OCR service returned success=false or invalid response.';
        throw new OcrServiceError(
          errMsg,
          502,
          'OCR_INVALID_RESPONSE'
        );
      }

      if (!parsed.analysis || typeof parsed.analysis !== 'object') {
        throw new OcrServiceError(
          'OCR service response missing "analysis" object.',
          502,
          'OCR_INVALID_RESPONSE'
        );
      }

      const analysis = parsed.analysis || {};
      const ocrText = parsed.ocrText || '';

      const result = {
        success: true,
        ocrText,
        analysis: {
          title: typeof analysis.title === 'string' ? analysis.title : '',
          description: typeof analysis.description === 'string' ? analysis.description : '',
          start_datetime: typeof analysis.start_datetime === 'string' ? analysis.start_datetime : '',
          end_datetime: typeof analysis.end_datetime === 'string' ? analysis.end_datetime : '',
          location: typeof analysis.location === 'string' ? analysis.location : '',
          assigned_to: Array.isArray(analysis.assigned_to) ? analysis.assigned_to : [],
          body: typeof analysis.body === 'string' ? analysis.body : '',
          servings: typeof analysis.servings === 'string' ? analysis.servings : '',
          prepTime: typeof analysis.prepTime === 'string' ? analysis.prepTime : '',
          cookTime: typeof analysis.cookTime === 'string' ? analysis.cookTime : '',
          diet: Array.isArray(analysis.diet) ? analysis.diet : [],
          ingredients: Array.isArray(analysis.ingredients) ? analysis.ingredients : [],
          notes: Array.isArray(analysis.notes) ? analysis.notes : [],
        },
      };

      log.info('Final OCR result to frontend:', JSON.stringify(result));
      return result;
    } catch (err) {
      if (err instanceof OcrServiceError) throw err;

      // Verbindungsfehler zum OCR-Service
      if (err.code === 'ECONNREFUSED' || err.message?.includes('connect') || err.message?.includes('ECONN')) {
        throw new OcrServiceError(
          'OCR service is not reachable. Please try again later.',
          502,
          'OCR_SERVICE_UNAVAILABLE'
        );
      }

      log.error('OCR service error:', err);
      throw new OcrServiceError(
        err.message || 'OCR service error.',
        502,
        'OCR_SERVICE_ERROR'
      );
    }
  }
}

/**
 * NVIDIA Vision API Provider fuer Rezept-Import.
 * Sendet das Bild direkt als base64 an https://integrate.api.nvidia.com/v1/chat/completions
 * ohne OCR-Vorverarbeitung.
 */
export class NvidiaRecipeImportProvider extends RecipeImportProvider {
  constructor(apiKey, model = 'meta/llama-3.2-90b-vision-instruct', textModel = 'meta/llama-3.1-70b-instruct', endpoint = 'https://integrate.api.nvidia.com/v1/chat/completions') {
    super();
    this.apiKey = apiKey;
    this.model = model;
    this.textModel = textModel;
    this.endpoint = endpoint;
  }

  /**
   * Zwei-Schritt-Rezept-Import:
   * 1. Vision-Modell transkribiert das Rezept aus dem Bild als reinen Text.
   * 2. Text-Modell parst den transkribierten Text in strukturiertes JSON.
   *
   * @param {Buffer} buffer       Bilddaten als Buffer
   * @param {string} mimeType     MIME-Typ (image/jpeg, image/png)
   * @param {string} originalName Originaldateiname
   * @returns {Promise<{ success: boolean, ocrText?: string, analysis?: { title?: string, body?: string, servings?: string, prepTime?: string, cookTime?: string, diet?: string[], ingredients?: any[], notes?: string[] }, error?: string }>}
   */
  async importRecipe(buffer, mimeType, originalName) {
    if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
      throw new OcrServiceError('No image data provided.', 400, 'NO_IMAGE_DATA');
    }

    const normalizedMime = String(mimeType || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_MIME.has(normalizedMime)) {
      throw new OcrServiceError(
        `Unsupported file type: ${mimeType || 'unknown'}. Only JPG, JPEG and PNG are allowed.`,
        400,
        'UNSUPPORTED_FILE_TYPE'
      );
    }

    const startTime = Date.now();
    const base64 = buffer.toString('base64');
    const imageUrl = `data:${normalizedMime};base64,${base64}`;

    const timeoutMs = Number(process.env.NVIDIA_RECIPE_TIMEOUT_MS) || 600000;

    // --------------------------------------------------------
    // Schritt 1: Vision-Modell transkribiert das Rezept aus dem Bild
    // --------------------------------------------------------
    const visionStart = Date.now();
    const visionController = new AbortController();
    const visionTimeoutId = setTimeout(() => visionController.abort(), timeoutMs);
    log.info(`NVIDIA vision step starting: model=${this.model} timeout=${timeoutMs}ms imageSize=${buffer.length}bytes`);

    const visionPrompt = `You are a recipe transcription assistant. Transcribe the recipe exactly as written.

Rules:
- Preserve line breaks.
- Preserve ingredient lines exactly.
- Preserve quantities exactly.
- Preserve units exactly.
- Do not combine ingredient lines.
- Do not combine ingredient lines with footnotes.
- Do not summarize.
- Do not interpret.
- Do not rewrite.
- Output plain text only.

Return ONLY the raw text of the recipe - no JSON, no markdown, no explanations, no formatting. Just the plain text content of the recipe as you see it in the image.

Include:
- Recipe title
- Description/introductory text
- Servings information
- Prep time, cook time
- Diet information
- Complete ingredient list with quantities, units, and preparation notes
- All cooking instructions and steps
- Any notes or serving suggestions

Do not add anything that is not visible in the image.`;

    const visionBody = JSON.stringify({
      model: this.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: visionPrompt },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
      max_tokens: 4096,
      temperature: 0.0,
    });

    let transcribedText;
    try {
      log.info(`NVIDIA vision request sent: model=${this.model} imageSize=${buffer.length}bytes`);
      const visionRequestStart = Date.now();
      const visionResponse = await safeRequest(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Length': String(Buffer.byteLength(visionBody)),
        },
        body: visionBody,
        signal: visionController.signal,
      });

      clearTimeout(visionTimeoutId);
      const visionRequestEnd = Date.now();
      log.info(`NVIDIA vision response received: status=${visionResponse.status} requestTimeMs=${visionRequestEnd - visionRequestStart}ms`);

      if (!visionResponse.ok) {
        const errorText = await readBodyAsText(visionResponse.body);
        log.error(`NVIDIA Vision API returned ${visionResponse.status}: ${errorText}`);
        throw new OcrServiceError(
          `NVIDIA Vision API returned status ${visionResponse.status}.`,
          visionResponse.status >= 500 ? 502 : 400,
          'NVIDIA_API_ERROR'
        );
      }

      const visionBodyText = await readBodyAsText(visionResponse.body);
      log.info('Raw NVIDIA Vision API response:', visionBodyText);

      let visionParsed;
      try {
        visionParsed = JSON.parse(visionBodyText);
      } catch {
        throw new OcrServiceError(
          'NVIDIA Vision API returned invalid JSON.',
          502,
          'NVIDIA_INVALID_RESPONSE'
        );
      }

      const visionContent = visionParsed?.choices?.[0]?.message?.content;
      if (!visionContent || typeof visionContent !== 'string') {
        throw new OcrServiceError(
          'NVIDIA Vision API response missing message content.',
          502,
          'NVIDIA_INVALID_RESPONSE'
        );
      }

      transcribedText = visionContent.trim();
      log.info(`NVIDIA vision transcription complete: ${transcribedText.length} characters`);
    } catch (err) {
      clearTimeout(visionTimeoutId);
      if (err instanceof OcrServiceError) throw err;
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        throw new OcrServiceError(
          `NVIDIA Vision API timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          504,
          'NVIDIA_TIMEOUT'
        );
      }
      throw new OcrServiceError(
        err.message || 'NVIDIA Vision API error.',
        502,
        'NVIDIA_API_ERROR'
      );
    }

    // --------------------------------------------------------
    // Schritt 2: Text-Modell parst den transkribierten Text in JSON
    // --------------------------------------------------------
    const parseStart = Date.now();
    const parseController = new AbortController();
    const parseTimeoutId = setTimeout(() => parseController.abort(), timeoutMs);
    log.info(`NVIDIA parse step starting: model=${this.textModel} timeout=${timeoutMs}ms transcribedLength=${transcribedText.length}chars`);

    const parsePrompt = `You are a recipe data extraction assistant. You will receive raw recipe text transcribed from an image. Extract the recipe into a JSON object that matches the schema below.

Schema:

{
  "title":"",
  "servings":"",
  "prepTime":"",
  "cookTime":"",
  "diet":[],
  "ingredients":[
    {
      "section":"",
      "name":"",
      "quantity":"",
      "unit":"",
      "note":""
    }
  ],
  "notes":[]
}

Example input text:
"Chili
Try this cool chili recipe, great for warm nights. Add beans if you want. 7 servings.
Cook time: 2 hours.
Gluten free!

1 pound lean ground beef
1 tablespoon chili powder
3 onions, chopped

Brown the beef.

Add chili powder and onions and simmer for 10 minutes.

Serve with cheddar cheese (optional)"

Example Output:
{
  "title": "Chili",
  "servings": "7",
  "prepTime": "",
  "cookTime": "2 hours",
  "diet": ["Gluten free"],
  "ingredients": [
    {
      "section": "",
      "name": "ground beef",
      "quantity": "1",
      "unit": "pound",
      "note": "lean"
    },
    {
      "section": "",
      "name": "chili powder",
      "quantity": "1",
      "unit": "tablespoon",
      "note": ""
    }
  ],
  "notes": [
    "Try this cool chili recipe, great for warm nights. Add beans if you want.",
    "Brown the beef.",
    "Add chili powder and onions and simmer for 10 minutes.",
    "Serve with cheddar cheese (optional)"
  ]
}

IMPORTANT RULES:
- Return ONLY raw JSON
- Do not infer information that is not explicitly present in the text.
- Extract EVERY ingredient visible in the text.
- Preserve ingredient quantities exactly.
- Preserve ingredient units exactly.
- Preserve recipe title exactly.
- Put cooking instruction steps into "notes", not "note".
- do not invent instructions.
- Do not summarize.
- Do not explain.
- Do not include any text outside of the JSON object.
- If a field is not present in the text, leave it as an empty string or empty array.
- For servings, prepTime, cookTime, and diet, if not present in the text, leave them as empty strings or empty arrays.
- For ingredients, if a section is not present, leave it as an empty string.

INGREDIENT SPLITTING RULE

Each ingredient line must be decomposed into four parts:

quantity
unit
name
note

Rules:

1. Quantity is always the amount.
2. Unit is always the measurement word immediately following the quantity.
3. Name is the food ingredient itself.
4. Preparation words belong in note.

Common preparation words include:
chopped
minced
diced
sliced
shredded
grated
softened
melted
drained
lean
optional

Examples:

"2 cloves chopped or minced garlic"

quantity = "2"
unit = "cloves"
name = "garlic"
note = "chopped or minced"

"1 pound lean ground beef"

quantity = "1"
unit = "pound"
name = "ground beef"
note = "lean"

"Shredded mild cheddar cheese"

quantity = ""
unit = ""
name = "cheddar cheese"
note = "shredded mild"

The name field should contain only the actual ingredient name.

Do not include:
- quantities
- units
- preparation terms

inside the name field.

DO NOT INFER INGREDIENTS.

Only create ingredients from lines explicitly listed
in the ingredient list.

Do NOT create ingredients from instructions.

Here is the recipe text to parse:

${transcribedText}
`;

    const parseBody = JSON.stringify({
      model: this.textModel,
      messages: [
        {
          role: 'user',
          content: parsePrompt,
        },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    });

    let analysis;
    try {
      log.info(`NVIDIA parse request sent: model=${this.textModel} transcribedLength=${transcribedText.length}chars`);
      const parseRequestStart = Date.now();
      const parseResponse = await safeRequest(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Length': String(Buffer.byteLength(parseBody)),
        },
        body: parseBody,
        signal: parseController.signal,
      });

      clearTimeout(parseTimeoutId);
      const parseRequestEnd = Date.now();
      log.info(`NVIDIA parse response received: status=${parseResponse.status} requestTimeMs=${parseRequestEnd - parseRequestStart}ms`);

      if (!parseResponse.ok) {
        const errorText = await readBodyAsText(parseResponse.body);
        log.error(`NVIDIA Parse API returned ${parseResponse.status}: ${errorText}`);
        throw new OcrServiceError(
          `NVIDIA Parse API returned status ${parseResponse.status}.`,
          parseResponse.status >= 500 ? 502 : 400,
          'NVIDIA_PARSE_ERROR'
        );
      }

      const parseBodyText = await readBodyAsText(parseResponse.body);
      log.info('Raw NVIDIA Parse API response:', parseBodyText);

      let parseParsed;
      try {
        parseParsed = JSON.parse(parseBodyText);
      } catch {
        throw new OcrServiceError(
          'NVIDIA Parse API returned invalid JSON.',
          502,
          'NVIDIA_PARSE_INVALID_RESPONSE'
        );
      }

      const parseContent = parseParsed?.choices?.[0]?.message?.content;
      if (!parseContent || typeof parseContent !== 'string') {
        throw new OcrServiceError(
          'NVIDIA Parse API response missing message content.',
          502,
          'NVIDIA_PARSE_INVALID_RESPONSE'
        );
      }

      // Defensive JSON parsing: find first { and last }
      const firstBrace = parseContent.indexOf('{');
      const lastBrace = parseContent.lastIndexOf('}');
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const jsonText = parseContent.substring(firstBrace, lastBrace + 1);
        try {
          analysis = JSON.parse(jsonText);
        } catch {
          analysis = null;
        }
      }

      // Markdown fallback: sometimes the text model returns formatted text instead of raw JSON.
      if (!analysis) {
        analysis = parseNvidiaMarkdown(parseContent);
        if (!analysis) {
          throw new OcrServiceError(
            'NVIDIA Parse API returned neither JSON nor parseable markdown.',
            502,
            'NVIDIA_PARSE_INVALID_RESPONSE'
          );
        }
      }
    } catch (err) {
      clearTimeout(parseTimeoutId);
      if (err instanceof OcrServiceError) throw err;
      if (err.name === 'AbortError' || err.message?.includes('abort')) {
        throw new OcrServiceError(
          `NVIDIA Parse API timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
          504,
          'NVIDIA_PARSE_TIMEOUT'
        );
      }
      throw new OcrServiceError(
        err.message || 'NVIDIA Parse API error.',
        502,
        'NVIDIA_PARSE_ERROR'
      );
    }

    const endTime = Date.now();
    const responseTimeMs = endTime - startTime;

    const result = {
      success: true,
      ocrText: transcribedText,
      analysis: {
        title: typeof analysis.title === 'string' ? analysis.title : '',
        description: typeof analysis.description === 'string' ? analysis.description : '',
        servings: typeof analysis.servings === 'string' ? analysis.servings : '',
        prepTime: typeof analysis.prepTime === 'string' ? analysis.prepTime : '',
        cookTime: typeof analysis.cookTime === 'string' ? analysis.cookTime : '',
        diet: Array.isArray(analysis.diet) ? analysis.diet : [],
        ingredients: Array.isArray(analysis.ingredients) ? analysis.ingredients : [],
        notes: Array.isArray(analysis.notes) ? analysis.notes : [],
      },
    };

    log.info(
      `Recipe Engine: Nvidia (two-step)\n` +
      `Vision Model: ${this.model}\n` +
      `Parse Model: ${this.textModel}\n` +
      `Time: ${responseTimeMs}ms\n` +
      `Ingredients: ${result.analysis.ingredients.length}\n` +
      `Title: ${result.analysis.title}`
    );
    return result;
  }
}

/**
 * Parses NVIDIA's markdown-formatted recipe response into the analysis shape.
 * Handles sections like **Recipe Title:**, **Servings:**, **Ingredients:**, **Notes:**.
 *
 * @param {string} content Markdown text from NVIDIA
 * @returns {object|null} Parsed analysis object, or null if unparseable
 */
function parseNvidiaMarkdown(content) {
  const analysis = {
    title: '',
    description: '',
    servings: '',
    prepTime: '',
    cookTime: '',
    diet: [],
    ingredients: [],
    notes: [],
  };

  const lines = content.split('\n');
  let currentSection = null;
  let currentIngredient = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Section headers
    if (line.startsWith('**Recipe Title:**')) {
      analysis.title = line.replace(/\*\*Recipe Title:\*\*\s*/i, '').trim();
      continue;
    }
    if (line.startsWith('**Servings:**')) {
      analysis.servings = line.replace(/\*\*Servings:\*\*\s*/i, '').trim();
      continue;
    }
    if (line.startsWith('**Prep Time:**')) {
      analysis.prepTime = line.replace(/\*\*Prep Time:\*\*\s*/i, '').trim();
      continue;
    }
    if (line.startsWith('**Cook Time:**')) {
      analysis.cookTime = line.replace(/\*\*Cook Time:\*\*\s*/i, '').trim();
      continue;
    }
    if (line.startsWith('**Diet:**')) {
      const dietVal = line.replace(/\*\*Diet:\*\*\s*/i, '').trim();
      if (dietVal && dietVal !== 'Not specified') analysis.diet = [dietVal];
      continue;
    }
    if (line.startsWith('**Ingredients:**')) {
      currentSection = 'ingredients';
      continue;
    }
    if (line.startsWith('**Notes:**')) {
      currentSection = 'notes';
      continue;
    }

    // Ingredient bullet lines: **Name:** X, **Quantity:** Y, etc.
    if (currentSection === 'ingredients' && line.startsWith('**')) {
      const nameMatch = line.match(/\*\*Name:\*\*\s*(.+)/i);
      if (nameMatch) {
        if (currentIngredient) analysis.ingredients.push(currentIngredient);
        currentIngredient = { section: '', name: nameMatch[1].trim(), quantity: '', unit: '', note: '' };
        continue;
      }
      const sectionMatch = line.match(/\*\*Section:\*\*\s*(.+)/i);
      if (sectionMatch && currentIngredient) {
        currentIngredient.section = sectionMatch[1].trim();
        continue;
      }
      const qtyMatch = line.match(/\*\*Quantity:\*\*\s*(.+)/i);
      if (qtyMatch && currentIngredient) {
        currentIngredient.quantity = qtyMatch[1].trim();
        continue;
      }
      const unitMatch = line.match(/\*\*Unit:\*\*\s*(.+)/i);
      if (unitMatch && currentIngredient) {
        currentIngredient.unit = unitMatch[1].trim();
        continue;
      }
      const noteMatch = line.match(/\*\*Note:\*\*\s*(.+)/i);
      if (noteMatch && currentIngredient) {
        currentIngredient.note = noteMatch[1].trim();
        continue;
      }
    }

    // Notes bullet lines
    if (currentSection === 'notes' && (line.startsWith('*') || line.startsWith('-'))) {
      const noteText = line.replace(/^[*\-]\s*/, '').replace(/\*\*/g, '').trim();
      if (noteText) analysis.notes.push(noteText);
    }
  }

  if (currentIngredient) analysis.ingredients.push(currentIngredient);

  // Require at least a title or one ingredient to consider it parsed
  if (!analysis.title && analysis.ingredients.length === 0) return null;

  return analysis;
}

/**
 * Baut einen multipart/form-data Body mit einem Datei-Feld `file`.
 *
 * @param {Buffer} buffer      Bilddaten
 * @param {string} mimeType    MIME-Typ
 * @param {string} fileName    Dateiname
 * @param {string} boundary    Multipart-Boundary
 * @returns {Buffer}
 */
function buildMultipartBody(buffer, mimeType, fileName, boundary) {
  const parts = [];
  const dashBoundary = `--${boundary}`;

  // Datei-Feld `file` (wie vom OCR-Service erwartet)
  parts.push(
    dashBoundary,
    `Content-Disposition: form-data; name="file"; filename="${fileName}"`,
    `Content-Type: ${mimeType}`,
    '',
    buffer,
  );

  // Abschluss-Boundary
  parts.push(`${dashBoundary}--`, '');

  // Alle Teile mit \r\n trennen
  return Buffer.concat(
    parts.map((part, index) => {
      const buf = Buffer.isBuffer(part) ? part : Buffer.from(part, 'utf8');
      return index === parts.length - 1 ? buf : Buffer.concat([buf, Buffer.from('\r\n', 'utf8')]);
    })
  );
}

/**
 * Liest einen node:http Response-Body als Text.
 *
 * @param {import('node:http').IncomingMessage} body
 * @returns {Promise<string>}
 */
async function readBodyAsText(body) {
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export { ALLOWED_MIME, ALLOWED_EXTENSIONS };
