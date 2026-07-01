/* Review Sesh — upload a swing video, play it back slow, and draw on it.
   Entirely client-side: the file never leaves the tab (object URL only, no
   upload, no persistence). Ported from the mobile app's analyze.tsx +
   SwingAnnotator.tsx — same tool set (pen/eraser/line/circle), same slo-mo
   rates, same "nearest stroke" eraser hit-testing — reimplemented with
   <video> + <canvas> instead of expo-av + rotated Views. */
(function () {
  var root = document.querySelector('.review-wrap[data-page="review"]');
  if (!root) return;

  var PLAYBACK_RATES = [1, 0.5, 0.25, 0.125];
  var RATE_LABELS = { 1: '1×', 0.5: '½×', 0.25: '¼×', 0.125: '⅛×' };
  var PEN_COLORS = ['#ffd60a', '#e63946', '#4a9eff', '#7aab78', '#ffffff'];
  var PEN_WIDTH = 4;
  var HIT_PX = 14; // eraser hit tolerance, matches mobile

  var dropEl = document.getElementById('review-drop');
  var fileInput = document.getElementById('review-file');
  var pickBtn = document.getElementById('review-pick');
  var stageEl = document.getElementById('review-stage');
  var frameEl = document.getElementById('review-frame');
  var video = document.getElementById('review-video');
  var canvas = document.getElementById('review-canvas');
  var ctx = canvas.getContext('2d');
  var playBtn = document.getElementById('review-playbtn');
  var scrubEl = document.getElementById('review-scrub');
  var scrubFill = document.getElementById('review-scrub-fill');
  var timeEl = document.getElementById('review-time');
  var speedRow = document.getElementById('review-speed');
  var toolsRow = document.getElementById('review-tools');
  var doneBtn = document.getElementById('review-done');
  var undoBtn = document.getElementById('review-undo');
  var clearBtn = document.getElementById('review-clear');
  var colorsRow = document.getElementById('review-colors');
  var hintEl = document.getElementById('review-hint');
  var newBtn = document.getElementById('review-new');

  var objectUrl = null;
  var tool = null; // null | 'pen' | 'eraser' | 'line' | 'circle'
  var penColor = PEN_COLORS[0];
  var strokes = []; // committed strokes, normalized 0..1 coords
  var active = null; // in-progress stroke
  var anchor = null; // drag start for line/circle, normalized coords
  var cssW = 1, cssH = 1;

  // ----- Video source -------------------------------------------------------
  function pickFile() { fileInput.click(); }
  pickBtn.addEventListener('click', pickFile);

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    if (!f) return;
    loadVideo(f);
  });

  function loadVideo(file) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    strokes = []; active = null; anchor = null;
    setTool(null);
    updateToolButtons();
    dropEl.hidden = true;
    stageEl.hidden = false;
  }

  newBtn.addEventListener('click', function () {
    video.pause();
    video.removeAttribute('src');
    video.load();
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    fileInput.value = '';
    strokes = []; active = null; anchor = null;
    setTool(null);
    updateToolButtons();
    stageEl.hidden = true;
    dropEl.hidden = false;
  });

  // Drag-and-drop onto the drop zone, as an alternative to the file picker.
  ['dragover', 'dragenter'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.style.borderColor = 'var(--gold)'; });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.style.borderColor = ''; });
  });
  dropEl.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f && f.type.indexOf('video') === 0) loadVideo(f);
  });

  // ----- Canvas sizing -------------------------------------------------------
  // The canvas is drawn in CSS-pixel coordinates (via a DPR transform) so
  // strokes stay crisp on retina displays without extra math elsewhere.
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
  if (window.ResizeObserver) {
    new ResizeObserver(resizeCanvas).observe(frameEl);
  } else {
    window.addEventListener('resize', resizeCanvas);
  }
  video.addEventListener('loadedmetadata', resizeCanvas);

  // ----- Playback controls ---------------------------------------------------
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var s = Math.floor(sec);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }
  function updateTimeUI() {
    var d = video.duration || 0, p = video.currentTime || 0;
    scrubFill.style.width = (d > 0 ? Math.min(100, (p / d) * 100) : 0) + '%';
    timeEl.textContent = fmtTime(p) + ' / ' + fmtTime(d);
  }
  video.addEventListener('timeupdate', updateTimeUI);
  video.addEventListener('durationchange', updateTimeUI);
  video.addEventListener('play', function () { playBtn.innerHTML = '&#10074;&#10074;'; });
  video.addEventListener('pause', function () { playBtn.innerHTML = '&#9654;'; });

  playBtn.addEventListener('click', function () {
    if (video.paused) video.play().catch(function () {});
    else video.pause();
  });

  function seekFromClientX(clientX) {
    var rect = scrubEl.getBoundingClientRect();
    var frac = Math.max(0, Math.min(1, (clientX - rect.left) / (rect.width || 1)));
    if (video.duration) video.currentTime = frac * video.duration;
  }
  var scrubbing = false;
  scrubEl.addEventListener('pointerdown', function (e) {
    scrubbing = true;
    // Capture failure (e.g. an already-released/foreign pointerId) shouldn't
    // block the seek itself — dragging still works via pointermove either way.
    try { scrubEl.setPointerCapture(e.pointerId); } catch (err) {}
    seekFromClientX(e.clientX);
  });
  scrubEl.addEventListener('pointermove', function (e) { if (scrubbing) seekFromClientX(e.clientX); });
  scrubEl.addEventListener('pointerup', function () { scrubbing = false; });
  scrubEl.addEventListener('pointercancel', function () { scrubbing = false; });

  // Speed chips — a video element's playbackRate persists across play/pause
  // and loop restarts on its own, so unlike expo-av there's no reset-to-1x
  // quirk to fight; we just set the property once.
  PLAYBACK_RATES.forEach(function (rate) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = RATE_LABELS[rate];
    b.className = rate === 1 ? 'on' : '';
    b.addEventListener('click', function () {
      video.playbackRate = rate;
      Array.prototype.forEach.call(speedRow.children, function (c) { c.classList.remove('on'); });
      b.classList.add('on');
    });
    speedRow.appendChild(b);
  });

  // ----- Drawing tools ---------------------------------------------------
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

  function setTool(next) {
    tool = next;
    canvas.classList.toggle('drawing', !!tool);
    doneBtn.hidden = !tool;
    hintEl.hidden = !tool;
    colorsRow.hidden = !tool || tool === 'eraser';
  }
  function updateToolButtons() {
    Array.prototype.forEach.call(toolsRow.querySelectorAll('button[data-tool]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-tool') === tool);
    });
    undoBtn.hidden = strokes.length === 0;
    clearBtn.hidden = strokes.length === 0;
  }
  Array.prototype.forEach.call(toolsRow.querySelectorAll('button[data-tool]'), function (b) {
    b.addEventListener('click', function () {
      setTool(b.getAttribute('data-tool'));
      updateToolButtons();
    });
  });
  doneBtn.addEventListener('click', function () { setTool(null); updateToolButtons(); });
  undoBtn.addEventListener('click', function () { strokes.pop(); updateToolButtons(); redraw(); });
  clearBtn.addEventListener('click', function () { strokes = []; updateToolButtons(); redraw(); });

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function localPoint(e) {
    var rect = canvas.getBoundingClientRect();
    return {
      x: clamp01((e.clientX - rect.left) / (rect.width || 1)),
      y: clamp01((e.clientY - rect.top) / (rect.height || 1)),
    };
  }

  /** Perpendicular distance from p to segment a->b, in CURRENT pixel space —
   *  recomputed from normalized coords on every hit-test so a resize between
   *  drawing and erasing can't throw off the tolerance. */
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
    if (idx >= 0) { strokes.splice(idx, 1); updateToolButtons(); redraw(); }
  }

  var pointerDown = false;
  canvas.addEventListener('pointerdown', function (e) {
    if (!tool) return;
    e.preventDefault();
    pointerDown = true;
    // Capture keeps the drag tracking even if the pointer leaves the canvas
    // mid-stroke; a failure here (foreign pointerId, capture unsupported)
    // shouldn't abort the stroke — drawing still works without it as long as
    // the pointer stays over the canvas.
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
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
    updateToolButtons();
    redraw();
  }
  canvas.addEventListener('pointerup', finishStroke);
  canvas.addEventListener('pointercancel', function () { pointerDown = false; active = null; anchor = null; redraw(); });

  // ----- Rendering ---------------------------------------------------------
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
})();
