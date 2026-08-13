/*
 * render.js — экранный рендер воды на WebGL2.
 *
 * Частицы не рисуются кружочками. Вместо этого:
 *   1) сцена: фон + стены, затенённые прямо из SDF (та же текстура, что
 *      использует физика), с процедурным камнем;
 *   2) splat: каждая частица размазывается гауссианой в float-буфер.
 *      R — плотность, GB — скорость, A — вспененность;
 *   3) раздельное размытие поля: сглаживает дискретность частиц (дрожание
 *      в 20% от dp под ним исчезает);
 *   4) проход «сколько воды выше»: для затемнения глубины по Бугеру–Ламберту;
 *   5) композит: изоуровень даёт покрытие, псевдовысота H = sqrt(D - T)
 *      даёт нормаль (у кромки крутая, в толще смотрит на зрителя), дальше
 *      преломление фона по нормали, поглощение по спектру воды, отражение
 *      неба по Френелю, блик и пена;
 *   6) брызги, пена и пузырьки — спрайтами поверх.
 *
 * Поглощение задано настоящими коэффициентами воды (1/м): красный гаснет
 * в ~20 раз быстрее синего — отсюда бирюза на глубине без всякой раскраски.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WaterRender = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /*
   * Константы сплата. Живут здесь, а не в тексте шейдера, и подставляются
   * в него — чтобы проверка «видна ли струя» в node считала ровно то же,
   * что рисует GPU, и они не разъехались при правках.
   */
  var SPLAT_K = 4.5;                        // крутизна гауссианы
  var SPLAT_EDGE = Math.exp(-SPLAT_K);      // вычитаем, чтобы клякса кончалась на кромке
  var STRETCH_CAP = 3.0;                    // потолок вытягивания по скорости
  var STRETCH_MIN = 1.5;                    // м/с, ниже которых не вытягиваем вовсе
  var ISO_FRAC = 0.5;                       // изоуровень = половина плотности упаковки
  var COVER_LO = 0.65, COVER_HI = 1.15;     // границы перехода покрытия

  /*
   * Во сколько раз клякса вытянута вдоль скорости. Ниже STRETCH_MIN не
   * вытягиваем: спокойная вода дрожит на месте, и вытягивание там только
   * раздувало бы её объём на экране.
   */
  function stretchOf(speed, k) {
    return 1 + Math.min(Math.max(speed - STRETCH_MIN, 0) * k, STRETCH_CAP);
  }

  /*
   * Вес кляксы. dAlong — смещение вдоль скорости, dAcross — поперёк.
   * Амплитуда НЕ гасится при вытягивании: разогнавшаяся струя разносит
   * частицы вдоль потока ровно во столько же раз, во сколько вытянута
   * клякса, так что растущий интеграл именно это и компенсирует. Иначе
   * поле проваливается ниже изоуровня и струя исчезает с экрана.
   */
  function splatWeight(dAlong, dAcross, R, a) {
    var u = dAlong / (R * a), v = dAcross / R;
    var r2 = u * u + v * v;
    if (r2 > 1) return 0;
    return Math.max(0, Math.exp(-SPLAT_K * r2) - SPLAT_EDGE);
  }

  /* ------------------------------------------------------------------ */
  /* Шейдеры                                                             */

  var VS_FULL = `#version 300 es
  void main(){
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  var COMMON = `
  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
               mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
  }
  float fbm(vec2 p){
    float s = 0.0, a = 0.5;
    for(int i = 0; i < 5; i++){ s += a * noise(p); p *= 2.03; a *= 0.5; }
    return s;
  }`;

  /* --- фон и стены -------------------------------------------------- */
  var FS_SCENE = `#version 300 es
  precision highp float;
  uniform sampler2D uSdf;
  uniform vec2 uRes;
  uniform float uPxPerM;
  uniform float uWallTex;
  uniform float uBackLight;   // яркость панели позади аквариума
  uniform float uFill;        // подсветка со стороны камеры
  out vec4 o;
  ` + COMMON + `
  uniform vec2 uSdfTexel;
  float sdfRaw(vec2 uv){ return texture(uSdf, uv).r; }

  /*
   * Кисть растрируется по ячейкам сетки расстояний, и точный EDT честно
   * повторяет эту лесенку — кромка стены выглядит зубчатой. Физике это не
   * мешает (там масштаб частицы крупнее ячейки), а глазу мешает, поэтому
   * для показа усредняем поле по кресту из девяти отсчётов: изолиния
   * выпрямляется, а положение стенки остаётся тем же.
   */
  float sdf(vec2 uv){
    vec2 e = uSdfTexel * 0.8;
    float s = sdfRaw(uv) * 0.28;
    s += (sdfRaw(uv + vec2(e.x, 0)) + sdfRaw(uv - vec2(e.x, 0))
        + sdfRaw(uv + vec2(0, e.y)) + sdfRaw(uv - vec2(0, e.y))) * 0.125;
    s += (sdfRaw(uv + e) + sdfRaw(uv - e)
        + sdfRaw(uv + vec2(e.x, -e.y)) + sdfRaw(uv - vec2(e.x, -e.y))) * 0.055;
    return s;
  }

  void main(){
    vec2 px = gl_FragCoord.xy;
    vec2 uv = vec2(px.x / uRes.x, 1.0 - px.y / uRes.y);
    float d = sdf(uv);                       // метры, >0 вне тела
    float dpx = d * uPxPerM;

    /*
     * Фон — не стена, а СВЕТОВАЯ ПАНЕЛЬ позади аквариума, светящая в камеру.
     *
     * Так снимают жидкости: рассеиватель ставят за объект, и жидкость
     * начинает светиться на просвет. Здесь это ещё и физически выгодно —
     * свет идёт сквозь толщу, и закон Бугера–Ламберта работает в полную
     * силу: цвет воды рождается поглощением по пути к зрителю, а не
     * подкраской.
     *
     * Панель не гладкая: по ней идёт решётка переплётов. Без рисунка не было
     * бы видно преломления — искажать оказалось бы нечего.
     */
    vec2 tile = px / vec2(78.0, 62.0);
    vec2 fr = abs(fract(tile) - 0.5) * 2.0;
    float seam = smoothstep(0.86, 0.995, max(fr.x, fr.y));
    float cellN = hash(floor(tile) + 3.7);

    // мягкий спад к краям: у рассеивателя есть размер, к углам он темнеет
    vec2 pd = (uv - vec2(0.5, 0.44)) * vec2(1.0, 1.2);
    float falloff = 1.0 / (1.0 + 1.6 * dot(pd, pd));
    falloff *= 0.84 + 0.30 * pow(1.0 - uv.y, 1.5);   // свет заведён сверху

    /*
     * Середина теплее краёв. У лампы за рассеивателем так всегда, и это одна
     * из примет настоящего источника: ровный по цвету свет глаз читает как
     * заливку.
     */
    vec3 warm = mix(vec3(0.74, 0.83, 1.00), vec3(1.0, 0.94, 0.82), falloff);
    vec3 bg = warm * uBackLight * falloff;

    // переплёты — это тень, но не провал в чёрный: иначе на них лезет
    // цветная кайма от преломления, а сам кадр становится графичным
    bg *= 1.0 - seam * 0.72;
    bg *= 0.90 + 0.20 * fbm(px / 70.0) + (cellN - 0.5) * 0.05;   // матировка
    bg *= 0.94 + 0.10 * fbm(px / 17.0);
    bg *= 1.0 - smoothstep(0.72, 0.10, uv.y) * fbm(px * vec2(0.02, 0.006)) * 0.16;

    // ---- камень ----
    // Он между панелью и камерой, поэтому в основном силуэт. Фактуру ему
    // даёт слабая заливка со стороны зрителя, а объём — кромка, на которую
    // задний свет заходит вскользь.
    vec2 t = uv * uRes / 26.0;
    float n = fbm(t) * 0.55 + fbm(t * 3.7) * 0.3 + fbm(t * 11.0) * 0.15;
    vec3 stone = mix(vec3(0.19, 0.185, 0.195), vec3(0.52, 0.50, 0.48), n);
    stone *= 0.82 + 0.35 * fbm(t * 0.6);
    stone *= vec3(0.16, 0.17, 0.20) * uFill;

    // нормаль стены из градиента SDF
    vec2 e = vec2(1.5 / uRes.x, 1.5 / uRes.y);
    vec2 g = vec2(sdf(uv + vec2(e.x, 0)) - sdf(uv - vec2(e.x, 0)),
                  sdf(uv + vec2(0, e.y)) - sdf(uv - vec2(0, e.y)));
    g = normalize(g + vec2(1e-9));
    float lit = clamp(-g.y * 0.5 + 0.5, 0.0, 1.0);
    stone *= 0.60 + 0.70 * lit;

    /*
     * Контурный свет. Панель шире камня, поэтому её свет заходит на кромку
     * с изнанки — у подсвеченного сзади предмета всегда светится край. Это
     * и не даёт ему стать плоской чёрной вырезкой.
     */
    float rimW = 1.0 - smoothstep(0.0, 9.0, -dpx);
    stone += warm * uBackLight * rimW * rimW * 0.16;
    stone += warm * uBackLight * (1.0 - smoothstep(0.0, 2.5, -dpx)) * 0.30;

    /*
     * Тени камня на панели быть не может, и раньше она тут была ошибочно.
     * Источник света — сама панель, она ЗА камнем; между камнем и зрителем
     * нет поверхности, на которую тень могла бы лечь. А написано было
     * затемнение по расстоянию до тела, то есть одинаковое во все стороны,
     * включая вверх — отсюда и брались тёмные пятна, висящие в воздухе над
     * камнями. Подсвеченный сзади предмет даёт чистый силуэт; за переход
     * отвечает контурный свет на кромке, он уже есть выше.
     */

    float inside = 1.0 - smoothstep(-1.2, 1.2, dpx);
    /*
     * На выход — ЛИНЕЙНЫЙ свет. Цвета выше подбирались на глаз, то есть в
     * гамма-кодировании; переводим их в линейное, потому что дальше идёт
     * настоящая физика: закон Бугера–Ламберта, рассеяние и Френель — всё
     * это законы про поток энергии, и в гамма-кодированных числах они
     * попросту неверны. Обратно в гамму кадр вернётся в пост-проходе.
     */
    // max перед pow обязателен: затенение уводит камень чуть ниже нуля, а
    // отрицательное число в дробной степени даёт NaN — он потом расползается
    // размытием ореола и рвёт кадр чёрными кляксами.
    o = vec4(pow(max(mix(bg, stone, inside), vec3(0.0)), vec3(2.2)), inside);
  }`;

  /* --- пост: свечение бликов и тональная компрессия ------------------ */
  /*
   * Композит воды пишется в HDR-буфер, где яркость блика может быть и 20, и
   * 50. Без этого блик просто упирался в единицу и выглядел плоским белым
   * пятном — главная примета «отрендерено», а не «снято».
   *
   * Отсюда два прохода: сначала выделяем то, что ярче единицы, и размываем
   * (в объективе яркий свет всегда даёт ореол), потом складываем обратно и
   * прогоняем через плёночную кривую ACES, у которой света уходят в белый
   * плавно, а не обрезаются.
   */
  var FS_BRIGHT = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform vec2 uSrcRes;
  uniform float uThresh;
  out vec4 o;
  void main(){
    // цель вчетверо мельче источника
    vec2 uv = gl_FragCoord.xy * 4.0 / uSrcRes;
    vec2 t = 1.0 / uSrcRes;
    vec3 s = texture(uSrc, uv + vec2(-1.0,-1.0)*t).rgb
           + texture(uSrc, uv + vec2( 1.0,-1.0)*t).rgb
           + texture(uSrc, uv + vec2(-1.0, 1.0)*t).rgb
           + texture(uSrc, uv + vec2( 1.0, 1.0)*t).rgb;
    s *= 0.25;
    // страховка от бесконечностей: одна такая расползается размытием
    s = min(s, vec3(64.0));
    if (!(s.r == s.r && s.g == s.g && s.b == s.b)) s = vec3(0.0);
    float lum = dot(s, vec3(0.2126, 0.7152, 0.0722));
    o = vec4(s * max(lum - uThresh, 0.0) / max(lum, 1e-4), 1.0);
  }`;

  var FS_BLOOM = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform vec2 uDir;
  uniform vec2 uSrcRes;
  out vec4 o;
  void main(){
    vec2 texel = 1.0 / uSrcRes;
    vec2 uv = gl_FragCoord.xy * texel;
    const float off[4] = float[4](0.0, 1.3846, 3.2308, 5.1765);
    const float wt[4]  = float[4](0.2270, 0.3162, 0.0702, 0.0101);
    vec3 s = texture(uSrc, uv).rgb * wt[0];
    for (int i = 1; i < 4; i++){
      vec2 d = uDir * off[i] * texel;
      s += texture(uSrc, uv + d).rgb * wt[i];
      s += texture(uSrc, uv - d).rgb * wt[i];
    }
    o = vec4(s, 1.0);
  }`;

  var FS_POST = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform sampler2D uBloom;
  uniform vec2 uRes;
  uniform float uExposure;
  uniform float uBloomAmt;
  uniform float uVignette;
  out vec4 o;
  ` + COMMON + `

  /* Плёночная кривая ACES: света сходятся к белому плавно. */
  vec3 aces(vec3 x){
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main(){
    vec2 uv = gl_FragCoord.xy / uRes;
    vec3 c = texture(uSrc, uv).rgb;
    c += texture(uBloom, uv).rgb * uBloomAmt;
    c *= uExposure;

    // виньетка объектива — слабая, только чтобы кадр не был равномерным
    vec2 d = (uv - 0.5) * vec2(1.0, 0.62);
    c *= 1.0 - uVignette * dot(d, d) * 1.9;

    c = aces(c);
    // в sRGB: считали в линейном свете, экран ждёт гамма-кодированное
    c = pow(max(c, 0.0), vec3(1.0 / 2.2));
    // зерно: убирает полосы на плавных градиентах и добавляет «снятости»
    c += (hash(gl_FragCoord.xy * 0.37 + fract(uv.x)) - 0.5) * 0.012;
    o = vec4(c, 1.0);
  }`;

  /* --- splat частиц ------------------------------------------------- */
  var VS_SPLAT = `#version 300 es
  in vec2 aCorner;
  in vec2 aPos;      // метры
  in vec2 aVel;
  in float aFoam;
  in float aMat;
  uniform vec2 uRes;
  uniform float uPxPerM;
  uniform float uRadius;    // пиксели
  uniform float uStretch;   // растяжение вдоль скорости
  out vec2 vLocal;
  out vec2 vVel;
  out float vFoam;
  out float vAmp;
  // Единичный вектор материала считаем здесь: в фрагментном шейдере
  // индексировать выход переменной нельзя, только константой.
  flat out vec4 vMatW;
  void main(){
    vMatW = vec4(equal(ivec4(int(aMat + 0.5)), ivec4(0, 1, 2, 3)));
    vec2 c = vec2(aPos.x * uPxPerM, uRes.y - aPos.y * uPxPerM);
    // Падающая струя растягивается: частицы расходятся вдоль потока, и
    // круглые кляксы перестают перекрываться — тонкая струя просто исчезает.
    // Вытягиваем каплю по направлению движения (заодно это смаз движения),
    // амплитуду гасим, чтобы поле не «набирало массу» из воздуха.
    float sp = length(aVel);
    float a = 1.0 + min(max(sp - ${STRETCH_MIN.toFixed(1)}, 0.0) * uStretch,
                        ${STRETCH_CAP.toFixed(1)});
    vec2 dir = sp > 1e-4 ? aVel / sp : vec2(0.0, 1.0);
    dir.y = -dir.y;                       // экранная ось Y смотрит вниз
    vec2 perp = vec2(-dir.y, dir.x);
    vec2 off = (dir * aCorner.x * a + perp * aCorner.y) * uRadius;
    gl_Position = vec4((c + off) / uRes * 2.0 - 1.0, 0.0, 1.0);
    vLocal = aCorner;
    vVel = aVel;
    vFoam = aFoam;
    // амплитуду не гасим — см. комментарий к splatWeight
    vAmp = 1.0;
  }`;

  var FS_SPLAT = `#version 300 es
  precision highp float;
  in vec2 vLocal;
  in vec2 vVel;
  in float vFoam;
  in float vAmp;
  flat in vec4 vMatW;
  layout(location = 0) out vec4 o;
  layout(location = 1) out vec4 oMat;
  void main(){
    float r2 = dot(vLocal, vLocal);
    if (r2 > 1.0) discard;
    // гауссиана, зануленная на кромке (константы общие с splatWeight)
    float w = max(exp(-${SPLAT_K.toFixed(1)} * r2) - ${SPLAT_EDGE.toFixed(6)}, 0.0) * vAmp;
    o = vec4(w, vVel * w, vFoam * w);
    // вес кладём в канал своей жидкости: сумма каналов равна плотности,
    // а их отношение даёт долю каждой жидкости в пикселе
    oMat = vMatW * w;
  }`;

  /* --- раздельное размытие ------------------------------------------ */
  /* Размываем оба поля разом: отсчёты берутся в одних и тех же точках,
     поэтому доли жидкостей сглаживаются согласованно с плотностью. */
  var FS_BLUR = `#version 300 es
  precision highp float;
  uniform sampler2D uSrc;
  uniform sampler2D uSrcMat;
  uniform vec2 uDir;         // шаг в пикселях источника
  uniform vec2 uSrcRes;
  layout(location = 0) out vec4 o;
  layout(location = 1) out vec4 oMat;
  void main(){
    vec2 texel = 1.0 / uSrcRes;
    vec2 uv = gl_FragCoord.xy * texel;
    // 9 отсчётов, попарно снятых билинейной выборкой = гауссиана шириной ~13
    const float off[5] = float[5](0.0, 1.4117, 3.2941, 5.1765, 7.0588);
    const float wt[5]  = float[5](0.1964, 0.2969, 0.0944, 0.0104, 0.0003);
    vec4 s = texture(uSrc, uv) * wt[0];
    vec4 sm = texture(uSrcMat, uv) * wt[0];
    for (int i = 1; i < 5; i++){
      vec2 d = uDir * off[i] * texel;
      s += texture(uSrc, uv + d) * wt[i];
      s += texture(uSrc, uv - d) * wt[i];
      sm += texture(uSrcMat, uv + d) * wt[i];
      sm += texture(uSrcMat, uv - d) * wt[i];
    }
    o = s; oMat = sm;
  }`;

  /* --- сколько воды над пикселем (для затемнения глубины) ----------- */
  var FS_ABOVE = `#version 300 es
  precision highp float;
  uniform sampler2D uField;
  uniform vec2 uRes;
  uniform float uIso;
  uniform float uMPerPx;
  out vec4 o;
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes;
    float acc = 0.0;
    float stepPx = uRes.y / 22.0;
    for (int i = 1; i <= 22; i++){
      float y = gl_FragCoord.y + float(i) * stepPx;   // экранный верх = +y
      if (y > uRes.y) break;
      float d = texture(uField, vec2(gl_FragCoord.x, y) / uRes).r;
      acc += smoothstep(uIso * 0.55, uIso * 1.25, d);
    }
    o = vec4(acc * stepPx * uMPerPx, 0.0, 0.0, 1.0);
  }`;

  /* --- композит ------------------------------------------------------ */
  var FS_WATER = `#version 300 es
  precision highp float;
  uniform sampler2D uField;
  uniform sampler2D uScene;
  uniform sampler2D uAbove;
  uniform vec2 uRes;
  uniform float uIso;
  uniform float uFull;
  uniform float uTankDepth;     // метры «в глубину экрана»
  uniform float uAbsorb;        // множитель поглощения
  uniform float uScatter;       // мутность (однократное рассеяние)
  uniform float uRefract;
  uniform float uHeight;
  uniform float uFoamAmt;
  uniform float uSpec;
  uniform float uBlur;
  uniform float uRipple;
  uniform float uFoamLight;    // чем освещена пена, в линейных единицах
  uniform float uTime;
  uniform sampler2D uMat;      // доли жидкостей в пикселе
  uniform vec3 uAbsorbK[4];     // 1/м, по жидкостям
  uniform vec3 uScatterK[4];
  uniform vec3 uFoamCol[4];
  uniform vec4 uMetal;         // «металличность» каждой жидкости
  uniform vec4 uIor;
  out vec4 o;
  ` + COMMON + `

  float fieldAt(vec2 p){ return texture(uField, p / uRes).r; }
  // Псевдовысота: 0 на кромке воды, 1 в полной толще. Купол sqrt даёт у края
  // крутую нормаль (там поверхность отворачивается от зрителя), а в глубине —
  // почти фронтальную. Нормировка на (uFull-uIso) делает ползунок рельефа
  // независимым от размера частиц.
  float heightAt(vec2 p){
    return sqrt(max(0.0, fieldAt(p) - uIso) / max(uFull - uIso, 1e-4));
  }

  // Вид сбоку: камера смотрит горизонтально, поверхность воды в основном
  // обращена к зрителю, поэтому отражается «комната» за камерой —
  // светлый потолок сверху, тёмный пол снизу и лампа слева вверху.
  /*
   * Отражение — главный источник правдоподобия для воды: она почти не имеет
   * собственного цвета и живёт тем, что показывает вокруг. Поэтому здесь не
   * просто градиент, а грубая «комната» за спиной зрителя: тёмный пол,
   * светлый потолок, узкая яркая полоса окна и две лампы. Всё в линейном
   * свете, лампы намеренно ярче единицы — именно из них потом растёт ореол.
   */
  vec3 env(vec3 d){
    /*
     * Теперь свет стоит ЗА аквариумом, значит комната перед ним тёмная и
     * отражать почти нечего — как и бывает при съёмке на просвет. Оставлен
     * слабый верхний отблеск: часть света панели возвращается от потолка, и
     * без него поверхность воды теряет линию.
     */
    float t = clamp(d.y * 0.5 + 0.5, 0.0, 1.0);
    vec3 c = mix(vec3(0.004, 0.005, 0.008), vec3(0.10, 0.12, 0.16), pow(t, 1.8));
    float band = exp(-pow((d.y - 0.34) * 6.0, 2.0));
    c += vec3(0.45, 0.55, 0.72) * band * 0.35;
    // две лампы: тёплая слева сверху и слабая холодная справа
    vec3 l1 = normalize(vec3(-0.40, 0.70, 0.59));
    vec3 l2 = normalize(vec3(0.62, 0.52, 0.59));
    /*
     * clamp, а не max — обязательно. Скалярное произведение двух единичных
     * векторов может выйти 1.0000001 из-за округления, и тогда возведение в
     * 900-ю степень даёт бесконечность. Дальше она попадает в яркостный
     * проход, там Inf/Inf превращается в NaN, размытие разносит его по
     * округе — и в кадре появляется чёрный клин.
     */
    float d1 = clamp(dot(d, l1), 0.0, 1.0), d2 = clamp(dot(d, l2), 0.0, 1.0);
    c += vec3(1.0, 0.93, 0.80) * pow(d1, 900.0) * 14.0;
    c += vec3(1.0, 0.95, 0.86) * pow(d1, 26.0) * 0.14;
    c += vec3(0.70, 0.82, 1.0) * pow(d2, 700.0) * 5.0;
    c += vec3(0.62, 0.74, 0.95) * pow(d2, 20.0) * 0.05;
    return c;
  }

  void main(){
    vec2 px = gl_FragCoord.xy;
    vec2 uv = px / uRes;
    vec4 f = texture(uField, uv);
    float D = f.r;
    vec4 sc = texture(uScene, uv);
    vec3 scene = sc.rgb;

    // Мокрый камень: там, где вода касается стенки, поверхность темнеет и
    // начинает бликовать — плёнка воды заполняет микрорельеф.
    float wet = smoothstep(uIso * 0.03, uIso * 0.5, D) * sc.a;
    if (wet > 0.0) {
      scene = mix(scene, scene * scene * 1.35, wet * 0.85);
      scene += vec3(0.35, 0.44, 0.55) * wet * 0.05;
    }

    float cover = smoothstep(uIso * ${COVER_LO.toFixed(2)}, uIso * ${COVER_HI.toFixed(2)}, D);
    if (cover <= 0.001) { o = vec4(scene, 1.0); return; }

    vec2 vel = f.gb / max(D, 1e-4);
    float foam = f.a / max(D, 1e-4);

    // ---- что за жидкость в этом пикселе ----
    vec4 mw = texture(uMat, uv);
    float mTot = mw.x + mw.y + mw.z + mw.w;
    vec4 frac = mTot > 1e-5 ? mw / mTot : vec4(1.0, 0.0, 0.0, 0.0);
    vec3 sigA = uAbsorbK[0] * frac.x + uAbsorbK[1] * frac.y
              + uAbsorbK[2] * frac.z + uAbsorbK[3] * frac.w;
    vec3 sigSb = uScatterK[0] * frac.x + uScatterK[1] * frac.y
               + uScatterK[2] * frac.z + uScatterK[3] * frac.w;
    vec3 foamCol = uFoamCol[0] * frac.x + uFoamCol[1] * frac.y
                 + uFoamCol[2] * frac.z + uFoamCol[3] * frac.w;
    float metal = dot(uMetal, frac);
    float ior = dot(uIor, frac);

    // ---- нормаль поверхности ----
    float e = 1.25;
    float hx = heightAt(px + vec2(e, 0.0)) - heightAt(px - vec2(e, 0.0));
    float hy = heightAt(px + vec2(0.0, e)) - heightAt(px - vec2(0.0, e));
    vec3 nRaw = vec3(-hx * uHeight, -hy * uHeight, 1.0);
    /*
     * Наклон ограничен, и это не косметика. Псевдовысота — корень из поля
     * плотности, а у корня производная на кромке уходит в бесконечность:
     * ровно по краю воды нормаль разворачивается скачком, где-то обязательно
     * совпадает с направлением на источник и ловит полное зеркало. По всей
     * береговой линии шла режущая белая нить, а ореол её ещё и размазывал.
     * У настоящей воды кромка заворачивается плавно, на масштабе мениска.
     */
    float tilt = length(nRaw.xy);
    if (tilt > 2.6) nRaw.xy *= 2.6 / tilt;      // не круче ~69° к зрителю
    vec3 n = normalize(nRaw);

    /*
     * Капиллярная рябь. Это не украшение: гладкой воды не бывает, и именно
     * мелкая рябь даёт то дробное мерцание, по которому глаз опознаёт
     * жидкость. Без неё поверхность читается как крашеный гель.
     *
     * Две октавы шума, снесённые полем скоростей (рябь живёт на потоке, а
     * не мерцает на месте) плюс медленный дрейф — чтобы стоячая вода тоже
     * дышала. Амплитуда растёт с движением: покой глаже, бурление рябее.
     */
    vec2 flow = px * 0.055 - vel * uTime * 2.2;
    float r1 = fbm(flow + uTime * 0.09);
    float r2 = fbm(flow * 2.7 - uTime * 0.13);
    float rd = 1.1;
    vec2 g1 = vec2(fbm(flow + vec2(rd, 0.0)) - fbm(flow - vec2(rd, 0.0)),
                   fbm(flow + vec2(0.0, rd)) - fbm(flow - vec2(0.0, rd)));
    vec2 g2 = vec2(fbm(flow * 2.7 + vec2(rd, 0.0)) - fbm(flow * 2.7 - vec2(rd, 0.0)),
                   fbm(flow * 2.7 + vec2(0.0, rd)) - fbm(flow * 2.7 - vec2(0.0, rd)));
    float amp = uRipple * (0.35 + 0.65 * clamp(length(vel) * 0.5, 0.0, 1.0));
    n = normalize(n + vec3(g1 * amp + g2 * amp * 0.55, 0.0));

    vec3 view = vec3(0.0, 0.0, 1.0);

    // ---- преломление фона ----
    float thickFrac = clamp((D - uIso) / max(uFull - uIso, 1e-4), 0.0, 1.0);
    vec2 refr = n.xy * uRefract * (0.35 + 0.65 * thickFrac);
    vec2 rstep = refr / uRes * vec2(1.0, -1.0);
    /*
     * Толща размывает картинку за собой: свет в ней рассеивается, и чем
     * толще слой, тем меньше видно деталей. Берём несколько отсчётов по
     * кругу с радиусом, растущим от толщины.
     *
     * Дисперсию — разный показатель преломления для разных длин волн —
     * берём для каждого канала СВОИМ смещением, но с тем же размытием.
     * Раньше зелёный брался размытым, а красный с синим резкими: на
     * контрастной решётке фона это давало ядовитую зелёную кайму по всем
     * линиям. Разница в показателе преломления воды между красным и
     * фиолетовым около 1%, поэтому и смещения такие.
     */
    float blur = uBlur * (0.15 + 0.85 * thickFrac) / max(uRes.x, 1.0);
    const vec2 kern[5] = vec2[5](vec2(0.0), vec2(0.95, 0.3), vec2(-0.6, 0.8),
                                 vec2(-0.7, -0.7), vec2(0.35, -0.95));
    vec3 back = vec3(0.0);
    for (int i = 0; i < 5; i++) {
      vec2 k = kern[i] * blur;
      back.r += texture(uScene, uv + rstep * 0.988 + k).r;
      back.g += texture(uScene, uv + rstep         + k).g;
      back.b += texture(uScene, uv + rstep * 1.012 + k).b;
    }
    back *= 0.2;

    // ---- перенос света в воде: поглощение + однократное рассеяние ----
    // sigma_a — настоящие коэффициенты поглощения воды (1/м): красный гаснет
    // почти в 20 раз быстрее синего, отсюда бирюза без всякой раскраски.
    // Свет, попавший в толщу сверху, гаснет на глубине above, часть его
    // рассеивается в сторону зрителя по пути path — это и есть свечение воды.
    float above = texture(uAbove, uv).r;
    float path = uTankDepth * (0.30 + 0.70 * thickFrac);
    sigA *= uAbsorb;
    vec3 sigS = sigSb * uScatter;
    vec3 sigT = sigA + sigS + 1e-4;

    vec3 Tview = exp(-sigT * path);                // панель сквозь толщу к зрителю
    vec3 Tdown = exp(-sigT * (above * 1.35));      // свет сверху сквозь слой

    /*
     * Свет идёт от панели ЗА аквариумом прямо в камеру, поэтому источником
     * рассеяния служит она же — то, что мы уже взяли из фона с преломлением.
     * Часть её света доходит напрямую (Tview), часть рассеивается по пути и
     * приходит размытой: (sigS/sigT)*(1-Tview). На большой глубине это даёт
     * постоянную долю — предел диффузии, физически верное поведение.
     *
     * Именно поэтому цвет воды тут рождается сам: красный гаснет по пути в
     * двадцать раз быстрее синего, и толща на просвет уходит в бирюзу.
     */
    vec3 inscat = back * (sigS / sigT) * (1.0 - Tview);
    // остатки верхнего света — слабые, они лишь оживляют приповерхностный слой
    inscat += vec3(1.0, 0.97, 0.92) * 0.05 * Tdown * (sigS / sigT) * (1.0 - Tview);
    vec3 body = back * Tview + inscat;

    // ---- отражение + Френель (Шлик) ----
    // F0 = ((n-1)/(n+1))^2: у воды 0.02, у масла 0.036. У металла отражение
    // почти зеркальное и прозрачности нет вовсе — отсюда отдельная ветка.
    vec3 r = reflect(-view, n);
    vec3 refl = env(r);
    float f0 = (ior - 1.0) / (ior + 1.0); f0 *= f0;
    float ct = max(dot(n, view), 0.0);
    float F = f0 + (1.0 - f0) * pow(1.0 - ct, 5.0);
    vec3 col = mix(body, refl, F * 0.9);

    if (metal > 0.001) {
      /*
       * Ртуть — не жидкость со «своим цветом», а зеркало: отражает 73% и
       * не пропускает ничего. Кроме окружения подмешиваем то, что за ней:
       * в виде сбоку зеркало показывает в основном стену позади зрителя,
       * а её у нас нет — сцена за жидкостью тут ближайшее правдоподобное.
       */
      vec3 mf0 = vec3(0.78, 0.76, 0.74);
      vec3 mF = mf0 + (1.0 - mf0) * pow(1.0 - ct, 5.0);
      vec3 mirror = (refl * 1.55 + scene * 0.55) * mF;
      // резкий узкий блик — характерная примета металла
      vec3 hm = normalize(normalize(vec3(-0.40, 0.70, 0.59)) + view);
      mirror += vec3(1.0, 0.98, 0.95) * pow(max(dot(n, hm), 0.0), 420.0) * 3.0;
      col = mix(col, mirror, metal);
    }

    // ---- блик ----
    // Два лепестка: узкий даёт искры на ряби, широкий — общий глянец.
    vec3 L = normalize(vec3(-0.40, 0.70, 0.59));
    vec3 H = normalize(L + view);
    float nh = clamp(dot(n, H), 0.0, 1.0);
    col += vec3(1.0, 0.97, 0.92) * pow(nh, 220.0) * uSpec * 6.0;
    col += vec3(0.72, 0.84, 1.0) * pow(nh, 22.0) * uSpec * 0.06;

    // ---- пена ----
    // Пена — не ровная белая краска, а комки пузырьков. Модулируем её
    // шумом, который сносится вместе с водой: пятна живут на потоке, а не
    // мерцают на месте.
    float edge = 1.0 - smoothstep(0.0, 0.55, thickFrac);   // тонкий край
    float fo = clamp(foam * uFoamAmt, 0.0, 1.0);
    fo = clamp(fo + edge * fo * 0.9, 0.0, 1.0);
    if (fo > 0.001) {
      vec2 adv = px * 0.09 - vel * uTime * 1.4;
      float lumps = fbm(adv) * 0.65 + fbm(adv * 2.7 + 4.3) * 0.35;
      fo *= smoothstep(0.18, 0.72, lumps * 0.55 + 0.45 + fo * 0.35);
    }
    /*
     * Пена — не источник света, а рыхлый белый материал: её яркость это
     * альбедо, помноженное на то, чем её освещают. Цвета в таблице заданы
     * как воспринимаемые (гамма), поэтому переводим их в линейные и
     * умножаем на освещённость сцены. Без этого пена шла в кадр с яркостью
     * 0.95 при воде в 0.03 — то есть в тридцать раз ярче, и любой поток
     * превращался в сплошное белое пятно.
     */
    vec3 foamLit = pow(foamCol, vec3(2.2)) * uFoamLight;
    // немного блеска: мокрая пена не матовая
    foamLit += vec3(1.0, 0.98, 0.95) * pow(nh, 60.0) * uFoamLight * 0.5;
    col = mix(col, foamLit, fo * 0.9 * (1.0 - metal));

    // ---- каустика ----
    // Вогнутый участок поверхности собирает свет в пучок, выпуклый —
    // рассеивает. Знак лапласиана псевдовысоты даёт и то, и другое.
    float curv = (heightAt(px + vec2(e,0.0)) + heightAt(px - vec2(e,0.0))
                + heightAt(px + vec2(0.0,e)) + heightAt(px - vec2(0.0,e))
                - 4.0 * heightAt(px)) * uHeight;
    float caust = clamp(-curv * 0.55, 0.0, 1.5);
    // свет успевает погаснуть, пока идёт сквозь толщу — красный первым
    col += vec3(0.62, 0.84, 0.95) * Tdown * caust * caust * 0.5 * (1.0 - fo) * (1.0 - metal);

    o = vec4(mix(scene, col, cover), 1.0);
  }`;

  /* --- брызги / пена / пузырьки ------------------------------------- */
  var VS_DIFFUSE = `#version 300 es
  in vec2 aCorner;
  in vec2 aPos;
  in float aType;
  in float aLife;     // 0..1 остаток жизни
  in float aSize;
  in float aMat;
  uniform vec2 uRes;
  uniform float uPxPerM;
  uniform float uScale;
  uniform vec3 uFoamCol[4];
  uniform vec4 uMetalD;
  out vec2 vLocal;
  out float vType;
  out float vLife;
  out vec3 vCol;
  flat out float vMetal;
  void main(){
    int mi = int(aMat + 0.5);
    vCol = uFoamCol[mi];
    vMetal = uMetalD[mi];
    vec2 c = vec2(aPos.x * uPxPerM, uRes.y - aPos.y * uPxPerM);
    // пузырьки мельче брызг, пена — самая крупная и рыхлая
    float r = aSize * uScale * (aType > 1.5 ? 0.75 : (aType > 0.5 ? 1.25 : 0.8));
    gl_Position = vec4((c + aCorner * r) / uRes * 2.0 - 1.0, 0.0, 1.0);
    vLocal = aCorner; vType = aType; vLife = aLife;
  }`;

  var FS_DIFFUSE = `#version 300 es
  precision highp float;
  in vec2 vLocal;
  in float vType;
  in float vLife;
  in vec3 vCol;
  flat in float vMetal;
  uniform float uLight;
  out vec4 o;
  void main(){
    float r = length(vLocal);
    if (r > 1.0) discard;
    float fade = smoothstep(0.0, 0.35, vLife);
    /*
     * Спрайты рисуются в тот же линейный HDR-буфер, что и вода, поэтому их
     * цвет — тоже альбедо, помноженное на освещённость. Капля не светится.
     */
    if (vType > 1.5) {
      // пузырёк: почти прозрачный, виден светлым ободком и бликом
      float ring = smoothstep(0.50, 0.92, r) * (1.0 - smoothstep(0.92, 1.0, r));
      float gl = pow(max(0.0, 1.0 - length(vLocal - vec2(-0.34, -0.34)) * 2.8), 2.0);
      o = vec4(pow(vec3(0.80, 0.91, 1.0), vec3(2.2)) * uLight * (ring * 0.8 + gl * 2.2),
               (ring * 0.55 + gl * 0.4) * fade);
    } else {
      // брызги и пена: цвет берём у своей жидкости — пивная пена кремовая,
      // масляная жёлтая, ртутные капли зеркальные
      float a = pow(1.0 - r, 1.7);
      vec3 c = pow(vCol, vec3(2.2)) * uLight;
      // капля круглая: подсветим её с той же стороны, откуда светит лампа
      c *= 0.75 + 0.9 * pow(max(0.0, 1.0 - length(vLocal - vec2(-0.3, 0.34)) * 1.5), 2.0);
      if (vMetal > 0.5) c = mix(c, (vec3(0.5) + vec3(0.9) * (1.0 - r)) * uLight, 0.85);
      o = vec4(c, a * fade * (vType > 0.5 ? 0.70 : 0.85));
    }
  }`;

  /* ------------------------------------------------------------------ */
  /* Утилиты GL                                                          */

  function compile(gl, type, src, name) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(name + ': ' + gl.getShaderInfoLog(s));
    return s;
  }

  function program(gl, vs, fs, name) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs, name + '.vs'));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs, name + '.fs'));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(name + ' link: ' + gl.getProgramInfoLog(p));
    p._u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) {
      var info = gl.getActiveUniform(p, i);
      p._u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return p;
  }

  function newTex(gl, w, h, internal, format, type, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /* opts.extra — сколько дополнительных цветовых вложений (для MRT). */
  function makeTarget(gl, w, h, internal, format, type, filter, opts) {
    var extra = (opts && opts.extra) || 0;
    var t = newTex(gl, w, h, internal, format, type, filter);
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    var res = { tex: t, fbo: f, w: w, h: h, tex2: null };
    if (extra) {
      res.tex2 = newTex(gl, w, h, internal, format, type, filter);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, res.tex2, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    }
    var st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) throw new Error('FBO неполон: 0x' + st.toString(16));
    return res;
  }

  /* ------------------------------------------------------------------ */

  function Renderer(canvas, cfg) {
    this.canvas = canvas;
    this.W = canvas.width;
    this.H = canvas.height;
    this.pxPerM = cfg.pxPerM;
    this.maxParticles = cfg.maxParticles;
    this.maxDiffuse = cfg.maxDiffuse;

    // Сначала проверяем поддержку на одноразовом холсте. Если запросить
    // webgl2 у настоящего холста и отказаться, холст останется навсегда
    // привязан к gl-контексту, и запасной getContext('2d') вернёт null.
    var why = Renderer.probe();
    if (why) { this.ok = false; this.reason = why; return; }

    var gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance'
    });
    if (!gl) { this.ok = false; this.reason = 'WebGL2 недоступен'; return; }
    this.gl = gl;
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('OES_texture_float_linear');

    try { this.init(); this.ok = true; }
    catch (e) { this.ok = false; this.reason = e.message; }
  }

  /* Возвращает причину отказа или null, если всё нужное есть. */
  Renderer.probe = function () {
    try {
      var t = document.createElement('canvas');
      t.width = t.height = 1;
      var g = t.getContext('webgl2');
      if (!g) return 'WebGL2 недоступен';
      if (!g.getExtension('EXT_color_buffer_float'))
        return 'нет float-буферов (EXT_color_buffer_float)';
      var lose = g.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return null;
    } catch (e) { return e.message || 'WebGL2 недоступен'; }
  };

  Renderer.prototype.init = function () {
    var gl = this.gl, W = this.W, H = this.H;

    this.pScene = program(gl, VS_FULL, FS_SCENE, 'scene');
    this.pSplat = program(gl, VS_SPLAT, FS_SPLAT, 'splat');
    this.pBlur = program(gl, VS_FULL, FS_BLUR, 'blur');
    this.pAbove = program(gl, VS_FULL, FS_ABOVE, 'above');
    this.pWater = program(gl, VS_FULL, FS_WATER, 'water');
    this.pDiffuse = program(gl, VS_DIFFUSE, FS_DIFFUSE, 'diffuse');
    this.pBright = program(gl, VS_FULL, FS_BRIGHT, 'bright');
    this.pBloom = program(gl, VS_FULL, FS_BLOOM, 'bloom');
    this.pPost = program(gl, VS_FULL, FS_POST, 'post');

    /*
     * Сцена теперь в полуплавающем формате: в линейном свете тёмные тона
     * занимают крошечный кусок диапазона, и восьми бит на канал не хватает —
     * на градиентах фона вылезали ступеньки.
     */
    this.scene = makeTarget(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    // куда пишется композит до тональной компрессии: блик может быть и 50
    this.hdr = makeTarget(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    // ореол считаем в четверть разрешения — он всё равно размытый
    var bw = W >> 2, bh = H >> 2;
    this.bloomA = makeTarget(gl, bw, bh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    this.bloomB = makeTarget(gl, bw, bh, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR);
    // поле плотности и поле долей жидкостей пишутся и размываются парой
    this.fieldA = makeTarget(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR,
                             { extra: 1 });
    this.fieldB = makeTarget(gl, W, H, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, gl.LINEAR,
                             { extra: 1 });
    this.above = makeTarget(gl, W >> 1, H >> 1, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR);

    // SDF стен
    this.sdfTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.sdfW = 0;

    // геометрия: пустой VAO для полноэкранных проходов
    this.emptyVao = gl.createVertexArray();

    // квадрат для инстансинга
    var corners = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, corners, gl.STATIC_DRAW);

    // splat: [x, y, vx, vy, foam, mat]
    this.splatData = new Float32Array(this.maxParticles * 6);
    this.splatBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.splatData.byteLength, gl.DYNAMIC_DRAW);
    this.splatVao = this.makeInstVao(this.pSplat, this.splatBuf, [
      ['aPos', 2], ['aVel', 2], ['aFoam', 1], ['aMat', 1]], 6);

    // diffuse: [x, y, type, life, size, mat]
    this.diffData = new Float32Array(this.maxDiffuse * 6);
    this.diffBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.diffBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.diffData.byteLength, gl.DYNAMIC_DRAW);
    this.diffVao = this.makeInstVao(this.pDiffuse, this.diffBuf, [
      ['aPos', 2], ['aType', 1], ['aLife', 1], ['aSize', 1], ['aMat', 1]], 6);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  };

  Renderer.prototype.makeInstVao = function (prog, buf, attrs, stride) {
    var gl = this.gl;
    var vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    var lc = gl.getAttribLocation(prog, 'aCorner');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(lc);
    gl.vertexAttribPointer(lc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    var off = 0;
    for (var i = 0; i < attrs.length; i++) {
      var loc = gl.getAttribLocation(prog, attrs[i][0]);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, attrs[i][1], gl.FLOAT, false, stride * 4, off * 4);
        gl.vertexAttribDivisor(loc, 1);
      }
      off += attrs[i][1];
    }
    gl.bindVertexArray(null);
    return vao;
  };

  /* Изоуровень: сколько поле набирает при полной упаковке. Считаем ровно
   * так же, как rho0 в физике — суммой по гексагональной решётке. */
  Renderer.prototype.calibrate = function (dpPx, radiusPx) {
    var s = 0, dy = dpPx * Math.sqrt(3) / 2;
    var rows = Math.ceil(radiusPx / dy) + 1, cols = Math.ceil(radiusPx / dpPx) + 1;
    for (var j = -rows; j <= rows; j++) {
      var off = (Math.abs(j) % 2) ? 0.5 : 0;
      for (var i = -cols; i <= cols; i++) {
        s += splatWeight(j * dy, (i + off) * dpPx, radiusPx, 1);
      }
    }
    this.fullField = s;
    this.iso = s * ISO_FRAC;
    this.splatRadius = radiusPx;
  };

  /* Оптику жидкостей раскладываем в массивы под uniform-ы: 4 жидкости,
   * дальше шейдер смешивает их по долям в пикселе. */
  Renderer.prototype.setMaterials = function (list) {
    var absorb = new Float32Array(12), scatter = new Float32Array(12);
    var foamCol = new Float32Array(12);
    var metal = new Float32Array(4), ior = new Float32Array(4);
    for (var i = 0; i < 4; i++) {
      var m = list[i] || list[0];
      absorb[i * 3] = m.absorb[0]; absorb[i * 3 + 1] = m.absorb[1]; absorb[i * 3 + 2] = m.absorb[2];
      scatter[i * 3] = m.scatter[0]; scatter[i * 3 + 1] = m.scatter[1]; scatter[i * 3 + 2] = m.scatter[2];
      foamCol[i * 3] = m.foamColor[0]; foamCol[i * 3 + 1] = m.foamColor[1];
      foamCol[i * 3 + 2] = m.foamColor[2];
      metal[i] = m.metal; ior[i] = m.ior;
    }
    this.matUniforms = { absorb: absorb, scatter: scatter, foamCol: foamCol,
                         metal: metal, ior: ior };
  };

  Renderer.prototype.uploadSdf = function (solid) {
    var gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    if (this.sdfW !== solid.nx || this.sdfH !== solid.ny) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, solid.nx, solid.ny, 0, gl.RED, gl.FLOAT, solid.dist);
      this.sdfW = solid.nx; this.sdfH = solid.ny;
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, solid.nx, solid.ny, gl.RED, gl.FLOAT, solid.dist);
    }
    this.sceneDirty = true;
  };

  Renderer.prototype.fullscreen = function (target) {
    var gl = this.gl;
    if (target) { gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo); gl.viewport(0, 0, target.w, target.h); }
    else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, this.W, this.H); }
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  Renderer.prototype.draw = function (fluid, diffuse, p) {
    var gl = this.gl, W = this.W, H = this.H, u;

    // ---- 1. сцена (перерисовываем, когда изменились стены или свет) ----
    if (this._bl !== p.backLight || this._fl !== p.fill) {
      this._bl = p.backLight; this._fl = p.fill; this.sceneDirty = true;
    }
    if (this.sceneDirty) {
      gl.useProgram(this.pScene);
      u = this.pScene._u;
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
      gl.uniform1i(u.uSdf, 0);
      gl.uniform2f(u.uRes, W, H);
      gl.uniform1f(u.uPxPerM, this.pxPerM);
      gl.uniform2f(u.uSdfTexel, 1 / this.sdfW, 1 / this.sdfH);
      gl.uniform1f(u.uBackLight, p.backLight);
      gl.uniform1f(u.uFill, p.fill);
      gl.disable(gl.BLEND);
      this.fullscreen(this.scene);
      this.sceneDirty = false;
    }

    // ---- 2. splat частиц в float-поле ----
    var n = fluid.n, d = this.splatData;
    if (n > this.maxParticles) n = this.maxParticles;
    var fmat = fluid.mat;
    for (var i = 0, k = 0; i < n; i++) {
      d[k++] = fluid.px[i]; d[k++] = fluid.py[i];
      d[k++] = fluid.vx[i]; d[k++] = fluid.vy[i];
      d[k++] = fluid.foam[i]; d[k++] = fmat ? fmat[i] : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.splatBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, n * 6);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldA.fbo);
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (n > 0) {
      gl.useProgram(this.pSplat);
      u = this.pSplat._u;
      gl.uniform2f(u.uRes, W, H);
      gl.uniform1f(u.uPxPerM, this.pxPerM);
      gl.uniform1f(u.uRadius, this.splatRadius);
      gl.uniform1f(u.uStretch, p.stretch);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.splatVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
      gl.disable(gl.BLEND);
    }

    // ---- 3. размытие поля ----
    var passes = p.smooth | 0;
    var src = this.fieldA, dst = this.fieldB;
    gl.useProgram(this.pBlur);
    u = this.pBlur._u;
    gl.uniform1i(u.uSrc, 0); gl.uniform1i(u.uSrcMat, 1);
    for (var b = 0; b < passes; b++) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, src.tex2);
      gl.uniform2f(u.uDir, 1, 0); gl.uniform2f(u.uSrcRes, W, H);
      this.fullscreen(dst);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, dst.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, dst.tex2);
      gl.uniform2f(u.uDir, 0, 1); gl.uniform2f(u.uSrcRes, W, H);
      this.fullscreen(src);
    }
    var field = src;

    // ---- 4. сколько воды выше ----
    gl.useProgram(this.pAbove);
    u = this.pAbove._u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, field.tex);
    gl.uniform1i(u.uField, 0);
    gl.uniform2f(u.uRes, this.above.w, this.above.h);
    gl.uniform1f(u.uIso, this.iso);
    gl.uniform1f(u.uMPerPx, 1 / this.pxPerM);
    this.fullscreen(this.above);

    // ---- 5. композит воды ----
    gl.useProgram(this.pWater);
    u = this.pWater._u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, field.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.scene.tex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.above.tex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, field.tex2);
    gl.uniform1i(u.uField, 0); gl.uniform1i(u.uScene, 1); gl.uniform1i(u.uAbove, 2);
    gl.uniform1i(u.uMat, 3);
    if (this.matUniforms) {
      var mu = this.matUniforms;
      gl.uniform3fv(u['uAbsorbK[0]'], mu.absorb);
      gl.uniform3fv(u['uScatterK[0]'], mu.scatter);
      gl.uniform3fv(u['uFoamCol[0]'], mu.foamCol);
      gl.uniform4fv(u.uMetal, mu.metal);
      gl.uniform4fv(u.uIor, mu.ior);
    }
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uIso, this.iso);
    gl.uniform1f(u.uFull, this.fullField);
    gl.uniform1f(u.uTankDepth, p.tankDepth);
    gl.uniform1f(u.uAbsorb, p.absorb);
    gl.uniform1f(u.uScatter, p.scatter);
    gl.uniform1f(u.uRefract, p.refract);
    gl.uniform1f(u.uHeight, p.height);
    gl.uniform1f(u.uFoamAmt, p.foam);
    gl.uniform1f(u.uSpec, p.specular);
    gl.uniform1f(u.uBlur, p.blur);
    gl.uniform1f(u.uRipple, p.ripple);
    gl.uniform1f(u.uFoamLight, p.foamLight);
    gl.uniform1f(u.uTime, p.time);
    gl.disable(gl.BLEND);
    this.fullscreen(this.hdr);       // не на экран, а в HDR-буфер

    // ---- 6. брызги, пена, пузырьки ----
    var dn = diffuse ? Math.min(diffuse.n, this.maxDiffuse) : 0;
    if (dn > 0) {
      var dd = this.diffData, dmat = diffuse.mat;
      for (i = 0, k = 0; i < dn; i++) {
        dd[k++] = diffuse.px[i]; dd[k++] = diffuse.py[i];
        dd[k++] = diffuse.type[i];
        dd[k++] = diffuse.life[i] / (diffuse.life0[i] || 1);
        dd[k++] = diffuse.size[i];
        dd[k++] = dmat ? dmat[i] : 0;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.diffBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, dd, 0, dn * 6);
      gl.useProgram(this.pDiffuse);
      u = this.pDiffuse._u;
      gl.uniform2f(u.uRes, W, H);
      gl.uniform1f(u.uPxPerM, this.pxPerM);
      gl.uniform1f(u.uScale, p.diffuseScale);
      gl.uniform1f(u.uLight, p.foamLight);
      if (this.matUniforms) {
        gl.uniform3fv(u['uFoamCol[0]'], this.matUniforms.foamCol);
        gl.uniform4fv(u.uMetalD, this.matUniforms.metal);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.hdr.fbo);
      gl.viewport(0, 0, W, H);
      gl.bindVertexArray(this.diffVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, dn);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);

    // ---- 7. ореол от бликов ----
    var bw = this.bloomA.w, bh = this.bloomA.h;
    gl.useProgram(this.pBright);
    u = this.pBright._u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.hdr.tex);
    gl.uniform1i(u.uSrc, 0);
    gl.uniform2f(u.uSrcRes, W, H);
    gl.uniform1f(u.uThresh, p.bloomThresh);
    this.fullscreen(this.bloomA);

    gl.useProgram(this.pBloom);
    u = this.pBloom._u;
    gl.uniform1i(u.uSrc, 0);
    gl.uniform2f(u.uSrcRes, bw, bh);
    for (var q = 0; q < 2; q++) {
      gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
      gl.uniform2f(u.uDir, 1, 0);
      this.fullscreen(this.bloomB);
      gl.bindTexture(gl.TEXTURE_2D, this.bloomB.tex);
      gl.uniform2f(u.uDir, 0, 1);
      this.fullscreen(this.bloomA);
    }

    // ---- 8. тональная компрессия на экран ----
    gl.useProgram(this.pPost);
    u = this.pPost._u;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.hdr.tex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.bloomA.tex);
    gl.uniform1i(u.uSrc, 0); gl.uniform1i(u.uBloom, 1);
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uExposure, p.exposure);
    gl.uniform1f(u.uBloomAmt, p.bloom);
    gl.uniform1f(u.uVignette, p.vignette);
    this.fullscreen(null);
  };

  return {
    Renderer: Renderer,
    // выставлено наружу, чтобы тест мог посчитать поле теми же формулами
    splat: {
      K: SPLAT_K, EDGE: SPLAT_EDGE, STRETCH_CAP: STRETCH_CAP,
      ISO_FRAC: ISO_FRAC, COVER_LO: COVER_LO, COVER_HI: COVER_HI,
      weight: splatWeight, stretchOf: stretchOf,
      calibrate: function (dpPx, radiusPx) {
        var o = {};
        Renderer.prototype.calibrate.call(o, dpPx, radiusPx);
        return o;
      }
    }
  };
}));
