/**
 * Единственный файл конфигурации игры.
 * Всё, что владелец проекта может захотеть поменять, — здесь.
 */

export const CONFIG = {
  /**
   * URL Google Apps Script Web App для лидербордов.
   * ПУСТАЯ СТРОКА = лидерборды полностью выключены, игра работает как обычно
   * и не делает ни одного сетевого запроса к ним.
   * Как получить URL — см. SETUP.md.
   *
   * Пример: 'https://script.google.com/macros/s/AKfycb.../exec'
   */
  LEADERBOARD_ENDPOINT: '',

  /** Сколько строк показывать в компактной таблице на стартовом экране. */
  LEADERBOARD_PREVIEW_N: 7,

  /** Сколько строк отдавать в полноэкранном оверлее. */
  LEADERBOARD_FULL_N: 100,

  /** Язык по умолчанию. Сайт ВСЕГДА стартует на казахском. */
  DEFAULT_LOCALE: 'kk',
  LOCALES: ['kk', 'ru'],

  /** Путь к собранному каталогу (scripts/build-catalog.mjs). */
  CATALOG_URL: 'data/tracks.json',

  /** Сколько вариантов показывать в выпадающем списке поиска. */
  SEARCH_RESULTS: 8,

  /** Таймаут загрузки одного трека перед заменой на другой из того же тира. */
  TRACK_LOAD_TIMEOUT_MS: 12000,

  /** Ключи localStorage. */
  OFFSET_CACHE_KEY: 'tap-anda:offsets:v2',
  LOCALE_KEY: 'tap-anda:locale',
  LOCALE_SEEN_KEY: 'tap-anda:locale-hint-seen',

  /** Публичная ссылка на игру — подставляется в текст шеринга. */
  SHARE_URL: 'https://songless.zhengisbay.com',
};
