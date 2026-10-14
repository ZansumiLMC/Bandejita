/* =====================================================================
   Visor 3D de animaciones Blockbench (formato Bedrock)
   Bandejitaapaisaa · sección «Animaciones 3D»

   - Lee el modelo   (minecraft:geometry, format_version 1.12.0)
   - Lee animaciones (animations, format_version 1.8.0): keyframes con
     lerp_mode linear / catmullrom / step, valores Molang, poses fijas.
   - Three.js se carga solo al entrar en esta sección.
   ===================================================================== */
(function (global) {
  "use strict";

  /* ============================ CONFIGURACIÓN ============================ */
  var BASE = "assets/3d/";
  var CONFIG = {
    model: BASE + "models/character.geo.json",
    texture: BASE + "textures/skin.png", // opcional: si no existe se usa una textura provisional
    files: {
      a1: BASE + "animations/animaciones1.json",
      a2: BASE + "animations/animaciones2.json"
    },
    /* id: identificador interno · file: archivo · key: nombre REAL dentro del JSON */
    animations: [
      { id: "idle",   label: "Idle",        file: "a1", key: "idle" },
      { id: "walk",   label: "Walk",        file: "a1", key: "walk" },
      { id: "walk2",  label: "Walk2",       file: "a2", key: "walk" },
      { id: "sprint", label: "Sprint",      file: "a1", key: "sprint" },
      { id: "sleep",  label: "Emote Sleep", file: "a1", key: "emote.sleep" }
    ],
    defaultId: "idle",
    three: "https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js",
    orbit: "https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js",
    blendSeconds: 0.4
  };

  var PX = 1 / 16;               // 16 unidades Bedrock = 1 unidad de escena
  var DEG = Math.PI / 180;
  var STRIDE = 9;                // rot(3) + pos(3) + scale(3) por hueso
  var O_ROT = 0, O_POS = 3, O_SCL = 6;

  /* ============================== MOLANG ================================= */
  /* Evaluador propio (sin eval ni Function). Soporta lo que usa Blockbench:
     aritmética, math.*, query.life_time / anim_time, variable.*, ?:, &&, ||. */
  var MATH_FN = {
    sin: function (a) { return Math.sin(a[0] * DEG); },
    cos: function (a) { return Math.cos(a[0] * DEG); },
    tan: function (a) { return Math.tan(a[0] * DEG); },
    asin: function (a) { return Math.asin(a[0]) / DEG; },
    acos: function (a) { return Math.acos(a[0]) / DEG; },
    atan: function (a) { return Math.atan(a[0]) / DEG; },
    atan2: function (a) { return Math.atan2(a[0], a[1]) / DEG; },
    abs: function (a) { return Math.abs(a[0]); },
    sqrt: function (a) { return Math.sqrt(a[0]); },
    pow: function (a) { return Math.pow(a[0], a[1]); },
    exp: function (a) { return Math.exp(a[0]); },
    ln: function (a) { return Math.log(a[0]); },
    floor: function (a) { return Math.floor(a[0]); },
    ceil: function (a) { return Math.ceil(a[0]); },
    round: function (a) { return Math.round(a[0]); },
    trunc: function (a) { return Math.trunc(a[0]); },
    sign: function (a) { return Math.sign(a[0]); },
    min: function (a) { return Math.min(a[0], a[1]); },
    max: function (a) { return Math.max(a[0], a[1]); },
    clamp: function (a) { return Math.min(Math.max(a[0], a[1]), a[2]); },
    lerp: function (a) { return a[0] + (a[1] - a[0]) * a[2]; },
    mod: function (a) { return a[0] % a[1]; },
    random: function () { return 0.5; } // determinista
  };

  function tokenize(src) {
    var re = /\s*(?:(\d*\.?\d+(?:e[+-]?\d+)?)|([a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)*)|(<=|>=|==|!=|&&|\|\||[-+*\/(),?:<>!]))/gy;
    var out = [], m, last = 0;
    while (last < src.length) {
      re.lastIndex = last;
      m = re.exec(src);
      if (!m) {
        if (/^\s*$/.test(src.slice(last))) break;
        throw new Error("carácter inesperado en «" + src + "»");
      }
      last = re.lastIndex;
      if (m[1] !== undefined) out.push({ k: "n", v: parseFloat(m[1]) });
      else if (m[2] !== undefined) out.push({ k: "i", v: m[2] });
      else out.push({ k: "o", v: m[3] });
    }
    return out;
  }

  var molangCache = Object.create(null);

  function compileMolang(source) {
    var src = String(source).trim().toLowerCase().replace(/;+\s*$/, "");
    if (molangCache[src]) return molangCache[src];
    var toks = tokenize(src), pos = 0;

    function peek() { return toks[pos]; }
    function next() { return toks[pos++]; }
    function isOp(v) { var t = peek(); return t && t.k === "o" && t.v === v; }
    function expect(v) {
      var t = next();
      if (!t || t.v !== v) throw new Error("se esperaba «" + v + "» en «" + src + "»");
    }

    function ident(name) {
      var parts = name.split("."), ns = parts[0], rest = parts.slice(1).join(".");
      if (ns === "math" && rest === "pi") { return function () { return Math.PI; }; }
      if (ns === "query" || ns === "q") {
        if (rest === "life_time") return function (c) { return c.life; };
        if (rest === "anim_time") return function (c) { return c.anim; };
        return function () { return 0; }; // ground_speed, delta_time, etc.
      }
      if (ns === "variable" || ns === "v" || ns === "temp" || ns === "t") {
        return function (c) { return c.vars[rest] || 0; };
      }
      return function () { return 0; };
    }

    function call(name, args) {
      var parts = name.split(".");
      var fn = parts[0] === "math" ? MATH_FN[parts.slice(1).join(".")] : null;
      if (!fn) throw new Error("función Molang no soportada: " + name);
      return function (c) {
        var v = new Array(args.length);
        for (var i = 0; i < args.length; i++) v[i] = args[i](c);
        return fn(v);
      };
    }

    function primary() {
      var t = next();
      if (!t) throw new Error("expresión incompleta: «" + src + "»");
      if (t.k === "n") { var n = t.v; return function () { return n; }; }
      if (t.k === "i") {
        if (isOp("(")) {
          next();
          var args = [];
          if (!isOp(")")) {
            args.push(ternary());
            while (isOp(",")) { next(); args.push(ternary()); }
          }
          expect(")");
          return call(t.v, args);
        }
        return ident(t.v);
      }
      if (t.v === "(") { var e = ternary(); expect(")"); return e; }
      throw new Error("token inesperado «" + t.v + "» en «" + src + "»");
    }

    function unary() {
      if (isOp("-")) { next(); var a = unary(); return function (c) { return -a(c); }; }
      if (isOp("+")) { next(); return unary(); }
      if (isOp("!")) { next(); var b = unary(); return function (c) { return b(c) ? 0 : 1; }; }
      return primary();
    }

    function binary(sub, ops, mk) {
      return function () {
        var l = sub();
        while (peek() && peek().k === "o" && ops.indexOf(peek().v) >= 0) {
          var op = next().v, r = sub();
          l = mk(op, l, r);
        }
        return l;
      };
    }

    var mul = binary(unary, ["*", "/"], function (op, l, r) {
      return op === "*"
        ? function (c) { return l(c) * r(c); }
        : function (c) { var d = r(c); return d === 0 ? 0 : l(c) / d; };
    });
    var add = binary(mul, ["+", "-"], function (op, l, r) {
      return op === "+" ? function (c) { return l(c) + r(c); } : function (c) { return l(c) - r(c); };
    });
    var cmp = binary(add, ["<", ">", "<=", ">=", "==", "!="], function (op, l, r) {
      return function (c) {
        var a = l(c), b = r(c), v;
        switch (op) {
          case "<": v = a < b; break;
          case ">": v = a > b; break;
          case "<=": v = a <= b; break;
          case ">=": v = a >= b; break;
          case "==": v = a === b; break;
          default: v = a !== b;
        }
        return v ? 1 : 0;
      };
    });
    var and = binary(cmp, ["&&"], function (op, l, r) { return function (c) { return l(c) && r(c) ? 1 : 0; }; });
    var or = binary(and, ["||"], function (op, l, r) { return function (c) { return l(c) || r(c) ? 1 : 0; }; });
    function ternary() {
      var cond = or();
      if (isOp("?")) {
        next();
        var a = ternary();
        expect(":");
        var b = ternary();
        return function (c) { return cond(c) ? a(c) : b(c); };
      }
      return cond;
    }

    var fn = ternary();
    if (pos < toks.length) throw new Error("sobra texto en «" + src + "»");
    molangCache[src] = fn;
    return fn;
  }

  /* ===================== ANIMACIONES BLOCKBENCH / BEDROCK ================= */
  function compileVec(v, warn) {
    var arr = Array.isArray(v) ? v : [v, v, v]; // escalar = uniforme
    var out = [0, 0, 0], dyn = false;
    for (var i = 0; i < 3; i++) {
      var c = arr[i];
      if (c === undefined || c === null) { out[i] = 0; continue; }
      if (typeof c === "number") { out[i] = c; continue; }
      var n = Number(c);
      if (c !== "" && !isNaN(n)) { out[i] = n; continue; }
      try { out[i] = compileMolang(c); dyn = true; }
      catch (e) { warn.push(e.message); out[i] = 0; }
    }
    return { c: out, dyn: dyn };
  }

  function evalVec(vec, ctx, o) {
    for (var i = 0; i < 3; i++) {
      var c = vec.c[i];
      o[i] = typeof c === "function" ? c(ctx) : c;
    }
  }

  function compileTrack(raw, warn) {
    if (raw === undefined || raw === null) return null;
    if (Array.isArray(raw) || typeof raw === "number" || typeof raw === "string") {
      return { st: compileVec(raw, warn), keys: null };
    }
    if (typeof raw !== "object") return null;
    var keys = [];
    Object.keys(raw).forEach(function (k) {
      var t = parseFloat(k);
      if (isNaN(t)) return;
      var kv = raw[k], pre, post, mode = "linear";
      if (kv && typeof kv === "object" && !Array.isArray(kv)) {
        mode = kv.lerp_mode || "linear";
        post = kv.post !== undefined ? kv.post : kv.pre;
        pre = kv.pre !== undefined ? kv.pre : kv.post;
        if (post === undefined) return;
      } else { pre = post = kv; }
      var vPost = compileVec(post, warn);
      keys.push({ t: t, pre: pre === post ? vPost : compileVec(pre, warn), post: vPost, mode: mode });
    });
    if (!keys.length) return null;
    keys.sort(function (a, b) { return a.t - b.t; });
    return { st: null, keys: keys };
  }

  var CHANNELS = [["rotation", O_ROT], ["position", O_POS], ["scale", O_SCL]];

  function parseAnimation(key, raw) {
    var warn = [];
    var a = {
      key: key,
      loopMode: raw.loop === true ? "loop" : raw.loop === "hold_on_last_frame" ? "hold" : "once",
      length: Number(raw.animation_length) > 0 ? Number(raw.animation_length) : 0,
      tracks: [], keyed: false, dynamic: false, warnings: warn, wrapKeys: false
    };
    var maxT = 0;
    var bones = raw.bones || {};
    Object.keys(bones).forEach(function (bone) {
      CHANNELS.forEach(function (ch) {
        var tr = compileTrack(bones[bone][ch[0]], warn);
        if (!tr) return;
        if (tr.keys) {
          if (tr.keys.length > 1) a.keyed = true;
          maxT = Math.max(maxT, tr.keys[tr.keys.length - 1].t);
          tr.keys.forEach(function (k) { if (k.pre.dyn || k.post.dyn) a.dynamic = true; });
        } else if (tr.st.dyn) a.dynamic = true;
        a.tracks.push({ bone: bone, off: ch[1], tr: tr });
      });
    });
    if (!a.length && a.keyed) a.length = maxT;
    a.wrapKeys = a.loopMode === "loop" && a.length > 0 && Math.abs(maxT - a.length) <= 0.05 * a.length + 0.02;
    a.kind = a.keyed ? "keyframes" : a.dynamic ? "procedural" : "static";
    return a;
  }

  function catmull(p0, p1, p2, p3, t) {
    var v0 = (p2 - p0) * 0.5, v1 = (p3 - p1) * 0.5, t2 = t * t, t3 = t * t2;
    return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
  }

  var sA = [0, 0, 0], sB = [0, 0, 0], sP0 = [0, 0, 0], sP3 = [0, 0, 0], sOut = [0, 0, 0];

  function sampleTrack(a, tr, t, ctx, o) {
    if (!tr.keys) { evalVec(tr.st, ctx, o); return; }
    var k = tr.keys, n = k.length, i;
    if (n === 1 || t <= k[0].t) { evalVec(t < k[0].t ? k[0].pre : k[0].post, ctx, o); return; }
    if (t >= k[n - 1].t) { evalVec(k[n - 1].post, ctx, o); return; }
    i = 0;
    while (i < n - 2 && t >= k[i + 1].t) i++;
    var A = k[i], B = k[i + 1], f = (t - A.t) / (B.t - A.t);
    evalVec(A.post, ctx, sA);
    if (A.mode === "step") { o[0] = sA[0]; o[1] = sA[1]; o[2] = sA[2]; return; }
    evalVec(B.pre, ctx, sB);
    if (A.mode === "catmullrom" || B.mode === "catmullrom") {
      var wrap = a.wrapKeys && n > 2;
      var P0 = i > 0 ? k[i - 1] : (wrap ? k[n - 2] : A);
      var P3 = i + 2 < n ? k[i + 2] : (wrap ? k[1] : B);
      evalVec(P0.post, ctx, sP0);
      evalVec(P3.post, ctx, sP3);
      for (var j = 0; j < 3; j++) o[j] = catmull(sP0[j], sA[j], sB[j], sP3[j], f);
    } else {
      for (var q = 0; q < 3; q++) o[q] = sA[q] + (sB[q] - sA[q]) * f;
    }
  }

  function resetPose(out, count) {
    for (var i = 0; i < count; i++) {
      var o = i * STRIDE;
      out[o] = out[o + 1] = out[o + 2] = out[o + 3] = out[o + 4] = out[o + 5] = 0;
      out[o + 6] = out[o + 7] = out[o + 8] = 1;
    }
  }

  /* Rellena `out` con la pose (grados/píxeles Bedrock) de la animación en `time` segundos. */
  function sampleAnimation(a, time, boneIndex, boneCount, out) {
    resetPose(out, boneCount);
    var t = time;
    if (a.length > 0) t = a.loopMode === "loop" ? time % a.length : Math.min(time, a.length);
    var ctx = { life: time, anim: t, vars: {} };
    for (var i = 0; i < a.tracks.length; i++) {
      var tk = a.tracks[i], idx = boneIndex[tk.bone];
      if (idx === undefined) continue; // huesos que no existen en el modelo (p. ej. «martillo») se ignoran
      sampleTrack(a, tk.tr, t, ctx, sOut);
      var o = idx * STRIDE + tk.off;
      out[o] = sOut[0]; out[o + 1] = sOut[1]; out[o + 2] = sOut[2];
    }
  }

  /* ============================ MODELO BEDROCK ============================ */
  function parseGeometry(json) {
    var g = json && json["minecraft:geometry"] && json["minecraft:geometry"][0];
    if (!g || !Array.isArray(g.bones)) throw new Error("El archivo no contiene «minecraft:geometry» con huesos.");
    var d = g.description || {};
    var model = { tw: d.texture_width || 64, th: d.texture_height || 64, bones: [], byName: {}, index: {} };
    g.bones.forEach(function (b, i) {
      var p = b.pivot || [0, 0, 0];
      var rec = {
        name: b.name, parent: b.parent || null, index: i,
        pivotPx: [-p[0], p[1], p[2]],  // X espejado (convención Blockbench/Bedrock)
        rest: b.rotation || [0, 0, 0], cubes: b.cubes || [], base: [0, 0, 0]
      };
      model.bones.push(rec);
      model.byName[b.name] = rec;
      model.index[b.name] = i;
    });
    model.bones.forEach(function (r) {
      var par = r.parent && model.byName[r.parent];
      if (!par) r.parent = null;
      var pp = par ? par.pivotPx : [0, 0, 0];
      r.base = [(r.pivotPx[0] - pp[0]) * PX, (r.pivotPx[1] - pp[1]) * PX, (r.pivotPx[2] - pp[2]) * PX];
    });
    return model;
  }

  /* Rectángulos UV por cara. Admite UV por cara y UV de caja clásico. */
  function faceRects(c) {
    var out = {}, uv = c.uv, s = c.size;
    if (Array.isArray(uv)) {
      var u = uv[0], v = uv[1], sx = Math.floor(s[0]), sy = Math.floor(s[1]), sz = Math.floor(s[2]);
      out.north = { u: u + sz, v: v + sz, w: sx, h: sy };
      out.east = { u: u, v: v + sz, w: sz, h: sy };
      out.south = { u: u + sz + sx + sz, v: v + sz, w: sx, h: sy };
      out.west = { u: u + sz + sx, v: v + sz, w: sz, h: sy };
      out.up = { u: u + sz, v: v, w: sx, h: sz };
      out.down = { u: u + sz + sx, v: v + sz, w: sx, h: -sz };
    } else if (uv && typeof uv === "object") {
      ["north", "east", "south", "west", "up", "down"].forEach(function (f) {
        var fc = uv[f];
        if (fc && fc.uv) {
          var sz2 = fc.uv_size || [0, 0];
          out[f] = { u: fc.uv[0], v: fc.uv[1], w: sz2[0], h: sz2[1] };
        }
      });
    }
    return out;
  }

  /* Geometría de un cubo en coordenadas de escena, relativa al pivote del hueso.
     X se espeja. Las etiquetas east/west se mantienen sobre las caras +X/-X de escena,
     de modo que el lado «right» de la skin queda en el lado derecho del personaje. */
  function cubeData(c, pivotPx, tw, th) {
    var o = c.origin, s = c.size, inf = c.inflate || 0;
    var x0 = -(o[0] + s[0] + inf) - pivotPx[0], x1 = -(o[0] - inf) - pivotPx[0];
    var y0 = o[1] - inf - pivotPx[1], y1 = o[1] + s[1] + inf - pivotPx[1];
    var z0 = o[2] - inf - pivotPx[2], z1 = o[2] + s[2] + inf - pivotPx[2];
    var rects = faceRects(c);
    var pos = [], uvs = [], nor = [], idx = [];

    function face(corners, n, r, flip) {
      var base = pos.length / 3;
      for (var i = 0; i < 4; i++) {
        pos.push(corners[i][0] * PX, corners[i][1] * PX, corners[i][2] * PX);
        nor.push(n[0], n[1], n[2]);
      }
      var ua = r.u / tw, ub = (r.u + r.w) / tw, va = 1 - r.v / th, vb = 1 - (r.v + r.h) / th;
      uvs.push(ua, va, ub, va, ub, vb, ua, vb); // TL TR BR BL
      if (flip) idx.push(base, base + 2, base + 3, base, base + 1, base + 2);
      else idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
    }
    // Esquinas: [TL, TR, BR, BL] vistas desde fuera
    if (rects.north) face([[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]], [0, 0, -1], rects.north);
    if (rects.south) face([[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]], [0, 0, 1], rects.south);
    if (rects.east) face([[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]], [1, 0, 0], rects.east);
    if (rects.west) face([[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]], [-1, 0, 0], rects.west);
    if (rects.up) face([[x1, y1, z1], [x0, y1, z1], [x0, y1, z0], [x1, y1, z0]], [0, 1, 0], rects.up);
    if (rects.down) face([[x1, y0, z1], [x0, y0, z1], [x0, y0, z0], [x1, y0, z0]], [0, -1, 0], rects.down, true);
    return { pos: pos, uvs: uvs, nor: nor, idx: idx };
  }

  /* Aplica una pose (grados/píxeles Bedrock) a los grupos de Three.js.
     Convención Blockbench: rotación (-x, -y, +z) en orden ZYX; posición x invertida. */
  function applyPose(rig, pose) {
    var list = rig.list;
    for (var i = 0; i < list.length; i++) {
      var r = list[i], o = i * STRIDE, g = r.group, b = r.def;
      g.position.set(b.base[0] - pose[o + 3] * PX, b.base[1] + pose[o + 4] * PX, b.base[2] + pose[o + 5] * PX);
      g.rotation.set(
        -(pose[o] + b.rest[0]) * DEG,
        -(pose[o + 1] + b.rest[1]) * DEG,
        (pose[o + 2] + b.rest[2]) * DEG,
        "ZYX"
      );
      g.scale.set(pose[o + 6], pose[o + 7], pose[o + 8]);
    }
  }

  function ease(t) { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); }

  /* ============================== UTILIDADES ============================== */
  var scriptCache = Object.create(null);
  function loadScript(url) {
    if (scriptCache[url]) return scriptCache[url];
    var p = new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = url; s.async = true;
      s.onload = resolve;
      s.onerror = function () { s.remove(); delete scriptCache[url]; reject(new Error("No se pudo descargar " + url)); };
      document.head.appendChild(s);
    });
    scriptCache[url] = p;
    return p;
  }
  function loadThree() {
    if (global.THREE && global.THREE.OrbitControls) return Promise.resolve();
    return loadScript(CONFIG.three).then(function () { return loadScript(CONFIG.orbit); });
  }
  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error("«" + url + "» respondió HTTP " + r.status + ". Comprueba que el archivo existe en esa ruta.");
      return r.json().catch(function () { throw new Error("«" + url + "» no es un JSON válido."); });
    }, function () {
      throw new Error("No se pudo leer «" + url + "». Si abriste index.html directamente desde el disco, sírvelo con un servidor local o súbelo al hosting.");
    });
  }
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("sin textura")); };
      img.src = url;
    });
  }
  function fmt(n) { return n.toLocaleString("es", { maximumFractionDigits: 2 }); }

  var ICON = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
    restart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/></svg>',
    view: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/><circle cx="12" cy="12" r="2.5"/></svg>'
  };

  /* =============================== VISOR ================================== */
  function createViewer(root) {
    var T = null, renderer, scene, camera, controls, modelGroup, rig, floor, lights = [];
    var dead = false, visible = true, raf = 0, lastT = 0, lastRender = 0;
    var io = null, ro = null, texture = null, material = null;
    var anims = {};            // id -> { cfg, anim, meta, error }
    var nb = 0;
    var poseNew, poseOut, lastPose, poseFrom;
    var lastLift = 0;
    var reduced = !!(global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches);
    var st = { cur: null, time: 0, playing: true, speed: 1, blend: 1, blendDur: CONFIG.blendSeconds, fromLift: 0 };
    var focusTween = null, viewTween = null, hintHidden = false;
    var ui = {}, notes = [];
    var DEFAULT_OFFSET = [1.7, 0.55, -4.1];

    /* ---------- Interfaz ---------- */
    function buildUI() {
      root.innerHTML =
        '<div class="v3d-stage" id="v3dStage">' +
          '<div class="v3d-now" id="v3dNow" aria-live="polite"><span class="v3d-dot" aria-hidden="true"></span><b id="v3dNowName">Idle</b><small id="v3dNowState"></small></div>' +
          '<p class="v3d-hint" id="v3dHint">Arrastra para girar. Usa la rueda o pellizca para acercar.</p>' +
          '<div class="v3d-ov" id="v3dLoad" role="status"><div class="v3d-sp" aria-hidden="true"></div><span>Cargando personaje y animaciones…</span></div>' +
          '<div class="v3d-ov v3d-err" id="v3dErr" role="alert" hidden><h3>No se pudo cargar el visor</h3><p id="v3dErrMsg"></p><button class="v3d-b" id="v3dRetry" type="button">Reintentar</button></div>' +
        '</div>' +
        '<aside class="v3d-panel" aria-label="Controles del visor">' +
          '<h3>Animaciones</h3>' +
          '<div class="v3d-list" id="v3dList" role="group" aria-label="Seleccionar animación"></div>' +
          '<div class="v3d-ctl">' +
            '<button class="v3d-b p" id="v3dPlay" type="button" disabled></button>' +
            '<button class="v3d-b" id="v3dRestart" type="button" disabled>' + ICON.restart + 'Reiniciar</button>' +
            '<button class="v3d-b" id="v3dView" type="button" disabled>' + ICON.view + 'Vista</button>' +
          '</div>' +
          '<div class="v3d-speed"><label for="v3dSpeed">Velocidad</label><output id="v3dSpeedOut" for="v3dSpeed">1×</output>' +
            '<input id="v3dSpeed" type="range" min="0.25" max="2" step="0.05" value="1" aria-valuetext="1×"></div>' +
          '<p class="note" id="v3dNote" hidden></p>' +
        '</aside>';
      var q = function (id) { return root.querySelector("#" + id); };
      ui.stage = q("v3dStage"); ui.now = q("v3dNow"); ui.nowName = q("v3dNowName"); ui.nowState = q("v3dNowState");
      ui.hint = q("v3dHint"); ui.load = q("v3dLoad"); ui.err = q("v3dErr"); ui.errMsg = q("v3dErrMsg");
      ui.retry = q("v3dRetry"); ui.list = q("v3dList"); ui.play = q("v3dPlay"); ui.restart = q("v3dRestart");
      ui.view = q("v3dView"); ui.speed = q("v3dSpeed"); ui.speedOut = q("v3dSpeedOut"); ui.note = q("v3dNote");

      CONFIG.animations.forEach(function (cfg) {
        var b = document.createElement("button");
        b.type = "button"; b.className = "v3d-it"; b.id = "v3d-it-" + cfg.id; b.disabled = true;
        b.setAttribute("aria-pressed", "false");
        b.innerHTML = "<b></b><small>Cargando…</small>";
        b.firstChild.textContent = cfg.label;
        b.addEventListener("click", function () { select(cfg.id); });
        ui.list.appendChild(b);
      });
      ui.play.innerHTML = ICON.pause + "Pausar";
      ui.play.addEventListener("click", togglePlay);
      ui.restart.addEventListener("click", restart);
      ui.view.addEventListener("click", resetView);
      ui.speed.addEventListener("input", function () {
        st.speed = parseFloat(ui.speed.value);
        var t = fmt(st.speed) + "×";
        ui.speedOut.textContent = t; ui.speed.setAttribute("aria-valuetext", t);
      });
      ui.retry.addEventListener("click", function () { global.Anim3D.mount(root); });
    }

    function subtitle(a) {
      if (!a.anim) return a.error ? "No disponible" : "Cargando…";
      var k = a.anim;
      if (k.kind === "keyframes") return fmt(k.length) + " s, keyframes";
      if (k.kind === "procedural") return "Ciclo procedural";
      return "Pose fija";
    }

    function refreshList() {
      CONFIG.animations.forEach(function (cfg) {
        var a = anims[cfg.id], b = ui.list.querySelector("#v3d-it-" + cfg.id);
        b.disabled = !(a && a.anim);
        b.querySelector("small").textContent = subtitle(a || {});
        if (a && a.error) b.title = a.error;
        b.setAttribute("aria-pressed", st.cur === cfg.id ? "true" : "false");
      });
    }

    function refreshTransport() {
      var on = !!st.cur;
      ui.play.disabled = ui.restart.disabled = ui.view.disabled = !on;
      ui.play.innerHTML = (st.playing ? ICON.pause + "Pausar" : ICON.play + "Reproducir");
      if (st.cur) {
        ui.nowName.textContent = anims[st.cur].cfg.label;
        ui.nowState.textContent = st.playing ? "Reproduciendo" : "En pausa";
        ui.now.classList.toggle("on", st.playing);
      }
      refreshList();
    }

    function showError(msg) {
      if (dead) return;
      ui.load.hidden = true;
      ui.errMsg.textContent = msg;
      ui.err.hidden = false;
    }

    /* ---------- Carga ---------- */
    function init() {
      buildUI();
      if (!global.WebGLRenderingContext) { showError("Tu navegador no admite WebGL, necesario para el visor 3D."); return Promise.resolve(); }

      var results = {};
      var fileIds = Object.keys(CONFIG.files);
      var jobs = [
        loadThree().then(function () { return true; }),
        fetchJSON(CONFIG.model).then(function (j) { results.model = j; })
      ];
      var filePromises = fileIds.map(function (id) {
        return fetchJSON(CONFIG.files[id]).then(
          function (j) { results[id] = { json: j }; },
          function (e) { results[id] = { error: e.message }; }
        );
      });

      return Promise.all(jobs.concat(filePromises)).then(function () {
        if (dead) return;
        T = global.THREE;
        var parsed = parseGeometry(results.model);
        return loadImage(CONFIG.texture).then(function (img) { return { img: img }; }, function () { return { img: null }; })
          .then(function (tex) {
            if (dead) return;
            setupScene(parsed, tex.img);
            registerAnimations(results, parsed);
            startViewer();
          });
      }).catch(function (e) {
        showError(e && e.message ? e.message : "Error desconocido al preparar el visor.");
      });
    }

    function registerAnimations(results, parsed) {
      var problems = [];
      CONFIG.animations.forEach(function (cfg) {
        var rec = { cfg: cfg, anim: null, meta: null, error: null };
        anims[cfg.id] = rec;
        var f = results[cfg.file];
        if (!f || f.error) { rec.error = f ? f.error : "Archivo no cargado."; problems.push(cfg.label + ": " + rec.error); return; }
        var raw = f.json && f.json.animations && f.json.animations[cfg.key];
        if (!raw) { rec.error = "No existe «" + cfg.key + "» en " + CONFIG.files[cfg.file]; problems.push(cfg.label + ": " + rec.error); return; }
        try {
          rec.anim = parseAnimation(cfg.key, raw);
          rec.meta = analyze(rec.anim);
        } catch (e) { rec.anim = null; rec.error = e.message; problems.push(cfg.label + ": " + e.message); }
      });
      if (problems.length) notes.push("Algunas animaciones no se pudieron cargar. " + problems.join(" "));
      if (notes.length) { ui.note.hidden = false; ui.note.textContent = notes.join(" "); }
    }

    function makeFallbackTexture(parsed) {
      var c = document.createElement("canvas");
      c.width = parsed.tw; c.height = parsed.th;
      var x = c.getContext("2d");
      var col = { skin: "#c99673", shirt: "#2f8f9d", pants: "#3b3f8f", shoe: "#4a4d57", hair: "#4a3220" };
      function vol(cb) { return cb.size[0] * cb.size[1] * cb.size[2]; }
      function paint(r, color) {
        x.fillStyle = color;
        x.fillRect(Math.floor(Math.min(r.u, r.u + r.w)), Math.floor(Math.min(r.v, r.v + r.h)), Math.ceil(Math.abs(r.w)), Math.ceil(Math.abs(r.h)));
      }
      function colorFor(n) {
        if (/^head/.test(n) || /hand/.test(n)) return col.skin;
        if (/foot/.test(n)) return col.shoe;
        if (/leg/.test(n)) return col.pants;
        return col.shirt;
      }
      parsed.bones.forEach(function (b) {
        if (!b.cubes.length) return;
        var inner = b.cubes.reduce(function (m, cb) { return vol(cb) < vol(m) ? cb : m; });
        var rects = faceRects(inner), f;
        for (f in rects) paint(rects[f], colorFor(b.name));
        if (/^head/.test(b.name) && rects.north) {
          var n = rects.north;
          paint(rects.up, col.hair);
          paint({ u: n.u, v: n.v, w: n.w, h: 2 }, col.hair);
          ["east", "west"].forEach(function (s) { paint({ u: rects[s].u, v: rects[s].v, w: rects[s].w, h: 3 }, col.hair); });
          paint({ u: rects.south.u, v: rects.south.v, w: rects.south.w, h: 7 }, col.hair);
          paint({ u: n.u + 1, v: n.v + 4, w: 1, h: 1 }, "#ffffff");
          paint({ u: n.u + 6, v: n.v + 4, w: 1, h: 1 }, "#ffffff");
          paint({ u: n.u + 2, v: n.v + 4, w: 1, h: 1 }, "#3a2f6b");
          paint({ u: n.u + 5, v: n.v + 4, w: 1, h: 1 }, "#3a2f6b");
          paint({ u: n.u + 3, v: n.v + 6, w: 2, h: 1 }, "#8a4b3d");
        }
      });
      return c;
    }

    function setupScene(parsed, img) {
      renderer = new T.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
      renderer.setClearColor(0x000000, 0);
      renderer.outputEncoding = T.sRGBEncoding;
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = T.PCFSoftShadowMap;
      var cv = renderer.domElement;
      cv.setAttribute("aria-label", "Personaje 3D interactivo. Arrastra para girar la cámara.");
      cv.setAttribute("role", "img");
      ui.stage.insertBefore(cv, ui.stage.firstChild);
      cv.addEventListener("webglcontextlost", function (e) { e.preventDefault(); showError("Se perdió el contexto gráfico del navegador."); });

      scene = new T.Scene();
      camera = new T.PerspectiveCamera(32, 1, 0.1, 50);

      /* Iluminación */
      var hemi = new T.HemisphereLight(0xcfe0ff, 0x1a2542, 0.85);
      var key = new T.DirectionalLight(0xffffff, 1.5);
      key.position.set(2.2, 4.2, -3); key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      var sc = key.shadow.camera; sc.left = -2.4; sc.right = 2.4; sc.top = 2.8; sc.bottom = -2.4; sc.near = 0.5; sc.far = 12; sc.updateProjectionMatrix();
      key.shadow.bias = -0.0004; key.shadow.normalBias = 0.02;
      var fill = new T.DirectionalLight(0x77b7ff, 0.45); fill.position.set(-3, 1.8, -2);
      var rim = new T.DirectionalLight(0x4c8dff, 1.1); rim.position.set(0.5, 2.6, 3.6);
      lights = [hemi, key, fill, rim];
      lights.forEach(function (l) { scene.add(l); });

      /* Suelo */
      floor = new T.Mesh(
        new T.CircleGeometry(1.9, 64).rotateX(-Math.PI / 2),
        new T.MeshStandardMaterial({ color: 0x0e1a31, roughness: 0.85, metalness: 0.05 })
      );
      floor.position.y = -0.002; floor.receiveShadow = true;
      var ring = new T.Mesh(
        new T.RingGeometry(1.87, 1.9, 96).rotateX(-Math.PI / 2),
        new T.MeshBasicMaterial({ color: 0x4c8dff, transparent: true, opacity: 0.55 })
      );
      ring.position.y = 0.001;
      scene.add(floor, ring);

      /* Textura */
      if (img) { texture = new T.Texture(img); }
      else {
        texture = new T.CanvasTexture(makeFallbackTexture(parsed));
        notes.push("Se muestra una textura provisional. Coloca tu skin PNG en assets/3d/textures/skin.png.");
      }
      texture.encoding = T.sRGBEncoding;
      texture.magFilter = T.NearestFilter;
      texture.minFilter = T.NearestFilter;   // píxeles nítidos, sin mipmaps que difuminen
      texture.generateMipmaps = false;
      texture.anisotropy = 1;
      texture.needsUpdate = true;
      material = new T.MeshStandardMaterial({ map: texture, alphaTest: 0.5, roughness: 0.92, metalness: 0 });

      /* Rig */
      modelGroup = new T.Group();
      rig = buildRig(parsed);
      modelGroup.add(rig.root);
      scene.add(modelGroup);
      nb = parsed.bones.length;
      poseNew = new Float32Array(nb * STRIDE);
      poseOut = new Float32Array(nb * STRIDE);
      lastPose = new Float32Array(nb * STRIDE);
      poseFrom = new Float32Array(nb * STRIDE);
      resetPose(lastPose, nb);

      /* Cámara */
      controls = new T.OrbitControls(camera, cv);
      controls.enableDamping = true; controls.dampingFactor = 0.09;
      controls.enablePan = false;
      controls.minDistance = 2.4; controls.maxDistance = 8;
      controls.minPolarAngle = 0.2; controls.maxPolarAngle = Math.PI / 2 - 0.01;
      controls.rotateSpeed = 0.8;
      controls.addEventListener("start", function () { if (!hintHidden) { hintHidden = true; ui.hint.classList.add("off"); } });
      controls.addEventListener("change", requestRender);
      controls.target.set(0, 1, 0);
      camera.position.set(DEFAULT_OFFSET[0], 1 + DEFAULT_OFFSET[1], DEFAULT_OFFSET[2]);
      controls.update();
    }

    function buildRig(parsed) {
      var rootG = new T.Group(), list = [], byName = {};
      parsed.bones.forEach(function (b) {
        var g = new T.Group(); g.name = b.name;
        var rec = { def: b, group: g };
        list.push(rec); byName[b.name] = rec;
      });
      list.forEach(function (r) {
        var b = r.def;
        (b.parent ? byName[b.parent].group : rootG).add(r.group);
        r.group.position.set(b.base[0], b.base[1], b.base[2]);
        b.cubes.forEach(function (cb) {
          var d = cubeData(cb, b.pivotPx, parsed.tw, parsed.th);
          var geo = new T.BufferGeometry();
          geo.setAttribute("position", new T.Float32BufferAttribute(d.pos, 3));
          geo.setAttribute("normal", new T.Float32BufferAttribute(d.nor, 3));
          geo.setAttribute("uv", new T.Float32BufferAttribute(d.uvs, 2));
          geo.setIndex(d.idx);
          geo.computeBoundingBox();
          var m = new T.Mesh(geo, material);
          m.castShadow = true; m.receiveShadow = true;
          r.group.add(m);
        });
      });
      return { root: rootG, list: list, byName: byName, index: parsed.index };
    }

    /* Recorre la animación para obtener altura mínima (evita hundirse en el suelo)
       y el punto de enfoque de la cámara. No modifica los datos de la animación. */
    function analyze(anim) {
      if (!rig) return { lift: 0, focus: { x: 0, y: 1, z: 0 } };
      var steps = anim.kind === "static" ? 1 : 24;
      var span = anim.length > 0 ? anim.length : 1.5;
      var tmp = new Float32Array(nb * STRIDE);
      var minY = Infinity, cx = 0, cy = 0, cz = 0, c8 = [new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3(), new T.Vector3()];
      modelGroup.position.y = 0;
      for (var s = 0; s < steps; s++) {
        sampleAnimation(anim, (s / steps) * span, rig.index, nb, tmp);
        applyPose(rig, tmp);
        rig.root.updateMatrixWorld(true);
        var lo = Infinity, hi = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        rig.list.forEach(function (r) {
          r.group.children.forEach(function (m) {
            if (!m.isMesh) return;
            var bb = m.geometry.boundingBox;
            for (var i = 0; i < 8; i++) {
              c8[i].set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z).applyMatrix4(m.matrixWorld);
              lo = Math.min(lo, c8[i].y); hi = Math.max(hi, c8[i].y);
              x0 = Math.min(x0, c8[i].x); x1 = Math.max(x1, c8[i].x);
              z0 = Math.min(z0, c8[i].z); z1 = Math.max(z1, c8[i].z);
            }
          });
        });
        minY = Math.min(minY, lo);
        cx += (x0 + x1) / 2; cy += (lo + hi) / 2; cz += (z0 + z1) / 2;
      }
      var lift = Math.max(0, -minY);
      return { lift: lift, focus: { x: cx / steps, y: Math.min(1.15, Math.max(0.3, cy / steps + lift)), z: cz / steps } };
    }

    /* ---------- Reproducción ---------- */
    function snapshot(dur) {
      poseFrom.set(lastPose);
      st.fromLift = lastLift;
      st.blend = 0; st.blendDur = reduced ? 0.01 : dur;
    }

    function select(id) {
      var a = anims[id];
      if (!a || !a.anim || id === st.cur) return;
      if (st.cur) snapshot(CONFIG.blendSeconds);
      st.cur = id; st.time = 0; st.playing = true;
      startFocus(a.meta.focus);
      refreshTransport();
      requestRender();
    }

    function togglePlay() {
      st.playing = !st.playing;
      refreshTransport();
      requestRender();
    }

    function restart() {
      if (!st.cur) return;
      snapshot(0.2);
      st.time = 0;
      requestRender();
    }

    function startFocus(f) {
      var from = controls.target.clone();
      focusTween = { from: from, to: new T.Vector3(f.x, f.y, f.z), prev: from.clone(), t: 0, dur: reduced ? 0.01 : 0.7 };
    }

    function resetView() {
      if (!st.cur) return;
      var f = anims[st.cur].meta.focus;
      var toTarget = new T.Vector3(f.x, f.y, f.z);
      var toOff = new T.Vector3(DEFAULT_OFFSET[0], DEFAULT_OFFSET[1], DEFAULT_OFFSET[2]);
      var fromOff = camera.position.clone().sub(controls.target);
      var s0 = new T.Spherical().setFromVector3(fromOff), s1 = new T.Spherical().setFromVector3(toOff);
      var dth = s1.theta - s0.theta;
      dth = Math.atan2(Math.sin(dth), Math.cos(dth));
      viewTween = { s0: s0, s1: s1, dth: dth, fromT: controls.target.clone(), toT: toTarget, t: 0, dur: reduced ? 0.01 : 0.7 };
      focusTween = null;
      requestRender();
    }

    function poseAndApply() {
      var a = anims[st.cur];
      sampleAnimation(a.anim, st.time, rig.index, nb, poseNew);
      var lift = a.meta.lift;
      if (st.blend < 1) {
        var w = ease(st.blend);
        for (var i = 0; i < poseOut.length; i++) poseOut[i] = poseFrom[i] + (poseNew[i] - poseFrom[i]) * w;
        lift = st.fromLift + (lift - st.fromLift) * w;
      } else poseOut.set(poseNew);
      applyPose(rig, poseOut);
      modelGroup.position.y = lift;
      lastPose.set(poseOut);
      lastLift = lift;
    }

    /* ---------- Bucle de render ---------- */
    function frame(now) {
      raf = 0;
      if (dead || !visible || document.hidden || !st.cur) return;
      if (now - lastRender < 14) { raf = requestAnimationFrame(frame); return; }
      var dt = Math.min(0.1, Math.max(0, (now - lastT) / 1000));
      lastT = now; lastRender = now;
      var busy = false;

      if (st.playing) { st.time += dt * st.speed; busy = true; }
      if (st.blend < 1) { st.blend = Math.min(1, st.blend + dt / st.blendDur); busy = true; }

      if (focusTween) {
        focusTween.t = Math.min(1, focusTween.t + dt / focusTween.dur);
        var p = new T.Vector3().lerpVectors(focusTween.from, focusTween.to, ease(focusTween.t));
        var delta = p.clone().sub(focusTween.prev);
        camera.position.add(delta); controls.target.add(delta);
        focusTween.prev = p;
        if (focusTween.t >= 1) focusTween = null;
        busy = true;
      }
      if (viewTween) {
        viewTween.t = Math.min(1, viewTween.t + dt / viewTween.dur);
        var e = ease(viewTween.t), v = viewTween;
        var tgt = new T.Vector3().lerpVectors(v.fromT, v.toT, e);
        var sp = new T.Spherical(
          v.s0.radius + (v.s1.radius - v.s0.radius) * e,
          v.s0.phi + (v.s1.phi - v.s0.phi) * e,
          v.s0.theta + v.dth * e
        );
        controls.target.copy(tgt);
        camera.position.copy(tgt).add(new T.Vector3().setFromSpherical(sp));
        if (v.t >= 1) viewTween = null;
        busy = true;
      }

      poseAndApply();
      if (controls.update()) busy = true;
      renderer.render(scene, camera);
      if (busy) raf = requestAnimationFrame(frame);
    }

    function requestRender() {
      if (raf || dead || !visible || document.hidden || !st.cur || !renderer) return;
      lastT = performance.now();
      raf = requestAnimationFrame(frame);
    }

    function resize() {
      if (dead || !renderer) return;
      var r = ui.stage.getBoundingClientRect();
      var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
      renderer.setPixelRatio(Math.min(global.devicePixelRatio || 1, 2.5));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      requestRender();
    }

    function onVisibility() { if (!document.hidden) requestRender(); }

    function startViewer() {
      var startId = anims[CONFIG.defaultId] && anims[CONFIG.defaultId].anim ? CONFIG.defaultId :
        (CONFIG.animations.filter(function (c) { return anims[c.id].anim; })[0] || {}).id;
      if (!startId) { showError("No se pudo cargar ninguna animación."); return; }
      st.cur = startId;
      st.playing = !reduced;
      var f = anims[startId].meta.focus;
      var off = camera.position.clone().sub(controls.target);
      controls.target.set(f.x, f.y, f.z);
      camera.position.copy(controls.target).add(off);
      controls.update();
      ui.load.hidden = true;
      refreshTransport();
      resize();

      if ("ResizeObserver" in global) { ro = new ResizeObserver(resize); ro.observe(ui.stage); }
      else global.addEventListener("resize", resize);
      if ("IntersectionObserver" in global) {
        io = new IntersectionObserver(function (entries) {
          visible = entries[0].isIntersecting;
          if (visible) requestRender();
        }, { threshold: 0.01 });
        io.observe(ui.stage);
      }
      document.addEventListener("visibilitychange", onVisibility);
      requestRender();
    }

    /* ---------- Limpieza ---------- */
    function destroy() {
      if (dead) return;
      dead = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (io) io.disconnect();
      if (ro) ro.disconnect();
      global.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibility);
      if (controls) controls.dispose();
      if (scene) {
        scene.traverse(function (o) {
          if (o.geometry) o.geometry.dispose();
          if (o.material && o.material !== material) o.material.dispose();
        });
      }
      if (material) material.dispose();
      if (texture) texture.dispose();
      if (renderer) {
        renderer.dispose();
        if (renderer.forceContextLoss) renderer.forceContextLoss();
        if (renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      renderer = scene = camera = controls = rig = null;
    }

    return { init: init, destroy: destroy };
  }

  /* =============================== API ==================================== */
  var current = null;
  var api = {
    mount: function (root) {
      if (!root) return Promise.resolve();
      api.destroy();
      current = createViewer(root);
      return current.init();
    },
    destroy: function () {
      if (current) { current.destroy(); current = null; }
    },
    _core: {
      compileMolang: compileMolang, parseAnimation: parseAnimation, sampleAnimation: sampleAnimation,
      parseGeometry: parseGeometry, cubeData: cubeData, faceRects: faceRects, CONFIG: CONFIG, STRIDE: STRIDE, PX: PX, DEG: DEG
    }
  };
  global.Anim3D = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
