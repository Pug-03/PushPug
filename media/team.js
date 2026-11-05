// "ทีมของฉัน / My Team" sidebar. Plain JS; keeps DOM nodes alive between
// updates so new commits can slide in and the mascot can change pose smoothly.
(function () {
  'use strict';
  var vscode = acquireVsCodeApi();
  var init = JSON.parse(document.getElementById('pp-init').textContent);
  var M = window.PushPugMascot;
  var I = window.PushPugIcon;
  var S = init.strings;
  var lang = init.lang;
  var view = init.view;
  var app = document.getElementById('app');

  var seenShas = null; // shas already rendered (null = first render, no entrance animation)
  var expanded = {}; // sha → checks panel open
  var details = {}; // "sha|checkId" → failure detail (null while loading)
  var undoUntil = 0; // when the "undo the last merge" offer ends (ms)
  var celebratedAt = (vscode.getState() || {}).celebratedAt || 0;
  var successUntil = 0;
  var currentMode = '';
  var currentRoot = '';

  function s(key) {
    var args = Array.prototype.slice.call(arguments, 1);
    return (S[key] || key).replace(/\{(\d+)\}/g, function (m, i) { return args[i] !== undefined ? args[i] : m; });
  }
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function post(m) { vscode.postMessage(m); }

  var rtf = (function () { try { return new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }); } catch (e) { return null; } })();
  function ago(sec) {
    var d = Math.round(sec - Date.now() / 1000);
    var a = Math.abs(d);
    if (a < 45 || !rtf) return lang === 'th' ? 'เมื่อสักครู่' : 'just now';
    if (a < 3600) return rtf.format(Math.round(d / 60), 'minute');
    if (a < 86400) return rtf.format(Math.round(d / 3600), 'hour');
    if (a < 86400 * 30) return rtf.format(Math.round(d / 86400), 'day');
    return new Date(sec * 1000).toLocaleDateString(lang === 'th' ? 'th-TH' : 'en-US', { day: 'numeric', month: 'short' });
  }

  // Same person → same colour, always.
  function hue(key) {
    var h = 0;
    for (var i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
    return h % 360;
  }
  function initials(name) {
    var parts = String(name || '?').trim().split(/[\s._-]+/).filter(Boolean);
    if (parts.length === 0) return '?';
    var first = Array.from(parts[0])[0] || '?';
    var second = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] : (Array.from(parts[0])[1] || '');
    // Thai: a single leading consonant reads better than two letters.
    if (/[฀-๿]/.test(first)) return first;
    return (first + second).toUpperCase();
  }
  function avatar(c) {
    // Initials underneath; the profile picture covers them once it loads (and is dropped if it fails).
    var img = c.avatar ? '<img class="avatar-img" src="' + esc(c.avatar) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '';
    return '<span class="avatar' + (c.avatar ? ' has-img' : '') + '" data-hue="' + hue((c.email || c.author || '').toLowerCase()) + '" title="' + esc(c.author) + '">' + esc(initials(c.author)) + img + '</span>';
  }
  function applyHues(root) {
    root.querySelectorAll('[data-hue]').forEach(function (el) { el.style.setProperty('--hue', el.getAttribute('data-hue')); });
    root.querySelectorAll('img.avatar-img:not([data-wired])').forEach(function (img) {
      img.setAttribute('data-wired', '');
      img.addEventListener('error', function () { img.remove(); });
      img.addEventListener('load', function () { img.classList.add('loaded'); });
      if (img.complete && img.naturalWidth) img.classList.add('loaded');
    });
  }
  function uniqueAuthors(commits) {
    var seen = {}, out = [];
    commits.forEach(function (c) { var k = (c.email || c.author).toLowerCase(); if (!seen[k]) { seen[k] = 1; out.push(c); } });
    return out;
  }
  function basename(p) { return String(p).split('/').pop(); }
  function dirname(p) { var i = String(p).lastIndexOf('/'); return i > 0 ? p.slice(0, i) : ''; }

  // ---------- Mode ----------
  function repo() { return view.repos[view.selected] || view.repos[0]; }

  function modeOf(r) {
    if (!r) return 'empty';
    if (r.phase === 'pulling') return 'pulling';
    if (r.lastResult && r.lastResult.kind === 'ok' && r.lastResult.at > celebratedAt && Date.now() - r.lastResult.at < 8000) {
      celebratedAt = r.lastResult.at;
      vscode.setState({ celebratedAt: celebratedAt });
      successUntil = Date.now() + 3600; // long enough for the pug's jump-spin-land
      setTimeout(update, 2650);
      return 'success';
    }
    if (Date.now() < successUntil) return 'success';
    if (r.state === 'checking') return 'checking';
    if (r.state === 'conflict') return r.conflict && r.conflict.kind === 'merge' && r.conflict.files.length === 0 ? 'mergeReady' : 'conflict';
    if (r.state === 'behind') return 'behind';
    if (r.state === 'error') return 'error';
    if (r.state === 'noUpstream') return 'noUpstream';
    if (r.state === 'detached') return 'detached';
    return 'upToDate';
  }

  // Pug poses (media/mascot.js) for each hero state.
  var POSE = {
    empty: 'welcome', checking: 'check', pulling: 'merge', success: 'success', conflict: 'conflict', mergeReady: 'pass',
    behind: 'alert', error: 'fail', noUpstream: 'check', detached: 'conflict', upToDate: 'sleep'
  };
  /** Up to date, but GitHub Actions just finished: show how it went. */
  function poseFor(mode, r) {
    if (mode === 'upToDate' && r && r.ci) {
      if (r.ci.state === 'failure') return 'fail';
      if (r.ci.state === 'success') return 'pass';
      if (r.ci.state === 'running') return 'check';
    }
    return POSE[mode] || 'sit';
  }

  // ---------- Pieces ----------
  function mergeArt() {
    // Two branch lanes meet; commit dots travel along them (transform only).
    return (
      '<svg class="merge-art" viewBox="0 0 168 64" aria-hidden="true">' +
        '<path class="lane lane-a" d="M8 14 L84 32 L160 32"/>' +
        '<path class="lane lane-b" d="M8 50 L84 32"/>' +
        '<g class="flow flow-a"><circle r="4.5" class="dot dot-a" /></g>' +
        '<g class="flow flow-a f2"><circle r="4.5" class="dot dot-a" /></g>' +
        '<g class="flow flow-b"><circle r="4.5" class="dot dot-b" /></g>' +
        '<g class="flow flow-b f2"><circle r="4.5" class="dot dot-b" /></g>' +
        '<circle class="meet" cx="84" cy="32" r="7"/>' +
        '<circle class="end" cx="160" cy="32" r="5.5"/>' +
      '</svg>'
    );
  }
  function checkArt() {
    return (
      '<svg class="check-art" viewBox="0 0 64 64" aria-hidden="true">' +
        '<defs><clipPath id="ckclip"><rect class="ck-reveal" x="0" y="0" width="64" height="64"/></clipPath></defs>' +
        '<circle class="ck-ring" cx="32" cy="32" r="28"/>' +
        '<path class="ck-mark" clip-path="url(#ckclip)" d="M19 33.5 L28.5 43 L46 23"/>' +
      '</svg>'
    );
  }

  function heroHtml(mode, r) {
    var title = '', sub = '', actions = '', art = '';
    switch (mode) {
      case 'empty':
        title = s('team.noRepo.title'); sub = s('team.noRepo.body');
        actions = btn('primary', 'folder', s('team.openFolder'), 'cmd', 'openFolder') + btn('', 'cloud', s('team.clone'), 'cmd', 'clone');
        break;
      case 'checking':
        title = '…'; sub = '';
        break;
      case 'upToDate':
        title = s('team.upToDate'); sub = s('team.upToDateSub');
        break;
      case 'behind': {
        var who = uniqueAuthors(r.incoming).map(function (c) { return c.author; });
        title = r.behind === 1 ? s('team.behindOne', r.behind) : s('team.behindMany', r.behind);
        sub = who.length ? s('team.behindSub', who.join(', ')) : '';
        actions = btn('primary btn-lg btn-block', 'pull', s('team.pull'), 'pull');
        break;
      }
      case 'pulling':
        art = mergeArt();
        title = s('team.pulling'); sub = s('team.pullingSub');
        break;
      case 'success':
        art = checkArt();
        title = s('team.success'); sub = s('team.successSub', r.lastResult ? r.lastResult.pulled : 0);
        break;
      case 'conflict':
        title = s('team.conflict.' + (r.conflict ? r.conflict.kind : 'other'));
        sub = r.conflict && r.conflict.kind === 'autostash' ? s('team.conflict.autostashSub') : s('team.conflict.mergeSub');
        break;
      case 'mergeReady':
        title = s('team.conflict.ready'); sub = '';
        actions = btn('primary btn-lg btn-block', 'check', s('team.finishMerge'), 'finishMerge');
        break;
      case 'error':
        title = s('team.error.title'); sub = r.error ? r.error.text : '';
        actions = btn('', 'refresh', s('team.retry'), 'check') + (r.error && r.error.raw ? btn('ghost', 'help', s('team.error.full'), 'fullError') : '');
        break;
      case 'noUpstream':
        title = s('team.noUpstream.title'); sub = s('team.noUpstream.body', r.branch || '');
        actions = btn('primary', 'cloud', s('team.publish'), 'cmd', 'publish');
        break;
      case 'detached':
        title = s('team.detached.title'); sub = s('team.detached.body');
        actions = btn('primary', 'branch', s('team.switchBranch'), 'cmd', 'switchBranch');
        break;
    }
    return (
      '<div class="hero-art">' +
        '<div class="hero-mascot" id="mascotHost"></div>' +
        (art ? '<div class="hero-extra">' + art + '</div>' : '') +
      '</div>' +
      '<div class="hero-text">' +
        '<h2 class="hero-title">' + esc(title) + '</h2>' +
        (sub ? '<p class="hero-sub">' + esc(sub) + '</p>' : '') +
      '</div>' +
      (actions ? '<div class="hero-actions">' + actions + '</div>' : '')
    );
  }

  function btn(kind, icon, label, act, arg) {
    return '<button class="btn ' + (kind ? kind.split(' ').map(function (k) { return k.indexOf('btn') === 0 ? k : 'btn-' + k; }).join(' ') : '') + '" data-act="' + act + '"' + (arg ? ' data-arg="' + esc(arg) + '"' : '') + '>' + I(icon) + '<span>' + esc(label) + '</span></button>';
  }

  function sameFileHtml(r) {
    if (!r || r.state !== 'behind' || !r.overlap.length) return '';
    var who = uniqueAuthors(r.incoming)[0];
    return (
      '<section class="alert-card warn" role="alert">' +
        '<div class="alert-head">' + I('warn') + '<strong>' + esc(s('team.sameFile')) + '</strong></div>' +
        '<p>' + esc(s('team.sameFileBody', who ? who.author : '')) + '</p>' +
        '<ul class="files">' + r.overlap.slice(0, 6).map(function (f) {
          return '<li><button class="file-link" data-act="openFile" data-arg="' + esc(f) + '">' + I('file') + '<span class="fname">' + esc(basename(f)) + '</span><span class="fdir">' + esc(dirname(f)) + '</span></button></li>';
        }).join('') + '</ul>' +
      '</section>'
    );
  }

  function conflictHtml(r, mode) {
    if (mode !== 'conflict' || !r.conflict) return '';
    var auto = r.conflict.kind === 'autostash';
    var files = r.conflict.files;
    return (
      '<section class="alert-card danger">' +
        '<div class="files-label">' + esc(s('team.conflict.files')) + ' · ' + files.length + '</div>' +
        '<ul class="cf-files">' + files.map(function (f) {
          return '<li><span class="cf-ic">' + I('file') + '</span><span class="cf-name"><span class="fname">' + esc(basename(f)) + '</span><span class="fdir">' + esc(dirname(f)) + '</span></span>' +
            '<button class="btn btn-sm" data-act="openFile" data-arg="' + esc(f) + '">' + esc(s('team.conflict.open')) + '</button></li>';
        }).join('') + '</ul>' +
        (files.length ? '<button class="btn btn-primary btn-block" data-act="mergeEditor" data-arg="' + esc(files[0]) + '">' + I('merge') + '<span>' + esc(s('team.conflict.mergeEditor')) + '</span></button>' : '') +
      '</section>' +
      '<details class="help card" open>' +
        '<summary>' + I('help') + '<span>' + esc(s('team.help.title')) + '</span></summary>' +
        '<dl>' +
          '<div><dt><span class="tag cur">' + esc(s('team.help.current')) + '</span></dt><dd>' + esc(s(auto ? 'team.help.autoCurrent' : 'team.help.mergeCurrent')) + '</dd></div>' +
          '<div><dt><span class="tag inc">' + esc(s('team.help.incoming')) + '</span></dt><dd>' + esc(s(auto ? 'team.help.autoIncoming' : 'team.help.mergeIncoming')) + '</dd></div>' +
          '<div><dt><span class="tag both">' + esc(s('team.help.bothLabel')) + '</span></dt><dd>' + esc(s('team.help.both')) + '</dd></div>' +
        '</dl>' +
        '<p class="help-tip">' + esc(s('team.help.tip')) + '</p>' +
      '</details>'
    );
  }

  function itemHtml(c) {
    return (
      '<li class="tl-item' + (c.isNew ? ' is-new' : '') + '" data-sha="' + esc(c.sha) + '">' +
        avatar(c) +
        '<div class="tl-body">' +
          '<div class="tl-subject">' + esc(c.subject) + '</div>' +
          '<div class="tl-meta"><span class="tl-author">' + esc(c.author) + '</span><span class="sep">·</span><time>' + esc(ago(c.time)) + '</time><span class="sep">·</span><span class="mono">' + esc(c.sha.slice(0, 7)) + '</span></div>' +
        '</div>' +
        (c.isNew ? '<span class="tl-new"><i class="pulse"></i>' + esc(s('team.new')) + '</span>' : '') +
        badgeHtml(c) +
        (c.checks && expanded[c.sha] ? checksPanel(c) : '') +
      '</li>'
    );
  }

  // ---------- GitHub checks ----------
  var CK_ICONS = {
    pending: '<svg class="ck-ic ck-spin" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" class="ck-track"/><path d="M8 2a6 6 0 0 1 6 6" class="ck-arc"/></svg>',
    success: '<svg class="ck-ic ck-draw" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" class="ck-disc"/><path d="M4.6 8.3 7 10.6l4.4-5" class="ck-tick"/></svg>',
    failure: '<svg class="ck-ic ck-shake" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" class="ck-disc"/><path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" class="ck-x"/></svg>',
    skipped: '<svg class="ck-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" class="ck-track"/><path d="M4.5 11.5l7-7" class="ck-slash"/></svg>'
  };
  CK_ICONS.cancelled = CK_ICONS.skipped;

  function badgeHtml(c) {
    if (!c.checks) return '';
    var k = c.checks;
    return '<button class="ck-badge ck-' + k.state + '" data-act="toggleChecks" data-arg="' + esc(c.sha) + '" aria-expanded="' + !!expanded[c.sha] + '" title="' + esc(s('team.checks.title')) + '">' +
      CK_ICONS[k.state] + '<span>' + k.passed + '/' + k.total + '</span></button>';
  }

  function dur(sec) {
    if (sec === undefined || sec === null) return '';
    return sec < 60 ? s('unit.s', sec) : sec % 60 ? s('unit.minS', Math.floor(sec / 60), sec % 60) : s('unit.min', sec / 60);
  }

  function checksPanel(c) {
    return '<div class="ck-panel"><ul class="ck-list">' + c.checks.items.map(function (i) {
      var key = c.sha + '|' + i.id;
      var open = Object.prototype.hasOwnProperty.call(details, key);
      return '<li class="ck-item ck-' + i.state + '">' +
        '<div class="ck-row">' + CK_ICONS[i.state] +
          '<span class="ck-name">' + esc(i.name) + '</span>' +
          '<span class="ck-state">' + esc(s('team.check.state.' + i.state)) + (i.duration !== undefined ? ' · ' + esc(dur(i.duration)) : '') + '</span>' +
          (i.canExplain ? '<button class="ck-why" data-act="why" data-arg="' + esc(key) + '" aria-expanded="' + open + '">' + esc(s('team.check.why')) + '</button>' : '') +
        '</div>' +
        (open ? detailHtml(details[key], i) : '') +
      '</li>';
    }).join('') + '</ul></div>';
  }

  function detailHtml(d, item) {
    if (d === null) return '<div class="ck-detail"><span class="ck-loading">' + CK_ICONS.pending + esc(s('team.check.loading')) + '</span></div>';
    var parts = '';
    if (d && d.step) parts += '<div class="ck-step">' + esc(s('team.check.step', d.step)) + '</div>';
    if (d && d.kind) parts += '<p class="ck-explain">' + esc(s('team.check.kind.' + d.kind)) + '</p>';
    parts += d && d.log && d.log.length ? '<pre class="ck-log">' + esc(d.log.join('\n')) + '</pre>' : '<p class="ck-explain muted">' + esc(s('team.check.noLog')) + '</p>';
    var url = (d && d.url) || item.url;
    if (url) parts += '<button class="btn btn-sm" data-act="openUrl" data-arg="' + esc(url) + '">' + I('cloud') + '<span>' + esc(s('team.check.open')) + '</span></button>';
    return '<div class="ck-detail">' + parts + '</div>';
  }

  // ---------- undo the last merge ----------
  function undoHtml(r) {
    if (!r || !(undoUntil > Date.now())) return '';
    return '<section class="undo-card"><div class="undo-text"><b>' + esc(s('team.undo')) + '</b><span id="undoLeft">' + esc(s('team.undoHint', mmss(undoUntil - Date.now()))) + '</span></div>' +
      '<button class="btn btn-sm" data-act="undo">' + I('refresh') + '<span>' + esc(s('team.undoBtn')) + '</span></button></section>';
  }
  function mmss(ms) {
    var t = Math.max(0, Math.round(ms / 1000));
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }

  // ---------- task branch and its pull request ----------
  function prHtml(r, mode) {
    var p = r && r.pr;
    if (!p || mode === 'empty' || mode === 'checking') return '';
    if (p.onBase) {
      // Each person picks how commits on main reach the team: straight to main, via pull request, or ask.
      if (p.workflow === 'direct') return '';
      if (p.unpushed > 0 && p.workflow !== 'pullRequest') {
        return '<section class="alert-card pr-card">' +
          '<div class="alert-head">' + I('cloud') + '<strong>' + esc(s('team.pr.unsentAsk', p.unpushed, p.base)) + '</strong></div>' +
          '<p>' + esc(s('team.pr.unsentAskHint', p.unpushed, p.base)) + '</p>' +
          '<div class="pr-actions">' + btn('primary sm', 'cloud', s('team.pr.pushMain', p.base), 'push') + btn('sm', 'branch', s('team.pr.sendPr'), 'pr', 'send') + '</div></section>';
      }
      if (p.unpushed > 0) {
        return '<section class="alert-card warn pr-card">' +
          '<div class="alert-head">' + I('branch') + '<strong>' + esc(s('team.pr.unsent', p.unpushed, p.base)) + '</strong></div>' +
          '<p>' + esc(s('team.pr.unsentHint', p.unpushed, p.base)) + '</p>' +
          '<div class="pr-actions">' + btn('primary sm', 'cloud', s('team.pr.send'), 'pr', 'send') + '</div></section>';
      }
      return '<section class="pr-row"><div class="pr-text"><b>' + I('branch') + esc(s('team.pr.onBase', p.base)) + '</b><span>' + esc(s('team.pr.onBaseHint')) + '</span></div>' +
        btn('sm', 'branch', s('team.pr.start'), 'pr', 'startTask') + '</section>';
    }
    var pr = p.pr;
    var status = pr ? pr.status : 'none';
    var line;
    var buttons = '';
    if (!pr) {
      line = p.unpushed ? s('team.pr.none', p.unpushed) : s('team.pr.noCommits');
      if (p.unpushed) buttons = btn('primary sm', 'cloud', s('team.pr.send'), 'pr', 'send');
    } else if (status === 'merged') {
      line = s('team.pr.merged', pr.number);
      buttons = btn('primary sm', 'check', s('team.pr.back', p.base), 'pr', 'finishTask') + btn('sm', 'github', s('team.pr.openPr'), 'pr', 'openPr');
    } else if (status === 'closed') {
      line = s('team.pr.closed', pr.number);
      buttons = btn('sm', 'github', s('team.pr.openPr'), 'pr', 'openPr') + btn('sm', 'check', s('team.pr.back', p.base), 'pr', 'finishTask');
    } else if (status === 'conflict') {
      line = s('team.pr.conflict', pr.number, p.base);
      buttons = btn('primary sm', 'merge', s('team.pr.update', p.base), 'pr', 'updateFromMain') + btn('sm', 'github', s('team.pr.openPr'), 'pr', 'openPr');
    } else {
      line = s(status === 'draft' ? 'team.pr.draft' : 'team.pr.open', pr.number);
      buttons = btn('sm', 'github', s('team.pr.openPr'), 'pr', 'openPr') + (r.ahead > 0 || !r.upstream ? btn('sm', 'cloud', s('team.pr.sendAgain'), 'pr', 'send') : '');
    }
    var tone = status === 'conflict' ? ' warn' : status === 'merged' ? ' ok' : '';
    return '<section class="alert-card pr-card' + tone + '">' +
      '<div class="alert-head">' + I('branch') + '<strong>' + esc(s('team.pr.task', p.branch)) + '</strong></div>' +
      '<p class="pr-status" data-status="' + esc(status) + '"><i class="state-dot"></i>' + esc(line) + '</p>' +
      (pr && pr.title ? '<p class="pr-title">' + esc(pr.title) + '</p>' : '') +
      (buttons ? '<div class="pr-actions">' + buttons + '</div>' : '') +
    '</section>';
  }

  function timelineHtml(r, mode) {
    if (!r || mode === 'empty' || mode === 'noUpstream' || mode === 'detached' || mode === 'checking') return '';
    var fresh = r.recent.filter(function (c) { return c.isNew; });
    var old = r.recent.filter(function (c) { return !c.isNew; });
    var html = '';
    if (fresh.length) html += '<h3 class="tl-title"><span class="live-dot"></span>' + esc(s('team.newSection')) + '</h3><ol class="tl">' + fresh.map(itemHtml).join('') + '</ol>';
    html += '<h3 class="tl-title">' + esc(s('team.recentSection', r.upstream || r.branch || '')) + '</h3>';
    html += old.length ? '<ol class="tl">' + old.map(itemHtml).join('') + '</ol>' : '<p class="tl-empty">' + esc(s('team.empty', r.upstream || '')) + '</p>';
    return html;
  }

  function reposHtml() {
    if (view.repos.length < 2) return '';
    return (
      '<nav class="repos" aria-label="' + esc(s('team.repos')) + '">' +
        view.repos.map(function (r, i) {
          var dot = r.state === 'conflict' ? 'danger' : r.state === 'behind' ? 'warn' : r.state === 'error' ? 'muted' : 'ok';
          return '<button class="repo-pill' + (i === view.selected ? ' is-on' : '') + '" data-act="select" data-arg="' + esc(r.root) + '" aria-pressed="' + (i === view.selected) + '">' +
            '<i class="state-dot ' + dot + '"></i><span>' + esc(r.name) + '</span>' + (r.behind ? '<b>' + r.behind + '</b>' : '') + '</button>';
        }).join('') +
      '</nav>'
    );
  }

  function footerHtml(r) {
    if (!r || !r.checkedAt) return '';
    return '<footer class="foot"><span>' + esc(s('team.checked', ago(r.checkedAt / 1000))) + '</span>' +
      '<span class="foot-actions"><button class="icon-btn" data-act="push" title="' + esc(s('team.push')) + '" aria-label="' + esc(s('team.push')) + '">' + I('cloud') + '</button>' +
      '<button class="icon-btn" data-act="check" title="' + esc(s('team.checkNow')) + '" aria-label="' + esc(s('team.checkNow')) + '">' + I('refresh') + '</button></span></footer>';
  }

  // ---------- Render ----------
  function shell() {
    app.innerHTML =
      '<div class="tm">' +
        '<div id="repos"></div>' +
        '<section class="hero card" id="hero" aria-live="polite"></section>' +
        '<div id="alerts"></div>' +
        '<div id="timeline"></div>' +
        '<div id="foot"></div>' +
      '</div>';
    app.addEventListener('click', onClick);
  }

  var mascotEl = null;
  function ensureMascot(pose, firstTime) {
    var host = document.getElementById('mascotHost');
    if (!host) return;
    if (!mascotEl) {
      host.innerHTML = M.svg({ pose: pose, size: 140, enter: firstTime, label: 'Pug' });
      mascotEl = host.firstChild;
    } else {
      host.appendChild(mascotEl);
      M.setPose(mascotEl, pose);
    }
  }

  function update() {
    var r = repo();
    var mode = modeOf(r);
    var root = r ? r.root : '';
    document.getElementById('repos').innerHTML = reposHtml();

    var hero = document.getElementById('hero');
    var heroKey = mode + '|' + root + '|' + (r ? r.behind + '|' + (r.conflict ? r.conflict.files.length : '') + '|' + (r.error ? r.error.code : '') + '|' + (r.ci ? r.ci.state : '') : '');
    if (heroKey !== hero.getAttribute('data-key')) {
      var changed = currentMode && (mode !== currentMode || root !== currentRoot);
      var firstTime = !currentMode;
      hero.setAttribute('data-key', heroKey);
      hero.setAttribute('data-mode', mode);
      if (mascotEl && mascotEl.parentNode) mascotEl.parentNode.removeChild(mascotEl);
      hero.innerHTML = heroHtml(mode, r);
      ensureMascot(poseFor(mode, r), firstTime);
      if (changed) {
        hero.classList.remove('swap');
        void hero.offsetWidth;
        hero.classList.add('swap');
      }
      if (mode === 'success') setTimeout(function () { M.confetti(hero, 40); }, 260);
    }
    if (r) undoUntil = r.undoLeft ? Date.now() + r.undoLeft * 1000 : 0;
    // Only replace the cards when they changed: new elements replay their slide-in, so
    // re-rendering identical cards on every check made them jump. The undo countdown
    // ticks on its own (see the interval below), so its text doesn't count as a change.
    var alerts = document.getElementById('alerts');
    var alertsHtml = undoHtml(r) + prHtml(r, mode) + sameFileHtml(r) + conflictHtml(r, mode);
    var alertsKey = alertsHtml.replace(/<span id="undoLeft">[^<]*<\/span>/, '');
    if (alerts.getAttribute('data-key') !== alertsKey) {
      alerts.setAttribute('data-key', alertsKey);
      alerts.innerHTML = alertsHtml;
    }
    renderTimeline(r, mode);
    document.getElementById('foot').innerHTML = footerHtml(r);
    applyHues(app);
    currentMode = mode;
    currentRoot = root;
  }

  function renderTimeline(r, mode) {
    var host = document.getElementById('timeline');
    var key = r ? r.root : '';
    if (host.getAttribute('data-root') !== key) seenShas = null; // switching repo: no slide-in storm
    host.setAttribute('data-root', key);
    host.innerHTML = timelineHtml(r, mode);
    var items = host.querySelectorAll('.tl-item');
    var nextSeen = {};
    var delay = 0;
    items.forEach(function (li) {
      var sha = li.getAttribute('data-sha');
      nextSeen[sha] = true;
      if (seenShas && !seenShas[sha]) {
        li.classList.add('enter');
        li.style.setProperty('--d', delay + 'ms');
        delay += 70;
      }
    });
    seenShas = nextSeen;
  }

  function onClick(e) {
    var el = e.target.closest('[data-act]');
    if (!el) return;
    var act = el.getAttribute('data-act');
    var arg = el.getAttribute('data-arg');
    var r = repo();
    switch (act) {
      case 'pull': post({ type: 'pull', root: r.root }); break;
      case 'check':
        el.classList.add('spin');
        post({ type: 'check' });
        break;
      case 'openFile': post({ type: 'openFile', root: r.root, file: arg }); break;
      case 'mergeEditor': post({ type: 'mergeEditor', root: r.root, file: arg }); break;
      case 'finishMerge': post({ type: 'finishMerge', root: r.root }); break;
      case 'select':
        view.selected = view.repos.findIndex(function (x) { return x.root === arg; });
        update();
        post({ type: 'select', root: arg });
        break;
      case 'cmd': post({ type: 'command', id: arg }); break;
      case 'toggleChecks':
        expanded[arg] = !expanded[arg];
        renderTimeline(r, currentMode);
        applyHues(app);
        break;
      case 'why': {
        if (Object.prototype.hasOwnProperty.call(details, arg)) delete details[arg];
        else {
          details[arg] = null;
          var parts = arg.split('|');
          post({ type: 'checkDetail', root: r.root, sha: parts[0], id: parts[1] });
        }
        renderTimeline(r, currentMode);
        applyHues(app);
        break;
      }
      case 'openUrl': post({ type: 'openUrl', url: arg }); break;
      case 'undo': post({ type: 'undo', root: r.root }); break;
      case 'push': post({ type: 'push', root: r.root }); break;
      case 'pr': post({ type: 'pr', root: r.root, act: arg }); break;
      case 'fullError': if (r.error) post({ type: 'fullError', text: r.error.raw || r.error.text }); break;
    }
  }

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (m.type === 'view') {
      view = m.view;
      update();
    } else if (m.type === 'checkDetail') {
      details[m.sha + '|' + m.id] = m.detail || {};
      renderTimeline(repo(), currentMode);
      applyHues(app);
    } else if (m.type === 'expandChecks') {
      expanded[m.sha] = true;
      renderTimeline(repo(), currentMode);
      applyHues(app);
      var li = document.querySelector('.tl-item[data-sha="' + m.sha + '"]');
      if (li) li.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (m.type === 'theme') {
      var root = document.documentElement;
      root.className = root.className.replace(/\btheme-[a-z]+\b/, 'theme-' + m.theme);
    }
  });

  // Undo countdown.
  setInterval(function () {
    var el = document.getElementById('undoLeft');
    if (!el) return;
    if (undoUntil <= Date.now()) {
      var card = el.closest('.undo-card');
      if (card) card.remove();
      // The cards on screen no longer match the last render: redraw on the next update.
      document.getElementById('alerts').removeAttribute('data-key');
      return;
    }
    el.textContent = s('team.undoHint', mmss(undoUntil - Date.now()));
  }, 1000);

  // Keep relative times fresh.
  setInterval(function () {
    document.querySelectorAll('.tl-item time').forEach(function (t, i) {
      var li = t.closest('.tl-item');
      var c = repo() && repo().recent.filter(function (x) { return x.sha === li.getAttribute('data-sha'); })[0];
      if (c) t.textContent = ago(c.time);
    });
    var r = repo();
    var foot = document.querySelector('.foot span');
    if (r && foot) foot.textContent = s('team.checked', ago(r.checkedAt / 1000));
  }, 30000);

  shell();
  update();
  // Tell the extension whether the animation library loaded (shown in the PushPug output).
  post({ type: 'ready', diag: { gsap: !!window.gsap, morph: !!window.MorphSVGPlugin, errors: window.__ppErrors || [] } });
  window.addEventListener('error', function (e) { post({ type: 'error', message: String(e.message) + ' @ ' + String(e.filename || '').split('/').pop() + ':' + e.lineno }); });
})();
