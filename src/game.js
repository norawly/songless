/**
 * Конечный автомат партии. Ничего не знает про DOM — только про правила.
 * Рендер подписывается через onChange.
 *
 * Механика раундов и очков не менялась (блок H задания): 5 раундов, 7 ступеней,
 * промах открывает следующую ступень, бонус считается от первого ввода.
 * Новое в итерации 2 — фильтры режима и экран предзагрузки перед стартом.
 */

import { STEP_MS, STEPS, ROUNDS, roundScore, stepPoints, nearMissKind } from './scoring.js';

export const SCREEN = {
  START: 'start',
  LOADING: 'loading',
  ROUND: 'round',
  REVEAL: 'reveal',
  FINAL: 'final',
  ERROR: 'error',
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
     * Фильтры режима.
     * age: 'family' — только семейное; '18plus' — семейное И взрослое.
     * genres: пустой массив = все жанры (режим Random).
     */
    this.filters = { age: 'family', genres: [] };

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
    /** Ступени, которые игрок уже слышал. */
    this.heardSteps = new Set();
    /** Догадки текущего раунда. */
    this.guesses = [];
  }

  /* ---------------------------------------------------------------- */
  /* Фильтры режима                                                    */
  /* ---------------------------------------------------------------- */

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

  /** Random = сброс всех жанровых фильтров (возраст остаётся выбором игрока). */
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

  /* ---------------------------------------------------------------- */
  /* Партия                                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Готовит партию. Треки выбираются сразу, но экран переключается на
   * LOADING: игра не стартует, пока все пять не декодированы.
   * @returns {{picked: object[], spares: object[][]}}
   */
  prepare() {
    const { picked, spares } = this.catalog.pickGame(this.filters, ROUNDS);
    this.tracks = picked;
    this.spares = spares;
    this.roundIndex = 0;
    this.step = 0;
    this.results = [];
    this.loadProgress = { done: 0, total: ROUNDS };
    this.loadNote = null;
    this._resetRoundTiming();
    this.screen = SCREEN.LOADING;
    this._emit();
    return { picked, spares };
  }

  setLoadProgress(done, total) {
    this.loadProgress = { done, total };
    this._emit();
  }

  /** Все треки готовы — партия начинается. */
  begin(tracks, note = null) {
    if (tracks) this.tracks = tracks;
    this.loadNote = note;
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
    return STEP_MS[this.step];
  }

  get stepValue() {
    return stepPoints(this.step);
  }

  get isLastStep() {
    return this.step >= STEPS - 1;
  }

  get totalScore() {
    return this.results.reduce((s, r) => s + r.total, 0);
  }

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

  /**
   * Игрок выбрал трек из списка.
   * @returns {{correct:boolean, near:'artist'|'title'|null, ended:boolean}}
   */
  guess(track) {
    const answer = this.track;
    if (!answer) return { correct: false, near: null, ended: false };

    if (track.id === answer.id) {
      this._closeRound(true);
      return { correct: true, near: null, ended: true };
    }

    this.guesses.push(track);
    const near = nearMissKind(track, answer);

    // Неверный ответ открывает следующую ступень — как «Өткізу».
    // Это делает 7 ступеней = 7 попыток и закрывает перебор каталога.
    this.bonusVoid = true;
    const ended = this._advanceStep();
    return { correct: false, near, ended };
  }

  /** «Өткізу»: открыть следующую ступень. */
  skip() {
    this.guesses.push(null);
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
    });
    this.results.push({
      track: this.track,
      level: this.roundIndex + 1,
      solved,
      stepIndex: this.step,
      guesses: this.guesses.slice(),
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
