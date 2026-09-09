/**
 * Лидерборды через Google Apps Script Web App.
 *
 * Таблица считается не общей кучей, а по СРЕЗАМ (блок H2):
 *   период   — за всё время / за сегодня
 *   категория — Random или конкретный набор жанров, плюс режим подачи
 *               и возрастной фильтр
 * Ключ среза строит Game.sliceKey, например `random|expert|family`.
 * Игрок после партии видит своё место именно в том срезе, в котором играл.
 *
 * Если CONFIG.LEADERBOARD_ENDPOINT пуст — модуль отвечает `enabled() === false`,
 * UI не показывает лидерборды, и ни один сетевой запрос не уходит.
 * Игра обязана работать полностью без них.
 *
 * Ключей на клиенте нет вообще — только URL эндпоинта. Сервисный аккаунт с
 * JSON-ключом здесь применять нельзя: на статическом сайте ключ оказался бы
 * в исходнике и его увидел бы любой.
 *
 * Про CORS: Apps Script не обрабатывает preflight, поэтому POST уходит с
 * `Content-Type: text/plain;charset=utf-8` — это «простой» запрос по
 * спецификации CORS, preflight для него не требуется. Тело всё равно JSON и
 * читается из `e.postData.contents`.
 */

import { CONFIG } from './config.js';
import { MAX_GAME_SCORE, MAX_ROUND_SCORE, ROUNDS } from './scoring.js';

export const enabled = () => Boolean(CONFIG.LEADERBOARD_ENDPOINT);

/**
 * Сколько ждём ответа. Apps Script после простоя стартует медленно — первый
 * запрос за долгое время спокойно занимает десяток секунд, и девяти не
 * хватало: игра показывала «недоступно» там, где всё работало.
 */
const TIMEOUT_MS = 20000;

/**
 * Корни нецензурной лексики (рус./каз.) и типовые оскорбления.
 * Проверка грубая и намеренно консервативная: цель — не пустить откровенный
 * мат в публичную таблицу, а не построить идеальный фильтр. Тот же список
 * продублирован в apps-script.gs, потому что клиенту доверять нельзя.
 */
const PROFANITY = [
  'хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебал', 'ебан', 'ебуч', 'еблан',
  'бляд', 'блять', 'сука', 'мудак', 'мудил', 'гандон', 'пидор', 'пидар',
  'залуп', 'дроч', 'манда', 'ублюд', 'шлюх', 'нахуй', 'похуй',
  'котак', 'котақ', 'амжырт', 'амшелек', 'сiкт', 'сікт', 'енең', 'енен',
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'nigg', 'asshole', 'whore',
];

/** Ник: чистим управляющие символы, режем длину, глушим formula injection. */
export function sanitizeNick(raw) {
  let s = String(raw || '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20);
  // Google Sheets трактует ведущие = + - @ как формулу.
  s = s.replace(/^[=+\-@]+/, '');
  return s.trim();
}

/** Есть ли в нике мат. Сравнение по «свёрнутой» строке, чтобы обойти л33t. */
export function hasProfanity(nick) {
  // Порядок важен: цифры-подмены разворачиваем ДО того, как выкинуть
  // всё небуквенное, иначе «b1tch» терял бы единицу и проходил фильтр.
  const flat = String(nick || '')
    .toLowerCase()
    .replace(/0/g, 'o')
    .replace(/1/g, 'i')
    .replace(/3/g, 'e')
    .replace(/4/g, 'a')
    .replace(/5/g, 's')
    .replace(/@/g, 'a')
    .replace(/\$/g, 's')
    .replace(/[^a-zЀ-ӿ]/g, '');
  return PROFANITY.some((w) => flat.includes(w));
}

/** Клиентская проверка на невозможный результат. Не анти-чит, а гигиена. */
export function isPlausible(payload) {
  if (!Number.isInteger(payload.score)) return false;
  if (payload.score < 0 || payload.score > MAX_GAME_SCORE) return false;
  if (!Array.isArray(payload.rounds) || payload.rounds.length !== ROUNDS) return false;
  let sum = 0;
  for (const r of payload.rounds) {
    if (!Number.isInteger(r.points) || r.points < 0 || r.points > MAX_ROUND_SCORE) return false;
    sum += r.points;
  }
  return sum === payload.score;
}

/** fetch с таймаутом: висящий запрос хуже честной ошибки. */
async function withTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    // no-store обязателен: владелец чистит строки прямо в таблице, и
    // закэшированный браузером ответ показывал бы удалённые ники ещё сутки.
    return await fetch(url, { cache: 'no-store', ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Оба топа одного среза одним запросом.
 * @param {string} slice ключ среза, см. Game.sliceKey
 * @returns {Promise<{allTime: object[], today: object[], categories: object[]}>}
 */
export async function fetchBoards(slice = 'random|normal|family', limit = CONFIG.LEADERBOARD_PREVIEW_N) {
  if (!enabled()) return { allTime: [], today: [], global: [], categories: [] };
  const q = new URLSearchParams({
    action: 'top', slice, limit: String(limit),
    // Apps Script отдаёт ответы через кэширующий фронт Google; параметр
    // делает каждый запрос уникальным, и таблица читается всегда свежая.
    _: String(Date.now()),
  });
  const res = await withTimeout(`${CONFIG.LEADERBOARD_ENDPOINT}?${q}`, { method: 'GET' });
  if (!res.ok) throw new Error(`лидерборд HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.ok !== true) throw new Error('лидерборд: неожиданный ответ');
  return {
    allTime: Array.isArray(data.allTime) ? data.allTime : [],
    today: Array.isArray(data.today) ? data.today : [],
    // Общий зачёт: лучшие очки за всё время без деления на категории.
    // Старое развёртывание скрипта его не отдаёт — тогда просто пусто, и
    // третья таблица не показывается.
    global: Array.isArray(data.global) ? data.global : null,
    // Какие срезы вообще существуют — нужно для переключателя в оверлее.
    categories: Array.isArray(data.categories) ? data.categories : [],
  };
}

/**
 * Общий зачёт «все категории» для СТАРОГО развёртывания скрипта.
 *
 * Свежий скрипт считает его сам и отдаёт полем `global` в том же ответе —
 * это один запрос и правильные места. Пока в таблице лежит старая версия,
 * собираем то же самое на клиенте: просим топ каждой известной категории и
 * склеиваем. Запросов столько, сколько категорий, поэтому берём не больше
 * десяти самых населённых и делаем это только по требованию — когда человек
 * открыл вкладку «Все категории».
 *
 * @param {Array<{slice:string,count:number}>} categories
 */
export async function fetchGlobalFallback(categories = [], limit = 20) {
  if (!enabled() || categories.length === 0) return [];
  const top = categories.slice(0, 10);
  const lists = await Promise.all(top.map(async (c) => {
    try {
      const boards = await fetchBoards(c.slice, Math.min(limit, 25));
      return (boards.allTime || []).map((r) => ({ ...r, slice: c.slice }));
    } catch {
      return [];
    }
  }));
  return lists
    .flat()
    .sort((a, b) => b.score - a.score || (a.date < b.date ? -1 : 1))
    .slice(0, limit);
}

/**
 * @param {object} p
 * @param {string} p.nick     пустая строка = гость, имя присвоит сервер
 * @param {number} p.score
 * @param {Array<{level:number, step:number, points:number, solved:boolean}>} p.rounds
 * @param {string} p.slice
 * @param {string} p.sessionHash
 * @returns {Promise<{ok:true, nick:string, placeAllTime:number, placeToday:number}>}
 */
export async function submitScore(p) {
  if (!enabled()) throw new Error('лидерборд выключен');
  const nick = sanitizeNick(p.nick);
  const guest = nick.length === 0;
  if (!guest && nick.length < 2) throw new Error('nick-too-short');
  if (!guest && hasProfanity(nick)) throw new Error('nick-bad');

  const body = {
    action: 'submit',
    nick,
    guest,
    score: p.score,
    rounds: p.rounds,
    slice: p.slice,
    sessionHash: p.sessionHash,
    date: new Date().toISOString(),
    tzOffset: new Date().getTimezoneOffset(),
    v: 3,
  };
  if (!isPlausible(body)) throw new Error('implausible');

  const res = await withTimeout(CONFIG.LEADERBOARD_ENDPOINT, {
    method: 'POST',
    // text/plain → «простой» CORS-запрос, без preflight, который Apps Script не умеет
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`лидерборд HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.ok !== true) throw new Error(data?.error || 'лидерборд отказал');
  return data;
}

/* ------------------------------------------------------------------ */
/* Сохранённые таблицы                                                  */
/* ------------------------------------------------------------------ */

/**
 * Таблицы лежат в localStorage и показываются СРАЗУ, до всякой сети.
 *
 * Причина простая: Apps Script отвечает секундами, а иногда не отвечает вовсе.
 * Показать вчерашний топ мгновенно и обновить его в фоне честнее, чем держать
 * человека перед скелетом на каждой перезагрузке и на каждой смене категории.
 * Если обновить не удалось — на экране остаётся то, что было, без ругани:
 * таблица рекордов не та вещь, ради которой стоит показывать ошибку.
 */
function boardsStore() {
  try {
    return JSON.parse(localStorage.getItem(CONFIG.BOARDS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

/** @returns {{allTime:object[], today:object[], global:object[]|null, categories:object[], ts:number}|null} */
export function cachedBoards(slice) {
  const store = boardsStore();
  const own = store[slice];
  if (!own) return null;
  return { ...own, global: store.__global?.rows ?? null };
}

export function saveBoards(slice, boards) {
  try {
    const store = boardsStore();
    store[slice] = {
      allTime: boards.allTime || [],
      today: boards.today || [],
      categories: boards.categories || [],
      ts: Date.now(),
    };
    // Общий зачёт от категории не зависит — храним отдельно и не трогаем при
    // переключении жанров.
    if (Array.isArray(boards.global)) {
      store.__global = { rows: boards.global, ts: Date.now() };
    }
    // Больше десятка срезов держать незачем: выкидываем самые старые.
    const keys = Object.keys(store).filter((k) => k !== '__global');
    if (keys.length > 12) {
      keys.sort((a, b) => (store[a].ts || 0) - (store[b].ts || 0));
      for (const k of keys.slice(0, keys.length - 12)) delete store[k];
    }
    localStorage.setItem(CONFIG.BOARDS_KEY, JSON.stringify(store));
  } catch {
    /* приватный режим или переполнение — не повод ломать игру */
  }
}

/** Насколько стар сохранённый общий зачёт. */
export function globalAge() {
  const ts = boardsStore().__global?.ts || 0;
  return ts ? Date.now() - ts : Infinity;
}

/* ------------------------------------------------------------------ */
/* Имя игрока (блок H3)                                                */
/* ------------------------------------------------------------------ */

export function savedNick() {
  try {
    return sanitizeNick(localStorage.getItem(CONFIG.NICK_KEY) || '');
  } catch {
    return '';
  }
}

export function rememberNick(nick) {
  try {
    localStorage.setItem(CONFIG.NICK_KEY, sanitizeNick(nick));
  } catch {
    /* приватный режим */
  }
}
