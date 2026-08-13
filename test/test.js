/* Дешёвые проверки физики в node: node test/test.js */
var SDF = require('../js/sdf.js');
var WS = require('../js/solver.js');

var fails = 0, checks = 0;
function ok(name, cond, info) {
  checks++;
  if (!cond) { fails++; console.log('  FAIL  ' + name + (info ? '   ' + info : '')); }
  else console.log('  ok    ' + name + (info ? '   ' + info : ''));
}
function near(a, b, tol) { return Math.abs(a - b) <= tol; }

/* ---------- 1. нормировка двумерных ядер ---------------------------- */
console.log('\n[ядра, 2D нормировка]');
(function () {
  var h = 0.0825;
  var k6 = 4 / (Math.PI * Math.pow(h, 8));
  var kS = 10 / (Math.PI * Math.pow(h, 5));
  var N = 2000, sum6 = 0, sumS = 0, dr = h / N;
  for (var i = 0; i < N; i++) {
    var r = (i + 0.5) * dr, t = h * h - r * r, u = h - r;
    sum6 += k6 * t * t * t * 2 * Math.PI * r * dr;
    sumS += kS * u * u * u * 2 * Math.PI * r * dr;
  }
  ok('интеграл Poly6 = 1', near(sum6, 1, 2e-3), 'получено ' + sum6.toFixed(5));
  ok('интеграл Spiky = 1', near(sumS, 1, 2e-3), 'получено ' + sumS.toFixed(5));

  // grad Spiky = -30/(pi h^5) (h-r)^2 — сверяем с численной производной W
  var r0 = h * 0.37, e = 1e-7;
  var W = function (r) { var u = h - r; return kS * u * u * u; };
  var num = (W(r0 + e) - W(r0 - e)) / (2 * e);
  var ana = -30 / (Math.PI * Math.pow(h, 5)) * (h - r0) * (h - r0);
  ok('grad Spiky совпадает с dW/dr', near(num / ana, 1, 1e-3),
     'числ ' + num.toFixed(1) + ' / аналит ' + ana.toFixed(1));
})();

/* ---------- 2. граничная таблица ------------------------------------ */
console.log('\n[граничный член: срезанная ядром полуплоскость]');
(function () {
  var h = 0.0825;
  var f = new WS.Fluid({ width: 1, height: 1, spacing: h / 2.2, maxParticles: 10 });
  ok('missing(0) = 0.5 (половина ядра за стенкой)', near(f.boundaryMissing(0), 0.5, 5e-3),
     f.boundaryMissing(0).toFixed(4));
  ok('missing(h) = 0', near(f.boundaryMissing(f.h), 0, 1e-3), f.boundaryMissing(f.h).toFixed(4));
  ok('missing(-h) = 1', near(f.boundaryMissing(-f.h), 1, 1e-3), f.boundaryMissing(-f.h).toFixed(4));
  var mono = true;
  for (var d = -f.h; d < f.h; d += f.h / 50)
    if (f.boundaryMissing(d + f.h / 50) > f.boundaryMissing(d) + 1e-6) mono = false;
  ok('missing монотонно убывает', mono);
})();

/* ---------- 3. равновесная плотность -------------------------------- */
console.log('\n[равновесная плотность измерена, а не задана]');
(function () {
  var dp = 0.0375;
  var f = new WS.Fluid({ width: 8, height: 4.5, spacing: dp, maxParticles: 10 });
  // теоретически rho0 ≈ m / площадь_на_частицу для гексагональной упаковки
  var theo = 1 / (dp * dp * Math.sqrt(3) / 2);
  ok('rho0 близка к 1/(площадь ячейки упаковки)', near(f.rho0 / theo, 1, 0.05),
     'rho0=' + f.rho0.toFixed(1) + ' теория=' + theo.toFixed(1));
  ok('rho0 положительна и конечна', isFinite(f.rho0) && f.rho0 > 0);
  ok('gradSumSq0 > 0', f.gradSumSq0 > 0, f.gradSumSq0.toExponential(3));
})();

/* ---------- 4. SDF --------------------------------------------------- */
console.log('\n[SDF стен]');
(function () {
  var s = new SDF.Solid(200, 120, 0.025);
  s.paintRect(1.0, 1.0, 3.0, 2.0, 1);
  s.rebuild();
  ok('внутри блока расстояние отрицательное', s.sample(2.0, 1.5) < 0, s.sample(2.0, 1.5).toFixed(4));
  ok('снаружи положительное', s.sample(2.0, 0.5) > 0, s.sample(2.0, 0.5).toFixed(4));
  var d = s.sample(2.0, 0.7);   // 0.3 м над верхней гранью
  ok('расстояние сверху ≈ 0.3 м', near(d, 0.3, 0.03), d.toFixed(4));
  var out = [0, 0];
  s.probe(2.0, 0.7, out);
  ok('нормаль над блоком смотрит вверх', out[1] < -0.9, '(' + out[0].toFixed(2) + ',' + out[1].toFixed(2) + ')');
  ok('нормаль единичная', near(Math.hypot(out[0], out[1]), 1, 1e-3));
})();

/* ---------- 5. прорыв плотины: устойчивость и несжимаемость ---------- */
console.log('\n[прорыв плотины: 600 шагов]');
var damResult = (function () {
  var W = 8, H = 4.5, cell = 0.025;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3);
  solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: 0.0375, maxParticles: 20000, solid: solid });
  f.fillRect(0.2, 1.2, 2.6, 4.3, 0.02);
  var n0 = f.n;
  var maxComp = 0, escaped = 0;
  for (var s = 0; s < 600; s++) {
    f.step(1 / 60);
    if (s > 30) maxComp = Math.max(maxComp, f.meanCompression());
  }
  for (var i = 0; i < f.n; i++) {
    if (f.px[i] < -0.01 || f.px[i] > W + 0.01 || f.py[i] > H + 0.01) escaped++;
    if (solid.sample(f.px[i], f.py[i]) < -0.01) escaped++;
  }
  ok('частиц не появилось и не исчезло', f.n === n0, n0 + ' шт');
  ok('нет NaN/Inf', !f.hasNaN());
  ok('никто не утёк за стенки', escaped === 0, escaped + ' нарушителей');
  // односторонняя метрика (только положительные отклонения), поэтому
  // беспорядок упаковки сам по себе даёт пару процентов
  ok('средняя сжатость < 3%', maxComp < 0.03, (maxComp * 100).toFixed(3) + '%');
  var v = f.maxVelocity();
  // вода падает с 3 м, свободное падение даёт ~7.7 м/с; всё сверх этого —
  // численный разгон. Порог с запасом на всплески у дна.
  ok('скорости не разгоняются', v < 16, 'max |v| = ' + v.toFixed(2) + ' м/с');
  return f;
})();

/* ---------- 6. гидростатика: покой остаётся покоем ------------------- */
console.log('\n[гидростатика: столб воды в покое]');
(function () {
  var W = 2, H = 3, cell = 0.02, dp = 0.03;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3);
  solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 12000, solid: solid });
  // заливаем ВПЛОТНУЮ к стенкам, с равновесным пристеночным отступом:
  // иначе вода сначала падает, бьёт по дну, и мы меряем не гидростатику
  var sp = dp * Math.sqrt(3) / 2, row = 0;
  for (var y = H - 3 * cell - f.wallOffset; y > 1.1; y -= sp, row++) {
    var off = (row % 2) ? dp * 0.5 : 0;
    for (var x = 3 * cell + f.wallOffset + off; x < W - 3 * cell - f.wallOffset; x += dp)
      f.add(x, y, 0, 0);
  }
  var y0 = 1e9;
  for (var i = 0; i < f.n; i++) if (f.py[i] < y0) y0 = f.py[i];

  for (var s = 0; s < 400; s++) f.step(1 / 60);

  // Мгновенная скорость в PBF — это (q - p)/dt, то есть в неё входят и
  // поправки решателя. Стоячая вода честно проверяется смещением центра
  // масс, а дрожание — долей dp за кадр (оно меньше размера частицы и
  // после экранного сглаживания в рендере не видно).
  var cx0 = 0, cy0 = 0;
  for (i = 0; i < f.n; i++) { cx0 += f.px[i]; cy0 += f.py[i]; }
  cx0 /= f.n; cy0 /= f.n;
  for (s = 0; s < 60; s++) f.step(1 / 60);
  var cx1 = 0, cy1 = 0, vsum = 0;
  for (i = 0; i < f.n; i++) {
    cx1 += f.px[i]; cy1 += f.py[i];
    vsum += Math.sqrt(f.vx[i] * f.vx[i] + f.vy[i] * f.vy[i]);
  }
  cx1 /= f.n; cy1 /= f.n;
  var drift = Math.sqrt((cx1 - cx0) * (cx1 - cx0) + (cy1 - cy0) * (cy1 - cy0));
  ok('вода в покое не течёт', drift < 0.005, 'центр масс за 1 с: ' + (drift * 1000).toFixed(2) + ' мм');
  var jitter = vsum / f.n / 60 / dp;
  ok('дрожание меньше размера частицы', jitter < 0.35,
     (jitter * 100).toFixed(1) + '% от dp за кадр');

  var flying = 0;
  for (i = 0; i < f.n; i++) if (f.py[i] < y0 - 0.05) flying++;
  ok('решатель не выбрасывает частицы вверх', flying === 0, flying + ' шт');

  // несжимаемость: плотность в толще не должна расти с глубиной
  var bins = 4, sum = new Float64Array(bins), cnt = new Int32Array(bins);
  var yMax = -9;
  for (i = 0; i < f.n; i++) if (f.py[i] > yMax) yMax = f.py[i];
  for (i = 0; i < f.n; i++) {
    if (f.bdist[i] < f.h) continue;                  // не у стенки
    var b = Math.min(bins - 1, Math.max(0, Math.floor((f.py[i] - y0) / (yMax - y0 + 1e-9) * bins)));
    sum[b] += f.rho[i] / f.rho0 - 1; cnt[b]++;
  }
  // верхний слой пропускаем: у свободной поверхности плотность занижена
  // по определению (соседей сверху нет), это не сжимаемость
  var top = cnt[1] ? sum[1] / cnt[1] : 0, bot = cnt[bins - 1] ? sum[bins - 1] / cnt[bins - 1] : 0;
  ok('плотность в толще не растёт с глубиной', Math.abs(bot - top) < 0.03,
     'под поверхностью ' + (top * 100).toFixed(2) + '%, у дна ' + (bot * 100).toFixed(2) + '%');

  // поверхность горизонтальна; берём 4-ю сверху частицу столбца,
  // чтобы одиночная капля не портила замер
  var cols = 16, colY = [];
  for (var c = 0; c < cols; c++) colY.push([]);
  for (i = 0; i < f.n; i++) {
    c = Math.min(cols - 1, Math.max(0, Math.floor(f.px[i] / W * cols)));
    colY[c].push(f.py[i]);
  }
  var tops = [];
  for (c = 0; c < cols; c++) {
    if (colY[c].length < 8) continue;
    colY[c].sort(function (a, b) { return a - b; });
    tops.push(colY[c][3]);
  }
  var mn = Math.min.apply(null, tops), mx = Math.max.apply(null, tops);
  ok('свободная поверхность горизонтальна', mx - mn < 0.1,
     'перепад ' + ((mx - mn) * 100).toFixed(1) + ' см');
})();

/* ---------- 7. сообщающиеся сосуды ---------------------------------- */
console.log('\n[сообщающиеся сосуды: уровень выравнивается]');
(function () {
  var W = 3, H = 2.5, cell = 0.02;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3);
  solid.paintRect(1.45, 0.0, 1.55, 1.9, 1);   // перегородка с щелью у дна
  solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: 0.03, maxParticles: 9000, solid: solid });
  f.vorticity = 0.05;
  f.fillRect(0.1, 0.6, 1.4, 2.4, 0.01);       // вода только слева
  for (var s = 0; s < 900; s++) f.step(1 / 60);
  var lTop = 1e9, rTop = 1e9, lN = 0, rN = 0;
  for (var i = 0; i < f.n; i++) {
    if (f.px[i] < 1.4) { lN++; if (f.py[i] < lTop) lTop = f.py[i]; }
    else if (f.px[i] > 1.6) { rN++; if (f.py[i] < rTop) rTop = f.py[i]; }
  }
  ok('вода перетекла во второй сосуд', rN > f.n * 0.25, 'слева ' + lN + ', справа ' + rN);
  ok('уровни сравнялись', Math.abs(lTop - rTop) < 0.15,
     'перепад ' + (Math.abs(lTop - rTop) * 100).toFixed(1) + ' см');
})();

/* ---------- 8. тонкая стенка: нет туннелирования --------------------- */
console.log('\n[быстрая капля против тонкой стенки]');
(function () {
  var W = 2, H = 3, cell = 0.02;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3);
  solid.paintRect(0.0, 2.0, 2.0, 2.06, 1);    // стенка толщиной 6 см
  solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: 0.03, maxParticles: 500, solid: solid });
  for (var i = 0; i < 60; i++)
    f.add(0.5 + (i % 10) * 0.03, 0.2 + Math.floor(i / 10) * 0.03, 0, 22);  // 22 м/с вниз
  for (var s = 0; s < 200; s++) f.step(1 / 60);
  var through = 0;
  for (i = 0; i < f.n; i++) if (f.py[i] > 2.1) through++;
  ok('никто не проскочил сквозь стенку', through === 0, through + ' проскочило');
})();

/* ---------- 9. кран льёт в бак, пока не переполнит ------------------- */
console.log('\n[кран: наполняем бак до отказа]');
(function () {
  var W = 2, H = 2.5, cell = 0.02, dp = 0.03;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3);
  solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 2500, solid: solid });
  var em = new WS.Emitter(f, { x: 1.0, y: 0.15, dirX: 0, dirY: 1, speed: 2.5, width: dp * 6 });
  var maxComp = 0, maxV = 0;
  for (var s = 0; s < 900; s++) {
    em.step(1 / 60);
    f.step(1 / 60);
    if (s > 60) { maxComp = Math.max(maxComp, f.meanCompression()); maxV = Math.max(maxV, f.maxVelocity()); }
  }
  ok('нет NaN при непрерывном вливе', !f.hasNaN());
  ok('кран остановился на пределе', f.n === f.max, f.n + ' / ' + f.max);
  var inside = 0, out = 0;
  for (var i = 0; i < f.n; i++) {
    if (solid.sample(f.px[i], f.py[i]) < -0.01) inside++;
    if (f.px[i] < 0 || f.px[i] > W || f.py[i] > H) out++;
  }
  ok('никто не в стенке и не за баком', inside === 0 && out === 0, inside + ' в стенке, ' + out + ' снаружи');
  ok('плотность в месте рождения не скачет', maxComp < 0.05, (maxComp * 100).toFixed(2) + '%');
  ok('струя никого не разгоняет', maxV < 16, 'max |v| = ' + maxV.toFixed(2) + ' м/с');

  // вода должна дойти до дна и налиться, а не зависнуть
  var deep = 0;
  for (i = 0; i < f.n; i++) if (f.py[i] > H - 0.5) deep++;
  ok('вода налилась снизу', deep > f.n * 0.2, deep + ' из ' + f.n + ' в нижних 50 см');
})();

/* ---------- 10. стену рисуют прямо по воде --------------------------- */
console.log('\n[стену рисуют по залитой воде]');
(function () {
  var W = 2, H = 2.5, cell = 0.02, dp = 0.03;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3);
  solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 6000, solid: solid });
  f.fillRect(0.1, 1.2, 1.9, 2.4, 0.01);
  for (var s = 0; s < 120; s++) f.step(1 / 60);
  var before = f.n;

  // мазок кистью поперёк бассейна
  solid.paintSegment(0.2, 1.8, 1.8, 1.8, 0.06, 1);
  solid.rebuild();
  var killed = f.removeInside();
  ok('запертые в стенке частицы удалены', killed > 0, killed + ' шт из ' + before);

  var maxV = 0;
  for (s = 0; s < 200; s++) { f.step(1 / 60); maxV = Math.max(maxV, f.maxVelocity()); }
  ok('нет NaN после рисования по воде', !f.hasNaN());
  ok('стенка не выстреливает водой', maxV < 12, 'max |v| = ' + maxV.toFixed(2) + ' м/с');
  var inside = 0;
  for (var i = 0; i < f.n; i++) if (solid.sample(f.px[i], f.py[i]) < -0.01) inside++;
  ok('никто не остался внутри стенки', inside === 0, inside + ' шт');
})();

/* ---------- 11. сверка с экспериментом: прорыв плотины -------------- */
console.log('\n[эталон Koshizuka & Oka 1996: фронт прорыва плотины]');
(function () {
  // Колонна воды ширины L и высоты 2L рушится под своим весом.
  // Безразмерные: T = t*sqrt(2g/L), Z = положение фронта / L.
  // Опубликованный эксперимент: T=1 -> 1.5, T=2 -> 2.5, T=3 -> 3.6.
  var expect = { 1: 1.5, 1.5: 2.0, 2: 2.5, 2.5: 3.1, 3: 3.6 };
  function frontAt(dp) {
    var L = 1.0, W = 6, H = 3, cell = 0.02;
    var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
    solid.addBorder(3); solid.rebuild();
    var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 40000, solid: solid });
    var floor = H - 3 * cell, x0 = 3 * cell;
    f.fillRect(x0, floor - 2 * L, x0 + L, floor, 0.005);
    var targets = [1, 1.5, 2, 2.5, 3], out = {}, ti = 0, t = 0;
    while (ti < targets.length && t < 600) {
      f.step(1 / 60); t++;
      var T = (t / 60) * Math.sqrt(2 * 9.81 / L);
      if (T >= targets[ti]) {
        var xs = [];
        for (var i = 0; i < f.n; i++) if (f.py[i] > floor - 0.25) xs.push(f.px[i]);
        xs.sort(function (a, b) { return a - b; });
        out[targets[ti]] = (xs[Math.floor(xs.length * 0.99)] - x0) / L;  // 99-й перцентиль: без одиночных брызг
        ti++;
      }
    }
    var err = 0, c = 0, txt = [];
    for (var k in out) { err += Math.abs(out[k] - expect[k]) / expect[k]; c++; txt.push('T=' + k + ':' + out[k].toFixed(2)); }
    return { err: err / c, txt: txt.join(' '), n: f.n };
  }
  var coarse = frontAt(0.045), fine = frontAt(0.03);
  ok('фронт совпадает с экспериментом (грубая сетка)', coarse.err < 0.12,
     coarse.txt + '  ошибка ' + (coarse.err * 100).toFixed(1) + '%');
  ok('фронт совпадает с экспериментом (мелкая сетка)', fine.err < 0.10,
     fine.txt + '  ошибка ' + (fine.err * 100).toFixed(1) + '%');
  // сходимость: измельчение сетки должно приближать к эксперименту, а не наоборот
  ok('решение сходится при измельчении', fine.err < coarse.err + 0.005,
     (coarse.err * 100).toFixed(1) + '% -> ' + (fine.err * 100).toFixed(1) + '%');
})();

/* ---------- 12. струя держится, а не разрежается -------------------- */
console.log('\n[связность падающей струи]');
(function () {
  var W = 3, H = 4.5, cell = 0.025, dp = 0.045;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3); solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 30000, solid: solid });
  var em = new WS.Emitter(f, { x: 1.5, y: 0.15, dirX: 0, dirY: 1, speed: 2.0, width: dp * 9 });
  for (var t = 0; t < 260; t++) { em.step(1 / 60); f.step(1 / 60); }

  function slice(y) {
    var xs = [], rho = 0, c = 0;
    for (var i = 0; i < f.n; i++) {
      if (Math.abs(f.py[i] - y) > dp * 1.2) continue;
      xs.push(f.px[i]); rho += f.rho[i] / f.rho0; c++;
    }
    if (c < 4) return null;
    xs.sort(function (a, b) { return a - b; });
    return { w: xs[Math.floor(xs.length * 0.9)] - xs[Math.floor(xs.length * 0.1)], rho: rho / c, n: c };
  }
  var top = slice(0.6), bot = slice(2.2);
  ok('струя доходит до низа', top && bot, top && bot ? 'срезы получены' : 'струя распалась');
  if (top && bot) {
    // свободная струя разгоняется и обязана сужаться, оставаясь плотной
    ok('струя остаётся плотной', bot.rho > 0.7,
       'ρ/ρ0 сверху ' + top.rho.toFixed(2) + ', снизу ' + bot.rho.toFixed(2));
    ok('струя сужается на разгоне', bot.w <= top.w * 1.15,
       'ширина ' + (top.w * 100).toFixed(0) + ' см -> ' + (bot.w * 100).toFixed(0) + ' см');
  }
})();

/* ---------- 13. струя не пропадает, когда разгоняется ---------------- */
console.log('\n[видимость струи на разгоне]');
(function () {
  var R = require('../js/render.js');
  var sp = R.splat;

  var dpPx, radius, cal, iso;
  function useQuality(dp) {
    dpPx = dp; radius = dp * 2.2 * 1.6;      // радиус кляксы = 1.6 * h
    cal = sp.calibrate(dpPx, radius);
    iso = cal.iso;
  }
  useQuality(7.5);

  /*
   * Струя из nCols частиц в ряду. Ряды выпускаются через dp*sqrt(3)/2 пути,
   * поэтому на скорости v расстояние между рядами растёт как v/v0.
   * Считаем поле в центре струи ровно так же, как складывает его GPU.
   */
  function fieldInJet(v0, v, nCols, stretch) {
    var rowGap = dpPx * Math.sqrt(3) / 2 * (v / v0);
    var a = sp.stretchOf(v, stretch);
    var rows = Math.ceil(radius * a / rowGap) + 1;
    var s = 0;
    for (var j = -rows; j <= rows; j++) {
      var off = (Math.abs(j) % 2) ? 0.5 : 0;
      for (var i = -(nCols >> 1); i <= (nCols >> 1); i++) {
        s += sp.weight(j * rowGap, (i + off) * dpPx, radius, a);
      }
    }
    return s;
  }
  function cover(D) {
    var t = (D - iso * sp.COVER_LO) / (iso * (sp.COVER_HI - sp.COVER_LO));
    t = Math.max(0, Math.min(1, t));
    return t * t * (3 - 2 * t);
  }

  ok('изоуровень положителен', iso > 0, 'iso = ' + iso.toFixed(2) +
     ' при полной упаковке ' + cal.fullField.toFixed(2));

  // струя шириной 7 частиц, выпуск 2.4 м/с, разгон до 10 м/с (падение с 4.5 м)
  var v0 = 2.4, worst = 1, line = [];
  [2.4, 4, 6, 8, 10].forEach(function (v) {
    var c = cover(fieldInJet(v0, v, 7, 0.22));
    line.push(v + ' м/с: ' + (c * 100).toFixed(0) + '%');
    if (c < worst) worst = c;
  });
  ok('струя видна на всём разгоне', worst > 0.55, line.join(', '));

  // без вытягивания клякс струя обязана пропадать — иначе тест ничего не ловит
  var noStretch = cover(fieldInJet(v0, 10, 7, 0));
  ok('без вытягивания клякс струя действительно пропадает', noStretch < 0.15,
     'покрытие ' + (noStretch * 100).toFixed(0) + '%');

  // тонкая струя из 3 частиц в ряду тоже должна оставаться заметной
  var thin = cover(fieldInJet(v0, 8, 3, 0.22));
  ok('тонкая струя (3 частицы в ряду) видна', thin > 0.3,
     'покрытие ' + (thin * 100).toFixed(0) + '%');

  // а спокойная вода не должна раздуваться от вытягивания
  var still = fieldInJet(0.5, 0.5, 15, 0.22) / cal.fullField;
  ok('спокойная вода не раздувается', still > 0.97 && still < 1.03,
     (still * 100).toFixed(0) + '% от плотности упаковки');
  var slosh = fieldInJet(1.5, 1.5, 15, 0.22) / cal.fullField;
  ok('лёгкое волнение тоже не раздувает', slosh < 1.05,
     (slosh * 100).toFixed(0) + '% от плотности упаковки');

  // то же самое на всех трёх уровнях качества: шаг частиц другой,
  // а изоуровень пересчитывается — струя обязана оставаться видимой
  [['низкое', 9.5], ['среднее', 7.5], ['высокое', 6.0]].forEach(function (q) {
    useQuality(q[1]);
    var w = 1, st = 1;
    [2.4, 5, 8, 10].forEach(function (v) {
      w = Math.min(w, cover(fieldInJet(2.4, v, 7, 0.22)));
    });
    st = fieldInJet(0.5, 0.5, 15, 0.22) / cal.fullField;
    ok('качество «' + q[0] + '»: струя видна, покой не раздут',
       w > 0.55 && st > 0.97 && st < 1.03,
       'худшее покрытие струи ' + (w * 100).toFixed(0) + '%, покой ' + (st * 100).toFixed(0) + '%');
  });
})();

/* ---------- 14. массивы не меняются местами -------------------------- */
console.log('\n[ссылки на массивы неподвижны]');
(function () {
  // Сортировка частиц по ячейкам может либо копировать результат на место,
  // либо просто поменять ссылки на буферы. Второе бесплатно, но данные у
  // нас общие с рабочими потоками, а ссылки — свои у каждого: стоит одному
  // потоку переставить их у себя, и он начнёт писать в буфер, из которого
  // остальные не читают. Ломается через раз, по чётности перестановок.
  var W = 4, H = 3, cell = 0.025;
  var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
  solid.addBorder(3); solid.rebuild();
  var f = new WS.Fluid({ width: W, height: H, spacing: 0.04, maxParticles: 8000, solid: solid });
  f.fillRect(0.3, 1.0, 3.7, 2.8, 0.01);

  var names = ['px', 'py', 'qx', 'qy', 'vx', 'vy', 'foam',
               '_sx', '_sy', '_sqx', '_sqy', '_svx', '_svy', '_sf',
               'nbr', 'ncount', 'rho', 'lam', 'gmC', 'scC', 'near', 'gstart'];
  var before = {};
  names.forEach(function (k) { before[k] = f[k]; });

  for (var s = 0; s < 12; s++) f.step(1 / 60);

  var moved = names.filter(function (k) { return f[k] !== before[k]; });
  ok('ни один массив не подменён после 12 шагов', moved.length === 0,
     moved.length ? 'уехали: ' + moved.join(', ') : 'все ' + names.length + ' на месте');

  // и на всякий случай: смещения в арене тоже прежние
  var offOk = f.px.byteOffset === before.px.byteOffset &&
              f.vx.byteOffset === before.vx.byteOffset;
  ok('смещения в общей памяти не изменились', offOk,
     'px @ ' + f.px.byteOffset + ', vx @ ' + f.vx.byteOffset);
})();

/* ---------- 15. разные жидкости --------------------------------------- */
console.log('\n[жидкости: вода, масло, пиво, ртуть]');
(function () {
  var M = WS.MATERIALS;
  var WATER = 0, OIL = 1, BEER = 2, HG = 3;

  ok('плотности настоящие', M[WATER].density === 998 && M[OIL].density === 915 &&
     M[BEER].density === 1010 && M[HG].density === 13534,
     M.map(function (m) { return m.name + ' ' + m.density; }).join(', '));

  /* Капля одной жидкости внутри другой: куда поедет. */
  function drop(bulk, dropMat, startY, steps) {
    var W = 3, H = 3, cell = 0.02, dp = 0.045;
    var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
    solid.addBorder(3); solid.rebuild();
    var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 20000, solid: solid });
    var dy = dp * Math.sqrt(3) / 2, row = 0;
    for (var y = 1.0; y < 2.9; y += dy, row++) {
      var off = (row % 2) ? dp * 0.5 : 0;
      for (var x = 0.1 + off; x < W - 0.1; x += dp) {
        if (solid.sample(x, y) < dp * 0.55) continue;
        f.add(x, y, 0, 0, Math.hypot(x - 1.5, y - startY) < 0.28 ? dropMat : bulk);
      }
    }
    function meanY(m) {
      var s = 0, c = 0;
      for (var i = 0; i < f.n; i++) if (f.mat[i] === m) { s += f.py[i]; c++; }
      return c ? s / c : 0;
    }
    var rel0 = meanY(dropMat) - meanY(bulk);
    for (var t = 0; t < steps; t++) f.step(1 / 60);
    // y растёт вниз, поэтому уменьшение относительной высоты = всплытие
    return { rise: rel0 - (meanY(dropMat) - meanY(bulk)), nan: f.hasNaN(), n: f.n };
  }

  var oilUp = drop(WATER, OIL, 2.6, 900);
  ok('масло всплывает в воде', oilUp.rise > 0.5 && !oilUp.nan,
     'поднялось на ' + oilUp.rise.toFixed(2) + ' м');

  var hgDown = drop(WATER, HG, 1.3, 900);
  ok('ртуть тонет в воде', hgDown.rise < -0.5 && !hgDown.nan,
     'опустилась на ' + (-hgDown.rise).toFixed(2) + ' м');

  var waterInOil = drop(OIL, WATER, 1.3, 900);
  ok('вода тонет в масле', waterInOil.rise < -0.5,
     'опустилась на ' + (-waterInOil.rise).toFixed(2) + ' м');

  // пиво и вода почти одной плотности (1010 против 998) — и не должны
  // разделяться: в жизни они тоже смешиваются
  var beer = drop(WATER, BEER, 2.6, 900);
  ok('пиво с водой не расслаивается', Math.abs(beer.rise) < 0.15,
     'сдвиг ' + beer.rise.toFixed(2) + ' м');

  /* Порядок слоёв: наливаем заведомо неправильно и ждём, что перевернётся. */
  (function () {
    var W = 3, H = 3, cell = 0.02, dp = 0.045;
    var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
    solid.addBorder(3); solid.rebuild();
    var f = new WS.Fluid({ width: W, height: H, spacing: dp, maxParticles: 20000, solid: solid });
    f.fillRect(0.1, 1.3, 2.9, 1.85, 0.01, HG);     // ртуть сверху
    f.fillRect(0.1, 1.85, 2.9, 2.4, 0.01, WATER);
    f.fillRect(0.1, 2.4, 2.9, 2.9, 0.01, OIL);     // масло снизу
    for (var t = 0; t < 1200; t++) f.step(1 / 60);
    function meanY(m) {
      var s = 0, c = 0;
      for (var i = 0; i < f.n; i++) if (f.mat[i] === m) { s += f.py[i]; c++; }
      return c ? s / c : 0;
    }
    var yo = meanY(OIL), yw = meanY(WATER), yh = meanY(HG);
    ok('слои встают по плотности: масло, вода, ртуть', yo < yw && yw < yh,
       'масло ' + yo.toFixed(2) + ' < вода ' + yw.toFixed(2) + ' < ртуть ' + yh.toFixed(2) + ' м');
    ok('перестановка слоёв никого не выбросила', !f.hasNaN() && f.n > 0, f.n + ' частиц');
  })();

  /*
   * Одна жидкость сама по себе обязана вести себя одинаково при любой
   * плотности: чистая ртуть не должна плескаться как на планете с
   * четырёхкратной тяжестью. Меняем ТОЛЬКО плотность, всё остальное
   * оставляем прежним, и требуем побитового совпадения — за это отвечает
   * опора выталкивающей силы на среднюю плотность налитого.
   */
  (function () {
    var W = 3, H = 3, cell = 0.02, dp = 0.04;
    function run(density) {
      var mats = JSON.parse(JSON.stringify(WS.MATERIALS));
      mats[0].density = density;
      var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
      solid.addBorder(3); solid.rebuild();
      var f = new WS.Fluid({ width: W, height: H, spacing: dp,
                             maxParticles: 20000, solid: solid, materials: mats });
      f.fillRect(0.2, 1.4, 2.8, 2.8, 0);
      for (var t = 0; t < 150; t++) f.step(1 / 60);
      return f;
    }
    var a = run(998), b = run(13534);
    var maxd = 0;
    for (var i = 0; i < a.n; i++)
      maxd = Math.max(maxd, Math.abs(a.py[i] - b.py[i]), Math.abs(a.px[i] - b.px[i]));
    ok('одна жидкость ведёт себя одинаково при любой плотности', maxd === 0,
       'вода против ртути в чистом виде: расхождение ' +
       (maxd === 0 ? '0' : maxd.toExponential(1)) + ' м');
  })();
})();

/* ---------- 16. смачивание стенок ------------------------------------- */
console.log('\n[мениск: смачивает или нет]');
(function () {
  /*
   * Плоский сосуд с вертикальными стенками. Меряем, насколько поверхность
   * у стенки выше середины. Смачивающая жидкость должна лезть вверх,
   * несмачивающая (ртуть, краевой угол 140°) — отступать вниз.
   */
  function meniscus(adh, coh, steps) {
    var W = 2, H = 2.4, cell = 0.02, dp = 0.045;
    var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
    solid.addBorder(3); solid.rebuild();
    var mats = JSON.parse(JSON.stringify(WS.MATERIALS));
    mats[0].adh = adh; mats[0].coh = coh;
    var f = new WS.Fluid({ width: W, height: H, spacing: dp,
                           maxParticles: 20000, solid: solid, materials: mats });
    f.fillRect(0.1, 1.3, 1.9, 2.3, 0.01, 0);
    for (var t = 0; t < steps; t++) f.step(1 / 60);
    var cols = 20, top = [];
    for (var c = 0; c < cols; c++) top.push(1e9);
    for (var i = 0; i < f.n; i++) {
      var ci = Math.min(cols - 1, Math.max(0, Math.floor(f.px[i] / W * cols)));
      if (f.py[i] < top[ci]) top[ci] = f.py[i];
    }
    var edge = (top[0] + top[1] + top[cols - 1] + top[cols - 2]) / 4;
    var mid = 0, k = 0;
    for (c = 6; c < cols - 6; c++) { mid += top[c]; k++; }
    mid /= k;
    return { rise: (mid - edge) * 1000, nan: f.hasNaN() };   // мм, + = выше у стенки
  }

  var wet = meniscus(1.0, 5, 600);
  var dry = meniscus(-0.4, 33, 600);
  var none = meniscus(0, 5, 600);

  ok('смачивающая жидкость поднимается у стенки', wet.rise > 5 && !wet.nan,
     'мениск ' + wet.rise.toFixed(0) + ' мм');
  ok('несмачивающая отступает от стенки', dry.rise < -25 && !dry.nan,
     'мениск ' + dry.rise.toFixed(0) + ' мм');
  ok('знак мениска определяется смачиванием', wet.rise > none.rise && none.rise > dry.rise,
     'смачивает ' + wet.rise.toFixed(0) + ' > никак ' + none.rise.toFixed(0) +
     ' > не смачивает ' + dry.rise.toFixed(0) + ' мм');

  /*
   * Подъём обязан останавливаться. Без ограничителя сила линии контакта
   * превышала тяжесть, равновесия не было в принципе, и вода уползала по
   * стене на всю высоту сосуда — мениск доходил до 2.5 м.
   */
  var lo = meniscus(1.0, 5, 600), hi = meniscus(1.0, 5, 2400);
  ok('подъём останавливается, а не ползёт бесконечно',
     Math.abs(hi.rise) < 200 && !hi.nan,
     '10 с: ' + lo.rise.toFixed(0) + ' мм, 40 с: ' + hi.rise.toFixed(0) + ' мм');
})();

/* ---------- 17. производительность ------------------------------------ */
console.log('\n[производительность]');
(function () {
  var f = damResult;
  var t0 = process.hrtime.bigint();
  var N = 60;
  for (var s = 0; s < N; s++) f.step(1 / 60);
  var ms = Number(process.hrtime.bigint() - t0) / 1e6 / N;
  var per = ms / f.n * 1000;
  console.log('  ' + f.n + ' частиц: ' + ms.toFixed(2) + ' мс/кадр, ' +
              per.toFixed(2) + ' мкс на частицу');
  /*
   * Сторож грубых регрессий, а не бюджет кадра. Порог намеренно широкий:
   * на этой машине один и тот же код показывал от 2.4 до 8.7 мкс на
   * частицу в зависимости от фоновой загрузки — при открытом браузере с
   * рабочими потоками счёт идёт втрое медленнее. Узкий порог падал бы от
   * шума, а не от ошибки, а тест, падающий случайно, хуже отсутствующего.
   * Настоящие сравнения производительности делает test/bench.js, и только
   * внутри одного запуска.
   */
  console.log('  в 12 мс физики влезает ~' + Math.round(12 / per * 1000) + ' частиц (node)');
  ok('нет грубой регрессии производительности', per < 20, per.toFixed(2) + ' мкс/частицу');
})();

console.log('\n' + (fails ? fails + ' из ' + checks + ' проверок ПРОВАЛЕНО' : 'все ' + checks + ' проверок пройдены'));
process.exit(fails ? 1 : 0);
