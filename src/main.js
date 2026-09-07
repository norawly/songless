/**
 * Контроллер и экраны. Игра линейна, состояние держит Game, здесь — рендер
 * и обработка ввода.
 *
 * Итерация 3: только десктоп, только тёмная тема, ни один экран не скроллится.
 * Композиция собрана по сетке из DESIGN_BRIEF §«Сетка»: 12 колонок, отступы
 * только из шкалы 4/8/12/16/24/32/48/64.
 */

import { CONFIG } from './config.js';
import {
  loadStrings, t, levelName, genreName, locale, setLocale,
  onLocaleChange, localeHintSeen, markLocaleHintSeen, savedLocale, otherLocale,
  localeShort,
} from './i18n.js';
import { loadCatalog, streamingLinks } from './catalog.js';
import { AudioEngine } from './audio.js';
import { Pulse } from './pulse.js';
import { Ambient, ambientAllowed, rememberAmbient } from './ambient.js';
import { extractPalette } from './palette.js';
import { moodFor, applyFilter } from './mood.js';
import { watchViewportHeight } from './fit.js';
import { Game, SCREEN, STEP_STATE } from './game.js';
import {
  ROUNDS, MODES, verdictIndex, stepDuration, stepCount,
} from './scoring.js';
import { buildShareText, buildGrid, copyText, canShareNatively, shareNatively } from './share.js';
import * as LB from './leaderboard.js';
import {
  $, $$, esc, sheet, closeSheet, toast, animateCount,
  reduceMotion, formatStepDuration, fmtNum, fmtSeconds,
} from './ui.js';

const app = () => document.getElementById('screen');

let catalog = null;
let game = null;
const audio = new AudioEngine();
const ambient = new Ambient(audio);
let pulse = null;

/** Отправляли ли уже результат этой партии — клиентский rate-limit. */
let submittedThisGame = false;
/** Проигрывание фрагмента идёт прямо сейчас. */
let playing = false;
/** Таймер окончания фрагмента и токен текущей разметки раунда. */
let finishTimer = null;
let roundToken = 0;
/** Кэш загруженных топов, чтобы не дёргать сеть на каждую перерисовку. */
let boardsCache = null;
let boardsSlice = null;
/** Строк в компактной таблице на телефоне: экран не прокручивается. */
const MOBILE_BOARD_ROWS = 3;
/** Перехват «уходишь без имени» показывается ровно один раз за сессию. */
let signPromptShown = false;
/**
 * Счётчик перерисовок экрана. Извлечение палитры асинхронно и может
 * завершиться уже после того, как игрок ушёл дальше, — тогда фон окрасился бы
 * на экране, который должен быть нейтральным. Токен отсекает такие ответы.
 */
let paintToken = 0;

/**
 * Автофокус в поле ответа — только там, где есть мышь.
 * На телефоне фокус открывает клавиатуру поверх пол-экрана, и делать это
 * без явного тапа игрока нельзя (блок D4).
 */
const canAutofocus = () => window.matchMedia('(pointer: fine)').matches;

/**
 * Телефон — не «узкий десктоп», а другая подача: другая шапка, настройки в
 * шторке вместо панели, меньше слоёв на экране. Поэтому разметка местами
 * своя, и одного CSS тут не хватает.
 */
const MOBILE_QUERY = '(max-width: 760px)';
const mobile = () => window.matchMedia(MOBILE_QUERY).matches;

/* ================================================================== */
/* Установка на домашний экран                                         */
/* ================================================================== */

/**
 * Событие Chrome, которым браузер разрешает предложить установку.
 * Ловим его до первой отрисовки шапки, поэтому слушатель стоит на модуле, а
 * не внутри функции: браузер стреляет им один раз и очень рано.
 */
let installPrompt = null;

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIOS = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  syncInstallButton();
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  syncInstallButton();
});

/**
 * Кнопка показывается, только если установка реально возможна: Chrome дал
 * событие, либо это iOS, где такого события нет вовсе и человеку нужно
 * показать, куда нажимать. Уже установленное приложение кнопку не показывает.
 */
function syncInstallButton() {
  const btn = document.querySelector('[data-install]');
  if (!btn) return;
  btn.hidden = standalone() || (!installPrompt && !isIOS());
}

function showInstall() {
  // На Android отдаём управление системному диалогу — он честнее любого
  // нашего объяснения.
  if (installPrompt) {
    installPrompt.prompt();
    installPrompt.userChoice?.finally?.(() => {
      installPrompt = null;
      syncInstallButton();
    });
    return;
  }
  sheet({
    title: t('install.title'),
    bodyHtml: `<p>${esc(isIOS() ? t('install.ios') : t('install.android'))}</p>
      <div class="sheet__actions">
        <button class="btn btn--primary" data-close type="button" data-autofocus>${esc(t('nav.close'))}</button>
      </div>`,
  });
}

/**
 * Оболочка игры работает офлайн — см. sw.js. Регистрируем после загрузки,
 * чтобы не конкурировать за сеть с каталогом и первым треком.
 */
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// и http на чужом хосте service worker не принимает — молча выходим.
  if (location.protocol !== 'https:' && location.hostname !== 'localhost') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

/* ================================================================== */
/* Загрузка                                                            */
/* ================================================================== */

async function boot() {
  watchViewportHeight();
  registerServiceWorker();
  pulse = new Pulse(document.getElementById('song-bg'));
  wireFirstGesture();

  try {
    await loadStrings();
  } catch {
    app().innerHTML = '<p style="padding:2rem">Не удалось загрузить локализацию.</p>';
    return;
  }

  renderChrome();

  try {
    catalog = await loadCatalog();
  } catch (err) {
    console.error(err);
    renderCatalogError();
    return;
  }

  game = new Game(catalog);
  restoreMode();
  game.onChange(render);

  // Смена языка перерисовывает и шапку, и текущий экран.
  onLocaleChange(() => {
    renderChrome();
    render();
  });

  render();
}

/**
 * Свечение фона живёт всё время, пока что-то звучит, и питается общим
 * анализатором. Вызывается после каждого запуска звука: полосы калибруются
 * заново под новую музыку.
 */
function liveBg(mode = 'glow') {
  pulse.setMode(mode);
  pulse.show();
  pulse.start(audio.analyser);
}

/**
 * Фоновая музыка стартового экрана.
 *
 * Браузер не даст завести звук до первого жеста — поэтому ждём любой клик или
 * клавишу и только тогда заводим. Один раз: дальше состоянием управляет
 * кнопка звука в шапке.
 */
function wireFirstGesture() {
  const go = () => {
    document.removeEventListener('pointerdown', go);
    document.removeEventListener('keydown', go);
    audio.ensureContext();
    liveBg();
    if (ambientAllowed() && game && game.screen === SCREEN.START) ambient.start();
  };
  document.addEventListener('pointerdown', go, { once: false });
  document.addEventListener('keydown', go, { once: false });
}

/** Фон играет только на стартовом экране — в партии звучит сама игра. */
function syncAmbient() {
  if (!game) return;
  if (game.screen === SCREEN.START && ambientAllowed()) {
    if (audio.ctx) ambient.start();
  } else {
    ambient.stop();
  }
  const btn = document.querySelector('[data-sound]');
  if (btn) btn.setAttribute('aria-pressed', String(ambientAllowed()));
}

/** Режим подачи запоминается между партиями — это выбор, а не настройка. */
function restoreMode() {
  try {
    const saved = localStorage.getItem(CONFIG.MODE_KEY);
    if (saved && MODES[saved]) game.filters.difficulty = saved;
  } catch {
    /* приватный режим */
  }
}

function rememberMode(id) {
  try {
    localStorage.setItem(CONFIG.MODE_KEY, id);
  } catch {
    /* приватный режим */
  }
}

/* ================================================================== */
/* Шапка                                                               */
/* ================================================================== */

function renderChrome() {
  const header = document.getElementById('chrome-head');
  const showHint = !localeHintSeen() && locale() === 'kk';

  // На телефоне в шапке остаётся только самое нужное: имя, язык и «Ещё».
  // Звук, громкость, правила и установка уехали в шторку — шесть контролов
  // в строке шириной 360 px читались как панель приборов, а не как шапка.
  const nav = mobile()
    ? `
      <nav class="chrome__nav">
        ${langMarkup(showHint)}
        <button class="btn btn--icon" data-menu type="button"
                aria-label="${esc(t('nav.menu'))}" title="${esc(t('nav.menu'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.9" fill="currentColor"/><circle cx="12" cy="12" r="1.9" fill="currentColor"/><circle cx="19" cy="12" r="1.9" fill="currentColor"/></svg>
        </button>
      </nav>`
    : `
      <nav class="chrome__nav">
        <button class="btn btn--icon" data-about type="button"
                aria-label="${esc(t('nav.about'))}" title="${esc(t('nav.about'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v6M12 7.6v.01" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        <button class="btn btn--icon" data-rules type="button"
                aria-label="${esc(t('nav.rules'))}" title="${esc(t('nav.rules'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v.01M12 14c0-2 2.5-2.2 2.5-4.3A2.6 2.6 0 0 0 12 7a2.6 2.6 0 0 0-2.5 2.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
        </button>
        <button class="btn btn--icon" data-install type="button" hidden
                aria-label="${esc(t('nav.install'))}" title="${esc(t('nav.install'))}">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0l-4-4m4 4l4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        ${soundMarkup()}
        ${langMarkup(showHint)}
      </nav>`;

  header.innerHTML = `
    <button class="brand" data-home type="button" title="${esc(t('app.title'))}">
      <span class="brand__mark" aria-hidden="true"></span>
      <span class="brand__name">${esc(t('app.title'))}</span>
    </button>

    <div class="chrome__rail" id="level-rail" hidden></div>
    ${nav}`;

  header.addEventListener('click', onChromeClick);
  wireVolume(header);
  syncInstallButton();
}

/** Кнопка фоновой музыки и общая громкость — один блок в шапке и в шторке. */
function soundMarkup() {
  return `
    <div class="sound" role="group" aria-label="${esc(t('nav.volume'))}">
      <button class="btn btn--icon" data-sound type="button"
              aria-pressed="${ambientAllowed()}"
              aria-label="${esc(t('nav.sound'))}" title="${esc(t('nav.sound'))}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.4L12 5.5v13l-4.6-4H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path class="sound__waves" d="M16 9.2a4 4 0 0 1 0 5.6M18.6 6.6a7.6 7.6 0 0 1 0 10.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path class="sound__off" d="M16 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <input class="sound__range" type="range" min="0" max="100" step="1"
             value="${Math.round(audio.volume * 100)}" data-volume
             aria-label="${esc(t('nav.volume'))}" title="${esc(t('nav.volume'))}">
    </div>`;
}

function langMarkup(showHint) {
  return `
    <div class="lang-wrap">
      <div class="lang" role="group" aria-label="${esc(t('nav.language'))}">
        <button class="lang__btn" data-locale="kk" type="button"
                aria-pressed="${locale() === 'kk'}">KK</button>
        <button class="lang__btn" data-locale="ru" type="button"
                aria-pressed="${locale() === 'ru'}">RU</button>
      </div>
      ${showHint
        // Подсказка всегда по-русски: она адресована именно тем, кто не
        // читает по-казахски и иначе не поймёт, куда нажимать.
        ? `<span class="lang__hint" aria-hidden="true">↑ Русский</span>` : ''}
    </div>`;
}

/** Ползунок громкости живёт и в шапке, и в шторке — вешаем на оба. */
function wireVolume(root) {
  root.querySelector('[data-volume]')?.addEventListener('input', (e) => {
    audio.setVolume(Number(e.target.value) / 100);
  });
}

/**
 * Шторка «Ещё» — всё, что на телефоне не влезло в шапку.
 * Один список, крупные строки: это меню, а не панель управления.
 */
function showMenu() {
  const panel = sheet({
    title: t('nav.menu'),
    bodyHtml: `
      <div class="menu">
        <div class="menu__sound">
          <span class="field__label">${esc(t('menu.sound'))}</span>
          ${soundMarkup()}
        </div>
        <button class="menu__item" data-rules type="button">${esc(t('nav.rules'))}</button>
        <button class="menu__item" data-about type="button">${esc(t('nav.about'))}</button>
        <button class="menu__item" data-install type="button" hidden>${esc(t('nav.install'))}</button>
      </div>`,
    onMount(p) {
      wireVolume(p);
      const install = p.querySelector('[data-install]');
      if (install) install.hidden = standalone() || (!installPrompt && !isIOS());
      p.addEventListener('click', (e) => {
        const sound = e.target.closest('[data-sound]');
        if (sound) return toggleAmbient(sound);
        if (e.target.closest('[data-rules]')) return showRules();
        if (e.target.closest('[data-about]')) return showAbout();
        if (e.target.closest('[data-install]')) return showInstall();
      });
    },
  });
  return panel;
}

/** Фоновая музыка — вкус, а не настройка звука игры: выбор запоминается. */
function toggleAmbient(btn) {
  const on = !ambientAllowed();
  rememberAmbient(on);
  for (const b of $$('[data-sound]')) b.setAttribute('aria-pressed', String(on));
  if (on) {
    audio.ensureContext();
    liveBg();
    if (game?.screen === SCREEN.START) ambient.start();
  } else ambient.stop(0.4);
}

function onChromeClick(e) {
  const langBtn = e.target.closest('[data-locale]');
  if (langBtn) {
    markLocaleHintSeen();
    setLocale(langBtn.dataset.locale);
    return;
  }
  const sound = e.target.closest('[data-sound]');
  if (sound) return toggleAmbient(sound);
  if (e.target.closest('[data-menu]')) return showMenu();
  if (e.target.closest('[data-install]')) return showInstall();
  if (e.target.closest('[data-rules]')) return showRules();
  if (e.target.closest('[data-about]')) return showAbout();
  if (e.target.closest('[data-home]')) return goHome();
}

/** Клик по логотипу во время партии обязан спросить подтверждение. */
function goHome() {
  if (!game) return;
  if (!game.inProgress) {
    resetToStart();
    return;
  }
  sheet({
    title: t('exit.title'),
    bodyHtml: `
      <p>${esc(t('exit.body'))}</p>
      <div class="sheet__actions">
        <button class="btn btn--primary" data-exit-yes type="button">${esc(t('exit.confirm'))}</button>
        <button class="btn btn--ghost" data-close type="button" data-autofocus>${esc(t('exit.cancel'))}</button>
      </div>`,
    onMount(panel) {
      panel.querySelector('[data-exit-yes]').addEventListener('click', () => {
        closeSheet();
        resetToStart();
      });
    },
  });
}

function resetToStart() {
  audio.stop(160);
  submittedThisGame = false;
  game.reset();
  render();
}

/* ================================================================== */
/* Роутер                                                              */
/* ================================================================== */

function render() {
  const rail = document.getElementById('level-rail');
  const inGame = game.screen === SCREEN.ROUND || game.screen === SCREEN.REVEAL;
  if (rail) {
    rail.hidden = !inGame;
    if (inGame) renderLevelRail(rail);
  }
  // Логотип убран только с финального экрана — так требует задание.
  document.getElementById('chrome-head')
    .dataset.hideBrand = game.screen === SCREEN.FINAL ? '1' : '0';

  paintToken++; // всё, что красило фон для прошлого экрана, теперь недействительно
  syncAmbient();

  switch (game.screen) {
    case SCREEN.START: renderStart(); break;
    case SCREEN.LOADING: renderLoading(); break;
    case SCREEN.ROUND: renderRound(); break;
    case SCREEN.REVEAL: renderReveal(); break;
    case SCREEN.FINAL: renderFinal(); break;
    case SCREEN.ERROR: renderRuntimeError(); break;
  }
}

function renderLevelRail(rail) {
  rail.setAttribute('role', 'group');
  rail.setAttribute('aria-label', t('a11y.levelRail', {
    n: game.roundIndex + 1, level: levelName(game.roundIndex + 1),
  }));
  // Пять полосок без подписи читались как непонятный декор — теперь рядом
  // прямо написано, какой это уровень.
  const segs = Array.from({ length: ROUNDS }, (_, i) => {
    const state = i < game.roundIndex ? 'done' : i === game.roundIndex ? 'now' : 'todo';
    return `<span class="rail__seg" data-state="${state}"><i></i></span>`;
  }).join('');
  rail.innerHTML =
    `<span class="rail__label">${esc(t('round.levelOf', { n: game.roundIndex + 1 }))}</span>
     <span class="rail__segs">${segs}</span>`;
}

/* ================================================================== */
/* Экран: старт                                                        */
/* ================================================================== */

function renderStart() {
  audio.stop(200);
  pulse.setMode('glow');

  const av = game.availability;

  const hero = `
    <div class="start__main">
      <div class="hero">
        <p class="eyebrow">${esc(t('app.subtitle'))}</p>
        <h1 class="hero__title">${esc(t('app.title'))}</h1>
        <p class="hero__tagline">${esc(t('app.tagline'))}</p>
      </div>

      <div class="start__cta">
        <button class="btn btn--primary btn--xl" data-start type="button"
                ${av.ok ? '' : 'disabled'}>${esc(t('start.play'))}</button>
        ${av.ok
          ? `<span class="start__meta">${esc(t('start.catalogCount', {
              count: fmtNum(av.total), artists: av.artists,
            }))}</span>`
          : `<span class="start__warn">${esc(t('start.notEnough'))}</span>`}
      </div>
    </div>`;

  // На телефоне вместо панели настроек — одна строка с текущим выбором.
  // Панель с тремя полями, подписями и десятью чипами занимала весь экран и
  // спорила с кнопкой «Играть», хотя меняют её раз в несколько партий.
  app().innerHTML = mobile()
    ? `
    <section class="screen screen--start">
      ${hero}
      <div class="start__foot">
        <button class="setup-line" data-settings type="button">
          <span class="setup-line__label">${esc(t('start.settings'))}</span>
          <span class="setup-line__value">${esc(setupSummary())}</span>
          <svg class="setup-line__chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        ${LB.enabled() ? boardMarkup('allTime', t('start.records'), MOBILE_BOARD_ROWS) : ''}
      </div>
    </section>`
    : `
    <section class="screen screen--start">
      ${hero}
      <div class="start__setup panel">${settingsFieldsMarkup()}</div>
      <aside class="start__side">
        ${LB.enabled()
          ? boardMarkup('allTime', t('lb.allTime')) + boardMarkup('today', t('lb.today'))
          : howToMarkup()}
      </aside>
    </section>`;

  wireStart();
  if (LB.enabled()) loadBoards();
}

/** Текущий выбор одной строкой: «Обычный · Family · Всё вперемешку». */
function setupSummary() {
  const genres = game.isRandom
    ? t('start.random')
    : game.filters.genres.map((g) => genreName(g)).join(', ');
  return [
    t(`difficulty.${game.filters.difficulty}`),
    t(`age.${game.filters.age}`),
    genres,
  ].join(' · ');
}

/** Три поля настроек. Одна разметка на панель десктопа и на шторку телефона. */
function settingsFieldsMarkup() {
  const genres = catalog.availableGenres();
  return `
    <div class="field">
      <span class="field__label" id="lbl-diff">${esc(t('start.difficulty'))}</span>
      <div class="seg" role="group" aria-labelledby="lbl-diff">
        ${['normal', 'expert'].map((id) => `
          <button class="seg__btn" data-diff="${id}" type="button"
                  aria-pressed="${game.filters.difficulty === id}"
                  title="${esc(t(`difficulty.${id}Hint`))}">${esc(t(`difficulty.${id}`))}</button>
        `).join('')}
      </div>
      <span class="field__hint">${esc(t(`difficulty.${game.filters.difficulty}Hint`))}</span>
    </div>

    <div class="field">
      <span class="field__label" id="lbl-age">${esc(t('start.audience'))}</span>
      <div class="seg" role="group" aria-labelledby="lbl-age">
        ${['family', '18plus', 'both'].map((id) => `
          <button class="seg__btn" data-age="${id}" type="button"
                  aria-pressed="${game.filters.age === id}"
                  title="${esc(t(`age.${id}Hint`))}">${esc(t(`age.${id}`))}</button>
        `).join('')}
      </div>
      <span class="field__hint">${esc(t(`age.${game.filters.age}Hint`))}</span>
    </div>

    <div class="field field--wide">
      <span class="field__label" id="lbl-genre">${esc(t('start.genres'))}</span>
      <div class="chips" role="group" aria-labelledby="lbl-genre">
        <button class="chip chip--random" data-random type="button"
                aria-pressed="${game.isRandom}"
                title="${esc(t('start.randomHint'))}">${esc(t('start.random'))}</button>
        ${genres.map((g) => `
          <button class="chip" data-genre="${esc(g)}" type="button"
                  aria-pressed="${game.filters.genres.includes(g)}">${esc(genreName(g))}</button>
        `).join('')}
      </div>
    </div>`;
}

/** Настройки на телефоне живут в шторке и обновляются на месте. */
function showSettings() {
  sheet({
    title: t('start.settings'),
    bodyHtml: `<div class="settings-sheet">${settingsFieldsMarkup()}</div>`,
    onMount(panel) {
      panel.addEventListener('click', (e) => {
        if (!handleFilterClick(e)) return;
        // Экран под шторкой перерисовался сам (game.onChange), а её
        // содержимое нужно обновить здесь: иначе нажатая кнопка не выглядит
        // нажатой.
        const box = panel.querySelector('.settings-sheet');
        if (box) box.innerHTML = settingsFieldsMarkup();
      });
    },
  });
}

/**
 * Клик по фильтру. Общий для панели десктопа и шторки телефона.
 * @returns {boolean} был ли клик по фильтру
 */
function handleFilterClick(e) {
  const diff = e.target.closest('[data-diff]');
  if (diff) {
    rememberMode(diff.dataset.diff);
    game.setDifficulty(diff.dataset.diff);
    return true;
  }
  const age = e.target.closest('[data-age]');
  if (age) {
    game.setAge(age.dataset.age);
    return true;
  }
  if (e.target.closest('[data-random]')) {
    game.resetGenres();
    return true;
  }
  const g = e.target.closest('[data-genre]');
  if (g) {
    game.toggleGenre(g.dataset.genre);
    return true;
  }
  return false;
}

/**
 * Правая колонка, когда лидерборды выключены.
 *
 * Пустая правая зона — ровно та композиционная дыра, из-за которой стартовый
 * экран переделывался. Пока таблицы нет, её место занимает короткое «как это
 * работает»: три шага, никакой рекламы.
 */
function howToMarkup() {
  return `
    <section class="howto">
      <h2 class="board__title as-heading">${esc(t('nav.about'))}</h2>
      <ol class="howto__list">
        <li><b>1</b><span>${esc(t('about.p1'))}</span></li>
        <li><b>2</b><span>${esc(t('rules.body3'))}</span></li>
        <li><b>3</b><span>${esc(t('rules.body5'))}</span></li>
      </ol>
      <p class="howto__legal">${esc(t('legal.note'))}</p>
    </section>`;
}

/**
 * Компактная таблица на стартовом экране.
 *
 * Под заголовком стоит подпись среза: таблица считается по срезам, и без неё
 * непонятно, чей это топ — «всё вперемешку в обычном режиме» или «рэп 18+
 * в экспертном». Пока данные едут, показываем скелет строк, а не слово
 * «загружаем»: список не прыгает, когда они приедут.
 */
function boardMarkup(kind, title, rows = CONFIG.LEADERBOARD_PREVIEW_N) {
  const label = sliceLabel(game.sliceKey);
  return `
    <section class="board board--${kind === 'today' ? 'today' : 'all'}">
      <div class="board__head">
        <button class="board__title" data-open-board="${kind}" type="button">${esc(title)}</button>
        <button class="board__more" data-open-board="${kind}" type="button">${esc(t('lb.openFull'))} →</button>
      </div>
      <p class="board__slice">${esc(label.full)}</p>
      <div class="board__body" data-board="${kind}">${skeletonRows(rows)}</div>
    </section>`;
}

function skeletonRows(n) {
  return `<div class="lb-skeleton" aria-hidden="true">${
    Array.from({ length: n }, (_, i) => `<i style="--i:${i}"></i>`).join('')
  }</div>`;
}

function wireStart() {
  const screen = $('.screen--start');

  screen.addEventListener('click', (e) => {
    if (handleFilterClick(e)) return;

    if (e.target.closest('[data-settings]')) return showSettings();

    const board = e.target.closest('[data-open-board]');
    if (board) return showFullBoard(board.dataset.openBoard);

    if (e.target.closest('[data-start]')) return startGame();
  });
}

/* ------------------------------------------------------------------ */
/* Лидерборды                                                          */
/* ------------------------------------------------------------------ */

async function loadBoards() {
  const boxes = $$('[data-board]');
  if (!boxes.length) return;
  const slice = game.sliceKey;
  const limit = mobile() ? MOBILE_BOARD_ROWS : CONFIG.LEADERBOARD_PREVIEW_N;
  try {
    boardsCache = await LB.fetchBoards(slice, limit);
    boardsSlice = slice;
    // Экран мог смениться, пока шёл запрос: Apps Script отвечает секундами.
    if (!$('[data-board]')) return;
    paintBoard('allTime');
    paintBoard('today');
  } catch (err) {
    console.warn('leaderboard:', err);
    // Лидерборд необязателен: показываем честное состояние, игру не трогаем.
    for (const box of $$('[data-board]')) {
      box.innerHTML = `<p class="muted">${esc(t('lb.offline'))}</p>
        <button class="btn btn--ghost btn--sm" data-retry-board type="button">${esc(t('lb.retry'))}</button>`;
    }
    $('[data-retry-board]')?.addEventListener('click', () => {
      for (const box of $$('[data-board]')) box.innerHTML = skeletonRows(3);
      loadBoards();
    });
  }
}

function paintBoard(kind, highlight = null) {
  const host = $(`[data-board="${kind}"]`);
  if (!host || !boardsCache) return;
  const rows = boardsCache[kind] || [];
  host.innerHTML = rows.length
    ? leaderboardTable(rows, highlight)
    : `<p class="muted">${esc(kind === 'today' ? t('lb.emptyToday') : t('lb.empty'))}</p>`;
}

function leaderboardTable(rows, highlightNick = null, { head = false } = {}) {
  return `
    <table class="lb">
      ${head ? `<thead><tr>
        <th scope="col" class="lb__rank">${esc(t('lb.place'))}</th>
        <th scope="col">${esc(t('lb.player'))}</th>
        <th scope="col" class="num">${esc(t('lb.score'))}</th>
      </tr></thead>` : ''}
      <tbody>${rows.map((r, i) => {
        const me = highlightNick && r.nick === highlightNick;
        return `
        <tr${me ? ' class="is-me"' : ''} data-rank="${i + 1}">
          <td class="lb__rank">${i + 1}</td>
          <td class="lb__nick">${esc(r.nick)}${me ? ` <span class="lb__you">${esc(t('lb.you'))}</span>` : ''}</td>
          <td class="num">${fmtNum(Number(r.score || 0))}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
}

/**
 * Человекочитаемое имя среза. Возраст возвращается отдельным полем: в
 * лидерборде он обязателен (иначе «рэп 18+» и «рэп Family» выглядят одной и
 * той же строкой в списке категорий), а в тексте шеринга его нет — там по
 * заданию только режим и категория.
 */
function sliceLabel(slice) {
  const [cat, diff, age] = slice.split('|');
  const category = cat === 'random'
    ? t('lb.sliceRandom')
    : cat.slice(2).split('+').map((g) => genreName(g)).join(' + ');
  const ageId = age === '18plus' || age === 'both' ? age : 'family';
  return {
    category,
    mode: t(`difficulty.${diff === 'expert' ? 'expert' : 'normal'}`),
    age: t(`age.${ageId}`),
    full: `${category} · ${t(`difficulty.${diff === 'expert' ? 'expert' : 'normal'}`)} · ${t(`age.${ageId}`)}`,
  };
}

/**
 * Полноэкранный список. Здесь скроллинг разрешён — прямо по заданию.
 * Переключатели: период (за всё время / сегодня) и категория (срез).
 */
async function showFullBoard(kind = 'allTime', slice = game.sliceKey, highlight = null) {
  const label = sliceLabel(slice);
  const panel = sheet({
    title: t('lb.title'),
    wide: true,
    bodyHtml: `
      <div class="lb-controls">
        <div class="field">
          <span class="field__label" id="lbl-period">${esc(t('lb.period'))}</span>
          <div class="seg" role="group" aria-labelledby="lbl-period">
            <button class="seg__btn" data-period="allTime" type="button"
                    aria-pressed="${kind === 'allTime'}">${esc(t('lb.allTime'))}</button>
            <button class="seg__btn" data-period="today" type="button"
                    aria-pressed="${kind === 'today'}">${esc(t('lb.today'))}</button>
          </div>
        </div>
        <label class="field lb-controls__cat">
          <span class="field__label">${esc(t('lb.category'))}</span>
          <select class="input" data-slice></select>
        </label>
      </div>
      <div class="lb-full" data-full>${skeletonRows(8)}</div>`,
  });

  const body = panel.querySelector('[data-full]');
  const select = panel.querySelector('[data-slice]');
  let period = kind;
  let current = slice;

  const fillSelect = (categories) => {
    const known = new Map();
    known.set(current, label.full);
    for (const c of categories) {
      known.set(c.slice, `${sliceLabel(c.slice).full} (${c.count})`);
    }
    select.innerHTML = [...known.entries()]
      .map(([k, v]) => `<option value="${esc(k)}"${k === current ? ' selected' : ''}>${esc(v)}</option>`)
      .join('');
  };

  const paintRows = (rows) => {
    body.innerHTML = rows.length
      ? leaderboardTable(rows, highlight, { head: true })
      : `<p class="muted">${esc(period === 'today' ? t('lb.emptyToday') : t('lb.empty'))}</p>`;
    // Своя строка может быть далеко внизу — подводим к ней сразу.
    body.querySelector('tr.is-me')?.scrollIntoView({ block: 'center' });
  };

  // Топ этого среза уже загружен для стартового экрана — показываем сразу,
  // не заставляя человека смотреть на «загружаем» лишние три секунды.
  if (boardsCache && boardsSlice === current) {
    fillSelect(boardsCache.categories || []);
    paintRows(boardsCache[period] || []);
  }

  const paint = async () => {
    if (!body.querySelector('.lb')) body.innerHTML = skeletonRows(8);
    try {
      const boards = await LB.fetchBoards(current, CONFIG.LEADERBOARD_FULL_N);
      if (!body.isConnected) return;
      fillSelect(boards.categories);
      paintRows(boards[period] || []);
    } catch {
      if (!body.isConnected) return;
      if (!body.querySelector('.lb')) {
        body.innerHTML = `<p class="muted">${esc(t('lb.offline'))}</p>`;
      }
    }
  };

  panel.addEventListener('click', (e) => {
    const p = e.target.closest('[data-period]');
    if (!p) return;
    period = p.dataset.period;
    $$('[data-period]', panel).forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.period === period)));
    paint();
  });
  select.addEventListener('change', () => {
    current = select.value;
    paint();
  });

  paint();
}

/* ================================================================== */
/* Старт партии: предзагрузка всех треков                               */
/* ================================================================== */

async function startGame() {
  // Контекст создаётся внутри жеста пользователя — иначе автоплей заблокирован.
  audio.ensureContext();

  let picked;
  let spares;
  let recycled;
  try {
    ({ picked, spares, recycled } = game.prepare());
  } catch (err) {
    game.fail(err.message);
    return;
  }

  const { tracks, replaced } = await audio.preloadGame(
    picked, spares, (done, total) => game.setLoadProgress(done, total)
  );

  const missing = tracks.filter((tr) => !audio.isReady(tr.id));
  let note = null;
  if (replaced > 0 || missing.length) note = t('error.loadFailed');
  else if (recycled?.length) note = t('start.recycled', { levels: recycled.join(', ') });

  // Обложки тянем заранее, пока идёт раунд. Иначе первая же карточка ответа
  // ждёт 600×600 JPEG: на телефоне это полсекунды загрузки и декодирования
  // ровно в момент показа, и экран выглядит зависшим.
  warmCovers(tracks);

  // Партия стартует только когда все треки реально готовы.
  game.begin(tracks, note);
}

/** Заранее прогревает обложки партии: сеть и декодирование — не в момент показа. */
function warmCovers(tracks) {
  for (const track of tracks) {
    if (!track.art) continue;
    const img = new Image();
    img.decoding = 'async';
    // Тот же режим, что у картинок на экране: иначе браузер сходит за файлом
    // второй раз, а палитре достанется «испорченный» canvas.
    img.crossOrigin = 'anonymous';
    img.src = track.art;
  }
}

function renderLoading() {
  const { done, total } = game.loadProgress;
  const pct = total ? Math.round((done / total) * 100) : 0;
  app().innerHTML = `
    <section class="screen screen--loading">
      <p class="eyebrow">${esc(t('start.preparing'))}</p>
      <h1 class="loading__title">${esc(t('app.title'))}</h1>
      <div class="loading__bar" role="progressbar" aria-label="${esc(t('a11y.progress'))}"
           aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${total}">
        <i style="width:${pct}%"></i>
      </div>
      <p class="loading__count">${esc(t('start.preparingCount', { done, total }))}</p>
    </section>`;
}

/* ================================================================== */
/* Экран: раунд                                                        */
/* ================================================================== */

function renderRound() {
  // Песня загадана: фон обязан быть нейтральным, цвет обложки был бы подсказкой.
  pulse.setMode('glow');
  const n = game.roundIndex + 1;
  const total = game.stepsTotal;

  app().innerHTML = `
    <section class="screen screen--round">
      <div class="round__top">
        <div class="round__head">
          <p class="eyebrow">${esc(t('round.label', { n }))}</p>
          <h1 class="round__level">${esc(levelName(n))}</h1>
        </div>
        <div class="round__score">
          <span class="eyebrow">${esc(t('round.score'))}</span>
          <b data-total-score>${fmtNum(game.totalScore)}</b>
        </div>
      </div>

      <div class="player">
        <button class="play" data-play type="button" aria-label="${esc(
          t('a11y.play', { seconds: formatStepDuration(game.stepMs) })
        )}">
          <span class="play__icon" aria-hidden="true"></span>
          <svg class="play__ring" viewBox="0 0 100 100" aria-hidden="true">
            <circle class="play__ring-bg" cx="50" cy="50" r="47"/>
            <circle class="play__ring-fg" cx="50" cy="50" r="47" data-ring/>
          </svg>
        </button>
        <p class="player__caption">
          <span class="player__label" data-play-label>${esc(t('round.play'))}</span>
          <span class="player__dur">${esc(formatStepDuration(game.stepMs))}</span>
        </p>
      </div>

      ${stepMeterMarkup()}

      <div class="answer">
        <div class="answer__field">
          <label class="visually-hidden" for="answer-input">${esc(t('round.searchLabel'))}</label>
          <input id="answer-input" class="input" type="text" autocomplete="off"
                 autocapitalize="off" autocorrect="off" spellcheck="false"
                 role="combobox" aria-expanded="false" aria-autocomplete="list"
                 aria-controls="answer-results"
                 value="${esc(game.pending ? `${game.pending.title} — ${game.pending.artist}` : '')}"
                 placeholder="${esc(t('round.searchPlaceholder'))}">
          <ul class="results" id="answer-results" role="listbox"
              aria-label="${esc(t('a11y.results'))}" hidden></ul>
        </div>
        <button class="btn ${game.hasPending ? 'btn--primary' : 'btn--ghost'}" data-act type="button">
          ${esc(game.hasPending ? t('round.check') : t('round.skip'))}
        </button>
      </div>

      <p class="hint round__hint">${esc(
        game.step === 0 && game.roundIndex === 0 ? t('round.hintFirst') : t('round.hintSkip')
      )}</p>

      <p class="visually-hidden" aria-live="polite" data-live></p>
    </section>`;

  wireRound();
  if (game.loadNote) {
    toast(game.loadNote);
    game.loadNote = null;
  }
}

/**
 * Шкала ступеней: простая линия из отрезков, под каждым — длительность.
 *
 * Цены ступени здесь нет (блок E3): настоящий результат зависит ещё от времени
 * и режима, и число с итогом не сходилось. Убывание показано не размером, а
 * приглушением: чем дальше отрезок, тем он тусклее.
 *
 * Цвет несёт ровно один смысл:
 *   серый   — ступень пропущена без попытки
 *   красный — на ступени была попытка, и она неверна
 *   лайм    — текущая ступень
 */
function stepMeterMarkup() {
  const total = game.stepsTotal;
  const cells = [];
  for (let i = 0; i < total; i++) {
    const st = i === game.step ? 'now' : game.stepStates[i] || STEP_STATE.LOCKED;
    const dim = (1 - (i / (total - 1)) * 0.55).toFixed(2);
    cells.push(`
      <div class="steps__cell" data-state="${st}" style="--dim:${dim}">
        <span class="steps__bar"></span>
        <span class="steps__dur">${esc(formatStepDuration(stepDuration(game.filters.difficulty, i)))}</span>
      </div>`);
  }
  return `
    <div class="steps" style="--steps:${total}" role="img"
         aria-label="${esc(t('a11y.stepMeter', { n: game.step + 1, total }))}">
      ${cells.join('')}
    </div>`;
}

function wireRound() {
  const playBtn = $('[data-play]');
  const input = $('#answer-input');
  const list = $('#answer-results');
  const actBtn = $('[data-act]');
  const live = $('[data-live]');
  let activeIndex = -1;
  let results = [];
  let raf = 0;

  // Разметка раунда пересоздаётся на каждой ступени, а звук — нет. Токен
  // отсекает таймеры и кадры, оставшиеся от прошлой разметки: без него
  // отложенный finish пометил бы следующую ступень как «дослушанную»
  // и подарил бы чужой бонус.
  const token = ++roundToken;
  const stale = () => token !== roundToken;
  // Флаг «идёт фрагмент» живёт дольше разметки: если прошлый раунд закончился
  // пропуском последней ступени, он оставался поднятым, и в следующем раунде
  // playStep выходил на первой же строке — кнопка «Слушать» переставала
  // работать до конца партии. Каждая новая разметка начинает с чистого листа.
  playing = audio.isLive(game.track.id);

  function stopVisuals() {
    cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(finishTimer);
    finishTimer = null;
    playing = false;
  }

  /** Фрагмент текущей ступени доиграл. */
  function finishFragment() {
    if (stale()) return;
    finishTimer = null;
    playing = false;
    cancelAnimationFrame(raf);
    if (!playBtn.isConnected) return;
    $('[data-ring]').style.strokeDashoffset = '295';
    playBtn.classList.remove('is-playing');
    $('[data-play-label]').textContent = t('round.playAgain');
    game.fragmentEnded();
    if (canAutofocus()) input.focus();
  }

  /** Индикация и таймер для фрагмента длиной durMs от начала сессии. */
  function trackFragment(durMs) {
    if (stale()) return;
    playing = true;
    playBtn.classList.add('is-playing');
    $('[data-play-label]').textContent = t('round.playing');

    const ring = $('[data-ring]');
    cancelAnimationFrame(raf);
    const spin = () => {
      if (stale() || !ring.isConnected) return;
      const elapsed = (audio.elapsedOf(game.track.id) ?? 0) * 1000;
      const p = Math.min(1, elapsed / Math.max(durMs, 200));
      ring.style.strokeDashoffset = String(295 * (1 - p));
      if (p < 1) raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);

    const left = Math.max(60, durMs - (audio.elapsedOf(game.track.id) ?? 0) * 1000);
    clearTimeout(finishTimer);
    // onended у коротких фрагментов приходит с задержкой планировщика,
    // поэтому момент окончания берём по таймеру — он точнее для метрики.
    finishTimer = setTimeout(finishFragment, left);
  }

  async function playStep() {
    const durMs = game.stepMs;

    // Песня этого раунда уже звучит — не начинаем заново, а продлеваем.
    // «Өткізу» на четвёртой секунде не откатывает трек назад: он продолжает
    // играть и теперь доиграет до шести.
    if (audio.isLive(game.track.id) && audio.extendTo(game.track.id, durMs)) {
      trackFragment(durMs);
      return;
    }

    if (playing) return;
    playing = true;
    playBtn.classList.add('is-playing');
    $('[data-play-label]').textContent = t('round.playing');

    try {
      await audio.play(game.track, durMs);
      liveBg('glow');
      trackFragment(durMs);
    } catch {
      stopVisuals();
      if (!playBtn.isConnected) return;
      playBtn.classList.remove('is-playing');
      $('[data-play-label]').textContent = t('round.play');
      showAudioError();
    }
  }

  playBtn.addEventListener('click', playStep);

  /* --- поиск --- */

  function closeList(animated = true) {
    if (list.hidden) return;
    const done = () => {
      list.hidden = true;
      list.innerHTML = '';
      list.classList.remove('is-closing');
    };
    if (animated && !reduceMotion()) {
      list.classList.add('is-closing');
      setTimeout(done, 150);
    } else done();
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    activeIndex = -1;
    results = [];
  }

  /** Подсветка совпавшей подстроки — по «сырому» тексту, как его видит игрок. */
  function highlight(text, query) {
    const q = query.trim();
    if (!q) return esc(text);
    const i = text.toLowerCase().indexOf(q.toLowerCase());
    if (i < 0) return esc(text);
    return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
  }

  /**
   * Выбирает направление и высоту выдачи по реальному свободному месту.
   * Экран не скроллится, поэтому список обязан поместиться в зазор.
   */
  function placeList() {
    const r = input.getBoundingClientRect();
    const margin = 16;
    // Считаем по ВИДИМОЙ высоте: на телефоне клавиатура забирает низ экрана,
    // и по innerHeight выдача открывалась бы прямо под ней.
    const viewH = window.visualViewport?.height ?? window.innerHeight;
    const below = viewH - r.bottom - margin;
    const above = r.top - margin;
    const down = below >= Math.min(above, 220) || below >= 220;
    list.dataset.dir = down ? 'down' : 'up';
    // На телефоне выдача открывается вверх и, если её не ограничить, закрывает
    // весь экран вместе с плеером и шкалой. Больше 42% видимой высоты она не
    // занимает никогда — шесть строк, дальше прокрутка внутри списка.
    const room = Math.floor(down ? below : above);
    const cap = window.innerWidth <= 760 ? Math.round(viewH * 0.42) : room;
    list.style.setProperty('--results-max', `${Math.max(120, Math.min(room, cap))}px`);
  }

  function renderList(query) {
    list.hidden = false;
    list.classList.remove('is-closing');
    placeList();
    input.setAttribute('aria-expanded', 'true');

    if (results.length === 0) {
      list.innerHTML = `<li class="results__empty">${esc(t('round.noResults'))}</li>`;
      return;
    }
    list.innerHTML = results.map((tr, i) => {
      // Уже отвергнутый в этом раунде вариант виден, но выбрать его нельзя:
      // так игрок не тратит попытку дважды на одно и то же (блок D3).
      const rejected = game.rejectedIds.has(tr.id);
      return `
      <li class="results__item${rejected ? ' is-rejected' : ''}" id="opt-${i}" role="option"
          aria-selected="${i === activeIndex}" aria-disabled="${rejected}"
          data-i="${i}" style="--i:${i}"
          ${rejected ? `title="${esc(t('a11y.rejected'))}"` : ''}>
        <span class="results__title">${highlight(tr.title, query)}</span>
        <span class="results__artist">${highlight(tr.artist, query)}</span>
      </li>`;
    }).join('');
  }

  function setActive(i) {
    activeIndex = i;
    $$('.results__item', list).forEach((n, idx) => {
      n.setAttribute('aria-selected', String(idx === i));
      n.classList.toggle('is-active', idx === i);
    });
    if (i >= 0) {
      input.setAttribute('aria-activedescendant', `opt-${i}`);
      $$('.results__item', list)[i]?.scrollIntoView({ block: 'nearest' });
    }
  }

  input.addEventListener('input', () => {
    // Слушаем input, а не keydown: вставка, IME и автодополнение считаются
    // вводом наравне с клавишей (SCORING.md §4.6).
    game.registerInput(input.value);
    const q = input.value.trim();
    if (!q) {
      // Поле очищено — кнопка возвращается в «Өткізу» (блок D1).
      game.clearSelection();
      syncActionButton();
      closeList();
      return;
    }
    results = catalog.search(q, CONFIG.SEARCH_RESULTS);
    activeIndex = -1;
    renderList(q);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
      if (e.key === 'Enter' && game.hasPending) {
        e.preventDefault();
        checkAnswer();
        return;
      }
      if (e.key === 'ArrowDown' && input.value.trim()) {
        results = catalog.search(input.value.trim(), CONFIG.SEARCH_RESULTS);
        renderList(input.value.trim());
        setActive(0);
        e.preventDefault();
      }
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(results.length - 1, activeIndex + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(0, activeIndex - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[activeIndex >= 0 ? activeIndex : 0];
      if (pick) selectTrack(pick);
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  // mousedown, а не click: иначе blur успевает закрыть список.
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.results__item');
    if (!item) return;
    e.preventDefault();
    selectTrack(results[Number(item.dataset.i)]);
  });

  input.addEventListener('blur', () => setTimeout(() => closeList(), 140));

  /**
   * Выбор варианта. Ответ НЕ засчитывается: он только заряжает кнопку,
   * которая превращается в «Тексеру» (блок D1).
   */
  /** Подпись и вид кнопки действия зависят только от того, выбран ли вариант. */
  function syncActionButton() {
    actBtn.textContent = game.hasPending ? t('round.check') : t('round.skip');
    actBtn.classList.toggle('btn--primary', game.hasPending);
    actBtn.classList.toggle('btn--ghost', !game.hasPending);
  }

  function selectTrack(track) {
    if (!track) return;
    if (game.rejectedIds.has(track.id)) {
      toast(t('round.tried'));
      return;
    }
    input.value = `${track.title} — ${track.artist}`;
    closeList(false);
    game.select(track);
    syncActionButton();
    if (canAutofocus()) input.focus();
  }

  function checkAnswer() {
    const res = game.check();
    if (res.correct) {
      // Раунд закончен: карточка результата играет превью с начала.
      stopVisuals();
      audio.stop(90);
      return;
    }
    // Неверный ответ, как и пропуск, открывает следующую ступень — и песня
    // продолжает играть, а не откатывается.

    const fresh = $('#answer-input');
    if (fresh) fresh.value = '';
    flashWrong();

    const message = res.near === 'artist'
      ? t('round.nearArtist')
      : res.near === 'title' ? t('round.nearTitle') : t('round.wrong');
    toast(message, res.near ? 'near' : 'bad');
    const liveNode = $('[data-live]');
    if (liveNode) liveNode.textContent = message;
    if (!res.ended && canAutofocus()) fresh?.focus();
  }

  actBtn.addEventListener('click', () => {
    if (game.hasPending) return checkAnswer();
    // Звук не останавливаем: следующая ступень просто продлит фрагмент.
    clearTimeout(finishTimer);
    finishTimer = null;
    game.skip();
  });

  /* --- клавиатура на уровне экрана --- */
  const onKey = (e) => {
    if (game.screen !== SCREEN.ROUND) return;
    if (e.target === input) return;
    if (e.code === 'Space') {
      e.preventDefault();
      playStep();
    } else if (e.key.toLowerCase() === 's') {
      e.preventDefault();
      $('[data-act]')?.click();
    }
  };
  // #screen переживает смену разметки, поэтому храним «отписку» на нём.
  document.addEventListener('keydown', onKey);
  app()._offKeys?.();
  app()._offKeys = () => document.removeEventListener('keydown', onKey);

  // Разметка новая, а песня та же и всё ещё звучит: подхватываем её и
  // продлеваем до длительности новой ступени.
  if (audio.isLive(game.track.id)) playStep();

  // Клавиатура на телефоне открывается только по явному тапу в поле.
  if (canAutofocus()) input.focus();
}

/**
 * Заметная, но короткая вспышка на неверный ответ (блок D2).
 * 400 мс с плавным затуханием; при prefers-reduced-motion не запускается.
 */
function flashWrong() {
  if (reduceMotion()) return;
  const root = document.body;
  root.classList.remove('is-wrong');
  // reflow, иначе повторная вспышка подряд не перезапустит анимацию
  void root.offsetWidth;
  root.classList.add('is-wrong');
  setTimeout(() => root.classList.remove('is-wrong'), 460);
}

function showAudioError() {
  sheet({
    title: t('error.audioTitle'),
    bodyHtml: `
      <p>${esc(t('error.audioBody'))}</p>
      <div class="sheet__actions">
        <button class="btn btn--primary" data-close type="button" data-autofocus>${esc(t('error.retry'))}</button>
      </div>`,
  });
}

/* ================================================================== */
/* Экран: карточка результата раунда                                   */
/* ================================================================== */

function renderReveal() {
  const r = game.results[game.results.length - 1];
  const track = r.track;
  const last = game.roundIndex >= ROUNDS - 1;
  const expert = r.mode === 'expert';

  app().innerHTML = `
    <section class="screen screen--reveal">
      <div class="reveal__box">
        <div class="card__art">
          <img src="${esc(track.art || '')}" alt="${esc(
            t('a11y.artwork', { title: track.title, artist: track.artist })
          )}" width="600" height="600" decoding="async" crossorigin="anonymous">
        </div>

        <div class="card__meta">
          <p class="eyebrow ${r.solved ? 'eyebrow--win' : ''}">
            ${esc(r.solved ? t('reveal.correct') : t('reveal.missed'))}
          </p>
          <h1 class="card__title">${esc(track.title)}</h1>
          <p class="card__artist">${esc(track.artist)}</p>
          <p class="card__sub">${esc([track.album, track.year].filter(Boolean).join(' · '))}</p>

          <div class="score">
            <p class="score__value"><span data-count>0</span> <em>${esc(t('reveal.points'))}</em></p>
            ${r.solved ? `
              <p class="score__detail">
                ${esc(t('reveal.stepBonus', { n: r.stepIndex + 1, base: r.base }))}${
                  r.bonus > 0 ? ` · ${esc(t('reveal.speedBonus', { bonus: r.bonus }))}` : ''
                }${expert ? ` · ${esc(t('reveal.modeBonus'))}` : ''}
              </p>` : `<p class="score__detail">${esc(t('reveal.zero'))}</p>`}
          </div>

          <div class="links">
            <span class="links__label">${esc(t('reveal.listenOn'))}</span>
            ${streamingLinks(track).map((l) =>
              `<a class="links__a" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a>`
            ).join('')}
            <button class="btn btn--primary" data-next type="button">
              ${esc(last ? t('reveal.finish') : t('reveal.next'))}
            </button>
          </div>
        </div>
      </div>

      <p class="visually-hidden" aria-live="polite">${esc(
        t('a11y.roundResult', { n: game.roundIndex + 1, points: r.total })
      )}</p>
    </section>`;

  animateCount($('[data-count]'), r.total);

  // Превью играет полноценно, фон окрашивается обложкой и пульсирует под бит.
  paintAndPlay(track);

  const next = $('[data-next]');
  next.addEventListener('click', () => {
    audio.stop(220);
      game.next();
  });
  next.focus();
}

/**
 * Карточка ответа: обложка уже открыта, поэтому фон переходит в режим цвета
 * обложки — пятна на орбитах под фильтром, характер по жанру трека.
 */
async function paintAndPlay(track) {
  const token = paintToken;
  // На телефоне цепочки фильтров нет вовсе — и настраивать нечего.
  if (!mobile()) {
    const mood = moodFor(track);
    applyFilter(mood);
    pulse.setMood(mood);
  }
  try {
    await audio.playFull(track);
    if (token !== paintToken) return;
    liveBg('cover');
  } catch {
    /* звук не критичен для показа карточки */
  }
  // Палитра считается ПОСЛЕ того, как экран нарисован и звук пошёл.
  // Раньше она попадала ровно в момент перехода: декодирование обложки и
  // проход по пикселям складывались в одну длинную задачу, и на телефоне
  // карточка ответа появлялась рывком. Теперь фон подкрашивается чуть позже
  // и никого не держит.
  whenIdle(async () => {
    // Пиксели берём из той обложки, что уже показана на экране: второй
    // раз декодировать тот же JPEG незачем.
    const shown = $('.card__art img');
    const colors = await extractPalette(track.art, track.id, shown);
    // Экран мог смениться, пока считалась палитра.
    if (colors && token === paintToken) pulse.setColors(colors);
  });
}

/** Отложить работу до свободного момента. Без rIC — просто следующий кадр. */
function whenIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 700 });
  else setTimeout(fn, 120);
}

/* ================================================================== */
/* Экран: финал                                                        */
/* ================================================================== */

function renderFinal() {
  audio.stop(220);
  // Обложки открыты, но пока курсор ни на одной — фон нейтральный.
  pulse.setMode('glow');

  const total = game.totalScore;
  const verdict = t(`final.verdict${verdictIndex(total, game.filters.difficulty)}`);
  const label = sliceLabel(game.sliceKey);

  app().innerHTML = `
    <section class="screen screen--final">
      <div class="final__top">
        <div>
          <p class="eyebrow">${esc(t('final.title'))} · ${esc(label.mode)} · ${esc(label.category)}</p>
          <h1 class="final__verdict">${esc(verdict)}</h1>
        </div>
        <div class="final__total">
          <span class="eyebrow">${esc(t('final.total'))}</span>
          <p class="final__number" data-total>0</p>
        </div>
      </div>

      <div class="final__grid" id="final-grid">
        ${game.results.map((r, i) => `
          <article class="fcard" data-i="${i}" data-track="${esc(r.track.id)}"
                   style="--d:${i * 70}ms" tabindex="0" role="button"
                   aria-label="${esc(`${r.track.title} — ${r.track.artist}. ${t('final.open')}`)}">
            <div class="fcard__inner">
              <div class="fcard__art">
                <img src="${esc(r.track.art || '')}" alt="" loading="lazy" decoding="async"
                     crossorigin="anonymous">
                <span class="fcard__badge">${esc(levelName(r.level))}</span>
                <span class="fcard__eq" aria-hidden="true"><i></i><i></i><i></i></span>
              </div>
              <h2 class="fcard__title">${esc(r.track.title)}</h2>
              <p class="fcard__artist">${esc(r.track.artist)}</p>
              <dl class="fcard__facts" data-level="${esc(levelName(r.level))}">
                <div><dt>${esc(t('final.stepLabel'))}</dt><dd>${
                  r.solved ? `${r.stepIndex + 1}/${r.stepsTotal}` : '—'
                }</dd></div>
                <div><dt>${esc(t('final.timeLabel'))}</dt><dd>${esc(fmtSeconds(r.elapsedMs))}</dd></div>
                <div><dt>${esc(t('final.pointsLabel'))}</dt><dd><b>${fmtNum(r.total)}</b></dd></div>
              </dl>
            </div>
          </article>`).join('')}
      </div>

      <div class="final__bottom">
        ${LB.enabled() ? `
          <form class="lb-form" novalidate>
            <label class="field__label" for="nick">${esc(t('lb.nick'))}</label>
            <input class="input" id="nick" name="nick" maxlength="20" autocomplete="nickname"
                   value="${esc(LB.savedNick())}"
                   placeholder="${esc(t('lb.nickPlaceholder'))}">
            <button class="btn btn--primary" type="submit">${esc(t('lb.submit'))}</button>
            <span class="lb-status" role="status" data-lb-status></span>
          </form>` : `<p class="hint">${esc(t('final.hoverHint'))}</p>`}

        <div class="final__actions">
          <button class="btn btn--ghost" data-share type="button">${esc(t('final.share'))}</button>
          <button class="btn ${LB.enabled() ? 'btn--ghost' : 'btn--primary'}" data-again type="button">${esc(t('final.again'))}</button>
        </div>
      </div>
    </section>`;

  animateCount($('[data-total]'), total, 1300);
  wireFinalCards();

  $('[data-share]').addEventListener('click', () => showShare(total, verdict, label));
  $('[data-again]').addEventListener('click', () => {
    audio.stop(160);
      submittedThisGame = false;
    game.reset();
    render();
  });

  if (LB.enabled()) {
    wireSubmit(total);
    armSignPrompt();
  }

  // Раскрытие: все карточки стартуют одновременно, stagger — сдвиг фазы.
  requestAnimationFrame(() => $('#final-grid')?.classList.add('is-open'));
}

function wireFinalCards() {
  const grid = $('#final-grid');
  if (!grid) return;
  let hovered = null;

  const startPreview = async (card) => {
    const id = card.dataset.track;
    const track = catalog.get(id);
    if (!track || hovered === id) return;
    hovered = id;
    const token = paintToken;
    if (!mobile()) {
      const mood = moodFor(track);
      applyFilter(mood);
      pulse.setMood(mood);
    }
    card.classList.add('is-sounding');
    try {
      await audio.playFull(track);
      if (hovered !== id || token !== paintToken) return; // курсор ушёл или сменился экран
      liveBg('cover');
      whenIdle(async () => {
        const shown = card.querySelector('.fcard__art img');
        const colors = await extractPalette(track.art, track.id, shown);
        if (colors && hovered === id && token === paintToken) pulse.setColors(colors);
      });
    } catch {
      /* тишина не ломает финал */
    }
  };

  const stopPreview = (card) => {
    card.classList.remove('is-sounding');
    // Наклон живёт на самой карточке — уводя курсор, возвращаем её ровно.
    card.style.setProperty('--tilt-x', '0deg');
    card.style.setProperty('--tilt-y', '0deg');
    if (hovered === card.dataset.track) {
      hovered = null;
      audio.stop(300); // плавное затухание
        }
  };

  grid.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.fcard');
    if (card && !card.contains(e.relatedTarget)) startPreview(card);
  });
  grid.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.fcard');
    if (card && !card.contains(e.relatedTarget)) stopPreview(card);
  });

  // Клик по карточке открывает ту же панель, что и после угадывания:
  // обложка, название, артист, ссылки. Атрибуция обязана быть везде.
  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.fcard');
    if (card) showTrackSheet(card.dataset.track);
  });
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const card = e.target.closest('.fcard');
    if (!card) return;
    e.preventDefault();
    showTrackSheet(card.dataset.track);
  });

  // Клавиатура: фокус на карточке работает как наведение.
  grid.addEventListener('focusin', (e) => {
    const card = e.target.closest('.fcard');
    if (card) startPreview(card);
  });
  grid.addEventListener('focusout', (e) => {
    const card = e.target.closest('.fcard');
    if (card && !card.contains(e.relatedTarget)) stopPreview(card);
  });

  if (reduceMotion()) return;
  grid.addEventListener('mousemove', (e) => {
    const card = e.target.closest('.fcard');
    if (!card) return;
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    card.style.setProperty('--tilt-x', `${(-py * 14).toFixed(2)}deg`);
    card.style.setProperty('--tilt-y', `${(px * 18).toFixed(2)}deg`);
  });
  grid.addEventListener('mouseleave', () => {
    $$('.fcard', grid).forEach((c) => {
      c.style.setProperty('--tilt-x', '0deg');
      c.style.setProperty('--tilt-y', '0deg');
    });
  });
}

/** Панель трека — та же, что после угадывания. Открывается кликом с финала. */
function showTrackSheet(id) {
  const track = catalog.get(id);
  if (!track) return;
  const result = game.results.find((r) => r.track.id === id);

  sheet({
    title: track.title,
    bodyHtml: `
      <div class="tsheet">
        <div class="card__art tsheet__art">
          <img src="${esc(track.art || '')}" alt="${esc(
            t('a11y.artwork', { title: track.title, artist: track.artist })
          )}">
        </div>
        <div class="tsheet__meta">
          <p class="card__artist">${esc(track.artist)}</p>
          <p class="card__sub">${esc([track.album, track.year].filter(Boolean).join(' · '))}</p>
          ${result ? `<p class="score__detail">${esc(
            result.solved
              ? `${t('final.guessedAt', { n: result.stepIndex + 1 })} · ${fmtSeconds(result.elapsedMs)} · ${fmtNum(result.total)} ${t('reveal.points')}`
              : `${t('final.notGuessed')} · ${fmtSeconds(result.elapsedMs)}`
          )}</p>` : ''}
          <div class="links">
            <span class="links__label">${esc(t('reveal.listenOn'))}</span>
            ${streamingLinks(track).map((l) =>
              `<a class="links__a" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.name)}</a>`
            ).join('')}
          </div>
        </div>
      </div>`,
  });
}

function wireSubmit(total) {
  const form = $('.lb-form');
  if (!form) return;
  const status = $('[data-lb-status]');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submittedThisGame) {
      status.textContent = t('lb.alreadySent');
      return;
    }
    const btn = form.querySelector('button');
    const raw = $('#nick').value;
    const nick = LB.sanitizeNick(raw);
    // Пустое имя допустимо: сервер запишет игрока как Qonaq с номером.
    if (nick.length === 1) {
      status.textContent = t('lb.nickTooShort');
      return;
    }
    if (nick && LB.hasProfanity(nick)) {
      status.textContent = t('lb.nickBad');
      return;
    }
    btn.disabled = true;
    status.textContent = t('lb.sending');
    try {
      const res = await LB.submitScore({
        nick,
        score: total,
        rounds: game.results.map((r) => ({
          level: r.level, step: r.stepIndex + 1, points: r.total, solved: r.solved,
        })),
        slice: game.sliceKey,
        sessionHash: game.sessionId,
      });
      submittedThisGame = true;
      if (nick) LB.rememberNick(nick);
      status.textContent = res.placeAllTime
        ? t('lb.myPlace', { place: res.placeAllTime })
        : t('lb.sent');
      btn.textContent = t('lb.sent');
      // Открываем срез, в котором игрок играл, и подсвечиваем его строку.
      showFullBoard('allTime', game.sliceKey, res.nick || nick);
    } catch (err) {
      console.warn('leaderboard:', err);
      status.textContent = err.message === 'nick-bad' ? t('lb.nickBad') : t('lb.error');
      btn.disabled = false;
    }
  });
}

/**
 * Один ненавязчивый перехват «уходишь, не подписав результат» (блок H3).
 *
 * Не beforeunload: системное окно не объясняет причину и раздражает.
 * Ловим намерение уйти — курсор ушёл вверх за пределы окна, к вкладкам и
 * адресной строке. Показываем ровно один раз за сессию; отказ уважаем.
 */
function armSignPrompt() {
  if (signPromptShown || submittedThisGame) return;

  const onLeave = (e) => {
    if (e.clientY > 8) return;
    if (submittedThisGame || signPromptShown) return disarm();
    if (game.screen !== SCREEN.FINAL) return;
    signPromptShown = true;
    disarm();
    sheet({
      title: t('lb.signTitle'),
      bodyHtml: `
        <p>${esc(t('lb.signBody'))}</p>
        <div class="sheet__actions">
          <button class="btn btn--primary" data-sign type="button" data-autofocus>${esc(t('lb.signYes'))}</button>
          <button class="btn btn--ghost" data-close type="button">${esc(t('lb.signNo'))}</button>
        </div>`,
      onMount(panel) {
        panel.querySelector('[data-sign]').addEventListener('click', () => {
          closeSheet();
          $('#nick')?.focus();
        });
      },
    });
  };

  function disarm() {
    document.removeEventListener('mouseout', onLeave);
  }

  document.addEventListener('mouseout', onLeave);
}

/* ================================================================== */
/* Оверлеи                                                             */
/* ================================================================== */

function showRules() {
  const modeRow = (id) => {
    const m = MODES[id];
    const steps = m.stepMs.map((ms) => formatStepDuration(ms)).join(' → ');
    return `<tr>
      <td>${esc(t(`difficulty.${id}`))}</td>
      <td>${esc(steps)}</td>
      <td class="num">×${String(m.multiplier).replace('.', ',')}</td>
    </tr>`;
  };

  sheet({
    title: t('rules.title'),
    wide: true,
    bodyHtml: `
      <p>${esc(t('rules.body1'))}</p>
      <p>${esc(t('rules.body2'))}</p>
      <p>${esc(t('rules.body3'))}</p>
      <p>${esc(t('rules.body4'))}</p>
      <p>${esc(t('rules.body5'))}</p>
      <p>${esc(t('rules.body6'))}</p>
      <h3 class="section-label">${esc(t('rules.modes'))}</h3>
      <table class="lb">
        <thead><tr>
          <th scope="col">${esc(t('rules.colMode'))}</th>
          <th scope="col">${esc(t('rules.colSteps'))}</th>
          <th scope="col" class="num">${esc(t('rules.colMult'))}</th>
        </tr></thead>
        <tbody>${modeRow('normal')}${modeRow('expert')}</tbody>
      </table>`,
  });
}

function showAbout() {
  sheet({
    title: t('about.title'),
    bodyHtml: `
      <p>${esc(t('about.p1'))}</p>
      <p>${esc(t('about.p2'))}</p>
      <p>${esc(t('about.p3'))}</p>
      <p>${esc(t('about.p4'))}</p>
      <p class="muted">${esc(t('legal.note'))}</p>`,
  });
}

function showShare(total, verdict, label) {
  const text = buildShareText(game.results, total, verdict, label);
  sheet({
    title: t('share.title'),
    bodyHtml: `
      <pre class="share__grid">${esc(text)}</pre>
      <p class="muted">${esc(t('share.hint'))}</p>
      <div class="sheet__actions">
        <button class="btn btn--primary" data-copy type="button" data-autofocus>${esc(t('share.copy'))}</button>
        ${canShareNatively() ? `<button class="btn btn--ghost" data-native type="button">${esc(t('share.native'))}</button>` : ''}
      </div>`,
    onMount(panel) {
      panel.querySelector('[data-copy]').addEventListener('click', async (e) => {
        if (await copyText(text)) {
          e.currentTarget.textContent = t('share.copied');
          toast(t('share.copied'), 'good');
        }
      });
      panel.querySelector('[data-native]')?.addEventListener('click', () => shareNatively(text));
    },
  });
}

/* ================================================================== */
/* Ошибки                                                              */
/* ================================================================== */

function renderCatalogError() {
  app().innerHTML = `
    <section class="screen screen--error">
      <h1 class="error__title">${esc(t('error.catalogTitle'))}</h1>
      <p>${esc(t('error.catalogBody'))}</p>
      <button class="btn btn--primary btn--xl" data-retry type="button">${esc(t('error.retry'))}</button>
    </section>`;
  $('[data-retry]').addEventListener('click', () => location.reload());
}

function renderRuntimeError() {
  app().innerHTML = `
    <section class="screen screen--error">
      <h1 class="error__title">${esc(t('start.notEnoughShort'))}</h1>
      <p>${esc(game.error || t('start.notEnough'))}</p>
      <button class="btn btn--primary btn--xl" data-retry type="button">${esc(t('error.retry'))}</button>
    </section>`;
  $('[data-retry]').addEventListener('click', () => resetToStart());
}

/* ================================================================== */

if (new URLSearchParams(location.search).has('debug')) window.__OLENSIZ_DEBUG = true;

boot();

// Небольшая поверхность для ручной проверки и e2e-скрипта.
window.__olensiz = {
  get game() { return game; },
  get catalog() { return catalog; },
  audio,
  get pulse() { return pulse; },
  buildGrid: () => buildGrid(game.results),
  savedLocale, otherLocale, localeShort, stepCount,
};
