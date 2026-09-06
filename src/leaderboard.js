/**
 * Лидерборды через Google Apps Script Web App.
 *
 * Два топа приходят одним запросом: «за всё время» и «сегодня».
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

/**
 * Оба топа одним запросом.
 * @returns {Promise<{allTime: object[], today: object[]}>}
 */
export async function fetchBoards(limit = CONFIG.LEADERBOARD_PREVIEW_N) {
  if (!enabled()) return { allTime: [], today: [] };
  const url = `${CONFIG.LEADERBOARD_ENDPOINT}?action=top&limit=${encodeURIComponent(limit)}`;
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`лидерборд HTTP ${res.status}`);
  const data = await res.json();
  if (!data || data.ok !== true) throw new Error('лидерборд: неожиданный ответ');
  return {
    allTime: Array.isArray(data.allTime) ? data.allTime : [],
    today: Array.isArray(data.today) ? data.today : [],
  };
}

/**
 * @param {object} p
 * @param {string} p.nick
 * @param {number} p.score
 * @param {Array<{level:number, step:number, points:number, solved:boolean}>} p.rounds
 * @param {string} p.sessionHash
 */
export async function submitScore(p) {
  if (!enabled()) throw new Error('лидерборд выключен');
  const nick = sanitizeNick(p.nick);
  if (nick.length < 2) throw new Error('nick-too-short');
  if (hasProfanity(nick)) throw new Error('nick-bad');

  const body = {
    action: 'submit',
    nick,
    score: p.score,
    rounds: p.rounds,
    sessionHash: p.sessionHash,
    date: new Date().toISOString(),
    tzOffset: new Date().getTimezoneOffset(),
    v: 2,
  };
  if (!isPlausible(body)) throw new Error('implausible');

  const res = await fetch(CONFIG.LEADERBOARD_ENDPOINT, {
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
