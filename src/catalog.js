/**
 * Каталог треков: загрузка, поиск, фильтры и подбор партии.
 *
 * Уровни сложности НЕ вычисляются здесь: они выводятся из `fame_tier`,
 * проставленного артисту в data/artists.csv. Соответствие уровень → тиры
 * лежит в собранном JSON (`levelTiers`), чтобы клиент и сборщик не могли
 * разъехаться.
 *
 * Поиск устойчив к казахской орфографии — это принцип брифа «слух важнее
 * орфографии»: қ↔k, ә↔a, ө↔o, ү/ұ↔u, ң↔n, ғ↔g, і↔i, j↔zh, y↔i,
 * латиница ↔ кириллица.
 */

import { CONFIG } from './config.js';
import { norm, foldKey, tightKey, skeleton, levenshtein, trigramSim } from './normalize.js';
import { ROUNDS } from './scoring.js';

/* ------------------------------------------------------------------ */
/* История сыгранного (блок I3)                                        */
/* ------------------------------------------------------------------ */

/**
 * Игрок не должен встречать один и тот же трек, пока не исчерпает каталог.
 *
 * История лежит в localStorage и ограничена по размеру: хранилище не должно
 * пухнуть от многолетней игры. Когда в каком-то тире свободных треков не
 * осталось, сбрасывается история ТОЛЬКО этого тира — иначе один исчерпанный
 * уровень обнулял бы память обо всех остальных.
 */
export class PlayHistory {
  constructor(key = CONFIG.HISTORY_KEY, limit = CONFIG.HISTORY_LIMIT) {
    this.key = key;
    this.limit = limit;
    this.ids = this._read();
  }

  _read() {
    try {
      const raw = JSON.parse(localStorage.getItem(this.key) || '[]');
      return Array.isArray(raw) ? raw.map(String) : [];
    } catch {
      return [];
    }
  }

  _write() {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.ids));
    } catch {
      /* приватный режим — история просто не переживёт вкладку */
    }
  }

  has(id) {
    return this.ids.includes(String(id));
  }

  add(ids) {
    for (const id of ids) {
      const s = String(id);
      if (!this.ids.includes(s)) this.ids.push(s);
    }
    // FIFO: самые старые забываются первыми.
    if (this.ids.length > this.limit) this.ids = this.ids.slice(-this.limit);
    this._write();
  }

  /** Забывает треки, попадающие в предикат. @returns {number} сколько забыли */
  forget(pred) {
    const before = this.ids.length;
    this.ids = this.ids.filter((id) => !pred(id));
    if (this.ids.length !== before) this._write();
    return before - this.ids.length;
  }

  clear() {
    this.ids = [];
    this._write();
  }

  get size() {
    return this.ids.length;
  }
}

/** Веса релевантности: точное совпадение названия всегда выше нечёткого. */
const W = {
  titleExact: 1000,
  titlePrefix: 720,
  titleWordPrefix: 640,
  titleContains: 560,
  artistExact: 520,
  artistPrefix: 470,
  artistContains: 400,
  comboContains: 340,
  skeleton: 330,
  allTokens: 300,
  fuzzyBase: 260,
  trigramScale: 250,
};

/** Резерв на замену треков, которые не смогли загрузиться. */
export const PICK_SPARE = 3;

export class Catalog {
  constructor(payload) {
    this.meta = payload;
    this.levelTiers = payload.levelTiers || {
      1: [1], 2: [1, 2], 3: [2, 3], 4: [3, 4], 5: [4, 5],
    };
    // Экспертный режим подмешивает тир 5 и андеграунд в верхние уровни.
    this.levelTiersExpert = payload.levelTiersExpert || this.levelTiers;
    /** Категории, которые вообще показываются игроку (порог из сборщика). */
    this.genres = payload.genres || [];
    this.history = new PlayHistory();

    this.tracks = payload.tracks.map((t) => {
      const titleF = foldKey(t.title);
      const artistF = foldKey(t.artist);
      return {
        ...t,
        _titleF: titleF,
        _artistF: artistF,
        _titleT: tightKey(t.title),
        _artistT: tightKey(t.artist),
        _comboF: `${artistF} ${titleF}`,
        _titleS: skeleton(t.title),
        _artistS: skeleton(t.artist),
        _titleWords: titleF.split(' ').filter(Boolean),
        _comboWords: `${artistF} ${titleF}`.split(' ').filter(Boolean),
        _display: `${t.artist} — ${t.title}`,
      };
    });

    this.byId = new Map(this.tracks.map((t) => [t.id, t]));
  }

  get size() {
    return this.tracks.length;
  }

  get artistCount() {
    return new Set(this.tracks.map((t) => t.artistKey || t._artistF)).size;
  }

  /** Какие жанры реально представлены в каталоге (для чипов на старте). */
  availableGenres() {
    const set = new Set();
    for (const t of this.tracks) for (const g of t.genres || []) set.add(g);
    return this.genres.filter((g) => set.has(g));
  }

  /* ---------------------------------------------------------------- */
  /* Фильтры                                                           */
  /* ---------------------------------------------------------------- */

  /**
   * @param {{ age?: 'family'|'18plus', genres?: string[] }} filters
   *   age 'family' — только семейные; '18plus' — семейные И взрослые
   *   (18+ это расширение каталога, а не отдельная его часть).
   */
  matches(track, filters) {
    if (filters.age === 'family' && track.age !== 'family') return false;
    if (filters.genres && filters.genres.length) {
      const has = (track.genres || []).some((g) => filters.genres.includes(g));
      if (!has) return false;
    }
    return true;
  }

  filtered(filters = {}) {
    return this.tracks.filter((t) => this.matches(t, filters));
  }

  /** Карта «уровень → тиры» для выбранного режима подачи. */
  tiersFor(filters = {}) {
    return filters.difficulty === 'expert' ? this.levelTiersExpert : this.levelTiers;
  }

  /**
   * Треки, допустимые на уровне `level` при данных фильтрах.
   *
   * В экспертном режиме на уровнях 4–5 к тирам добавляется андеграунд
   * независимо от тира: это ровно то «подмешивание», которого требует блок B1,
   * и оно делает верхние раунды по-настоящему трудными.
   */
  poolForLevel(level, filters = {}) {
    const map = this.tiersFor(filters);
    const tiers = map[level] || map[String(level)] || [];
    const mixUnderground = filters.difficulty === 'expert' && level >= 4;
    return this.tracks.filter((t) => {
      if (!this.matches(t, filters)) return false;
      if (tiers.includes(t.tier)) return true;
      return mixUnderground && (t.genres || []).includes('underground');
    });
  }

  /**
   * Хватает ли треков на партию. Возвращает подробности, чтобы UI мог
   * объяснить игроку, какой именно уровень пустует.
   */
  canStart(filters = {}) {
    const perLevel = [];
    let ok = true;
    for (let level = 1; level <= ROUNDS; level++) {
      const n = this.poolForLevel(level, filters).length;
      perLevel.push({ level, count: n });
      if (n < 1) ok = false;
    }
    const pool = this.filtered(filters);
    return {
      ok,
      perLevel,
      total: pool.length,
      // Счётчик артистов тоже должен считаться по отфильтрованному пулу:
      // иначе «54 песни / 115 исполнителей» выглядит как ошибка.
      artists: new Set(pool.map((t) => t.artistKey || t._artistF)).size,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Подбор партии                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * Партия: по одному случайному треку на каждый уровень, строго 1→5.
   * Дополнительно возвращает запасные треки на каждый уровень — ими
   * подменяются те, что не смогли загрузиться (см. src/audio.js).
   */
  pickGame(filters = {}, rounds = ROUNDS) {
    const used = new Set();
    const picked = [];
    const spares = [];
    /** Уровни, для которых пришлось сбросить историю (блок I3). */
    const recycled = [];

    for (let level = 1; level <= rounds; level++) {
      const levelPool = this.poolForLevel(level, filters).filter((t) => !used.has(t.id));
      if (levelPool.length === 0) {
        throw new Error(`Нет треков для уровня ${level} с текущими фильтрами`);
      }

      let pool = levelPool.filter((t) => !this.history.has(t.id));
      if (pool.length === 0) {
        // Уровень исчерпан: забываем историю ровно этого уровня, не всю.
        const ids = new Set(levelPool.map((t) => t.id));
        this.history.forget((id) => ids.has(id));
        recycled.push(level);
        pool = levelPool;
      }
      const shuffled = shuffle(pool);
      const main = shuffled[0];
      used.add(main.id);
      picked.push(main);

      const levelSpares = [];
      for (const t of shuffled.slice(1)) {
        if (levelSpares.length >= PICK_SPARE) break;
        if (used.has(t.id)) continue;
        used.add(t.id);
        levelSpares.push(t);
      }
      spares.push(levelSpares);
    }
    return { picked, spares, recycled };
  }

  /** Запоминает сыгранные треки, чтобы они не повторялись (блок I3). */
  remember(tracks) {
    this.history.add(tracks.map((t) => t.id));
  }

  get(id) {
    return this.byId.get(id);
  }

  /* ---------------------------------------------------------------- */
  /* Поиск                                                             */
  /* ---------------------------------------------------------------- */

  _score(t, qF, qT, qTokens, qS) {
    let best = 0;

    if (t._titleF === qF) best = Math.max(best, W.titleExact);
    else if (t._titleF.startsWith(qF)) best = Math.max(best, W.titlePrefix);
    else if (t._titleWords.some((w) => w.startsWith(qF))) best = Math.max(best, W.titleWordPrefix);
    else if (t._titleF.includes(qF)) best = Math.max(best, W.titleContains);

    if (t._artistF === qF) best = Math.max(best, W.artistExact);
    else if (t._artistF.startsWith(qF)) best = Math.max(best, W.artistPrefix);
    else if (t._artistF.includes(qF)) best = Math.max(best, W.artistContains);

    if (best === 0 && t._comboF.includes(qF)) best = W.comboContains;

    // Другой алфавит: «Ninety One» ищут как «найнти уан», «Скриптонит» — как
    // «Scriptonit». Сравниваем согласные скелеты; гласные при переносе между
    // языками плывут, согласные держатся.
    if (best === 0 && qS.length >= 3) {
      if (t._artistS === qS || t._titleS === qS) best = W.skeleton;
      else if (t._artistS.startsWith(qS) || t._titleS.startsWith(qS)) best = W.skeleton - 30;
      else if (qS.length >= 4 && (t._artistS.includes(qS) || t._titleS.includes(qS))) {
        best = W.skeleton - 60;
      }
    }

    // Слитный ввод: «карабала» тоже должен находить «Qara Bala».
    if (best === 0 && qT.length >= 4) {
      if (t._titleT.includes(qT) || t._artistT.includes(qT)) best = W.titleContains;
    }

    // Все слова запроса нашлись как префиксы слов трека, в любом порядке.
    if (best === 0 && qTokens.length > 1) {
      const all = qTokens.every((qt) => t._comboWords.some((w) => w.startsWith(qt)));
      if (all) best = W.allTokens;
    }

    // Опечатки: расстояние Левенштейна ≤ 2.
    if (best === 0 && qF.length >= 3) {
      let dist = 3;
      const cap = Math.min(2, Math.floor(qF.length / 3) + 1);
      if (Math.abs(t._titleF.length - qF.length) <= 2) {
        dist = Math.min(dist, levenshtein(qF, t._titleF, 2));
      }
      for (const w of t._comboWords) {
        if (Math.abs(w.length - qF.length) > 2) continue;
        dist = Math.min(dist, levenshtein(qF, w, 2));
        if (dist === 0) break;
      }
      if (dist <= Math.max(1, cap)) best = W.fuzzyBase - 60 * dist;
    }

    // Триграммный «шумовой пол»: он наполняет список похожими вариантами,
    // когда точного совпадения нет. Путать игрока — часть механики.
    const sim = trigramSim(qF, t._comboF);
    const simScore = Math.round(sim * W.trigramScale);
    return Math.max(best, simScore) + simScore * 0.15;
  }

  /**
   * Живой поиск. Ищет по ВСЕМУ каталогу независимо от фильтров партии:
   * список вариантов не должен подсказывать, из какого подмножества
   * загадан трек.
   */
  search(query, limit = CONFIG.SEARCH_RESULTS) {
    const qF = foldKey(query);
    if (!qF) return [];
    const qT = tightKey(query);
    const qTokens = qF.split(' ').filter(Boolean);
    const qS = skeleton(query);

    const scored = [];
    for (const t of this.tracks) {
      const s = this._score(t, qF, qT, qTokens, qS);
      if (s > 6) scored.push({ t, s });
    }
    scored.sort((a, b) => b.s - a.s || a.t._display.localeCompare(b.t._display, 'kk'));
    return scored.slice(0, limit).map((x) => x.t);
  }
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Грузит data/tracks.json. Ошибка пробрасывается — экран ошибки её покажет. */
export async function loadCatalog(url = CONFIG.CATALOG_URL) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`каталог HTTP ${res.status}`);
  const payload = await res.json();
  if (!payload || !Array.isArray(payload.tracks) || payload.tracks.length === 0) {
    throw new Error('каталог пуст');
  }
  return new Catalog(payload);
}

/**
 * Ссылки на стриминги. Apple — точная (из API), остальные — поисковые.
 * Атрибуция обязана быть везде, где показан трек: и на карточке раунда,
 * и на карточке финала.
 */
export function streamingLinks(track) {
  const q = encodeURIComponent(`${track.artist} ${track.title}`);
  return [
    track.appleUrl && { name: 'Apple Music', url: track.appleUrl },
    { name: 'Spotify', url: `https://open.spotify.com/search/${q}` },
    { name: 'Deezer', url: `https://www.deezer.com/search/${q}` },
  ].filter(Boolean);
}

export { norm, foldKey };
