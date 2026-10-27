// 演唱会座位登记 · 网页版前端（单页应用）
(function () {
  'use strict';

  const D = window.SEAT_DATA;
  const appEl = document.getElementById('app');
  const toastEl = document.getElementById('toast');
  const modalEl = document.getElementById('modal');

  const state = {
    token: localStorage.getItem('seat_token') || '',
    name: localStorage.getItem('seat_name') || '',
    verified: false,
    adminToken: sessionStorage.getItem('admin_token') || '',
    questions: null,
    fbPreset: null,
    seat: { dateId: '1113', tier: '', sec: '', picked: null, inputSec: '', msg: '', occ: new Set(), bookings: [] },
    view: { dateId: '1113', sec: '', keys: [], msgs: {}, msgRkey: '', lastUpd: '' },
    done: false,
    admin: {
      data: null, tab: 'stat', revealKey: '',
      name: localStorage.getItem('admin_name') || ''
    },
    timers: []
  };

  let quiz = { ans: [], fills: [], bad: [] };
  let fb = null;

  /* ---------------- 基础工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), ms || 1800);
  }

  function confirmDialog(opt) {
    return new Promise(resolve => {
      const showCancel = opt.cancelText !== null;
      modalEl.innerHTML = '<div class="dialog">' +
        '<div class="dlg-title">' + esc(opt.title || '提示') + '</div>' +
        '<div class="dlg-body">' + (opt.html || esc(opt.content || '')) + '</div>' +
        '<div class="dlg-acts">' +
        (showCancel ? '<button class="dlg-btn" id="dlgCancel">' + esc(opt.cancelText || '取消') + '</button>' : '') +
        '<button class="dlg-btn primary ' + (opt.danger ? 'danger' : '') + '" id="dlgOk">' + esc(opt.okText || '确定') + '</button>' +
        '</div></div>';
      modalEl.classList.remove('hidden');
      const close = v => {
        modalEl.classList.add('hidden');
        modalEl.innerHTML = '';
        resolve(v);
      };
      document.getElementById('dlgOk').onclick = () => close(true);
      const c = document.getElementById('dlgCancel');
      if (c) c.onclick = () => close(false);
      modalEl.onclick = e => { if (e.target === modalEl) close(false); };
    });
  }

  function showImage(src) {
    confirmDialog({
      title: '购票截图',
      html: '<img src="' + esc(src) + '" alt="购票截图">',
      cancelText: null,
      okText: '关闭'
    });
  }

  async function api(path, body, method) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['x-token'] = state.token;
    if (state.adminToken) headers['x-admin'] = state.adminToken;
    const res = await fetch('/api' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('请求失败（' + res.status + '）'));
      err.status = res.status;
      throw err;
    }
    return data || {};
  }

  function clearTimers() {
    state.timers.forEach(t => clearInterval(t));
    state.timers = [];
  }

  function go(hash) {
    const target = '#/' + hash.replace(/^#?\/?/, '');
    if (location.hash === target) route();
    else location.hash = target;
  }

  function parseRoute() {
    const raw = (location.hash || '').replace(/^#\/?/, '');
    const qi = raw.indexOf('?');
    const path = (qi >= 0 ? raw.slice(0, qi) : raw) || 'login';
    const params = {};
    if (qi >= 0) {
      raw.slice(qi + 1).split('&').filter(Boolean).forEach(pair => {
        const i = pair.indexOf('=');
        const k = i >= 0 ? pair.slice(0, i) : pair;
        const v = i >= 0 ? pair.slice(i + 1) : '';
        params[decodeURIComponent(k)] = decodeURIComponent(v);
      });
    }
    return { path, path_name: path, params };
  }

  /* ---------------- 路由 ---------------- */

  async function route() {
    clearTimers();
    modalEl.classList.add('hidden');
    const { path, params } = parseRoute();
    // 离开后台即解除管理员登录：再次进入必须重新输入秘钥，秘钥卡也只显示一次
    if (path !== 'admin') {
      state.admin.revealKey = '';
      state.adminToken = '';
      state.admin.data = null;
      sessionStorage.removeItem('admin_token');
    }
    const needAuth = ['choose', 'date', 'seat', 'view', 'feedback', 'thanks'];
    if (needAuth.indexOf(path) >= 0 && !state.verified) {
      go('#/login');
      return;
    }
    // 已完成登记的设备不能再进入选座流程
    if (state.done && (path === 'date' || path === 'seat')) {
      toast('本设备已完成登记，仅可查看座位图');
      go('#/choose');
      return;
    }
    try {
      if (path === 'login') renderLogin();
      else if (path === 'quiz') renderQuiz();
      else if (path === 'choose') renderChoose();
      else if (path === 'date') await renderDate();
      else if (path === 'seat') await renderSeat(params);
      else if (path === 'view') await renderView(params);
      else if (path === 'feedback') renderFeedback();
      else if (path === 'thanks') await renderThanks();
      else if (path === 'admin') await renderAdmin();
      else go('#/login');
    } catch (e) {
      appEl.innerHTML = '<div class="page"><div class="loading">' + esc(e.message || '加载失败') +
        '</div><div class="page" style="padding:0 40px"><button class="btn-primary" id="errHome">返回首页</button></div></div>';
      const b = document.getElementById('errHome');
      if (b) b.onclick = () => go('#/login');
    }
  }

  /* ---------------- 登录 ---------------- */

  function renderLogin() {
    const adminEntry = '<div class="admin-entry" id="adminEntry" title="管理员入口">👤</div>';
    if (state.verified) {
      appEl.innerHTML =
        '<div class="page login-page">' +
        '<div class="login-inner">' +
        '<div class="logo">🎤</div>' +
        '<div class="title">「游点意思Pro」巡回演唱会</div>' +
        '<div class="sub">梓渝 · 2026.11.13 - 11.15 · 澳门银河综艺馆</div>' +
        '<button class="btn-primary login-btn" id="continueBtn">继续进入</button>' +
        '<div class="link-line" id="switchUser">不是我，切换用户</div>' +
        '</div>' + adminEntry + '</div>';
      document.getElementById('continueBtn').onclick = () => go('#/choose');
      document.getElementById('switchUser').onclick = () => {
        state.token = ''; state.verified = false; state.done = false;
        localStorage.removeItem('seat_token');
        renderLogin();
      };
    } else {
      appEl.innerHTML =
        '<div class="page login-page">' +
        '<div class="login-inner">' +
        '<div class="logo">🎤</div>' +
        '<div class="title">「游点意思Pro」巡回演唱会</div>' +
        '<div class="sub">梓渝 · 2026.11.13 - 11.15 · 澳门银河综艺馆</div>' +
        '<input class="name-input" id="nameInput" maxlength="20" placeholder="请输入昵称（必填，所有人均可登录）" value="' + esc(state.name) + '">' +
        '<button class="btn-primary login-btn" id="loginBtn"' + (state.name ? '' : ' disabled') + '>登录并开始验证</button>' +
        '<div class="tip">无需密码 · 所有人均可登录<br>登录后需答对 3 道题，才能进入下一步</div>' +
        '</div>' + adminEntry + '</div>';
      const input = document.getElementById('nameInput');
      const btn = document.getElementById('loginBtn');
      input.addEventListener('input', () => {
        state.name = input.value.trim();
        btn.disabled = !input.value.trim();
      });
      const doLogin = async () => {
        const name = input.value.trim();
        if (!name) return toast('请输入昵称');
        btn.disabled = true;
        btn.textContent = '登录中…';
        try {
          const r = await api('/login', { name });
          state.token = r.token;
          state.name = r.name;
          state.verified = false;
          state.questions = r.questions;
          localStorage.setItem('seat_token', r.token);
          localStorage.setItem('seat_name', r.name);
          go('#/quiz');
        } catch (e) {
          toast(e.message);
          btn.disabled = false;
          btn.textContent = '登录并开始验证';
        }
      };
      btn.onclick = doLogin;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    }
    document.getElementById('adminEntry').onclick = () => go('#/admin');
  }

  /* ---------------- 答题 ---------------- */

  function renderQuiz() {
    if (!state.questions) { go('#/login'); return; }
    quiz = {
      ans: state.questions.map(q => q.type === 'choice' ? -1 : ''),
      fills: state.questions.map(() => ''),
      bad: state.questions.map(() => false)
    };
    paintQuiz();
  }

  function paintQuiz() {
    const qs = state.questions;
    const cards = qs.map((q, qi) => {
      let body;
      if (q.type === 'fill') {
        body = '<input class="qfill ' + (quiz.bad[qi] ? 'bad' : '') + '" data-qi="' + qi + '" ' +
          'placeholder="请输入答案" value="' + esc(quiz.fills[qi]) + '">' +
          (quiz.bad[qi] ? '<div class="qfeed">答案不正确，请重新填写</div>' : '');
      } else {
        body = q.options.map((opt, oi) =>
          '<div class="opt ' + (quiz.ans[qi] === oi ? 'on' : '') + '" data-qi="' + qi + '" data-oi="' + oi + '">' + esc(opt) + '</div>'
        ).join('');
      }
      return '<div class="card qcard">' +
        '<div class="q"><span>' + (qi + 1) + '. ' + esc(q.q) + '</span>' +
        '<span class="qtag ' + (q.type === 'fill' ? 'fill' : 'choice') + '">' + (q.type === 'fill' ? '填空题' : '选择题') + '</span></div>' +
        body + '</div>';
    }).join('');

    appEl.innerHTML =
      '<div class="page quiz-page">' +
      '<div class="quiz-intro">回答正确以下 ' + qs.length + ' 个问题（题库 5 道选择题 + 5 道填空题，每次随机抽取、互不重复），方可进入座位登记界面。</div>' +
      cards +
      '<button class="btn-primary" id="quizSubmit">提交验证</button>' +
      '<div class="tip">答错会自动换一组题重新作答</div>' +
      '</div>';

    appEl.querySelectorAll('.opt').forEach(el => {
      el.onclick = () => {
        const qi = Number(el.dataset.qi);
        quiz.ans[qi] = Number(el.dataset.oi);
        el.parentNode.querySelectorAll('.opt').forEach(o => o.classList.remove('on'));
        el.classList.add('on');
      };
    });
    appEl.querySelectorAll('.qfill').forEach(el => {
      el.addEventListener('input', () => {
        const qi = Number(el.dataset.qi);
        quiz.fills[qi] = el.value;
        if (quiz.bad[qi]) {
          el.classList.remove('bad');
          quiz.bad[qi] = false;
          const f = el.parentNode.querySelector('.qfeed');
          if (f) f.remove();
        }
      });
    });
    document.getElementById('quizSubmit').onclick = submitQuiz;
  }

  async function submitQuiz() {
    const qs = state.questions;
    const empty = qs.some((q, i) => q.type === 'choice' ? quiz.ans[i] < 0 : !String(quiz.fills[i] || '').trim());
    if (empty) return toast('请回答全部 ' + qs.length + ' 个问题');
    const btn = document.getElementById('quizSubmit');
    btn.disabled = true;
    btn.textContent = '校验中…';
    try {
      const r = await api('/quiz', {
        answers: qs.map((q, i) => ({ i: q.i, type: q.type, value: q.type === 'choice' ? quiz.ans[i] : quiz.fills[i] }))
      });
      if (r.ok) {
        state.verified = true;
        toast('验证通过', 1200);
        setTimeout(() => go('#/choose'), 450);
        return;
      }
      (r.wrong || []).forEach(i => { quiz.bad[i] = true; });
      paintQuiz();
      toast('答案不正确，即将换一组题目', 1600);
      setTimeout(async () => {
        try {
          const rr = await api('/quiz/retry', {});
          state.questions = rr.questions;
          renderQuiz();
        } catch (e) { toast(e.message); }
      }, 1400);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      btn.textContent = '提交验证';
    }
  }

  /* ---------------- 分流页 ---------------- */

  function renderChoose() {
    const done = state.done;
    appEl.innerHTML =
      '<div class="page choose-page">' +
      '<div class="topbar" style="width:100%"><span class="tb-home" id="toLogin">⌂ 首页</span><span class="who">' + esc(state.name) + '</span></div>' +
      '<div class="ch-head"><div class="ch-title">澳门银河综艺馆 · 座位登记</div></div>' +
      (done
        ? '<div class="ch-done-tip">本设备已完成登记，仅可查看座位图与提交反馈。</div>'
        : '<div class="ch-card" id="goFill"><div class="ch-icon">📝</div><div class="ch-name">填写座位</div>' +
          '<div class="ch-desc">选择场次日期，每天可登记 1 个座位，最多 3 个</div><div class="ch-go">开始填写 ›</div></div>') +
      '<div class="ch-card alt" id="goView"><div class="ch-icon">🗺️</div><div class="ch-name">查看座位图</div>' +
      '<div class="ch-desc">查看各场次当前已登记的座位（🌽），每 3 分钟自动更新</div><div class="ch-go">进入查看 ›</div></div>' +
      (done
        ? '<div class="ch-card" id="goFb"><div class="ch-icon">📮</div><div class="ch-name">提交反馈</div>' +
          '<div class="ch-desc">座位被他人登记？提交申诉，管理员核实后处理</div><div class="ch-go">去提交 ›</div></div>'
        : '') +
      '<div class="ch-home" id="goHome">返回首页</div>' +
      '</div>';
    if (!done) document.getElementById('goFill').onclick = () => go('#/date');
    document.getElementById('goView').onclick = () => go('#/view');
    if (done) document.getElementById('goFb').onclick = () => go('#/feedback');
    document.getElementById('goHome').onclick = () => go('#/login');
    document.getElementById('toLogin').onclick = () => go('#/login');
  }

  /* ---------------- 日期中心 ---------------- */

  async function renderDate() {
    appEl.innerHTML = '<div class="page"><div class="loading">加载中…</div></div>';
    const r = await api('/bookings');
    paintDate(r.bookings);
  }

  function paintDate(bookings) {
    const byDate = {};
    bookings.forEach(b => { byDate[b.dateId] = b; });
    const cards = D.DATES.map((d, i) => {
      const b = byDate[d.id];
      return '<div class="card date-card ' + (b ? 'on' : '') + '" data-i="' + i + '">' +
        '<div><div class="d-main">2026年' + d.label + '</div>' +
        '<div class="d-week">' + d.week + ' · 澳门银河综艺馆</div>' +
        (b ? '<div class="d-sel">已选：Sec ' + esc(b.sec) + ' · ' + esc(b.seatText) + '（' + esc(b.tierName) + '）</div>' : '') +
        '</div><div class="d-right">' + (b ? '重选 ›' : '选择 ›') + '</div></div>';
    }).join('');

    const list = bookings.map(b =>
      '<div class="ss-item"><span class="ss-txt">' + esc(b.dateLabel) + ' · Sec ' + esc(b.sec) + ' · ' +
      esc(b.seatText) + ' · ' + esc(b.tierName) + '</span>' +
      '<span class="ss-del" data-rkey="' + esc(b.rkey) + '">删除</span></div>'
    ).join('');

    appEl.innerHTML =
      '<div class="page date-page">' +
      '<div class="topbar"><span class="tb-back" id="backBtn">‹ 返回</span><span class="who">' + esc(state.name) + '</span><span class="tb-home" id="homeBtn">⌂ 首页</span></div>' +
      '<div class="hint">每位用户每天可登记 1 座，最多可选 3 天（3 座）。点击日期进入座位图选座：</div>' +
      cards +
      (bookings.length ? '<div class="sel-summary"><div class="ss-title">已选座位（' + bookings.length + '/3）</div>' + list + '</div>' : '') +
      '<button class="btn-primary confirm-btn" id="confirmBtn">确认保存' + (bookings.length ? '（' + bookings.length + ' 个座位）' : '') + '</button>' +
      '<div class="tip">座位在每天的座位图中确认时即被锁定 🌽；删除已选座位会立即释放。全部选好后点「确认保存」完成登记。</div>' +
      '</div>';

    document.getElementById('backBtn').onclick = () => go('#/choose');
    document.getElementById('homeBtn').onclick = () => go('#/login');
    appEl.querySelectorAll('.date-card').forEach(el => {
      el.onclick = () => {
        const d = D.DATES[Number(el.dataset.i)];
        go('#/seat?date=' + d.id);
      };
    });
    appEl.querySelectorAll('.ss-del').forEach(el => {
      el.onclick = async e => {
        e.stopPropagation();
        const rkey = el.dataset.rkey;
        const b = bookings.find(x => x.rkey === rkey);
        if (!b) return;
        const ok = await confirmDialog({
          title: '删除已选座位',
          content: '确定放弃 ' + b.dateLabel + ' Sec ' + b.sec + ' ' + b.seatText + ' 吗？该座位将释放给他人。',
          okText: '删除'
        });
        if (!ok) return;
        try {
          await api('/release', { rkey });
          await renderDate();
          toast('已删除并释放座位');
        } catch (err) { toast(err.message); }
      };
    });
    document.getElementById('confirmBtn').onclick = async () => {
      if (!bookings.length) return toast('请先选择至少 1 个座位');
      const btn = document.getElementById('confirmBtn');
      btn.disabled = true;
      try {
        await api('/finish', {});
        state.done = true;
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
        return;
      }
      go('#/thanks');
    };
  }

  /* ---------------- 选座页 ---------------- */

  async function renderSeat(params) {
    const S = state.seat;
    const date = D.DATES.find(d => d.id === (params.date || S.dateId)) || D.DATES[0];
    S.dateId = date.id;
    S.tier = '';
    S.sec = '';
    S.picked = null;
    S.inputSec = '';
    S.msg = '';
    appEl.innerHTML = '<div class="page seat-page"><div class="loading">加载中…</div></div>';
    const [occ, bk] = await Promise.all([api('/occ?date=' + date.id), api('/bookings')]);
    S.occ = new Set(occ.keys);
    S.bookings = bk.bookings;
    paintSeat();
  }

  function seatInfoHTML() {
    const S = state.seat;
    const mine = S.bookings.map(b =>
      '<div class="mysel">🌽 ' + esc(b.dateLabel) + ' · Sec ' + esc(b.sec) + ' · ' + esc(b.seatText) + '</div>'
    ).join('');
    let status;
    if (S.picked) status = '本场已选 Sec ' + esc(S.sec) + ' · ' + esc(S.picked.seatText);
    else if (S.sec) status = '已进入 Sec ' + esc(S.sec) + '，请点击座位';
    else if (S.tier) status = '票档已选，请选择区域';
    else status = '请先选择票档，再选择区域';
    return '<div id="seatInfo">' + mine + '<div>' + status + '</div></div>';
  }

  function overviewHTML() {
    return '<div class="ov-hint">① 选择票档 ② 点马蹄形上的区域，或输入区域编号 ③ 放大后选座</div>' +
      '<div class="ov-wrap"><canvas id="ovCanvas" class="ov-canvas"></canvas></div>' +
      '<div class="sec-input-row"><input class="sec-input" id="secInput" placeholder="输入区域编号，如 205" value="' +
      esc(state.seat.inputSec) + '"><button class="confirm-btn" id="secGo">确认</button></div>' +
      '<div class="fb-link" id="fbLink">座位被他人登记？提交反馈申诉 ›</div>';
  }

  function zoomHTML() {
    const S = state.seat;
    const sc = D.SECTIONS[S.sec];
    const total = sc.rows.reduce((a, b) => a + b, 0);
    const rows = sc.rows.map((n, r) => {
      const rt = D.rowTier(sc, r);
      const na = !!S.tier && rt !== S.tier;
      let cells = '';
      for (let s = 1; s <= n; s++) {
        const k = D.seatKey(S.dateId, S.sec, r, s);
        const occ = S.occ.has(k);
        const cls = occ ? 'occ' : (na ? 'na' : (S.picked && S.picked.rkey === k ? 'picked' : ''));
        cells += '<div class="zs ' + cls + '" data-rkey="' + esc(k) + '" data-r="' + r + '" data-s="' + s + '" data-occ="' +
          (occ ? 1 : 0) + '" data-na="' + (na ? 1 : 0) + '">' + (occ ? '🌽' : s) + '</div>';
      }
      return '<div class="zrow ' + (na ? 'narow' : '') + '" style="min-width:' + (40 + n * 23 + 40) + 'px">' +
        '<span class="zrow-label">' + D.rowLabel(r) + '排' +
        (sc.split ? '<i class="rt" style="background:' + (rt === 'b' ? '#8fd69c' : '#b18ae0') + '"></i>' : '') +
        '</span>' + cells + '<span class="zrow-label">' + D.rowLabel(r) + '排</span></div>';
    }).join('');
    const tierTxt = sc.split ? ' · 前' + sc.split + '排B档 / 后' + (sc.rows.length - sc.split) + '排C档' : '';
    return '<div class="zoom-head"><span class="back" id="backOv">‹ 返回全景</span>' +
      '<span class="zoom-title">Sec ' + esc(S.sec) + '（' + sc.rows.length + '排 / ' + total + '座）' + tierTxt + '</span></div>' +
      '<div class="zoom-scroll" style="max-height:none"><div class="zoom-grid">' + rows + '</div></div>' +
      '<div id="msgWrap">' + msgBoxHTML() + '</div>' +
      '<div class="zoom-tip">🌽 = 已登记（点击可申诉）；点空位选中；灰排不属于当前票档</div>';
  }

  function msgBoxHTML() {
    const S = state.seat;
    if (!S.picked) return '';
    return '<div class="msg-box"><div class="msg-h">💬 ' + esc(S.picked.seatText.replace('座', '号')) + '的留言</div>' +
      '<input class="msg-input" id="seatMsg" maxlength="30" placeholder="选填，最多 30 字，例如：同场的朋友，散场一起走？" value="' + esc(S.msg) + '"></div>';
  }

  function bindMsgInput() {
    const mi = document.getElementById('seatMsg');
    if (mi) {
      mi.oninput = () => { state.seat.msg = mi.value; };
      mi.addEventListener('keydown', e => e.stopPropagation());
    }
  }

  function paintSeat() {
    const S = state.seat;
    appEl.innerHTML =
      '<div class="page seat-page">' +
      '<div class="topbar"><span class="tb-back" id="backBtn">‹ 返回</span>' +
      '<span class="who">' + esc(state.name) + ' · ' +
      esc((D.DATES.find(d => d.id === S.dateId) || {}).label || '') + '</span>' +
      '<span class="tb-home" id="homeBtn">⌂ 首页</span></div>' +
      '<div class="seat-main">' + (S.sec ? zoomHTML() : overviewHTML()) + '</div>' +
      '<div class="legend"><span><i class="lg multi"></i>当前票档</span><span><i class="lg"></i>其他票档</span>' +
      '<span>🌽 本场已登记 ' + S.occ.size + '</span></div>' +
      '<div class="bottom"><div class="tiers">' +
      D.TIERS.map(t => '<div class="tier ' + (S.tier === t.id ? 'on' : '') + '" data-tier="' + t.id + '">' +
        '<div class="dot c-' + t.id + '"></div><div class="t-name">' + t.name + '</div><div class="t-price">¥' + t.price + '</div></div>').join('') +
      '</div><div class="save-row"><div class="info">' + seatInfoHTML() + '</div>' +
      '<button class="btn-primary save-btn" id="saveBtn">确认该座位</button></div></div>' +
      '</div>';

    document.getElementById('backBtn').onclick = () => go('#/date');
    document.getElementById('homeBtn').onclick = () => go('#/login');

    appEl.querySelectorAll('.tier').forEach(el => {
      el.onclick = () => {
        S.tier = el.dataset.tier;
        S.sec = '';
        S.picked = null;
        paintSeat();
      };
    });

    const cv = document.getElementById('ovCanvas');
    if (cv) {
      drawOverview(cv, { mode: 'seat', tier: S.tier });
      cv.onclick = e => {
        const id = hitOverview(cv, e.clientX, e.clientY);
        if (id) openSection(id);
      };
      const input = document.getElementById('secInput');
      const goSec = () => openSection(input.value);
      document.getElementById('secGo').onclick = goSec;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') goSec(); });
      input.addEventListener('input', () => { S.inputSec = input.value; });
      document.getElementById('fbLink').onclick = () => {
        state.fbPreset = null;
        go('#/feedback');
      };
    }

    const backOv = document.getElementById('backOv');
    if (backOv) {
      backOv.onclick = () => {
        S.sec = '';
        S.picked = null;
        paintSeat();
      };
    }
    if (S.sec) {
      appEl.querySelectorAll('.zs').forEach(el => {
        el.onclick = () => onSeatClick(el);
      });
    }

    document.getElementById('saveBtn').onclick = saveSeat;
    bindMsgInput();
  }

  function openSection(rawId) {
    const S = state.seat;
    const id = String(rawId || '').trim().toUpperCase().replace(/^SEC/, '');
    const sc = D.SECTIONS[id];
    if (!id) return toast('请输入区域编号');
    if (!sc) return toast('未找到该区域，请检查编号');
    if (!S.tier) return toast('请先选择票档');
    if (D.secTiers(sc).indexOf(S.tier) < 0) return toast('该区域不属于当前票档');
    S.sec = id;
    S.picked = null;
    paintSeat();
  }

  async function onSeatClick(el) {
    const S = state.seat;
    const sc = D.SECTIONS[S.sec];
    const r = Number(el.dataset.r);
    const s = Number(el.dataset.s);
    const k = el.dataset.rkey;
    if (el.dataset.na === '1') {
      const rt = D.rowTier(sc, r);
      return toast('该排属于' + (rt === 'b' ? 'B档 ¥980' : 'C档 ¥680') + '，不属于当前票档');
    }
    if (el.dataset.occ === '1') {
      if (S.bookings.some(b => b.rkey === k)) return toast('这是您已登记的座位');
      const ok = await confirmDialog({
        title: '座位已被登记',
        content: '该座位已被其他用户登记（🌽）。是否提交反馈申诉（需附购票截图）？',
        okText: '去申诉',
        cancelText: '取消'
      });
      if (!ok) return;
      state.fbPreset = { dateId: S.dateId, sec: S.sec, row: D.rowLabel(r), seat: s };
      go('#/feedback');
      return;
    }
    S.picked = { rkey: k, r, s, seatText: D.rowLabel(r) + '排' + s + '座' };
    appEl.querySelectorAll('.zs.picked').forEach(x => x.classList.remove('picked'));
    el.classList.add('picked');
    const info = document.getElementById('seatInfo');
    if (info) info.outerHTML = seatInfoHTML();
    const wrap = document.getElementById('msgWrap');
    if (wrap) {
      wrap.innerHTML = msgBoxHTML();
      bindMsgInput();
    }
  }

  async function saveSeat() {
    const S = state.seat;
    if (!S.sec) return toast('请先选择区域');
    if (!S.picked) return toast('请先选择座位');
    const btn = document.getElementById('saveBtn');
    btn.disabled = true;
    try {
      const r = await api('/occupy', { dateId: S.dateId, sec: S.sec, r: S.picked.r, s: S.picked.s, msg: S.msg.trim() });
      S.msg = '';
      toast('已确认（' + r.count + '/3），返回选择其他日期', 1500);
      setTimeout(() => go('#/date'), 500);
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
      if (e.status === 409) {
        const occ = await api('/occ?date=' + S.dateId);
        S.occ = new Set(occ.keys);
        paintSeat();
      }
    }
  }

  /* ---------------- 全景绘制 ---------------- */

  function sectorPath(ctx, r0, r1, ang, sp) {
    const t1 = ang - sp / 2 - 180;
    const t2 = ang + sp / 2 - 180;
    const a = t => (90 - t) * Math.PI / 180;
    ctx.beginPath();
    ctx.arc(D.CX, D.CY, r1, a(t1), a(t2), true);
    ctx.arc(D.CX, D.CY, r0, a(t2), a(t1), false);
    ctx.closePath();
  }

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawOverview(cv, opt) {
    const cssW = cv.clientWidth || 340;
    const U = cssW / D.CANVAS_W;
    const cssH = Math.round(D.CANVAS_H * U);
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    cv.style.height = cssH + 'px';
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr * U, 0, 0, dpr * U, 0, 0);
    ctx.clearRect(0, 0, D.CANVAS_W, D.CANVAS_H);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';

    const seatMode = opt.mode === 'seat';

    // 舞台
    rr(ctx, 120, 6, 120, 26, 6);
    ctx.fillStyle = '#8a8a97';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText('STAGE', 180, 19.5);

    // 内场 FLOOR 四块
    D.FLOOR_BLOCKS.forEach(item => {
      const id = item[0], x = item[1], y = item[2];
      const lit = !seatMode || opt.tier === 'vvip';
      rr(ctx, x, y, 46, 18, 5);
      ctx.fillStyle = lit ? D.TIER_COLOR.vvip : D.COLOR_IDLE;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = lit ? '#fff' : D.TEXT_IDLE;
      ctx.font = 'bold 8.5px sans-serif';
      ctx.fillText(id, x + 23, y + 9.5);
    });
    ctx.fillStyle = '#b9bac4';
    ctx.font = '7px sans-serif';
    ctx.fillText('FLOOR SEATS · VVIP', 180, 90);

    // FOH
    rr(ctx, 162, 99, 36, 12, 4);
    ctx.fillStyle = '#c9cad2';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 7.5px sans-serif';
    ctx.fillText('FOH', 180, 105.5);

    // LEVEL 标签
    ctx.fillStyle = '#9b9ca8';
    ctx.font = '7.5px sans-serif';
    [['LEVEL 3', 137], ['LEVEL 2', 103], ['LEVEL 1', 69]].forEach(item => {
      const th = -118 * Math.PI / 180;
      ctx.fillText(item[0], D.CX + item[1] * Math.sin(th), D.CY + item[1] * Math.cos(th));
    });

    // 三层马蹄形
    D.RINGS.forEach(ring => {
      const rm = (ring.r0 + ring.r1) / 2;
      ring.secs.forEach(id => {
        const sc = D.SECTIONS[id];
        if (sc.split) {
          const mid = (ring.r0 + ring.r1) / 2;
          sectorPath(ctx, ring.r0, mid, sc.ang, sc.sp);
          ctx.fillStyle = (!seatMode || opt.tier === 'b') ? D.TIER_COLOR.b : D.COLOR_IDLE;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
          sectorPath(ctx, mid, ring.r1, sc.ang, sc.sp);
          ctx.fillStyle = (!seatMode || opt.tier === 'c') ? D.TIER_COLOR.c : D.COLOR_IDLE;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        } else {
          sectorPath(ctx, ring.r0, ring.r1, sc.ang, sc.sp);
          ctx.fillStyle = (!seatMode || opt.tier === sc.t) ? D.TIER_COLOR[sc.t] : D.COLOR_IDLE;
          ctx.fill();
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
        const rad = (sc.ang - 180) * Math.PI / 180;
        const lit = !seatMode || (opt.tier && (opt.tier === sc.t || (sc.split && (opt.tier === 'b' || opt.tier === 'c'))));
        ctx.fillStyle = lit ? '#fff' : D.TEXT_IDLE;
        ctx.font = 'bold 8.5px sans-serif';
        ctx.fillText(id, D.CX + rm * Math.sin(rad), D.CY + rm * Math.cos(rad));
      });
    });
  }

  function hitOverview(cv, clientX, clientY) {
    const rect = cv.getBoundingClientRect();
    const U = rect.width / D.CANVAS_W;
    const x = (clientX - rect.left) / U;
    const y = (clientY - rect.top) / U;
    for (let i = 0; i < D.FLOOR_BLOCKS.length; i++) {
      const it = D.FLOOR_BLOCKS[i];
      if (x >= it[1] && x <= it[1] + 46 && y >= it[2] && y <= it[2] + 18) return it[0];
    }
    const dx = x - D.CX, dy = y - D.CY;
    const r = Math.sqrt(dx * dx + dy * dy);
    const ring = D.RINGS.find(g => r >= g.r0 - 2 && r <= g.r1 + 2);
    if (!ring) return null;
    let ang = Math.atan2(dx, dy) * 180 / Math.PI + 180;
    ang = (ang + 360) % 360;
    let best = '', bd = 1e9;
    ring.secs.forEach(id => {
      const sc = D.SECTIONS[id];
      const d = Math.abs(((ang - sc.ang + 540) % 360) - 180);
      if (d <= sc.sp / 2 + 0.5 && d < bd) { bd = d; best = id; }
    });
    return best || null;
  }

  /* ---------------- 座位图查看 ---------------- */

  async function renderView(params) {
    const V = state.view;
    if (params.date) V.dateId = params.date;
    if (!D.DATES.some(d => d.id === V.dateId)) V.dateId = '1113';
    V.sec = '';
    V.msgRkey = '';
    await loadView();
    state.timers.push(setInterval(() => {
      loadView(true).catch(() => { });
    }, 3 * 60 * 1000));
  }

  async function loadView(silent) {
    const V = state.view;
    try {
      const r = await api('/occ?date=' + V.dateId);
      V.keys = r.keys;
      V.msgs = r.msgs || {};
      V.lastUpd = new Date().toTimeString().slice(0, 8);
      paintView();
    } catch (e) {
      if (!silent) toast(e.message);
    }
  }

  function paintView() {
    const V = state.view;
    const date = D.DATES.find(d => d.id === V.dateId);
    let main;
    if (V.sec) {
      const sc = D.SECTIONS[V.sec];
      const total = sc.rows.reduce((a, b) => a + b, 0);
      const rows = sc.rows.map((n, r) => {
        let cells = '';
        for (let s = 1; s <= n; s++) {
          const k = D.seatKey(V.dateId, V.sec, r, s);
          const occ = V.keys.indexOf(k) >= 0;
          const hasMsg = occ && V.msgs[k];
          cells += '<div class="zs ' + (occ ? 'occ' : '') + '" data-rkey="' + esc(k) + '" data-occ="' + (occ ? 1 : 0) +
            '"' + (hasMsg ? ' data-hasmsg="1" title="点击查看留言"' : '') + '>' + (occ ? '🌽' : s) + '</div>';
        }
        return '<div class="zrow" style="min-width:' + (40 + n * 23 + 40) + 'px">' +
          '<span class="zrow-label">' + D.rowLabel(r) + '排</span>' + cells +
          '<span class="zrow-label">' + D.rowLabel(r) + '排</span></div>';
      }).join('');
      main = '<div class="zoom-head"><span class="back" id="backOv">‹ 返回全景</span>' +
        '<span class="zoom-title">' + date.label + ' · Sec ' + esc(V.sec) + '（' + sc.rows.length + '排 / ' + total + '座）</span></div>' +
        '<div class="zoom-scroll"><div class="zoom-grid">' + rows + '</div></div>' +
        '<div class="zoom-tip">🌽 = 该场次已登记的座位（点 🌽 在下方查看留言）</div>' +
        '<div class="msg-panel" id="msgPanel">' + msgPanelHTML() + '</div>';
    } else {
      main = '<div class="ov-hint">点马蹄形上的区域查看每个座位，或输入区域编号；每 3 分钟自动更新</div>' +
        '<div class="ov-wrap"><canvas id="ovCanvas" class="ov-canvas"></canvas></div>' +
        '<div class="sec-input-row"><input class="sec-input" id="secInput" placeholder="输入区域编号，如 205" value="' +
        esc(V.inputSec || '') + '"><button class="confirm-btn blue" id="secGo">查看</button></div>';
    }

    appEl.innerHTML =
      '<div class="page vm-page">' +
      '<div class="topbar"><span class="tb-back" id="backBtn">‹ 返回</span><span class="who">座位图 · 只读</span>' +
      '<span class="tb-home" id="homeBtn">⌂ 首页</span></div>' +
      '<div class="date-row">' + D.DATES.map(d =>
        '<div class="d-chip ' + (d.id === V.dateId ? 'on' : '') + '" data-id="' + d.id + '">' + d.label + ' · ' + d.week + '</div>'
      ).join('') + '</div>' +
      '<div class="vm-main">' + main + '</div>' +
      '<div class="legend">' +
      '<span><i class="lg c-vvip"></i>VVIP</span><span><i class="lg c-vip"></i>VIP</span>' +
      '<span><i class="lg c-a"></i>A档</span><span><i class="lg c-b"></i>B档</span><span><i class="lg c-c"></i>C档</span>' +
      '<span><i class="lg occd"></i>🌽 已登记 ' + V.keys.length + '</span>' +
      '<span class="upd">最后更新：' + esc(V.lastUpd) + ' · 每 3 分钟自动刷新</span>' +
      '</div></div>';

    document.getElementById('backBtn').onclick = () => go('#/choose');
    document.getElementById('homeBtn').onclick = () => go('#/login');

    appEl.querySelectorAll('.d-chip').forEach(el => {
      el.onclick = () => {
        if (el.dataset.id === V.dateId) return;
        V.dateId = el.dataset.id;
        V.sec = '';
        V.msgRkey = '';
        V.inputSec = '';
        loadView().catch(e => toast(e.message));
      };
    });

    const cv = document.getElementById('ovCanvas');
    if (cv) {
      drawOverview(cv, { mode: 'view' });
      cv.onclick = e => {
        const id = hitOverview(cv, e.clientX, e.clientY);
        if (id) { V.sec = id; V.msgRkey = ''; paintView(); }
      };
      const input = document.getElementById('secInput');
      const doGo = () => {
        const id = String(input.value || '').trim().toUpperCase().replace(/^SEC/, '');
        if (!D.SECTIONS[id]) return toast('未找到该区域，请检查编号');
        V.sec = id;
        V.msgRkey = '';
        paintView();
      };
      document.getElementById('secGo').onclick = doGo;
      input.addEventListener('keydown', e => { if (e.key === 'Enter') doGo(); });
      input.addEventListener('input', () => { V.inputSec = input.value; });
    }
    const backOv = document.getElementById('backOv');
    if (backOv) backOv.onclick = () => { V.sec = ''; V.msgRkey = ''; paintView(); };
    if (V.sec) {
      appEl.querySelectorAll('.zs.occ').forEach(el => {
        el.onclick = () => selectSeatMsg(el);
      });
      const cur = V.msgRkey && appEl.querySelector('.zs.cur');
      if (!cur && V.msgRkey) {
        const el = appEl.querySelector('.zs[data-rkey="' + V.msgRkey.replace(/"/g, '') + '"]');
        if (el) el.classList.add('cur');
      }
    }
  }

  function selectSeatMsg(el) {
    const V = state.view;
    V.msgRkey = el.dataset.rkey;
    appEl.querySelectorAll('.zs.cur').forEach(x => x.classList.remove('cur'));
    el.classList.add('cur');
    const panel = document.getElementById('msgPanel');
    if (panel) panel.innerHTML = msgPanelHTML();
  }

  function msgPanelHTML() {
    const V = state.view;
    const k = V.msgRkey;
    if (!k) return '<div class="mp-hint">点座位图上的 🌽，在此查看该座位主人的留言</div>';
    const info = V.msgs[k];
    const parts = String(k).split('-');
    const seatText = D.rowLabel(Number(parts[2])) + '排' + parts[3] + '号';
    return '<div class="mp-h">💬 ' + esc(seatText) + '的留言</div>' +
      (info
        ? '<div class="mp-name">来自 ' + esc(info.name) + '</div><div class="mp-text">' + esc(info.msg) + '</div>'
        : '<div class="mp-text dim">这位主人没有留下留言</div>');
  }

  /* ---------------- 反馈 ---------------- */

  function renderFeedback() {
    const preset = state.fbPreset || {};
    state.fbPreset = null;
    fb = {
      dateId: preset.dateId || '1113',
      sec: preset.sec || '',
      row: preset.row || '',
      seat: preset.seat ? String(preset.seat) : '',
      note: '',
      img: ''
    };
    paintFeedback();
  }

  function paintFeedback() {
    const chips = D.DATES.map(d =>
      '<div class="d-chip ' + (fb.dateId === d.id ? 'on' : '') + '" data-id="' + d.id + '">' + d.label + '</div>'
    ).join('');

    appEl.innerHTML =
      '<div class="page fb-page">' +
      '<div class="topbar"><span class="tb-back" id="backBtn">‹ 返回</span>' +
      '<span class="tb-home" id="homeBtn">⌂ 首页</span></div>' +
      '<div class="fb-intro">若您发现登记的座位已被他人占用，请填写下方信息并上传购票截图，提交后管理员可在后台核实处理，核实后会为您清空该座位。</div>' +
      '<div class="fb-form">' +
      '<div class="f-label"><span class="req">*</span>场次（必选）</div>' +
      '<div class="date-row">' + chips + '</div>' +
      '<div class="f-row3">' +
      '<div class="f-cell"><div class="f-label"><span class="req">*</span>区域编号</div>' +
      '<input class="f-input" id="fSec" placeholder="如 205" value="' + esc(fb.sec) + '"></div>' +
      '<div class="f-cell"><div class="f-label"><span class="req">*</span>排号</div>' +
      '<input class="f-input" id="fRow" placeholder="如 A" value="' + esc(fb.row) + '"></div>' +
      '<div class="f-cell"><div class="f-label"><span class="req">*</span>座号</div>' +
      '<input class="f-input" id="fSeat" type="number" placeholder="如 5" value="' + esc(fb.seat) + '"></div>' +
      '</div>' +
      '<div class="f-label"><span class="req">*</span>购票截图（必填）</div>' +
      '<div class="up-box" id="upBox">' + uploadInner() + '</div>' +
      '<input type="file" id="fileInput" accept="image/*" style="display:none">' +
      '<div class="f-label">补充说明（选填）</div>' +
      '<input class="f-input" id="fNote" placeholder="补充描述您遇到的情况" value="' + esc(fb.note) + '">' +
      '</div>' +
      '<div class="req-tip">带 * 为必填项：座位具体位置与购票截图未提供时无法提交。</div>' +
      '<button class="btn-primary" id="fbSubmit">提交反馈</button>' +
      '</div>';

    document.getElementById('backBtn').onclick = () => go('#/date');
    document.getElementById('homeBtn').onclick = () => go('#/login');

    appEl.querySelectorAll('.date-row .d-chip').forEach(el => {
      el.onclick = () => {
        fb.dateId = el.dataset.id;
        appEl.querySelectorAll('.date-row .d-chip').forEach(x => x.classList.toggle('on', x.dataset.id === fb.dateId));
      };
    });
    document.getElementById('fSec').oninput = e => { fb.sec = e.target.value; };
    document.getElementById('fRow').oninput = e => { fb.row = e.target.value; };
    document.getElementById('fSeat').oninput = e => { fb.seat = e.target.value; };
    document.getElementById('fNote').oninput = e => { fb.note = e.target.value; };

    const fileInput = document.getElementById('fileInput');
    const bindUpBox = () => {
      const box = document.getElementById('upBox');
      if (!box) return;
      const imgEl = box.querySelector('.up-img');
      if (imgEl) imgEl.onclick = e => { e.stopPropagation(); showImage(fb.img); };
      box.onclick = () => fileInput.click();
    };
    bindUpBox();
    fileInput.onchange = async () => {
      const f = fileInput.files && fileInput.files[0];
      if (!f) return;
      try {
        const box = document.getElementById('upBox');
        box.innerHTML = '<div class="up-txt">处理中…</div>';
        fb.img = await compressImage(f);
        box.innerHTML = uploadInner();
        bindUpBox();
      } catch (e) {
        toast('图片读取失败，请换一张');
        document.getElementById('upBox').innerHTML = uploadInner();
        bindUpBox();
      }
    };

    document.getElementById('fbSubmit').onclick = submitFeedback;
  }

  function uploadInner() {
    if (fb.img) {
      return '<img class="up-img" src="' + fb.img + '" alt="购票截图"><div class="up-hint">点击图片可放大查看</div>';
    }
    return '<div class="up-plus">＋</div><div class="up-txt">点击上传购票截图（必填）</div>';
  }

  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1000;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const cv = document.createElement('canvas');
          cv.width = w;
          cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          resolve(cv.toDataURL('image/jpeg', 0.82));
        } catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
      img.src = url;
    });
  }

  async function submitFeedback() {
    const sec = String(fb.sec || '').trim().toUpperCase();
    const row = String(fb.row || '').trim().toUpperCase();
    const seat = String(fb.seat || '').trim();
    if (!sec || !row || !seat) return toast('座位具体位置为必填，请填写区域、排号和座号');
    if (!fb.img) return toast('购票截图为必填，请上传后提交');
    const btn = document.getElementById('fbSubmit');
    btn.disabled = true;
    try {
      await api('/feedback', { dateId: fb.dateId, sec, row, seat, note: fb.note, img: fb.img });
      await confirmDialog({
        title: '反馈提交成功',
        content: '您的反馈已提交，管理员核实后该座位将被清空。您可以在第二天重新进行填写。',
        cancelText: null,
        okText: '我知道了'
      });
      go('#/date');
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  }

  /* ---------------- 完成页 ---------------- */

  async function renderThanks() {
    appEl.innerHTML = '<div class="page"><div class="loading">加载中…</div></div>';
    const r = await api('/bookings');
    const bookings = r.bookings || [];
    if (!bookings.length) { go('#/date'); return; }
    const cards = bookings.map((b, i) =>
      '<div class="card">' +
      '<div class="row"><span class="k">场次</span><span>2026年' + esc(b.dateLabel) + ' · 澳门银河综艺馆</span></div>' +
      '<div class="row"><span class="k">票档</span><span>' + esc(b.tierName) + '</span></div>' +
      '<div class="row"><span class="k">区域</span><span>Sec ' + esc(b.sec) + '</span></div>' +
      '<div class="row"><span class="k">座位</span><span class="seat-txt">' + esc(b.seatText) + ' 🌽</span></div>' +
      '<div class="row"><span class="k">登记人</span><span>' + esc(state.name) + '</span></div>' +
      '</div>'
    ).join('');

    appEl.innerHTML =
      '<div class="page thanks-page">' +
      '<div class="navbar"><div class="nav-title">登记完成</div></div>' +
      '<div class="ok">✓</div>' +
      '<div class="title">感谢您的填写</div>' +
      '<div class="sub">共登记 ' + bookings.length + ' 个座位，提交成功</div>' +
      cards +
      '<button class="btn-ghost" id="homeBtn">返回首页</button>' +
      '</div>';
    document.getElementById('homeBtn').onclick = () => go('#/login');
  }

  /* ---------------- 管理员 ---------------- */

  async function renderAdmin() {
    if (!state.adminToken) {
      appEl.innerHTML = '<div class="page adm-page"><div class="loading">正在进入管理员后台…</div></div>';
      try {
        const r = await api('/admin/open', {});
        if (r.needsSetup) {
          paintAdminKey('', { setup: true, suggestKey: r.suggestKey });
          return;
        }
        paintAdminKey('');
        return;
      } catch (e) {
        paintAdminKey(e.message);
        return;
      }
    }
    await loadAdmin();
  }

  // setup=true：首次初始化，填写昵称 + 秘钥（预填系统生成，可改）
  function paintAdminKey(errText, opt) {
    opt = opt || {};
    const setup = !!opt.setup;
    const needName = setup || !state.admin.name;
    const keyVal = setup ? (opt.suggestKey || '') : '';
    appEl.innerHTML =
      '<div class="page adm-page">' +
      '<div class="topbar"><span class="tb-back" id="backBtn">‹ 返回</span><span class="tb-home" id="homeBtn">⌂ 首页</span></div>' +
      '<div class="adm-intro">' + (setup
        ? '首次初始化：请填写管理员昵称，并确认管理员秘钥（系统已生成一个，可自行修改，留空则用系统生成的）。'
        : '请输入管理员秘钥进入管理界面。首次使用该秘钥的管理员还需填写自己的昵称，之后再次进入只需填秘钥。') +
      '</div>' +
      '<div class="adm-form">' +
      (needName
        ? '<div class="f-label">管理员昵称</div>' +
          '<input class="key-form-input" id="adminNameInput" maxlength="20" placeholder="如：小林" autocomplete="off">'
        : '<div class="f-label">当前管理员</div><div class="adm-me">' + esc(state.admin.name) + '</div>') +
      '<div class="f-label">管理员秘钥</div>' +
      '<input class="key-form-input" id="adminKeyInput" placeholder="' + (setup ? '留空则使用系统生成的秘钥' : '请输入秘钥，如 GLY7K2M9Q') + '" autocomplete="off" value="' + esc(keyVal) + '">' +
      (errText ? '<div class="qfeed">' + esc(errText) + '</div>' : '') +
      '<button class="btn-primary" id="adminLoginBtn">' + (setup ? '完成初始化并进入' : '进入管理员界面') + '</button>' +
      '</div>' +
      '<div class="hint-s center">' + (setup
        ? '秘钥仅在初始化后显示一次，请立刻记下并转发给其他管理员。'
        : '首次填写的昵称会记入「管理人员列表」；秘钥永久有效，忘了只能清空全部数据重新生成。') +
      '</div>' +
      '</div>';

    document.getElementById('backBtn').onclick = () => go('#/login');
    document.getElementById('homeBtn').onclick = () => go('#/login');
    const keyInput = document.getElementById('adminKeyInput');
    const nameInput = document.getElementById('adminNameInput');
    const btn = document.getElementById('adminLoginBtn');
    const doLogin = async () => {
      const key = keyInput.value.trim();
      const name = nameInput ? nameInput.value.trim() : state.admin.name;
      if (setup) {
        if (!name) return toast('请填写管理员昵称');
        btn.disabled = true;
        try {
          const r = await api('/admin/setup', { name, key });
          state.adminToken = r.token;
          state.admin.name = r.adminName || name;
          localStorage.setItem('admin_name', state.admin.name);
          state.admin.revealKey = r.key || '';
          sessionStorage.setItem('admin_token', r.token);
          await loadAdmin();
        } catch (e) {
          toast(e.message);
          btn.disabled = false;
        }
        return;
      }
      if (!key) return toast('请输入秘钥');
      btn.disabled = true;
      try {
        const r = await api('/admin/login', { key, name });
        state.adminToken = r.token;
        state.admin.name = r.adminName || name || '';
        if (state.admin.name) localStorage.setItem('admin_name', state.admin.name);
        sessionStorage.setItem('admin_token', r.token);
        await loadAdmin();
      } catch (e) {
        toast(e.message);
        btn.disabled = false;
      }
    };
    btn.onclick = doLogin;
    keyInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
    setTimeout(() => { if (setup) nameInput && nameInput.focus(); }, 60);
  }

  async function loadAdmin() {
    try {
      const d = await api('/admin/data');
      state.admin.data = d;
      paintAdmin();
    } catch (e) {
      if (e.status === 401) {
        state.adminToken = '';
        sessionStorage.removeItem('admin_token');
        paintAdminKey('管理员登录已失效，请重新输入秘钥');
      } else {
        toast(e.message);
      }
    }
  }

  function paintAdmin() {
    const A = state.admin;
    const d = A.data;
    if (!d) return;
    const tabs = [['stat', '座位统计'], ['quiz', '题库管理'], ['fb', '反馈处理'], ['adm', '管理员']];
    let content = '';
    if (A.tab === 'stat') content = adminStatHTML(d);
    else if (A.tab === 'quiz') content = adminQuizHTML(d);
    else if (A.tab === 'fb') content = adminFbHTML(d);
    else content = adminAdmHTML(d);

    appEl.innerHTML =
      '<div class="page adm-page">' +
      '<div class="topbar"><span class="tb-back" id="backBtn">‹ 返回</span><span class="who">管理员后台</span>' +
      '<span class="tb-home" id="homeBtn">⌂ 首页</span></div>' +
      (A.revealKey ?
        '<div class="key-card"><div class="kc-h">🔑 管理员秘钥 · 仅显示一次</div>' +
        (state.admin.name ? '<div class="kc-name">管理员昵称：' + esc(state.admin.name) + '</div>' : '') +
        '<div class="kc-key">' + esc(A.revealKey) + '</div>' +
        '<div class="kc-tip">请把此秘钥转发给其他管理员：他们第一次进入时填写此秘钥 + 自己的昵称，之后每次进入只需填秘钥。</div>' +
        '<div class="kc-act"><button class="sm-btn" id="copyKeyBtn">复制秘钥</button>' +
        '<button class="sm-btn grey" id="hideKeyBtn">我已记住，隐藏</button></div></div>' : '') +
      '<div class="adm-tabs">' + tabs.map(t =>
        '<div class="adm-tab ' + (A.tab === t[0] ? 'on' : '') + '" data-t="' + t[0] + '">' + t[1] + '</div>'
      ).join('') + '</div>' +
      content +
      '</div>';

    document.getElementById('backBtn').onclick = () => go('#/login');
    document.getElementById('homeBtn').onclick = () => go('#/login');
    appEl.querySelectorAll('.adm-tab').forEach(el => {
      el.onclick = () => { A.tab = el.dataset.t; paintAdmin(); };
    });
    const copyBtn = document.getElementById('copyKeyBtn');
    if (copyBtn) {
      copyBtn.onclick = () => {
        navigator.clipboard.writeText(A.revealKey).then(
          () => toast('秘钥已复制'),
          () => toast('复制失败，请手动记录')
        );
      };
      document.getElementById('hideKeyBtn').onclick = () => {
        A.revealKey = '';
        paintAdmin();
        toast('已隐藏，请妥善保管秘钥');
      };
    }
    bindAdminContent();
  }

  function adminStatHTML(d) {
    const s = d.stats;
    const tierCells = map => D.TIERS.map(t =>
      '<div class="sg"><div class="sg-b">' + ((map && map[t.id]) || 0) + '</div><div class="sg-s">' + t.name + '</div></div>'
    ).join('');
    const dateBlocks = s.perDate.map(ds =>
      '<div class="ds-card"><div class="ds-head"><span class="ds-label">' + esc(ds.label) + ' · ' + esc(ds.week) + '</span>' +
      '<span class="ds-total">合计 ' + ds.total + ' 座</span></div>' +
      '<div class="stat-grid">' + tierCells(ds.byTier) + '</div></div>'
    ).join('');
    const details = s.details.length
      ? s.details.map(x => '<div class="d-item">' + esc(x.text) + '</div>').join('')
      : '<div class="empty">暂无登记</div>';
    return '<div class="adm-sec"><div class="sec-h">登记座位统计' +
      '<span class="sec-hint">已登记总数 ' + s.total + ' 座</span></div>' +
      dateBlocks +
      '<div class="pend">待处理反馈：<span class="hl">' + s.pend + '</span> 条</div></div>' +
      '<div class="adm-sec"><div class="sec-h">管理员占座</div>' +
      '<div class="occ-total"><span>三个场次合计</span><b>' + s.adminCount + '</b></div>' +
      '<div class="hint-s">管理员占座单独统计，不计入上面的用户登记数量。</div></div>' +
      '<div class="adm-sec"><div class="sec-h">最近登记明细</div>' + details + '</div>';
  }

  function adminQuizHTML(d) {
    const bank = d.bank;
    const items = bank.map((q, i) => {
      if (q.type === 'fill') {
        return '<div class="qedit" data-i="' + i + '" data-type="fill">' +
          '<div class="qe-no">第 ' + (i + 1) + ' 题 · 填空题</div>' +
          '<input class="f-input" data-f="q" value="' + esc(q.q) + '" placeholder="题目">' +
          '<div class="qe-opts"><input class="f-input" data-f="ans" value="' +
          esc([q.answer].concat(q.alts || []).join(' / ')) + '" placeholder="参考答案，多个答案用 / 分隔"></div>' +
          '<div class="qe-ans">多个可接受答案用 / 分隔，如：3 / 三天 / 3天；判分忽略空格、标点与「天/个/日」等单位</div></div>';
      }
      return '<div class="qedit" data-i="' + i + '" data-type="choice">' +
        '<div class="qe-no">第 ' + (i + 1) + ' 题 · 选择题</div>' +
        '<input class="f-input" data-f="q" value="' + esc(q.q) + '" placeholder="题目">' +
        '<div class="qe-opts">' +
        '<input class="f-input" data-f="o0" value="' + esc(q.options[0]) + '" placeholder="选项A">' +
        '<input class="f-input" data-f="o1" value="' + esc(q.options[1]) + '" placeholder="选项B">' +
        '<input class="f-input" data-f="o2" value="' + esc(q.options[2]) + '" placeholder="选项C">' +
        '</div>' +
        '<div class="qe-ans">正确答案：<select class="ans-sel" data-f="ans">' +
        '<option value="0"' + (q.answer === 0 ? ' selected' : '') + '>A</option>' +
        '<option value="1"' + (q.answer === 1 ? ' selected' : '') + '>B</option>' +
        '<option value="2"' + (q.answer === 2 ? ' selected' : '') + '>C</option>' +
        '</select></div></div>';
    }).join('');
    return '<div class="adm-sec"><div class="sec-h">题库管理（' + bank.length + ' 题 · 每次随机抽 3 题）</div>' +
      items + '<button class="btn-primary save" id="saveBankBtn">保存题库（立即生效）</button></div>';
  }

  function adminFbHTML(d) {
    const list = d.feedback.length ? d.feedback.map(f => {
      const img = f.img
        ? '<img class="fb-img" src="' + f.img + '" alt="购票截图" data-img="' + f.id + '">' +
        '<div class="fb-img-hint">点击图片放大核对</div>'
        : '<div class="fb-img-hint">该反馈未上传截图</div>';
      const acts = f.status === 'pending'
        ? '<div class="fb-acts"><button class="sm-btn" data-act="clear" data-id="' + esc(f.id) + '">核实无误，清空该座位</button>' +
        '<button class="sm-btn grey" data-act="dismiss" data-id="' + esc(f.id) + '">驳回</button></div>'
        : '<div class="fb-done">✓ ' + esc(f.reply || '已处理') + '</div>';
      return '<div class="fb-item">' +
        '<div class="fb-t">' + esc(f.dateLabel) + ' · Sec ' + esc(f.sec) + ' · ' + esc(f.row) + '排' + esc(f.seat) + '座' +
        '<span class="fb-tag ' + f.status + '">' + (f.status === 'pending' ? '待处理' : '已处理') + '</span></div>' +
        '<div class="fb-meta">' + esc(f.name || '匿名') + ' · ' + esc(f.time) + '</div>' +
        (f.note ? '<div class="fb-meta">说明：' + esc(f.note) + '</div>' : '') +
        img + acts + '</div>';
    }).join('') : '<div class="empty">暂无反馈</div>';

    return '<div class="adm-sec"><div class="sec-h">用户反馈（座位被占申诉）</div>' + list + '</div>' +
      '<div class="adm-sec"><div class="sec-h">手动清空座位</div>' +
      '<div class="f-row3">' +
      '<input class="f-input" id="mSec" placeholder="区域 如 205">' +
      '<input class="f-input" id="mRow" placeholder="排 如 A">' +
      '<input class="f-input" id="mSeat" placeholder="座 如 5">' +
      '</div><button class="sm-btn" id="manualClearBtn" style="margin-top:8px">清空该座位（3 个场次）</button></div>' +
      '<div class="adm-sec"><div class="sec-h">手动占座（遮挡视线等不售出座位）</div>' +
      '<div class="f-row3">' +
      '<input class="f-input" id="oSec" placeholder="区域 如 205">' +
      '<input class="f-input" id="oRow" placeholder="排 如 A">' +
      '<input class="f-input" id="oSeat" placeholder="座 如 5">' +
      '</div><input class="f-input" id="oNote" placeholder="备注（选填，如：遮挡舞台视线不售出）" style="margin-top:6px">' +
      '<button class="sm-btn" id="manualOccupyBtn" style="margin-top:8px">标记占座（不售出，3 个场次）</button></div>';
  }

  function adminAdmHTML(d) {
    const admins = (d && d.admins) || [];
    const list = admins.length
      ? admins.map((a, i) =>
        '<div class="adm-row"><div class="ar-name">' + esc(a.name || '未命名') +
        (a.first ? '<span class="ar-tag">首位</span>' : '') + '</div>' +
        '<div class="ar-time">加入时间：' + esc(a.createdAt || '—') + '</div></div>'
      ).join('')
      : '<div class="empty">暂无管理员记录</div>';
    return '<div class="adm-sec"><div class="sec-h">管理人员列表（' + admins.length + ' 人）</div>' +
      list +
      '<div class="hint-s">当前登录：' + esc(state.admin.name || '未登记昵称') +
      '。第一次用秘钥进入时填写的昵称会记录在此列表，之后再次进入只需秘钥。</div>' +
      '<button class="sm-btn grey quit-btn" id="quitAdminBtn">退出管理员身份</button></div>' +
      '<div class="adm-sec danger"><div class="sec-h danger-h">危险操作 · 清空全部数据</div>' +
      '<div class="rule-s">清空后：<span class="hl">管理员秘钥、管理人员列表、全部已登记座位（🌽）、全部反馈</span>都会被删除，系统回到「首次初始化」状态（题库保留）。此操作不可恢复。</div>' +
      '<button class="danger-btn" id="resetAllBtn">清空全部数据</button></div>';
  }

  function bindAdminContent() {
    const A = state.admin;

    const saveBankBtn = document.getElementById('saveBankBtn');
    if (saveBankBtn) {
      saveBankBtn.onclick = async () => {
        const bank = [];
        let ok = true;
        appEl.querySelectorAll('.qedit').forEach(el => {
          const i = Number(el.dataset.i);
          const type = el.dataset.type;
          const qEl = el.querySelector('[data-f="q"]');
          const qText = qEl ? qEl.value.trim() : '';
          if (!qText) ok = false;
          if (type === 'fill') {
            const ansEl = el.querySelector('[data-f="ans"]');
            const parts = String(ansEl ? ansEl.value : '').split('/').map(x => x.trim()).filter(Boolean);
            if (!parts.length) ok = false;
            bank[i] = { type: 'fill', q: qText, answer: parts[0] || '', alts: parts.slice(1) };
          } else {
            const o0 = el.querySelector('[data-f="o0"]').value.trim();
            const o1 = el.querySelector('[data-f="o1"]').value.trim();
            const o2 = el.querySelector('[data-f="o2"]').value.trim();
            if (!o0 || !o1 || !o2) ok = false;
            bank[i] = { type: 'choice', q: qText, options: [o0, o1, o2], answer: Number(el.querySelector('[data-f="ans"]').value) };
          }
        });
        if (!ok) return toast('题目、选项与参考答案不能为空');
        try {
          await api('/admin/bank', { bank });
          toast('题库已保存并生效');
          await loadAdmin();
        } catch (e) { toast(e.message); }
      };
    }

    appEl.querySelectorAll('.fb-img').forEach(img => {
      img.onclick = () => {
        const f = (A.data.feedback || []).find(x => x.id === img.dataset.img);
        if (f && f.img) showImage(f.img);
      };
    });

    appEl.querySelectorAll('.fb-acts .sm-btn').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const act = btn.dataset.act;
        const title = act === 'clear' ? '核实无误，清空该座位？' : '驳回该反馈？';
        const content = act === 'clear'
          ? '将清空该座位在三个场次中的全部登记，并标记反馈已处理。'
          : '座位维持原状，并标记反馈已处理。';
        const ok = await confirmDialog({ title, content, okText: act === 'clear' ? '清空' : '驳回' });
        if (!ok) return;
        try {
          await api('/admin/feedback', { id, action: act });
          toast(act === 'clear' ? '已清空并标记处理' : '已驳回该反馈');
          await loadAdmin();
        } catch (e) { toast(e.message); }
      };
    });

    const manualClearBtn = document.getElementById('manualClearBtn');
    if (manualClearBtn) {
      manualClearBtn.onclick = async () => {
        const sec = document.getElementById('mSec').value;
        const row = document.getElementById('mRow').value;
        const seat = document.getElementById('mSeat').value;
        if (!sec.trim() || !row.trim() || !seat.trim()) return toast('请填写区域、排、座号');
        try {
          const r = await api('/admin/seat/clear', { sec, row, seat });
          toast(r.count ? '已清空（' + r.count + ' 个场次）' : '该座位当前无登记记录');
          await loadAdmin();
        } catch (e) { toast(e.message); }
      };
    }

    const manualOccupyBtn = document.getElementById('manualOccupyBtn');
    if (manualOccupyBtn) {
      manualOccupyBtn.onclick = async () => {
        const sec = document.getElementById('oSec').value;
        const row = document.getElementById('oRow').value;
        const seat = document.getElementById('oSeat').value;
        const note = document.getElementById('oNote').value;
        if (!sec.trim() || !row.trim() || !seat.trim()) return toast('请填写区域、排、座号');
        try {
          await api('/admin/seat/occupy', { sec, row, seat, note });
          toast('已标记占座（3 个场次均不售出）');
          await loadAdmin();
        } catch (e) { toast(e.message); }
      };
    }

    const quitBtn = document.getElementById('quitAdminBtn');
    if (quitBtn) {
      quitBtn.onclick = async () => {
        const ok = await confirmDialog({
          title: '退出管理员',
          content: '退出后仅解除本机的管理员登录；秘钥保持不变、永久有效。确定退出？',
          okText: '退出'
        });
        if (!ok) return;
        state.adminToken = '';
        sessionStorage.removeItem('admin_token');
        state.admin.data = null;
        state.admin.revealKey = '';
        go('#/login');
      };
    }

    const resetBtn = document.getElementById('resetAllBtn');
    if (resetBtn) {
      resetBtn.onclick = async () => {
        const ok = await confirmDialog({
          title: '清空全部数据',
          content: '将删除：全部已登记座位（🌽）、全部用户反馈、管理员秘钥。题库保留，系统回到「首次初始化」状态。此操作不可恢复，确定继续？',
          okText: '清空',
          danger: true
        });
        if (!ok) return;
        try {
          await api('/admin/reset', {});
          state.adminToken = '';
          sessionStorage.removeItem('admin_token');
          state.admin.data = null;
          state.admin.revealKey = '';
          state.admin.name = '';
          localStorage.removeItem('admin_name');
          paintAdminKey('已清空数据，请重新进入以初始化管理员秘钥');
        } catch (e) { toast(e.message); }
      };
    }
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    if (state.token) {
      try {
        const r = await api('/me');
        state.name = r.name;
        state.verified = !!r.verified;
        state.done = !!r.done;
        localStorage.setItem('seat_name', r.name);
      } catch (e) {
        state.token = '';
        state.verified = false;
        state.done = false;
        localStorage.removeItem('seat_token');
      }
    }
    window.addEventListener('hashchange', route);
    if (!location.hash) location.hash = '#/login';
    route();
  }

  init();
})();
