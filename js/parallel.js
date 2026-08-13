/*
 * parallel.js — управление рабочими потоками из главного.
 *
 * Главный поток физику НЕ считает. Причина простая: пока он считает, он не
 * рисует и не отвечает на мышь. Он только раздаёт команду «шаг» и получает
 * сообщение о готовности, а рисует по снимку предыдущего состояния — так
 * счёт и отрисовка идут одновременно, а не по очереди.
 *
 * Работает только при включённой изоляции источника (COOP/COEP), иначе
 * SharedArrayBuffer недоступен и делить память не с кем. Отсюда serve.py.
 */
(function (root) {
  'use strict';

  function available() {
    return typeof SharedArrayBuffer !== 'undefined' &&
           typeof Worker !== 'undefined' &&
           (typeof crossOriginIsolated === 'undefined' || crossOriginIsolated);
  }

  function reason() {
    if (typeof Worker === 'undefined') return 'нет Worker';
    if (typeof SharedArrayBuffer === 'undefined')
      return 'нет SharedArrayBuffer — нужны заголовки COOP/COEP (serve.py)';
    if (typeof crossOriginIsolated !== 'undefined' && !crossOriginIsolated)
      return 'страница не изолирована (COOP/COEP) — запустите через serve.py';
    return null;
  }

  /*
   * cfg: { fluid, solid, threads, version, onReady }
   * fluid уже создан над общей ареной, solid — над общим буфером поля.
   */
  function Pool(cfg) {
    this.f = cfg.fluid;
    this.nT = cfg.threads;
    this.ready = false;
    this.busy = false;
    this.onStepDone = null;

    var PS = root.ParStep;
    this.ctrlBuf = new SharedArrayBuffer(PS.C_SIZE * 4);
    this.parBuf = new SharedArrayBuffer(PS.P_SIZE * 8);
    this.boundsBuf = new SharedArrayBuffer(64 * 4);
    this.timesBuf = new SharedArrayBuffer(64 * 8);
    this.ctrl = new Int32Array(this.ctrlBuf);
    this.params = new Float64Array(this.parBuf);
    this.bounds = new Int32Array(this.boundsBuf);
    this.times = new Float64Array(this.timesBuf);
    this.share = new Float64Array(this.nT);
    for (var i = 0; i < this.nT; i++) this.share[i] = 1 / this.nT;

    var self = this, got = 0;
    this.workers = [];
    for (var id = 0; id < this.nT; id++) {
      var w = new Worker('js/worker.js?v=' + cfg.version);
      w.onmessage = function (e) {
        if (e.data.msg === 'ready') { if (++got === self.nT) { self.ready = true; cfg.onReady(); } }
        else if (e.data.msg === 'done') { self.busy = false; if (self.onStepDone) self.onStepDone(); }
      };
      w.onerror = function (e) { cfg.onError && cfg.onError(e.message || 'ошибка воркера'); };
      w.postMessage({
        cmd: 'init', v: cfg.version, id: id, nT: this.nT,
        arena: this.f.arena.buf, ctrl: this.ctrlBuf, params: this.parBuf,
        bounds: this.boundsBuf, times: this.timesBuf,
        dist: cfg.solid.dist.buffer, snx: cfg.solid.nx, sny: cfg.solid.ny,
        scell: cfg.solid.cell,
        width: this.f.width, height: this.f.height, spacing: this.f.dp,
        h: this.f.h, max: this.f.max
      });
      this.workers.push(w);
    }
  }

  /* Запустить шаг. Возвращает false, если предыдущий ещё не закончился. */
  Pool.prototype.step = function (dt) {
    if (!this.ready || this.busy) return false;
    var PS = root.ParStep;
    PS.rebalance(this.bounds, this.times, this.f.n, this.nT, this.share);
    // средний вес налитого считает главный поток: одна свёртка по частицам,
    // рабочим она приходит вместе с остальными параметрами
    this.f.updateAmbient();
    PS.writeParams(this.params, this.f, dt);
    Atomics.store(this.ctrl, PS.C_N, this.f.n);
    this.busy = true;
    Atomics.store(this.ctrl, PS.C_CMD, Atomics.load(this.ctrl, PS.C_CMD) + 1);
    Atomics.notify(this.ctrl, PS.C_CMD);
    return true;
  };

  Pool.prototype.dispose = function () {
    var PS = root.ParStep;
    Atomics.store(this.ctrl, PS.C_QUIT, 1);
    Atomics.store(this.ctrl, PS.C_CMD, Atomics.load(this.ctrl, PS.C_CMD) + 1);
    Atomics.notify(this.ctrl, PS.C_CMD);
    for (var i = 0; i < this.workers.length; i++) this.workers[i].terminate();
    this.workers.length = 0;
    this.ready = false;
  };

  /* Сколько чистой работы досталось каждому потоку — для статистики. */
  Pool.prototype.load = function () {
    var out = [];
    for (var i = 0; i < this.nT; i++)
      out.push({ ms: this.times[i * 8], n: this.bounds[i + 1] - this.bounds[i] });
    return out;
  };

  root.Parallel = { available: available, reason: reason, Pool: Pool };
}(typeof self !== 'undefined' ? self : this));
