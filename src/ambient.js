/**
 * Фоновая музыка стартового экрана.
 *
 * Музыка СИНТЕЗИРУЕТСЯ прямо в браузере, а не берётся файлом. Причины две, и
 * обе жёсткие: в репозитории не должно быть аудиофайлов, а чужой трек с
 * какого-нибудь CDN — это чужие права на сайте, который индексируется.
 * Осциллятор ничьих прав не нарушает и весит ноль байт.
 *
 * Звучание намеренно не казахское и никак не связано с каталогом: это не
 * подсказка и не часть игры, а воздух в комнате. Медленный пад из трёх
 * расстроенных пил через низкий фильтр, мягкий пульс раз в такт и редкие
 * капли поверх. Аккорды идут по кругу из четырёх — минорный колор, который
 * не спорит с лаймовым акцентом интерфейса.
 *
 * Играет через тот же анализатор, что и превью треков, поэтому фон-эквалайзер
 * на стартовом экране движется под неё, а не стоит мёртвым.
 *
 * Автозапуск: браузеры не дают завести AudioContext до жеста пользователя,
 * поэтому мы ждём первого касания страницы. Кнопка звука в шапке помнит
 * выбор — выключил один раз, больше не услышит.
 */

const KEY = 'olensiz:ambient';

/** Am — F — C — G, четыре такта по восемь секунд. Ноты в Гц. */
const CHORDS = [
  [220.00, 261.63, 329.63],   // Am
  [174.61, 220.00, 261.63],   // F
  [261.63, 329.63, 392.00],   // C
  [196.00, 246.94, 293.66],   // G
];

const CHORD_S = 8;
const PULSE_S = 1.5;

export function ambientAllowed() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function rememberAmbient(on) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* приватный режим */
  }
}

export class Ambient {
  /** @param {import('./audio.js').AudioEngine} engine */
  constructor(engine) {
    this.engine = engine;
    this.nodes = null;
    this.timer = 0;
    this.chord = 0;
    this.playing = false;
  }

  /** Пад, фильтр и общий гейн. Строятся один раз на весь сеанс. */
  _build(ctx, dest) {
    const out = ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(dest);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 700;
    filter.Q.value = 0.6;
    filter.connect(out);

    // Медленное движение среза — от него пад «дышит», и эквалайзер фона
    // шевелится даже там, где нот не меняется.
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.05;
    lfoGain.gain.value = 260;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    // Три голоса пада: слегка расстроены между собой, оттого звук живой.
    const voices = [];
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.detune.value = (i - 1) * 7;
      const g = ctx.createGain();
      g.gain.value = 0.16;
      osc.connect(g).connect(filter);
      osc.start();
      voices.push({ osc, gain: g });
    }

    return { out, filter, voices, lfo };
  }

  /** Мягкий низкий пульс: даёт эквалайзеру удар, по которому он дышит. */
  _pulse(ctx, dest, t) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.16);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.5, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + 0.6);
  }

  /** Редкая «капля» в верхнем регистре — чтобы фон не был совсем плоским. */
  _drop(ctx, dest, t, hz) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = hz;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.09, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    osc.connect(g).connect(dest);
    osc.start(t);
    osc.stop(t + 1.7);
  }

  /** Переставляет пад на следующий аккорд круга. */
  _next(ctx) {
    const t = ctx.currentTime;
    const chord = CHORDS[this.chord % CHORDS.length];
    this.chord++;
    this.nodes.voices.forEach((v, i) => {
      v.osc.frequency.setTargetAtTime(chord[i % chord.length], t, 1.2);
    });
    // Капля берёт ноту аккорда двумя октавами выше — всегда «в тональности».
    this._drop(ctx, this.nodes.filter, t + 1.2, chord[(this.chord + 1) % chord.length] * 4);
  }

  start() {
    if (this.playing) return;
    const ctx = this.engine.ensureContext();
    const dest = this.engine.busIn;
    if (!ctx || !dest) return;

    if (!this.nodes) this.nodes = this._build(ctx, dest);
    this.playing = true;

    const now = ctx.currentTime;
    this.nodes.out.gain.cancelScheduledValues(now);
    this.nodes.out.gain.setValueAtTime(Math.max(0.0001, this.nodes.out.gain.value), now);
    this.nodes.out.gain.linearRampToValueAtTime(0.5, now + 2.5);

    this._next(ctx);
    let beat = 0;
    this.timer = setInterval(() => {
      if (!this.playing) return;
      const t = this.engine.ctx.currentTime + 0.05;
      this._pulse(this.engine.ctx, this.nodes.filter, t);
      beat++;
      if (beat % Math.round(CHORD_S / PULSE_S) === 0) this._next(this.engine.ctx);
    }, PULSE_S * 1000);
  }

  /** Уводит фон в тишину. Узлы остаются — включить обратно дешевле, чем строить. */
  stop(fadeS = 1.2) {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this.timer);
    this.timer = 0;
    const ctx = this.engine.ctx;
    if (!ctx || !this.nodes) return;
    const now = ctx.currentTime;
    const g = this.nodes.out.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0.0001, now + fadeS);
  }
}
