#!/usr/bin/env node
/**
 * Генерирует страницы, которые видит поисковик, и карту сайта.
 *
 * Зачем это вообще нужно. Игра — одностраничное приложение: в разметке нет
 * ни названий песен, ни имён исполнителей, весь каталог приезжает JSON-ом
 * и живёт в памяти. Для человека это правильно, для поисковика — пустая
 * страница. Отсюда и весь смысл файла: превратить каталог в настоящий текст
 * на настоящей странице, по которой людей можно найти запросом вроде
 * «угадай песню Кайрата Нуртаса» или «қазақша ән ойыны».
 *
 * Это НЕ дорвеи: страница одна, она полезна человеку («кто вообще есть в
 * игре») и никого никуда не перенаправляет.
 *
 * Что делает:
 *   catalog.html  — список исполнителей каталога с числом песен и жанрами,
 *                   сводка по категориям, разметка CollectionPage/ItemList;
 *   sitemap.xml   — все страницы с сегодняшней датой и hreflang-альтернативами.
 *
 * Запуск: npm run seo   (после пересборки каталога)
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = 'https://olensiz.zhengisbay.com';

const GENRE_RU = {
  toi: 'Той', retro: 'Ретро и эстрада', pop: 'Поп', rnb: 'R&B', rap: 'Рэп',
  underground: 'Андеграунд', indie: 'Инди', folk: 'Фольклор',
  patriotic: 'Патриотические', qpop: 'Q-pop', rock: 'Рок', memes: 'Мемы',
};
const GENRE_KK = {
  toi: 'Той', retro: 'Ретро', pop: 'Поп', rnb: 'R&B', rap: 'Рэп',
  underground: 'Андеграунд', indie: 'Инди', folk: 'Фольклор',
  patriotic: 'Патриоттық', qpop: 'Q-pop', rock: 'Рок', memes: 'Мемдер',
};

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const today = () => new Date().toISOString().slice(0, 10);

/** Исполнители каталога: по artistId, с числом песен и жанрами. */
function collectArtists(tracks) {
  const map = new Map();
  for (const t of tracks) {
    const key = t.artistId || t.artistKey || t.artist;
    const cur = map.get(key) || { name: t.artist, count: 0, genres: new Set(), names: new Map() };
    cur.count++;
    for (const g of t.genres || []) cur.genres.add(g);
    // Имя берём то, что встречается чаще: у фитов в поле artist стоит связка.
    cur.names.set(t.artist, (cur.names.get(t.artist) || 0) + 1);
    map.set(key, cur);
  }
  const list = [];
  for (const a of map.values()) {
    const name = [...a.names.entries()].sort((x, y) => y[1] - x[1])[0][0];
    // «А & Б» — это фит, а не исполнитель каталога: берём первую часть.
    const clean = name.split(/\s+(?:&|feat\.|ft\.)\s+/i)[0].trim();
    list.push({ name: clean, count: a.count, genres: [...a.genres] });
  }
  // Схлопываем одинаковые имена, оставшиеся после чистки фитов.
  const byName = new Map();
  for (const a of list) {
    const prev = byName.get(a.name);
    if (prev) {
      prev.count += a.count;
      prev.genres = [...new Set([...prev.genres, ...a.genres])];
    } else byName.set(a.name, { ...a });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, 'kk'));
}

const catalog = JSON.parse(await readFile(join(ROOT, 'data', 'tracks.json'), 'utf8'));
const artists = collectArtists(catalog.tracks);
const shown = catalog.genres || [];
const counts = catalog.byGenre || {};

const genreRows = (catalog.allGenres || [])
  .filter((g) => counts[g])
  .sort((a, b) => (counts[b] || 0) - (counts[a] || 0))
  .map((g) => `      <tr><td>${esc(GENRE_RU[g] || g)}</td><td>${esc(GENRE_KK[g] || g)}</td>` +
    `<td class="num">${counts[g]}</td>` +
    `<td>${shown.includes(g) ? 'да' : 'нет — мало песен'}</td></tr>`)
  .join('\n');

const artistItems = artists
  .map((a) => `      <li><b>${esc(a.name)}</b> <span class="meta">${a.count} ${
    a.count === 1 ? 'песня' : a.count < 5 ? 'песни' : 'песен'
  } · ${a.genres.map((g) => esc(GENRE_RU[g] || g)).join(', ')}</span></li>`)
  .join('\n');

const jsonLd = {
  '@context': 'https://schema.org',
  '@type': 'CollectionPage',
  name: 'Каталог игры Óleńsiz — казахстанские исполнители',
  url: `${SITE}/catalog.html`,
  inLanguage: ['ru', 'kk'],
  isPartOf: { '@type': 'WebSite', name: 'Óleńsiz', url: `${SITE}/` },
  about: { '@type': 'Thing', name: 'Казахская музыка' },
  mainEntity: {
    '@type': 'ItemList',
    numberOfItems: artists.length,
    itemListElement: artists.slice(0, 100).map((a, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: { '@type': 'MusicGroup', name: a.name },
    })),
  },
};

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Каталог: ${artists.length} казахстанских исполнителей — Óleńsiz</title>
<meta name="description" content="Кто есть в игре Óleńsiz: ${artists.length} казахстанских исполнителей и ${catalog.count} песен — той, ретро, Q-pop, рэп, инди, фольклор. Список артистов каталога.">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#08090a">
<link rel="canonical" href="${SITE}/catalog.html">
<meta property="og:type" content="article">
<meta property="og:title" content="Каталог игры Óleńsiz — ${artists.length} исполнителей">
<meta property="og:description" content="Полный список казахстанских исполнителей, чьи песни встречаются в игре «угадай казахскую песню».">
<meta property="og:url" content="${SITE}/catalog.html">
<meta property="og:image" content="${SITE}/og-image.png">
<link rel="icon" href="icons/icon-192.png">
<link rel="stylesheet" href="styles/tokens.css">
<style>
  html, body { overflow: auto; height: auto; }
  body {
    margin: 0;
    background: var(--color-bg-primary);
    color: var(--color-text-primary);
    font-family: var(--font-family-body);
    font-size: var(--font-size-md);
    line-height: var(--line-height-relaxed);
  }
  .doc { max-width: 52rem; margin-inline: auto; padding: var(--s-48) var(--s-24) var(--s-64); }
  .doc a { color: var(--color-accent-primary); }
  h1 {
    font-size: clamp(1.8rem, 5vw, 3rem);
    line-height: var(--line-height-tight);
    letter-spacing: var(--letter-spacing-tighter);
    margin: 0 0 var(--s-12);
  }
  h2 {
    font-size: var(--font-size-xl);
    letter-spacing: var(--letter-spacing-tight);
    margin: var(--s-48) 0 var(--s-12);
  }
  p, li { color: var(--color-text-secondary); margin: 0 0 var(--s-12); }
  .lead { color: var(--color-text-primary); font-size: var(--font-size-lg); }
  table { border-collapse: collapse; width: 100%; margin-bottom: var(--s-16); }
  th, td {
    text-align: left; padding: var(--s-8) var(--s-4);
    border-bottom: 1px solid var(--color-border-secondary);
    font-size: var(--font-size-base);
  }
  th { color: var(--color-text-tertiary); font-weight: var(--font-weight-medium); }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .artists { list-style: none; padding: 0; columns: 2; column-gap: var(--s-32); }
  .artists li { break-inside: avoid; margin-bottom: var(--s-8); color: var(--color-text-primary); }
  .artists .meta { color: var(--color-text-tertiary); font-size: var(--font-size-sm); display: block; }
  @media (max-width: 640px) { .artists { columns: 1; } }
  .back {
    display: inline-flex; align-items: center; gap: var(--s-8);
    min-height: var(--control-height);
    padding: 0 var(--s-24);
    margin-top: var(--s-32);
    background: var(--color-accent-primary); color: var(--color-accent-on);
    font-weight: var(--font-weight-bold); text-decoration: none;
  }
  footer { margin-top: var(--s-48); color: var(--color-text-tertiary); font-size: var(--font-size-sm); }
</style>
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
</head>
<body>
<main class="doc">
  <h1>Каталог Óleńsiz</h1>
  <p class="lead">
    ${catalog.count} песен ${artists.length} казахстанских исполнителей — это всё, что
    может попасться в игре «<a href="/">угадай казахскую песню</a>». Список
    собран не поиском по названиям, а по идентификаторам артистов в Apple
    Music, поэтому чужих песен здесь нет.
  </p>
  <p lang="kk">
    Ойында кездесетін орындаушылардың толық тізімі: ${artists.length} орындаушы,
    ${catalog.count} ән. Той әндері, ретро эстрада, Q-pop, рэп, инди, фольклор
    және андеграунд.
  </p>

  <h2>Категории</h2>
  <table>
    <thead><tr><th>Категория</th><th>Қазақша</th><th class="num">Песен</th><th>Фильтр в игре</th></tr></thead>
    <tbody>
${genreRows}
    </tbody>
  </table>
  <p>
    Категория показывается фильтром на старте, когда в ней набирается
    ${catalog.genreMinTracks} песен: пустой фильтр обманывает игрока сильнее,
    чем его отсутствие.
  </p>

  <h2>Исполнители</h2>
  <ul class="artists">
${artistItems}
  </ul>

  <a class="back" href="/">← Играть</a>
  <footer>
    <a href="about.html">Об игре и правила</a> ·
    <a href="/">olensiz.zhengisbay.com</a><br>
    Игра использует официальные открытые превью Apple iTunes. Аудиофайлы не
    хранятся, каждый трек атрибутирован исполнителю.
  </footer>
</main>
</body>
</html>
`;

await writeFile(join(ROOT, 'catalog.html'), html, 'utf8');

const day = today();
const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
        xmlns:xhtml="http://www.w3.org/1999/xhtml">
  <url>
    <loc>${SITE}/</loc>
    <lastmod>${day}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
    <xhtml:link rel="alternate" hreflang="kk" href="${SITE}/?lang=kk"/>
    <xhtml:link rel="alternate" hreflang="ru" href="${SITE}/?lang=ru"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>
  </url>
  <url>
    <loc>${SITE}/about.html</loc>
    <lastmod>${day}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>
  <url>
    <loc>${SITE}/catalog.html</loc>
    <lastmod>${day}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.6</priority>
  </url>
</urlset>
`;
await writeFile(join(ROOT, 'sitemap.xml'), sitemap, 'utf8');

console.log(`catalog.html — ${artists.length} исполнителей, ${catalog.count} песен`);
console.log(`sitemap.xml — 3 страницы, lastmod ${day}`);
