/* Compare Sesh — two swing videos, side by side.
     • Playback: each panel has its own play/pause button (play A alone, or B
       alone), PLUS one big shared button that plays/pauses BOTH together.
       Speed and the scrub bar stay shared — the scrub seeks each clip to the
       SAME FRACTION of its own duration (not the same absolute time), which
       is also useful for lining the two up even when only one is playing.
     • Drawing: no "which panel" mode. Both canvases are always live together;
       whichever one you touch is the one that gets the mark — the browser's
       own pointer targeting already resolves that, no routing needed. Tool
       and color are shared (pick a color once, draw with it on either
       video); Undo/Clear are per-panel since there's no single "current"
       panel to route a shared Undo/Clear to.

   The per-panel canvas math (DPR-aware sizing, pen/eraser/line/circle,
   nearest-stroke eraser hit-test) is the exact same logic as review.js,
   factored into makePanel() so it isn't duplicated by hand for A and B. */
(function () {
  var root = document.querySelector('.review-wrap[data-page="review-compare"]');
  if (!root) return;

  var PLAYBACK_RATES = [1, 0.5, 0.25, 0.125];
  var RATE_LABELS = { 1: '1×', 0.5: '½×', 0.25: '¼×', 0.125: '⅛×' };
  var PEN_COLORS = ['#ffd60a', '#e63946', '#4a9eff', '#7aab78', '#ffffff'];
  var PEN_WIDTH = 4;
  var HIT_PX = 14;

  var controlsEl = document.getElementById('compare-controls');
  var playBtn = document.getElementById('compare-playbtn');
  var scrubEl = document.getElementById('compare-scrub');
  var scrubFill = document.getElementById('compare-scrub-fill');
  var timeAEl = document.getElementById('compare-time-a');
  var timeBEl = document.getElementById('compare-time-b');
  var speedRow = document.getElementById('compare-speed');
  var toolsRow = document.getElementById('compare-tools');
  var doneBtn = document.getElementById('compare-done');
  var colorsRow = document.getElementById('compare-colors');
  var hintEl = document.getElementById('compare-hint');
  var resetBtn = document.getElementById('compare-reset');

  var tool = null;              // null | 'pen' | 'eraser' | 'line' | 'circle'
  var penColor = PEN_COLORS[0];

  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  // ----- One panel (video + canvas + independent strokes + own play/undo) --
  function makePanel(side, label) {
    var dropEl = document.getElementById('compare-drop-' + side);
    var fileInput = document.getElementById('compare-file-' + side);
    var pickBtn = document.getElementById('compare-pick-' + side);
    var stageEl = document.getElementById('compare-stage-' + side);
    var frameEl = document.getElementById('compare-frame-' + side);
    var video = document.getElementById('compare-video-' + side);
    var canvas = document.getElementById('compare-canvas-' + side);
    var errorEl = document.getElementById('compare-error-' + side);
    var panelPlayBtn = document.getElementById('compare-playbtn-' + side);
    var strokesRow = document.getElementById('compare-strokes-' + side);
    var undoBtn = document.getElementById('compare-undo-' + side);
    var clearBtn = document.getElementById('compare-clear-' + side);
    var ctx = canvas.getContext('2d');

    var objectUrl = null;
    var strokes = [];
    var active = null;
    var anchor = null;
    var cssW = 1, cssH = 1;
    var loaded = false;

    function resizeCanvas() {
      var rect = frameEl.getBoundingClientRect();
      cssW = Math.max(1, rect.width);
      cssH = Math.max(1, rect.height);
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      redraw();
    }
    if (window.ResizeObserver) new ResizeObserver(resizeCanvas).observe(frameEl);
    else window.addEventListener('resize', resizeCanvas);
    video.addEventListener('loadedmetadata', resizeCanvas);

    function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
    function localPoint(e) {
      var rect = canvas.getBoundingClientRect();
      return {
        x: clamp01((e.clientX - rect.left) / (rect.width || 1)),
        y: clamp01((e.clientY - rect.top) / (rect.height || 1)),
      };
    }
    function segmentDistancePx(a, b, p) {
      var ax = a.x * cssW, ay = a.y * cssH, bx = b.x * cssW, by = b.y * cssH;
      var px = p.x * cssW, py = p.y * cssH;
      var dx = bx - ax, dy = by - ay;
      var len2 = dx * dx + dy * dy;
      if (len2 === 0) { var dx2 = px - ax, dy2 = py - ay; return Math.sqrt(dx2 * dx2 + dy2 * dy2); }
      var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      var cx = ax + t * dx, cy = ay + t * dy;
      var ddx = px - cx, ddy = py - cy;
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }
    function circleDistPx(s, p) {
      var cx = s.center.x * cssW, cy = s.center.y * cssH;
      var r = Math.hypot((s.edge.x - s.center.x) * cssW, (s.edge.y - s.center.y) * cssH);
      var d = Math.hypot(p.x * cssW - cx, p.y * cssH - cy);
      return Math.abs(d - r);
    }
    function nearestStrokeIndex(pt) {
      var bestIdx = -1, bestDist = Infinity;
      for (var i = 0; i < strokes.length; i++) {
        var s = strokes[i], d = Infinity;
        if (s.mode === 'circle') {
          d = circleDistPx(s, pt);
        } else if (s.points.length === 1) {
          d = Math.hypot((s.points[0].x - pt.x) * cssW, (s.points[0].y - pt.y) * cssH);
        } else {
          for (var j = 0; j < s.points.length - 1; j++) d = Math.min(d, segmentDistancePx(s.points[j], s.points[j + 1], pt));
        }
        if (d < bestDist) { bestDist = d; bestIdx = i; }
      }
      return bestDist <= HIT_PX ? bestIdx : -1;
    }
    function eraseAt(pt) {
      var idx = nearestStrokeIndex(pt);
      if (idx >= 0) { strokes.splice(idx, 1); updateStrokeUI(); redraw(); }
    }

    // Both panels' canvases are always live once a tool is armed — whichever
    // one a pointerdown lands on is the one that gets the stroke. No "is this
    // my panel" check needed: the browser already resolved that by dispatching
    // the event to THIS canvas.
    var pointerDown = false;
    canvas.addEventListener('pointerdown', function (e) {
      if (!tool) return;
      e.preventDefault();
      pointerDown = true;
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { }
      var p = localPoint(e);
      if (tool === 'eraser') { eraseAt(p); return; }
      anchor = p;
      active = { mode: tool, color: penColor, width: PEN_WIDTH, points: [p] };
      redraw();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!tool || !pointerDown) return;
      e.preventDefault();
      var p = localPoint(e);
      if (tool === 'eraser') { eraseAt(p); return; }
      if (!active) return;
      if (tool === 'line') {
        active.points = [anchor, p];
      } else if (tool === 'circle') {
        active.mode = 'circle';
        active.center = anchor;
        active.edge = p;
      } else {
        var last = active.points[active.points.length - 1];
        if (!last || Math.abs(last.x - p.x) >= 0.002 || Math.abs(last.y - p.y) >= 0.002) active.points.push(p);
      }
      redraw();
    });
    function finishStroke() {
      pointerDown = false;
      if (active && tool !== 'eraser') {
        if (active.mode === 'circle' ? (active.center && active.edge) : active.points.length > 0) {
          strokes.push(active);
        }
      }
      active = null;
      anchor = null;
      updateStrokeUI();
      redraw();
    }
    canvas.addEventListener('pointerup', finishStroke);
    canvas.addEventListener('pointercancel', function () { pointerDown = false; active = null; anchor = null; redraw(); });

    function drawStroke(s) {
      ctx.save();
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 1.5;
      ctx.shadowOffsetY = 1;
      if (s.mode === 'circle') {
        if (s.center && s.edge) {
          var cx = s.center.x * cssW, cy = s.center.y * cssH;
          var r = Math.hypot((s.edge.x - s.center.x) * cssW, (s.edge.y - s.center.y) * cssH);
          if (r > 0.5) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke(); }
        }
      } else if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(s.points[0].x * cssW, s.points[0].y * cssH, s.width / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(s.points[0].x * cssW, s.points[0].y * cssH);
        for (var i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x * cssW, s.points[i].y * cssH);
        ctx.stroke();
      }
      ctx.restore();
    }
    function redraw() {
      ctx.clearRect(0, 0, cssW, cssH);
      for (var i = 0; i < strokes.length; i++) drawStroke(strokes[i]);
      if (active && tool !== 'eraser') drawStroke(active);
    }

    // Show/hide + wire this panel's own Undo/Clear row.
    function updateStrokeUI() {
      strokesRow.hidden = strokes.length === 0;
    }
    undoBtn.addEventListener('click', function () { strokes.pop(); updateStrokeUI(); redraw(); });
    clearBtn.addEventListener('click', function () { strokes = []; updateStrokeUI(); redraw(); });

    // This panel's own play/pause — independent of the shared "Play Both"
    // button below, so either swing can play on its own.
    function updatePanelPlayLabel() {
      panelPlayBtn.innerHTML = (video.paused ? '&#9654; Play ' : '&#10074;&#10074; Pause ') + label;
    }
    video.addEventListener('play', updatePanelPlayLabel);
    video.addEventListener('pause', updatePanelPlayLabel);
    panelPlayBtn.addEventListener('click', function () {
      if (!loaded) return;
      if (video.paused) video.play().catch(function () { });
      else video.pause();
    });

    // `loaded` only flips true once the browser actually decodes the file
    // (loadedmetadata), and an `error` event reverts to the drop state with a
    // message — otherwise a non-video file (accept="video/*" is only a picker
    // HINT; "All Files" bypasses it same as a renamed file) silently counts as
    // "loaded", desyncing bothLoaded()/the shared transport against a panel
    // that will never actually play.
    function load(file) {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = URL.createObjectURL(file);
      video.src = objectUrl;
      strokes = []; active = null; anchor = null;
      loaded = false;
      errorEl.hidden = true;
      dropEl.hidden = true;
      stageEl.hidden = false;
      updateStrokeUI();
      redraw();
      video.addEventListener('error', function onErr() {
        video.removeEventListener('error', onErr);
        reset();
        errorEl.hidden = false;
        errorEl.textContent = "Couldn't load that file — pick a video.";
      }, { once: true });
      video.addEventListener('loadedmetadata', function onMeta() {
        video.removeEventListener('loadedmetadata', onMeta);
        loaded = true;
        onPanelChanged();
      }, { once: true });
    }
    function reset() {
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      fileInput.value = '';
      strokes = []; active = null; anchor = null;
      loaded = false;
      stageEl.hidden = true;
      dropEl.hidden = false;
      updateStrokeUI();
      onPanelChanged();
    }

    function pickValid(file) { return file && file.type.indexOf('video') === 0; }

    pickBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      if (pickValid(f)) {
        load(f);
      } else if (f) {
        errorEl.hidden = false;
        errorEl.textContent = 'That doesn\'t look like a video — pick an MP4 or MOV.';
      }
      fileInput.value = ''; // allow re-picking the same file after a rejected pick
    });
    ['dragover', 'dragenter'].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.style.borderColor = 'var(--gold)'; });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.style.borderColor = ''; });
    });
    dropEl.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (pickValid(f)) load(f);
    });

    return {
      video: video,
      canvas: canvas,
      isLoaded: function () { return loaded; },
      redraw: redraw,
      reset: reset,
    };
  }

  var panelA = makePanel('a', 'Video A');
  var panelB = makePanel('b', 'Video B');

  function bothLoaded() { return panelA.isLoaded() && panelB.isLoaded(); }
  function onPanelChanged() { controlsEl.hidden = !bothLoaded(); }

  // ----- Shared transport: "Play Both" + speed + fraction-synced scrub -----
  // The shared icon reflects whether EITHER clip is playing — mirrors each
  // panel's own play button (which drives that video alone) rather than
  // silently ignoring one side, so a broken/never-loaded A can't wedge this
  // like a single-source read would.
  function updatePlayIcon() {
    var anyPlaying = !panelA.video.paused || !panelB.video.paused;
    playBtn.innerHTML = anyPlaying ? '&#10074;&#10074;' : '&#9654;';
  }
  panelA.video.addEventListener('play', updatePlayIcon);
  panelA.video.addEventListener('pause', updatePlayIcon);
  panelB.video.addEventListener('play', updatePlayIcon);
  panelB.video.addEventListener('pause', updatePlayIcon);

  playBtn.addEventListener('click', function () {
    if (!bothLoaded()) return;
    var anyPlaying = !panelA.video.paused || !panelB.video.paused;
    if (anyPlaying) {
      panelA.video.pause();
      panelB.video.pause();
    } else {
      panelA.video.play().catch(function () { });
      panelB.video.play().catch(function () { });
    }
  });

  function updateTimeUI() {
    var dA = panelA.video.duration || 0, pA = panelA.video.currentTime || 0;
    var dB = panelB.video.duration || 0, pB = panelB.video.currentTime || 0;
    // Fall back to B's fraction when A has no duration (or never loads) — a
    // broken A shouldn't permanently pin the shared scrub bar at 0%.
    var frac = dA > 0 ? pA / dA : (dB > 0 ? pB / dB : 0);
    scrubFill.style.width = Math.min(100, Math.max(0, frac * 100)) + '%';
    timeAEl.textContent = 'A ' + fmtTime(pA) + ' / ' + fmtTime(dA);
    timeBEl.textContent = 'B ' + fmtTime(pB) + ' / ' + fmtTime(dB);
  }
  panelA.video.addEventListener('timeupdate', updateTimeUI);
  panelA.video.addEventListener('durationchange', updateTimeUI);
  panelB.video.addEventListener('timeupdate', updateTimeUI);
  panelB.video.addEventListener('durationchange', updateTimeUI);

  // Seek both clips to the SAME FRACTION of their own duration — applies
  // regardless of which is playing, useful for lining the two up even when
  // only one is actively running.
  function seekToFrac(frac) {
    var f = Math.max(0, Math.min(1, frac));
    if (panelA.video.duration) panelA.video.currentTime = f * panelA.video.duration;
    if (panelB.video.duration) panelB.video.currentTime = f * panelB.video.duration;
  }
  function seekFromClientX(clientX) {
    var rect = scrubEl.getBoundingClientRect();
    seekToFrac((clientX - rect.left) / (rect.width || 1));
  }
  var scrubbing = false;
  scrubEl.addEventListener('pointerdown', function (e) {
    scrubbing = true;
    try { scrubEl.setPointerCapture(e.pointerId); } catch (err) { }
    seekFromClientX(e.clientX);
  });
  scrubEl.addEventListener('pointermove', function (e) { if (scrubbing) seekFromClientX(e.clientX); });
  scrubEl.addEventListener('pointerup', function () { scrubbing = false; });
  scrubEl.addEventListener('pointercancel', function () { scrubbing = false; });

  PLAYBACK_RATES.forEach(function (rate) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = RATE_LABELS[rate];
    b.className = rate === 1 ? 'on' : '';
    b.addEventListener('click', function () {
      panelA.video.playbackRate = rate;
      panelB.video.playbackRate = rate;
      Array.prototype.forEach.call(speedRow.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
    });
    speedRow.appendChild(b);
  });

  // ----- Drawing tools (shared tool/color; both canvases always live) ------
  PEN_COLORS.forEach(function (c) {
    var b = document.createElement('button');
    b.type = 'button';
    b.style.background = c;
    if (c === penColor) b.classList.add('on');
    b.addEventListener('click', function () {
      penColor = c;
      Array.prototype.forEach.call(colorsRow.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });
    colorsRow.appendChild(b);
  });

  function updateCanvasDrawingClass() {
    var on = !!tool;
    panelA.canvas.classList.toggle('drawing', on);
    panelB.canvas.classList.toggle('drawing', on);
  }
  function setTool(next) {
    tool = next;
    doneBtn.hidden = !tool;
    hintEl.hidden = !tool;
    colorsRow.hidden = !tool || tool === 'eraser';
    updateCanvasDrawingClass();
  }
  function updateToolButtons() {
    Array.prototype.forEach.call(toolsRow.querySelectorAll('button[data-tool]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tool') === tool);
    });
  }
  Array.prototype.forEach.call(toolsRow.querySelectorAll('button[data-tool]'), function (b) {
    b.addEventListener('click', function () {
      setTool(b.getAttribute('data-tool'));
      updateToolButtons();
    });
  });
  doneBtn.addEventListener('click', function () { setTool(null); updateToolButtons(); });

  resetBtn.addEventListener('click', function () {
    panelA.reset();
    panelB.reset();
    setTool(null);
    updateToolButtons();
    onPanelChanged();
  });
})();
