/**
 * Конечный автомат партии. Ничего не знает про DOM — только про правила.
 * Рендер подписывается через onChange.
 *
 * Не трогали (блок K): пять раундов, порядок уровней 1→5, переход раунд →
 * карточка → следующий раунд, атрибуция артиста.
 *
 * Новое в итерации 3:
 *   — два режима подачи (обычный / экспертный), от них зависят ступени и очки;
 *   — ответ засчитывается только по «Тексеру», а не мгновенно при выборе;
 *   — ступени помнят, была ли на них попытка (серый ≠ красный);
 *   — уже отвергнутые в этом раунде треки нельзя выбрать снова;
 *   — раунд помнит, за сколько игрок ответил.
 */

import {
  ROUNDS, roundScore, stepPoints, stepDuration, stepCount, nearMissKind,
  DEFAULT_MODE, modeOf,
} from './scoring.js';

export const SCREEN = {
  START: 'start',
  LOADING: 'loading',
  ROUND: 'round',
  REVEAL: 'reveal',
  FINAL: 'final',
  ERROR: 'error',
};

/** Состояние ступени в полоске под плеером (блок D2). */
export const STEP_STATE = {
  LOCKED: 'locked',   // до неё не дошло
  NOW: 'now',         // текущая
  SKIPPED: 'skipped', // пропущена без попытки — серая
  WRONG: 'wrong',     // была попытка, и она неверна — красная
  SOLVED: 'solved',   // на ней угадали
};

/** Идентификатор сессии — ключ rate-limit в лидерборде. */
function makeSessionId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

export class Game {
  constructor(catalog) {
    this.catalog = catalog;
    this.listeners = new Set();
    this.sessionId = makeSessionId();

    /**
     * Фильтры партии — два независимых измерения выбора плюс жанры.
     * difficulty: 'normal' | 'expert' — длина фрагментов и цена ступеней.
     * age: 'family' — только семейное; '18plus' — семейное И взрослое.
     * genres: пустой массив = все категории (режим Random).
     */
    this.filters = { difficulty: DEFAULT_MODE, age: 'family', genres: [] };

    this.reset();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  reset() {
    this.screen = SCREEN.START;
    this.tracks = [];
    this.spares = [];
    this.roundIndex = 0;
    this.step = 0;
    this.results = [];
    this.error = null;
    this.loadProgress = { done: 0, total: ROUNDS };
    this.loadNote = null;
    this._resetRoundTiming();
  }

  _resetRoundTiming() {
    /** Помечен ли раунд как «без бонуса» (был неверный ответ). */
    this.bonusVoid = false;
    /** performance.now() окончания ПЕРВОГО проигрывания текущей ступени. */
    this.fragmentEndedAt = null;
    /** performance.now() первого валидного ввода после окончания фрагмента. */
    this.firstInputAt = null;
    /** performance.now() начала раунда — для «за сколько ответил» в финале. */
    this.roundStartedAt = performance.now();
    /** Ступени, которые игрок уже слышал. */
    this.heardSteps = new Set();
    /** Догадки текущего раунда. */
    this.guesses = [];
    /** id треков, уже отвергнутых в этом раунде (блок D3). */
    this.rejectedIds = new Set();
    /** Состояние каждой ступени: была попытка или просто пропуск (блок D2). */
    this.stepStates = new Array(this.stepsTotal).fill(STEP_STATE.LOCKED);
    /** Выбранный, но ещё не проверенный трек (блок D1). */
    this.pending = null;
  }

  /* ---------------------------------------------------------------- */
  /* Режим партии                                                      */
  /* ---------------------------------------------------------------- */

  get mode() {
    return modeOf(this.filters.difficulty);
  }

  get stepsTotal() {
    return stepCount(this.filters.difficulty);
  }

  setDifficulty(id) {
    this.filters.difficulty = id === 'expert' ? 'expert' : 'normal';
    this._resetRoundTiming();
    this._emit();
  }

  setAge(age) {
    this.filters.age = age === '18plus' ? '18plus' : 'family';
    this._emit();
  }

  toggleGenre(tag) {
    const i = this.filters.genres.indexOf(tag);
    if (i >= 0) this.filters.genres.splice(i, 1);
    else this.filters.genres.push(tag);
    this._emit();
  }

  /** Random = сброс всех жанровых фильтров (возраст и режим — выбор игрока). */
  resetGenres() {
    this.filters.genres = [];
    this._emit();
  }

  get isRandom() {
    return this.filters.genres.length === 0;
  }

  /** Хватает ли треков на партию с текущими фильтрами. */
  get availability() {
    return this.catalog.canStart(this.filters);
  }

  /**
   * Срез лидерборда, в котором играет этот игрок (блок H2).
   * Строка стабильна: жанры отсортированы, режим и возраст всегда на месте.
   */
  get sliceKey() {
    const cat = this.isRandom ? 'random' : `g:${[...this.filters.genres].sort().join('+')}`;
    return `${cat}|${this.filters.difficulty}|${this.filters.age}`;
  }

  /* ---------------------------------------------------------------- */
  /* Партия                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Готовит партию. Треки выбираются сразу, но экран переключается на
   * LOADING: игра не стартует, пока все пять не декодированы.
   */
  prepare() {
    const { picked, spares, recycled } = this.catalog.pickGame(this.filters, ROUNDS);
    this.tracks = picked;
    this.spares = spares;
    this.recycled = recycled;
    this.roundIndex = 0;
    this.step = 0;
    this.results = [];
    this.loadProgress = { done: 0, total: ROUNDS };
    this.loadNote = null;
    this._resetRoundTiming();
    this.screen = SCREEN.LOADING;
    this._emit();
    return { picked, spares, recycled };
  }

  setLoadProgress(done, total) {
    this.loadProgress = { done, total };
    this._emit();
  }

  /** Все треки готовы — партия начинается. */
  begin(tracks, note = null) {
    if (tracks) this.tracks = tracks;
    this.loadNote = note;
    // Запоминаем партию целиком сразу: игрок уже «видел» эти треки,
    // и повторить их в следующей партии было бы обидно.
    this.catalog.remember(this.tracks);
    this.roundStartedAt = performance.now();
    this.screen = SCREEN.ROUND;
    this._emit();
  }

  fail(err) {
    this.error = err;
    this.screen = SCREEN.ERROR;
    this._emit();
  }

  /** Идёт ли партия прямо сейчас (для подтверждения выхода). */
  get inProgress() {
    return this.screen === SCREEN.ROUND
      || this.screen === SCREEN.REVEAL
      || this.screen === SCREEN.LOADING;
  }

  get track() {
    return this.tracks[this.roundIndex] || null;
  }

  get stepMs() {
    return stepDuration(this.filters.difficulty, this.step);
  }

  get stepValue() {
    return stepPoints(this.filters.difficulty, this.step);
  }

  get isLastStep() {
    return this.step >= this.stepsTotal - 1;
  }

  get totalScore() {
    return this.results.reduce((s, r) => s + r.total, 0);
  }

  /* ---------------------------------------------------------------- */
  /* Тайминг ответа                                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Фрагмент ступени доиграл до конца.
   *
   * Отсчёт привязан к ПЕРВОМУ проигрыванию ступени и повторными не
   * сбрасывается: иначе можно было бы слушать сколько угодно, а потом нажать
   * клавишу мгновенно и забрать полный бонус (SCORING.md §4.4).
   */
  fragmentEnded() {
    if (this.heardSteps.has(this.step)) return;
    this.heardSteps.add(this.step);
    this.fragmentEndedAt = performance.now();
    this.firstInputAt = null;
  }

  /** Любой ввод в поле ответа: клавиша, вставка, IME, автодополнение. */
  registerInput(value) {
    // Поле очищено в ноль — предыдущий «первый ввод» аннулируется.
    if (value.trim() === '') {
      this.firstInputAt = null;
      return;
    }
    if (this.fragmentEndedAt === null) return; // ввод до конца фрагмента не считается
    if (this.firstInputAt !== null) return;
    this.firstInputAt = performance.now();
  }

  get timeToFirstInputMs() {
    if (this.fragmentEndedAt === null || this.firstInputAt === null) return null;
    return Math.max(0, this.firstInputAt - this.fragmentEndedAt);
  }

  /* ---------------------------------------------------------------- */
  /* Ответ (блок D1)                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Игрок выбрал трек из выдачи. Ответ ЕЩЁ НЕ проверяется: выбор только
   * заряжает кнопку, которая из «Өткізу» превращается в «Тексеру».
   * @returns {boolean} принят ли выбор (уже отвергнутый трек выбрать нельзя)
   */
  select(track) {
    if (!track || this.rejectedIds.has(track.id)) return false;
    this.pending = track;
    // Намеренно БЕЗ _emit(): перерисовка раунда пересоздала бы поле ввода и
    // стёрла бы только что выбранное название. Подпись кнопки меняет
    // контроллер точечно (main.js → syncActionButton).
    return true;
  }

  /** Поле очищено — кнопка возвращается в «Өткізу». */
  clearSelection() {
    if (!this.pending) return;
    this.pending = null;
  }

  get hasPending() {
    return this.pending !== null;
  }

  /**
   * «Тексеру»: проверить выбранный трек.
   * @returns {{correct:boolean, near:'artist'|'title'|null, ended:boolean, track:object}}
   */
  check() {
    const answer = this.track;
    const track = this.pending;
    if (!answer || !track) return { correct: false, near: null, ended: false, track: null };

    this.pending = null;

    if (track.id === answer.id) {
      this.stepStates[this.step] = STEP_STATE.SOLVED;
      this._closeRound(true);
      return { correct: true, near: null, ended: true, track };
    }

    this.guesses.push(track);
    this.rejectedIds.add(track.id);
    const near = nearMissKind(track, answer);

    // Неверный ответ открывает следующую ступень — как «Өткізу».
    // Это делает N ступеней = N попыток и закрывает перебор каталога.
    this.bonusVoid = true;
    this.stepStates[this.step] = STEP_STATE.WRONG;
    const ended = this._advanceStep();
    return { correct: false, near, ended, track };
  }

  /** «Өткізу»: открыть следующую ступень, попытки не было. */
  skip() {
    this.guesses.push(null);
    this.pending = null;
    this.stepStates[this.step] = STEP_STATE.SKIPPED;
    return this._advanceStep();
  }

  /** @returns {boolean} закончился ли раунд */
  _advanceStep() {
    if (this.isLastStep) {
      this._closeRound(false);
      return true;
    }
    this.step++;
    this.firstInputAt = null;
    this.fragmentEndedAt = null;
    this._emit();
    return false;
  }

  _closeRound(solved) {
    const score = roundScore({
      solved,
      stepIndex: this.step,
      timeToFirstInputMs: this.timeToFirstInputMs,
      bonusVoid: this.bonusVoid,
      mode: this.filters.difficulty,
    });
    this.results.push({
      track: this.track,
      level: this.roundIndex + 1,
      solved,
      stepIndex: this.step,
      stepsTotal: this.stepsTotal,
      mode: this.filters.difficulty,
      // Сколько прошло от начала раунда до ответа — показывается в финале.
      elapsedMs: Math.max(0, performance.now() - this.roundStartedAt),
      guesses: this.guesses.slice(),
      stepStates: this.stepStates.slice(),
      ...score,
    });
    this.screen = SCREEN.REVEAL;
    this._emit();
  }

  /** «Келесі» с карточки результата. */
  next() {
    if (this.roundIndex >= ROUNDS - 1) {
      this.screen = SCREEN.FINAL;
      this._emit();
      return;
    }
    this.roundIndex++;
    this.step = 0;
    this._resetRoundTiming();
    this.screen = SCREEN.ROUND;
    this._emit();
  }

  get nextTrack() {
    return this.tracks[this.roundIndex + 1] || null;
  }
}
