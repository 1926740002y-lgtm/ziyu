// 演唱会座位登记 · 网页版服务端
// 零依赖 Node 服务：静态页面 + REST 接口 + data.json 持久化
// 启动：node server.js   然后浏览器打开 http://localhost:3000
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const SD = require('./public/seatdata.js');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data.json');

const DEFAULT_BANK = [
  /* ---- 选择题 × 5 ---- */
  { type: 'choice', q: '本场演唱会的举办场馆是？', options: ['威尼斯人金光综艺馆', '澳门银河综艺馆', '香港红磡体育馆'], answer: 1 },
  { type: 'choice', q: '本场演出的日期范围是？', options: ['11.01 - 11.03', '11.13 - 11.15', '12.13 - 12.15'], answer: 1 },
  { type: 'choice', q: '每位用户最多可登记几个座位？', options: ['1 个', '2 个', '3 个'], answer: 2 },
  { type: 'choice', q: '选座时可以跨票档选择吗？', options: ['可以', '不可以，仅限当前票档', '看情况'], answer: 1 },
  { type: 'choice', q: '发现座位已被他人登记时应怎么做？', options: ['提交反馈申诉', '强行选择', '放弃登记'], answer: 0 },
  /* ---- 填空题 × 5 ---- */
  { type: 'fill', q: '本场演唱会在哪个城市举办？（填写城市名）', answer: '澳门', alts: ['澳门特别行政区', '澳門'] },
  { type: 'fill', q: '举办场馆的中文名称是什么？（如：XX 综艺馆）', answer: '澳门银河综艺馆', alts: ['银河综艺馆'] },
  { type: 'fill', q: '本场演出共连续举办几天？（填写数字）', answer: '3', alts: ['3天', '三天'] },
  { type: 'fill', q: '本次演出的最后一天是 11 月几号？（填写数字）', answer: '15', alts: ['15日', '十五'] },
  { type: 'fill', q: '每位用户最多可登记几个座位？（填写数字）', answer: '3', alts: ['3个', '三个'] }
];

/* ---------------- 数据层 ---------------- */

function blankData() {
  return { adminKey: '', admins: [], occ: {}, feedback: [], bank: null, sessions: {} };
}

let data = blankData();
let dirty = false;

/* ---- 存储后端：本地 JSON 文件 / Upstash Redis（Vercel 部署时使用） ---- */

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const USE_REDIS = !!(REDIS_URL && REDIS_TOKEN);
const REDIS_KEY = process.env.DATA_KEY || 'seat:data';

function normalize() {
  if (!data.occ || typeof data.occ !== 'object') data.occ = {};
  if (!Array.isArray(data.feedback)) data.feedback = [];
  if (!data.sessions || typeof data.sessions !== 'object') data.sessions = {};
  if (!Array.isArray(data.admins)) data.admins = [];
  if (!data.adminKey) data.adminKey = '';
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    data = Object.assign(blankData(), JSON.parse(raw));
  } catch (e) {
    data = blankData();
  }
  normalize();
}

async function redisCmd(cmd) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('Redis HTTP ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}

async function storeLoad() {
  if (!USE_REDIS) return; // 本地模式：数据常驻内存，由 save() 写文件
  const raw = await redisCmd(['GET', REDIS_KEY]);
  try {
    data = Object.assign(blankData(), raw ? JSON.parse(raw) : {});
  } catch (e) {
    data = blankData();
  }
  normalize();
}

async function storeSave() {
  if (!USE_REDIS || !dirty) return;
  dirty = false;
  await redisCmd(['SET', REDIS_KEY, JSON.stringify(data)]);
}

// 简单分布式锁：Serverless 多实例并发时，保证一次只处理一个写请求
async function storeLock() {
  if (!USE_REDIS) return async () => {};
  const id = rand(8);
  for (let i = 0; i < 24; i++) {
    try {
      const r = await redisCmd(['SET', 'seat:lock', id, 'NX', 'PX', '5000']);
      if (r === 'OK') {
        return async () => {
          try {
            const cur = await redisCmd(['GET', 'seat:lock']);
            if (cur === id) await redisCmd(['DEL', 'seat:lock']);
          } catch (e) { /* 超时自动释放 */ }
        };
      }
    } catch (e) { /* 网络抖动，重试 */ }
    await new Promise(r => setTimeout(r, 60));
  }
  return async () => {};
}

let saveTimer = null;
function save() {
  dirty = true;
  if (USE_REDIS) return;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const tmp = DATA_FILE + '.tmp';
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) {
      console.error('[保存数据失败]', e.message);
    }
  }, 60);
}

function rand(n) { return crypto.randomBytes(n).toString('hex'); }
function nowText() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------------- 题库 ---------------- */

function bankOk(b) {
  return Array.isArray(b) && b.length === 10 && b.every(q =>
    q && (q.type === 'choice' || q.type === 'fill') && typeof q.q === 'string' && q.q.trim() &&
    (q.type === 'choice'
      ? (Array.isArray(q.options) && q.options.length >= 2)
      : (typeof q.answer === 'string' && q.answer.trim())));
}

function getBank() {
  return bankOk(data.bank) ? data.bank : JSON.parse(JSON.stringify(DEFAULT_BANK));
}

// 填空答案归一化：忽略大小写/空格/标点/单位后缀，全角转半角，中文数字转阿拉伯数字
function normAns(v) {
  let s = String(v == null ? '' : v)
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。、,.!?？！;；:："'“”‘’()（）【】\[\]<>《》\/]/g, '')
    .replace(/[天个日号座人位次]$/, '');
  const cn = { '一': '1', '二': '2', '两': '2', '三': '3', '四': '4', '五': '5', '六': '6', '七': '7', '八': '8', '九': '9', '十': '10' };
  return s.split('').map(c => cn[c] || c).join('');
}

function fillRight(q, v) {
  const ok = [q.answer].concat(q.alts || []).map(normAns);
  return ok.indexOf(normAns(v)) >= 0;
}

// 随机抽 3 题（选择/填空各至少 1 题），返回题库下标
function pickQuestions() {
  const bank = getBank();
  const shuffle = a => {
    const r = a.slice();
    for (let i = r.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = r[i]; r[i] = r[j]; r[j] = t;
    }
    return r;
  };
  const choice = shuffle(bank.map((q, i) => ({ q, i })).filter(x => x.q.type === 'choice'));
  const fill = shuffle(bank.map((q, i) => ({ q, i })).filter(x => x.q.type === 'fill'));
  let arr;
  if (choice.length && fill.length > 1 && (Math.random() < 0.5 || choice.length < 2)) {
    arr = [choice[0], fill[0], fill[1]];
  } else if (choice.length > 1 && fill.length) {
    arr = [choice[0], choice[1], fill[0]];
  } else {
    arr = shuffle(bank.map((q, i) => ({ q, i }))).slice(0, 3);
  }
  return shuffle(arr).map(x => ({ i: x.i, type: x.q.type }));
}

function questionsForClient(questions) {
  const bank = getBank();
  return questions.map(x => {
    const q = bank[x.i];
    return q ? { i: x.i, type: q.type, q: q.q, options: q.options || [] } : null;
  }).filter(Boolean);
}

/* ---------------- 会话 ---------------- */

const DAY = 24 * 60 * 60 * 1000;

function pruneSessions() {
  const t = Date.now();
  for (const k in data.sessions) {
    const s = data.sessions[k];
    const max = s.admin ? 30 * DAY : 7 * DAY;
    if (!s.createdAt || t - s.createdAt > max) delete data.sessions[k];
  }
  const keys = Object.keys(data.sessions);
  if (keys.length > 5000) {
    keys.sort((a, b) => (data.sessions[a].createdAt || 0) - (data.sessions[b].createdAt || 0));
    keys.slice(0, keys.length - 5000).forEach(k => delete data.sessions[k]);
  }
}

function getSession(req) {
  const t = req.headers['x-token'];
  if (!t || Array.isArray(t)) return null;
  const s = data.sessions[t];
  return (s && !s.admin) ? s : null;
}

function getAdmin(req) {
  const t = req.headers['x-admin'];
  if (!t || Array.isArray(t)) return null;
  const s = data.sessions[t];
  return (s && s.admin) ? s : null;
}

function genAdmKey() {
  const cs = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  let s = 'GLY';
  for (let i = 0; i < 6; i++) s += cs[crypto.randomInt(0, cs.length)];
  return s;
}
function normKey(v) { return String(v || '').toUpperCase().replace(/[\s\-_—]/g, ''); }

/* ---------------- HTTP 工具 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('请求格式错误')); }
    });
    req.on('error', reject);
  });
}

function occOfDate(dateId) {
  const pre = dateId + '-';
  return Object.keys(data.occ).filter(k => k.indexOf(pre) === 0);
}

function bookingList(uid) {
  return Object.keys(data.occ)
    .filter(k => data.occ[k].uid === uid)
    .map(k => {
      const it = data.occ[k];
      return {
        rkey: k, dateId: it.dateId, dateLabel: it.dateLabel,
        sec: it.sec, r: it.r, s: it.s, seatText: it.seatText,
        tier: it.tier, tierName: it.tierName
      };
    })
    .sort((a, b) => a.dateId.localeCompare(b.dateId));
}

function userStats() {
  const byTier = {};
  const perDate = SD.DATES.map(d => ({ id: d.id, label: d.label, week: d.week, total: 0, byTier: {} }));
  let total = 0;
  let adminCount = 0;
  const details = [];

  for (const k in data.occ) {
    const it = data.occ[k];
    if (it.tier === 'admin') { adminCount++; continue; } // 管理员占座单独统计，不计入用户登记数
    total++;
    byTier[it.tier] = (byTier[it.tier] || 0) + 1;
    const ds = perDate.find(x => x.id === it.dateId);
    if (ds) {
      ds.total++;
      ds.byTier[it.tier] = (ds.byTier[it.tier] || 0) + 1;
    }
    details.push({
      k,
      text: it.dateLabel + ' · Sec ' + it.sec + ' · ' + SD.rowLabel(it.r) + '排' + it.s + '座 · ' +
        (it.name || '匿名') + ' · ' + it.time
    });
  }

  const pend = data.feedback.filter(f => f.status === 'pending').length;
  return {
    total,
    byTier,
    perDate,
    adminCount,
    pend,
    details: details.reverse().slice(0, 40)
  };
}

/* ---------------- 业务接口 ---------------- */

async function handleApi(req, res, url) {
  // 只对写请求加锁，读请求（GET）直接读数据，减少 Redis 命令消耗
  const unlock = req.method === 'GET' ? async () => {} : await storeLock();
  try {
    await storeLoad();
    return await handleApiInner(req, res, url);
  } finally {
    try { await storeSave(); } catch (e) { console.error('[数据保存失败]', e.message); }
    try { await unlock(); } catch (e) { /* 忽略 */ }
  }
}

async function handleApiInner(req, res, url) {
  const p = url.pathname;
  const method = req.method;
  const body = method === 'POST' ? await readJson(req) : {};

  /* --- 登录：仅需昵称 --- */
  if (p === '/api/login' && method === 'POST') {
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return sendJson(res, 400, { error: '请输入昵称' });
    pruneSessions();
    const token = rand(16);
    const questions = pickQuestions();
    data.sessions[token] = {
      uid: 'u' + rand(6), name, verified: false,
      questions, createdAt: Date.now()
    };
    save();
    return sendJson(res, 200, { token, name, questions: questionsForClient(questions) });
  }

  if (p === '/api/me' && method === 'GET') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    return sendJson(res, 200, { name: s.name, verified: !!s.verified, done: !!s.done });
  }

  // 登记完成：同一设备此后只能查看座位图与提交反馈，不能再选座
  if (p === '/api/finish' && method === 'POST') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    s.done = true;
    save();
    return sendJson(res, 200, { ok: true });
  }

  /* --- 答题校验 --- */
  if (p === '/api/quiz' && method === 'POST') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    if (s.verified) return sendJson(res, 200, { ok: true });
    const bank = getBank();
    const answers = Array.isArray(body.answers) ? body.answers : [];
    const wrong = [];
    s.questions.forEach((q, idx) => {
      const item = bank[q.i];
      const a = answers.find(x => x && Number(x.i) === q.i);
      const val = a ? a.value : '';
      if (!item) { wrong.push(idx); return; }
      if (item.type === 'choice') {
        if (Number(val) !== Number(item.answer)) wrong.push(idx);
      } else if (!fillRight(item, val)) {
        wrong.push(idx);
      }
    });
    if (wrong.length) return sendJson(res, 200, { ok: false, wrong });
    s.verified = true;
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/quiz/retry' && method === 'POST') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    s.questions = pickQuestions();
    save();
    return sendJson(res, 200, { questions: questionsForClient(s.questions) });
  }

  /* --- 我的登记 --- */
  if (p === '/api/bookings' && method === 'GET') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    return sendJson(res, 200, { bookings: bookingList(s.uid) });
  }

  /* --- 某场次的占用座位 --- */
  if (p === '/api/occ' && method === 'GET') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    const dateId = url.searchParams.get('date') || '1113';
    if (!SD.DATES.some(d => d.id === dateId)) return sendJson(res, 400, { error: '日期不存在' });
    const keys = occOfDate(dateId);
    const msgs = {};
    keys.forEach(k => {
      const it = data.occ[k];
      if (it && it.msg) msgs[k] = { name: it.name || '匿名', msg: it.msg };
    });
    return sendJson(res, 200, { dateId, keys, msgs });
  }

  /* --- 锁定座位 --- */
  if (p === '/api/occupy' && method === 'POST') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    if (!s.verified) return sendJson(res, 403, { error: '请先完成答题验证' });
    if (s.done) return sendJson(res, 403, { error: '本设备已完成登记，不能再选座' });
    const dateId = String(body.dateId || '');
    const date = SD.DATES.find(d => d.id === dateId);
    if (!date) return sendJson(res, 400, { error: '日期不存在' });
    const sec = String(body.sec || '').toUpperCase();
    const sc = SD.SECTIONS[sec];
    if (!sc) return sendJson(res, 400, { error: '区域不存在' });
    const r = Number(body.r);
    const seatNo = Number(body.s);
    if (!Number.isInteger(r) || r < 0 || r >= sc.rows.length) return sendJson(res, 400, { error: '排号异常' });
    if (!Number.isInteger(seatNo) || seatNo < 1 || seatNo > sc.rows[r]) return sendJson(res, 400, { error: '座号异常' });
    const key = SD.seatKey(dateId, sec, r, seatNo);
    const cur = data.occ[key];
    if (cur && cur.uid !== s.uid) return sendJson(res, 409, { error: '该座位刚被他人登记，请另选' });

    // 同一天只保留一个座位：先释放本人在该日期的其他座位
    for (const k in data.occ) {
      if (data.occ[k].uid === s.uid && data.occ[k].dateId === dateId && k !== key) delete data.occ[k];
    }
    const tier = SD.rowTier(sc, r);
    const tierInfo = SD.tierById(tier);
    const msg = String(body.msg || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    data.occ[key] = {
      dateId, dateLabel: date.label, sec, r, s: seatNo,
      tier, tierName: tierInfo ? tierInfo.name + ' ¥' + tierInfo.price : tier,
      seatText: SD.rowLabel(r) + '排' + seatNo + '座',
      uid: s.uid, name: s.name, msg, time: nowText()
    };
    save();
    const count = Object.keys(data.occ).filter(k => data.occ[k].uid === s.uid).length;
    return sendJson(res, 200, { ok: true, rkey: key, count });
  }

  /* --- 释放座位 --- */
  if (p === '/api/release' && method === 'POST') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    if (s.done) return sendJson(res, 403, { error: '本设备已完成登记，不能再修改座位' });
    const rkey = String(body.rkey || '');
    const it = data.occ[rkey];
    if (!it) return sendJson(res, 200, { ok: true });
    if (it.uid !== s.uid) return sendJson(res, 403, { error: '无权操作该座位' });
    delete data.occ[rkey];
    save();
    return sendJson(res, 200, { ok: true });
  }

  /* --- 提交反馈 --- */
  if (p === '/api/feedback' && method === 'POST') {
    const s = getSession(req);
    if (!s) return sendJson(res, 401, { error: '登录状态已失效' });
    if (!s.verified) return sendJson(res, 403, { error: '请先完成答题验证' });
    const dateId = String(body.dateId || '');
    const date = SD.DATES.find(d => d.id === dateId);
    if (!date) return sendJson(res, 400, { error: '请选择场次' });
    const sec = String(body.sec || '').trim().toUpperCase();
    const row = String(body.row || '').trim().toUpperCase();
    const seat = String(body.seat || '').trim();
    const img = String(body.img || '');
    if (!sec || !row || !seat) return sendJson(res, 400, { error: '座位具体位置为必填' });
    if (!/^data:image\//.test(img)) return sendJson(res, 400, { error: '购票截图为必填' });
    if (img.length > 4 * 1024 * 1024) return sendJson(res, 413, { error: '截图过大，请重新上传' });
    data.feedback.unshift({
      id: 'FB' + Date.now() + rand(2),
      uid: s.uid, name: s.name,
      dateId, dateLabel: date.label,
      sec, row, seat,
      note: String(body.note || '').trim().slice(0, 200),
      img,
      status: 'pending', reply: '',
      time: nowText()
    });
    save();
    return sendJson(res, 200, { ok: true });
  }

  /* --- 管理员 --- */
  if (p === '/api/admin/open' && method === 'POST') {
    if (!data.adminKey) {
      return sendJson(res, 200, { needsSetup: true, suggestKey: genAdmKey() });
    }
    return sendJson(res, 200, { needsKey: true });
  }

  // 首次初始化：填写管理员昵称（秘钥可自定义，留空则用系统生成的）
  if (p === '/api/admin/setup' && method === 'POST') {
    if (data.adminKey) return sendJson(res, 400, { error: '管理员已完成初始化，请用秘钥进入' });
    const name = String(body.name || '').trim().slice(0, 20);
    if (!name) return sendJson(res, 400, { error: '请填写管理员昵称' });
    let key = normKey(body.key);
    if (!key) key = genAdmKey();
    if (!/^[A-Z0-9]{4,20}$/.test(key)) {
      return sendJson(res, 400, { error: '秘钥只能用 4-20 位字母或数字（不能含符号）' });
    }
    data.adminKey = key;
    data.admins = [{ name, first: true, createdAt: nowText() }];
    const token = rand(16);
    pruneSessions();
    data.sessions[token] = { admin: true, adminName: name, createdAt: Date.now() };
    save();
    console.log('[管理员] 首位管理员：' + name + '，秘钥：' + key);
    return sendJson(res, 200, { ok: true, token, key, adminName: name, admins: data.admins });
  }

  if (p === '/api/admin/login' && method === 'POST') {
    const key = normKey(body.key);
    if (!data.adminKey) return sendJson(res, 400, { error: '管理员尚未初始化' });
    if (!key || key !== normKey(data.adminKey)) return sendJson(res, 401, { error: '秘钥错误，请重新输入' });
    const name = String(body.name || '').trim().slice(0, 20);
    if (name && !data.admins.some(a => a.name === name)) {
      data.admins.push({ name, first: false, createdAt: nowText() });
    }
    const token = rand(16);
    data.sessions[token] = { admin: true, adminName: name, createdAt: Date.now() };
    save();
    return sendJson(res, 200, { ok: true, token, adminName: name, admins: data.admins });
  }

  if (p === '/api/admin/data' && method === 'GET') {
    const s = getAdmin(req);
    if (!s) return sendJson(res, 401, { error: '管理员登录已失效' });
    return sendJson(res, 200, {
      stats: userStats(),
      feedback: data.feedback,
      bank: getBank(),
      dates: SD.DATES,
      admins: data.admins,
      adminName: s.adminName || ''
    });
  }

  if (p === '/api/admin/bank' && method === 'POST') {
    if (!getAdmin(req)) return sendJson(res, 401, { error: '管理员登录已失效' });
    const b = body.bank;
    if (!bankOk(b)) return sendJson(res, 400, { error: '题库格式不正确（需 10 题：5 选择 + 5 填空）' });
    data.bank = b;
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/feedback' && method === 'POST') {
    if (!getAdmin(req)) return sendJson(res, 401, { error: '管理员登录已失效' });
    const id = String(body.id || '');
    const fb = data.feedback.find(f => f.id === id);
    if (!fb) return sendJson(res, 404, { error: '反馈不存在' });
    if (fb.status !== 'pending') return sendJson(res, 200, { ok: true });
    if (body.action === 'clear') {
      const r = SD.rowIndexOf(fb.row);
      const s = Number(String(fb.seat).replace(/[^0-9]/g, ''));
      let n = 0;
      for (const d of SD.DATES) {
        const k = SD.seatKey(d.id, fb.sec, r, s);
        if (data.occ[k]) { delete data.occ[k]; n++; }
      }
      fb.status = 'done';
      fb.reply = '已清空该座位（' + n + ' 个场次），请重新填写';
    } else {
      fb.status = 'done';
      fb.reply = '核实未通过，座位维持原状';
    }
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/seat/clear' && method === 'POST') {
    if (!getAdmin(req)) return sendJson(res, 401, { error: '管理员登录已失效' });
    const sec = String(body.sec || '').trim().toUpperCase();
    const row = String(body.row || '').trim();
    const seat = String(body.seat || '').trim();
    if (!sec || !row || !seat) return sendJson(res, 400, { error: '请填写区域、排、座号' });
    const r = SD.rowIndexOf(row), s = Number(String(seat).replace(/[^0-9]/g, ''));
    let n = 0;
    for (const d of SD.DATES) {
      const k = SD.seatKey(d.id, sec, r, s);
      if (data.occ[k]) { delete data.occ[k]; n++; }
    }
    save();
    return sendJson(res, 200, { ok: true, count: n });
  }

  if (p === '/api/admin/seat/occupy' && method === 'POST') {
    if (!getAdmin(req)) return sendJson(res, 401, { error: '管理员登录已失效' });
    const sec = String(body.sec || '').trim().toUpperCase();
    const sc = SD.SECTIONS[sec];
    const row = String(body.row || '').trim();
    const seat = String(body.seat || '').trim();
    if (!sec || !row || !seat) return sendJson(res, 400, { error: '请填写区域、排、座号' });
    if (!sc) return sendJson(res, 400, { error: '区域不存在' });
    const r = SD.rowIndexOf(row);
    const s = Number(String(seat).replace(/[^0-9]/g, ''));
    if (r < 0 || r >= sc.rows.length) return sendJson(res, 400, { error: '排号超出该区域范围' });
    if (!(s >= 1 && s <= sc.rows[r])) return sendJson(res, 400, { error: '座号超出该排范围' });
    for (const d of SD.DATES) {
      if (data.occ[SD.seatKey(d.id, sec, r, s)]) return sendJson(res, 409, { error: '该座位已有登记/占用，请先清空' });
    }
    const note = String(body.note || '').trim().slice(0, 100) || '管理员标记：遮挡视线不售出';
    for (const d of SD.DATES) {
      data.occ[SD.seatKey(d.id, sec, r, s)] = {
        dateId: d.id, dateLabel: d.label, sec, r, s,
        tier: 'admin', tierName: '管理员占座',
        seatText: SD.rowLabel(r) + '排' + s + '座',
        uid: '', name: '管理员占座', time: nowText(), note
      };
    }
    save();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/admin/reset' && method === 'POST') {
    if (!getAdmin(req)) return sendJson(res, 401, { error: '管理员登录已失效' });
    data.occ = {};
    data.feedback = [];
    data.adminKey = '';
    data.admins = [];
    for (const k in data.sessions) { if (data.sessions[k].admin) delete data.sessions[k]; }
    save();
    return sendJson(res, 200, { ok: true });
  }

  return sendJson(res, 404, { error: '接口不存在' });
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, url) {
  let p;
  try { p = decodeURIComponent(url.pathname); } catch (e) { p = '/'; }
  if (p === '/') p = '/index.html';
  const rel = path.normalize(p).replace(/^([/\\]|\.\.[/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not Found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(buf);
  });
}

/* ---------------- 启动 ---------------- */

if (!USE_REDIS) load();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname.indexOf('/api/') === 0) {
    handleApi(req, res, url).catch(err => {
      console.error('[接口错误]', err.message);
      if (!res.headersSent) sendJson(res, 500, { error: err.message || '服务器错误' });
    });
    return;
  }
  serveStatic(req, res, url);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用，请设置其他端口后再启动，例如：');
    console.error('  PowerShell: $env:PORT=3001; node server.js');
  } else {
    console.error(err);
  }
  process.exit(1);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    const ips = [];
    const nets = os.networkInterfaces();
    for (const name in nets) {
      for (const n of nets[name] || []) {
        if (n.family === 'IPv4' && !n.internal) ips.push(n.address);
      }
    }
    console.log('演唱会座位登记网站已启动');
    console.log('  本机访问：http://localhost:' + PORT);
    ips.forEach(ip => console.log('  局域网访问：http://' + ip + ':' + PORT));
    console.log('  数据文件：' + DATA_FILE);
    if (!data.adminKey) console.log('  管理员秘钥：尚未初始化（首次进入管理员入口时，首位管理员填写昵称后生成）');
  });
}

// Vercel 等 Serverless 平台：直接导出请求处理函数，不监听端口
module.exports = { handleApi, serveStatic, server };
