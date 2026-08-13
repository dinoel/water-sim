/*
 * Бенчмарк. Берём МИНИМУМ по раундам, а не среднее: минимум — это оценка
 * времени без помех со стороны системы, и он повторяется от запуска к
 * запуску, тогда как среднее гуляет в полтора-два раза.
 *
 *   node test/bench.js
 */
var SDF = require('../js/sdf.js');
var WS = require('../js/solver.js');

function scene(dp, nSteps) {
  var W = 8, H = 4.5, cell = 0.025;
  var s = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  s.addBorder(3);
  s.paintRect(4.6, 2.6, 8.0, 2.75, 1);     // уступ, чтобы поток был неоднородным
  s.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 30000, solid: s });
  var d = new WS.Diffuse(f, 14000);
  f.fillRect(0.2, 1.1, 3.2, 4.3, 0.02);
  for (var t = 0; t < nSteps; t++) { f.step(1 / 60); d.step(1 / 60); }
  return { f: f, d: d };
}

function bench(label, fn, rounds, iters) {
  var best = Infinity, all = [];
  for (var r = 0; r < rounds; r++) {
    var t0 = process.hrtime.bigint();
    for (var i = 0; i < iters; i++) fn();
    var ms = Number(process.hrtime.bigint() - t0) / 1e6 / iters;
    all.push(ms);
    if (ms < best) best = ms;
  }
  all.sort(function (a, b) { return a - b; });
  var med = all[all.length >> 1];
  console.log('  ' + label.padEnd(26) + best.toFixed(3) + ' мс  (медиана ' +
              med.toFixed(3) + ', разброс ' + ((med / best - 1) * 100).toFixed(0) + '%)');
  return best;
}

console.log('\nразбор шага по частям');
var sc = scene(0.045, 150);
var f = sc.f, d = sc.d;
console.log('  частиц: ' + f.n + ', соседей в среднем ' +
  (function () { var a = 0; for (var i = 0; i < f.n; i++) a += f.ncount[i]; return (a / f.n).toFixed(1); })());

var N = f.n;
var sort = bench('sortParticles', function () { f.sortParticles(); }, 8, 200);
var nbr = bench('findNeighbors (симм.)', function () { f.findNeighbors(); }, 8, 200);
bench('findNeighbors (диапаз.)', function () { f.findNeighborsRange(0, N); }, 8, 200);
var bnd = bench('граница', function () { f.phaseBoundaryFull(0, N, 0); }, 8, 200);
var so = bench('силы 2-го порядка', function () {
  f.phaseForces1(0, N); f.phaseForces2(0, N, 1 / 60); f.phaseForcesApply(0, N, 1 / 60);
}, 8, 200);
var fo = bench('computeFoam', function () { f.computeFoam(0, N, 1 / 60); }, 8, 200);
var proj = bench('плотность+поправка', function () {
  f.phaseDensity(0, N, 1, 0); f.phaseDeltaP(0, N); f.phaseApply(0, N, 0);
}, 8, 200);
var full = bench('ПОЛНЫЙ step', function () { f.step(1 / 60); }, 8, 120);
var dif = bench('брызги (' + d.n + ' шт)', function () { d.step(1 / 60); }, 8, 120);

var perSub = sort + nbr + bnd;
var iterMs = (full - f.substeps * perSub - so - fo) / (f.substeps * f.iterations);
console.log('');
console.log('  подшаги (сорт+соседи+граница) x' + f.substeps + ' = ' + (f.substeps * perSub).toFixed(2) + ' мс');
console.log('  ' + (f.substeps * f.iterations) + ' итераций решателя = ' +
            (full - f.substeps * perSub - so - fo).toFixed(2) + ' мс (' + iterMs.toFixed(3) + ' на итерацию)');
console.log('  силы 2-го порядка + пена = ' + (so + fo).toFixed(2) + ' мс');
console.log('');
console.log('  ИТОГО ' + (full / f.n * 1000).toFixed(2) + ' мкс на частицу');
console.log('  в 12 мс физики влезает ' + Math.round(12 / full * f.n) + ' частиц');

// Сравнивать можно только числа ИЗ ОДНОГО запуска: между запусками загрузка
// машины меняет абсолютные значения в полтора-два раза.
console.log('\nмасштабирование по числу частиц');
sc = f = d = null;                       // отпускаем разбор, чтобы не мешал кэшу
[0.060, 0.045, 0.036].forEach(function (dp) {
  var s2 = scene(dp, 120);
  var ff = s2.f, n = ff.n;
  var ms = bench('dp=' + (dp * 160).toFixed(1) + 'px, n=' + n,
                 function () { ff.step(1 / 60); }, 6, 100);
  console.log('       -> ' + (ms / n * 1000).toFixed(2) + ' мкс/частицу, ' +
              Math.round(12 / ms * n) + ' частиц в 12 мс');
  s2 = ff = null;
});
