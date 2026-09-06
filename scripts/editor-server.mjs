#!/usr/bin/env node
/**
 * Локальный редактор каталога. ТОЛЬКО для владельца проекта, на его машине.
 *
 * Почему сервер, а не localStorage: правки должны переживать перезапуск и быть
 * видны сборщику каталога. Браузерное хранилище сборщик прочитать не может, а
 * data/overrides.json — может, и накладывает поверх собранных данных.
 *
 * В продакшн ничего из этого не попадает: страница редактора отдаётся этим
 * сервером, а не лежит в корне сайта, и без сервера она не работает —
 * сохранять ей некуда.
 *
 * Запуск:  npm run editor   → http://localhost:5175
 *
 * Формат data/overrides.json:
 *   { "<trackId>": { startOffset?: number, tier?: 1..5, genres?: string[],
 *                    age?: 'family'|'18plus', note?: string, hidden?: true } }
 * Записываются ТОЛЬКО реально изменённые поля. Не тронул — записи нет.
 */

import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRACKS = join(ROOT, 'data', 'tracks.json');
const OVERRIDES = join(ROOT, 'data', 'overrides.json');
const PAGE = join(ROOT, 'scripts', 'editor.html');
const PORT = Number(process.env.PORT || 5175);

/** Поля, которые редактор вправе переопределять. Всё прочее игнорируется. */
const FIELDS = new Set(['startOffset', 'tier', 'genres', 'age', 'note', 'hidden']);

async function loadOverrides() {
  try {
    const raw = JSON.parse(await readFile(OVERRIDES, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function saveOverrides(data) {
  // Стабильный порядок ключей — чтобы дифф в git читался.
  const sorted = {};
  for (const k of Object.keys(data).sort()) sorted[k] = data[k];
  return writeFile(OVERRIDES, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
}

/** Санитизация одного переопределения. Мусор в файл не попадает. */
function clean(patch, allGenres) {
  const out = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!FIELDS.has(k)) continue;
    if (k === 'startOffset') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n < 60) out.startOffset = Math.round(n * 1000) / 1000;
    } else if (k === 'tier') {
      const n = Math.round(Number(v));
      if (n >= 1 && n <= 5) out.tier = n;
    } else if (k === 'genres') {
      if (Array.isArray(v)) {
        const g = v.filter((x) => allGenres.includes(x));
        if (g.length) out.genres = g;
      }
    } else if (k === 'age') {
      if (v === 'family' || v === '18plus') out.age = v;
    } else if (k === 'note') {
      const s = String(v).slice(0, 400).trim();
      if (s) out.note = s;
    } else if (k === 'hidden') {
      if (v === true) out.hidden = true;
    }
  }
  return out;
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

async function readBody(req, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new Error('too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (req, res) => {
  // Сервер локальный и пишет в репозиторий, поэтому принимает запросы
  // только с этой же машины.
  const remote = req.socket.remoteAddress || '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
    res.writeHead(403).end('только localhost');
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await readFile(PAGE);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/data') {
      const payload = JSON.parse(await readFile(TRACKS, 'utf8'));
      json(res, 200, {
        ok: true,
        generatedAt: payload.generatedAt,
        genres: payload.allGenres || payload.genres || [],
        tracks: payload.tracks,
        overrides: await loadOverrides(),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/override') {
      const body = await readBody(req);
      const id = String(body.id || '');
      if (!id) return json(res, 400, { ok: false, error: 'нет id' });

      const payload = JSON.parse(await readFile(TRACKS, 'utf8'));
      const allGenres = payload.allGenres || payload.genres || [];
      const store = await loadOverrides();
      const patch = clean(body.patch, allGenres);

      if (Object.keys(patch).length === 0) delete store[id];
      else store[id] = patch;

      await saveOverrides(store);
      json(res, 200, { ok: true, id, saved: store[id] || null, count: Object.keys(store).length });
      return;
    }

    res.writeHead(404).end('нет такого');
  } catch (err) {
    json(res, 500, { ok: false, error: String(err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nРедактор каталога: http://localhost:${PORT}`);
  console.log(`Правки пишутся в data/overrides.json`);
  console.log(`Сборщик накладывает их поверх: npm run build:catalog\n`);
});
