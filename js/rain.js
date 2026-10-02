// Rain on the window. Drops are simulated on the CPU (pinning, sliding,
// merging, trails) and rendered into a height field; a WebGL2 pass then
// refracts the city photo through that height field, so every drop shows a
// tiny upside-down view of the scene like a real one does. Mist on the glass
// is a blurred copy of the scene that sliding drops wipe clear.
(function () {
    'use strict';

    const canvas = document.getElementById('rain');
    const backgroundEl = document.querySelector('.background');
    const glowCanvas = document.getElementById('city-glow');
    if (!canvas || !backgroundEl) return;

    const gl = canvas.getContext('webgl2', {
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false
    });
    if (!gl || !(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'))) return;

    // Sizes are CSS px, times are seconds.
    const CFG = {
        dropRate: 16,          // drops hitting the glass, per second per 1e6 px²
        dropletRate: 1300,     // fine mist droplets, per second per 1e6 px²
        dropMin: 1.2,
        dropMax: 8,
        dropletMin: 0.45,
        dropletMax: 1.9,
        slideRadius: 5.7,      // around this size gravity beats surface pinning
        gravity: 1100,
        drag: 3.4,
        sweep: 0.05,           // water picked up per px² a sliding drop sweeps
        evaporate: 0.2,        // small drops shrink faster, so the glass never saturates
        maxDrops: 1200,
        fogCenter: 0.08,       // mist density in the middle of the glass
        fogEdge: 0.55,         // ...and towards the frame
        refogTime: 14,         // how long a wiped trail takes to mist over
        dropletLife: 45,
        refraction: 0.9,       // how wide a view each drop sees, × screen height
        blur: 9,               // how strongly the mist blurs the city
        warmup: 14,            // simulated seconds before the first frame
        parallax: 0.012,       // how far the city shifts behind the glass, × screen size
        wipeRadius: 18,        // cursor / finger wiping the mist
        sound: false           // synthesised placeholder; hidden until there's a real recording
    };

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const photo = new Image();
    photo.src = './images/bg-dark.jpg';

    // ---------- shaders ----------

    const FULLSCREEN_VS = `#version 300 es
        out vec2 vUv;
        void main() {
            vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
            vUv = p;
            gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
        }`;

    // One instanced quad per drop; writes the drop's height in device px.
    const DROP_VS = `#version 300 es
        layout(location = 0) in vec2 aCorner;
        layout(location = 1) in vec4 aDrop;   // x, y, rx, ry
        layout(location = 2) in vec4 aShape;  // taper, wobble, contour phase, height ratio
        layout(location = 3) in vec4 aShape2; // lean along the path, second contour phase
        uniform vec2 uView;
        out vec2 vLocal;
        flat out vec4 vShape;
        flat out vec2 vShape2;
        flat out float vRadius;
        void main() {
            vLocal = aCorner * vec2(1.25 + 1.25 * abs(aShape2.x), 1.25);
            vShape = aShape;
            vShape2 = aShape2.xy;
            vRadius = min(aDrop.z, aDrop.w);
            vec2 clip = (aDrop.xy + vLocal * aDrop.zw) / uView * 2.0 - 1.0;
            gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        }`;

    const DROP_FS = `#version 300 es
        precision highp float;
        in vec2 vLocal;
        flat in vec4 vShape;
        flat in vec2 vShape2;
        flat in float vRadius;
        uniform float uScale;
        out vec4 outColor;
        void main() {
            vec2 p = vLocal;
            // sliding drops lean along their path, with the tail trailing behind,
            // and are narrower above their centre (y points down)
            p.x -= vShape2.x * p.y;
            p.x *= 1.0 + vShape.x * max(-p.y, 0.0);
            float a = atan(p.y, p.x + 1e-6);
            float k = 1.0 + vShape.y * (0.6 * cos(2.0 * a + vShape.z) + 0.4 * cos(3.0 * a + vShape2.y));
            float d2 = dot(p, p) / (k * k);
            if (d2 >= 1.0) discard;
            // gravity pulls the bulk of the water towards the bottom edge
            float sag = 1.0 + 0.3 * clamp(vLocal.y, -1.0, 1.0);
            outColor = vec4(vShape.w * vRadius * uScale * sqrt(1.0 - d2) * sag, 0.0, 0.0, 1.0);
        }`;

    // Capsule from a drop's last position to its new one; clears mist and droplets.
    const WIPE_VS = `#version 300 es
        layout(location = 0) in vec2 aCorner;
        layout(location = 1) in vec4 aSeg;    // ax, ay, bx, by
        layout(location = 2) in vec2 aParams; // radius, strength
        uniform vec2 uView;
        out vec2 vPos;
        flat out vec4 vSeg;
        flat out vec2 vParams;
        void main() {
            vec2 lo = min(aSeg.xy, aSeg.zw) - aParams.x;
            vec2 hi = max(aSeg.xy, aSeg.zw) + aParams.x;
            vPos = mix(lo, hi, aCorner * 0.5 + 0.5);
            vSeg = aSeg;
            vParams = aParams;
            vec2 clip = vPos / uView * 2.0 - 1.0;
            gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
        }`;

    const WIPE_FS = `#version 300 es
        precision highp float;
        in vec2 vPos;
        flat in vec4 vSeg;
        flat in vec2 vParams;
        out vec4 outColor;
        void main() {
            vec2 pa = vPos - vSeg.xy;
            vec2 ba = vSeg.zw - vSeg.xy;
            float t = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
            float d = length(pa - ba * t);
            outColor = vec4(0.0, 0.0, 0.0, (1.0 - smoothstep(vParams.x * 0.55, vParams.x, d)) * vParams.y);
        }`;

    // Wet state: R = droplet height (slowly evaporates), G = mist (creeps back).
    const UPDATE_FS = `#version 300 es
        precision highp float;
        in vec2 vUv;
        uniform sampler2D uPrev;
        uniform float uDecay;
        uniform float uRefog;
        uniform vec2 uFog;   // centre, edge
        uniform float uAspect;
        uniform vec2 uSeed;
        out vec4 outColor;
        float hash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += dot(p, p + 45.32);
            return fract(p.x * p.y);
        }
        float noise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
                       mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
        }
        void main() {
            vec2 w = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0).rg;
            vec2 c = vUv - 0.5;
            c.x *= uAspect;
            vec2 q = vec2(vUv.x * uAspect, vUv.y) * 3.0 + uSeed;
            float n = 0.55 * noise(q) + 0.3 * noise(q * 2.3) + 0.15 * noise(q * 5.1);
            // denser towards the frame and the sill, patchy everywhere
            float edge = smoothstep(0.35, 0.95, length(c * vec2(0.8, 1.25)));
            float sill = smoothstep(0.45, 0.0, vUv.y);
            float fogTarget = mix(uFog.x, uFog.y, max(edge, sill * 0.9)) * (0.55 + 0.9 * n);
            outColor = vec4(w.r * uDecay, mix(w.g, fogTarget, uRefog), 0.0, 1.0);
        }`;

    const BLUR_FS = `#version 300 es
        precision highp float;
        in vec2 vUv;
        uniform sampler2D uSrc;
        uniform vec2 uStep;
        uniform float uLod;
        uniform float uSigma;
        out vec4 outColor;
        void main() {
            vec4 sum = vec4(0.0);
            float total = 0.0;
            for (int i = -8; i <= 8; i++) {
                float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
                sum += textureLod(uSrc, vUv + uStep * float(i), uLod) * w;
                total += w;
            }
            outColor = sum / total;
        }`;

    const COMPOSITE_FS = `#version 300 es
        precision highp float;
        in vec2 vUv;
        uniform sampler2D uScene;
        uniform sampler2D uBlur;
        uniform sampler2D uDrops;
        uniform sampler2D uWet;
        uniform vec2 uRes;
        uniform float uRefract;
        uniform vec2 uShift;   // parallax: where the city sits behind the glass
        uniform float uZoom;
        out vec4 outColor;
        float heightAt(ivec2 p) {
            p = clamp(p, ivec2(0), ivec2(uRes) - 1);
            return max(texelFetch(uDrops, p, 0).r, texelFetch(uWet, p, 0).r);
        }
        void main() {
            ivec2 p = ivec2(gl_FragCoord.xy);
            float h = heightAt(p);
            vec2 slope = 0.5 * vec2(heightAt(p + ivec2(1, 0)) - heightAt(p - ivec2(1, 0)),
                                    heightAt(p + ivec2(0, 1)) - heightAt(p - ivec2(0, 1)));
            float steep = length(slope);

            // Each drop is a small lens: it shows an inverted, shrunken view of
            // the city around it. Mipmapping keeps that view from shimmering.
            vec2 sceneUv = (vUv - 0.5 - uShift) / uZoom + 0.5;
            vec2 offset = slope * (1.0 + 0.8 * steep * steep) * uRefract / uRes / uZoom;
            vec3 refr = vec3(texture(uScene, sceneUv + offset * 1.02).r,
                             texture(uScene, sceneUv + offset).g,
                             texture(uScene, sceneUv + offset * 0.98).b);
            refr *= 1.15;
            // light hitting the steep rim is mostly reflected back into the dark room
            refr *= 1.0 - 0.85 * smoothstep(0.7, 1.6, steep);
            vec3 n = normalize(vec3(-slope * 1.4, 1.0));
            refr += 0.12 * pow(max(dot(n, normalize(vec3(-0.35, 0.6, 1.0))), 0.0), 60.0);

            float fog = clamp(texelFetch(uWet, p, 0).g, 0.0, 1.0);
            vec3 haze = texture(uBlur, sceneUv).rgb * 1.12 + vec3(0.010, 0.016, 0.020);
            vec4 color = mix(vec4(haze, 1.0) * fog, vec4(refr, 1.0), smoothstep(0.0, 0.45, h));

            float dither = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
            color.rgb += dither / 255.0 * color.a;
            outColor = color;
        }`;

    function compile(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
    }

    function program(vs, fs) {
        const p = gl.createProgram();
        gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
        gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
        const uniforms = {};
        const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < n; i++) {
            const name = gl.getActiveUniform(p, i).name;
            uniforms[name] = gl.getUniformLocation(p, name);
        }
        return { p, u: uniforms };
    }

    let progs;
    try {
        progs = {
            drop: program(DROP_VS, DROP_FS),
            wipe: program(WIPE_VS, WIPE_FS),
            update: program(FULLSCREEN_VS, UPDATE_FS),
            blur: program(FULLSCREEN_VS, BLUR_FS),
            composite: program(FULLSCREEN_VS, COMPOSITE_FS)
        };
    } catch (e) {
        console.warn('rain disabled:', e.message);
        return;
    }

    // ---------- geometry ----------

    const emptyVao = gl.createVertexArray();
    const cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    function instancedVao(layout) {
        const vao = gl.createVertexArray();
        const buf = gl.createBuffer();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        const stride = layout.reduce((a, b) => a + b, 0) * 4;
        let offset = 0;
        layout.forEach((size, i) => {
            gl.enableVertexAttribArray(i + 1);
            gl.vertexAttribPointer(i + 1, size, gl.FLOAT, false, stride, offset);
            gl.vertexAttribDivisor(i + 1, 1);
            offset += size * 4;
        });
        gl.bindVertexArray(null);
        return { vao, buf, floats: stride / 4 };
    }

    const spriteGeo = instancedVao([4, 4, 4]);
    const wipeGeo = instancedVao([4, 2]);

    function drawInstances(geo, data) {
        const count = data.length / geo.floats;
        if (!count) return;
        gl.bindVertexArray(geo.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, geo.buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }

    function drawFullscreen() {
        gl.bindVertexArray(emptyVao);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ---------- render targets ----------

    function texture(w, h, internal, format, type, filter) {
        const t = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return t;
    }

    function target(w, h, kind) {
        // Half floats keep slopes smooth; fall back to RGBA16F where narrower formats aren't renderable.
        const formats = kind === 'rgba8' ? [[gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE]]
            : [[kind === 'r' ? gl.R16F : gl.RG16F, kind === 'r' ? gl.RED : gl.RG, gl.HALF_FLOAT], [gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT]];
        for (const [internal, format, type] of formats) {
            const tex = texture(w, h, internal, format, type, kind === 'rgba8' ? gl.LINEAR : gl.NEAREST);
            const fb = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) return { tex, fb, w, h };
            gl.deleteFramebuffer(fb);
            gl.deleteTexture(tex);
        }
        throw new Error('no renderable float format');
    }

    function freeTarget(t) {
        if (!t) return;
        gl.deleteFramebuffer(t.fb);
        gl.deleteTexture(t.tex);
    }

    // ---------- state ----------

    let W = 0, H = 0, scale = 1, width = 0, height = 0;
    let sceneTex = null, blurA = null, blurB = null, dropsRT = null, wetA = null, wetB = null;
    let drops = [];
    let wipes = [];
    let spawns = [];
    let dropAcc = 0, dropletAcc = 0, pendingDt = 0, clock = 0;
    // When each 6 px cell was last run over; drops prefer glass that's already wet.
    const CELL = 6;
    let wetGrid = new Float32Array(0), gridW = 0, gridH = 0;
    let raf = 0, last = 0, ready = false, failed = false;
    // Set from the settings panel: how hard it rains, how readily drops run.
    let rainAmount = 1, flow = 1;
    // Parallax and wiping are opt-in from the panel. The city's shift is -1..1
    // of CFG.parallax, scaled by depth, which eases in and out with the toggle;
    // the photo zooms by the same amount so the shift never reveals its edges.
    let parallaxOn = false, wipeOn = true, depth = 0;
    const shift = { x: 0, y: 0, tx: 0, ty: 0 };
    let lastPointer = null;
    const impacts = []; // x, radius of drops that landed this frame, for the sound
    const noiseSeed = [Math.random() * 1000, Math.random() * 1000];

    function hash(x, y) {
        let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
        h = Math.imul(h ^ (h >>> 13), 1274126177);
        return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }

    function noise(x, y) {
        x += noiseSeed[0];
        y += noiseSeed[1];
        const xi = Math.floor(x), yi = Math.floor(y);
        const u = x - xi, v = y - yi;
        const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
        const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
        return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
    }

    // ---------- simulation ----------

    function wetness(x, y) {
        const gx = Math.floor(x / CELL), gy = Math.floor(y / CELL);
        if (gx < 0 || gy < 0 || gx >= gridW || gy >= gridH) return 0;
        return Math.max(0, 1 - (clock - wetGrid[gy * gridW + gx]) / CFG.refogTime);
    }

    function markWet(d) {
        const y0 = Math.max(0, Math.floor((d.y - d.ry) / CELL)), y1 = Math.min(gridH - 1, Math.floor(d.y / CELL));
        const x0 = Math.max(0, Math.floor((d.x - d.rx * 0.8) / CELL)), x1 = Math.min(gridW - 1, Math.floor((d.x + d.rx * 0.8) / CELL));
        for (let gy = y0; gy <= y1; gy++) {
            for (let gx = x0; gx <= x1; gx++) wetGrid[gy * gridW + gx] = clock;
        }
    }

    function addDrop(x, y, r) {
        if (drops.length >= CFG.maxDrops) return;
        drops.push({
            x, y, r, vx: 0, vy: 0, rx: r, ry: r, stretch: 0, spread: 0.3, seed: Math.random(), travel: 0, nextTrail: r,
            heading: 0, headingTarget: (Math.random() - 0.5) * 0.3, nextSnag: 20 + 90 * Math.random(), morph: 0, dead: false
        });
        impacts.push(x, r);
        wipes.push(x, y, x, y, r * 0.8, 1);
    }

    function addDroplet(x, y, r, ratio) {
        spawns.push(x, y, r, r, 0, 0.05, Math.random() * 6.2832, ratio, 0, Math.random() * 6.2832, 0, 0);
    }

    function randomDropRadius() {
        return CFG.dropMin + (CFG.dropMax - CFG.dropMin) * Math.pow(Math.random(), 2.6);
    }

    function randomDropletRadius() {
        return CFG.dropletMin + (CFG.dropletMax - CFG.dropletMin) * Math.pow(Math.random(), 3);
    }

    function merge(a, b) {
        const ma = a.r * a.r * a.r, mb = b.r * b.r * b.r, m = ma + mb;
        a.x = (a.x * ma + b.x * mb) / m;
        a.y = (a.y * ma + b.y * mb) / m;
        a.vy = (a.vy * ma + b.vy * mb) / m;
        a.r = Math.cbrt(m);
        a.spread = Math.min(0.35, a.spread + 0.06 + 0.3 * mb / m);
        b.dead = true;
        wipes.push(b.x, b.y, b.x, b.y, b.r * 0.8, 1);
    }

    function collide() {
        const cell = 40;
        const grid = new Map();
        for (const d of drops) {
            if (d.dead) continue;
            const cx = Math.floor(d.x / cell), cy = Math.floor(d.y / cell);
            for (let gx = cx - 1; gx <= cx + 1; gx++) {
                for (let gy = cy - 1; gy <= cy + 1; gy++) {
                    const bucket = grid.get(gx * 73856093 ^ gy * 19349663);
                    if (!bucket) continue;
                    for (const o of bucket) {
                        if (o.dead || d.dead) continue;
                        const dx = o.x - d.x, dy = o.y - d.y, reach = (o.r + d.r) * 0.82;
                        if (dx * dx + dy * dy < reach * reach) {
                            if (o.r >= d.r) merge(o, d); else merge(d, o);
                        }
                    }
                }
            }
            if (d.dead) continue;
            const key = cx * 73856093 ^ cy * 19349663;
            if (!grid.has(key)) grid.set(key, []);
            grid.get(key).push(d);
        }
    }

    function step(dt) {
        const area = W * H / 1e6;
        clock += dt;
        // rain comes in gusts rather than at a steady rate
        const gust = 0.35 + 1.3 * noise(clock * 0.07, 7.5);
        dropAcc += CFG.dropRate * rainAmount * gust * area * dt;
        for (; dropAcc >= 1; dropAcc--) addDrop(Math.random() * W, Math.random() * H, randomDropRadius());
        dropletAcc += CFG.dropletRate * rainAmount * gust * area * dt;
        for (; dropletAcc >= 1; dropletAcc--) addDroplet(Math.random() * W, Math.random() * H, randomDropletRadius(), 0.5);

        for (const d of drops) {
            if (d.dead) continue;
            const x0 = d.x, y0 = d.y;
            // Gravity scales with volume, pinning with contact line; the glass
            // is uneven, so drops near the threshold move in stops and starts.
            // A recent trail ahead means less pinning and less drag.
            const ahead = d.y + d.ry + 2;
            const wet = wetness(d.x, ahead);
            const pin = CFG.slideRadius * flow * (0.7 + 0.6 * noise(d.x / 14, d.y / 14)) * (1 - 0.4 * wet);
            const drive = 1 - (pin * pin) / (d.r * d.r);
            if (drive > 0) d.vy += CFG.gravity * drive * dt;
            const drag = drive > 0 ? CFG.drag * (0.5 + 1.4 * noise(d.x / 9 + 20, d.y / 9)) * (1 - 0.45 * wet) : 16;
            d.vy -= d.vy * Math.min(1, drag * dt);
            if (d.vy < 2 && drive <= 0) d.vy = 0;
            if (d.vy > 0) {
                // Runs are mostly straight and kink where the glass snags the drop,
                // rather than swaying smoothly; recent trails pull them in.
                const pull = wetness(d.x + d.rx, ahead) - wetness(d.x - d.rx, ahead);
                d.heading += (d.headingTarget + 0.5 * pull - d.heading) * Math.min(1, dt * 14);
                d.vx = d.vy * d.heading;
                d.x += d.vx * dt;
                d.y += d.vy * dt;
                const moved = Math.hypot(d.x - x0, d.y - y0);
                d.morph += moved / 25;
                d.nextSnag -= moved;
                if (d.nextSnag <= 0) {
                    // it hesitates, squashes against the snag and sets off at a new
                    // angle; heavier drops get knocked off course less
                    const kick = (Math.random() < 0.3 ? 0.55 : 0.18) * (1.2 - 0.6 * Math.min(1, d.r / 12));
                    d.headingTarget = Math.max(-0.6, Math.min(0.6, 0.45 * d.headingTarget + (Math.random() * 2 - 1) * kick));
                    d.vy *= 1 - (0.1 + 0.35 * Math.random()) * (1.2 - 0.6 * Math.min(1, d.r / 12));
                    d.spread = Math.min(0.35, d.spread + 0.1);
                    d.nextSnag = 20 + 90 * Math.random();
                }
                d.r = Math.cbrt(d.r * d.r * d.r + CFG.sweep * 2 * d.r * moved);
                // Shed small droplets from the tail as the drop runs.
                d.travel += moved;
                while (d.travel >= d.nextTrail && d.r > 1.5) {
                    d.travel -= d.nextTrail;
                    d.nextTrail = d.r * (0.8 + Math.random());
                    const t = 1 - d.travel / Math.max(moved, 1e-3);
                    const rt = Math.max(0.5, d.r * (0.14 + 0.16 * Math.random()));
                    const tx = x0 + (d.x - x0) * t - d.heading * (d.ry + rt * 1.3) + (Math.random() - 0.5) * d.rx * 0.5;
                    const ty = y0 + (d.y - y0) * t - d.ry - rt * 1.3;
                    addDroplet(tx, ty, rt, 0.45);
                    d.r = Math.cbrt(Math.max(0.1, d.r * d.r * d.r - rt * rt * rt));
                }
            }
            d.r -= CFG.evaporate * dt / d.r;
            if (d.vy === 0) d.heading *= Math.exp(-dt * 4);
            const sp = Math.min(1, d.vy / 260);
            d.stretch += (sp - d.stretch) * Math.min(1, dt * 8);
            d.spread *= Math.exp(-dt * 9);
            d.rx = d.r * (1 + d.spread - 0.12 * d.stretch);
            d.ry = d.r * (1 - 0.5 * d.spread + 0.35 * d.stretch);
            if (d.vy > 0) {
                wipes.push(x0, y0, d.x, d.y, d.rx * 0.9, 1);
                markWet(d);
            }
            if (d.y - d.ry > H + 4 || d.r < 0.6) d.dead = true;
        }
        collide();
        drops = drops.filter((d) => !d.dead);
    }

    // ---------- rendering ----------

    function setBlendMax() {
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.MAX);
    }

    function flushWet(settle) {
        const u = progs.update.u;
        gl.disable(gl.BLEND);
        gl.colorMask(true, true, true, true);
        gl.bindFramebuffer(gl.FRAMEBUFFER, wetB.fb);
        gl.viewport(0, 0, width, height);
        gl.useProgram(progs.update.p);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, wetA.tex);
        gl.uniform1i(u.uPrev, 0);
        gl.uniform1f(u.uDecay, Math.exp(-pendingDt / CFG.dropletLife));
        gl.uniform1f(u.uRefog, settle ? 1 : 1 - Math.exp(-pendingDt / CFG.refogTime));
        gl.uniform2f(u.uFog, CFG.fogCenter, CFG.fogEdge);
        gl.uniform1f(u.uAspect, W / H);
        gl.uniform2f(u.uSeed, noiseSeed[0] % 50, noiseSeed[1] % 50);
        drawFullscreen();
        [wetA, wetB] = [wetB, wetA];
        pendingDt = 0;

        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
        gl.colorMask(true, true, false, false);
        gl.useProgram(progs.wipe.p);
        gl.uniform2f(progs.wipe.u.uView, W, H);
        drawInstances(wipeGeo, wipes);
        wipes = [];

        setBlendMax();
        gl.colorMask(true, false, false, false);
        gl.useProgram(progs.drop.p);
        gl.uniform2f(progs.drop.u.uView, W, H);
        gl.uniform1f(progs.drop.u.uScale, scale);
        drawInstances(spriteGeo, spawns);
        spawns = [];
        gl.colorMask(true, true, true, true);
    }

    function render() {
        flushWet();

        const data = [];
        for (const d of drops) {
            // still drops keep a fixed uneven outline; running ones keep reshaping as they go
            const wobble = 0.07 * Math.min(1, d.r / 5) * (1 - d.stretch) + 0.045 * d.stretch;
            const lean = Math.max(-0.8, Math.min(0.8, d.heading * d.ry / d.rx));
            data.push(d.x, d.y, d.rx, d.ry, 0.4 * d.stretch, wobble, d.seed * 6.2832 + d.morph, 0.46 - 0.1 * Math.min(1, d.r / 14),
                lean, d.seed * 10.68 + d.morph * 1.6, 0, 0);
        }
        gl.bindFramebuffer(gl.FRAMEBUFFER, dropsRT.fb);
        gl.viewport(0, 0, width, height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        setBlendMax();
        gl.useProgram(progs.drop.p);
        gl.uniform2f(progs.drop.u.uView, W, H);
        gl.uniform1f(progs.drop.u.uScale, scale);
        drawInstances(spriteGeo, data);

        gl.disable(gl.BLEND);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, width, height);
        const u = progs.composite.u;
        gl.useProgram(progs.composite.p);
        [sceneTex, blurB.tex, dropsRT.tex, wetA.tex].forEach((t, i) => {
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, t);
        });
        gl.uniform1i(u.uScene, 0);
        gl.uniform1i(u.uBlur, 1);
        gl.uniform1i(u.uDrops, 2);
        gl.uniform1i(u.uWet, 3);
        gl.uniform2f(u.uRes, width, height);
        gl.uniform1f(u.uRefract, CFG.refraction * height);
        gl.uniform2f(u.uShift, shift.x * CFG.parallax * depth, -shift.y * CFG.parallax * depth);
        gl.uniform1f(u.uZoom, sceneZoom());
        drawFullscreen();
    }

    function blurPass(src, dst, stepX, stepY, lod, sigma) {
        const u = progs.blur.u;
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb);
        gl.viewport(0, 0, dst.w, dst.h);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, src);
        gl.uniform1i(u.uSrc, 0);
        gl.uniform2f(u.uStep, stepX, stepY);
        gl.uniform1f(u.uLod, lod);
        gl.uniform1f(u.uSigma, sigma);
        drawFullscreen();
    }

    function drawCover(ctx, img, w, h) {
        const s = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        const sw = img.naturalWidth * s, sh = img.naturalHeight * s;
        ctx.drawImage(img, (w - sw) / 2, (h - sh) / 2, sw, sh);
    }

    // The scene behind the glass: the photo plus the warm glow layer, exactly
    // as the page draws them, with a blurred copy for the misted glass.
    function uploadScene() {
        const c = document.createElement('canvas');
        c.width = width;
        c.height = height;
        const ctx = c.getContext('2d');
        drawCover(ctx, photo, width, height);
        if (glowCanvas && glowCanvas.style.opacity === '1' && glowCanvas.width > 1) {
            ctx.drawImage(glowCanvas, 0, 0, width, height);
        }
        if (!sceneTex) sceneTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, sceneTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, c);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);

        gl.disable(gl.BLEND);
        gl.useProgram(progs.blur.p);
        const sigma = CFG.blur * scale / 4 / Math.SQRT2;
        blurPass(sceneTex, blurA, 1 / blurA.w, 0, 2, sigma);
        blurPass(blurA.tex, blurB, 0, 1 / blurB.h, 0, sigma);
        blurPass(blurB.tex, blurA, 1 / blurA.w, 0, 0, sigma);
        blurPass(blurA.tex, blurB, 0, 1 / blurB.h, 0, sigma);
    }

    // Start with glass that has been out in the rain for a while.
    function warmup() {
        const area = W * H / 1e6;
        for (let i = CFG.dropletRate * rainAmount * area * 18; i > 0; i--) {
            addDroplet(Math.random() * W, Math.random() * H, randomDropletRadius(), 0.5 * Math.random());
        }
        for (let i = CFG.dropRate * rainAmount * area * 10; i > 0; i--) addDrop(Math.random() * W, Math.random() * H, randomDropRadius());
        flushWet(true);
        const dt = 1 / 30;
        for (let t = 0; t < CFG.warmup; t += dt) {
            step(dt);
            pendingDt += dt;
            if (pendingDt >= 0.5) flushWet();
        }
        impacts.length = 0;
    }

    function resize() {
        if (failed || !photo.naturalWidth) return;
        const rect = backgroundEl.getBoundingClientRect();
        const w = Math.max(1, rect.width), h = Math.max(1, rect.height);
        // Full device resolution up to ~6 MP; beyond that the GPU cost isn't worth it.
        const s = Math.min(Math.max(1, Math.min(2, window.devicePixelRatio || 1)), Math.sqrt(6e6 / (w * h)));
        const pw = Math.round(w * s), ph = Math.round(h * s);
        if (pw === width && ph === height) {
            uploadScene();
            if (reducedMotion) render();
            return;
        }
        W = w; H = h; scale = s; width = pw; height = ph;
        canvas.width = width;
        canvas.height = height;
        canvas.style.width = W + 'px';
        canvas.style.height = H + 'px';
        [blurA, blurB, dropsRT, wetA, wetB].forEach(freeTarget);
        const bw = Math.max(1, Math.round(width / 4)), bh = Math.max(1, Math.round(height / 4));
        try {
            blurA = target(bw, bh, 'rgba8');
            blurB = target(bw, bh, 'rgba8');
            dropsRT = target(width, height, 'r');
            wetA = target(width, height, 'rg');
            wetB = target(width, height, 'rg');
            // Throws on file:// pages, where the browser won't let WebGL read the photo.
            uploadScene();
        } catch (e) {
            console.warn('rain disabled:', e.message);
            failed = true;
            cancelAnimationFrame(raf);
            canvas.style.opacity = '0';
            return;
        }
        drops = [];
        wipes = [];
        spawns = [];
        gridW = Math.ceil(W / CELL);
        gridH = Math.ceil(H / CELL);
        wetGrid = new Float32Array(gridW * gridH).fill(-1e6);
        warmup();
        if (!reducedMotion) applyParallax();
        render();
        canvas.style.opacity = '1';
        ready = true;
        if (settingsToggle && !reducedMotion) settingsToggle.hidden = false;
        if (!reducedMotion) {
            cancelAnimationFrame(raf);
            last = performance.now();
            raf = requestAnimationFrame(frame);
        }
    }

    function frame(now) {
        const dt = Math.max(0, Math.min(0.05, (now - last) / 1000));
        last = now;
        step(dt);
        pendingDt += dt;
        const ease = 1 - Math.exp(-dt * 3);
        shift.x += (shift.tx - shift.x) * ease;
        shift.y += (shift.ty - shift.y) * ease;
        depth += ((parallaxOn ? 1 : 0) - depth) * ease;
        applyParallax();
        if (sound) playSound();
        impacts.length = 0;
        render();
        raf = requestAnimationFrame(frame);
    }

    // ---------- settings panel ----------

    const settingsToggle = document.getElementById('rain-toggle');
    const settingsPanel = document.getElementById('rain-settings');
    const amountInput = document.getElementById('rain-amount');
    const flowInput = document.getElementById('rain-flow');

    function readSettings() {
        // 50 means the CFG rates: rain runs from dry to ~3x, flow from calm to streaming.
        // The page starts from the slider values in the HTML.
        rainAmount = Math.pow(amountInput.value / 50, 1.6);
        flow = Math.pow(1.3, (50 - flowInput.value) / 50);
    }

    // Panel settings are remembered per browser, so a reload (phones drop
    // pages in the background) doesn't put them back to the defaults.
    const STORE_KEY = 'rain-settings';

    function loadSettings() {
        try {
            return JSON.parse(localStorage.getItem(STORE_KEY)) || {};
        } catch (e) {
            return {};
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify({
                rain: amountInput.value, flow: flowInput.value, parallax: parallaxOn, wipe: wipeOn
            }));
        } catch (e) { }
    }

    // An on/off pill button; aria-pressed holds the state.
    function bindSwitch(id, initial, onChange) {
        const button = document.getElementById(id);
        if (!button) return;
        const show = (on) => {
            button.setAttribute('aria-pressed', String(on));
            button.textContent = on ? 'on' : 'off';
        };
        show(initial);
        onChange(initial);
        button.addEventListener('click', () => {
            const on = button.getAttribute('aria-pressed') !== 'true';
            show(on);
            onChange(on);
            saveSettings();
        });
    }

    function setPanelOpen(open) {
        settingsPanel.hidden = !open;
        settingsToggle.setAttribute('aria-expanded', String(open));
    }

    if (settingsToggle && settingsPanel && amountInput && flowInput) {
        const saved = loadSettings();
        if (saved.rain !== undefined) amountInput.value = saved.rain;
        if (saved.flow !== undefined) flowInput.value = saved.flow;
        readSettings();
        amountInput.addEventListener('input', readSettings);
        flowInput.addEventListener('input', readSettings);
        amountInput.addEventListener('change', saveSettings);
        flowInput.addEventListener('change', saveSettings);
        bindSwitch('rain-parallax', saved.parallax === true, (on) => {
            parallaxOn = on;
            shift.tx = 0;
            shift.ty = 0;
        });
        bindSwitch('rain-wipe', saved.wipe !== false, (on) => {
            wipeOn = on;
        });
        const soundButton = document.getElementById('rain-sound');
        if (soundButton && CFG.sound && (window.AudioContext || window.webkitAudioContext)) {
            soundButton.closest('.rain-setting').hidden = false;
            bindSwitch('rain-sound', false, setSound);
        }
        settingsToggle.addEventListener('click', () => setPanelOpen(settingsPanel.hidden));
        document.addEventListener('pointerdown', (e) => {
            if (!settingsPanel.hidden && !settingsPanel.contains(e.target) && !settingsToggle.contains(e.target)) setPanelOpen(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape' || settingsPanel.hidden) return;
            setPanelOpen(false);
            settingsToggle.focus();
        });
    }

    // ---------- parallax & wiping ----------

    const sceneLayers = [backgroundEl, glowCanvas, document.getElementById('city-lights')].filter(Boolean);

    function sceneZoom() {
        return 1 + (2 * CFG.parallax + 0.004) * depth;
    }

    function applyParallax() {
        if (!parallaxOn && depth < 0.001) {
            // fully eased out: leave the layers exactly as the page draws them
            depth = 0;
            if (sceneLayers[0].style.transform) for (const el of sceneLayers) el.style.transform = '';
            return;
        }
        const t = 'translate3d(' + (shift.x * CFG.parallax * depth * W).toFixed(2) + 'px, ' +
            (shift.y * CFG.parallax * depth * H).toFixed(2) + 'px, 0) scale(' + sceneZoom().toFixed(5) + ')';
        for (const el of sceneLayers) el.style.transform = t;
    }

    // The pointer stands in for where you're looking: the city drifts the other
    // way, and (with wiping on) the pointer wipes a path through the mist.
    function onPointerMove(e) {
        if (!ready || reducedMotion || !e.isPrimary) return;
        if (parallaxOn) {
            shift.tx = 1 - 2 * e.clientX / W;
            shift.ty = 1 - 2 * e.clientY / H;
        }
        const from = lastPointer || { x: e.clientX, y: e.clientY };
        lastPointer = { x: e.clientX, y: e.clientY };
        if (!wipeOn) return;
        const radius = CFG.wipeRadius * (e.pointerType === 'mouse' ? 1 : 1.3);
        wipes.push(from.x, from.y, e.clientX, e.clientY, radius, 1);
        // the wiped water beads up along both edges of the path
        const dx = e.clientX - from.x, dy = e.clientY - from.y, len = Math.hypot(dx, dy);
        for (let t = 0; t < len; t += 3) {
            for (const side of [-1, 1]) {
                if (Math.random() < 0.35) continue;
                const off = side * radius * (0.95 + 0.2 * Math.random());
                addDroplet(from.x + dx * t / len - dy / len * off, from.y + dy * t / len + dx / len * off,
                    0.5 + 1.1 * Math.random() * Math.random(), 0.5);
            }
        }
    }

    function releasePointer() {
        lastPointer = null;
        shift.tx = 0;
        shift.ty = 0;
    }

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerdown', (e) => {
        if (e.pointerType !== 'mouse') onPointerMove(e);
    });
    window.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'mouse') releasePointer();
    });
    window.addEventListener('pointercancel', releasePointer);
    document.documentElement.addEventListener('pointerleave', releasePointer);

    // Phones that report tilt without asking (Android) shift with it too; the
    // resting angle slowly follows the phone so it re-centres when you settle.
    let tiltBase = null;
    window.addEventListener('deviceorientation', (e) => {
        if (!ready || reducedMotion || !parallaxOn || lastPointer || e.beta === null || e.gamma === null) return;
        if (!tiltBase) tiltBase = { beta: e.beta, gamma: e.gamma };
        tiltBase.beta += (e.beta - tiltBase.beta) * 0.003;
        tiltBase.gamma += (e.gamma - tiltBase.gamma) * 0.003;
        shift.tx = Math.max(-1, Math.min(1, (tiltBase.gamma - e.gamma) / 15));
        shift.ty = Math.max(-1, Math.min(1, (tiltBase.beta - e.beta) / 15));
    });

    // ---------- sound ----------

    // A synthesised stand-in until there's a real recording: filtered noise for
    // the wash of rain, plus a short tap for each drop that lands, panned to
    // where it hit.
    function createRainSound(ctx) {
        const rate = ctx.sampleRate, len = rate * 4, fade = rate * 0.5;
        const noise = ctx.createBuffer(2, len, rate);
        for (let ch = 0; ch < 2; ch++) {
            // pink noise (Paul Kellet's filter), with the end crossfaded into the
            // start so the loop has no seam
            const raw = new Float32Array(len + fade);
            let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
            for (let i = 0; i < raw.length; i++) {
                const white = Math.random() * 2 - 1;
                b0 = 0.99886 * b0 + white * 0.0555179;
                b1 = 0.99332 * b1 + white * 0.0750759;
                b2 = 0.969 * b2 + white * 0.153852;
                b3 = 0.8665 * b3 + white * 0.3104856;
                b4 = 0.55 * b4 + white * 0.5329522;
                b5 = -0.7616 * b5 - white * 0.016898;
                raw[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
                b6 = white * 0.115926;
            }
            const data = noise.getChannelData(ch);
            for (let i = 0; i < len; i++) {
                const a = i < fade ? i / fade : 1;
                data[i] = raw[i] * Math.sqrt(a) + (i < fade ? raw[len + i] * Math.sqrt(1 - a) : 0);
            }
        }

        const master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);

        function bed(type, freq, q, level) {
            const src = ctx.createBufferSource();
            src.buffer = noise;
            src.loop = true;
            const filter = ctx.createBiquadFilter();
            filter.type = type;
            filter.frequency.value = freq;
            filter.Q.value = q;
            const gain = ctx.createGain();
            gain.gain.value = level;
            src.connect(filter).connect(gain).connect(master);
            src.start(0, Math.random() * 4);
        }
        bed('lowpass', 900, 0.5, 0.9);    // the body of the rain
        bed('bandpass', 4500, 0.6, 0.22); // fine hiss of small drops

        return {
            level(value, when) {
                master.gain.setTargetAtTime(value, when, 0.35);
            },
            tap(when, pan, size) {
                const src = ctx.createBufferSource();
                src.buffer = noise;
                const filter = ctx.createBiquadFilter();
                filter.type = 'bandpass';
                filter.frequency.value = 1800 + 3200 * Math.random();
                filter.Q.value = 1.5 + 3 * Math.random();
                const gain = ctx.createGain();
                gain.gain.setValueAtTime(0, when);
                gain.gain.linearRampToValueAtTime(0.05 + 0.25 * size, when + 0.002);
                gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.03 + 0.05 * size);
                const panner = ctx.createStereoPanner();
                panner.pan.value = pan;
                src.connect(filter).connect(gain).connect(panner).connect(master);
                src.start(when, Math.random() * 3.5, 0.12);
            }
        };
    }

    let audioCtx = null, sound = null, soundOn = false, soundLevelAt = 0;

    function playSound() {
        const now = audioCtx.currentTime;
        if (now - soundLevelAt > 0.1) {
            soundLevelAt = now;
            const gust = 0.35 + 1.3 * noise(clock * 0.07, 7.5);
            sound.level(soundOn ? 0.5 * Math.pow(rainAmount * gust, 0.6) : 0, now);
        }
        if (!soundOn) return;
        // a handful of taps per frame at most, spread so they don't land together
        for (let i = 0; i < Math.min(impacts.length, 8); i += 2) {
            const size = Math.min(1, impacts[i + 1] / CFG.dropMax);
            sound.tap(now + Math.random() * 0.016, impacts[i] / W * 1.6 - 0.8, size);
        }
    }

    function setSound(on) {
        soundOn = on;
        if (on && !audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            sound = createRainSound(audioCtx);
        }
        if (on) {
            audioCtx.resume();
        } else if (audioCtx) {
            // let the fade-out finish, then stop the audio thread
            setTimeout(() => {
                if (!soundOn) audioCtx.suspend();
            }, 1500);
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (!audioCtx) return;
        if (document.hidden) audioCtx.suspend();
        else if (soundOn) audioCtx.resume();
    });

    let resizeTimer = 0;
    window.addEventListener('resize', () => {
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(resize, 150);
    });
    if (glowCanvas) {
        glowCanvas.addEventListener('rendered', () => {
            if (ready) resize();
        });
    }
    if (photo.complete && photo.naturalWidth) resize();
    else photo.addEventListener('load', resize);
})();
