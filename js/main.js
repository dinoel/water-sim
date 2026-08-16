/*
 * main.js — сцена, ввод и цикл.
 *
 * Мир 8 x 4.5 м, холст 1280 x 720 (160 пикселей на метр), гравитация 9.81.
 * Масштаб выбран так, чтобы вода на экране падала с узнаваемой скоростью и
 * при этом шаг по времени 1/60 оставался в пределах CFL для ядра.
 */
(function () {
  'use strict';

  var APP_VERSION = '8';        // сбивает кэш воркеров при правках
  var CW = 1280, CH = 720;
  var WORLD_W = 8.0, WORLD_H = 4.5;
  var PX_PER_M = CW / WORLD_W;
  var CELL_PX = 4;

  // Потолки взяты по измеренному бюджету (~2.5-4 мкс на частицу за кадр):
  // это верхняя граница, ниже которой регулятор всё равно подстроится сам.
  var QUALITY = {
    low:    { dpPx: 9.5, cap: 5000 },
    medium: { dpPx: 7.5, cap: 5000 },
    high:   { dpPx: 6.0, cap: 6000 }
  };

  var canvas = document.getElementById('c');
  canvas.width = CW; canvas.height = CH;

  var app = {
    quality: 'medium',
    graphics: 'simple',
    paused: false,
    tool: 'wall',
    material: 0,        // чем льём: 0 вода, 1 масло, 2 пиво, 3 ртуть
    speed: 1.0,         // скорость симуляции: 1 = реальное время
    brush: 26,          // пиксели
    stirStrength: 0.5,  // насколько сильно вода липнет к курсору
    solid: null, fluid: null, diffuse: null, emitter: null, renderer: null,
    fallback: null,
    time: 0,
    maxLive: 26000, throttled: false,
    pool: null, threads: 1, parReason: null, snap: null, view: null,
    pendingPrime: null,
    physMs: 8, renderMs: 4, fps: 60, steps: 1,
    render: {
      tankDepth: 2.4, absorb: 1.0, scatter: 1.0, refract: 22, height: 1.6,
      foam: 1.0, specular: 0.55, smooth: 1, stretch: 0.22, blur: 14,
      // порог ореола замерен: при 1.0 ярче него в кадре не оказывалось
      // ничего, и свечение просто не включалось
      ripple: 0.30, exposure: 1.25, bloom: 1.1, bloomThresh: 0.28, vignette: 0.70,
      // яркость панели подобрана замером: при 0.95 она садится на экране
      // около 0.8 — светло, но с запасом до белого, чтобы воде осталось
      // место показать свой цвет на просвет
      foamLight: 0.42, backLight: 0.95, fill: 3.2,
      diffuseScale: 2.8, time: 0
    }
  };

  /* ------------------------------------------------------------------ */
  /* Построение мира                                                     */

  function build(keepWalls) {
    var q = QUALITY[app.quality];
    var dp = q.dpPx / PX_PER_M;
    var nx = Math.ceil(CW / CELL_PX), ny = Math.ceil(CH / CELL_PX);
    var MAXP = 22000;

    if (app.pool) { app.pool.dispose(); app.pool = null; }

    // В многопоточном режиме и поле стен, и все массивы решателя должны
    // лежать в общей памяти — иначе рабочие потоки их не увидят.
    var par = Parallel.available();
    var oldMask = keepWalls && app.solid ? app.solid.mask.slice() : null;
    var distBuf = par ? new SharedArrayBuffer(nx * ny * 4) : null;
    var solid = new SDF.Solid(nx, ny, CELL_PX / PX_PER_M, distBuf);
    if (oldMask && oldMask.length === solid.mask.length) solid.mask.set(oldMask);
    else solid.addBorder(3);
    solid.rebuild();

    var probe = new WaterSolver.Fluid({ width: WORLD_W, height: WORLD_H, spacing: dp,
                                        maxParticles: 8 });
    var cells = probe.gnx * probe.gny + 1;
    var arena = par ? makeArena(new SharedArrayBuffer(
                        WaterSolver.Fluid.arenaBytes(MAXP, cells))) : null;

    var fluid = new WaterSolver.Fluid({
      width: WORLD_W, height: WORLD_H, spacing: dp,
      maxParticles: MAXP, solid: solid, arena: arena
    });
    var diffuse = new WaterSolver.Diffuse(fluid, 14000);
    var emitter = new WaterSolver.Emitter(fluid, {
      x: WORLD_W * 0.5, y: 0.16, dirX: 0, dirY: 1,
      speed: 2.4, width: dp * 6, on: true
    });

    app.solid = solid; app.fluid = fluid; app.diffuse = diffuse; app.emitter = emitter;
    app.maxLive = q.cap;
    app.snap = { px: new Float32Array(MAXP), py: new Float32Array(MAXP),
                 vx: new Float32Array(MAXP), vy: new Float32Array(MAXP),
                 foam: new Float32Array(MAXP), mat: new Int32Array(MAXP), n: 0 };
    startPool(fluid, solid);

    if (!app.renderer) {
      app.renderer = new WaterRender.Renderer(canvas, {
        pxPerM: PX_PER_M, maxParticles: 22000, maxDiffuse: 14000
      });
      if (!app.renderer.ok) {
        app.fallback = makeFallback();
        note('Красивый рендер недоступен: ' + app.renderer.reason + ' — простой режим');
      }
    }
    if (app.renderer.ok) {
      app.renderer.calibrate(q.dpPx, fluid.h * PX_PER_M * 1.6);
      app.renderer.setMaterials(WaterSolver.MATERIALS);
      app.renderer.uploadSdf(solid);
    }
    emitter.mat = app.material;
    syncUI();
  }

  function makeArena(buf) {
    var off = 0;
    return {
      buf: buf,
      f32: function (n) { var a = new Float32Array(buf, off, n); off += n * 4; return a; },
      i32: function (n) { var a = new Int32Array(buf, off, n); off += n * 4; return a; }
    };
  }

  /* Поднять пул рабочих потоков. Если общей памяти нет — работаем в один. */
  function startPool(fluid, solid) {
    app.threads = 1;
    var why = Parallel.reason();
    if (why) { app.parReason = why; return; }
    /*
     * Три потока — не «сколько ядер», а измеренный оптимум. Дальше упирается
     * не в вычисления (их потоки делят почти идеально), а в барьеры: их за
     * кадр несколько десятков, и на каждом кто-то кого-то ждёт. Чем больше
     * потоков, тем чаще кто-то опаздывает. Значение вынесено в интерфейс —
     * на другой машине оптимум может быть иным.
     */
    var want = app.threadsWanted || 3;
    try {
      app.pool = new Parallel.Pool({
        fluid: fluid, solid: solid, threads: want, version: APP_VERSION,
        onReady: function () { app.threads = want; app.parReason = null; syncUI(); },
        onError: function (m) { app.parReason = m; app.pool = null; app.threads = 1; }
      });
      app.pool.onStepDone = onPhysicsDone;
    } catch (e) {
      app.parReason = e.message; app.pool = null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* Сцены                                                               */

  var scenes = {
    empty: function () {},

    // Чаша: нижняя половина эллипса. y растёт вниз, поэтому дно —
    // в середине пролёта, а края поднимаются вверх.
    bowl: function (s) {
      var cx = WORLD_W * 0.5, top = 2.05, rx = 2.5, ry = 1.85;
      for (var t = -1; t <= 1; t += 0.003)
        s.paintCircle(cx + t * rx, top + Math.sqrt(Math.max(0, 1 - t * t)) * ry, 0.1, 1);
    },

    // Каскад: два уступа со стенкой-бортиком, вода переливается вниз
    waterfall: function (s) {
      s.paintRect(0.0, 1.70, 3.30, 1.86, 1);
      s.paintRect(3.14, 1.70, 3.30, 2.30, 1);
      s.paintRect(4.30, 2.80, 8.00, 2.96, 1);
      s.paintRect(4.30, 2.80, 4.46, 3.42, 1);
      s.paintRect(0.0, 3.90, 8.00, 4.06, 1);
    },

    // Воронка: сходящиеся стенки с узким горлом и приёмным поддоном
    funnel: function (s) {
      var cx = WORLD_W * 0.5;
      for (var t = 0; t <= 1; t += 0.003) {
        var y = 1.35 + t * 1.55;
        var w = 2.6 * (1 - t) + 0.13;
        s.paintCircle(cx - w, y, 0.09, 1);
        s.paintCircle(cx + w, y, 0.09, 1);
      }
      s.paintRect(0, 4.00, 8.00, 4.14, 1);
    },

    // Ступени: вода стекает зигзагом
    steps: function (s) {
      for (var i = 0; i < 5; i++) {
        var y = 1.15 + i * 0.60;
        var x0 = (i % 2) ? 0.0 : WORLD_W - 5.4;
        s.paintRect(x0, y, x0 + 5.4, y + 0.13, 1);
        if (i % 2) s.paintRect(x0 + 5.4 - 0.13, y, x0 + 5.4, y + 0.34, 1);
        else s.paintRect(x0, y, x0 + 0.13, y + 0.34, 1);
      }
    },

    // Плотина: перегородка, слева налита вода
    dam: function (s) {
      s.paintRect(3.05, 0.9, 3.25, 4.2, 1);
    }
  };

  function loadScene(name, withWater) {
    app.solid.clear(true, 3);
    scenes[name](app.solid);
    app.solid.rebuild();
    app.fluid.clear(); app.diffuse.clear();
    if (app.renderer.ok) app.renderer.uploadSdf(app.solid);
    if (withWater) {
      if (name === 'dam') app.fluid.fillRect(0.2, 1.35, 2.95, 4.4, 0.02);
      else app.fluid.fillRect(0.3, 3.3, WORLD_W - 0.3, 4.4, 0.02);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Ввод                                                                */

  var mouse = { x: 0, y: 0, px: 0, py: 0, down: false, button: 0, inside: false, moved: false };

  function toWorld(ev) {
    var r = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left) / r.width * WORLD_W,
      y: (ev.clientY - r.top) / r.height * WORLD_H
    };
  }

  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  canvas.addEventListener('pointerdown', function (e) {
    canvas.setPointerCapture(e.pointerId);
    var w = toWorld(e);
    mouse.x = mouse.px = w.x; mouse.y = mouse.py = w.y;
    mouse.down = true; mouse.button = e.button; mouse.moved = true;
    if (app.tool === 'tap') { app.emitter.x = w.x; app.emitter.y = w.y; }
    else if (app.tool === 'prime' && e.button === 0) app.pendingPrime = { x: w.x, y: w.y };
    e.preventDefault();
  });

  canvas.addEventListener('pointermove', function (e) {
    var w = toWorld(e);
    mouse.x = w.x; mouse.y = w.y; mouse.inside = true; mouse.moved = true;
    if (mouse.down && app.tool === 'tap') { app.emitter.x = w.x; app.emitter.y = w.y; }
  });

  window.addEventListener('pointerup', function () { mouse.down = false; });
  canvas.addEventListener('pointerleave', function () { mouse.inside = false; });

  window.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    var k = e.key.toLowerCase();
    if (k === '1') setTool('wall');
    else if (k === '2') setTool('erase');
    else if (k === '3') setTool('water');
    else if (k === '4') setTool('tap');
    else if (k === '5') setTool('push');
    else if (k === '6') setTool('prime');
    else if (k === ' ') { app.paused = !app.paused; syncUI(); e.preventDefault(); }
    else if (k === 'c') { app.fluid.clear(); app.diffuse.clear(); }
    else if (k === 'x') { loadScene('empty', false); }
    else if (k === 'h') document.body.classList.toggle('hide-ui');
    else if (k === 'f') { app.emitter.on = !app.emitter.on; syncUI(); }
    else if (k === '[') { app.brush = Math.max(6, app.brush - 4); syncUI(); }
    else if (k === ']') { app.brush = Math.min(90, app.brush + 4); syncUI(); }
  });

  var wallDirty = false;

  function applyTool(dt) {
    if (!mouse.down) return;
    var f = app.fluid, s = app.solid;
    var br = app.brush / PX_PER_M;
    var tool = app.tool;
    if (mouse.button === 2 && (tool === 'wall' || tool === 'water')) tool = 'erase';

    if (tool === 'wall' || tool === 'erase') {
      var v = tool === 'wall' ? 1 : 0;
      if (s.paintSegment(mouse.px, mouse.py, mouse.x, mouse.y, br, v)) wallDirty = true;
    } else if (tool === 'water') {
      pourWater(mouse.x, mouse.y, br);
    } else if (tool === 'push') {
      // скорость курсора в м/с — её и «прилипает» вода вокруг
      var cvx = (mouse.x - mouse.px) / dt, cvy = (mouse.y - mouse.py) / dt;
      var sp = Math.sqrt(cvx * cvx + cvy * cvy);
      var lim = f.maxSpeed * 0.8;
      if (sp > lim) { cvx *= lim / sp; cvy *= lim / sp; }
      f.applyStir(mouse.x, mouse.y, br * 1.6, cvx, cvy, app.stirStrength);
    }
    mouse.px = mouse.x; mouse.py = mouse.y;
  }

  /* Наливаем воду кистью: гексагональная упаковка + проверка на занятость,
   * чтобы новые частицы не рождались внутри существующих. */
  function pourWater(cx, cy, r) {
    var f = app.fluid, dp = f.dp, dy = dp * Math.sqrt(3) / 2;
    var rows = Math.ceil(r / dy);
    for (var j = -rows; j <= rows; j++) {
      var y = cy + j * dy;
      var half = Math.sqrt(Math.max(0, r * r - (j * dy) * (j * dy)));
      var off = (Math.abs(j) % 2) ? dp * 0.5 : 0;
      for (var x = cx - half + off; x <= cx + half; x += dp) {
        if (f.n >= app.maxLive) return;
        if (f.solid.sample(x, y) < f.wallOffset) continue;
        if (f.hasParticleNear(x, y, dp * 0.85)) continue;
        f.add(x, y, 0, 0.3, app.material);
      }
    }
  }

  /*
   * Затравка сифона. По гексагональной решётке обходим связную часть узкого
   * канала, в которой точка действительно находится между двумя стенками,
   * и заполняем её выбранной жидкостью. Широкие открытые баки в обход не
   * попадают, поэтому один клик не заливает всю сцену.
   */
  function primeSiphon(cx, cy) {
    var f = app.fluid, s = app.solid, dp = f.dp;
    var dy = dp * Math.sqrt(3) / 2;
    var nx = Math.ceil(WORLD_W / dp) + 2, ny = Math.ceil(WORLD_H / dy) + 2;
    var total = nx * ny, seen = new Uint8Array(total), queue = new Int32Array(total);
    var probe = [0, 0], maxWidth = f.h * 4.0;

    function point(row, col) {
      return [(col + 0.5 + (row & 1) * 0.5) * dp, (row + 0.5) * dy];
    }
    function narrow(x, y) {
      if (x <= 0 || x >= WORLD_W || y <= 0 || y >= WORLD_H) return false;
      var d = s.sample(x, y);
      if (d < f.wallOffset || d >= maxWidth) return false;
      s.probe(x, y, probe);
      for (var reach = f.h * 0.5; d + reach <= maxWidth; reach += f.h * 0.5)
        if (s.sample(x + probe[0] * reach, y + probe[1] * reach) < f.wallOffset) return true;
      return false;
    }

    // Ближайший узкий узел, но только в пределах небольшого радиуса клика.
    var row0 = Math.round(cy / dy - 0.5), col0 = Math.round(cx / dp - 0.5 - (row0 & 1) * 0.5);
    var start = -1, best = f.h * f.h * 6.25;
    for (var rr = Math.max(0, row0 - 4); rr <= Math.min(ny - 1, row0 + 4); rr++) {
      for (var cc = Math.max(0, col0 - 4); cc <= Math.min(nx - 1, col0 + 4); cc++) {
        var pp = point(rr, cc), ddx = pp[0] - cx, ddy = pp[1] - cy;
        var d2 = ddx * ddx + ddy * ddy;
        if (d2 < best && narrow(pp[0], pp[1])) { best = d2; start = rr * nx + cc; }
      }
    }
    if (start < 0) {
      note('Нажмите внутри узкой трубки сифона');
      return;
    }

    var head = 0, tail = 1; queue[0] = start; seen[start] = 1;
    var dirs = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1],
                [1, -1], [1, 0], [1, 1]];
    while (head < tail) {
      var id = queue[head++], row = Math.floor(id / nx), col = id - row * nx;
      var pa = point(row, col);
      for (var di = 0; di < dirs.length; di++) {
        var nr = row + dirs[di][0], nc = col + dirs[di][1];
        if (nr < 0 || nr >= ny || nc < 0 || nc >= nx) continue;
        var ni = nr * nx + nc;
        if (seen[ni]) continue;
        var pb = point(nr, nc);
        if (!narrow(pb[0], pb[1])) continue;
        if (s.sample((pa[0] + pb[0]) * 0.5, (pa[1] + pb[1]) * 0.5) < f.wallOffset) continue;
        seen[ni] = 1; queue[tail++] = ni;
      }
    }

    var added = 0;
    for (var qi = 0; qi < tail && f.n < app.maxLive; qi++) {
      var qid = queue[qi], qr = Math.floor(qid / nx), qc = qid - qr * nx;
      var q = point(qr, qc);
      if (f.hasParticleNear(q[0], q[1], dp * 0.82)) continue;
      f.add(q[0], q[1], 0, 0, app.material); added++;
    }
    if (added) {
      app.diffuse.clear();
      note('Сифон затравлен: добавлено ' + added + ' частиц');
    } else note('Эта трубка уже заполнена');
  }

  /* ------------------------------------------------------------------ */
  /* Цикл                                                                */

  var DT = 1 / 60;
  var MAX_STEPS = 4;            // потолок шагов физики на кадр
  var acc = 0, last = performance.now();
  var stepsThisFrame = 0;
  var physEma = 8, renderEma = 4, fpsEma = 60, overFrames = 0;

  /*
   * Всё, что трогает массивы решателя, делается только когда физика стоит:
   * в многопоточном режиме рабочие потоки правят те же самые массивы.
   */
  function idleWindow(dt) {
    if (wallDirty) {
      app.solid.rebuild();
      var killed = app.fluid.removeInside();
      if (killed) app.diffuse.clear();
      if (app.renderer.ok) app.renderer.uploadSdf(app.solid);
      wallDirty = false;
    }
    if (app.pendingPrime) {
      primeSiphon(app.pendingPrime.x, app.pendingPrime.y);
      app.pendingPrime = null;
    }
    applyTool(dt);
    if (!app.paused) {
      if (!app.throttled && app.fluid.n < app.maxLive) app.emitter.step(dt);
      app.diffuse.step(dt);
    }
  }

  /* Снимок для отрисовки: пока рисуется кадр, физика уже считает следующий. */
  function snapshot() {
    var f = app.fluid, s = app.snap, n = f.n;
    s.px.set(f.px.subarray(0, n)); s.py.set(f.py.subarray(0, n));
    s.vx.set(f.vx.subarray(0, n)); s.vy.set(f.vy.subarray(0, n));
    s.foam.set(f.foam.subarray(0, n));
    s.mat.set(f.mat.subarray(0, n));
    s.n = n;
    s.dp = f.dp;
  }

  /*
   * Длительность шага берём из замера внутри рабочего потока, а не по
   * времени до сообщения «готово»: сообщение ждёт, пока главный поток
   * освободится от отрисовки, и приписало бы физике чужое время.
   *
   * Здесь же, не дожидаясь следующего кадра, запускаем очередной шаг, если
   * накопленного времени хватает. Без этого ускорение выше единицы в
   * многопоточном режиме не работало бы вовсе: главный поток отдаёт команду
   * раз в кадр, то есть не быстрее 60 шагов в секунду.
   */
  function onPhysicsDone() {
    var real = app.pool ? app.pool.times[2] : 0;
    if (!(real > 0)) real = performance.now() - app.physT0;
    physEma += (real - physEma) * 0.1;
    if (!app.paused && acc >= DT && stepsThisFrame < MAX_STEPS) {
      idleWindow(DT);
      startStep();
    }
  }

  /* Запустить один шаг физики в пуле. Окно простоя вызывает вызывающий. */
  function startStep() {
    var pool = app.pool;
    if (!pool || !pool.ready || pool.busy) return false;
    if (app.paused || acc < DT) return false;
    snapshot();
    app.time += DT;
    acc -= DT;
    stepsThisFrame++;
    app.steps = stepsThisFrame;
    app.physT0 = performance.now();
    pool.step(DT);
    return true;
  }

  function frame(now) {
    requestAnimationFrame(frame);
    var real = Math.min(0.25, (now - last) / 1000);
    last = now;
    fpsEma += (1 / Math.max(real, 1e-4) - fpsEma) * 0.06;

    /*
     * Скорость симуляции масштабирует НЕ шаг по времени, а то, сколько его
     * проживает кадр. Шаг остаётся 1/60: под него выверены подшаги и число
     * итераций, и растягивать его — значит выводить решатель из области
     * устойчивости. Замедление при таком способе точное: те же вычисления,
     * просто реже. Ускорение упирается в потолок шагов на кадр и в саму
     * машину — быстрее, чем она считает, симуляция не пойдёт.
     */
    var simDt = app.paused ? 0 : real * app.speed;
    stepsThisFrame = 0;

    var pool = app.pool;
    if (pool && pool.ready) {
      // --- многопоточно: главный поток только раздаёт работу и рисует ---
      acc += simDt;
      if (acc > DT * MAX_STEPS) acc = DT * MAX_STEPS;   // не копим долг
      if (!pool.busy) { idleWindow(DT); startStep(); }
      app.view = app.snap;
    } else {
      // --- один поток: считаем прямо здесь ---
      var t0 = performance.now();
      idleWindow(DT);
      if (!app.paused) {
        acc += simDt;
        // потолок шагов: иначе после переключения вкладки один длинный кадр
        // вызывает лавину шагов, которая делает следующий кадр ещё длиннее
        while (acc >= DT && stepsThisFrame < MAX_STEPS) {
          if (stepsThisFrame > 0) idleWindow(DT);
          app.fluid.step(DT);
          app.time += DT;
          acc -= DT; stepsThisFrame++;
        }
        if (acc > DT * MAX_STEPS) acc = 0;
        app.steps = Math.max(1, stepsThisFrame);
      }
      /*
       * Делим на число шагов: physEma всюду означает время ОДНОГО шага. Без
       * этого при ускоренной симуляции регулятор видел бы втрое большее
       * число, считал физику перегруженной и закрывал кран — хотя нагрузка
       * на шаг не изменилась.
       */
      physEma += ((performance.now() - t0) / Math.max(1, stepsThisFrame) - physEma) * 0.1;
      app.view = app.fluid;
    }

    // Регулятор нагрузки: он только перекрывает кран и кисть, но НИКОГДА
    // не удаляет уже налитую воду. Раньше он срезал частицы с начала
    // массива — а там после сортировки по ячейкам лежит верхний левый угол,
    // и в бассейне выгрызались полости. Вода, которую налил человек,
    // исчезать сама не должна: для этого есть кнопка слива.
    // Накопитель с гистерезисом: ~20 перегруженных кадров подряд, чтобы
    // перекрыть кран, и столько же спокойных, чтобы открыть обратно.
    // Рост и спад симметричны — иначе кран остаётся закрытым надолго после
    // того, как нагрузка давно упала.
    if (physEma > 13) overFrames = Math.min(80, overFrames + 2);
    else if (physEma < 9.5) overFrames = Math.max(0, overFrames - 2);
    app.throttled = overFrames > 40;

    var t1 = performance.now();
    app.render.time = app.time;
    var view = app.view || app.fluid;
    if (app.renderer.ok) {
      if (app.graphics === 'simple') app.renderer.drawSimple(view);
      else app.renderer.draw(view, app.diffuse, app.render);
    }
    else app.fallback(view, app.diffuse);
    drawCursor();
    renderEma += (performance.now() - t1 - renderEma) * 0.1;

    app.physMs = physEma; app.renderMs = renderEma; app.fps = fpsEma;
    updateStats();
  }

  /* ------------------------------------------------------------------ */
  /* Курсор инструмента поверх холста (отдельный слой, не трогает WebGL)  */

  var cur = document.getElementById('cursor');
  var curCtx = cur.getContext('2d');
  cur.width = CW; cur.height = CH;

  function drawCursor() {
    curCtx.clearRect(0, 0, CW, CH);
    if (!mouse.inside) return;
    var x = mouse.x * PX_PER_M, y = mouse.y * PX_PER_M;
    curCtx.save();
    if (app.tool === 'tap') {
      curCtx.strokeStyle = 'rgba(120,200,255,0.9)';
      curCtx.lineWidth = 2;
      curCtx.beginPath(); curCtx.arc(x, y, 12, 0, 6.284); curCtx.stroke();
      curCtx.beginPath(); curCtx.moveTo(x, y + 12); curCtx.lineTo(x, y + 34); curCtx.stroke();
    } else if (app.tool === 'prime') {
      curCtx.strokeStyle = 'rgba(110,225,255,0.95)';
      curCtx.lineWidth = 2;
      curCtx.beginPath(); curCtx.arc(x, y, 10, 0, 6.284); curCtx.stroke();
      curCtx.beginPath(); curCtx.moveTo(x - 14, y); curCtx.lineTo(x + 14, y);
      curCtx.moveTo(x, y - 14); curCtx.lineTo(x, y + 14); curCtx.stroke();
    } else {
      var r = app.brush * (app.tool === 'push' ? 1.6 : 1);
      curCtx.strokeStyle = app.tool === 'wall' ? 'rgba(255,190,120,0.85)'
        : app.tool === 'erase' ? 'rgba(255,120,120,0.85)'
        : app.tool === 'water' ? 'rgba(120,200,255,0.85)' : 'rgba(200,255,180,0.8)';
      curCtx.lineWidth = 1.5;
      curCtx.setLineDash([5, 4]);
      curCtx.beginPath(); curCtx.arc(x, y, r, 0, 6.284); curCtx.stroke();
    }
    // положение крана всегда видно
    var e = app.emitter;
    if (e.on) {
      curCtx.setLineDash([]);
      curCtx.strokeStyle = 'rgba(140,210,255,0.35)';
      curCtx.lineWidth = 1;
      curCtx.beginPath();
      curCtx.arc(e.x * PX_PER_M, e.y * PX_PER_M, 9, 0, 6.284);
      curCtx.stroke();
    }
    curCtx.restore();
  }

  /* ------------------------------------------------------------------ */
  /* Запасной рендер, если нет WebGL2                                    */

  function makeFallback() {
    // Если холст уже занят gl-контекстом (рендер поднялся, но упал позже),
    // 2D-контекста не будет. Молча ничего не рисуем, а не сыплем ошибками.
    var ctx = canvas.getContext('2d');
    if (!ctx) return function () {};
    return function (f, d) {
      ctx.fillStyle = '#0a0e14';
      ctx.fillRect(0, 0, CW, CH);
      var s = app.solid, cell = CELL_PX;
      ctx.fillStyle = '#2b2e35';
      for (var y = 0; y < s.ny; y++)
        for (var x = 0; x < s.nx; x++)
          if (s.mask[y * s.nx + x]) ctx.fillRect(x * cell, y * cell, cell, cell);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = 'rgba(60,150,220,0.75)';
      var r = (f.dp || app.fluid.dp) * PX_PER_M * 1.5;
      for (var i = 0; i < f.n; i++) {
        ctx.beginPath();
        ctx.arc(f.px[i] * PX_PER_M, f.py[i] * PX_PER_M, r, 0, 6.284);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(230,245,255,0.5)';
      for (i = 0; i < d.n; i++) {
        ctx.beginPath();
        ctx.arc(d.px[i] * PX_PER_M, d.py[i] * PX_PER_M, 2, 0, 6.284);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    };
  }

  /* ------------------------------------------------------------------ */
  /* UI                                                                  */

  function $(id) { return document.getElementById(id); }

  var MAT_DESC = [
    'Прозрачная, красный гаснет в 20 раз быстрее синего — отсюда бирюза.',
    'Легче воды и в 80 раз гуще: всплывает, течёт лениво, почти не брызгает. ' +
    'Жёлто-зелёное, потому что синий гасит нацело.',
    'Почти вода по плотности, поэтому с ней смешивается. Пена держится ' +
    'секундами: её стабилизирует белок.',
    'В 13.6 раза тяжелее воды — проваливается сквозь неё сразу. Натяжение ' +
    'в 6.7 раза выше, стенки не смачивает: собирается в шарики. Не прозрачна ' +
    'вовсе — это зеркало.'
  ];

  function setTool(t) {
    app.tool = t;
    var b = document.querySelectorAll('[data-tool]');
    for (var i = 0; i < b.length; i++)
      b[i].classList.toggle('on', b[i].dataset.tool === t);
  }

  /* Выбор жидкости — общий для крана и кисти «Налить». */
  function setMaterial(m) {
    app.material = m;
    app.emitter.mat = m;
    var b = document.querySelectorAll('[data-mat]');
    for (var i = 0; i < b.length; i++)
      b[i].classList.toggle('on', +b[i].dataset.mat === m);
    syncUI();
  }

  var noteTimer = null;
  function note(msg) {
    var el = $('note');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () { el.classList.remove('show'); }, 4000);
  }

  var sliders = [
    ['sGrav', 'gravityY', 'fluid', 1],
    // 'mat' — свойство выбранной жидкости, а не всей симуляции
    ['sVisc', 'visc', 'mat', 1],
    ['sTens', 'coh', 'mat', 1],
    ['sVort', 'vorticity', 'fluid', 1],
    ['sAdh', 'adh', 'mat', 1],
    ['sBuoy', 'buoyancy', 'fluid', 1],
    ['sFlow', 'speed', 'emitter', 1],
    ['sWide', 'width', 'emitter', 1],
    ['sDepth', 'tankDepth', 'render', 1],
    ['sAbs', 'absorb', 'render', 1],
    ['sScat', 'scatter', 'render', 1],
    ['sRefr', 'refract', 'render', 1],
    ['sHeight', 'height', 'render', 1],
    ['sFoam', 'foam', 'render', 1],
    ['sStretch', 'stretch', 'render', 1],
    ['sBlur', 'blur', 'render', 1],
    ['sStir', 'stirStrength', 'app', 1],
    ['sSpeed', 'speed', 'app', 1],
    ['sAir', 'airDrag', 'diffuse', 1],
    ['sFoamGen', 'foam', 'mat', 1],
    ['sSpray', 'rate', 'diffuse', 1],
    ['sSpec', 'specular', 'render', 1],
    ['sSmooth', 'smooth', 'render', 1],
    ['sRipple', 'ripple', 'render', 1],
    ['sExp', 'exposure', 'render', 1],
    ['sBack', 'backLight', 'render', 1],
    ['sFill', 'fill', 'render', 1],
    ['sBloom', 'bloom', 'render', 1],
    ['sVign', 'vignette', 'render', 1]
  ];

  function bindSliders() {
    sliders.forEach(function (sp) {
      var el = $(sp[0]);
      if (!el) return;
      el.addEventListener('input', function () {
        var v = parseFloat(el.value);
        if (sp[2] === 'fluid') app.fluid[sp[1]] = v;
        else if (sp[2] === 'emitter') app.emitter[sp[1]] = v;
        else if (sp[2] === 'diffuse') app.diffuse[sp[1]] = v;
        else if (sp[2] === 'app') app[sp[1]] = v;
        else if (sp[2] === 'mat') {
          WaterSolver.MATERIALS[app.material][sp[1]] = v;
          app.fluid.setMaterials(WaterSolver.MATERIALS);
        }
        else app.render[sp[1]] = v;
        var out = $(sp[0] + 'v');
        if (out) out.textContent = v.toFixed(2);
      });
    });
    $('sBrush').addEventListener('input', function () {
      app.brush = parseFloat(this.value); $('sBrushv').textContent = app.brush | 0;
    });
  }

  function syncUI() {
    sliders.forEach(function (sp) {
      var el = $(sp[0]);
      if (!el) return;
      var v = sp[2] === 'fluid' ? app.fluid[sp[1]]
            : sp[2] === 'emitter' ? app.emitter[sp[1]]
            : sp[2] === 'diffuse' ? app.diffuse[sp[1]]
            : sp[2] === 'app' ? app[sp[1]]
            : sp[2] === 'mat' ? WaterSolver.MATERIALS[app.material][sp[1]]
            : app.render[sp[1]];
      el.value = v;
      var out = $(sp[0] + 'v');
      if (out) out.textContent = (+v).toFixed(2);
    });
    $('sBrush').value = app.brush;
    $('sBrushv').textContent = app.brush | 0;
    var M = WaterSolver.MATERIALS[app.material];
    $('matNote').textContent = M.density + ' кг/м³';
    $('matDesc').textContent = MAT_DESC[app.material];
    $('btnPause').textContent = app.paused ? '► Пуск' : '❚❚ Пауза';
    $('btnTap').classList.toggle('on', app.emitter.on);
    $('quality').value = app.quality;
    $('graphics').value = app.graphics;
    document.body.classList.toggle('simple-render', app.graphics === 'simple');
    var th = $('threads');
    th.value = String(app.threadsWanted || 3);
    th.disabled = !!app.parReason;
    $('threadsNote').textContent = app.parReason
      ? 'один поток: ' + app.parReason
      : app.threads + ' активно';
  }

  function updateStats() {
    // physMs — это цена ОДНОГО шага в обоих режимах; сколько их было за
    // кадр, показываем отдельно множителем.
    var s = app.fluid.n + ' частиц · ' + app.diffuse.n + ' брызг · ' +
      app.fps.toFixed(0) + ' fps · шаг ' + app.physMs.toFixed(1) + ' мс' +
      (app.steps > 1 ? ' ×' + app.steps : '') +
      ' · рендер ' + app.renderMs.toFixed(1) + ' мс' +
      ' · ' + (app.threads > 1 ? app.threads + ' потока' : '1 поток') +
      (app.graphics === 'simple' ? ' · просто' : ' · красиво');
    if (app.speed !== 1) s += ' · скорость ×' + app.speed.toFixed(2);
    if (app.throttled) s += ' · кран приостановлен (нагрузка)';
    else if (app.fluid.n >= app.maxLive) s += ' · предел ' + app.maxLive;
    $('stats').textContent = s;
  }

  function bindUI() {
    var tb = document.querySelectorAll('[data-tool]');
    for (var i = 0; i < tb.length; i++)
      tb[i].addEventListener('click', function () { setTool(this.dataset.tool); });

    var mb = document.querySelectorAll('[data-mat]');
    for (i = 0; i < mb.length; i++)
      mb[i].addEventListener('click', function () { setMaterial(+this.dataset.mat); });

    var sb = document.querySelectorAll('[data-scene]');
    for (i = 0; i < sb.length; i++)
      sb[i].addEventListener('click', function () {
        loadScene(this.dataset.scene, this.dataset.water === '1');
      });

    $('btnPause').addEventListener('click', function () { app.paused = !app.paused; syncUI(); });
    $('btnClear').addEventListener('click', function () { app.fluid.clear(); app.diffuse.clear(); });
    $('btnTap').addEventListener('click', function () { app.emitter.on = !app.emitter.on; syncUI(); });
    $('btnDrain').addEventListener('click', function () {
      var f = app.fluid, keep = Math.floor(f.n * 0.5);
      // сливаем снизу: убираем самые глубокие
      var idx = [];
      for (var i = 0; i < f.n; i++) idx.push(i);
      idx.sort(function (a, b) { return f.py[b] - f.py[a]; });
      idx.slice(0, f.n - keep).sort(function (a, b) { return b - a; })
         .forEach(function (i) { f.remove(i); });
    });
    $('quality').addEventListener('change', function () {
      app.quality = this.value;
      build(true);
    });
    $('graphics').addEventListener('change', function () {
      app.graphics = this.value;
      syncUI();
    });
    $('threads').addEventListener('change', function () {
      app.threadsWanted = +this.value;
      if (app.pool) { app.pool.dispose(); app.pool = null; app.threads = 1; }
      startPool(app.fluid, app.solid);
    });
    $('btnHelp').addEventListener('click', function () {
      $('help').classList.toggle('show');
    });
    bindSliders();
  }

  /* ------------------------------------------------------------------ */

  build(false);
  bindUI();
  setTool('wall');
  loadScene('bowl', false);
  syncUI();
  requestAnimationFrame(frame);

  window.app = app;   // для отладки из консоли
})();
