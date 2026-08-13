/*
 * worker.js — рабочий поток физики.
 *
 * Ничего не решает сам: получает от главного потока общую память, собирает
 * над ней свой экземпляр решателя (данные те же самые, копирования нет) и
 * уходит в цикл «ждать команду — посчитать свою долю частиц».
 */
'use strict';

self.onmessage = function (e) {
  var d = e.data;
  if (d.cmd !== 'init') return;

  importScripts('sdf.js?v=' + d.v, 'solver.js?v=' + d.v, 'parstep.js?v=' + d.v);

  var off = 0;
  var arena = {
    buf: d.arena,
    f32: function (n) { var a = new Float32Array(this.buf, off, n); off += n * 4; return a; },
    i32: function (n) { var a = new Int32Array(this.buf, off, n); off += n * 4; return a; }
  };

  var solid = new SDF.SolidView(d.snx, d.sny, d.scell, d.dist);
  var f = new WaterSolver.Fluid({
    width: d.width, height: d.height, spacing: d.spacing, h: d.h,
    maxParticles: d.max, solid: solid, arena: arena
  });

  var ctrl = new Int32Array(d.ctrl);
  var params = new Float64Array(d.params);
  var bounds = new Int32Array(d.bounds);
  var times = new Float64Array(d.times);

  self.postMessage({ msg: 'ready', id: d.id });

  ParStep.workerLoop(f, ctrl, params, d.id, d.nT, function () {
    self.postMessage({ msg: 'done' });
  }, bounds, times);
};
