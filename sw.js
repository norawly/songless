/*
 * Service worker: оболочка игры работает офлайн.
 *
 * Что кэшируется, а что нет:
 *   — разметка, стили, скрипты, переводы и каталог — да. Это и есть
 *     приложение, и без сети оно должно открываться;
 *   — превью треков и обложки с CDN Apple — НЕТ, никогда. Это чужие файлы,
 *     их нельзя складывать к себе, да и весят они как весь остальной сайт
 *     на каждые полсотни песен. Без сети игра честно скажет, что не смогла
 *     загрузить песню;
 *   — запросы к лидерборду — нет: закэшированная таблица рекордов хуже, чем
 *     её отсутствие.
 *
 * Стратегия разная по смыслу файла:
 *   HTML  — сначала сеть: иначе после деплоя человек неделю сидит на старой
 *           версии, потому что его html лежит в кэше;
 *   всё остальное — сначала кэш, обновление в фоне.
 *
 * Версия в имени кэша — единственный рычаг инвалидации: поменяли что-то в
 * списке — подняли номер, старый кэш удалится сам.
 */

const VERSION = 'olensiz-v2';
const SHELL = [
  '/',
  '/index.html',
  '/about.html',
  '/catalog.html',
  '/404.html',
  '/styles/tokens.css',
  '/styles/app.css',
  '/src/main.js',
  '/src/config.js',
  '/src/i18n.js',
  '/src/catalog.js',
  '/src/audio.js',
  '/src/ambient.js',
  '/src/pulse.js',
  '/src/palette.js',
  '/src/mood.js',
  '/src/game.js',
  '/src/scoring.js',
  '/src/normalize.js',
  '/src/share.js',
  '/src/ui.js',
  '/src/fit.js',
  '/src/leaderboard.js',
  '/i18n/kk.json',
  '/i18n/ru.json',
  '/data/tracks.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  // Отдельными запросами, а не addAll: один недоступный файл не должен
  // проваливать установку целиком.
  e.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;      // Apple CDN и прочее чужое
  if (url.pathname.startsWith('/scripts/')) return;      // редактор в офлайне не нужен

  const isHtml = req.mode === 'navigate'
    || (req.headers.get('accept') || '').includes('text/html');

  if (isHtml) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put(req, fresh.clone());
        return fresh;
      } catch {
        return (await caches.match(req)) || (await caches.match('/index.html'));
      }
    })());
    return;
  }

  e.respondWith((async () => {
    const hit = await caches.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
      return res;
    }).catch(() => null);
    return hit || (await network) || new Response('offline', { status: 503 });
  })());
});
