# 弹棋问机 · 联机对战（实验版）

远程双人 **趣味局** 联机实验包。不含 `rl/` 与 ONNX AI。

## 公网联机（推荐）

**仅房主**在本机运行 **`serve-public.bat`**（Node 服务 + Cloudflare 隧道）。

| 角色 | 需要做什么 |
|------|-----------|
| **房主** | 运行 `serve-public.bat` → 浏览器打开 Cloudflare 的 `https://xxx.trycloudflare.com` → 创建房间 → **复制邀请链接** |
| **好友** | **只需**用手机/电脑浏览器点开邀请链接，自动加入，**无需**安装 Node、start-all.bat 或任何程序 |

邀请链接格式：`https://xxx.trycloudflare.com/?room=123456`

## 局域网

房主运行 `start-all.bat`，好友访问 `http://房主IP:8080/?room=房间号`。

## 启动（本地调试）

双击 **`start-all.bat`** — 仅本机或同一 WiFi 内使用。

## 架构（MULTIPLAYER_GUIDE）

```
浏览器 ── wss://域名/ws ──→ Node server/server.js
                              ├─ 静态页面托管
                              ├─ /api/health
                              └─ /ws 房间服务 (wsroom.js)
```

特性：clientId 防幻影席位 · 指数退避重连 · 心跳保活 · 房主断线 90s 宽限 · 空房间 60s 回收。

## 已确认需求

见 [`ONLINE_ANSWERS.md`](ONLINE_ANSWERS.md)。核心：

- 房间号匹配 · 房主权威物理 · **仅趣味局**
- 菜单：**联机 + 单机**（无本地双人）
- **盲布局**：布子阶段互相看不到对方棋子

## 局域网 / 公网

| 场景 | 做法 |
|------|------|
| 同一 WiFi | 房主 `start-all.bat`，好友访问 `http://房主IP:8080/?room=房间号` |
| **公网** | 房主 **`serve-public.bat`**，分享 Cloudflare 邀请链接；好友仅浏览器打开 |

**注意**：不要给好友发 `localhost` 或 `127.0.0.1` 链接，对方无法连接。

## 联机手感 / 卡顿对照测试

优化后采用：**服务端 60fps 物理 + 约 30Hz 增量 motion 下发 + 客户端 100ms 快照插值**（双端仍严格以服务端为准）。

| 步骤 | 做法 | 预期 |
|------|------|------|
| **1. 局域网基线** | 房主 `start-all.bat`，好友 `http://房主IP:8080/?room=房间号`，双方 Ctrl+F5 | 行棋应几乎无抖动 |
| **2. 公网对比** | 房主 `serve-public.bat`，分享 Cloudflare 链接，同样打一局 | 比优化前更顺；若仍抖，多为隧道抖动，可考虑 VPS |
| **3. 服务端** | 修改 `server/gameEngine.js` 后需**重启 Node 服务** | — |
| **4. 客户端** | 双方 **Ctrl+F5** 强刷 | — |

测量 motion 速率（可选）：在 `server/` 目录运行 `node test_motion_rate.cjs`（需有进行中的对局）。

## 文件

```
弹棋问机-联机对战/
├── server/server.js / server/wsroom.js
├── start-all.bat
├── js/online.js
└── …
```

旧版 `online_server.py`（Python 8765 端口）已废弃，保留仅供参考。

## 合并主线

将 `server/`、`js/online.js` 与 `game.js` 中 `ONLINE` 分支合回 `幽寂弹棋` 时，保持 `mode === 'ONLINE'` 开关。

---

若仍存在旧目录 **`弹棋问机-连击对战`**，可手动删除（此前误做，已废弃）。
