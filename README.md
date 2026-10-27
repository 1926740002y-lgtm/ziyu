# 演唱会座位登记 · Vercel 部署版

零依赖 Node.js 网站：静态页面 + 单个 Serverless 接口函数，数据存放在外部 Redis（Upstash），可在任意浏览器、手机与电脑访问。

## 目录结构（这些文件必须放在仓库根目录）

```
vercel.json          路由配置：静态页面 + /api/* 全部转发到 api/index.js
api/index.js         Vercel 函数入口，调用 server.js 的 handleApi
server.js            全部业务接口（本地也可直接 node server.js 运行）
public/              前端页面（index.html / app.js / style.css / seatdata.js）
package.json         启动脚本（云平台识别用）
```

## 部署步骤

1. **上传仓库**：把本目录下所有文件（含 `api/`、`public/` 两个文件夹）放到 GitHub 仓库根目录，不要套外层文件夹。
2. **Vercel 导入**：Vercel → Add New → Project → 选择该仓库 → Framework 选 **Other**，Root Directory 保持 `./`，Build Command 留空，Output Directory 填 `public`（`vercel.json` 已写好，通常无需手动改）。
3. **创建数据库**：Vercel 项目 → Storage / Marketplace → **Upstash Redis**（选 Free 档）→ 连接到当前项目。
   会自动注入环境变量，代码同时兼容两套命名：
   - `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
   - `KV_REST_API_URL` + `KV_REST_API_TOKEN`
   若手动创建，请到 Vercel → Settings → Environment Variables 自行添加。
4. **Redeploy**：添加环境变量后必须重新部署一次才会生效。
5. 打开分配的域名即可访问。管理员入口在登录页右下角 👤，首次进入生成秘钥（保存在 Redis，重启不丢）。

## 数据说明

- 全部数据以 JSON 形式存放在 Redis 键 `seat:data`（可用 `DATA_KEY` 环境变量改名）。
- 写请求会加 Redis 分布式锁（`seat:lock`），避免并发重复占座。
- 想清空：管理员后台「清空全部数据」，或在 Upstash 控制台删除 `seat:data`。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `UPSTASH_REDIS_REST_URL` / `KV_REST_API_URL` | Vercel 必填 | Redis REST 地址 |
| `UPSTASH_REDIS_REST_TOKEN` / `KV_REST_API_TOKEN` | Vercel 必填 | Redis REST 令牌 |
| `DATA_KEY` | 可选 | 数据键名，默认 `seat:data` |

未配置 Redis 时，程序退回本地 `data.json` 文件模式（`node server.js` 本地开发用），Vercel 上不配置会每次请求丢失数据。

## 本地运行

```bash
node server.js
# 打开 http://localhost:3000
```

手机上访问：与电脑同一 Wi-Fi，打开启动日志里打印的局域网地址。

## 免费额度参考（Upstash Free）

- 每天 10,000 条命令、256MB 存储。
- 一次选座约消耗 5 条命令，一次查看座位图约 1 条；几十人规模足够，超出请升级或改回自有服务器 + Docker。
- 单个键上限约 1MB：反馈截图是压缩后的 base64，图片过多时建议定期在后台处理或清空已处理反馈。
