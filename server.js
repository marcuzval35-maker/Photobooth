import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('[ERROR] GEMINI_API_KEY is missing. Add it to your .env file.');
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY || '' });

const app = express();
app.set('trust proxy', 1);

// Security headers with CSP configured for QRCode.js CDN, Google Fonts, and data URLs
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        mediaSrc: ["'self'", 'blob:'],
      },
    },
  })
);

app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Rate limit generation endpoint to protect API quota
const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many photo generations. Please wait a few minutes and try again.' },
});

// Strict server-side style preset mapping
const STYLE_PRESETS = {
  'vintage-90s': {
    name: '90s Vintage Film',
    prompt:
      'Transform this photo into an authentic 1990s 35mm disposable camera flash photograph. Add fine analog film grain, warm slightly faded retro color cast, soft halation around highlights, subtle direct on-camera flash lighting, and natural candid film texture. Keep every person’s exact facial identity, features, expression, clothing silhouette, and pose completely recognizable.',
  },
  'cyberpunk-neon': {
    name: 'Cyberpunk Neon',
    prompt:
      'Transform this photo into a cinematic cyberpunk night scene. Place the subject(s) against a rain-slicked futuristic neon-lit city backdrop with glowing hot magenta and electric cyan rim lighting across faces, hair, and clothing, subtle atmospheric haze, and glossy reflections. Strictly preserve every person’s exact facial identity, expression, and pose.',
  },
  'vinyl-toy': {
    name: '3D Vinyl Toy',
    prompt:
      'Transform the subject(s) in this photo into adorable stylized 3D collectible designer vinyl toy figurines. Give skin and outfits smooth matte-and-satin vinyl plastic textures, subtly exaggerated cute proportions, clean softbox studio lighting, and a sleek pastel-dark studio backdrop. Keep each person’s recognizable likeness, hairstyle, glasses/accessories, and pose.',
  },
  claymation: {
    name: 'Claymation',
    prompt:
      'Transform this photo into a handcrafted stop-motion claymation scene. Sculpt the subject(s) and background out of tactile modeling clay with visible subtle thumbprints, matte plasticine sheen, miniature practical set lighting, and charming stop-motion depth of field. Strictly preserve each person’s recognizable facial features, expression, and pose.',
  },
  'bw-booth': {
    name: 'Classic B&W Booth',
    prompt:
      'Transform this photo into an authentic vintage chemical photobooth silver-gelatin monochrome print. Use rich deep blacks, luminous crisp highlights, high-contrast studio booth lighting, subtle photographic paper grain, and classic darkroom tonal depth. Preserve every person’s exact facial identity, expression, and pose.',
  },
};

// Bounded in-memory TTL store for QR code sharing
const SHARE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_SHARE_ITEMS = 100;
const shareStore = new Map();

function saveSharedImage(buffer, mimeType, styleName) {
  const now = Date.now();

  // Evict expired items
  for (const [id, entry] of shareStore.entries()) {
    if (now - entry.createdAt > SHARE_TTL_MS) {
      shareStore.delete(id);
    }
  }

  // Evict oldest items if at capacity
  while (shareStore.size >= MAX_SHARE_ITEMS) {
    const oldestKey = shareStore.keys().next().value;
    shareStore.delete(oldestKey);
  }

  const id = crypto.randomBytes(8).toString('hex');
  shareStore.set(id, { buffer, mimeType, styleName, createdAt: now });
  return id;
}

const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of shareStore.entries()) {
    if (now - entry.createdAt > SHARE_TTL_MS) {
      shareStore.delete(id);
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    apiKeyConfigured: Boolean(GEMINI_API_KEY),
  });
});

app.post('/api/generate', generateLimiter, async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: 'Server is missing GEMINI_API_KEY in environment configuration.',
      });
    }

    const { image, styleId, mode } = req.body || {};

    if (typeof styleId !== 'string' || !Object.hasOwn(STYLE_PRESETS, styleId)) {
      return res.status(400).json({ error: 'Invalid or unsupported style preset.' });
    }

    if (mode !== 'single' && mode !== 'strip') {
      return res.status(400).json({ error: 'Invalid capture mode.' });
    }

    if (typeof image !== 'string') {
      return res.status(400).json({ error: 'Missing base64 image payload.' });
    }

    const match = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Image must be a valid base64 data URL (JPEG, PNG, or WebP).' });
    }

    const inputMimeType = match[1];
    const base64Data = match[2];

    // Guard against oversized payloads (~10MB raw binary)
    if (base64Data.length > 14_000_000) {
      return res.status(413).json({ error: 'Image payload is too large.' });
    }

    const preset = STYLE_PRESETS[styleId];
    const layoutGuardrail =
      mode === 'strip'
        ? ' IMPORTANT LAYOUT RULE: This input is a vertical 3-shot photobooth strip with a clean white border and bottom footer text. Preserve the exact 3-panel vertical strip composition, crisp white outer and inner borders, and bottom footer text cleanly while applying the requested art style consistently across all three photo frames.'
        : ' IMPORTANT COMPOSITION RULE: Maintain the exact framing, subject count, facial identity, and pose of the original photo.';

    const fullPrompt = `${preset.prompt}${layoutGuardrail}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: [
        {
          role: 'user',
          parts: [
            {
              inlineData: {
                mimeType: inputMimeType,
                data: base64Data,
              },
            },
            { text: fullPrompt },
          ],
        },
      ],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
      },
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData?.data);

    if (!imagePart) {
      const textFeedback = parts
        .filter((part) => part.text)
        .map((part) => part.text)
        .join(' ')
        .trim();

      return res.status(422).json({
        error: textFeedback || 'Gemini did not return an edited image. Try retaking the photo with clearer lighting.',
      });
    }

    const outputMimeType = imagePart.inlineData.mimeType || 'image/png';
    const outputBase64 = imagePart.inlineData.data;
    const outputBuffer = Buffer.from(outputBase64, 'base64');

    const shareId = saveSharedImage(outputBuffer, outputMimeType, preset.name);
    const origin = PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    const shareUrl = `${origin}/share/${shareId}`;

    return res.json({
      image: `data:${outputMimeType};base64,${outputBase64}`,
      mimeType: outputMimeType,
      styleId,
      styleName: preset.name,
      shareId,
      shareUrl,
    });
  } catch (err) {
    console.error('[Gemini API Error]', err);
    const status = err?.status === 429 ? 429 : 500;
    const message =
      status === 429
        ? 'Gemini API rate limit reached. Please wait a moment and try again.'
        : 'Failed to generate AI photo. Check server logs and API key configuration.';
    return res.status(status).json({ error: message });
  }
});

// Mobile-friendly share page reached by scanning the QR code
app.get('/share/:id', (req, res) => {
  const entry = shareStore.get(req.params.id);
  if (!entry || Date.now() - entry.createdAt > SHARE_TTL_MS) {
    shareStore.delete(req.params.id);
    return res
      .status(404)
      .send('<h1>Photo Expired</h1><p>This photobooth session has expired or does not exist.</p>');
  }

  const safeId = encodeURIComponent(req.params.id);
  const safeStyle = escapeHtml(entry.styleName);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AI Photobooth — ${safeStyle}</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 1rem;
      padding: 1.5rem;
      background: #090910;
      color: #f4f4ff;
      font-family: system-ui, -apple-system, sans-serif;
      text-align: center;
    }
    img {
      max-width: min(100%, 460px);
      max-height: 72vh;
      border-radius: 14px;
      box-shadow: 0 0 32px rgba(0, 240, 255, 0.22);
    }
    a.btn {
      display: inline-block;
      padding: 0.85rem 1.5rem;
      border-radius: 999px;
      background: linear-gradient(135deg, #ff2e93, #7c3aed);
      color: #fff;
      font-weight: 700;
      text-decoration: none;
    }
    p { margin: 0; color: #a8a8c7; font-size: 0.9rem; }
  </style>
</head>
<body>
  <img src="/share/${safeId}/image" alt="AI Photobooth Result (${safeStyle})" />
  <a class="btn" href="/share/${safeId}/download">Download Photo</a>
  <p>Style: ${safeStyle} &bull; Link expires 30 minutes after capture</p>
</body>
</html>`);
});

app.get('/share/:id/image', (req, res) => {
  const entry = shareStore.get(req.params.id);
  if (!entry || Date.now() - entry.createdAt > SHARE_TTL_MS) {
    shareStore.delete(req.params.id);
    return res.status(404).end();
  }
  res.setHeader('Content-Type', entry.mimeType);
  res.setHeader('Cache-Control', 'private, max-age=1800');
  return res.send(entry.buffer);
});

app.get('/share/:id/download', (req, res) => {
  const entry = shareStore.get(req.params.id);
  if (!entry || Date.now() - entry.createdAt > SHARE_TTL_MS) {
    shareStore.delete(req.params.id);
    return res.status(404).send('Photo expired.');
  }
  const ext = entry.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  res.setHeader('Content-Type', entry.mimeType);
  res.setHeader('Content-Disposition', `attachment; filename="ai-photobooth-${req.params.id}.${ext}"`);
  return res.send(entry.buffer);
});

app.listen(PORT, () => {
  console.log(`AI Photobooth running at http://localhost:${PORT}`);
  if (PUBLIC_BASE_URL) {
    console.log(`QR Share Base URL: ${PUBLIC_BASE_URL}`);
  }
});
