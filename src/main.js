/**
 * Контроллер и экраны. Игра линейна, состояние держит Game, здесь — рендер
 * и обработка ввода.
 *
 * Итерация 2: только десктоп, только тёмная тема, ни один экран не скроллится.
 */

import { CONFIG } from './config.js';
import {
  loadStrings, t, levelName, genreName, locale, otherLocale, setLocale,
  onLocaleChange, localeShort, localeHintSeen, markLocaleHintSeen, savedLocale,
} from './i18n.js';
import { loadCatalog, streamingLinks } from './catalog.js';
import { AudioEngine } from './audio.js';
import { Pulse } from './pulse.js';
import { extractPalette } from './palette.js';
import { watchViewportHeight } from './fit.js';
import { Game, SCREEN } from './game.js';
import { STEP_MS, STEP_POINTS, ROUNDS, verdictIndex } from './scoring.js';
import { buildShareText, buildGrid, copyText, canShareNatively, shareNatively } from './share.js';
import * as LB from './leaderboard.js';
import {
  $, $$, esc, sheet, closeSheet, toast, animateCount,
  reduceMotion, formatStepDuration, fmtNum,
} from './ui.js';

const app = () => document.getElementById('screen');

let catalog = null;
let game = null;
const audio = new AudioEngine();
let pulse = null;

/** Отправляли ли уже результат этой партии — клиентский rate-limit. */
let submittedThisGame = false;
/** Проигрывание фрагмента идёт прямо сейчас. */
let playing = false;
/** Кэш загруженных топов, чтобы не дёргать сеть на каждую перерисовку. */
let boardsCache = null;
/**
 * Счётчик перерисовок экрана. Извлечение палитры асинхронно и может
 * завершиться уже после того, как игрок ушёл дальше, — тогда фон окрасился бы
 * на экране, который должен быть нейтральным. Токен отсекает такие ответы.
 */
let paintToken = 0;

/* ================================================================== */
/* Загрузка                                                            */
/* ================================================================== */

async function boot() {
  watchViewportHeight();
  pulse = new Pulse(document.getElementById('song-bg'));

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
  game.onChange(render);

  // Смена языка перерисовывает и шапку, и текущий экран.
  onLocaleChange(() => {
    renderChrome();
    render();
  });

  render();
}

/* ================================================================== */
/* Шапка                                                               */
/* ================================================================== */

function renderChrome() {
  const header = document.getElementById('chrome-head');
  const showHint = !localeHintSeen() && locale() === 'kk';

  header.innerHTML = `
    <button class="brand" data-home type="button">
      <span class="brand__mark" aria-hidden="true"></span>
      <span class="brand__name">${esc(t('app.title'))}</span>
    </button>

    <div class="chrome__rail" id="level-rail" hidden></div>

    <nav class="chrome__nav">
      <button class="btn btn--icon" data-rules type="button"
              aria-label="${esc(t('nav.rules'))}" title="${esc(t('nav.rules'))}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17v.01M12 14c0-2 2.5-2.2 2.5-4.3A2.6 2.6 0 0 0 12 7a2.6 2.6 0 0 0-2.5 2.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="12" r="9.2" fill="none" stroke="currentColor" stroke-width="2"/></svg>
      </button>

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
      </div>
    </nav>`;

  header.addEventListener('click', onChromeClick);
}

function onChromeClick(e) {
  const langBtn = e.target.closest('[data-locale]');
  if (langBtn) {
    markLocaleHintSeen();
    setLocale(langBtn.dataset.locale);
    return;
  }
  if (e.target.closest('[data-rules]')) return showRules();
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
  pulse.clear();
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
  rail.innerHTML = Array.from({ length: ROUNDS }, (_, i) => {
    const state = i < game.roundIndex ? 'done' : i === game.roundIndex ? 'now' : 'todo';
    return `<span class="rail__seg" data-state="${state}"><i></i></span>`;
  }).join('');
}

/* ================================================================== */
/* Экран: старт                                                        */
/* ================================================================== */

function renderStart() {
  audio.stop(200);
  pulse.clear();

  const av = game.availability;
  const genres = catalog.availableGenres();

  app().innerHTML = `
    <section class="screen screen--start${LB.enabled() ? '' : ' is-solo'}">
      <div class="start__left">
        <div class="hero">
          <p class="eyebrow">${esc(t('app.subtitle'))}</p>
          <h1 class="hero__title">${esc(t('app.title'))}</h1>
          <p class="hero__tagline">${esc(t('app.tagline'))}</p>
        </div>

        <div class="facts">
          <div class="facts__item">
            <span class="facts__n">5</span>
            <span class="facts__label">${esc(t('start.rounds'))}</span>
          </div>
          <div class="facts__item">
            <span class="facts__n">7</span>
            <span class="facts__label">${esc(t('start.attempts'))}</span>
          </div>
          <div class="facts__item">
            <span class="facts__n">${fmtNum(catalog.size)}</span>
            <span class="facts__label">${esc(t('start.songsLabel'))}</span>
          </div>
        </div>

        <div class="modes">
          <div class="modes__row">
            <span class="section-label" style="margin:0">${esc(t('start.mode'))}</span>
            <div class="seg" role="group" aria-label="${esc(t('start.mode'))}">
              <button class="seg__btn" data-age="family" type="button"
                      aria-pressed="${game.filters.age === 'family'}"
                      title="${esc(t('age.familyHint'))}">${esc(t('age.family'))}</button>
              <button class="seg__btn" data-age="18plus" type="button"
                      aria-pressed="${game.filters.age === '18plus'}"
                      title="${esc(t('age.18plusHint'))}">${esc(t('age.18plus'))}</button>
            </div>
          </div>

          <div class="chips" role="group" aria-label="${esc(t('start.genres'))}">
            <button class="chip chip--random" data-random type="button"
                    aria-pressed="${game.isRandom}"
                    title="${esc(t('start.randomHint'))}">${esc(t('start.random'))}</button>
            ${genres.map((g) => `
              <button class="chip" data-genre="${esc(g)}" type="button"
                      aria-pressed="${game.filters.genres.includes(g)}">${esc(genreName(g))}</button>
            `).join('')}
          </div>
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
      </div>

      ${LB.enabled() ? `
        <aside class="start__right" id="start-boards">
          ${boardMarkup('allTime', t('lb.allTime'))}
          ${boardMarkup('today', t('lb.today'))}
        </aside>` : ''}
    </section>`;

  wireStart();
  if (LB.enabled()) loadBoards();
}

function boardMarkup(kind, title) {
  return `
    <section class="board board--${kind === 'today' ? 'today' : 'all'}">
      <div class="board__head">
        <button class="board__title" data-open-board="${kind}" type="button">${esc(title)}</button>
        <button class="board__more" data-open-board="${kind}" type="button">${esc(t('lb.openFull'))}</button>
      </div>
      <div class="board__body" data-board="${kind}">
        <p class="muted">${esc(t('lb.loading'))}</p>
      </div>
    </section>`;
}

function wireStart() {
  const screen = $('.screen--start');

  screen.addEventListener('click', (e) => {
    const age = e.target.closest('[data-age]');
    if (age) return game.setAge(age.dataset.age);

    if (e.target.closest('[data-random]')) return game.resetGenres();

    const g = e.target.closest('[data-genre]');
    if (g) return game.toggleGenre(g.dataset.genre);

    const board = e.target.closest('[data-open-board]');
    if (board) return showFullBoard(board.dataset.openBoard);

    if (e.target.closest('[data-start]')) return startGame();
  });
}

async function loadBoards() {
  const box = $('#start-boards');
  if (!box) return;
  try {
    boardsCache = await LB.fetchBoards();
    paintBoard('allTime');
    paintBoard('today');
  } catch {
    // Лидерборды необязательны: молча убираем блок, игру не трогаем.
    box.remove();
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

function leaderboardTable(rows, highlightNick = null) {
  return `
    <table class="lb">
      <tbody>${rows.map((r, i) => `
        <tr${highlightNick && r.nick === highlightNick ? ' class="is-me"' : ''}>
          <td class="num">${i + 1}</td>
          <td class="lb__nick">${esc(r.nick)}</td>
          <td class="num">${fmtNum(Number(r.score || 0))}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

async function showFullBoard(kind) {
  const panel = sheet({
    title: kind === 'today' ? t('lb.today') : t('lb.allTime'),
    wide: true,
    bodyHtml: `<p class="muted" data-full>${esc(t('lb.loading'))}</p>`,
  });
  try {
    const boards = await LB.fetchBoards(CONFIG.LEADERBOARD_FULL_N);
    const rows = boards[kind] || [];
    panel.querySelector('[data-full]').outerHTML = rows.length
      ? leaderboardTable(rows)
      : `<p class="muted">${esc(kind === 'today' ? t('lb.emptyToday') : t('lb.empty'))}</p>`;
  } catch {
    panel.querySelector('[data-full]').textContent = t('lb.error');
  }
}

/* ================================================================== */
/* Старт партии: предзагрузка всех пяти треков                          */
/* ================================================================== */

async function startGame() {
  // Контекст создаётся внутри жеста пользователя — иначе автоплей заблокирован.
  audio.ensureContext();

  let picked;
  let spares;
  try {
    ({ picked, spares } = game.prepare());
  } catch (err) {
    game.fail(err.message);
    return;
  }

  const { tracks, replaced } = await audio.preloadGame(
    picked, spares, (done, total) => game.setLoadProgress(done, total)
  );

  // Партия стартует только когда все пять треков реально готовы.
  const missing = tracks.filter((tr) => !audio.isReady(tr.id));
  game.begin(tracks, replaced > 0 || missing.length ? t('error.loadFailed') : null);
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
  pulse.clear();
  const n = game.roundIndex + 1;

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

      <div class="steps" role="img"
           aria-label="${esc(t('a11y.stepMeter', { n: game.step + 1, points: game.stepValue }))}">
        ${STEP_MS.map((ms, i) => `
          <div class="steps__cell" data-state="${
            i < game.step ? 'spent' : i === game.step ? 'now' : 'locked'
          }">
            <span class="steps__bar"><i></i></span>
            <span class="steps__dur">${esc(formatStepDuration(ms))}</span>
            <span class="steps__pts">${STEP_POINTS[i]}</span>
          </div>`).join('')}
      </div>

      <div class="answer">
        <div class="answer__field">
          <label class="visually-hidden" for="answer-input">${esc(t('round.searchLabel'))}</label>
          <input id="answer-input" class="input" type="text" autocomplete="off"
                 autocapitalize="off" autocorrect="off" spellcheck="false"
                 role="combobox" aria-expanded="false" aria-autocomplete="list"
                 aria-controls="answer-results"
                 placeholder="${esc(t('round.searchPlaceholder'))}">
          <ul class="results" id="answer-results" role="listbox"
              aria-label="${esc(t('a11y.results'))}" hidden></ul>
        </div>
        <button class="btn btn--ghost" data-skip type="button">
          ${esc(game.isLastStep ? t('round.lastStep') : t('round.skip'))}
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

function wireRound() {
  const playBtn = $('[data-play]');
  const input = $('#answer-input');
  const list = $('#answer-results');
  const live = $('[data-live]');
  let activeIndex = -1;
  let results = [];
  let finishTimer = null;

  /** Отложенный finish() обязан отмениться при смене экрана, иначе он
   *  пометит СЛЕДУЮЩИЙ раунд как «фрагмент дослушан» и подарит чужой бонус. */
  function cancelPlayback() {
    clearTimeout(finishTimer);
    finishTimer = null;
    playing = false;
  }

  async function playStep() {
    if (playing) return;
    playing = true;
    playBtn.classList.add('is-playing');
    $('[data-play-label]').textContent = t('round.playing');

    const durMs = game.stepMs;
    const ring = $('[data-ring]');
    const started = performance.now();
    let raf = 0;
    const spin = () => {
      const p = Math.min(1, (performance.now() - started) / Math.max(durMs, 200));
      ring.style.strokeDashoffset = String(295 * (1 - p));
      if (p < 1) raf = requestAnimationFrame(spin);
    };
    raf = requestAnimationFrame(spin);

    const finish = () => {
      cancelAnimationFrame(raf);
      finishTimer = null;
      playing = false;
      // Разметку могли заменить, пока играл фрагмент.
      if (!playBtn.isConnected) return;
      ring.style.strokeDashoffset = '295';
      playBtn.classList.remove('is-playing');
      $('[data-play-label]').textContent = t('round.playAgain');
      game.fragmentEnded();
      input.focus();
    };

    try {
      await audio.play(game.track, durMs);
      // onended у коротких фрагментов приходит с задержкой планировщика,
      // поэтому момент окончания берём по таймеру — он точнее для метрики.
      finishTimer = setTimeout(finish, Math.max(durMs, 80));
    } catch {
      cancelAnimationFrame(raf);
      cancelPlayback();
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
    const below = window.innerHeight - r.bottom - margin;
    const above = r.top - margin;
    const down = below >= Math.min(above, 220) || below >= 220;
    list.dataset.dir = down ? 'down' : 'up';
    list.style.setProperty('--results-max', `${Math.max(120, Math.floor(down ? below : above))}px`);
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
    list.innerHTML = results.map((tr, i) => `
      <li class="results__item" id="opt-${i}" role="option"
          aria-selected="${i === activeIndex}" data-i="${i}" style="--i:${i}">
        <span class="results__title">${highlight(tr.title, query)}</span>
        <span class="results__artist">${highlight(tr.artist, query)}</span>
      </li>`).join('');
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
    if (!q) return closeList();
    results = catalog.search(q, CONFIG.SEARCH_RESULTS);
    activeIndex = -1;
    renderList(q);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) {
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
      if (pick) submitGuess(pick);
    } else if (e.key === 'Escape') {
      closeList();
    }
  });

  // mousedown, а не click: иначе blur успевает закрыть список.
  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('.results__item');
    if (!item) return;
    e.preventDefault();
    submitGuess(results[Number(item.dataset.i)]);
  });

  input.addEventListener('blur', () => setTimeout(() => closeList(), 140));

  function submitGuess(track) {
    if (!track) return;
    cancelPlayback();
    audio.stop(90);
    const res = game.guess(track);
    if (res.correct) return; // game сам переключит экран

    input.value = '';
    closeList(false);

    const message = res.near === 'artist'
      ? t('round.nearArtist')
      : res.near === 'title' ? t('round.nearTitle') : t('round.wrong');
    toast(message, res.near ? 'near' : 'neutral');
    live.textContent = message;
    if (!res.ended) input.focus();
  }

  $('[data-skip]').addEventListener('click', () => {
    cancelPlayback();
    audio.stop(90);
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
      $('[data-skip]')?.click();
    }
  };
  // #screen переживает смену разметки, поэтому храним «отписку» на нём.
  document.addEventListener('keydown', onKey);
  app()._offKeys?.();
  app()._offKeys = () => document.removeEventListener('keydown', onKey);

  input.focus();
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

  app().innerHTML = `
    <section class="screen screen--reveal">
      <div class="reveal__box">
        <div class="card__art">
          <img src="${esc(track.art || '')}" alt="${esc(
            t('a11y.artwork', { title: track.title, artist: track.artist })
          )}" width="600" height="600">
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
                }
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
    pulse.clear();
    game.next();
  });
  next.focus();
}

/** Красит фон цветами обложки, запускает трек и пульсацию. */
async function paintAndPlay(track) {
  const token = paintToken;
  try {
    await audio.playFull(track);
    if (token !== paintToken) return;
    pulse.start(audio.analyser);
  } catch {
    /* звук не критичен для показа карточки */
  }
  const colors = await extractPalette(track.art, track.id);
  // Экран мог смениться, пока считалась палитра.
  if (colors && token === paintToken) pulse.setColors(colors);
}

/* ================================================================== */
/* Экран: финал                                                        */
/* ================================================================== */

function renderFinal() {
  audio.stop(220);
  pulse.clear();

  const total = game.totalScore;
  const verdict = t(`final.verdict${verdictIndex(total)}`);

  app().innerHTML = `
    <section class="screen screen--final">
      <div class="final__top">
        <div>
          <p class="eyebrow">${esc(t('final.title'))}</p>
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
                   style="--d:${i * 70}ms" tabindex="0"
                   aria-label="${esc(`${r.track.title} — ${r.track.artist}`)}">
            <div class="fcard__inner">
              <div class="fcard__art">
                <img src="${esc(r.track.art || '')}" alt="" loading="lazy">
                <span class="fcard__badge">${esc(levelName(r.level))}</span>
                <span class="fcard__eq" aria-hidden="true"><i></i><i></i><i></i></span>
              </div>
              <h2 class="fcard__title">${esc(r.track.title)}</h2>
              <p class="fcard__artist">${esc(r.track.artist)}</p>
              <p class="fcard__score">
                <b>${fmtNum(r.total)}</b>
                <span>${esc(r.solved ? t('final.guessedAt', { n: r.stepIndex + 1 }) : t('final.notGuessed'))}</span>
              </p>
            </div>
          </article>`).join('')}
      </div>

      <div class="final__bottom">
        ${LB.enabled() ? `
          <form class="lb-form" novalidate>
            <label class="visually-hidden" for="nick">${esc(t('lb.nick'))}</label>
            <input class="input" id="nick" name="nick" maxlength="20" autocomplete="nickname"
                   placeholder="${esc(t('lb.nickPlaceholder'))}">
            <button class="btn btn--ghost" type="submit">${esc(t('lb.submit'))}</button>
            <span class="lb-status" role="status" data-lb-status></span>
          </form>` : `<p class="hint">${esc(t('final.hoverHint'))}</p>`}

        <div class="final__actions">
          <button class="btn btn--primary" data-share type="button">${esc(t('final.share'))}</button>
          <button class="btn btn--ghost" data-again type="button">${esc(t('final.again'))}</button>
        </div>
      </div>
    </section>`;

  animateCount($('[data-total]'), total, 1300);
  wireFinalCards();

  $('[data-share]').addEventListener('click', () => showShare(total, verdict));
  $('[data-again]').addEventListener('click', () => {
    audio.stop(160);
    pulse.clear();
    submittedThisGame = false;
    game.reset();
    render();
  });

  if (LB.enabled()) wireSubmit(total);

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
    card.classList.add('is-sounding');
    try {
      await audio.playFull(track);
      if (hovered !== id || token !== paintToken) return; // курсор ушёл или сменился экран
      pulse.start(audio.analyser);
      const colors = await extractPalette(track.art, track.id);
      if (colors && hovered === id && token === paintToken) pulse.setColors(colors);
    } catch {
      /* тишина не ломает финал */
    }
  };

  const stopPreview = (card) => {
    card.classList.remove('is-sounding');
    if (hovered === card.dataset.track) {
      hovered = null;
      audio.stop(300); // плавное затухание
      pulse.clear();
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
    const nick = LB.sanitizeNick($('#nick').value);
    if (nick.length < 2) {
      status.textContent = t('lb.nickTooShort');
      return;
    }
    if (LB.hasProfanity(nick)) {
      status.textContent = t('lb.nickBad');
      return;
    }
    btn.disabled = true;
    status.textContent = t('lb.sending');
    try {
      await LB.submitScore({
        nick,
        score: total,
        rounds: game.results.map((r) => ({
          level: r.level, step: r.stepIndex + 1, points: r.total, solved: r.solved,
        })),
        sessionHash: game.sessionId,
      });
      submittedThisGame = true;
      status.textContent = t('lb.sent');
      btn.textContent = t('lb.sent');
      boardsCache = await LB.fetchBoards().catch(() => boardsCache);
      showFullBoard('allTime');
    } catch (err) {
      console.warn('leaderboard:', err);
      status.textContent = err.message === 'nick-bad' ? t('lb.nickBad') : t('lb.error');
      btn.disabled = false;
    }
  });
}

/* ================================================================== */
/* Оверлеи                                                             */
/* ================================================================== */

function showRules() {
  sheet({
    title: t('rules.title'),
    bodyHtml: `
      <p>${esc(t('rules.body1'))}</p>
      <p>${esc(t('rules.body2'))}</p>
      <p>${esc(t('rules.body3'))}</p>
      <p>${esc(t('rules.body4'))}</p>
      <p>${esc(t('rules.body5'))}</p>
      <h3 class="section-label">${esc(t('rules.steps'))}</h3>
      <table class="lb">
        <thead><tr>
          <th scope="col">${esc(t('rules.colStep'))}</th>
          <th scope="col" class="num">${esc(t('rules.colPoints'))}</th>
        </tr></thead>
        <tbody>${STEP_MS.map((ms, i) =>
          `<tr><td>${esc(formatStepDuration(ms))}</td><td class="num">${STEP_POINTS[i]}</td></tr>`
        ).join('')}</tbody>
      </table>`,
  });
}

function showShare(total, verdict) {
  const text = buildShareText(game.results, total, verdict);
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

if (new URLSearchParams(location.search).has('debug')) window.__TAP_ANDA_DEBUG = true;

boot();

// Небольшая поверхность для ручной проверки и e2e-скрипта.
window.__tapAnda = {
  get game() { return game; },
  get catalog() { return catalog; },
  audio,
  get pulse() { return pulse; },
  buildGrid: () => buildGrid(game.results),
  savedLocale, otherLocale, localeShort,
};
