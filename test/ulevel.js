/*
 * Диагностика сообщающихся сосудов с длинной U-образной трубой.
 * Запуск: node test/ulevel.js
 */
var SDF = require('../js/sdf.js');
var WS = require('../js/solver.js');

var W = 8, H = 4.5, cell = 0.025;
var dp = +(process.env.DP || 0.046875);
var steps = +(process.env.STEPS || 1800);
var inflow = process.env.INFLOW === '1';
var equalStart = process.env.EQUAL === '1';
var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
solid.addBorder(3);

// Два широких открытых резервуара, соединённых длинной узкой U-трубой.
// Сначала монолит, затем вырезанная полость: так на стыках гарантированно
// нет щелей, через которые жидкость могла бы уйти наружу.
solid.paintRect(0.78, 0.45, 7.22, 4.02, 1);
solid.paintRect(1.00, 0.30, 2.40, 2.52, 0);
solid.paintRect(1.38, 2.30, 1.82, 3.80, 0);
solid.paintRect(1.38, 3.40, 6.62, 3.80, 0);
solid.paintRect(6.18, 2.30, 6.62, 3.80, 0);
solid.paintRect(5.60, 0.30, 7.00, 2.52, 0);
solid.rebuild();

var f = new WS.Fluid({ width: W, height: H, spacing: dp,
                       maxParticles: 10000, solid: solid });
if (process.env.ITER) f.iterations = +process.env.ITER;
if (process.env.SUB) f.substeps = +process.env.SUB;
if (process.env.RELAX) f.relax = +process.env.RELAX;
if (process.env.SOR) f.sor = +process.env.SOR;
if (process.env.DAMP !== undefined) f.pipeDamping = +process.env.DAMP;

// Одна глобальная гексагональная решётка без перекрывающихся fillRect.
// Слева уровень на 30 см выше, труба изначально заполнена.
var dy = dp * Math.sqrt(3) / 2, row = 0;
for (var y = 0.5 + dp * 0.5; y < 3.78; y += dy, row++) {
  var off = row % 2 ? dp * 0.5 : 0;
  for (var x = 0.8 + dp * 0.5 + off; x < 7.2; x += dp) {
    var inLeft = x > 1.0 && x < 2.4 && y > (equalStart ? 1.48 : 1.18) && y < 2.52;
    var inRight = x > 5.6 && x < 7.0 && y > 1.48 && y < 2.52;
    var inLeftShaft = x > 1.4 && x < 1.8 && y > 2.45 && y < 3.82;
    var inRightShaft = x > 6.2 && x < 6.6 && y > 2.45 && y < 3.82;
    var inPipe = x > 1.4 && x < 6.6 && y > 3.42 && y < 3.8;
    if ((inLeft || inRight || inLeftShaft || inRightShaft || inPipe) &&
        solid.sample(x, y) > f.wallOffset) f.add(x, y, 0, 0, 0);
  }
}

function surface(x0, x1) {
  var bins = 12, tops = [];
  for (var b = 0; b < bins; b++) {
    var lo = x0 + (x1 - x0) * b / bins;
    var hi = x0 + (x1 - x0) * (b + 1) / bins;
    var ys = [];
    for (var i = 0; i < f.n; i++)
      if (f.px[i] >= lo && f.px[i] < hi && f.py[i] < 2.55) ys.push(f.py[i]);
    if (ys.length > 5) { ys.sort(function (a, b) { return a - b; }); tops.push(ys[1]); }
  }
  tops.sort(function (a, b) { return a - b; });
  return tops[tops.length >> 1];
}

function report(s) {
  var l = surface(1.12, 2.28), r = surface(5.72, 6.88);
  var lvx = 0, n = 0;
  for (var i = 0; i < f.n; i++) {
    if (f.py[i] > 3.43 && f.py[i] < 3.78 && f.px[i] > 2.1 && f.px[i] < 5.9) {
      lvx += f.vx[i]; n++;
    }
  }
  console.log(String(s).padStart(5) + '  left=' + l.toFixed(4) +
    ' right=' + r.toFixed(4) + ' delta=' + ((r - l) * 100).toFixed(2) +
    ' cm  pipe vx=' + (lvx / Math.max(1, n)).toFixed(4) + ' m/s');
  if (process.env.PROFILE) console.log('       model head=' + (f.stats.pipeHead || 0).toFixed(4) +
    ' speed=' + (f.stats.pipeSpeed || 0).toFixed(4) + ' ends=' + (f.stats.pipeEnds || 0));
}

console.log('particles=' + f.n + ' dp=' + dp + ' iter=' + f.iterations +
            ' sub=' + f.substeps + ' relax=' + f.relax + ' sor=' + f.sor +
            ' inflow=' + inflow);
var emitter = inflow ? new WS.Emitter(f, {
  x: 1.70, y: 0.65, dirX: 0, dirY: 1, speed: 2.4, width: 0.28
}) : null;
report(0);
for (var s = 1; s <= steps; s++) {
  if (emitter) emitter.step(1 / 60);
  f.step(1 / 60);
  if (s === 300 || s === 600 || s === 900 || s === 1200 || s === steps) report(s);
}
