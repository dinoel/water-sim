/*
 * solver.js — Position Based Fluids (Macklin & Müller, SIGGRAPH 2013), 2D.
 *
 * Никаких обращений к DOM: файл грузится и в браузере, и в node (тесты).
 *
 * Физика:
 *   - несжимаемость через проекцию ограничения плотности C_i = rho_i/rho0 - 1
 *   - ядра Poly6 / Spiky в ДВУМЕРНОЙ нормировке (4/(pi h^8), grad -30/(pi h^5))
 *   - rho0 не захардкожена, а измеряется на гексагональной упаковке при старте,
 *     поэтому шаг частиц dp и радиус ядра h можно менять свободно
 *   - artificial pressure s_corr (борьба с tensile instability)
 *   - XSPH-вязкость, vorticity confinement (возврат сбитой завихрённости)
 *   - когезия и член кривизны по Akinci — капли, мениск, поверхностное натяжение
 *   - адгезия к стенкам: вода смачивает поверхность и стекает по ней
 *   - граница: SDF + аналитический граничный член плотности. Недостающая
 *     за стенкой жидкость считается интегралом ядра по полуплоскости —
 *     таблица считается численно при инициализации, поэтому давление у стенки
 *     физически корректно, а не подобрано на глаз
 *   - непрерывная детекция столкновений (марш по SDF): быстрые капли не
 *     проскакивают сквозь тонкие стенки
 *
 * Производительность: частицы каждый кадр физически переупорядочиваются по
 * ячейкам сетки — соседи лежат рядом в памяти, кэш попадает.
 *
 * Единицы СИ: метры, секунды, g = 9.81 м/с². Масса частицы m = 1 (условная),
 * rho0 — поверхностная плотность в 2D; силы, зависящие от массы, имеют
 * собственные безразмерные коэффициенты.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaterSolver = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Потолок числа соседей. При h = 2.2*dp равновесная упаковка даёт ~16,
  // в ударах и сжатии наблюдалось до 21 — 32 оставляет запас и при этом
  // держит списки соседей вдвое компактнее в кэше.
  var MAXN = 32;
  var MAX_SLOTS = 32;      // потолок числа рабочих потоков
  var SLOT_STRIDE = 16;    // 16 * 4 байта = линия кэша на поток
  var SQRT3_2 = Math.sqrt(3) / 2;

  /* ------------------------------------------------------------------ */
  /* Граничная таблица: какая доля ядра срезана полуплоскостью, стоящей
   * на расстоянии d от частицы. missing(d) = ∫_{x < -d} W dA / ∫ W dA.    */
  function buildBoundaryTable(h, samples) {
    samples = samples || 256;
    var k6 = 4 / (Math.PI * Math.pow(h, 8));
    var h2 = h * h, M = 512;
    var lin = new Float32Array(samples + 1);
    var i, j;
    for (i = 0; i <= samples; i++) {
      var x = -h + 2 * h * i / samples;
      var ymax = Math.sqrt(Math.max(0, h2 - x * x));
      var s = 0, dy = 2 * ymax / M;
      for (j = 0; j <= M; j++) {
        var y = -ymax + dy * j;
        var r2 = x * x + y * y;
        if (r2 < h2) {
          var t = h2 - r2, w = k6 * t * t * t;
          s += (j === 0 || j === M) ? 0.5 * w : w;
        }
      }
      lin[i] = s * dy;
    }
    var cum = new Float32Array(samples + 1), acc = 0, dx = 2 * h / samples;
    for (i = 0; i <= samples; i++) {
      if (i > 0) acc += 0.5 * (lin[i] + lin[i - 1]) * dx;
      cum[i] = acc;
    }
    var total = cum[samples] || 1;
    var tbl = new Float32Array(samples + 1);
    for (i = 0; i <= samples; i++) {
      var d = -h + 2 * h * i / samples;
      var f = (-d + h) / (2 * h) * samples;
      var i0 = Math.max(0, Math.min(samples, Math.floor(f)));
      var i1 = Math.min(samples, i0 + 1);
      var tt = f - i0;
      tbl[i] = (cum[i0] * (1 - tt) + cum[i1] * tt) / total;
    }
    return { table: tbl, samples: samples, h: h };
  }

  /* ------------------------------------------------------------------ */
  /*
   * Арена памяти. В однопоточном режиме массивы обычные, в многопоточном —
   * нарезаются из общего SharedArrayBuffer, чтобы воркеры видели одни и те
   * же данные без копирования. Размер считается заранее: если формула
   * разойдётся с фактическими выделениями, арена сразу упадёт с ошибкой,
   * а не тихо отдаст пересекающиеся куски.
   */
  function Arena(bytes) {
    var SAB = (typeof SharedArrayBuffer !== 'undefined') ? SharedArrayBuffer : ArrayBuffer;
    this.buf = new SAB(bytes);
    this.off = 0;
    this.shared = (SAB !== ArrayBuffer);
  }
  Arena.prototype._take = function (n, bytesPer) {
    var need = n * bytesPer;
    if (this.off + need > this.buf.byteLength)
      throw new Error('арена памяти исчерпана: нужно ' + (this.off + need) +
                      ', выделено ' + this.buf.byteLength);
    var o = this.off; this.off += need;
    return o;
  };
  Arena.prototype.f32 = function (n) { return new Float32Array(this.buf, this._take(n, 4), n); };
  Arena.prototype.i32 = function (n) { return new Int32Array(this.buf, this._take(n, 4), n); };

  /* ------------------------------------------------------------------ */
  /* Материалы                                                           */

  var MAX_MAT = 8;
  var MAT_STRIDE = 16;        // слот на материал, с запасом и по линии кэша
  // индексы внутри слота
  var M_GSCALE = 0, M_VISC = 1, M_COH = 2, M_CURV = 3,
      M_ADH = 4, M_FRIC = 5, M_FOAM = 6, M_FOAMLIFE = 7, M_DRAG = 8;

  /*
   * Свойства взяты настоящие, в системе СИ. Пересчёт в коэффициенты
   * решателя — ниже, и он честно оговорен там, где не линеен.
   *
   *              плотность  вязкость(Па·с)  натяжение(Н/м)  краевой угол
   *   вода          998        0.0010           0.072          ~20° (смачивает)
   *   масло         915        0.0800           0.032          ~10° (смачивает сильно)
   *   пиво         1010        0.0018           0.045          ~25°
   *   ртуть       13534        0.0015           0.486         ~140° (НЕ смачивает)
   *
   * Ртуть тяжелее воды в 13.6 раза и при этом текучее её: кинематическая
   * вязкость 1.1e-7 против 1.0e-6 у воды. Масло наоборот — 8.7e-5, почти в
   * сто раз гуще воды.
   */
  var MATERIALS = [
    {
      key: 'water', name: 'Вода', density: 998,
      visc: 0.06, coh: 5.0, curv: 0.12, adh: 0.20, fric: 0.05,
      foam: 5, foamLife: 0.7, drag: 0.02,
      // 1/м, настоящие коэффициенты поглощения воды
      absorb: [0.45, 0.075, 0.025], scatter: [0.030, 0.055, 0.085],
      ior: 1.333, metal: 0, rough: 0.0,
      foamColor: [0.93, 0.96, 0.99]
    },
    {
      key: 'oil', name: 'Масло', density: 915,
      visc: 0.55, coh: 2.2, curv: 0.10, adh: 0.34, fric: 0.10,
      foam: 0.8, foamLife: 0.25, drag: 0.05,
      // оливковое: жёлто-зелёное, синий гасит почти нацело
      absorb: [0.30, 0.16, 2.40], scatter: [0.10, 0.09, 0.025],
      ior: 1.47, metal: 0, rough: 0.0,
      foamColor: [0.90, 0.86, 0.62]
    },
    {
      key: 'beer', name: 'Пиво', density: 1010,
      visc: 0.07, coh: 3.1, curv: 0.12, adh: 0.22, fric: 0.05,
      // пена стабилизирована белком: набирается быстро, живёт долго
      foam: 14, foamLife: 5.0, drag: 0.02,
      absorb: [0.42, 0.95, 3.20], scatter: [0.09, 0.05, 0.015],
      ior: 1.34, metal: 0, rough: 0.0,
      foamColor: [0.97, 0.94, 0.86]
    },
    {
      key: 'mercury', name: 'Ртуть', density: 13534,
      // натяжение в 6.75 раза больше воды, стенки не смачивает вовсе —
      // прилипание отрицательное, отсюда шарики и выпуклый мениск
      visc: 0.03, coh: 33.0, curv: 0.30, adh: -0.40, fric: 0.02,
      foam: 0, foamLife: 0.2, drag: 0.01,
      absorb: [0, 0, 0], scatter: [0, 0, 0],
      ior: 1.0, metal: 1, rough: 0.06,
      foamColor: [0.85, 0.85, 0.88]
    }
  ];

  var REF_DENSITY = 998;      // всё считается относительно воды

  /*
   * Усиление перепада весов и его границы.
   *
   * Теория даёт для капли масла радиусом 0.28 м в воде скорость всплытия
   * порядка sqrt(A*g*L) = 0.34 м/с (число Атвуда A = 0.043) — то есть
   * расслоение за считанные секунды. Схема же при линейном перепаде давала
   * 3 см за 15 секунд: численная диссипация душит всплытие примерно
   * стократно. Проверено, что виновата не вязкость (её снижение вдесятеро
   * ускоряет всплытие лишь вдвое), а само рассеяние в решателе.
   *
   * Поэтому перепад умножается на GAIN. Это компенсация затухания, а не
   * украшательство: с ним исход становится физически верным — масло
   * всплывает и собирается сверху, как и положено. Знаки и порядок
   * плотностей при этом остаются настоящими.
   */
  var BUOY_GAIN = 4;
  var GSCALE_MAX = 3;         // потолок «тяжелее окружения»
  var GSCALE_MIN = -0.75;     // и «легче»

  /*
   * Насколько слабее держатся друг за друга частицы РАЗНЫХ жидкостей.
   * Это и есть несмешиваемость: своё притягивает своё сильнее, чем чужое,
   * поэтому масло и вода сами собираются в отдельные слои. Механизм тот
   * же, что и в природе, — разница межфазного натяжения.
   */
  var MIX_COHESION = 0.15;

  /*
   * Сколько байт нужно арене. Список обязан совпадать с выделениями в
   * конструкторе — при расхождении арена бросит исключение на первом же
   * запуске, поэтому ошибка не проходит незамеченной.
   */
  Fluid.arenaBytes = function (m, cells) {
    var f32 = 26 * m + 2 * m * MAXN + 2 * MAX_SLOTS * SLOT_STRIDE
            + MAX_MAT * MAT_STRIDE;
    var i32 = 6 * m + m * MAXN + 2 * cells;
    return (f32 + i32) * 4 + 64;
  };

  function Fluid(cfg) {
    this.width = cfg.width;                 // ширина домена, м
    this.height = cfg.height;               // высота домена, м
    this.dp = cfg.spacing;                  // равновесное расстояние между частицами
    this.h = cfg.h || this.dp * 2.2;        // радиус ядра (~14 соседей в 2D)
    this.max = cfg.maxParticles || 20000;
    this.solid = cfg.solid || null;

    // --- параметры, все меняются на лету ---
    this.gravityX = 0;
    this.gravityY = 9.81;
    // Порог жёсткий: меньше ~9 проекций за кадр — глубокая колонна воды
    // недосходится и начинает «кипеть», выбрасывая частицы вверх.
    // Подшаги при этом важнее итераций (связывают скорости с позициями).
    this.iterations = 3;
    this.substeps = 3;
    this.relax = 3.0e-4;      // CFM-релаксация, в долях типичной суммы градиентов
    this.sor = 1.2;           // сверхрелаксация поправки позиции (>1.4 нестабильно)
    this.maxCorrection = 0.35;// потолок поправки за итерацию, в долях dp
    /*
     * Насколько жидкости позволено «тянуть» саму себя. 0 — давление только
     * на сжатие (свободная поверхность гарантированно не слипается), но
     * тогда разогнавшаяся струя не может стянуться по неразрывности и просто
     * разрежается вместо того, чтобы сузиться.
     */
    this.tensionLimit = 0;
    this.sCorrK = 1.0e-4;     // artificial pressure
    this.sCorrDq = 0.25;      // в долях h
    this.viscosity = 0.06;    // XSPH
    this.vorticity = 0.35;    // vorticity confinement
    /*
     * Поверхностное натяжение. Оно же удерживает падающую струю: при 0.4
     * струя разрежалась втрое (ρ падала до 0.28 от ρ0) и расползалась, при 5
     * держит ρ~0.9 и сужается — как и положено по неразрывности. Свободную
     * поверхность бассейна при этом не портит: ровность и дрейф не меняются,
     * а капля в невесомости становится круглой (вытянутость 1.74 -> 1.13).
     */
    this.cohesion = 5.0;      // м/с² на соседа
    this.curvature = 0.12;    // член кривизны Akinci
    this.adhesion = 0.20;     // прилипание к стенкам
    this.friction = 0.05;     // трение о стенку
    this.foamRate = 5;        // скорость набора вспенивания
    this.buoyancy = BUOY_GAIN;
    this.wetClimb = 8.0;      // сила линии контакта (ограничена долей g ниже)
    this.maxSpeed = 26;       // м/с, страховочный кламп
    this.drag = 0.02;         // сопротивление воздуха, 1/с

    this.n = 0;
    var m = this.max;

    // --- сетка соседей (размеры нужны до выделения памяти) ---
    this.cell = this.h;
    this.gnx = Math.max(1, Math.ceil(this.width / this.cell) + 2);
    this.gny = Math.max(1, Math.ceil(this.height / this.cell) + 4);
    var cells = this.gnx * this.gny + 1;

    // Все массивы решателя выделяются из одной арены: в многопоточном режиме
    // это общий SharedArrayBuffer, и воркеры работают с теми же данными.
    var A = cfg.arena || new Arena(Fluid.arenaBytes(m, cells));
    this.arena = A;
    var f32 = function (k) { return A.f32(k); }, i32 = function (k) { return A.i32(k); };

    this.px = f32(m); this.py = f32(m);
    this.qx = f32(m); this.qy = f32(m);          // предсказанные
    this.vx = f32(m); this.vy = f32(m);
    this.dx = f32(m); this.dy = f32(m);
    this.rho = f32(m);
    this.lam = f32(m);
    this.omg = f32(m);
    this.nrmX = f32(m); this.nrmY = f32(m);
    this.bd = f32(m);                 // граничная плотность
    this.bg = f32(m);                 // её производная по расстоянию
    this.bnx = f32(m); this.bny = f32(m);
    this.bdist = f32(m);
    this.foam = f32(m);
    this.mat = i32(m);                // какая жидкость в этой частице
    /*
     * Таблица свойств жидкостей лежит в той же общей памяти, что и частицы:
     * рабочие потоки читают её напрямую, без пересылки.
     */
    this.matParams = f32(MAX_MAT * MAT_STRIDE);

    this.nbr = i32(m * MAXN);
    this.ncount = i32(m);
    // Кэш на итерацию: коэффициент градиента ядра и готовое слагаемое
    // artificial pressure. Позиции между двумя проходами одной итерации не
    // меняются, поэтому второй проход не пересчитывает корень и ядро заново.
    this.gmC = f32(m * MAXN);
    this.scC = f32(m * MAXN);

    // буферы перестановки
    this._sx = f32(m); this._sy = f32(m);
    this._sqx = f32(m); this._sqy = f32(m);
    this._svx = f32(m); this._svy = f32(m);
    this._sf = f32(m);
    this._smat = i32(m);
    this.perm = i32(m);
    this.cellOf = i32(m);
    /*
     * Список пристеночных частиц. Каждый поток пишет в свой участок,
     * начинающийся с его первого индекса: длина участка заведомо не больше
     * числа частиц потока, поэтому пересечений быть не может.
     */
    this.near = i32(m);
    /*
     * Счётчики потоков разнесены на 64 байта (SLOT_STRIDE): если положить их
     * подряд, все потоки будут писать в одну линию кэша, и каждая запись
     * станет отбирать её у соседей — ложное разделение.
     */
    this.nearN = i32(MAX_SLOTS * SLOT_STRIDE);   // длина участка для потока
    this.compAcc = f32(MAX_SLOTS * SLOT_STRIDE); // частичные суммы сжатия

    this.gcount = i32(cells);
    this.gstart = i32(cells);

    // --- константы ядер (2D!) ---
    this.k6 = 4 / (Math.PI * Math.pow(this.h, 8));
    this.kSpiky = -30 / (Math.PI * Math.pow(this.h, 5));
    /*
     * Градиент берём у Spiky, хотя корень и деление в нём — самая дорогая
     * операция горячего цикла. Замена на градиент Poly6 (-6*k6*(h^2-r^2)^2 *
     * r_vec) убирает и корень, и деление и даёт 21% скорости, но проверка
     * показала цену: минимальное расстояние между соседями падает до 0.02*dp,
     * то есть частицы слипаются в совпадающие пары, и столб воды разваливается.
     * Причина общая для всех таких ядер: градиент вида «полином от r^2,
     * умноженный на r_vec» обнуляется при r->0, и на малых расстояниях просто
     * нет отталкивания. У Spiky множитель 1/r его сохраняет.
     */

    this.rho0 = this.measureRestDensity();
    this.gradSumSq0 = this.measureGradSumSq();
    this.wDq = this.poly6(this.sCorrDq * this.h);

    var bt = buildBoundaryTable(this.h, 256);
    this.bTable = bt.table; this.bSamples = bt.samples;
    this.wallOffset = this.measureWallOffset();

    this._probe = [0, 0];
    this.stats = { compression: 0 };
    this.setMaterials(cfg.materials || MATERIALS);
  }

  /*
   * Заполнить таблицу свойств жидкостей. Вызывается и при запуске, и когда
   * пользователь двигает ползунки. Записи атомарности не требуют: значения
   * меняются плавно, и один кадр со смешанным набором физически безобиден.
   */
  /*
   * Опора для выталкивающей силы — вес СРЕДИННОЙ жидкости, а не средний.
   *
   * Среднее не годится: ртуть тяжелее воды в 13.6 раза и одна утаскивает
   * его так далеко, что и масло, и вода оказываются легче опоры в пять раз
   * и обе упираются в ограничитель — различие между ними пропадает, и слои
   * встают в случайном порядке. Медиана к таким выбросам нечувствительна:
   * при воде с маслом опорой станет одна из них, при чистой ртути — ртуть
   * (и тогда она получает ровно g, как и должна одинокая жидкость).
   *
   * Считается по числу частиц каждой жидкости, поэтому это один проход и
   * сортировка четырёх чисел.
   */
  Fluid.prototype.updateAmbient = function () {
    var n = this.n, mat = this.mat, mp = this.matParams;
    if (n === 0) { this.ambientG = 1; return 1; }
    var cnt = this._matCount || (this._matCount = new Int32Array(MAX_MAT));
    cnt.fill(0);
    for (var i = 0; i < n; i++) cnt[mat[i]]++;
    var order = [];
    for (var m = 0; m < MAX_MAT; m++) if (cnt[m]) order.push(m);
    order.sort(function (a, b) {
      return mp[a * MAT_STRIDE + M_GSCALE] - mp[b * MAT_STRIDE + M_GSCALE];
    });
    var half = n * 0.5, acc = 0, med = 1;
    for (var k = 0; k < order.length; k++) {
      med = mp[order[k] * MAT_STRIDE + M_GSCALE];
      acc += cnt[order[k]];
      if (acc >= half) break;
    }
    this.ambientG = med;
    return med;
  };

  Fluid.prototype.setMaterials = function (list) {
    var p = this.matParams;
    this.materials = list;
    for (var i = 0; i < list.length && i < MAX_MAT; i++) {
      var m = list[i], o = i * MAT_STRIDE;
      // вес относительно воды: >1 тонет, <1 всплывает. Хранится настоящий,
      // усиление и ограничение накладываются уже в горячем цикле.
      p[o + M_GSCALE] = m.density / REF_DENSITY;
      p[o + M_VISC] = m.visc;
      p[o + M_COH] = m.coh;
      p[o + M_CURV] = m.curv;
      p[o + M_ADH] = m.adh;
      p[o + M_FRIC] = m.fric;
      p[o + M_FOAM] = m.foam;
      p[o + M_FOAMLIFE] = m.foamLife;
      p[o + M_DRAG] = m.drag;
    }
  };

  Fluid.prototype.poly6 = function (r) {
    if (r >= this.h) return 0;
    var t = this.h * this.h - r * r;
    return this.k6 * t * t * t;
  };

  /* rho0 измеряется, а не задаётся: сумма ядра по идеальной гексагональной
   * упаковке с шагом dp. Ядро и шаг частиц согласованы при любых dp/h. */
  Fluid.prototype.measureRestDensity = function () {
    var s = 0, h = this.h, dp = this.dp, h2 = h * h;
    var rows = Math.ceil(h / (dp * SQRT3_2)) + 2;
    var cols = Math.ceil(h / dp) + 2;
    for (var j = -rows; j <= rows; j++) {
      var off = (Math.abs(j) % 2) ? 0.5 : 0;
      for (var i = -cols; i <= cols; i++) {
        var x = (i + off) * dp, y = j * dp * SQRT3_2;
        var r2 = x * x + y * y;
        if (r2 < h2) { var t = h2 - r2; s += this.k6 * t * t * t; }
      }
    }
    return s;
  };

  /* Типичное sum_k |grad_k C_i|^2 на равновесной упаковке: делает
   * CFM-релаксацию безразмерной долей, не зависящей от масштаба. */
  Fluid.prototype.measureGradSumSq = function () {
    var h = this.h, dp = this.dp, ks = this.kSpiky;
    var rows = Math.ceil(h / (dp * SQRT3_2)) + 2;
    var cols = Math.ceil(h / dp) + 2;
    var sgx = 0, sgy = 0, sum = 0;
    for (var j = -rows; j <= rows; j++) {
      var off = (Math.abs(j) % 2) ? 0.5 : 0;
      for (var i = -cols; i <= cols; i++) {
        var x = (i + off) * dp, y = j * dp * SQRT3_2;
        var r = Math.sqrt(x * x + y * y);
        if (r < 1e-9 || r >= h) continue;
        var t = h - r, gm = ks * t * t / r;
        var gx = gm * x, gy = gm * y;
        sgx += gx; sgy += gy;
        sum += gx * gx + gy * gy;
      }
    }
    return (sum + sgx * sgx + sgy * sgy) / (this.rho0 * this.rho0);
  };

  Fluid.prototype.boundaryMissing = function (d) {
    var h = this.h;
    if (d >= h) return 0;
    if (d <= -h) return 1;
    var f = (d + h) / (2 * h) * this.bSamples;
    var i0 = f | 0, t = f - i0;
    if (i0 >= this.bSamples) return this.bTable[this.bSamples];
    return this.bTable[i0] * (1 - t) + this.bTable[i0 + 1] * t;
  };

  /*
   * На каком расстоянии от стенки лежит равновесный слой воды?
   *
   * Считаем плотность частицы, стоящей на расстоянии d от плоской стенки:
   * реальные соседи — полупространство гексагональной упаковки, плюс
   * граничный член rho0*missing(d) вместо жидкости за стенкой. Ищем d,
   * при котором сумма ровно rho0. Если взять это расстояние «на глаз»,
   * каждая пристеночная частица получает систематическую ошибку плотности,
   * решатель постоянно её «исправляет» и накачивает воду энергией.
   */
  Fluid.prototype.measureWallOffset = function () {
    var h = this.h, dp = this.dp, h2 = h * h, k6 = this.k6, rho0 = this.rho0;
    var s = dp * SQRT3_2;
    var rows = Math.ceil(h / s) + 2, cols = Math.ceil(h / dp) + 2;
    var self = this;
    function densityAt(d) {
      // частица в начале координат, стенка на расстоянии d ниже (y = +d),
      // жидкость заполняет полупространство y <= 0 слоями через s
      var sum = k6 * h2 * h2 * h2;                 // собственный вклад
      for (var j = 0; j <= rows; j++) {
        var y = -j * s;
        var off = (j % 2) ? 0.5 : 0;
        for (var i = -cols; i <= cols; i++) {
          if (j === 0 && i === 0) continue;
          var x = (i + off) * dp;
          var r2 = x * x + y * y;
          if (r2 < h2) { var t = h2 - r2; sum += k6 * t * t * t; }
        }
      }
      return sum + rho0 * self.boundaryMissing(d);
    }
    var lo = dp * 0.15, hi = dp * 1.1;
    for (var it = 0; it < 40; it++) {
      var mid = 0.5 * (lo + hi);
      if (densityAt(mid) > rho0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  };

  /* ------------------------------------------------------------------ */
  /* Частицы                                                             */

  Fluid.prototype.add = function (x, y, vx, vy, mat) {
    if (this.n >= this.max) return -1;
    var i = this.n++;
    this.px[i] = x; this.py[i] = y;
    this.vx[i] = vx || 0; this.vy[i] = vy || 0;
    this.foam[i] = 0; this.rho[i] = this.rho0;
    this.mat[i] = mat || 0;
    return i;
  };

  Fluid.prototype.remove = function (i) {
    var last = --this.n;
    if (i !== last) {
      this.px[i] = this.px[last]; this.py[i] = this.py[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
      this.foam[i] = this.foam[last]; this.mat[i] = this.mat[last];
    }
  };

  Fluid.prototype.clear = function () { this.n = 0; };

  /* Заполнить прямоугольник гексагональной упаковкой — той же, на которой
   * измерена rho0, поэтому жидкость стартует ровно в равновесии. */
  Fluid.prototype.fillRect = function (x0, y0, x1, y1, jitter, mat) {
    var dp = this.dp, dy = dp * SQRT3_2, row = 0;
    jitter = jitter === undefined ? 0.02 : jitter;
    for (var y = y0 + dp * 0.5; y < y1; y += dy, row++) {
      var off = (row % 2) ? dp * 0.5 : 0;
      for (var x = x0 + dp * 0.5 + off; x < x1; x += dp) {
        if (this.n >= this.max) return;
        if (this.solid && this.solid.sample(x, y) < dp * 0.55) continue;
        this.add(x + (Math.random() - 0.5) * dp * jitter,
                 y + (Math.random() - 0.5) * dp * jitter, 0, 0, mat || 0);
      }
    }
  };

  /* ------------------------------------------------------------------ */
  /* Сетка: сортировка подсчётом + физическая перестановка частиц         */

  /*
   * Результат перестановки ВСЕГДА копируется обратно в исходные массивы.
   *
   * Заманчиво вместо копирования просто поменять местами ссылки на буферы —
   * это бесплатно. Но ссылки живут в объекте конкретного потока, а данные —
   * общие. Стоит главному потоку сделать хоть один шаг самому (а он это
   * делает, пока поднимается пул воркеров), и его ссылки разъезжаются с
   * ссылками воркеров: одни пишут в один буфер, другие читают из другого.
   * Ломается при этом через раз — за шаг перестановок несколько, и всё
   * решает их чётность. Копирование стоит n*7*4 байт, единицы микросекунд,
   * и снимает целый класс таких ошибок.
   */
  Fluid.prototype.sortParticles = function () {
    var n = this.n, gnx = this.gnx, gny = this.gny, inv = 1 / this.cell;
    var gc = this.gcount, gs = this.gstart, cellOf = this.cellOf, perm = this.perm;
    var qx = this.qx, qy = this.qy;
    var nc = gnx * gny, i, c;
    gc.fill(0);
    for (i = 0; i < n; i++) {
      var cx = (qx[i] * inv + 1) | 0, cy = (qy[i] * inv + 2) | 0;
      if (cx < 0) cx = 0; else if (cx >= gnx) cx = gnx - 1;
      if (cy < 0) cy = 0; else if (cy >= gny) cy = gny - 1;
      c = cy * gnx + cx;
      cellOf[i] = c;
      gc[c]++;
    }
    var sum = 0;
    for (c = 0; c < nc; c++) { gs[c] = sum; sum += gc[c]; gc[c] = gs[c]; }
    gs[nc] = sum;
    for (i = 0; i < n; i++) perm[gc[cellOf[i]]++] = i;

    // физически переставляем — соседи оказываются рядом в памяти
    var sx = this._sx, sy = this._sy, sqx = this._sqx, sqy = this._sqy;
    var svx = this._svx, svy = this._svy, sf = this._sf, smt = this._smat;
    var px = this.px, py = this.py, vx = this.vx, vy = this.vy, fm = this.foam;
    var mt = this.mat;
    for (i = 0; i < n; i++) {
      var p = perm[i];
      sx[i] = px[p]; sy[i] = py[p];
      sqx[i] = qx[p]; sqy[i] = qy[p];
      svx[i] = vx[p]; svy[i] = vy[p];
      smt[i] = mt[p];
      sf[i] = fm[p];
    }
    px.set(sx.subarray(0, n)); py.set(sy.subarray(0, n));
    qx.set(sqx.subarray(0, n)); qy.set(sqy.subarray(0, n));
    vx.set(svx.subarray(0, n)); vy.set(svy.subarray(0, n));
    fm.set(sf.subarray(0, n)); mt.set(smt.subarray(0, n));
  };

  /*
   * Поиск соседей по половине окрестности. Пара i–j проверяется один раз,
   * а записывается в оба списка: это ровно вдвое меньше вычислений
   * расстояния. Обходим ячейки по порядку; «вперёд» — это остаток своей
   * ячейки, соседняя справа и три ячейки строкой ниже (они лежат в памяти
   * подряд, поэтому берутся одним диапазоном).
   */
  Fluid.prototype.findNeighbors = function () {
    var n = this.n, gnx = this.gnx, gny = this.gny;
    var gs = this.gstart, qx = this.qx, qy = this.qy, h2 = this.h * this.h;
    var nbr = this.nbr, ncount = this.ncount;
    var i, j, rx, ry, ci, cj;

    for (i = 0; i < n; i++) ncount[i] = 0;

    for (var cy = 0; cy < gny; cy++) {
      var rowBelow = (cy + 1) * gnx;
      for (var cx = 0; cx < gnx; cx++) {
        var c = cy * gnx + cx;
        var s = gs[c], e = gs[c + 1];
        if (s === e) continue;
        // диапазон «вперёд» вне своей ячейки: правый сосед + три снизу
        var rs = (cx + 1 < gnx) ? gs[c + 1] : 0;
        var re = (cx + 1 < gnx) ? gs[c + 2] : 0;
        var bs = 0, be = 0;
        if (cy + 1 < gny) {
          var bx0 = cx > 0 ? cx - 1 : 0, bx1 = cx < gnx - 1 ? cx + 1 : gnx - 1;
          bs = gs[rowBelow + bx0]; be = gs[rowBelow + bx1 + 1];
        }
        for (i = s; i < e; i++) {
          var xi = qx[i], yi = qy[i];
          ci = ncount[i];
          var bi = i * MAXN;
          for (j = i + 1; j < e; j++) {
            rx = xi - qx[j]; ry = yi - qy[j];
            if (rx * rx + ry * ry < h2) {
              if (ci < MAXN) nbr[bi + ci++] = j;
              cj = ncount[j];
              if (cj < MAXN) { nbr[j * MAXN + cj] = i; ncount[j] = cj + 1; }
            }
          }
          for (j = rs; j < re; j++) {
            rx = xi - qx[j]; ry = yi - qy[j];
            if (rx * rx + ry * ry < h2) {
              if (ci < MAXN) nbr[bi + ci++] = j;
              cj = ncount[j];
              if (cj < MAXN) { nbr[j * MAXN + cj] = i; ncount[j] = cj + 1; }
            }
          }
          for (j = bs; j < be; j++) {
            rx = xi - qx[j]; ry = yi - qy[j];
            if (rx * rx + ry * ry < h2) {
              if (ci < MAXN) nbr[bi + ci++] = j;
              cj = ncount[j];
              if (cj < MAXN) { nbr[j * MAXN + cj] = i; ncount[j] = cj + 1; }
            }
          }
          ncount[i] = ci;
        }
      }
    }
  };

  /*
   * Поиск соседей по диапазону частиц — для многопоточного режима.
   * Окрестность обходится целиком (9 ячеек), а не наполовину: каждая частица
   * пишет только в свой список, поэтому потоки не мешают друг другу. Работы
   * вдвое больше, чем у симметричного варианта, но она делится между ядрами.
   */
  Fluid.prototype.findNeighborsRange = function (i0, i1) {
    var gnx = this.gnx, gny = this.gny, inv = 1 / this.cell;
    var gs = this.gstart, qx = this.qx, qy = this.qy, h2 = this.h * this.h;
    var nbr = this.nbr, ncount = this.ncount;
    for (var i = i0; i < i1; i++) {
      var xi = qx[i], yi = qy[i];
      var cx = (xi * inv + 1) | 0, cy = (yi * inv + 2) | 0;
      if (cx < 0) cx = 0; else if (cx >= gnx) cx = gnx - 1;
      if (cy < 0) cy = 0; else if (cy >= gny) cy = gny - 1;
      var cnt = 0, base = i * MAXN;
      var x0 = cx > 0 ? cx - 1 : 0, x1 = cx < gnx - 1 ? cx + 1 : gnx - 1;
      var y0 = cy > 0 ? cy - 1 : 0, y1 = cy < gny - 1 ? cy + 1 : gny - 1;
      for (var gy = y0; gy <= y1; gy++) {
        var rb = gy * gnx;
        var s = gs[rb + x0], e = gs[rb + x1 + 1];
        for (var j = s; j < e; j++) {
          if (j === i) continue;
          var rx = xi - qx[j], ry = yi - qy[j];
          if (rx * rx + ry * ry < h2) {
            nbr[base + cnt++] = j;
            if (cnt === MAXN) { gy = y1; break; }
          }
        }
      }
      ncount[i] = cnt;
    }
  };

  /*
   * Граничные величины: расстояние до стенки, нормаль и «недостающая»
   * плотность. Полный проход делается раз в подшаг; внутри итераций позиции
   * меняются, поэтому расстояние пересчитывается дешёвым проходом ниже.
   */
  Fluid.prototype.phaseBoundaryFull = function (i0, i1, slot) {
    var solid = this.solid, p = this._probe;
    var h = this.h, rho0 = this.rho0;
    var qx = this.qx, qy = this.qy;
    var bd = this.bd, bg = this.bg, bnx = this.bnx, bny = this.bny, bdist = this.bdist;
    var eps = h * 0.02, inv2eps = 1 / (2 * eps);
    var near = this.near, i, d;

    if (!solid) {
      this.nearN[slot * SLOT_STRIDE] = 0;
      for (i = i0; i < i1; i++) { bdist[i] = 1e9; bd[i] = 0; bg[i] = 0; }
      return;
    }
    // Полный проход: заодно собираем список тех, кто вообще может достать до
    // стенки за серию итераций. Дальше работаем только с ними — в открытом
    // бассейне это единицы процентов частиц. Свой участок списка каждый
    // поток начинает со своего первого индекса, поэтому не мешает соседям.
    var slack = h + this.dp, cnt = i0;
    for (i = i0; i < i1; i++) {
      d = solid.sample(qx[i], qy[i]);
      bdist[i] = d;
      if (d < slack) near[cnt++] = i;
      if (d < h) {
        solid.probe(qx[i], qy[i], p);
        bnx[i] = p[0]; bny[i] = p[1];
        bd[i] = rho0 * this.boundaryMissing(d);
        bg[i] = rho0 * (this.boundaryMissing(d + eps) - this.boundaryMissing(d - eps)) * inv2eps;
      } else { bd[i] = 0; bg[i] = 0; bnx[i] = 0; bny[i] = 0; }
    }
    this.nearN[slot * SLOT_STRIDE] = cnt - i0;
  };

  /* Быстрый пересчёт: только расстояние и граничная плотность, нормаль
   * переиспользуется — она меняется медленно. */
  Fluid.prototype.phaseBoundaryFast = function (i0, slot) {
    var solid = this.solid;
    if (!solid) return;
    var h = this.h, rho0 = this.rho0, qx = this.qx, qy = this.qy;
    var bd = this.bd, bg = this.bg, bdist = this.bdist, near = this.near;
    var eps = h * 0.02, inv2eps = 1 / (2 * eps);
    var end = i0 + this.nearN[slot * SLOT_STRIDE];
    for (var k = i0; k < end; k++) {
      var i = near[k];
      var d = solid.sample(qx[i], qy[i]);
      bdist[i] = d;
      if (d < h) {
        bd[i] = rho0 * this.boundaryMissing(d);
        bg[i] = rho0 * (this.boundaryMissing(d + eps) - this.boundaryMissing(d - eps)) * inv2eps;
      } else { bd[i] = 0; bg[i] = 0; }
    }
  };

  /* ------------------------------------------------------------------ */
  /* Шаг                                                                  */

  Fluid.prototype.step = function (dt) {
    if (this.n === 0) return;
    var sub = Math.max(1, this.substeps | 0);
    var h = dt / sub;
    this._foamPass = true; this._foamDt = dt;
    this.updateAmbient();
    for (var s = 0; s < sub; s++) this.substep(h);
    // силы второго порядка — раз в кадр, по спискам соседей последнего подшага
    var n = this.n;
    this.phaseForces1(0, n);
    this.phaseForces2(0, n, dt);
    this.phaseForcesApply(0, n, dt);
  };

  /* Однопоточный подшаг: те же фазы, что и в многопоточном, но на всём
   * диапазоне частиц сразу. Поиск соседей здесь симметричный — он вдвое
   * дешевле, но пишет в оба списка пары и потому не делится между потоками. */
  Fluid.prototype.substep = function (dt) {
    var n = this.n;
    this.phasePredict(0, n, dt);
    if (this.solid) this.phaseCCD(0, n);
    this.sortParticles();
    this.findNeighbors();
    this.phaseBoundaryFull(0, n, 0);
    if (this._foamPass) { this.computeFoam(0, n, this._foamDt); this._foamPass = false; }
    for (var iter = 0; iter < this.iterations; iter++) {
      this.phaseDensity(0, n, iter, 0);
      this.phaseDeltaP(0, n);
      this.phaseApply(0, n, 0);
      if (iter < this.iterations - 1) this.phaseBoundaryFast(0, 0);
    }
    this.stats.compression = n ? this.compAcc[0] / n : 0;
    this.phaseVelocity(0, n, dt);
  };

  /* --- фазы: каждая работает на своём диапазоне [i0, i1) и пишет только
   *     в ячейки своих частиц, поэтому потоки не пересекаются --- */

  /*
   * Предсказание положения + вес жидкости.
   *
   * Ограничение плотности держит РАВНОМЕРНЫЙ шаг частиц и про массу ничего
   * не знает: давление, которое оно создаёт, подстраивается под то ускорение,
   * которое к жидкости приложено. Поэтому вес вводится здесь — множителем к
   * тяжести: тяжёлую жидкость тянет вниз сильнее, чем её поддерживает
   * давление окружения, и она тонет; лёгкую — слабее, и она всплывает.
   * Однородной жидкости это ничем не мешает: давление просто установится
   * пропорционально меньшим или большим.
   *
   * Важно, что сила приложена ко ВСЕМУ объёму. Пробовал считать честный
   * локальный Архимед по соседям — он даёт верные числа лишь на границе
   * раздела, а в глубине капли соседи свои и сила обнуляется: капля масла
   * радиусом 28 см получала в среднем 0.07 м/с² вместо 0.9 и не всплывала.
   *
   * Опорой служит СРЕДНЯЯ плотность того, что налито, а не вода. Иначе
   * чистая ртуть плескалась бы как на планете с четырёхкратной тяжестью:
   * ускорение зависело бы от того, какую жидкость выбрали, хотя одна
   * жидкость сама по себе обязана вести себя одинаково. С опорой на среднее
   * однородная жидкость получает ровно g при любой плотности, а в смеси
   * лёгкое всплывает и тяжёлое тонет — как и требуется.
   *
   * Множитель применяется только к погружённой жидкости: свободно летящая
   * капля должна падать с обычным g, а не с четырёхкратным.
   */
  Fluid.prototype.phasePredict = function (i0, i1, dt) {
    var gx = this.gravityX, gy = this.gravityY, vmax = this.maxSpeed;
    var vmax2 = vmax * vmax;
    var px = this.px, py = this.py, qx = this.qx, qy = this.qy;
    var vx = this.vx, vy = this.vy, rho = this.rho, invRho0 = 1 / this.rho0;
    var mat = this.mat, mp = this.matParams, buoy = this.buoyancy;
    var amb = this.ambientG || 1;
    for (var i = i0; i < i1; i++) {
      var o = mat[i] * MAT_STRIDE;
      var damp = Math.exp(-mp[o + M_DRAG] * dt);
      // погружённость: 0 в полёте, 1 в толще жидкости
      var imm = (rho[i] * invRho0 - 0.6) * 2.86;
      if (imm < 0) imm = 0; else if (imm > 1) imm = 1;
      var gd = (mp[o + M_GSCALE] / amb - 1) * buoy;
      if (gd > GSCALE_MAX) gd = GSCALE_MAX;
      else if (gd < GSCALE_MIN) gd = GSCALE_MIN;
      var gs = 1 + gd * imm;
      var nvx = (vx[i] + gx * gs * dt) * damp;
      var nvy = (vy[i] + gy * gs * dt) * damp;
      var sp2 = nvx * nvx + nvy * nvy;
      if (sp2 > vmax2) { var f = vmax / Math.sqrt(sp2); nvx *= f; nvy *= f; }
      vx[i] = nvx; vy[i] = nvy;
      qx[i] = px[i] + nvx * dt;
      qy[i] = py[i] + nvy * dt;
    }
  };

  /* Проход 1: плотность и лямбда; попутно кэшируем всё, что нужно проходу 2 —
   * позиции между двумя проходами одной итерации не меняются. */
  Fluid.prototype.phaseDensity = function (i0, i1, iter, slot) {
    var qx = this.qx, qy = this.qy;
    var nbr = this.nbr, ncount = this.ncount;
    var rho = this.rho, lam = this.lam;
    var bd = this.bd, bg = this.bg, bnx = this.bnx, bny = this.bny;
    var gmC = this.gmC, scC = this.scC;
    var kSpiky = this.kSpiky, k6 = this.k6, hh = this.h, hh2 = hh * hh;
    var selfW = k6 * hh2 * hh2 * hh2;
    var rho0 = this.rho0, invRho0 = 1 / rho0;
    var eps = this.relax * this.gradSumSq0;
    var negLimit = -Math.abs(this.tensionLimit);
    var sc = -this.sCorrK, invWdq = 1 / this.wDq;
    var totalC = 0, i, j, k;

    /*
     * Ограничение чисто геометрическое: оно держит РАВНОМЕРНЫЙ шаг частиц и
     * ничего не знает про массу. Так и надо — за разницу плотностей отвечает
     * отдельная выталкивающая сила (см. phaseForces2), которая считает
     * настоящий закон Архимеда по окружению частицы. Пробовал вместо этого
     * завести обратную массу прямо в лямбду: у ртути работает, а у масла
     * перепад плотностей всего 8%, и его съедает численное перемешивание.
     */
    for (i = i0; i < i1; i++) {
      var cnt = ncount[i], base = i * MAXN;
      var xi = qx[i], yi = qy[i];
      var d = selfW, sgx = 0, sgy = 0, sumSq = 0;
      for (k = 0; k < cnt; k++) {
        j = nbr[base + k];
        var rx = xi - qx[j], ry = yi - qy[j];
        var r2 = rx * rx + ry * ry;
        if (r2 >= hh2 || r2 < 1e-18) { gmC[base + k] = 0; scC[base + k] = 0; continue; }
        var t = hh2 - r2;
        var wp = k6 * t * t * t;
        d += wp;
        var r = Math.sqrt(r2), w = hh - r;
        var gm = kSpiky * w * w / r;
        var gjx = gm * rx, gjy = gm * ry;
        sgx += gjx; sgy += gjy;
        sumSq += gjx * gjx + gjy * gjy;
        gmC[base + k] = gm;
        var ratio = wp * invWdq;
        ratio *= ratio; ratio *= ratio;            // ratio^4
        scC[base + k] = sc * ratio * gm;
      }
      d += bd[i];
      var bgi = bg[i];
      if (bgi !== 0) { sgx += bgi * bnx[i]; sgy += bgi * bny[i]; }
      rho[i] = d;
      sumSq = (sumSq + sgx * sgx + sgy * sgy) * invRho0 * invRho0;
      var C = d * invRho0 - 1;
      if (iter === 0 && C > 0) totalC += C;
      // разрежение тянет жидкость обратно, но не сильнее заданного предела:
      // без ограничения свободная поверхность начинает слипаться сама к себе
      if (C < negLimit) C = negLimit;
      lam[i] = -C / (sumSq + eps);
    }
    if (iter === 0) this.compAcc[slot * SLOT_STRIDE] = totalC;
  };

  /* Проход 2: поправка позиции — корней и ядер здесь уже нет. */
  Fluid.prototype.phaseDeltaP = function (i0, i1) {
    var qx = this.qx, qy = this.qy, lam = this.lam;
    var nbr = this.nbr, ncount = this.ncount;
    var gmC = this.gmC, scC = this.scC;
    var bg = this.bg, bnx = this.bnx, bny = this.bny;
    var dxA = this.dx, dyA = this.dy, invRho0 = 1 / this.rho0;
    for (var i = i0; i < i1; i++) {
      var cnt = ncount[i], base = i * MAXN;
      var xi = qx[i], yi = qy[i], li = lam[i];
      var ax = 0, ay = 0;
      for (var k = 0; k < cnt; k++) {
        var gm = gmC[base + k];
        if (gm === 0) continue;
        var j = nbr[base + k];
        var c = (li + lam[j]) * gm + scC[base + k];
        ax += c * (xi - qx[j]); ay += c * (yi - qy[j]);
      }
      var bg2 = bg[i];
      if (bg2 !== 0) { ax += li * bg2 * bnx[i]; ay += li * bg2 * bny[i]; }
      dxA[i] = ax * invRho0; dyA[i] = ay * invRho0;
    }
  };

  /*
   * Применение поправки + выталкивание из тел + удержание в домене.
   *
   * Сверхрелаксация: Якоби-итерация PBF недорелаксирована, множитель >1
   * заметно ускоряет сходимость давления в глубокой воде. Поправка ограничена
   * сверху: иначе одиночный сильный удар может протолкнуть частицу сквозь
   * тонкую стенку за её середину, и наружу её вытолкнет с другой стороны.
   */
  Fluid.prototype.phaseApply = function (i0, i1, slot) {
    var qx = this.qx, qy = this.qy, dxA = this.dx, dyA = this.dy;
    var sor = this.sor, capd = this.maxCorrection * this.dp, cap2 = capd * capd;
    var i;
    for (i = i0; i < i1; i++) {
      var cxx = dxA[i] * sor, cyy = dyA[i] * sor;
      var m2 = cxx * cxx + cyy * cyy;
      if (m2 > cap2) { var sf = capd / Math.sqrt(m2); cxx *= sf; cyy *= sf; }
      qx[i] += cxx; qy[i] += cyy;
    }
    var solid = this.solid;
    if (solid) {
      var p = this._probe, rp = this.wallOffset;
      var near = this.near, end = i0 + this.nearN[slot * SLOT_STRIDE];
      for (var k = i0; k < end; k++) {
        i = near[k];
        var x = qx[i], y = qy[i];
        if (solid.sample(x, y) < rp) {
          var d = solid.probe(x, y, p);
          if (d < rp) { qx[i] = x + p[0] * (rp - d); qy[i] = y + p[1] * (rp - d); }
        }
      }
    }
    var W = this.width, H = this.height;
    for (i = i0; i < i1; i++) {
      if (qx[i] < 0) qx[i] = 0; else if (qx[i] > W) qx[i] = W;
      if (qy[i] > H) qy[i] = H; else if (qy[i] < -H) qy[i] = -H;
    }
  };

  Fluid.prototype.phaseVelocity = function (i0, i1, dt) {
    var px = this.px, py = this.py, qx = this.qx, qy = this.qy;
    var vx = this.vx, vy = this.vy, invDt = 1 / dt;
    for (var i = i0; i < i1; i++) {
      vx[i] = (qx[i] - px[i]) * invDt;
      vy[i] = (qy[i] - py[i]) * invDt;
      px[i] = qx[i]; py[i] = qy[i];
    }
  };

  /* Марш по SDF вдоль отрезка: быстрая частица не проскочит стенку. */
  Fluid.prototype.phaseCCD = function (i0, i1) {
    var solid = this.solid, p = this._probe;
    var px = this.px, py = this.py, qx = this.qx, qy = this.qy;
    var rp = this.wallOffset, cell = solid.cell;
    for (var i = i0; i < i1; i++) {
      var ax = px[i], ay = py[i];
      var sx = qx[i] - ax, sy = qy[i] - ay;
      var len2 = sx * sx + sy * sy;
      if (len2 < cell * cell) continue;      // короткий шаг — хватит проекции
      var steps = Math.ceil(Math.sqrt(len2) / (cell * 0.75));
      if (steps > 24) steps = 24;
      for (var s = 1; s <= steps; s++) {
        var t = s / steps;
        if (solid.sample(ax + sx * t, ay + sy * t) < rp) {
          var tp = (s - 1) / steps;
          var cx = ax + sx * tp, cy = ay + sy * tp;
          var dd = solid.probe(cx, cy, p);
          if (dd < rp) { cx += p[0] * (rp - dd); cy += p[1] * (rp - dd); }
          qx[i] = cx; qy[i] = cy;
          break;
        }
      }
    }
  };

  /*
   * Силы второго порядка: возврат завихрённости (Fedkiw), XSPH-вязкость и
   * поверхностное натяжение по Akinci (когезия + член кривизны).
   *
   * Всё это раньше было четырьмя отдельными обходами списков соседей,
   * которые считали одни и те же расстояния. Здесь их два: первый собирает
   * величины, зависящие от соседей (завихрённость и нормаль поверхности),
   * второй по ним считает силы. Скорости в обоих проходах только читаются,
   * приращение копится отдельно — результат не зависит от порядка частиц.
   */
  /* Проход 1: завихрённость и нормаль свободной поверхности. */
  Fluid.prototype.phaseForces1 = function (i0, i1) {
    var nbr = this.nbr, ncount = this.ncount;
    var px = this.px, py = this.py, vx = this.vx, vy = this.vy;
    var rho = this.rho, rho0 = this.rho0, omg = this.omg;
    var hh = this.h, hh2 = hh * hh, kSpiky = this.kSpiky;
    var nrmX = this.nrmX, nrmY = this.nrmY;
    var i, j, k, rx, ry, r2, r, gm;
    for (i = i0; i < i1; i++) {
      var cnt = ncount[i], base = i * MAXN;
      var xi = px[i], yi = py[i], vxi = vx[i], vyi = vy[i];
      var w = 0, sx = 0, sy = 0;
      for (k = 0; k < cnt; k++) {
        j = nbr[base + k];
        rx = xi - px[j]; ry = yi - py[j];
        r2 = rx * rx + ry * ry;
        if (r2 >= hh2 || r2 < 1e-18) continue;
        r = Math.sqrt(r2);
        var t = hh - r;
        gm = kSpiky * t * t / r / (rho[j] || rho0);
        // z-компонента ротора скорости
        w += (vx[j] - vxi) * (gm * ry) - (vy[j] - vyi) * (gm * rx);
        sx += gm * rx; sy += gm * ry;
      }
      omg[i] = w;
      nrmX[i] = hh * sx; nrmY[i] = hh * sy;
    }
  };

  /* Проход 2: сами силы. Скорости только читаются, приращение копится
   * отдельно — результат не зависит от порядка обхода частиц. */
  Fluid.prototype.phaseForces2 = function (i0, i1, dt) {
    var nbr = this.nbr, ncount = this.ncount;
    var px = this.px, py = this.py, vx = this.vx, vy = this.vy;
    var rho = this.rho, rho0 = this.rho0, omg = this.omg;
    var hh = this.h, hh2 = hh * hh, kSpiky = this.kSpiky, k6 = this.k6;
    var vort = this.vorticity;
    var nrmX = this.nrmX, nrmY = this.nrmY;
    var dvx = this.dx, dvy = this.dy;
    var mat = this.mat, mp = this.matParams;
    var i, j, k, rx, ry, r2, r, gm;
    for (i = i0; i < i1; i++) {
      var cnt2 = ncount[i], base2 = i * MAXN;
      var xi2 = px[i], yi2 = py[i], vxi2 = vx[i], vyi2 = vy[i];
      var rhoi = rho[i] || rho0;
      var nxi = nrmX[i], nyi = nrmY[i];
      var mi = mat[i], oi = mi * MAT_STRIDE;
      var visc = mp[oi + M_VISC], cohI = mp[oi + M_COH], curI = mp[oi + M_CURV];
      var ax = 0, ay = 0, wx = 0, wy = 0, ex = 0, ey = 0;
      for (k = 0; k < cnt2; k++) {
        j = nbr[base2 + k];
        rx = xi2 - px[j]; ry = yi2 - py[j];
        r2 = rx * rx + ry * ry;
        if (r2 >= hh2 || r2 < 1e-18) continue;
        r = Math.sqrt(r2);
        var rhoj = rho[j] || rho0;
        var tt = hh2 - r2;
        var wpoly = k6 * tt * tt * tt;
        var t2 = hh - r;
        gm = kSpiky * t2 * t2 / r;

        // XSPH: сглаживание поля скоростей
        var iw = wpoly / rhoj;
        wx += (vx[j] - vxi2) * iw; wy += (vy[j] - vyi2) * iw;

        // градиент модуля завихрённости — направление N для конфайнмента
        if (vort > 0) {
          var gv = gm * (omg[j] < 0 ? -omg[j] : omg[j]) / rhoj;
          ex += gv * rx; ey += gv * ry;
        }

        /*
         * Натяжение между парой. Своё со своим держится вдвое сильнее, чем
         * с чужим (MIX_COHESION) — это и есть несмешиваемость: масло само
         * собирается в масло, вода в воду, и слои разделяются. Механизм тот
         * же, что в природе: межфазное натяжение ниже собственного.
         */
        var mj = mat[j], oj = mj * MAT_STRIDE;
        var mix = (mj === mi) ? 1 : MIX_COHESION;
        var coh = (cohI + mp[oj + M_COH]) * 0.5 * mix;
        var cur = (curI + mp[oj + M_CURV]) * 0.5 * mix;

        // симметризация по плотности (Akinci): у поверхности сила не падает
        var K = 2 * rho0 / (rhoi + rhoj);
        if (coh > 0) {
          var q = r / hh;
          var spl = 16 * q * q * (1 - q) * (1 - q);   // 0 при r=0 и r=h, max при h/2
          var fmag = -coh * spl * K / r;
          ax += fmag * rx; ay += fmag * ry;
        }
        if (cur > 0) {
          ax -= cur * K * (nxi - nrmX[j]);
          ay -= cur * K * (nyi - nrmY[j]);
        }
      }
      if (vort > 0) {
        var l = Math.sqrt(ex * ex + ey * ey);
        if (l > 1e-8) {
          var o = omg[i] * vort / l;
          ax += ey * o; ay -= ex * o;    // (N x omega), N = (ex,ey)/l
        }
      }

      dvx[i] = visc * wx + ax * dt;
      dvy[i] = visc * wy + ay * dt;
    }
  };

  /* Применение накопленных приращений + трение о стенку и смачивание. */
  Fluid.prototype.phaseForcesApply = function (i0, i1, dt) {
    var vx = this.vx, vy = this.vy, dvx = this.dx, dvy = this.dy;
    var i;
    for (i = i0; i < i1; i++) { vx[i] += dvx[i]; vy[i] += dvy[i]; }
    if (!this.solid) return;
    var hh = this.h;
    var bd = this.bdist, bnx = this.bnx, bny = this.bny;
    var mat = this.mat, mp = this.matParams;
    var rho = this.rho, invRho0 = 1 / this.rho0;
    var gx = this.gravityX, gy = this.gravityY;
    var g = Math.sqrt(gx * gx + gy * gy) || 9.81;
    var climb = this.wetClimb;
    for (i = i0; i < i1; i++) {
      var d = bd[i];
      if (d >= hh) continue;
      var o = mat[i] * MAT_STRIDE;
      var fr = mp[o + M_FRIC], ad = mp[o + M_ADH];
      var nx = bnx[i], ny = bny[i];
      var vn = vx[i] * nx + vy[i] * ny;
      var w = 1 - d / hh; if (w < 0) w = 0;
      var tvx = vx[i] - vn * nx, tvy = vy[i] - vn * ny;
      var f = fr * w * w;
      vx[i] -= tvx * f; vy[i] -= tvy * f;

      if (ad === 0 || d <= 0) continue;

      // прижатие к стенке — оно отвечает за плёнку, но мениск не поднимает
      var a = ad * w * w * g * dt * 0.35;
      vx[i] -= nx * a; vy[i] -= ny * a;

      /*
       * Сила линии контакта — то, из-за чего и получается мениск.
       *
       * Прижатие по нормали поднять воду не может: нормаль перпендикулярна
       * стенке, а ограничение тут же возвращает частицу на равновесный
       * отступ. Смачивание в природе держится на другом — на нескомпенсиро-
       * ванном натяжении там, где свободная поверхность встречает стенку.
       * Эта сила направлена ВДОЛЬ стенки и тем сильнее, чем острее краевой
       * угол. Поэтому прикладываем её по касательной и только у самой линии
       * контакта: частица должна быть и у стенки, и на свободной поверхности.
       *
       * Знак берём у коэффициента: >0 — жидкость смачивает и ползёт вверх
       * (вода, масло), <0 — не смачивает и отступает вниз, давая выпуклый
       * мениск и шарики (ртуть, краевой угол 140°).
       *
       * Вес — КОЛОКОЛ по плотности, и это принципиально. Первая попытка
       * брала «чем меньше соседей, тем сильнее» — то есть чем выше плёнка
       * вскарабкалась, тем крепче её тянуло дальше. Обратная связь
       * положительная: до порога не двигалось ничего, а за порогом вода
       * уползала по стене на всю высоту сосуда. Колокол оставляет силу
       * только там, где ей место — у самой линии контакта, где плотность
       * промежуточная. Поднявшаяся плёнка из него выпадает, и подъём сам
       * останавливается на равновесии.
       */
      var q = rho[i] * invRho0;
      var surf = (q - 0.45) * (0.98 - q) * 14;
      if (surf <= 0) continue;
      if (surf > 1) surf = 1;
      var sx = -ny, sy = nx;                 // касательная к стенке
      if (sx * gx + sy * gy > 0) { sx = -sx; sy = -sy; }   // развернуть против тяжести
      /*
       * Предохранитель: подъёмная сила не может превысить тяжесть. Иначе
       * равновесия нет в принципе — вода уползает по стене на всю высоту
       * сосуда, что и наблюдалось при большом коэффициенте.
       */
      var k = ad * surf * w * climb;
      if (k > 0.92) k = 0.92; else if (k < -0.92) k = -0.92;
      var c = k * g * dt;
      vx[i] += sx * c; vy[i] += sy * c;
    }
  };

  /*
   * Диагностика вспенивания (Ihmsen et al. 2012, упрощённо):
   * захваченный воздух — сумма относительных скоростей сближающихся соседей,
   * умноженная на кинетическую энергию и дефицит плотности у поверхности.
   */
  Fluid.prototype.computeFoam = function (i0, i1, dt) {
    var nbr = this.nbr, ncount = this.ncount;
    var qx = this.qx, qy = this.qy, vx = this.vx, vy = this.vy;
    var hh = this.h, hh2 = hh * hh, foam = this.foam, bdist = this.bdist;
    var mat = this.mat, mp = this.matParams;
    for (var i = i0; i < i1; i++) {
      /* Пена своя у каждой жидкости: пивная стабилизирована белком и живёт
       * секундами, водяная опадает за доли секунды, ртуть не пенится вовсе. */
      var mo = mat[i] * MAT_STRIDE;
      var nrm = mp[mo + M_FOAM];
      var decay = Math.exp(-dt / mp[mo + M_FOAMLIFE]);
      var cnt = ncount[i], base = i * MAXN;
      var xi = qx[i], yi = qy[i], vxi = vx[i], vyi = vy[i];
      var ta = 0, nb = 0;
      for (var k = 0; k < cnt; k++) {
        var j = nbr[base + k];
        var rx = xi - qx[j], ry = yi - qy[j];
        var r2 = rx * rx + ry * ry;
        if (r2 >= hh2 || r2 < 1e-18) continue;
        nb++;
        var r = Math.sqrt(r2);
        var dvx = vxi - vx[j], dvy = vyi - vy[j];
        var dv2 = dvx * dvx + dvy * dvy;
        if (dv2 < 1e-8) continue;
        var dv = Math.sqrt(dv2);
        // (1 - v̂·x̂)/2: единица, когда частицы идут лоб в лоб
        var dot = (dvx * rx + dvy * ry) / (dv * r);
        ta += dv * (1 - dot) * 0.5 * (1 - r / hh);
      }
      var v2 = vxi * vxi + vyi * vyi;
      var ke = 0.5 * v2;
      // Раздробленность: соседей мало — частица на кромке или в брызгах.
      // Одного этого мало: у ровной падающей струи соседей тоже немного,
      // а она остаётся прозрачной. Поэтому член работает только вместе с
      // относительным движением ta — то есть когда струю реально рвёт.
      var frag = 1 - Math.min(1, nb / 8);
      var wall = (bdist[i] < hh * 0.7 && v2 > 6) ? Math.min(1, (v2 - 6) / 26) : 0;
      var gen = Math.min(1, ta / 12) * Math.min(1, ke / 4)
              + Math.min(1, ta / 16) * frag * frag * 0.45
              + wall * 0.5;
      var f = foam[i] * decay + gen * dt * nrm;
      foam[i] = f > 1.5 ? 1.5 : f;
    }
  };

  Fluid.prototype.maxVelocity = function () {
    var m = 0, n = this.n;
    for (var i = 0; i < n; i++) {
      var s = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
      if (s > m) m = s;
    }
    return Math.sqrt(m);
  };

  Fluid.prototype.hasNaN = function () {
    for (var i = 0; i < this.n; i++) {
      if (!isFinite(this.px[i]) || !isFinite(this.py[i]) ||
          !isFinite(this.vx[i]) || !isFinite(this.vy[i])) return true;
    }
    return false;
  };

  Fluid.prototype.meanCompression = function () {
    var s = 0, n = this.n;
    if (!n) return 0;
    for (var i = 0; i < n; i++) {
      var c = this.rho[i] / this.rho0 - 1;
      if (c > 0) s += c;
    }
    return s / n;
  };

  /* Есть ли частица ближе r к точке? По той же сетке соседей.
   * После шага px == qx, поэтому сетка актуальна и для текущих позиций. */
  Fluid.prototype.hasParticleNear = function (x, y, r) {
    var inv = 1 / this.cell, gnx = this.gnx, gny = this.gny, gs = this.gstart;
    var px = this.px, py = this.py, r2 = r * r;
    var cx = (x * inv + 1) | 0, cy = (y * inv + 2) | 0;
    if (cx < 0) cx = 0; else if (cx >= gnx) cx = gnx - 1;
    if (cy < 0) cy = 0; else if (cy >= gny) cy = gny - 1;
    var x0 = cx > 0 ? cx - 1 : 0, x1 = cx < gnx - 1 ? cx + 1 : gnx - 1;
    var y0 = cy > 0 ? cy - 1 : 0, y1 = cy < gny - 1 ? cy + 1 : gny - 1;
    for (var gy = y0; gy <= y1; gy++) {
      var rb = gy * gnx, s = gs[rb + x0], e = gs[rb + x1 + 1];
      for (var j = s; j < e; j++) {
        var dx = x - px[j], dy = y - py[j];
        if (dx * dx + dy * dy < r2) return true;
      }
    }
    return false;
  };

  /*
   * Убрать частицы, оказавшиеся внутри твёрдого тела. Нужно, когда стенку
   * рисуют прямо по воде: иначе решатель выстреливает запертыми частицами
   * наружу с огромной скоростью. Удаление читается как «стенка вытеснила воду».
   */
  Fluid.prototype.removeInside = function (margin) {
    var solid = this.solid;
    if (!solid) return 0;
    margin = margin === undefined ? this.wallOffset * 0.5 : margin;
    var removed = 0;
    for (var i = this.n - 1; i >= 0; i--) {
      if (solid.sample(this.px[i], this.py[i]) < margin) { this.remove(i); removed++; }
    }
    return removed;
  };

  /*
   * «Рука» в воде: тащим жидкость за курсором.
   *
   * Раньше здесь прикладывалось небольшое ускорение — и толку не было:
   * курсор проходит мимо частицы за пару кадров и успевает добавить ей
   * считанные сантиметры в секунду. Правильная модель — прилипание к
   * движущемуся телу: вода рядом с ним движется вместе с ним. Поэтому
   * скорость подтягивается к скорости курсора с весом, спадающим от центра.
   *
   * Отсюда же следует, что неподвижный курсор гасит течение — ровно как
   * настоящее препятствие, опущенное в поток.
   */
  Fluid.prototype.applyStir = function (cx, cy, radius, tvx, tvy, blend) {
    var n = this.n, px = this.px, py = this.py, vx = this.vx, vy = this.vy;
    var r2 = radius * radius;
    for (var i = 0; i < n; i++) {
      var dx = px[i] - cx, dy = py[i] - cy;
      var d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      var w = 1 - Math.sqrt(d2) / radius;
      var k = blend * w * w;
      if (k > 0.9) k = 0.9;
      vx[i] += (tvx - vx[i]) * k;
      vy[i] += (tvy - vy[i]) * k;
    }
  };

  /* ------------------------------------------------------------------ */
  /*
   * Emitter — кран. Струя выпускается не «сколько-то частиц в кадр», а
   * рядами с равновесным шагом dp: точка выпуска едет вместе со струёй, и
   * новый ряд рождается ровно тогда, когда предыдущий отошёл на расстояние
   * между слоями. Иначе частицы сыплются друг в друга, плотность в месте
   * рождения скачет в разы, и решатель разбрасывает их взрывом.
   */
  function Emitter(fluid, cfg) {
    this.f = fluid;
    this.x = cfg.x; this.y = cfg.y;
    this.dirX = cfg.dirX !== undefined ? cfg.dirX : 0;
    this.dirY = cfg.dirY !== undefined ? cfg.dirY : 1;
    this.speed = cfg.speed !== undefined ? cfg.speed : 2.2;
    this.width = cfg.width !== undefined ? cfg.width : fluid.dp * 5;
    this.on = cfg.on !== undefined ? cfg.on : true;
    this.mat = cfg.mat || 0;                     // что льём
    this.acc = 0;
    this.row = 0;
  }

  Emitter.prototype.step = function (dt) {
    if (!this.on) return 0;
    var f = this.f;
    if (f.n >= f.max) return 0;
    var dp = f.dp, rowGap = dp * SQRT3_2;
    var dl = Math.sqrt(this.dirX * this.dirX + this.dirY * this.dirY) || 1;
    var dx = this.dirX / dl, dy = this.dirY / dl;
    var tx = -dy, ty = dx;                       // поперёк струи
    this.acc += this.speed * dt;
    var made = 0;
    var guard = 0;
    while (this.acc >= rowGap && f.n < f.max && guard++ < 8) {
      this.acc -= rowGap;
      this.row++;
      // ряд отодвигаем назад на пройденное с момента рождения расстояние,
      // чтобы струя была сплошной, а не пульсировала пачками
      var back = this.acc;
      var cols = Math.max(1, Math.floor(this.width / dp));
      var off = (this.row % 2) ? 0.5 : 0;
      var half = (cols - 1) * 0.5;
      for (var c = 0; c < cols; c++) {
        var s = (c - half + off) * dp;
        var x = this.x + tx * s + dx * back;
        var y = this.y + ty * s + dy * back;
        if (f.solid && f.solid.sample(x, y) < f.wallOffset) continue;
        if (f.hasParticleNear(x, y, dp * 0.8)) continue;
        if (f.add(x, y, dx * this.speed, dy * this.speed, this.mat) < 0) break;
        made++;
      }
    }
    if (this.acc > rowGap * 8) this.acc = 0;     // страховка от накопления
    return made;
  };

  /* ------------------------------------------------------------------ */
  /*
   * Diffuse — брызги, пена и пузырьки (Ihmsen et al. 2012).
   * Тип частицы определяется локальной плотностью воды вокруг неё:
   *   spray  — почти нет воды: свободный полёт, гравитация и трение о воздух
   *   foam   — на поверхности: плывёт с водой, быстро тает
   *   bubble — внутри воды: всплывает (Архимед) с сопротивлением
   */
  function Diffuse(fluid, maxCount) {
    this.f = fluid;
    this.max = maxCount || 14000;
    var m = this.max;
    this.n = 0;
    this.px = new Float32Array(m); this.py = new Float32Array(m);
    this.vx = new Float32Array(m); this.vy = new Float32Array(m);
    this.life = new Float32Array(m);
    this.life0 = new Float32Array(m);
    this.type = new Uint8Array(m);
    this.size = new Float32Array(m);
    this.mat = new Uint8Array(m);     // из какой жидкости брызга — для цвета
    this.rate = 1.0;
    this.buoyancy = 5.5;
    this.dragCoef = 4.0;      // связь пузырька с течением воды
    /*
     * Сопротивление воздуха для брызг — квадратичное по скорости и обратно
     * пропорциональное размеру капли, как у настоящего шарика:
     *   a = (3 rho_воздух C_d) / (4 rho_вода d) * v^2
     * Отсюда мелкие капли гаснут за доли секунды и оседают рядом со
     * всплеском, а крупные летят далеко. С линейным трением, которое было
     * раньше, все брызги одинаково простреливали пол-экрана.
     */
    this.airDrag = 0.32;
    this._probe = [0, 0];
  }

  Diffuse.prototype.spawn = function (x, y, vx, vy, life, size, mat) {
    if (this.n >= this.max) return;
    var i = this.n++;
    this.px[i] = x; this.py[i] = y;
    this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.life0[i] = life;
    this.size[i] = size; this.type[i] = 0;
    this.mat[i] = mat || 0;
  };

  Diffuse.prototype.kill = function (i) {
    var last = --this.n;
    if (i !== last) {
      this.px[i] = this.px[last]; this.py[i] = this.py[last];
      this.vx[i] = this.vx[last]; this.vy[i] = this.vy[last];
      this.life[i] = this.life[last]; this.life0[i] = this.life0[last];
      this.type[i] = this.type[last]; this.size[i] = this.size[last];
      this.mat[i] = this.mat[last];
    }
  };

  Diffuse.prototype.clear = function () { this.n = 0; };

  Diffuse.prototype.emit = function (dt) {
    var f = this.f, n = f.n, foam = f.foam, dp = f.dp;
    var budget = Math.min(900, this.max - this.n);
    if (budget <= 0 || this.rate <= 0) return;
    for (var i = 0; i < n; i++) {
      var g = foam[i];
      if (g < 0.3) continue;
      var k = (g - 0.3) * this.rate * 0.9 * dt * 60;
      var cnt = k | 0;
      if (Math.random() < k - cnt) cnt++;
      if (cnt > 2) cnt = 2;
      for (var c = 0; c < cnt && budget > 0; c++, budget--) {
        var a = Math.random() * Math.PI * 2;
        var r = Math.sqrt(Math.random()) * dp * 1.1;
        var sp = 0.2 + Math.random() * 0.7;
        // размер по квадрату случайной величины: мелких капель много,
        // крупных единицы — как в настоящем распаде струи
        var u = Math.random();
        this.spawn(f.px[i] + Math.cos(a) * r, f.py[i] + Math.sin(a) * r,
                   f.vx[i] * 0.85 + Math.cos(a) * sp, f.vy[i] * 0.85 + Math.sin(a) * sp,
                   0.45 + Math.random() * 1.3, 0.25 + u * u * 1.25, f.mat[i]);
      }
      if (budget <= 0) break;
    }
  };

  Diffuse.prototype.step = function (dt) {
    this.emit(dt);
    var f = this.f, solid = f.solid;
    var hh = f.h, h2 = hh * hh, rho0 = f.rho0, k6 = f.k6;
    var gx = f.gravityX, gy = f.gravityY;
    var probe = this._probe;
    var inv = 1 / f.cell, gnx = f.gnx, gny = f.gny;
    var gs = f.gstart, fx = f.px, fy = f.py, fvx = f.vx, fvy = f.vy;

    for (var i = this.n - 1; i >= 0; i--) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; }
      var x = this.px[i], y = this.py[i];

      var cx = (x * inv + 1) | 0, cy = (y * inv + 2) | 0;
      var dens = 0, avx = 0, avy = 0, wsum = 0;
      if (cx >= 0 && cx < gnx && cy >= 0 && cy < gny) {
        var x0 = cx > 0 ? cx - 1 : 0, x1 = cx < gnx - 1 ? cx + 1 : gnx - 1;
        var y0 = cy > 0 ? cy - 1 : 0, y1 = cy < gny - 1 ? cy + 1 : gny - 1;
        for (var gyy = y0; gyy <= y1; gyy++) {
          var rb = gyy * gnx;
          var s = gs[rb + x0], e = gs[rb + x1 + 1];
          for (var j = s; j < e; j++) {
            var rx = x - fx[j], ry = y - fy[j];
            var r2 = rx * rx + ry * ry;
            if (r2 >= h2) continue;
            var t = h2 - r2, w = k6 * t * t * t;
            dens += w; avx += fvx[j] * w; avy += fvy[j] * w; wsum += w;
          }
        }
      }
      if (wsum > 0) { avx /= wsum; avy /= wsum; }
      var ratio = dens / rho0;

      var vxi = this.vx[i], vyi = this.vy[i];
      if (ratio < 0.3) {                       // БРЫЗГИ
        this.type[i] = 0;
        vxi += gx * dt; vyi += gy * dt;
        var sp2 = vxi * vxi + vyi * vyi;
        if (sp2 > 1e-6) {
          var dec = this.airDrag / Math.max(this.size[i], 0.25) * Math.sqrt(sp2) * dt;
          if (dec > 0.85) dec = 0.85;
          vxi -= vxi * dec; vyi -= vyi * dec;
        }
      } else if (ratio < 0.85) {               // ПЕНА
        this.type[i] = 1;
        vxi = avx; vyi = avy;
        this.life[i] -= dt * 0.5;
      } else {                                 // ПУЗЫРЬКИ
        this.type[i] = 2;
        vxi += ((avx - vxi) * this.dragCoef - gx * this.buoyancy) * dt;
        vyi += ((avy - vyi) * this.dragCoef - gy * this.buoyancy) * dt;
      }
      this.vx[i] = vxi; this.vy[i] = vyi;

      var nx2 = x + vxi * dt, ny2 = y + vyi * dt;
      if (solid) {
        var d = solid.sample(nx2, ny2);
        if (d < 0.004) {
          d = solid.probe(nx2, ny2, probe);
          nx2 += probe[0] * (0.004 - d); ny2 += probe[1] * (0.004 - d);
          var vn = this.vx[i] * probe[0] + this.vy[i] * probe[1];
          if (vn < 0) {
            this.vx[i] = (this.vx[i] - vn * probe[0]) * 0.55;
            this.vy[i] = (this.vy[i] - vn * probe[1]) * 0.55;
          }
          if (this.type[i] === 0) this.life[i] -= dt * 2.5;
        }
      }
      this.px[i] = nx2; this.py[i] = ny2;
      if (ny2 > f.height + 0.5 || nx2 < -0.5 || nx2 > f.width + 0.5) this.kill(i);
    }
  };

  return { Fluid: Fluid, Diffuse: Diffuse, Emitter: Emitter,
           MAXN: MAXN, buildBoundaryTable: buildBoundaryTable,
           MATERIALS: MATERIALS, MIX_COHESION: MIX_COHESION,
           REF_DENSITY: REF_DENSITY, BUOY_GAIN: BUOY_GAIN };
}));
