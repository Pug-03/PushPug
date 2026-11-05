// "ตั้งค่า PushPug / PushPug Settings" page. Plain JS, no framework.
// The page is rendered once; later updates from the extension patch values in
// place so focus, slider drags and the mode-card animation are never interrupted.
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var init = JSON.parse(document.getElementById('pp-init').textContent);
  var M = window.PushPugMascot;
  var I = window.PushPugIcon;
  var Modes = window.PushPugModes;
  var esc = Modes.esc;
  var app = document.getElementById('app');
  var state = { settings: null, freq: null };
  var SECTIONS = [
    { id: 'notify', icon: 'bell' },
    { id: 'frequency', icon: 'clock' },
    { id: 'look', icon: 'sun' },
    { id: 'github', icon: 'github' }
  ];

  function s(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    var t = init.strings[key] || key;
    return t.replace(/\{(\d+)\}/g, function (m, i) { return args[i] !== undefined ? args[i] : m; });
  }
  function post(msg) { vscode.postMessage(msg); }
  function secs(n) { return Modes.fmtSeconds(s, n); }
  /** "= 5 นาที" next to a seconds box; nothing under a minute (the box already says it). */
  function human(n) { return n >= 60 ? '= ' + secs(n) : ''; }

  // ---------- building blocks ----------
  function toggle(attr, key, icon, label, hint, disabled) {
    return (
      '<button class="tg" role="switch" aria-checked="false" ' + attr + '="' + key + '"' + (disabled ? ' disabled' : '') + '>' +
        '<span class="tg-ic">' + I(icon) + '</span>' +
        '<span class="tg-text"><span class="tg-label">' + esc(label) + '</span>' + (hint ? '<span class="tg-hint">' + esc(hint) + '</span>' : '') + '</span>' +
        '<span class="tg-switch"><i></i></span>' +
      '</button>'
    );
  }
  function miniSwitch(field, label) {
    return '<button class="mini-sw" role="switch" aria-checked="false" aria-label="' + esc(label) + '" data-field="' + field + '"><i></i></button>';
  }
  function num(field, unit, label) {
    var lim = state.freq.limits[field];
    return (
      '<span class="num"><input type="number" inputmode="numeric" data-field="' + field + '" min="' + lim[0] + '" max="' + lim[1] + '" step="1" aria-label="' + esc(label) + '">' +
      (unit ? '<span class="num-unit">' + esc(unit) + '</span>' : '') + '</span>'
    );
  }
  function sliderRow(field, label, hint, extraClass) {
    var lim = state.freq.limits[field];
    return (
      '<div class="st-row ' + (extraClass || '') + '" data-row="' + field + '">' +
        '<div class="st-row-text"><label class="st-label" for="r-' + field + '">' + esc(label) + '</label>' +
        '<span class="st-hint" data-hint="' + field + '">' + esc(hint) + '</span></div>' +
        '<div class="st-range">' +
          '<input type="range" id="r-' + field + '" data-range="' + field + '" min="' + lim[0] + '" max="' + lim[1] + '" step="1">' +
          num(field, s('set.secondsUnit'), label) +
          '<span class="st-range-human" data-human="' + field + '"></span>' +
        '</div>' +
      '</div>'
    );
  }
  /** A sentence with inline inputs: template "… {0} … {1}" + the inputs' html. */
  function sentence(template, parts) {
    return template.split(/(\{\d+\})/).map(function (bit) {
      var m = /^\{(\d+)\}$/.exec(bit);
      return m ? parts[Number(m[1])] : esc(bit);
    }).join('');
  }
  function rule(field, html) {
    return '<div class="st-rule" data-rule="' + field + '">' + miniSwitch(field + '.enabled', '') + '<div class="st-rule-text">' + html + '</div></div>';
  }
  function opt(group, value, icon, label, hint) {
    return (
      '<button class="opt" role="radio" aria-checked="false" data-group="' + group + '" data-value="' + value + '">' +
        '<span class="opt-ic">' + icon + '</span><span class="opt-label">' + esc(label) + '</span>' +
        (hint ? '<span class="opt-hint">' + esc(hint) + '</span>' : '') +
        '<span class="opt-check">' + I('check') + '</span>' +
      '</button>'
    );
  }
  function section(id, title, body) {
    return '<section class="st-sec" id="sec-' + id + '" data-sec="' + id + '"><h2 class="st-h2">' + esc(title) + '</h2>' + body + '</section>';
  }

  // ---------- sections ----------
  function secNotify() {
    var bgHint = init.platform === 'darwin' ? s('notify.backgroundMac') : init.platform === 'win32' ? s('notify.backgroundWin') : s('notify.backgroundNo');
    return section('notify', s('set.nav.notify'),
      '<div class="wz-list">' +
        toggle('data-setting', 'notifyInVSCode', 'code', s('notify.vscode'), s('notify.vscodeHint')) +
        toggle('data-setting', 'notifyDesktop', 'screen', s('notify.desktop'), s('notify.desktopHint')) +
        toggle('data-setting', 'notifyBackground', 'clock', s('notify.background'), s('notify.backgroundHint') + ' ' + bgHint, !init.bgSupported) +
        toggle('data-setting', 'sameFileWarning', 'file', s('set.notify.sameFile'), s('set.notify.sameFileHint')) +
        toggle('data-setting', 'quietEnabled', 'moon', s('set.quiet'), s('set.quietHint')) +
      '</div>' +
      '<div class="st-rule st-quiet" data-rule="quiet">' + sentence(s('set.quietRange'), [
        '<input type="time" data-time="quietStart" aria-label="start">', '<input type="time" data-time="quietEnd" aria-label="end">']) + '</div>' +
      '<div class="st-actions st-snooze"><span class="st-hint" data-text="snoozed"></span>' +
        '<button class="btn" data-act="snooze" data-show="notSnoozed">' + I('pause') + esc(s('set.snooze')) + '</button>' +
        '<button class="btn" data-act="unsnooze" data-show="snoozed">' + I('bell') + esc(s('set.unsnooze')) + '</button></div>' +
      '<div class="st-actions"><button class="btn" data-act="test">' + I('bell') + esc(s('set.notify.test')) + '</button>' +
      '<span class="st-ok" data-text="tested" hidden>' + I('check') + '<span>' + esc(s('set.notify.tested')) + '</span></span></div>'
    );
  }

  function secFrequency() {
    var u = s('set.secondsUnit');
    return section('frequency', s('set.nav.frequency'),
      '<div id="modeCards">' + Modes.cards(s, state.freq) + '</div>' +
      '<div class="st-now"><span class="st-now-ic" data-now-icon>' + I('clock') + '</span><span data-text="now"></span></div>' +
      '<div class="st-card st-custom" id="customPanel">' +
        '<p class="st-custom-hint">' + I('sliders') + '<span>' + esc(s('set.customHint')) + '</span></p>' +
        '<h3 class="st-h3">' + esc(s('set.g.interval')) + '</h3>' +
        sliderRow('checkSeconds', s('set.check'), s('set.checkHint')) +
        sliderRow('backgroundSeconds', s('set.background'), s('set.backgroundHint'), 'bg-row') +
        sliderRow('actionsSeconds', s('set.actions'), s('set.actionsHint')) +
        '<h3 class="st-h3">' + esc(s('set.g.saver')) + '</h3>' +
        '<p class="st-hint st-block">' + esc(s('set.saverHint')) + '</p>' +
        rule('idle', sentence(s('set.idle'), [num('idle.minutes', '', s('set.idle')), num('idle.seconds', u, s('set.idle'))])) +
        rule('lowBattery', sentence(s('set.lowBattery'), [num('lowBattery.percent', '', s('set.lowBattery')), num('lowBattery.seconds', u, s('set.lowBattery'))])) +
        rule('lowPowerMode', sentence(s('set.lowPower'), [num('lowPowerMode.seconds', u, s('set.lowPower'))])) +
        '<div class="st-rule">' + miniSwitch('pluggedInUsesNormal', s('set.plugged')) + '<div class="st-rule-text">' + esc(s('set.plugged')) + '</div></div>' +
        '<h3 class="st-h3">' + esc(s('set.g.hours')) + '</h3>' +
        '<div class="st-rule" data-rule="activeHours">' + miniSwitch('activeHours.enabled', s('set.hours')) +
          '<div class="st-rule-text">' + esc(s('set.hours')) + ' <input type="time" data-field="activeHours.start" aria-label="' + esc(s('set.hours')) + '"> ' +
          esc(s('set.hoursTo')) + ' <input type="time" data-field="activeHours.end" aria-label="' + esc(s('set.hoursTo')) + '"></div></div>' +
        '<p class="st-hint st-block">' + esc(s('set.hoursHint')) + '</p>' +
        '<div class="st-estimate">' + I('globe') + '<div><b>' + esc(s('set.estimate')) + ':</b> <span data-text="estimate"></span>' +
        '<div class="mode-note" data-text="estNote"></div></div></div>' +
      '</div>'
    );
  }

  function secLook() {
    return section('look', s('set.nav.look'),
      '<h3 class="st-h3">' + esc(s('set.lang')) + '</h3>' +
      '<div class="wz-grid three" role="radiogroup">' +
        opt('language', 'auto', I('auto'), s('set.lang.auto'), s('set.lang.autoHint')) +
        opt('language', 'th', '<span class="glyph">ก</span>', s('lang.th'), s('lang.thHint')) +
        opt('language', 'en', '<span class="glyph">A</span>', s('lang.en'), s('lang.enHint')) +
      '</div>' +
      '<h3 class="st-h3">' + esc(s('set.theme')) + '</h3>' +
      '<div class="wz-grid three" role="radiogroup">' +
        opt('theme', 'light', I('sun'), s('theme.light'), '') +
        opt('theme', 'dark', I('moon'), s('theme.dark'), '') +
        opt('theme', 'system', I('auto'), s('theme.system'), s('theme.systemHint')) +
      '</div>'
    );
  }

  function secGithub() {
    return section('github', s('set.nav.github'),
      '<div class="wz-list">' + toggle('data-setting', 'actionsEnabled', 'github', s('set.gh.actions'), s('set.gh.actionsHint')) +
        toggle('data-setting', 'checksOnPass', 'check', s('gh.onPass'), s('gh.onPassHint')) +
        toggle('data-setting', 'avatarsEnabled', 'auto', s('set.gh.avatars'), s('set.gh.avatarsHint')) + '</div>' +
      '<h3 class="st-h3">' + esc(s('gh.for')) + '</h3>' +
      '<div class="wz-grid three" role="radiogroup">' +
        opt('checksFor', 'all', I('globe'), s('gh.for.all'), '') +
        opt('checksFor', 'mine', I('code'), s('gh.for.mine'), '') +
        opt('checksFor', 'team', I('branch'), s('gh.for.team'), '') +
      '</div>' +
      '<p class="st-hint st-gh-bg" data-text="ghBg"></p>' +
      '<h3 class="st-h3">' + esc(s('set.wf')) + '</h3>' +
      '<div class="wz-grid three" role="radiogroup">' +
        opt('prWorkflow', 'ask', I('auto'), s('set.wf.ask'), s('set.wf.askHint')) +
        opt('prWorkflow', 'direct', I('cloud'), s('set.wf.direct'), s('set.wf.directHint')) +
        opt('prWorkflow', 'pullRequest', I('branch'), s('set.wf.pr'), s('set.wf.prHint')) +
      '</div>' +
      '<div class="st-card st-account">' +
        '<div class="st-account-ic">' + I('github') + '</div>' +
        '<div class="st-account-text"><div class="st-label">' + esc(s('set.gh.account')) + '</div>' +
          '<div class="st-hint" data-show="signedIn">' + esc(s('set.gh.signedIn')) + '</div>' +
          '<div class="st-hint" data-show="signedOut">' + esc(s('set.gh.signedOut')) + '</div></div>' +
        '<button class="btn btn-primary" data-act="signIn" data-show="signedOut">' + I('github') + esc(s('set.gh.signIn')) + '</button>' +
        '<span class="st-ok" data-show="signedIn">' + I('check') + '</span>' +
      '</div>' +
      '<div class="st-estimate">' + I('globe') + '<div><b>' + esc(s('set.gh.estimate')) + ':</b> <span data-text="ghEstimate"></span>' +
      '<div class="mode-note">' + esc(s('set.gh.estimateNote')) + '</div></div></div>'
    );
  }

  function shell() {
    app.innerHTML =
      '<div class="st">' +
        '<header class="st-top">' +
          '<div class="st-brand">' + M.svg({ pose: 'sit', size: 68, label: 'Pug' }) +
            '<div><h1 class="st-title">' + esc(s('set.title')) + '</h1><p class="st-sub">' + esc(s('set.sub')) + '</p></div></div>' +
          '<button class="btn btn-ghost st-reset" data-act="reset">' + I('reset') + '<span>' + esc(s('set.reset')) + '</span></button>' +
        '</header>' +
        '<div class="st-notice" id="notice" role="status" aria-live="polite" hidden></div>' +
        '<div class="st-body">' +
          '<nav class="st-nav" aria-label="' + esc(s('set.title')) + '">' +
            SECTIONS.map(function (x) {
              return '<button class="st-nav-btn" data-nav="' + x.id + '">' + I(x.icon) + '<span>' + esc(s('set.nav.' + x.id)) + '</span></button>';
            }).join('') +
          '</nav>' +
          '<main class="st-main">' + secNotify() + secFrequency() + secLook() + secGithub() +
            '<footer class="st-foot"><button class="btn btn-ghost" data-act="openVs">' + I('gear') + esc(s('set.openVs')) + '</button></footer>' +
          '</main>' +
        '</div>' +
      '</div>';
  }

  // ---------- patching values ----------
  function getField(cfg, field) {
    var p = field.split('.');
    return p.length > 1 ? cfg[p[0]][p[1]] : cfg[p[0]];
  }
  function setSwitch(el, on) {
    el.classList.toggle('is-on', !!on);
    el.setAttribute('aria-checked', String(!!on));
  }

  function update() {
    var st = state.settings;
    var f = state.freq;
    var cfg = f.config;
    document.querySelectorAll('[data-setting]').forEach(function (el) {
      var key = el.getAttribute('data-setting');
      setSwitch(el, key === 'notifyBackground' ? st[key] && init.bgSupported : st[key]);
    });
    document.querySelectorAll('[data-group]').forEach(function (el) {
      setSwitch(el, st[el.getAttribute('data-group')] === el.getAttribute('data-value'));
    });
    document.querySelectorAll('.mini-sw[data-field]').forEach(function (el) {
      setSwitch(el, getField(cfg, el.getAttribute('data-field')));
    });
    document.querySelectorAll('input[data-field]').forEach(function (el) {
      if (el === document.activeElement) return;
      el.value = getField(cfg, el.getAttribute('data-field'));
    });
    document.querySelectorAll('input[data-range]').forEach(function (el) {
      if (el.matches(':active')) return;
      el.value = getField(cfg, el.getAttribute('data-range'));
      fillRange(el);
    });
    document.querySelectorAll('[data-human]').forEach(function (el) {
      el.textContent = human(getField(cfg, el.getAttribute('data-human')));
    });
    // A rule's inputs are dimmed while the rule is off.
    ['idle', 'lowBattery', 'lowPowerMode', 'activeHours'].forEach(function (r) {
      var row = document.querySelector('[data-rule="' + r + '"]');
      if (row) row.classList.toggle('is-off', !cfg[r].enabled);
    });
    var bgRow = document.querySelector('.bg-row');
    bgRow.classList.toggle('is-off', !st.notifyBackground);
    document.querySelector('[data-hint="backgroundSeconds"]').textContent = st.notifyBackground ? s('set.backgroundHint') : s('set.backgroundOff');
    document.getElementById('customPanel').classList.toggle('is-custom', f.mode === 'custom');

    patchCards(f);
    text('now', f.nowText || '');
    var nowIc = document.querySelector('[data-now-icon]');
    nowIc.classList.toggle('slow', !!(f.effective && f.effective.reason !== 'normal' && f.effective.reason !== 'pluggedIn'));
    var est = Modes.estimateLine(s, f.estimates.check);
    if (st.notifyBackground && init.bgSupported) est += ' · ' + s('set.background') + ': ' + Modes.estimateLine(s, f.estimates.background);
    text('estimate', est);
    text('estNote', s('est.note', Math.max(1, f.repoCount)));
    text('ghEstimate', Modes.estimateLine(s, f.estimates.actions));
    var snoozed = f.snoozeUntil && f.snoozeUntil > Date.now();
    document.querySelectorAll('[data-show]').forEach(function (el) {
      var want = el.getAttribute('data-show');
      if (want === 'snoozed') el.hidden = !snoozed;
      else if (want === 'notSnoozed') el.hidden = !!snoozed;
      else el.hidden = want === 'signedIn' ? !f.signedIn : !!f.signedIn;
    });
    text('snoozed', snoozed ? s('set.snoozed', new Date(f.snoozeUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })) : '');
    document.querySelectorAll('input[data-time]').forEach(function (el) {
      if (el !== document.activeElement) el.value = st[el.getAttribute('data-time')];
    });
    var q = document.querySelector('[data-rule="quiet"]');
    if (q) q.classList.toggle('is-off', !st.quietEnabled);
    text('ghBg', s(f.ghFound ? 'gh.bgYes' : 'gh.bgNo') + ' ' + s('gh.githubOnly'));
  }
  function text(name, value) {
    var el = document.querySelector('[data-text="' + name + '"]');
    if (el) el.textContent = value;
  }
  function fillRange(el) {
    var min = Number(el.min), max = Number(el.max);
    el.style.setProperty('--fill', ((Number(el.value) - min) / (max - min)) * 100 + '%');
  }
  function patchCards(f) {
    var holder = document.createElement('div');
    holder.innerHTML = Modes.cards(s, f);
    document.querySelectorAll('#modeCards .mode-card').forEach(function (b) {
      var twin = holder.querySelector('[data-mode="' + b.getAttribute('data-mode') + '"]');
      b.querySelector('.mode-every').textContent = twin.querySelector('.mode-every').textContent;
      b.querySelector('.mode-est').innerHTML = twin.querySelector('.mode-est').innerHTML;
      setSwitch(b, f.mode === b.getAttribute('data-mode'));
      b.classList.toggle('is-on', f.mode === b.getAttribute('data-mode'));
    });
  }

  var noticeTimer;
  function notice(msg, fields) {
    var el = document.getElementById('notice');
    el.innerHTML = I('warn') + '<span>' + esc(msg) + '</span>';
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { el.hidden = true; }, 7000);
    (fields || []).forEach(function (f) {
      document.querySelectorAll('[data-field="' + f + '"]').forEach(function (inp) {
        inp.classList.remove('flash');
        void inp.offsetWidth;
        inp.classList.add('flash');
      });
    });
  }

  // ---------- events ----------
  function sendField(field, value) {
    var patch = {};
    patch[field] = value;
    post({ type: 'setValues', patch: patch });
  }

  var resetArmed;
  app.addEventListener('click', function (e) {
    var card = e.target.closest('.mode-card');
    if (card) {
      Modes.pick(card);
      post({ type: 'setMode', mode: card.getAttribute('data-mode') });
      if (card.getAttribute('data-mode') === 'custom') {
        document.getElementById('customPanel').classList.add('is-custom');
      }
      return;
    }
    var tg = e.target.closest('[data-setting]');
    if (tg && !tg.disabled) {
      var on = !tg.classList.contains('is-on');
      setSwitch(tg, on);
      post({ type: 'setSetting', key: tg.getAttribute('data-setting'), value: on });
      return;
    }
    var mini = e.target.closest('.mini-sw');
    if (mini) {
      var v = !mini.classList.contains('is-on');
      setSwitch(mini, v);
      sendField(mini.getAttribute('data-field'), v);
      return;
    }
    var o = e.target.closest('[data-group]');
    if (o) {
      var group = o.getAttribute('data-group');
      var value = o.getAttribute('data-value');
      o.parentNode.querySelectorAll('[data-group]').forEach(function (x) { setSwitch(x, x === o); });
      if (group === 'theme') applyTheme(value);
      post({ type: 'setSetting', key: group, value: value });
      return;
    }
    var nav = e.target.closest('[data-nav]');
    if (nav) {
      document.getElementById('sec-' + nav.getAttribute('data-nav')).scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    var act = e.target.closest('[data-act]');
    if (!act) return;
    var a = act.getAttribute('data-act');
    if (a === 'test') {
      post({ type: 'test' });
      var ok = document.querySelector('[data-text="tested"]');
      ok.hidden = false;
      ok.classList.remove('pop');
      void ok.offsetWidth;
      ok.classList.add('pop');
    } else if (a === 'snooze' || a === 'unsnooze') {
      post({ type: a });
    } else if (a === 'signIn') {
      post({ type: 'signIn' });
    } else if (a === 'openVs') {
      post({ type: 'openVsSettings' });
    } else if (a === 'reset') {
      var label = act.querySelector('span');
      if (!resetArmed) {
        act.classList.add('armed');
        label.textContent = s('set.resetConfirm');
        resetArmed = setTimeout(function () {
          resetArmed = null;
          act.classList.remove('armed');
          label.textContent = s('set.reset');
        }, 4000);
      } else {
        clearTimeout(resetArmed);
        resetArmed = null;
        act.classList.remove('armed');
        label.textContent = s('set.reset');
        post({ type: 'reset' });
      }
    }
  });

  app.addEventListener('input', function (e) {
    var r = e.target.closest('input[data-range]');
    if (!r) return;
    var field = r.getAttribute('data-range');
    fillRange(r);
    var n = document.querySelector('input[type="number"][data-field="' + field + '"]');
    if (n) n.value = r.value;
    var h = document.querySelector('[data-human="' + field + '"]');
    if (h) h.textContent = human(Number(r.value));
  });

  app.addEventListener('change', function (e) {
    var r = e.target.closest('input[data-range]');
    if (r) return sendField(r.getAttribute('data-range'), Number(r.value));
    var tm = e.target.closest('input[data-time]');
    if (tm) {
      if (/^\d\d:\d\d$/.test(tm.value)) post({ type: 'setSetting', key: tm.getAttribute('data-time'), value: tm.value });
      return;
    }
    var inp = e.target.closest('input[data-field]');
    if (!inp) return;
    var field = inp.getAttribute('data-field');
    sendField(field, inp.type === 'time' ? inp.value : inp.value === '' ? NaN : Number(inp.value));
  });

  app.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.matches('input[data-field]')) e.target.blur();
  });

  function applyTheme(theme) {
    var root = document.documentElement;
    root.className = root.className.replace(/\btheme-[a-z]+\b/, 'theme-' + theme);
  }

  function watchSections() {
    var navs = {};
    document.querySelectorAll('[data-nav]').forEach(function (b) { navs[b.getAttribute('data-nav')] = b; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        Object.keys(navs).forEach(function (k) { navs[k].classList.toggle('is-on', k === en.target.getAttribute('data-sec')); });
      });
    }, { rootMargin: '-20% 0px -70% 0px' });
    document.querySelectorAll('.st-sec').forEach(function (sec) { io.observe(sec); });
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'state') {
      var first = !state.freq;
      state.settings = m.settings;
      state.freq = m.freq;
      if (first) {
        shell();
        watchSections();
      }
      update();
      if (first && init.section) {
        var sec = document.getElementById('sec-' + init.section);
        if (sec) sec.scrollIntoView({ block: 'start' });
      }
      if (m.notice) notice(m.notice, m.adjusted);
    } else if (m.type === 'theme') {
      applyTheme(m.theme);
    } else if (m.type === 'section') {
      var el = document.getElementById('sec-' + m.section);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  post({ type: 'ready' });
})();
