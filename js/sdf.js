/*
 * sdf.js — твёрдые тела (стены), которые рисует пользователь.
 *
 * Стены хранятся как булева маска на регулярной сетке. Из маски строится
 * знаковое поле расстояний (SDF) алгоритмом 8SSEDT (Danielsson) — это почти
 * точное евклидово расстояние за два прохода, O(n).
 *
 * SDF нужен физике: расстояние до стенки даёт и глубину проникновения,
 * и нормаль (градиент SDF), и величину "недостающей" жидкости у границы
 * для граничного члена в уравнении плотности.
 *
 * Единицы: сетка в ячейках, наружу вычисляется расстояние в МИРОВЫХ единицах
 * (метрах), положительное вне тела, отрицательное внутри.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SDF = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INF = 1e9;

  /*
   * Общая часть: чтение поля. Живёт отдельно, потому что рабочим потокам
   * нужен только доступ к готовому полю расстояний, а маска и буферы
   * построения — нет.
   */
  function Field() {}

  /*
   * distBuffer — необязательный SharedArrayBuffer: тогда поле расстояний
   * лежит в общей памяти и его видят рабочие потоки без копирования.
   */
  function Solid(nx, ny, cell, distBuffer) {
    this.nx = nx | 0;
    this.ny = ny | 0;
    this.cell = cell;                 // размер ячейки в метрах
    this.invCell = 1 / cell;
    var n = this.nx * this.ny;
    this.mask = new Uint8Array(n);    // 1 = твёрдое
    this.dist = distBuffer ? new Float32Array(distBuffer, 0, n)
                           : new Float32Array(n);  // знаковое расстояние, метры
    // рабочие буферы 8SSEDT (векторы до ближайшей точки, в ячейках)
    this._ax = new Float32Array(n); this._ay = new Float32Array(n);
    this._bx = new Float32Array(n); this._by = new Float32Array(n);
    this.dirty = true;
    this.rebuild();
  }

  /* Обрамление домена: слева/справа/снизу — стенки бака, сверху открыто. */
  Solid.prototype.addBorder = function (thick) {
    var nx = this.nx, ny = this.ny, m = this.mask, t = thick | 0;
    for (var y = 0; y < ny; y++) {
      for (var x = 0; x < nx; x++) {
        if (x < t || x >= nx - t || y >= ny - t) m[y * nx + x] = 1;
      }
    }
    this.dirty = true;
  };

  Solid.prototype.clear = function (keepBorder, thick) {
    this.mask.fill(0);
    if (keepBorder) this.addBorder(thick || 2);
    this.dirty = true;
  };

  /* Круглая кисть в мировых координатах. value: 1 — рисовать, 0 — стирать. */
  Solid.prototype.paintCircle = function (wx, wy, r, value) {
    var cx = wx * this.invCell, cy = wy * this.invCell, cr = r * this.invCell;
    var x0 = Math.max(0, Math.floor(cx - cr)), x1 = Math.min(this.nx - 1, Math.ceil(cx + cr));
    var y0 = Math.max(0, Math.floor(cy - cr)), y1 = Math.min(this.ny - 1, Math.ceil(cy + cr));
    var r2 = cr * cr, m = this.mask, nx = this.nx, changed = false;
    for (var y = y0; y <= y1; y++) {
      var dy = y + 0.5 - cy;
      for (var x = x0; x <= x1; x++) {
        var dx = x + 0.5 - cx;
        if (dx * dx + dy * dy <= r2) {
          var i = y * nx + x;
          if (m[i] !== value) { m[i] = value; changed = true; }
        }
      }
    }
    if (changed) this.dirty = true;
    return changed;
  };

  /* Толстая линия (мазок кисти между двумя точками кадра). */
  Solid.prototype.paintSegment = function (x0, y0, x1, y1, r, value) {
    var dx = x1 - x0, dy = y1 - y0;
    var len = Math.sqrt(dx * dx + dy * dy);
    // шаг штампа заметно меньше радиуса, иначе мазок выходит «гусеницей»
    var steps = Math.max(1, Math.ceil(len / Math.max(this.cell, r * 0.18)));
    var ch = false;
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      if (this.paintCircle(x0 + dx * t, y0 + dy * t, r, value)) ch = true;
    }
    return ch;
  };

  /* Прямоугольник в мировых координатах. */
  Solid.prototype.paintRect = function (wx0, wy0, wx1, wy1, value) {
    var x0 = Math.max(0, Math.floor(Math.min(wx0, wx1) * this.invCell));
    var x1 = Math.min(this.nx - 1, Math.ceil(Math.max(wx0, wx1) * this.invCell));
    var y0 = Math.max(0, Math.floor(Math.min(wy0, wy1) * this.invCell));
    var y1 = Math.min(this.ny - 1, Math.ceil(Math.max(wy0, wy1) * this.invCell));
    for (var y = y0; y <= y1; y++)
      for (var x = x0; x <= x1; x++) this.mask[y * this.nx + x] = value;
    this.dirty = true;
  };

  /* ---- 8SSEDT ---------------------------------------------------------- */

  function pass(gx, gy, nx, ny) {
    var i, x, y;
    function cmp(i, oi, ox, oy) {
      var dx = gx[oi] + ox, dy = gy[oi] + oy;
      var d = dx * dx + dy * dy;
      var cx = gx[i], cy = gy[i];
      if (d < cx * cx + cy * cy) { gx[i] = dx; gy[i] = dy; }
    }
    for (y = 0; y < ny; y++) {
      for (x = 0; x < nx; x++) {
        i = y * nx + x;
        if (x > 0) cmp(i, i - 1, 1, 0);
        if (y > 0) cmp(i, i - nx, 0, 1);
        if (x > 0 && y > 0) cmp(i, i - nx - 1, 1, 1);
        if (x < nx - 1 && y > 0) cmp(i, i - nx + 1, -1, 1);
      }
      for (x = nx - 2; x >= 0; x--) { i = y * nx + x; cmp(i, i + 1, -1, 0); }
    }
    for (y = ny - 1; y >= 0; y--) {
      for (x = nx - 1; x >= 0; x--) {
        i = y * nx + x;
        if (x < nx - 1) cmp(i, i + 1, -1, 0);
        if (y < ny - 1) cmp(i, i + nx, 0, -1);
        if (x < nx - 1 && y < ny - 1) cmp(i, i + nx + 1, -1, -1);
        if (x > 0 && y < ny - 1) cmp(i, i + nx - 1, 1, -1);
      }
      for (x = 1; x < nx; x++) { i = y * nx + x; cmp(i, i - 1, 1, 0); }
    }
  }

  Solid.prototype.rebuild = function () {
    var n = this.nx * this.ny, m = this.mask;
    var ax = this._ax, ay = this._ay, bx = this._bx, by = this._by;
    for (var i = 0; i < n; i++) {
      if (m[i]) { ax[i] = 0; ay[i] = 0; bx[i] = INF; by[i] = INF; }
      else { ax[i] = INF; ay[i] = INF; bx[i] = 0; by[i] = 0; }
    }
    pass(ax, ay, this.nx, this.ny);   // расстояние до твёрдого
    pass(bx, by, this.nx, this.ny);   // расстояние до пустоты
    var d = this.dist, cell = this.cell;
    for (i = 0; i < n; i++) {
      var da = Math.sqrt(ax[i] * ax[i] + ay[i] * ay[i]);
      var db = Math.sqrt(bx[i] * bx[i] + by[i] * by[i]);
      // -0.5 ячейки: граница проходит по середине между центрами пикселей
      d[i] = (da - db - 0.5) * cell;
    }
    this.dirty = false;
  };

  Solid.prototype.update = function () { if (this.dirty) this.rebuild(); };

  /* Билинейная выборка SDF. Вне сетки — экстраполяция краевым значением. */
  Field.prototype.sample = function (wx, wy) {
    var fx = wx * this.invCell - 0.5, fy = wy * this.invCell - 0.5;
    var x0 = Math.floor(fx), y0 = Math.floor(fy);
    var tx = fx - x0, ty = fy - y0;
    var nx = this.nx, ny = this.ny, d = this.dist;
    var x1 = x0 + 1, y1 = y0 + 1;
    if (x0 < 0) x0 = 0; else if (x0 > nx - 1) x0 = nx - 1;
    if (x1 < 0) x1 = 0; else if (x1 > nx - 1) x1 = nx - 1;
    if (y0 < 0) y0 = 0; else if (y0 > ny - 1) y0 = ny - 1;
    if (y1 < 0) y1 = 0; else if (y1 > ny - 1) y1 = ny - 1;
    var a = d[y0 * nx + x0], b = d[y0 * nx + x1];
    var c = d[y1 * nx + x0], e = d[y1 * nx + x1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (e - c) * tx) * ty;
  };

  /*
   * Расстояние + нормаль (единичный градиент SDF, направлен ИЗ тела).
   * out[0]=nx, out[1]=ny. Возвращает знаковое расстояние.
   */
  Field.prototype.probe = function (wx, wy, out) {
    var d = this.sample(wx, wy);
    var e = this.cell;
    var gx = this.sample(wx + e, wy) - this.sample(wx - e, wy);
    var gy = this.sample(wx, wy + e) - this.sample(wx, wy - e);
    var l = Math.sqrt(gx * gx + gy * gy);
    if (l > 1e-12) { out[0] = gx / l; out[1] = gy / l; }
    else { out[0] = 0; out[1] = -1; }
    return d;
  };

  Solid.prototype.solidAt = function (wx, wy) {
    var x = Math.floor(wx * this.invCell), y = Math.floor(wy * this.invCell);
    if (x < 0 || y < 0 || x >= this.nx || y >= this.ny) return 0;
    return this.mask[y * this.nx + x];
  };

  // Solid умеет всё, что умеет Field, плюс рисование и перестройку
  Solid.prototype.sample = Field.prototype.sample;
  Solid.prototype.probe = Field.prototype.probe;

  /*
   * Только чтение готового поля из общей памяти — то, что нужно рабочему
   * потоку. Ни маски, ни буферов построения он не заводит.
   */
  function SolidView(nx, ny, cell, distBuffer) {
    this.nx = nx | 0; this.ny = ny | 0;
    this.cell = cell; this.invCell = 1 / cell;
    this.dist = new Float32Array(distBuffer, 0, this.nx * this.ny);
  }
  SolidView.prototype = Object.create(Field.prototype);
  SolidView.prototype.constructor = SolidView;

  return { Solid: Solid, SolidView: SolidView, Field: Field };
}));
