/**
 * Два языка: казахский (по умолчанию) и русский.
 *
 * Сайт ВСЕГДА стартует на казахском — язык системы не учитывается намеренно:
 * игра про казахскую музыку, и первый экран должен быть на казахском даже
 * у человека с русской системой. Русский включается только явным нажатием,
 * и после этого выбор запоминается.
 *
 * Язык интерфейса НЕ влияет на каталог: названия треков и имена артистов
 * не переводятся никогда.
 */

import { CONFIG } from './config.js';

let strings = {};
let current = CONFIG.DEFAULT_LOCALE;
const listeners = new Set();

/** Сохранённый выбор языка, если он был. */
export function savedLocale() {
  try {
    const v = localStorage.getItem(CONFIG.LOCALE_KEY);
    return CONFIG.LOCALES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

/** Видел ли пользователь подсказку про переключатель языка. */
export function localeHintSeen() {
  try {
    return localStorage.getItem(CONFIG.LOCALE_SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function markLocaleHintSeen() {
  try {
    localStorage.setItem(CONFIG.LOCALE_SEEN_KEY, '1');
  } catch {
    /* приватный режим */
  }
}

export function locale() {
  return current;
}

export function otherLocale() {
  return current === 'kk' ? 'ru' : 'kk';
}

/**
 * Язык из адреса: `?lang=ru`.
 *
 * Нужен для hreflang — поисковику необходим отдельный URL на каждую языковую
 * версию, а у одностраничной игры адрес один. Приоритет выше сохранённого
 * выбора: если человек пришёл по русской ссылке, он ждёт русский текст.
 */
export function urlLocale() {
  try {
    const v = new URLSearchParams(location.search).get('lang');
    return CONFIG.LOCALES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

export async function loadStrings(
  loc = urlLocale() || savedLocale() || CONFIG.DEFAULT_LOCALE
) {
  const res = await fetch(`i18n/${loc}.json`);
  if (!res.ok) throw new Error(`i18n: не удалось загрузить ${loc}.json`);
  strings = await res.json();
  current = loc;
  document.documentElement.lang = loc;
  return strings;
}

/** Смена языка на лету: перечитывает файл и уведомляет подписчиков. */
export async function setLocale(loc) {
  if (!CONFIG.LOCALES.includes(loc) || loc === current) return;
  await loadStrings(loc);
  try {
    localStorage.setItem(CONFIG.LOCALE_KEY, loc);
  } catch {
    /* приватный режим */
  }
  for (const fn of listeners) fn(loc);
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * t('round.step', { n: 3 }) -> 'Қадам 3 / 7'
 * Отсутствующий ключ возвращается как есть — так пропуск виден в UI,
 * а не превращается молча в пустоту.
 */
export function t(key, params) {
  let s = strings[key];
  if (s === undefined) return key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.replaceAll(`{${k}}`, String(v));
    }
  }
  return s;
}

/** Короткий код текущего/другого языка для кнопки-переключателя. */
export function localeShort(loc = current) {
  return loc === 'kk' ? 'KK' : 'RU';
}

/** Название уровня сложности 1..5. */
export function levelName(level) {
  return t(`level.${level}`);
}

/** Название жанрового тега. */
export function genreName(tag) {
  return t(`genre.${tag}`);
}
