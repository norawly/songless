/**
 * Óleńsiz — лидерборды на Google Apps Script + Google Sheets.
 *
 * Это единственный «сервер» проекта. Сайт статичный, поэтому вся проверка
 * результата обязана происходить здесь: клиентская валидация против намеренного
 * читера не работает в принципе (см. SCORING.md §1.4).
 *
 * Сервисный аккаунт с JSON-ключом здесь применять нельзя — на статическом сайте
 * ключ оказался бы в исходнике. Apps Script Web App с доступом «Anyone» не
 * требует никаких ключей на клиенте, только URL.
 *
 * Пошаговая инструкция по установке — в SETUP.md.
 *
 * Таблица считается по СРЕЗАМ (блок H2): срез = категория + режим подачи +
 * возрастной фильтр, например `random|expert|family`. Результаты разных
 * режимов несопоставимы — в экспертном очки в 1,8 раза выше, — поэтому общий
 * список был бы бессмысленным.
 *
 * Эндпоинты:
 *   GET  ?action=top&slice=random|normal|family&limit=7
 *        → { ok:true, slice, allTime:[...], today:[...], categories:[{slice,count}] }
 *   POST { action:'submit', … }
 *        → { ok:true, nick, placeAllTime, placeToday } либо { ok:false, error }
 *
 * ВАЖНО про CORS: Apps Script не обрабатывает preflight (OPTIONS), поэтому
 * клиент шлёт POST с Content-Type: text/plain;charset=utf-8 — это «простой»
 * CORS-запрос, для которого preflight не нужен. Тело всё равно JSON и читается
 * из e.postData.contents.
 */

/* ====================================================================== */
/* Настройки                                                              */
/* ====================================================================== */

/** Имя листа, куда пишутся результаты. Создастся автоматически. */
var SHEET_NAME = 'scores';

/** Теоретический максимум за партию. Должен совпадать с MAX_GAME_SCORE
 *  в src/scoring.js (5 раундов × 2250). Всё выше — отбрасываем. */
var MAX_GAME_SCORE = 11250;

/** Максимум за один раунд (лучшая ступень экспертного режима с бонусом). */
var MAX_ROUND_SCORE = 2250;

/** Базовые цены ступеней и множители режимов — копия src/scoring.js.
 *  Нужны, чтобы отсечь раунд, который дороже потолка своей ступени. */
var MODES = {
  normal: { points: [1000, 720, 520, 380, 280, 200], mult: 1.0 },
  expert: { points: [1000, 700, 500, 350, 250, 180, 130], mult: 1.8 }
};

/** Доля ступени, которую максимум добавляет бонус за скорость. */
var BONUS_FRACTION = 0.25;

/** Имя гостя, если игрок не подписался. К нему добавляется порядковый номер. */
var GUEST_NAME = 'Qonaq';

/** Раундов в партии. */
var ROUNDS = 5;

/** Сколько строк отдавать по умолчанию в каждом топе. */
var DEFAULT_TOP = 7;

/** Часовой пояс, по которому считается «сегодня». */
var TIMEZONE = 'Asia/Almaty';

/** Не чаще одной отправки в N секунд с одного sessionHash. */
var RATE_LIMIT_SECONDS = 20;

/** Одна сессия = одна запись. Поставь false, чтобы разрешить несколько партий. */
var ONE_SUBMIT_PER_SESSION = true;

/** Корни нецензурной лексики. Дублируют список из src/leaderboard.js:
 *  клиенту доверять нельзя, фильтр обязан работать и на сервере. */
var PROFANITY = [
  'хуй', 'хуе', 'хуё', 'пизд', 'ебат', 'ебал', 'ебан', 'ебуч', 'еблан',
  'бляд', 'блять', 'сука', 'мудак', 'мудил', 'гандон', 'пидор', 'пидар',
  'залуп', 'дроч', 'манда', 'ублюд', 'шлюх', 'нахуй', 'похуй',
  'котак', 'котақ', 'амжырт', 'амшелек', 'сікт', 'енең', 'енен',
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'nigg', 'asshole', 'whore'
];

/* ====================================================================== */
/* Точки входа                                                            */
/* ====================================================================== */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};
    if (params.action === 'top' || !params.action) {
      var limit = clampInt(params.limit, 1, 200, DEFAULT_TOP);
      var slice = normalizeSlice(params.slice);
      var boards = readBoards(limit, slice);
      return json({
        ok: true,
        slice: slice,
        allTime: boards.allTime,
        today: boards.today,
        categories: boards.categories
      });
    }
    return json({ ok: false, error: 'unknown-action' });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  // Блокировка: две одновременные отправки не должны затереть друг друга.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return json({ ok: false, error: 'busy' });
  }

  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ ok: false, error: 'empty-body' });
    }

    var body;
    try {
      body = JSON.parse(e.postData.contents);
    } catch (err) {
      return json({ ok: false, error: 'bad-json' });
    }

    if (body.action !== 'submit') return json({ ok: false, error: 'unknown-action' });

    var check = validate(body);
    if (!check.ok) return json(check);

    var sheet = getSheet();
    var sessionHash = String(body.sessionHash || '').slice(0, 64);

    var recent = findRecentBySession(sheet, sessionHash);
    if (recent) {
      if (ONE_SUBMIT_PER_SESSION) return json({ ok: false, error: 'already-submitted' });
      var ageSec = (new Date().getTime() - recent.getTime()) / 1000;
      if (ageSec < RATE_LIMIT_SECONDS) return json({ ok: false, error: 'rate-limited' });
    }

    var slice = normalizeSlice(body.slice);
    var nick = check.nick;
    if (!nick) nick = nextGuestName(sheet);   // не подписался — станет Qonaq N

    sheet.appendRow([
      new Date(),                // A. время записи на сервере (авторитетное)
      nick,                      // B. ник (санитизированный)
      check.score,               // C. общий счёт
      check.roundsText,          // D. разбивка по раундам
      sessionHash,               // E. хэш сессии
      String(body.date || ''),   // F. время по часам клиента (справочно)
      String(body.v || ''),      // G. версия клиента
      slice                      // H. срез: категория|режим|возраст
    ]);

    var places = placesOf(check.score, slice);
    return json({
      ok: true,
      nick: nick,
      slice: slice,
      placeAllTime: places.allTime,
      placeToday: places.today
    });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ====================================================================== */
/* Валидация — единственная настоящая защита в системе                    */
/* ====================================================================== */

function validate(body) {
  // Пустой ник допустим: игрок не обязан подписываться, ему выдадут «Qonaq N».
  var nick = sanitizeNick(body.nick);
  if (nick.length === 1) return { ok: false, error: 'nick-too-short' };
  if (nick && hasProfanity(nick)) return { ok: false, error: 'nick-bad' };

  var score = body.score;
  if (typeof score !== 'number' || !isFinite(score)) return { ok: false, error: 'bad-score' };
  if (score !== Math.floor(score)) return { ok: false, error: 'bad-score' };
  if (score < 0) return { ok: false, error: 'negative-score' };
  if (score > MAX_GAME_SCORE) return { ok: false, error: 'impossible-score' };

  var rounds = body.rounds;
  if (!rounds || rounds.length !== ROUNDS) return { ok: false, error: 'bad-rounds' };

  var sum = 0;
  var parts = [];
  for (var i = 0; i < rounds.length; i++) {
    var r = rounds[i] || {};
    var p = r.points;
    if (typeof p !== 'number' || !isFinite(p) || p !== Math.floor(p)) {
      return { ok: false, error: 'bad-round-points' };
    }
    if (p < 0 || p > MAX_ROUND_SCORE) return { ok: false, error: 'impossible-round' };

    var step = r.step;
    if (typeof step !== 'number' || step < 1 || step > 7) return { ok: false, error: 'bad-step' };
    // Раунд не может стоить больше потолка своей ступени в своём режиме.
    if (p > maxForStep(step, body.slice)) return { ok: false, error: 'round-exceeds-step-cap' };
    // Непойманный раунд обязан быть нулевым.
    if (r.solved === false && p !== 0) return { ok: false, error: 'unsolved-with-points' };

    sum += p;
    parts.push(r.level + ':' + step + ':' + p + (r.solved ? '+' : '-'));
  }

  if (sum !== score) return { ok: false, error: 'sum-mismatch' };
  return { ok: true, nick: nick, score: score, roundsText: parts.join(' | ') };
}

/**
 * Потолок раунда для ступени: база × (1 + бонус) × множитель режима.
 * Режим берём из среза; если срез не разобрать — считаем по самому щедрому,
 * иначе честный экспертный результат отвергался бы как невозможный.
 */
function maxForStep(step, slice) {
  var mode = modeOfSlice(slice);
  var best = 0;
  var ids = mode ? [mode] : ['normal', 'expert'];
  for (var i = 0; i < ids.length; i++) {
    var m = MODES[ids[i]];
    var pts = m.points[step - 1];
    if (pts === undefined) continue;              // в этом режиме такой ступени нет
    var cap = Math.round(pts * (1 + BONUS_FRACTION) * m.mult);
    if (cap > best) best = cap;
  }
  return best || MAX_ROUND_SCORE;
}

function modeOfSlice(slice) {
  var parts = String(slice || '').split('|');
  return MODES[parts[1]] ? parts[1] : null;
}

/**
 * Приводит срез к безопасному виду. В таблицу и в фильтр попадает только то,
 * что похоже на ключ среза, — произвольная строка от клиента сюда не пройдёт.
 */
function normalizeSlice(raw) {
  var s = String(raw == null ? '' : raw).slice(0, 120);
  s = s.replace(/[^a-z0-9+|:_-]/gi, '');
  var parts = s.split('|');
  var cat = parts[0] || 'random';
  var mode = MODES[parts[1]] ? parts[1] : 'normal';
  var age = (parts[2] === '18plus' || parts[2] === 'both') ? parts[2] : 'family';
  return cat + '|' + mode + '|' + age;
}

/**
 * Следующее имя гостя: Qonaq 1, Qonaq 2, …
 * Номер сквозной по всей таблице, чтобы два гостя не оказались тёзками.
 */
function nextGuestName(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return GUEST_NAME + ' 1';
  var values = sheet.getRange(2, 2, last - 1, 1).getValues();
  var max = 0;
  var re = new RegExp('^' + GUEST_NAME + '\\s+(\\d+)$');
  for (var i = 0; i < values.length; i++) {
    var m = re.exec(String(values[i][0]).trim());
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  return GUEST_NAME + ' ' + (max + 1);
}

/**
 * Санитизация ника. Отдельно глушим formula injection: Google Sheets исполняет
 * ячейку, начинающуюся с = + - @, как формулу.
 */
function sanitizeNick(raw) {
  var s = String(raw == null ? '' : raw);
  s = s.replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.substring(0, 20);
  s = s.replace(/^[=+\-@]+/, '');
  return s.trim();
}

/** Порядок важен: цифры-подмены разворачиваем ДО удаления небуквенного. */
function hasProfanity(nick) {
  var flat = String(nick || '').toLowerCase()
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e')
    .replace(/4/g, 'a').replace(/5/g, 's')
    .replace(/@/g, 'a').replace(/\$/g, 's')
    .replace(/[^a-zЀ-ӿ]/g, '');
  for (var i = 0; i < PROFANITY.length; i++) {
    if (flat.indexOf(PROFANITY[i]) !== -1) return true;
  }
  return false;
}

/* ====================================================================== */
/* Работа с таблицей                                                      */
/* ====================================================================== */

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['server_time', 'nick', 'score', 'rounds', 'session', 'client_date', 'v', 'slice']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function findRecentBySession(sheet, sessionHash) {
  if (!sessionHash) return null;
  var last = sheet.getLastRow();
  if (last < 2) return null;
  var n = Math.min(500, last - 1); // смотрим только хвост — этого достаточно
  var values = sheet.getRange(last - n + 1, 1, n, 5).getValues();
  for (var i = values.length - 1; i >= 0; i--) {
    if (String(values[i][4]) === sessionHash) return new Date(values[i][0]);
  }
  return null;
}

/** Строка «сегодня» в часовом поясе TIMEZONE. */
function dayKey(date) {
  return Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Оба топа за один проход по таблице.
 * «Сегодня» считается по серверному времени записи в TIMEZONE, а не по часам
 * клиента: клиентское время подделывается тривиально.
 */
function readBoards(limit, slice) {
  var sheet = getSheet();
  var last = sheet.getLastRow();
  if (last < 2) return { allTime: [], today: [], categories: [] };

  // A..H: время, ник, счёт, раунды, сессия, дата клиента, версия, срез
  var values = sheet.getRange(2, 1, last - 1, 8).getValues();
  var todayKey = dayKey(new Date());
  var all = [];
  var today = [];
  var counts = {};

  for (var i = 0; i < values.length; i++) {
    var score = Number(values[i][2]);
    // мусор в таблице (ручные правки, старые версии) просто пропускаем
    if (!isFinite(score) || score < 0 || score > MAX_GAME_SCORE) continue;

    // Записи до появления срезов считаем обычным Random — иначе они
    // потерялись бы совсем.
    var rowSlice = normalizeSlice(values[i][7] || 'random|normal|family');
    counts[rowSlice] = (counts[rowSlice] || 0) + 1;
    if (slice && rowSlice !== slice) continue;

    var when = values[i][0] ? new Date(values[i][0]) : null;
    var row = {
      nick: String(values[i][1]),
      score: score,
      date: when ? when.toISOString() : ''
    };
    all.push(row);
    if (when && dayKey(when) === todayKey) today.push(row);
  }

  // При равенстве очков выше тот, кто поставил результат раньше.
  var byScore = function (a, b) {
    return b.score - a.score || (a.date < b.date ? -1 : 1);
  };
  all.sort(byScore);
  today.sort(byScore);

  var categories = [];
  for (var key in counts) {
    if (counts.hasOwnProperty(key)) categories.push({ slice: key, count: counts[key] });
  }
  categories.sort(function (a, b) { return b.count - a.count; });

  return {
    allTime: all.slice(0, limit),
    today: today.slice(0, limit),
    categories: categories.slice(0, 40)
  };
}

/** Место игрока в СВОЁМ срезе — и за всё время, и за сегодня. */
function placesOf(score, slice) {
  var boards = readBoards(100000, slice);
  var place = function (rows) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].score <= score) return i + 1;
    }
    return rows.length + 1;
  };
  return { allTime: place(boards.allTime), today: place(boards.today) };
}

/* ====================================================================== */
/* Утилиты                                                                */
/* ====================================================================== */

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function clampInt(v, min, max, fallback) {
  var n = parseInt(v, 10);
  if (isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* ====================================================================== */
/* Ручная проверка из редактора Apps Script (Run → testEndpoints)         */
/* ====================================================================== */

function testEndpoints() {
  function post(nick, score, rounds) {
    return doPost({
      postData: {
        contents: JSON.stringify({
          action: 'submit', nick: nick, score: score, rounds: rounds,
          slice: 'random|normal|family',
          sessionHash: 'test-' + Math.random(), date: new Date().toISOString(), v: 3
        })
      }
    }).getContent();
  }

  var good = [
    { level: 1, step: 1, points: 1250, solved: true },
    { level: 2, step: 7, points: 0, solved: false },
    { level: 3, step: 7, points: 0, solved: false },
    { level: 4, step: 7, points: 0, solved: false },
    { level: 5, step: 7, points: 0, solved: false }
  ];

  // 1. Честная запись — должно быть ok:true
  Logger.log('честный:      ' + post('=HYPERLINK("evil")  Тест', 1250, good));

  // 1б. Без имени — должен появиться «Qonaq N»
  Logger.log('гость:        ' + post('', 1250, good));

  // 2. Оба топа
  Logger.log('топы:         ' + doGet({ parameter: { action: 'top', limit: '5', slice: 'random|normal|family' } }).getContent());

  // 3. Счёт выше максимума — должно быть impossible-score
  var cheat = [1, 2, 3, 4, 5].map(function (l) {
    return { level: l, step: 1, points: 199999, solved: true };
  });
  Logger.log('накрутка:     ' + post('cheater', 999999, cheat));

  // 4. Мат в нике — должно быть nick-bad
  Logger.log('мат в нике:   ' + post('сука', 1250, good));

  // 5. Сумма раундов не сходится — должно быть sum-mismatch
  Logger.log('sum-mismatch: ' + post('Тест2', 5000, good));
}
