/*
 * Диагностика сифона. Труба должна быть предварительно заполнена:
 *   node test/siphon.js
 *   PRIME=0 node test/siphon.js
 *   TENSION=0.02 node test/siphon.js
 */
var SDF = require('../js/sdf.js');
var WS = require('../js/solver.js');

var W = 8, H = 4.5, cell = 0.025, dp = 0.046875;
var steps = +(process.env.STEPS || 900);
var primed = process.env.PRIME !== '0';
var kick = +(process.env.KICK || 0);
var solid = new SDF.Solid(Math.ceil(W / cell), Math.ceil(H / cell), cell);
solid.addBorder(3);

// Исходный верхний бак.
solid.paintRect(0.40, 1.00, 2.70, 3.82, 1);
solid.paintRect(0.65, 0.80, 2.45, 3.55, 0);
// Нижний приёмник.
solid.paintRect(5.00, 3.00, 7.60, 4.45, 1);
solid.paintRect(5.25, 2.80, 7.35, 4.20, 0);

// Корпус перевёрнутой U-трубы поверх баков.
solid.paintRect(1.15, 0.35, 1.85, 2.90, 1);
solid.paintRect(1.15, 0.35, 6.20, 1.00, 1);
solid.paintRect(5.50, 0.35, 6.20, 3.75, 1);
// Непрерывный канал, открытый снизу на обоих концах.
solid.paintRect(1.35, 0.55, 1.65, 2.96, 0);
solid.paintRect(1.35, 0.55, 6.00, 0.80, 0);
solid.paintRect(5.70, 0.55, 6.00, 3.82, 0);
solid.rebuild();

var materials = WS.MATERIALS.map(function (m) { return Object.assign({}, m); });
if (process.env.COH) materials[0].coh = +process.env.COH;
var f = new WS.Fluid({ width: W, height: H, spacing: dp,
                       maxParticles: 10000, solid: solid, materials: materials });
if (process.env.TENSION) f.tensionLimit = +process.env.TENSION;
if (process.env.PIPE) f.pipeTension = +process.env.PIPE;
if (process.env.FLOW) f.pipeFlow = +process.env.FLOW;
if (process.env.DRIVE) f.pipeDrive = +process.env.DRIVE;
if (process.env.GRAV !== undefined) f.gravityY = +process.env.GRAV;
if (process.env.SCORR) f.sCorrK = +process.env.SCORR;
if (process.env.SUB) f.substeps = +process.env.SUB;
if (process.env.ITERS) f.iterations = +process.env.ITERS;
if (process.env.MAXCORR) f.maxCorrection = +process.env.MAXCORR;
if (process.env.RELAX) f.relax = +process.env.RELAX;
if (process.env.SOR) f.sor = +process.env.SOR;

function inTube(x, y) {
  return (x > 1.35 && x < 1.65 && y > 0.55 && y < 2.96) ||
         (x > 1.35 && x < 6.00 && y > 0.55 && y < 0.80) ||
         (x > 5.70 && x < 6.00 && y > 0.55 && y < 3.82);
}

// Одна решётка для баков и трубы, чтобы в местах пересечения не было дублей.
var dy = dp * Math.sqrt(3) / 2, row = 0;
for (var y = 0.5 + dp * 0.5; y < 4.2; y += dy, row++) {
  var off = row % 2 ? dp * 0.5 : 0;
  for (var x = 0.45 + dp * 0.5 + off; x < 7.55; x += dp) {
    var source = x > 0.65 && x < 2.45 && y > 1.55 && y < 3.55;
    var receiver = x > 5.25 && x < 7.35 && y > 3.92 && y < 4.20;
    var water = source || receiver || (primed && inTube(x, y));
    if (water && solid.sample(x, y) > f.wallOffset) {
      var vx = 0, vy = 0;
      if (primed && inTube(x, y) && kick) {
        if (x < 1.70 && y > 0.78) vy = -kick;
        else if (x > 5.60 && y > 0.78) vy = kick;
        else vx = kick;
      }
      f.add(x, y, vx, vy, 0);
    }
  }
}

function countSource() {
  var n = 0;
  for (var i = 0; i < f.n; i++) if (f.px[i] < 2.75 && f.py[i] > 0.3) n++;
  return n;
}
function countReceiver() {
  var n = 0;
  for (var i = 0; i < f.n; i++) if (f.px[i] > 5.0 && f.py[i] > 2.75) n++;
  return n;
}
function countTank() {
  var n = 0;
  for (var i = 0; i < f.n; i++)
    if (f.py[i] > 1.0 && f.py[i] < 3.58 && f.px[i] > 0.6 && f.px[i] < 2.5 &&
        (f.px[i] < 1.12 || f.px[i] > 1.88)) n++;
  return n;
}
function countLeftLeg() {
  var n = 0;
  for (var i = 0; i < f.n; i++)
    if (f.px[i] > 1.30 && f.px[i] < 1.70 && f.py[i] > 0.5 && f.py[i] < 2.98) n++;
  return n;
}
function countLoose() {
  var n = 0;
  for (var i = 0; i < f.n; i++) {
    var sourceArea = f.px[i] < 2.75 && f.py[i] > 0.3;
    var receiverArea = f.px[i] > 5.0 && f.py[i] > 2.75;
    if (!sourceArea && !receiverArea && !inTube(f.px[i], f.py[i])) n++;
  }
  return n;
}
function crestCount() {
  var n = 0;
  for (var i = 0; i < f.n; i++)
    if (f.py[i] > 0.53 && f.py[i] < 0.82 && f.px[i] > 1.3 && f.px[i] < 6.05) n++;
  return n;
}
function report(s, s0, r0, t0) {
  var cq = 0, cn = 0, cmin = 9, cnn = 0, cbd = 0, cconf = 0, c10 = 0, c11 = 0, c12 = 0;
  for (var i = 0; i < f.n; i++) {
    if (f.py[i] > 0.53 && f.py[i] < 0.82 && f.px[i] > 1.3 && f.px[i] < 6.05) {
      var q = f.rho[i] / f.rho0;
      cq += q; cnn += f.ncount[i]; cbd += f.bd[i] / f.rho0;
      cconf += f.confined[i];
      if (q > 0.72 && f.ncount[i] >= 10) c10++;
      if (q > 0.72 && f.ncount[i] >= 11) c11++;
      if (q > 0.72 && f.ncount[i] >= 12) c12++;
      cn++; if (q < cmin) cmin = q;
    }
  }
  console.log(String(s).padStart(5) + '  source=' + countSource() +
    ' (' + (countSource() - s0) + ') receiver=' + countReceiver() +
    ' (+' + (countReceiver() - r0) + ') crest=' + crestCount() +
    ' tank=' + countTank() + '(' + (countTank() - t0) + ')' +
    ' leg=' + countLeftLeg() +
    ' loose=' + countLoose() +
    ' rho=' + (cq / Math.max(1, cn)).toFixed(2) + '/' + cmin.toFixed(2) +
    ' nbr=' + (cnn / Math.max(1, cn)).toFixed(1) +
    ' bd=' + (cbd / Math.max(1, cn)).toFixed(2) +
    ' conf=' + cconf + '/' + cn +
    ' pipe=' + (f.stats.pipeLargest || 0) + '@' + (f.stats.pipeSpeed || 0).toFixed(2) +
    '/' + (f.stats.pipeEnds || 0) + ' h=' + (f.stats.pipeHead || 0).toFixed(2) +
    ' a=' + (f.stats.pipeDrive || 0).toFixed(2) +
    ' dense=' + c10 + '/' + c11 + '/' + c12 +
    ' maxV=' + f.maxVelocity().toFixed(2));
  if (process.env.PROFILE && s > 0) {
    var bins = new Array(12).fill(0), speed = new Array(12).fill(0);
    for (var p = 0; p < f.n; p++) {
      if (f.py[p] > 0.50 && f.py[p] < 0.85 && f.px[p] > 1.25 && f.px[p] < 6.10) {
        var b = Math.max(0, Math.min(11, Math.floor((f.px[p] - 1.25) / 4.85 * 12)));
        bins[b]++; speed[b] += f.vx[p];
      }
    }
    console.log('       crest bins=' + bins.join(',') +
      ' vx=' + speed.map(function (v, b) { return (v / Math.max(1, bins[b])).toFixed(2); }).join(','));
  }
}

var source0 = countSource(), receiver0 = countReceiver(), tank0 = countTank();
console.log('particles=' + f.n + ' primed=' + primed +
            ' tension=' + f.tensionLimit + ' kick=' + kick + ' source0=' + source0 +
            ' receiver0=' + receiver0);
report(0, source0, receiver0, tank0);
for (var s = 1; s <= steps; s++) {
  f.step(1 / 60);
  if (s === 120 || s === 300 || s === 600 || s === steps)
    report(s, source0, receiver0, tank0);
}
