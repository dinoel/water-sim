/*
 * Проверка многопоточного решателя без браузера: node test/parallel.js
 *
 * Главное здесь — не скорость, а совпадение результата. Потоки делят частицы
 * по диапазонам индексов, и если хоть одна фаза пишет за пределы своего
 * диапазона или читает то, что сосед ещё не досчитал, результат разойдётся с
 * однопоточным. Поэтому сравниваем побитово: тот же порядок обхода соседей,
 * та же арифметика — расхождений быть не должно вообще.
 */
var os = require('os');
var path = require('path');
var { Worker } = require('worker_threads');
var SDF = require('../js/sdf.js');
var WS = require('../js/solver.js');
var PS = require('../js/parstep.js');

var fails = 0, checks = 0;
function ok(name, cond, info) {
  checks++;
  if (!cond) { fails++; console.log('  FAIL  ' + name + (info ? '   ' + info : '')); }
  else console.log('  ok    ' + name + (info ? '   ' + info : ''));
}

var W = 8, H = 4.5, CELL = 0.025, MAXP = 60000;
var DP = +(process.env.DP || 0.045);       // DP=0.026 node test/parallel.js — плотнее
var STEPS = +(process.env.STEPS || 120);
var JS = path.join(__dirname, '..', 'js').replace(/\\/g, '/');

function makeSolid(distBuf) {
  var s = new SDF.Solid(Math.ceil(W / CELL), Math.ceil(H / CELL), CELL, distBuf);
  s.addBorder(3);
  s.paintRect(4.6, 2.6, 8.0, 2.75, 1);
  s.rebuild();
  return s;
}

function fill(f) { f.fillRect(0.2, 1.1, 3.2, 4.3, 0); }

/* ---------- эталон: один поток ---------------------------------------- */
function serial(steps) {
  var solid = makeSolid(null);
  var f = new WS.Fluid({ width: W, height: H, spacing: DP, maxParticles: MAXP, solid: solid });
  fill(f);
  for (var t = 0; t < steps; t++) f.step(1 / 60);
  return f;
}

/*
 * Тот же расчёт, но фазами и полным поиском соседей — как в многопоточном
 * режиме, только в одном потоке. Отделяет «ошибку многопоточности» от
 * «другого алгоритма поиска соседей».
 */
function phased(steps, nT) {
  var solid = makeSolid(null);
  var f = new WS.Fluid({ width: W, height: H, spacing: DP, maxParticles: MAXP, solid: solid });
  fill(f);
  var ctrl = new Int32Array(PS.C_SIZE);
  for (var t = 0; t < steps; t++) {
    for (var id = 0; id < nT; id++) PS.step(f, ctrl, id, 1, 1 / 60);   // nT=1: барьеров нет
  }
  return f;
}
function phasedOne(steps) {
  var solid = makeSolid(null);
  var f = new WS.Fluid({ width: W, height: H, spacing: DP, maxParticles: MAXP, solid: solid });
  fill(f);
  var ctrl = new Int32Array(PS.C_SIZE);
  for (var t = 0; t < steps; t++) PS.step(f, ctrl, 0, 1, 1 / 60);
  return f;
}

/* ---------- многопоточный прогон -------------------------------------- */
/*
 * warmSerial — сколько шагов главный поток считает САМ, прежде чем к нему
 * подключатся рабочие. Это не выдумка: пул воркеров поднимается несколько
 * кадров, и всё это время приложение считает физику в одиночку. Именно на
 * этом переходе ловилась ошибка — сортировка меняла местами ссылки на
 * буферы, у главного потока они уезжали, у воркеров оставались исходными,
 * и результат ломался в зависимости от ЧЁТНОСТИ числа перестановок.
 */
function parallel(steps, nT, cb, warmSerial) {
  var cells = Math.ceil(W / CELL) * Math.ceil(H / CELL);
  var distBuf = new SharedArrayBuffer(cells * 4);
  var solid = makeSolid(distBuf);

  var gnxCells = 0;
  var probe = new WS.Fluid({ width: W, height: H, spacing: DP, maxParticles: MAXP });
  gnxCells = probe.gnx * probe.gny + 1;

  var arenaBuf = new SharedArrayBuffer(WS.Fluid.arenaBytes(MAXP, gnxCells));
  var ctrlBuf = new SharedArrayBuffer(PS.C_SIZE * 4);
  var parBuf = new SharedArrayBuffer(PS.P_SIZE * 8);
  var boundsBuf = new SharedArrayBuffer(64 * 4);
  var timesBuf = new SharedArrayBuffer(64 * 8);
  var ctrl = new Int32Array(ctrlBuf), params = new Float64Array(parBuf);
  var bounds = new Int32Array(boundsBuf), ptimes = new Float64Array(timesBuf);
  var share = new Float64Array(nT);
  for (var q0 = 0; q0 < nT; q0++) share[q0] = 1 / nT;

  var arena = { buf: arenaBuf, off: 0,
    f32: function (n) { var a = new Float32Array(this.buf, this.off, n); this.off += n * 4; return a; },
    i32: function (n) { var a = new Int32Array(this.buf, this.off, n); this.off += n * 4; return a; } };

  var f = new WS.Fluid({ width: W, height: H, spacing: DP, maxParticles: MAXP,
                         solid: solid, arena: arena });
  fill(f);

  var src = `
    const { parentPort, workerData } = require('worker_threads');
    const SDF = require('${JS}/sdf.js');
    const WS  = require('${JS}/solver.js');
    const PS  = require('${JS}/parstep.js');
    const d = workerData;
    let off = 0;
    const arena = { buf: d.arena,
      f32: function(n){ const a=new Float32Array(this.buf,off,n); off+=n*4; return a; },
      i32: function(n){ const a=new Int32Array(this.buf,off,n); off+=n*4; return a; } };
    const solid = new SDF.SolidView(d.snx, d.sny, d.scell, d.dist);
    const f = new WS.Fluid({ width:d.W, height:d.H, spacing:d.dp,
                             maxParticles:d.max, solid: solid, arena: arena });
    const ctrl = new Int32Array(d.ctrl), params = new Float64Array(d.params);
    const bounds = new Int32Array(d.bounds), times = new Float64Array(d.times);
    parentPort.postMessage('ready');
    PS.workerLoop(f, ctrl, params, d.id, d.nT, null, bounds, times);
  `;

  var warm = warmSerial || 0;
  for (var ws = 0; ws < warm; ws++) f.step(1 / 60);

  var workers = [], ready = 0, done = 0, t = warm, t0;
  for (var id = 1; id < nT; id++) {
    var w = new Worker(src, { eval: true, workerData: {
      arena: arenaBuf, ctrl: ctrlBuf, params: parBuf, dist: distBuf,
      snx: solid.nx, sny: solid.ny, scell: solid.cell,
      bounds: boundsBuf, times: timesBuf,
      W: W, H: H, dp: DP, max: MAXP, id: id, nT: nT } });
    w.on('message', function (m) { if (m === 'ready' && ++ready === nT - 1) begin(); });
    w.on('error', function (e) { console.log('  ОШИБКА В ВОРКЕРЕ: ' + e.message); process.exit(1); });
    workers.push(w);
  }
  if (nT === 1) setImmediate(begin);

  function begin() { t0 = process.hrtime.bigint(); stepsDone = 0; runStep(); }
  var stepsDone = 0;

  /* Главный поток барьеров не касается: он делает свою долю работы как
     поток 0 и на общем барьере просто ждёт остальных без Atomics.wait. */
  function runStep() {
    if (t >= steps) {
      var ms = Number(process.hrtime.bigint() - t0) / 1e6 / Math.max(1, stepsDone);
      Atomics.store(ctrl, PS.C_QUIT, 1);
      Atomics.store(ctrl, PS.C_CMD, Atomics.load(ctrl, PS.C_CMD) + 1);
      Atomics.notify(ctrl, PS.C_CMD);
      var prof = [];
      for (var q = 0; q < nT; q++)
        prof.push({ id: q, work: ptimes[q * 8], cnt: bounds[q + 1] - bounds[q] });
      Promise.all(workers.map(function (w) { return w.terminate(); })).then(function () {
        cb(f, ms, prof);
      });
      return;
    }
    t++; stepsDone++;
    PS.rebalance(bounds, ptimes, f.n, nT, share);
    PS.writeParams(params, f, 1 / 60);
    Atomics.store(ctrl, PS.C_N, f.n);
    Atomics.store(ctrl, PS.C_CMD, Atomics.load(ctrl, PS.C_CMD) + 1);
    Atomics.notify(ctrl, PS.C_CMD);
    // поток 0 — это мы
    PS.step(f, ctrl, 0, nT, 1 / 60, bounds, ptimes);
    PS.barrier(ctrl, nT);
    setImmediate(runStep);
  }
}

/* ---------- сравнение -------------------------------------------------- */
function diff(a, b) {
  if (a.n !== b.n) return { n: true };
  var maxP = 0, maxV = 0;
  for (var i = 0; i < a.n; i++) {
    maxP = Math.max(maxP, Math.abs(a.px[i] - b.px[i]), Math.abs(a.py[i] - b.py[i]));
    maxV = Math.max(maxV, Math.abs(a.vx[i] - b.vx[i]), Math.abs(a.vy[i] - b.vy[i]));
  }
  return { p: maxP, v: maxV };
}

console.log('\n[многопоточный решатель]');
console.log('  ядер в системе: ' + os.cpus().length);

var ref = phasedOne(STEPS);
console.log('  эталон (фазы, один поток): ' + ref.n + ' частиц');

var serialRef = serial(STEPS);
var d0 = diff(serialRef, ref);
ok('фазовый путь совпадает с обычным по числу частиц', serialRef.n === ref.n,
   serialRef.n + ' против ' + ref.n);
console.log('  (симметричный и полный поиск соседей суммируют в разном порядке,' +
            ' расхождение ' + d0.p.toExponential(1) + ' м — это ожидаемо)');

var threads = [2, 4, 6, 8].filter(function (k) { return k <= os.cpus().length; });
var results = [];
(function next(k) {
  if (k >= threads.length) return finish();
  var nT = threads[k];
  parallel(STEPS, nT, function (f, ms, prof) {
    var d = diff(ref, f);
    results.push({ nT: nT, ms: ms, d: d, n: f.n, prof: prof });
    ok(nT + ' потока(ов): результат совпадает с однопоточным побитово',
       d.p === 0 && d.v === 0 && f.n === ref.n,
       'частиц ' + f.n + '/' + ref.n + ', расхождение позиции ' +
       (d.p === 0 ? '0' : d.p.toExponential(2)) + ' м');
    next(k + 1);
  });
})(0);

var _origFinish = finish;
finish = function () { handoffChecks(_origFinish); };

/*
 * Отдельно проверяем переход «сам считал -> подключились воркеры»: именно
 * там ломалось. Нечётное число разогревочных шагов — худший случай для
 * ошибки с перестановкой ссылок.
 */
function handoffChecks(done) {
  var cases = [1, 3, 7];
  (function next(k) {
    if (k >= cases.length) return done();
    var warm = cases[k];
    parallel(STEPS, 4, function (f) {
      var d = diff(ref, f);
      ok('переход к воркерам после ' + warm + ' шагов в одиночку',
         d.p === 0 && d.v === 0 && f.n === ref.n,
         'расхождение ' + (d.p === 0 ? '0' : d.p.toExponential(2)) + ' м');
      next(k + 1);
    }, warm);
  })(0);
}

function finish() {
  // скорость меряем отдельно, уже на прогретом коде
  parallel(STEPS, 1, function (f1, ms1) {
    console.log('\n  ускорение (' + STEPS + ' шагов, ' + ref.n + ' частиц):');
    console.log('    1 поток : ' + ms1.toFixed(2) + ' мс/шаг');
    var best = 1;
    results.forEach(function (r) {
      var sp = ms1 / r.ms;
      if (sp > best) best = sp;
      console.log('    ' + r.nT + ' потока: ' + r.ms.toFixed(2) + ' мс/шаг  ->  ускорение ' +
                  sp.toFixed(2) + 'x');
      if (r.prof && r.prof.length) {
        // После балансировки время работы у потоков должно сойтись, а число
        // частиц — разойтись: медленным ядрам достаётся меньше.
        var w = r.prof.map(function (p) { return p.work; });
        var mn = Math.min.apply(null, w), mx = Math.max.apply(null, w);
        console.log('        работа ' + mn.toFixed(1) + '..' + mx.toFixed(1) + ' мс' +
                    ' (разброс ' + ((mx / Math.max(mn, 1e-6) - 1) * 100).toFixed(0) + '%)' +
                    ', частиц по потокам: ' + r.prof.map(function (p) { return p.cnt; }).join('/'));
      }
    });
    /*
     * Порог намеренно низкий. Дело теста — корректность; абсолютная скорость
     * на этой машине гуляет в полтора-два раза от фоновой загрузки, и жёсткий
     * порог падал бы от шума, а не от регрессии. Сторожим только то, что
     * распараллеливание вообще работает и не стало медленнее одного потока.
     */
    ok('многопоточность не медленнее однопоточного', best > 1.15,
       'лучшее ' + best.toFixed(2) + 'x (порог низкий: замер шумный)');
    console.log('\n' + (fails ? fails + ' из ' + checks + ' ПРОВАЛЕНО'
                              : 'все ' + checks + ' проверок пройдены'));
    process.exit(fails ? 1 : 0);
  });
}
