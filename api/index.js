// Vercel Serverless 入口
// 所有 /api/* 请求经 vercel.json 的 rewrite 转发到这里，再交给 server.js 的 handleApi 处理。
// 本地开发不经过此文件，直接 node server.js 即可。
const { handleApi } = require('../server.js');

module.exports = (req, res) => {
  const host = req.headers.host || 'localhost';
  const url = new URL(req.url, 'http://' + host);
  handleApi(req, res, url).catch(err => {
    console.error('[接口错误]', err && err.message);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: (err && err.message) || '服务器错误' }));
    }
  });
};
