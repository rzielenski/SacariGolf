/* Sacari web app client. Drives the interactive play-loop pages (create a
   round, enter a scorecard) by calling the same-origin authenticated proxy at
   /app/api/*, which forwards to the backend with the session token. */
(function () {
  function api(method, path, body) {
    return fetch('/app/api' + path, {
      method: method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    }).then(function (r) {
      return r.text().then(function (t) {
        var j = {};
        try { j = t ? JSON.parse(t) : {}; } catch (e) { j = {}; }
        if (!r.ok) { var err = new Error((j && j.error) || ('Error ' + r.status)); err.status = r.status; throw err; }
        return j;
      });
    });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function segValue(seg) { var b = seg.querySelector('button.on'); return b ? b.getAttribute('data-val') : null; }
  function wireSeg(seg) {
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button'); if (!b) return;
      var all = seg.querySelectorAll('button');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('on', all[i] === b);
    });
  }

  var playEl = document.querySelector('.app-form[data-page="play"]');
  var scoreEl = document.querySelector('.app-score[data-page="score"]');
  if (playEl) initPlay(playEl);
  if (scoreEl) initScore(scoreEl);

  // ----- Create a round -----------------------------------------------------
  function initPlay(root) {
    var modeSeg = root.querySelector('#play-mode'), holesSeg = root.querySelector('#play-holes');
    wireSeg(modeSeg); wireSeg(holesSeg);
    var q = root.querySelector('#play-course-q'), ac = root.querySelector('#play-course-ac');
    var picked = root.querySelector('#play-course-picked'), teeGroup = root.querySelector('#play-tee-group');
    var teeSel = root.querySelector('#play-tee'), createBtn = root.querySelector('#play-create'), msg = root.querySelector('#play-msg');
    var chosen = null, timer = null, lastQ = '';

    function hideAc() { ac.hidden = true; ac.innerHTML = ''; }
    function updateBtn() { createBtn.disabled = !(chosen && teeSel.value); }

    function search() {
      var v = q.value.trim();
      if (v.length < 2) { hideAc(); return; }
      if (v === lastQ) return; lastQ = v;
      api('GET', '/courses/search?q=' + encodeURIComponent(v)).then(function (rows) {
        if (q.value.trim() !== v) return;
        if (!rows || !rows.length) { hideAc(); return; }
        ac.innerHTML = rows.slice(0, 8).map(function (c) {
          var loc = [c.city, c.state, c.country].filter(Boolean).join(', ');
          return '<button type="button" class="ac-item" data-id="' + esc(c.course_id) + '" data-name="' + esc(c.course_name) + '">' +
            '<span class="ac-name">' + esc(c.course_name) + '</span>' +
            (loc ? '<span class="ac-loc">' + esc(loc) + '</span>' : '') + '</button>';
        }).join('');
        ac.hidden = false;
      }).catch(hideAc);
    }

    function pickCourse(id, name) {
      chosen = { course_id: id, course_name: name };
      q.value = ''; hideAc();
      picked.hidden = false;
      picked.innerHTML = '<span>' + esc(name) + '</span><button type="button" id="play-clear">change</button>';
      picked.querySelector('#play-clear').addEventListener('click', function () {
        chosen = null; picked.hidden = true; teeGroup.hidden = true; updateBtn();
      });
      teeSel.innerHTML = '<option>Loading...</option>'; teeGroup.hidden = false;
      api('GET', '/courses/' + encodeURIComponent(id)).then(function (course) {
        var tees = course.teeboxes || [];
        if (!tees.length) { teeSel.innerHTML = '<option value="">No tees on file</option>'; updateBtn(); return; }
        teeSel.innerHTML = tees.map(function (t) {
          var label = (t.name || 'Tees') + (t.total_yards ? ' · ' + t.total_yards + ' yds' : '') + (t.num_holes ? ' · ' + t.num_holes + 'h' : '');
          return '<option value="' + esc(t.teebox_id) + '">' + esc(label) + '</option>';
        }).join('');
        updateBtn();
      }).catch(function () { teeSel.innerHTML = '<option value="">Could not load tees</option>'; updateBtn(); });
    }

    q.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(search, 180); });
    ac.addEventListener('click', function (e) {
      var b = e.target.closest('.ac-item'); if (!b) return;
      pickCourse(b.getAttribute('data-id'), b.getAttribute('data-name'));
    });
    teeSel.addEventListener('change', updateBtn);
    document.addEventListener('click', function (e) { if (e.target !== q && !ac.contains(e.target)) hideAc(); });

    createBtn.addEventListener('click', function () {
      if (createBtn.disabled) return;
      var mode = segValue(modeSeg), holes = segValue(holesSeg);
      var body = { format: 'stroke', teeboxId: teeSel.value };
      if (mode === 'practice') { body.matchType = 'practice'; body.isPractice = true; } else { body.matchType = 'solo'; }
      if (holes === 'front9') { body.numHoles = 9; body.holesSubset = 'front'; }
      else if (holes === 'back9') { body.numHoles = 9; body.holesSubset = 'back'; }
      else { body.numHoles = 18; body.holesSubset = 'full'; }
      createBtn.disabled = true; msg.textContent = 'Creating...';
      api('POST', '/matches', body).then(function (m) {
        var id = m.match_id || (m.match && m.match.match_id) || m.id;
        if (!id) { msg.textContent = 'Created, but no match id came back.'; createBtn.disabled = false; return; }
        window.location.href = '/app/score/' + encodeURIComponent(id);
      }).catch(function (e) { msg.textContent = e.message || 'Could not create the round.'; createBtn.disabled = false; });
    });
  }

  // ----- Score a round ------------------------------------------------------
  function initScore(root) {
    var matchId = root.getAttribute('data-match');
    var out = root.querySelector('#score-body');
    var me = null, match = null, course = null, teebox = null, holes = [];

    Promise.all([api('GET', '/users/me'), api('GET', '/matches/' + encodeURIComponent(matchId))]).then(function (res) {
      me = res[0]; match = res[1];
      var mine = (match.players || []).filter(function (p) { return p.user_id === me.user_id; })[0];
      if (!mine) { out.innerHTML = '<div class="empty">This is not your match.</div>'; return; }
      if (match.completed || mine.completed) {
        out.innerHTML = '<div class="empty">This round is already in. <a href="/app/match/' + esc(matchId) + '">View it &rarr;</a></div>'; return;
      }
      var courseId = mine.course_id, teeboxId = mine.teebox_id;
      if (!courseId || !teeboxId) { out.innerHTML = '<div class="empty">No course or tee is set on this round.</div>'; return; }
      api('GET', '/courses/' + encodeURIComponent(courseId)).then(function (c) {
        course = c;
        teebox = (c.teeboxes || []).filter(function (t) { return t.teebox_id === teeboxId; })[0];
        var all = ((teebox && teebox.holes) || []).slice().sort(function (a, b) { return a.hole_num - b.hole_num; });
        var n = match.num_holes || all.length || 18;
        var sub = match.holes_subset;
        var played;
        if (all.length === n) played = all;
        else if (sub === 'back') played = all.slice(all.length - n);
        else played = all.slice(0, n);
        holes = played.map(function (h) { return { hole_num: h.hole_num, par: h.par, score: '' }; });
        if (!holes.length) { out.innerHTML = '<div class="empty">This course has no hole data yet.</div>'; return; }
        renderCard();
      }).catch(function () { out.innerHTML = '<div class="empty">Could not load the course holes.</div>'; });
    }).catch(function (e) { out.innerHTML = '<div class="empty">' + esc(e.message || 'Could not load the round.') + '</div>'; });

    function renderCard() {
      var rows = holes.map(function (h, i) {
        return '<div class="sc-hole">' +
          '<span class="sc-h-num">' + esc(h.hole_num) + '</span>' +
          '<span class="sc-h-par">Par ' + esc(h.par != null ? h.par : '-') + '</span>' +
          '<button type="button" class="sc-step" data-i="' + i + '" data-d="-1">&minus;</button>' +
          '<input class="sc-in" inputmode="numeric" data-i="' + i + '" value="" />' +
          '<button type="button" class="sc-step" data-i="' + i + '" data-d="1">+</button>' +
          '</div>';
      }).join('');
      out.innerHTML = '<div class="sc-holes">' + rows + '</div>' +
        '<div class="sc-summary"><span id="sc-total">Total —</span><span id="sc-topar"></span></div>' +
        '<label class="field"><span class="field-label">Note (optional)</span>' +
        '<input id="sc-caption" maxlength="140" placeholder="How did it go?" /></label>' +
        '<div id="sc-msg" class="app-msg"></div>' +
        '<button id="sc-submit" class="cta" type="button">Submit round</button>';

      var inputs = out.querySelectorAll('.sc-in');
      for (var a = 0; a < inputs.length; a++) {
        inputs[a].addEventListener('input', function () {
          var i = +this.getAttribute('data-i');
          holes[i].score = this.value.replace(/[^0-9]/g, '').slice(0, 2);
          this.value = holes[i].score; updateTotals();
        });
      }
      var steps = out.querySelectorAll('.sc-step');
      for (var b = 0; b < steps.length; b++) {
        steps[b].addEventListener('click', function () {
          var i = +this.getAttribute('data-i'), d = +this.getAttribute('data-d');
          var cur = parseInt(holes[i].score, 10);
          if (isNaN(cur)) cur = holes[i].par || 4;
          cur = Math.max(1, cur + d);
          holes[i].score = String(cur);
          var inp = out.querySelector('.sc-in[data-i="' + i + '"]');
          if (inp) inp.value = holes[i].score;
          updateTotals();
        });
      }
      out.querySelector('#sc-submit').addEventListener('click', submit);
      updateTotals();
    }

    function updateTotals() {
      var total = 0, par = 0, filled = 0;
      holes.forEach(function (h) {
        var s = parseInt(h.score, 10);
        if (!isNaN(s) && s > 0) { total += s; filled++; }
        if (h.par != null) par += h.par;
      });
      var t = out.querySelector('#sc-total'), tp = out.querySelector('#sc-topar');
      if (t) t.textContent = total > 0 ? ('Total ' + total) : 'Total —';
      if (tp) {
        var d = total - par;
        tp.textContent = filled ? (d === 0 ? 'E' : (d > 0 ? '+' + d : String(d))) : '';
        tp.className = d <= 0 ? 'good' : 'bad';
      }
    }

    function submit() {
      var btn = out.querySelector('#sc-submit'), msg = out.querySelector('#sc-msg');
      for (var i = 0; i < holes.length; i++) {
        var s = parseInt(holes[i].score, 10);
        if (isNaN(s) || s < 1) { msg.textContent = 'Enter a score for hole ' + holes[i].hole_num + '.'; return; }
      }
      var cap = out.querySelector('#sc-caption');
      var body = {
        holeScores: holes.map(function (h) { return parseInt(h.score, 10); }),
        courseId: course && course.course_id,
        teeboxId: teebox && teebox.teebox_id,
        caption: cap && cap.value ? cap.value : undefined,
      };
      btn.disabled = true; msg.textContent = 'Submitting...';
      api('POST', '/matches/' + encodeURIComponent(matchId) + '/scores', body).then(function () {
        window.location.href = '/app/match/' + encodeURIComponent(matchId);
      }).catch(function (e) { msg.textContent = e.message || 'Could not submit.'; btn.disabled = false; });
    }
  }
})();
