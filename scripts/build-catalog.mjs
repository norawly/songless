#!/usr/bin/env node
/**
 * build-catalog.mjs — сбор каталога СТРОГО по whitelist артистов.
 *
 * Источник истины — data/artists.csv. Никакого свободного текстового поиска
 * по названиям треков: это архитектурная гарантия, а не фильтр-заплатка.
 *
 * Как трек попадает в каталог (и никак иначе):
 *   1. Имя артиста из CSV ищется через entity=musicArtist → получаем artistId.
 *   2. Треки берутся ТОЛЬКО через lookup?id={artistId}&entity=song.
 *   3. Каждый трек проверяется на принадлежность whitelist-у по artistId.
 *      Не совпал ID — трек отбрасывается, чем бы он ни назывался.
 *
 * Поэтому испанская (или любая другая чужая) песня физически не может пройти:
 * у неё другой artistId, а списка названий для поиска у скрипта просто нет.
 *
 * Запуск:  npm run build:catalog
 *          npm run build:catalog -- --fresh   (игнорировать кэш)
 */

import { writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { foldKey, norm } from '../src/normalize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CSV = join(ROOT, 'data', 'artists-v2.csv');
const OVERRIDES = join(ROOT, 'data', 'overrides.json');
const OUT = join(ROOT, 'data', 'tracks.json');
const REPORT = join(ROOT, 'data', 'build-report.md');
const CACHE = join(ROOT, '.cache');

const FRESH = process.argv.includes('--fresh');

/** Сколько треков берём у артиста в зависимости от его тира известности. */
const TRACKS_PER_TIER = { 1: 10, 2: 7, 3: 5, 4: 3, 5: 2 };

/**
 * Уровни сложности строятся из fame_tier, а не из выдуманного индекса.
 * Тир артиста → на каких уровнях могут появляться его треки.
 *
 * Экспертный режим (блок B1) подмешивает в верхние уровни тир 5 и андеграунд:
 * это и делает его экспертным, а не просто «фрагменты короче».
 */
export const LEVEL_TIERS = {
  1: [1],
  2: [1, 2],
  3: [2, 3],
  4: [3, 4],
  5: [4, 5],
};

export const LEVEL_TIERS_EXPERT = {
  1: [1],
  2: [1, 2],
  3: [2, 3],
  4: [3, 4, 5],
  5: [4, 5],
};

/**
 * Игровые категории — то, что человек видит чипами на старте.
 *
 * Итерация 3: тонкие жанры слиты в родительские, потому что категория без
 * песен хуже отсутствующей категории. jazz → rnb, electronic → pop,
 * classical вообще не игровая категория. Исходные теги при этом никуда не
 * деваются: они лежат в поле `tags` каждого трека и доступны редактору.
 */
const CANON_GENRES = [
  'toi', 'retro', 'pop', 'rnb', 'rap', 'underground',
  'indie', 'folk', 'patriotic', 'qpop', 'rock', 'memes',
];

const GENRE_ALIASES = {
  estrada: 'retro',
  alt: 'indie',
  acoustic: 'indie',
  ethno: 'folk',
  instrumental: 'folk',
  soul: 'rnb',
  comedy: 'memes',
  meme: 'memes',
  remix: 'pop',
  jazz: 'rnb',
  electronic: 'pop',
  classical: 'pop',
};

/**
 * Порог показа категории. Меньше — категория есть в данных, но чипа нет:
 * пустой фильтр обманывает игрока сильнее, чем его отсутствие.
 */
const GENRE_MIN_TRACKS = 25;

/**
 * Мемы собираются вручную (data/memes.csv), а не приходят жанром от Apple.
 * Треки оттуда получают тег `memes` и ВОЗРАСТ 18+: мемные песни в детскую
 * подборку попадать не должны ни при каких условиях.
 */
const MEMES_CSV = join(ROOT, 'data', 'memes.csv');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ==================================================================== */
/* CSV                                                                  */
/* ==================================================================== */

/** Разбор CSV с поддержкой кавычек и запятых внутри поля. */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') {
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = []; field = '';
      continue;
    }
    if (c === '\r') continue;
    field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);

  // Строки, начинающиеся с #, — комментарии. В data/memes.csv они несут
  // правила категории, и парсер обязан их пропускать, а не считать данными.
  const clean = rows.filter((r) => !String(r[0] ?? '').trim().startsWith('#'));
  const head = clean.shift().map((h) => h.trim());
  return clean.map((r) => {
    const o = {};
    head.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

/**
 * @returns {{genres: string[], tags: string[]}}
 *   genres — игровые категории (после слияния), tags — как записано в CSV.
 */
function canonGenres(raw) {
  const tags = String(raw || '')
    .split('|').map((x) => x.trim().toLowerCase()).filter(Boolean);
  const out = new Set();
  for (const g of tags) {
    const mapped = GENRE_ALIASES[g] || g;
    if (CANON_GENRES.includes(mapped)) out.add(mapped);
  }
  if (out.size === 0) out.add('pop');
  return { genres: [...out], tags };
}

/**
 * Схлопывает строки-дубли. В artists-v2.csv один и тот же артист встречается
 * дважды (`madi-rymbaev`), а Turan — под двумя разными id. Сборщик обязан это
 * пережить сам: пусть CSV остаётся таким, каким его ведёт человек.
 */
function dedupeRows(rows, report) {
  const byKey = new Map();
  for (const row of rows) {
    const key = foldKey(row.artist) || row.id;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, row); continue; }
    report.duplicates.push({ kept: prev.id, dropped: row.id, artist: row.artist });
    // Оставляем строку с более заполненными notes — в них кураторский сигнал.
    if ((row.notes || '').length > (prev.notes || '').length) byKey.set(key, row);
  }
  return [...byKey.values()];
}

/**
 * Похоже ли название на английскую песню.
 *
 * Это второй сигнал из блока I1: у казахоязычного артиста трек с чисто
 * английским названием — повод посмотреть глазами. Проверяем не «латиницу»
 * (половина каталога на латинице: «Sagynysh», «Bolme»), а именно английские
 * служебные слова — только они отличают чужую песню от казахской в романизации.
 */
const EN_WORDS = new Set([
  'the', 'you', 'your', 'my', 'me', 'i', 'love', 'baby', 'girl', 'boy', 'night',
  'day', 'life', 'time', 'heart', 'don', 'dont', 'can', 'want', 'need', 'know',
  'never', 'forever', 'always', 'about', 'without', 'with', 'and', 'for', 'like',
  'feel', 'feeling', 'money', 'dream', 'dreams', 'lonely', 'again', 'all', 'is',
  'it', 'no', 'on', 'in', 'of', 'to', 'be', 'we', 'she', 'he', 'they', 'she',
]);

function looksEnglish(title) {
  const words = norm(title).split(' ').filter(Boolean);
  if (words.length === 0) return false;
  if (/[а-яёәөүұқңғіһ]/i.test(title)) return false;
  const hits = words.filter((w) => EN_WORDS.has(w)).length;
  return hits >= Math.max(1, Math.ceil(words.length * 0.34));
}

/* ==================================================================== */
/* iTunes API + кэш                                                     */
/* ==================================================================== */

async function cachedFetch(url, attempt = 0) {
  const key = createHash('sha1').update(url).digest('hex');
  const file = join(CACHE, `${key}.json`);

  if (!FRESH) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch { /* кэша нет — идём в сеть */ }
  }

  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'tap-anda-catalog/2.0' } });
    if (res.status === 403 || res.status === 429) throw new Error(`rate-limit ${res.status}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = JSON.parse(await res.text());
    await writeFile(file, JSON.stringify(data), 'utf8');
    await sleep(220);
    return data;
  } catch (err) {
    if (attempt < 5) {
      const wait = 1200 * 2 ** attempt;
      process.stderr.write(`    retry (${err.message}) через ${wait}мс\n`);
      await sleep(wait);
      return cachedFetch(url, attempt + 1);
    }
    process.stderr.write(`    ПРОПУСК ${url}: ${err.message}\n`);
    return { results: [], resultCount: 0, _failed: true };
  }
}

const api = (path, params) =>
  cachedFetch(`https://itunes.apple.com/${path}?${new URLSearchParams({ country: 'KZ', ...params })}`);

/* ==================================================================== */
/* Шаг 1: имя артиста → artistId                                        */
/* ==================================================================== */

/**
 * Совпадает ли имя из выдачи с именем или одним из алиасов из CSV.
 *
 * Правило намеренно строгое. Раньше допускалось совпадение по отдельному
 * слову — и односложные имена собирали чужих: «Ali» из CSV притягивал
 * «Ali Gatie» и «ALI (feat. AKLO)», которые к казахстанской сцене отношения
 * не имеют. Теперь:
 *   • односложное имя обязано совпасть ТОЧНО;
 *   • имя из двух и более слов может быть подстрокой найденного — это
 *     покрывает фиты вида «Kairat Nurtas & Nyusha», оставаясь однозначным.
 */
function nameMatches(candidates, found) {
  const f = foldKey(found);
  if (!f) return false;
  const fWords = f.split(' ');

  return candidates.some((c) => {
    const a = foldKey(c);
    if (!a) return false;
    if (a === f) return true;

    const aWords = a.split(' ');
    if (aWords.length < 2) return false; // односложные — только точное совпадение

    // непрерывная последовательность слов внутри найденного имени
    for (let i = 0; i + aWords.length <= fWords.length; i++) {
      let ok = true;
      for (let j = 0; j < aWords.length; j++) {
        if (fWords[i + j] !== aWords[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  });
}

/**
 * Слишком короткий алиас нельзя использовать для опознания артиста.
 *
 * Именно так в каталог попал англоязычный трек под «Ириной Кайратовной»:
 * в алиасах стоит «IK», а в Apple есть исполнители ровно с таким именем.
 * Две-три буквы совпадают у кого угодно, поэтому такие алиасы участвуют
 * только в поиске игрока, но не в сопоставлении артиста.
 */
const MIN_ALIAS_LEN = 4;

async function resolveArtistIds(row, log) {
  const names = [row.artist, ...String(row.aliases || '').split('|')]
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s === row.artist || foldKey(s).replace(/\s/g, '').length >= MIN_ALIAS_LEN);

  /** @type {Map<number, {name:string, count:number}>} */
  const found = new Map();

  for (const name of names) {
    const data = await api('search', {
      term: name, entity: 'musicArtist', limit: '15', media: 'music',
    });
    for (const r of data.results || []) {
      if (!r.artistId) continue;
      if (!nameMatches(names, r.artistName)) continue;
      if (!found.has(r.artistId)) found.set(r.artistId, { name: r.artistName, count: 0 });
    }
  }

  if (found.size === 0) {
    log.push(`  ✗ artistId не найден`);
    return [];
  }
  return [...found.entries()].map(([id, v]) => ({ artistId: id, artistName: v.name }));
}

/* ==================================================================== */
/* Шаг 2: artistId → треки (ТОЛЬКО lookup)                              */
/* ==================================================================== */

const LIVE_RE = /\b(live|концерт|в живую|unplugged)\b|\(live\b|\[live\b/i;
const REMIX_RE = /\b(remix|rmx|mix|version|edit|reprise|instrumental|karaoke|минус)\b|\(.*(remix|version).*\)/i;
const JUNK_RE = /\b(sped up|slowed|nightcore|8d audio|reverb|mashup)\b/i;

/**
 * Признак «свой» каталог — КИРИЛЛИЦА.
 *
 * Латинские диакритики сюда намеренно не входят. Первая версия принимала
 * ş/ğ/ı/ü и заодно обычные i и á — из-за чего «Wild Side» японской группы ALI
 * и «Senden Daha Güzel» турецкой Duman засчитывались как казахские названия.
 * Казахская латиница неотличима от турецкой автоматически, поэтому
 * второй сигнал берём не из букв, а из колонки notes (см. countNoteHits).
 */
const KZ_CHARS = /[а-яёәөүұқңғіһ]/i;

/**
 * Слова-хиты из колонки notes: кураторский сигнал, кто здесь настоящий.
 * Порог длины 3, а не 4: короткие казахские названия вроде «Ai ai» и «Сен»
 * иначе выпадали, и живые артисты отклонялись как неподтверждённые.
 */
function noteWordsOf(row) {
  const n = norm(row.notes || '');
  return { words: n.split(' ').filter((w) => w.length >= 3), full: n };
}

function countNoteHits(tracks, notes) {
  // Проверяем по notes.full, а не по списку слов: у коротких названий
  // («Ai ai», «Сен») все слова короче порога, и ранний выход по пустому
  // списку убивал бы совпадение целиком.
  if (!notes.full) return 0;
  let hits = 0;
  for (const t of tracks) {
    const title = norm(t.trackName);
    if (!title) continue;

    // (а) название целиком встречается в notes — ловит короткие «Ai ai», «Сен»
    if (title.length >= 3 && notes.full.includes(title)) { hits++; continue; }

    // (б) большинство значимых слов названия названы в notes
    const words = title.split(' ').filter((w) => w.length >= 3);
    if (!words.length) continue;
    const m = words.filter((w) => notes.words.includes(w)).length;
    if (m && m >= Math.ceil(words.length * 0.6)) hits++;
  }
  return hits;
}

/** Доля треков с кириллицей в названии или альбоме. */
function kzShare(tracks) {
  if (!tracks.length) return 0;
  let n = 0;
  for (const t of tracks) {
    const blob = `${t.trackName} ${t.collectionName || ''}`;
    if (KZ_CHARS.test(blob)) n++;
  }
  return n / tracks.length;
}

/**
 * Забирает треки каждого кандидата и решает, кто из них — тот самый артист.
 *
 * Проверки по artistId мало: односложные имена делят с чужими людьми по всему
 * миру. «Ali» — это и казахстанский артист, и японская группа ALI; «Duman» —
 * и казахстанский, и турецкая рок-группа; «ZAQ», «TURAN», «Hiro», «Junior» —
 * та же история. Слить их id в один whitelist значит затащить в каталог
 * турецкий рок и японский хип-хоп.
 *
 * Поэтому кандидаты ранжируются по двум сигналам:
 *   1. попадания в хиты, названные в колонке notes (кураторский, самый сильный);
 *   2. доля треков с казахской кириллицей/латиницей.
 * Побеждает лучший; остальные id присоединяются, только если сами проходят
 * тест на «казахстанскость» — то есть это действительно дубли одного артиста
 * в базе Apple, а не однофамильцы.
 */
async function fetchArtistTracks(row, artistIds, report) {
  const noteWords = noteWordsOf(row);

  const candidates = [];
  for (const { artistId, artistName } of artistIds) {
    // limit=200 вместо 30: нужны кандидаты ДО фильтрации, чтобы после отсева
    // лайвов и ремиксов осталось из чего выбирать топ-N.
    const data = await api('lookup', { id: String(artistId), entity: 'song', limit: '200' });
    const tracks = (data.results || []).filter(
      (r) => r.wrapperType === 'track' && r.kind === 'song' && r.artistId === artistId
    );
    if (tracks.length === 0) continue;
    candidates.push({
      artistId,
      artistName,
      tracks,
      noteHits: countNoteHits(tracks, noteWords),
      kz: kzShare(tracks),
    });
  }

  if (candidates.length === 0) return { tracks: [], accepted: [], suspicious: false };

  candidates.sort(
    (a, b) => b.noteHits - a.noteHits || b.kz - a.kz || b.tracks.length - a.tracks.length
  );

  const best = candidates[0];

  // Артист считается подтверждённым, если у него есть попадания в хиты из notes
  // ЛИБО заметная доля кириллических названий. Иначе это, скорее всего,
  // однофамилец с другого конца мира — и он в каталог не попадает вовсе.
  // Лучше потерять артиста (он будет назван в отчёте) и проверить его руками,
  // чем затащить японский хип-хоп в игру про казахскую музыку.
  const confirms = (c) => c.noteHits > 0 || c.kz >= 0.25;
  const strength = (c) => c.noteHits * 10 + c.kz * 4;

  if (!confirms(best)) {
    report.suspicious.push({
      artist: row.artist,
      picked: best.artistName,
      artistId: best.artistId,
      kz: best.kz.toFixed(2),
      candidates: candidates.length,
      sample: best.tracks.slice(0, 3).map((t) => t.trackName).join(' / '),
      reason: 'ни одного попадания в notes, кириллицы почти нет',
    });
    return { tracks: [], accepted: [], suspicious: true };
  }

  /*
   * Второй профиль того же артиста в Apple — обычное дело: «Мақпал Жүнісова»
   * заведена дважды, Батырхан Шүкенов существует и сам по себе, и как
   * А'Студио. Такие профили сливать нужно, иначе половина каталога артиста
   * просто потеряется.
   *
   * А вот однофамилец с другого конца мира сливаться не должен. Отличаем их
   * не по «похожести», а по тому же тесту подтверждения: чужой исполнитель
   * не даёт ни попаданий в notes, ни кириллицы, и до этой строки не доходит.
   *
   * Отдельно логируем каждое слияние: если оно окажется ошибочным, это будет
   * видно в отчёте по имени профиля, а не обнаружится в игре.
   */
  const extra = candidates.slice(1).filter(confirms);
  const accepted = [best, ...extra];
  if (extra.length) {
    report.merged.push({
      artist: row.artist,
      profiles: accepted.map((c) => `${c.artistName} (${c.artistId})`).join(', '),
      strength: accepted.map((c) => strength(c).toFixed(1)).join(' / '),
    });
  }

  // Треки только подтверждённых профилей и только там, где артист основной.
  const byTrackId = new Map();
  for (const c of accepted) {
    for (const t of c.tracks) if (!byTrackId.has(t.trackId)) byTrackId.set(t.trackId, t);
  }
  return { tracks: [...byTrackId.values()], accepted, suspicious: false };
}

/**
 * Порядок популярности. lookup отдаёт треки по альбомам, а не по популярности,
 * поэтому ранг берём из двух источников:
 *   1. Хиты, перечисленные в колонке notes CSV, — кураторский сигнал, он главный.
 *   2. Порядок релевантности в search по artistTerm — прокси популярности.
 * Оба сигнала применяются ТОЛЬКО к трекам, уже прошедшим проверку по artistId.
 */
async function popularityRank(row, acceptedIds, tracks) {
  const rank = new Map(); // trackId -> число, меньше = популярнее
  const whitelist = new Set(acceptedIds);

  // (1) хиты из notes — кураторский сигнал популярности, он главный
  const notes = noteWordsOf(row);
  if (notes.full) {
    for (const t of tracks) {
      if (countNoteHits([t], notes) > 0) rank.set(t.trackId, -1000 + rank.size);
    }
  }

  // (2) релевантность поиска по имени артиста
  const data = await api('search', {
    term: row.artist, attribute: 'artistTerm', entity: 'song', limit: '100', media: 'music',
  });
  let i = 0;
  for (const r of data.results || []) {
    if (!whitelist.has(r.artistId)) continue; // чужие в ранжирование не попадают
    if (!rank.has(r.trackId)) rank.set(r.trackId, i);
    i++;
  }
  return rank;
}

/* ==================================================================== */
/* Шаг 3: отсев и выбор топ-N                                           */
/* ==================================================================== */

function selectTracks(tracks, rank, tier) {
  const limit = TRACKS_PER_TIER[tier] ?? 3;
  const rejected = { noPreview: 0, tooShort: 0, dupTitle: 0, live: 0, remix: 0, junk: 0 };

  const usable = tracks.filter((t) => {
    if (!t.previewUrl) { rejected.noPreview++; return false; }
    if ((t.trackTimeMillis || 0) < 60000) { rejected.tooShort++; return false; }
    if (JUNK_RE.test(t.trackName)) { rejected.junk++; return false; }
    return true;
  });

  usable.sort((a, b) => {
    const ra = rank.get(a.trackId) ?? 9999;
    const rb = rank.get(b.trackId) ?? 9999;
    return ra - rb;
  });

  /** Ключ «та же песня»: нормализованное название без скобочных пометок. */
  const baseKey = (name) =>
    foldKey(String(name).replace(/[([].*?[)\]]/g, '').replace(/\s*(feat|ft)\.?\s.*$/i, ''));

  const chosen = [];
  const seen = new Map(); // baseKey -> индекс в chosen

  for (const t of usable) {
    const key = baseKey(t.trackName);
    if (!key) continue;
    const isLive = LIVE_RE.test(t.trackName) || LIVE_RE.test(t.collectionName || '');
    const isRemix = REMIX_RE.test(t.trackName);

    if (seen.has(key)) {
      // Уже есть эта песня. Заменяем только если новая «чище» предыдущей:
      // студийная вместо лайва, оригинал вместо ремикса.
      const prevIdx = seen.get(key);
      const prev = chosen[prevIdx];
      const prevBad = LIVE_RE.test(prev.trackName) || REMIX_RE.test(prev.trackName);
      const nowBad = isLive || isRemix;
      if (prevBad && !nowBad) chosen[prevIdx] = t;
      else if (isLive) rejected.live++;
      else if (isRemix) rejected.remix++;
      else rejected.dupTitle++;
      continue;
    }

    seen.set(key, chosen.length);
    chosen.push(t);
    if (chosen.length >= limit) break;
  }

  return { chosen, rejected };
}

/* ==================================================================== */

function bigArt(url) {
  return url ? url.replace(/\/\d+x\d+bb\.(jpg|png)$/, '/600x600bb.$1') : null;
}

/** Ручные переопределения из локального редактора (scripts/editor-server.mjs). */
async function loadOverrides() {
  try {
    const raw = JSON.parse(await readFile(OVERRIDES, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Накладывает ручные правки поверх собранного трека.
 * Пересборка каталога НИКОГДА не затирает переопределения: они живут в
 * отдельном файле и применяются последними.
 */
function applyOverride(track, ov) {
  if (!ov) return track;
  const out = { ...track };
  if (Number.isFinite(ov.startOffset)) out.startOffset = Number(ov.startOffset);
  if (Number.isFinite(ov.tier)) out.tier = Math.min(5, Math.max(1, Math.round(ov.tier)));
  if (Array.isArray(ov.genres) && ov.genres.length) {
    out.genres = ov.genres.filter((g) => CANON_GENRES.includes(g));
    if (!out.genres.length) out.genres = track.genres;
  }
  if (ov.age === 'family' || ov.age === '18plus') out.age = ov.age;
  // Мемы остаются 18+ даже если в переопределении стоит family: это правило
  // каталога, а не предпочтение.
  if ((out.genres || []).includes('memes')) out.age = '18plus';
  if (typeof ov.note === 'string' && ov.note.trim()) out.note = ov.note.trim();
  if (ov.hidden === true) out.hidden = true;
  out.edited = true;
  return out;
}

/** id → пометка «это мем». Файла может не быть — тогда категория пустая. */
async function loadMemes() {
  try {
    const rows = parseCsv(await readFile(MEMES_CSV, 'utf8'));
    return new Set(rows.map((r) => String(r.id || '').trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const all = parseCsv(await readFile(CSV, 'utf8'));
  const memes = await loadMemes();

  const report = {
    csvRows: all.length,
    resolved: 0,
    failed: [],
    needsReview: [],
    suspicious: [],
    merged: [],
    duplicates: [],
    englishTitles: [],
    perArtist: [],
    rejected: { noPreview: 0, tooShort: 0, dupTitle: 0, live: 0, remix: 0, junk: 0 },
  };

  const rows = dedupeRows(all, report);
  report.artists = rows.length;
  const overrides = await loadOverrides();
  console.log(
    `Строк в CSV: ${all.length} → артистов после дедупликации: ${rows.length}` +
    `${FRESH ? ' (кэш игнорируется)' : ''}\n`
  );

  const tracks = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const tier = Number(row.fame_tier) || 3;
    const log = [];
    process.stdout.write(`[${String(i + 1).padStart(3)}/${rows.length}] ${row.artist.padEnd(28).slice(0, 28)} `);

    const artistIds = await resolveArtistIds(row, log);
    if (artistIds.length === 0) {
      console.log('— артист не найден');
      report.failed.push({ id: row.id, artist: row.artist, reason: 'artistId не найден' });
      continue;
    }

    const { tracks: raw, accepted } = await fetchArtistTracks(row, artistIds, report);
    if (raw.length === 0) {
      console.log(`— 0 треков (id: ${artistIds.map((a) => a.artistId).join(',')})`);
      report.failed.push({ id: row.id, artist: row.artist, reason: 'lookup вернул 0 треков' });
      continue;
    }

    const rank = await popularityRank(row, accepted.map((a) => a.artistId), raw);
    const { chosen, rejected } = selectTracks(raw, rank, tier);
    for (const k of Object.keys(rejected)) report.rejected[k] += rejected[k];

    if (chosen.length === 0) {
      console.log('— все треки отсеяны');
      report.failed.push({ id: row.id, artist: row.artist, reason: 'все треки отсеяны фильтрами' });
      continue;
    }

    const { genres, tags } = canonGenres(row.genres);
    const needsReview = row.kz_origin === 'verify';

    for (const t of chosen) {
      const english = looksEnglish(t.trackName);
      if (english) {
        report.englishTitles.push({ artist: row.artist, title: t.trackName });
      }
      const base = {
        id: String(t.trackId),
        title: t.trackName,
        artist: t.artistName,
        artistId: t.artistId,
        artistKey: row.id,
        album: t.collectionName || null,
        year: t.releaseDate ? Number(t.releaseDate.slice(0, 4)) : null,
        durationMs: t.trackTimeMillis || null,
        preview: t.previewUrl,
        art: bigArt(t.artworkUrl100),
        appleUrl: t.trackViewUrl || null,
        tier,
        genres,
        tags,
        age: row.age === '18plus' ? '18plus' : 'family',
        era: row.era || null,
        ...(needsReview ? { needsReview: true } : {}),
        // Английское название у казахоязычного артиста — повод посмотреть
        // глазами. Не исключаем, но помечаем: редактор умеет фильтровать.
        ...(english ? { flagEnglish: true } : {}),
      };
      // Мем — это не жанр от Apple, а ручная пометка. Она добавляется к
      // существующим тегам и всегда тянет за собой 18+.
      if (memes.has(String(base.id))) {
        base.genres = [...new Set([...(base.genres || []), 'memes'])];
        base.age = '18plus';
      }
      tracks.push(applyOverride(base, overrides[base.id]));
    }

    report.resolved++;
    report.perArtist.push({
      artist: row.artist, tier, ids: accepted.length,
      candidates: raw.length, taken: chosen.length,
    });
    if (needsReview) {
      report.needsReview.push({ artist: row.artist, tracks: chosen.length, note: row.notes });
    }
    console.log(`✓ ${String(chosen.length).padStart(2)} из ${String(raw.length).padStart(3)} (tier ${tier})${needsReview ? '  ⚠ needs_review' : ''}`);
  }

  // --- финальная дедупликация по trackId между артистами (фиты) ---
  const seenId = new Set();
  const unique = tracks.filter((t) => {
    if (t.hidden) return false; // скрыт вручную в редакторе
    if (seenId.has(t.id)) return false;
    seenId.add(t.id);
    return true;
  });

  const byTier = {};
  const byGenre = {};
  const byAge = { family: 0, '18plus': 0 };
  for (const t of unique) {
    byTier[t.tier] = (byTier[t.tier] || 0) + 1;
    byAge[t.age]++;
    for (const g of t.genres) byGenre[g] = (byGenre[g] || 0) + 1;
  }

  // Категория показывается игроку, только если в ней действительно есть песни.
  const playableGenres = CANON_GENRES.filter((g) => (byGenre[g] || 0) >= GENRE_MIN_TRACKS);

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'iTunes lookup by artistId (whitelist: data/artists-v2.csv)',
    note:
      'Треки собраны строго по одному artistId из whitelist. Свободный текстовый ' +
      'поиск по названиям не используется. Только метаданные и ссылки на официальные ' +
      '30-секундные превью Apple; аудиофайлы не хранятся.',
    levelTiers: LEVEL_TIERS,
    levelTiersExpert: LEVEL_TIERS_EXPERT,
    /** Категории, которые показываются чипами (≥ GENRE_MIN_TRACKS треков). */
    genres: playableGenres,
    /** Все канонические категории — для отчёта и редактора. */
    allGenres: CANON_GENRES,
    genreMinTracks: GENRE_MIN_TRACKS,
    count: unique.length,
    edited: unique.filter((t) => t.edited).length,
    byTier,
    byGenre,
    byAge,
    tracks: unique,
  };

  await writeFile(OUT, JSON.stringify(payload, null, 1) + '\n', 'utf8');

  /* --- отчёт сборки --- */
  const lines = [
    '# Отчёт сборки каталога',
    '',
    `Дата: ${new Date().toISOString()}`,
    `Источник: \`data/artists-v2.csv\` → iTunes lookup по одному \`artistId\``,
    '',
    '## Итог',
    '',
    `- Строк в CSV: **${report.csvRows}**`,
    `- Артистов после дедупликации: **${report.artists}**`,
    `- Успешно обработано: **${report.resolved}**`,
    `- Не удалось: **${report.failed.length}**`,
    `- Треков в каталоге: **${unique.length}**`,
    `- Из них с ручными правками: **${payload.edited}**`,
    `- Игровых категорий: **${playableGenres.length}** из ${CANON_GENRES.length}`,
    `- Уникальных артистов в каталоге: **${new Set(unique.map((t) => t.artistKey)).size}**`,
    '',
    '## Распределение по тирам',
    '',
    '| Тир | Треков | Уровни, где встречается |',
    '| --- | ---: | --- |',
    ...[1, 2, 3, 4, 5].map((t) =>
      `| ${t} | ${byTier[t] || 0} | ${Object.entries(LEVEL_TIERS)
        .filter(([, ts]) => ts.includes(t)).map(([l]) => l).join(', ')} |`),
    '',
    '## Категории',
    '',
    `Категория показывается чипом на старте, только если в ней хотя бы`,
    `**${GENRE_MIN_TRACKS}** треков. Пустая категория обманывает игрока сильнее,`,
    'чем её отсутствие, поэтому такие просто не показываются.',
    '',
    '| Категория | Треков | Показывается |',
    '| --- | ---: | --- |',
    ...CANON_GENRES.map((g) =>
      `| ${g} | ${byGenre[g] || 0} | ${(byGenre[g] || 0) >= GENRE_MIN_TRACKS ? 'да' : '**нет**'} |`),
    '',
    'Слиты в родительские и как отдельные категории не существуют: ' +
      '`jazz` → `rnb`, `electronic` → `pop`, `classical` → `pop`, `estrada` → `retro`, ' +
      '`ethno`/`instrumental` → `folk`, `alt`/`acoustic` → `indie`. ' +
      'Исходные теги сохранены в поле `tags` каждого трека.',
    '',
    '## Возрастной фильтр',
    '',
    `- family: **${byAge.family}**`,
    `- 18+: **${byAge['18plus']}**`,
    '',
  ];

  if (report.needsReview.length) {
    lines.push(
      '## ⚠ Требуют ручной проверки происхождения (`kz_origin=verify`)',
      '',
      'Эти артисты попали в каталог, но их казахстанское происхождение не подтверждено.',
      'Проверьте и либо поставьте `confirmed` в CSV, либо удалите строку и пересоберите.',
      '',
      '| Артист | Треков | Примечание из CSV |',
      '| --- | ---: | --- |',
      ...report.needsReview.map((r) => `| ${r.artist} | ${r.tracks} | ${r.note} |`),
      ''
    );
  } else {
    lines.push('## Требуют ручной проверки', '', 'Нет.', '');
  }

  if (report.suspicious.length) {
    lines.push(
      '## ⚠ Отклонены как неподтверждённые (однофамильцы)',
      '',
      'В Apple нашёлся артист с таким именем, но подтвердить, что это именно',
      'казахстанский исполнитель, не удалось: ни одного попадания в хиты из',
      'колонки `notes` и почти нет кириллицы в названиях. В каталог НЕ попали.',
      '',
      'Что делать: уточните имя в `data/artists.csv`, добавьте алиас или впишите',
      'в `notes` названия реальных песен — по ним сборщик и опознаёт артиста.',
      '',
      '| Артист из CSV | Что нашлось | artistId | Кириллица | Кандидатов | Примеры треков |',
      '| --- | --- | ---: | ---: | ---: | --- |',
      ...report.suspicious.map((r) =>
        `| ${r.artist} | ${r.picked} | ${r.artistId} | ${r.kz} | ${r.candidates} | ${r.sample} |`),
      ''
    );
  }

  if (report.merged.length) {
    lines.push(
      '## Слитые профили одного артиста',
      '',
      'В Apple у артиста несколько профилей — они объединены. Слияние проходят',
      'только профили, прошедшие тот же тест на подлинность (попадания в `notes`',
      'или кириллица в названиях), поэтому однофамилец с другого конца мира',
      'сюда попасть не может. Список — чтобы ошибочное слияние было видно здесь,',
      'а не обнаружилось в игре.',
      '',
      '| Артист | Профили | Сила сигнала |',
      '| --- | --- | --- |',
      ...report.merged.map((r) => `| ${r.artist} | ${r.profiles} | ${r.strength} |`),
      ''
    );
  }

  if (report.duplicates.length) {
    lines.push(
      '## Дубли строк в CSV',
      '',
      'Схлопнуты автоматически, CSV править не обязательно.',
      '',
      '| Артист | Оставлен id | Отброшен id |',
      '| --- | --- | --- |',
      ...report.duplicates.map((d) => `| ${d.artist} | \`${d.kept}\` | \`${d.dropped}\` |`),
      ''
    );
  }

  if (report.englishTitles.length) {
    lines.push(
      '## Английские названия (флаг на проверку)',
      '',
      'Не исключены из каталога — просто помечены `flagEnglish`. В локальном',
      'редакторе (`npm run editor`) по этому флагу есть фильтр.',
      '',
      '| Артист | Трек |',
      '| --- | --- |',
      ...report.englishTitles.slice(0, 60).map((r) => `| ${r.artist} | ${r.title} |`),
      report.englishTitles.length > 60
        ? `\n…и ещё ${report.englishTitles.length - 60}.` : '',
      ''
    );
  }

  if (report.failed.length) {
    lines.push(
      '## Отвалились',
      '',
      '| Артист | Причина |',
      '| --- | --- |',
      ...report.failed.map((f) => `| ${f.artist} | ${f.reason} |`),
      ''
    );
  }

  lines.push(
    '## Отсеяно фильтрами',
    '',
    '| Причина | Треков |',
    '| --- | ---: |',
    `| нет previewUrl | ${report.rejected.noPreview} |`,
    `| короче 60 секунд | ${report.rejected.tooShort} |`,
    `| дубль названия | ${report.rejected.dupTitle} |`,
    `| live при наличии студийной | ${report.rejected.live} |`,
    `| ремикс при наличии оригинала | ${report.rejected.remix} |`,
    `| мусор (sped up / nightcore / 8d) | ${report.rejected.junk} |`,
    '',
    '## Взято по артистам',
    '',
    '| Артист | Тир | artistId | Кандидатов | Взято |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...report.perArtist.map((p) =>
      `| ${p.artist} | ${p.tier} | ${p.ids} | ${p.candidates} | ${p.taken} |`),
    ''
  );

  await writeFile(REPORT, lines.join('\n'), 'utf8');

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Треков: ${unique.length} | артистов: ${new Set(unique.map((t) => t.artistKey)).size}`);
  console.log('По тирам:', byTier);
  console.log('По возрасту:', byAge);
  console.log(`Отвалилось артистов: ${report.failed.length}`);
  console.log(`needs_review: ${report.needsReview.length}`);
  console.log(`отклонено как неподтверждённые: ${report.suspicious.length}`);
  console.log(`слито профилей: ${report.merged.length}`);
  console.log('категории:', playableGenres.join(', '));
  console.log(`\n→ data/tracks.json`);
  console.log(`→ data/build-report.md`);
  const files = await readdir(CACHE).catch(() => []);
  console.log(`Кэш: ${files.length} ответов в .cache/\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
