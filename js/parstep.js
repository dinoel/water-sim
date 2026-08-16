/*
 * parstep.js — параллельный шаг решателя.
 *
 * Никаких DOM и Worker API: файл одинаково грузится в браузерный воркер, в
 * worker_threads под node и в главный поток. Поэтому одна и та же логика
 * проверяется тестами без браузера.
 *
 * Модель простая: все потоки равноправны и выполняют один и тот же код,
 * поделив частицы на непрерывные диапазоны индексов. Между фазами стоит
 * барьер. Это работает потому, что каждая фаза пишет ТОЛЬКО в ячейки своих
 * частиц, а читает чужие лишь те, что в этой фазе никто не меняет:
 *
 *   предсказание, столкновение с телом  -> пишет q своих
 *   сортировка                          -> одна на всех (поток 0), дёшево
 *   поиск соседей                       -> полный обход окрестности, а не
 *                                          симметричный: тот писал бы в
 *                                          списки чужих частиц
 *   плотность и лямбда                  -> пишет rho/lam/кэш своих
 *   поправка позиции                    -> читает чужие lam (уже готовы)
 *   применение поправки                 -> двигает q своих
 *
 * Главный поток барьеры не трогает вообще: Atomics.wait в нём запрещён.
 * Он лишь поднимает флаг «сделай шаг» и получает сообщение о готовности.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ParStep = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* --- раскладка управляющего блока (Int32Array) --- */
  var C_GEN = 0;      // поколение барьера
  var C_COUNT = 1;    // сколько потоков дошло до барьера
  var C_CMD = 2;      // поколение команды от главного потока
  var C_QUIT = 3;     // 1 — завершаться
  var C_N = 4;        // сколько частиц в этом шаге
  var C_SIZE = 8;

  /* --- параметры, которые главный поток передаёт рабочим каждый шаг --- */
  var PARAMS = [
    'gravityX', 'gravityY', 'iterations', 'substeps', 'relax', 'sor',
    'maxCorrection', 'tensionLimit', 'pipeTension', 'pipeFlow', 'pipeDrive', 'pipeDamping', 'sCorrK',
    'viscosity', 'vorticity',
    'cohesion', 'curvature', 'adhesion', 'friction', 'foamRate',
    'maxSpeed', 'drag', 'buoyancy', 'ambientG', 'wetClimb'
  ];
  var P_DT = PARAMS.length;          // шаг по времени кладём следом
  var P_SIZE = PARAMS.length + 4;

  function writeParams(arr, fluid, dt) {
    for (var i = 0; i < PARAMS.length; i++) arr[i] = fluid[PARAMS[i]];
    arr[P_DT] = dt;
  }
  function readParams(arr, fluid) {
    for (var i = 0; i < PARAMS.length; i++) fluid[PARAMS[i]] = arr[i];
    return arr[P_DT];
  }

  /*
   * Барьер. Сначала крутимся вхолостую: усыпить и разбудить поток стоит
   * несколько микросекунд, а фазы здесь короткие, и чаще всего остальные
   * подходят к барьеру почти одновременно. Если не дождались — засыпаем.
   */
  /*
   * Учёт простоя. Включается снаружи (PS.probe = {t:Float64Array, id, now})
   * и нужен ровно для одного вопроса: потоки стоят на барьерах потому, что
   * барьер дорог сам по себе, или потому, что кто-то из них медленнее?
   */
  /*
   * Сколько раз заглянуть в общую ячейку перед тем, как заснуть. Важно не
   * само число, а то, что между заглядываниями стоит РАСТУЩАЯ локальная
   * пауза: обращений к общей памяти мало (значит её линия не гоняется между
   * ядрами), а суммарное ожидание длинное — хватает, чтобы дождаться
   * отставший поток и не платить за пробуждение через ядро ОС.
   */
  var SPIN = 400;
  var SPIN_CAP = 4096;
  var sink = 0;                         // чтобы пауза не выбрасывалась оптимизатором
  var waitAcc = new Float64Array(64);   // накопленное ожидание по потокам
  var curId = 0, measuring = false;

  function barrier(ctrl, nT) {
    if (nT < 2) return;
    if (measuring) {
      var t0 = now();
      barrierRaw(ctrl, nT);
      waitAcc[curId] += now() - t0;
      return;
    }
    barrierRaw(ctrl, nT);
  }

  function barrierRaw(ctrl, nT) {
    var gen = Atomics.load(ctrl, C_GEN);
    if (Atomics.add(ctrl, C_COUNT, 1) === nT - 1) {
      Atomics.store(ctrl, C_COUNT, 0);
      Atomics.store(ctrl, C_GEN, gen + 1);
      Atomics.notify(ctrl, C_GEN);
      return;
    }
    /*
     * Ожидание с расширяющейся паузой.
     *
     * Здесь две беды, и они тянут в разные стороны. Если крутиться, читая
     * общую ячейку вплотную, её линия кэша непрерывно гоняется между
     * ядрами — и тормозят как раз те потоки, которые ещё считают (суммарная
     * работа росла втрое от числа потоков). Если же сразу засыпать, то
     * платишь пробуждением через ядро ОС, а барьеров за кадр несколько
     * десятков — и медианное время шага становится вдвое хуже минимального.
     *
     * Поэтому проверяем часто в начале (обычный разброс прихода к барьеру
     * невелик) и всё реже дальше, разделяя проверки локальной паузой,
     * которая общую память не трогает. Не дождались — только тогда спать.
     */
    var delay = 1;
    for (var spin = 0; spin < SPIN; spin++) {
      if (Atomics.load(ctrl, C_GEN) !== gen) return;
      for (var d = 0; d < delay; d++) sink += d;
      if (delay < SPIN_CAP) delay <<= 1;
    }
    while (Atomics.load(ctrl, C_GEN) === gen) Atomics.wait(ctrl, C_GEN, gen);
  }

  /* Диапазон частиц потока: непрерывный кусок, остаток размазан по первым. */
  function lo(n, id, nT) { var q = (n / nT) | 0, r = n % nT; return id * q + (id < r ? id : r); }

  var now = (typeof performance !== 'undefined' && performance.now)
    ? function () { return performance.now(); }
    : function () { return Date.now(); };

  /*
   * Пересчёт границ диапазонов по фактической скорости потоков.
   *
   * У современных мобильных процессоров ядра разные: часть потоков садится
   * на «экономичные» ядра и считает вдвое медленнее. При равном делении
   * частиц все остальные простаивают на каждом барьере, ожидая самый
   * медленный поток, — а барьеров за кадр несколько десятков.
   *
   * Поэтому каждый поток сообщает, сколько чистого времени (без ожидания)
   * он потратил на свои частицы, и доля пересчитывается пропорционально
   * скорости. Сглаживание нужно, чтобы границы не прыгали от случайного
   * выброса. На результат симуляции деление не влияет: расчёт каждой
   * частицы от него не зависит, поэтому числа остаются побитово теми же.
   */
  function rebalance(bounds, times, n, nT, share) {
    var i, sum = 0, ok = true;
    for (i = 0; i < nT; i++) {
      var cnt = bounds[i + 1] - bounds[i], t = times[i * 8];
      if (cnt < 8 || !(t > 0.02)) { ok = false; break; }
      times[i * 8 + 1] = cnt / t;                 // частиц в миллисекунду
    }
    if (!ok) {                                     // мало данных — делим поровну
      for (i = 0; i <= nT; i++) bounds[i] = lo(n, i, nT);
      return;
    }
    for (i = 0; i < nT; i++) sum += times[i * 8 + 1];
    var acc = 0;
    for (i = 0; i < nT; i++) {
      var want = times[i * 8 + 1] / sum;
      share[i] += (want - share[i]) * 0.35;        // сглаживание
      acc += share[i];
    }
    var pos = 0;
    bounds[0] = 0;
    for (i = 0; i < nT - 1; i++) {
      pos += n * share[i] / acc;
      var b = Math.round(pos);
      if (b < bounds[i] + 4) b = bounds[i] + 4;    // никого не оставляем без работы
      if (b > n) b = n;
      bounds[i + 1] = b;
    }
    bounds[nT] = n;
    for (i = nT; i > 0; i--) if (bounds[i - 1] > bounds[i]) bounds[i - 1] = bounds[i];
  }

  /*
   * Один полный шаг физики силами nT потоков. Вызывается в КАЖДОМ потоке
   * с одинаковыми аргументами, кроме id.
   */
  function step(f, ctrl, id, nT, dt, bounds, times) {
    var n = f.n;
    if (n === 0) {
      /*
       * Замер надо обнулить, а не просто выйти. Иначе на пустой сцене
       * остаётся последнее большое значение, регулятор считает, что физика
       * перегружена, и держит кран закрытым — навсегда: воды нет, значит и
       * время шага никогда не пересчитается. Слил воду — и кран больше не
       * включается.
       */
      if (times) { times[id * 8] = 0; times[id * 8 + 2] = 0; }
      return;
    }
    var i0, i1;
    if (bounds && bounds[nT] === n) { i0 = bounds[id]; i1 = bounds[id + 1]; }
    else { i0 = lo(n, id, nT); i1 = lo(n, id + 1, nT); }
    var tStart = 0;
    if (times) { tStart = now(); waitAcc[id] = 0; curId = id; measuring = true; }
    var sub = Math.max(1, f.substeps | 0), h = dt / sub;
    var iters = f.iterations, foamDone = false;

    for (var s = 0; s < sub; s++) {
      f.phasePredict(i0, i1, h);
      if (f.solid) f.phaseCCD(i0, i1);
      barrier(ctrl, nT);

      // сортировка переставляет ВСЕ частицы — делает один поток
      if (id === 0) f.sortParticles();
      barrier(ctrl, nT);

      f.findNeighborsRange(i0, i1);
      f.phaseBoundaryFull(i0, i1, id);
      // вспенивание считаем до проекции: она гасит скорости удара
      if (!foamDone) f.computeFoam(i0, i1, dt);
      barrier(ctrl, nT);

      /*
       * Барьер нужен между любыми двумя фазами, где первая ЧИТАЕТ чужие
       * данные, а вторая их ПИШЕТ. Здесь это:
       *   плотность -> поправка   (поправка читает чужие lam)
       *   поправка  -> применение (поправка читает чужие q, применение их пишет)
       *   применение -> плотность (плотность читает чужие q)
       * Последний барьер после финальной итерации не нужен: расчёт скоростей
       * трогает только свои частицы.
       */
      for (var iter = 0; iter < iters; iter++) {
        f.phaseDensity(i0, i1, iter, id);
        barrier(ctrl, nT);
        f.phaseDeltaP(i0, i1);
        barrier(ctrl, nT);
        f.phaseApply(i0, i1, id);
        if (iter < iters - 1) {
          f.phaseBoundaryFast(i0, id);
          barrier(ctrl, nT);
        }
      }

      f.phaseVelocity(i0, i1, h);
      foamDone = true;
    }

    // здесь барьер нужен: силы читают позиции и скорости чужих частиц
    barrier(ctrl, nT);
    f.phaseForces1(i0, i1);
    barrier(ctrl, nT);
    f.phaseForces2(i0, i1, dt);
    barrier(ctrl, nT);            // силы читают чужие v, а применение их пишет
    f.phaseForcesApply(i0, i1, dt);
    barrier(ctrl, nT);
    if (id === 0) f.projectPipeFlow(dt);
    barrier(ctrl, nT);

    if (times) {
      measuring = false;
      var total = now() - tStart;
      times[id * 8] = total - waitAcc[id];   // чистая работа, без ожидания
      times[id * 8 + 2] = total;             // полная длительность шага
      /*
       * Именно это и есть честная длительность шага физики. По времени от
       * команды до сообщения «готово» её мерить нельзя: сообщение ждёт,
       * пока главный поток освободится от отрисовки, и добавляет к замеру
       * чужое время.
       */
    }

    if (id === 0) {
      var tot = 0;
      for (var w = 0; w < nT; w++) tot += f.compAcc[w * 16];   // шаг = SLOT_STRIDE
      f.stats.compression = tot / n;
    }
  }

  /* Цикл рабочего потока: ждём команду, делаем шаг, сообщаем о готовности. */
  function workerLoop(f, ctrl, params, id, nT, onDone, bounds, times) {
    var seen = 0;
    for (;;) {
      while (Atomics.load(ctrl, C_CMD) === seen) {
        if (Atomics.load(ctrl, C_QUIT)) return;
        Atomics.wait(ctrl, C_CMD, seen, 100);
      }
      seen = Atomics.load(ctrl, C_CMD);
      if (Atomics.load(ctrl, C_QUIT)) return;
      f.n = Atomics.load(ctrl, C_N);
      var dt = readParams(params, f);
      step(f, ctrl, id, nT, dt, bounds, times);
      barrier(ctrl, nT);
      if (id === 0 && onDone) onDone();
    }
  }

  return {
    C_GEN: C_GEN, C_COUNT: C_COUNT, C_CMD: C_CMD, C_QUIT: C_QUIT, C_N: C_N,
    C_SIZE: C_SIZE, P_SIZE: P_SIZE, P_DT: P_DT, PARAMS: PARAMS,
    writeParams: writeParams, readParams: readParams,
    barrier: barrier, step: step, workerLoop: workerLoop, lo: lo,
    rebalance: rebalance, waitOf: function (id) { return waitAcc[id]; },
    setSpin: function (v) { SPIN = v; }
  };
}));
