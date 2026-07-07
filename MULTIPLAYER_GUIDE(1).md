# 学术大道 · 联机对战架构文档

> 版本：2026-06-22  
> 涵盖：公网隧道搭建、WebSocket 重连机制、防幻影席位方案

---

## 一、架构概览

```
浏览器 A ──┐                    ┌── 浏览器 B
            │ wss://domain/ws   │
            ▼                   ▼
┌─────────────────────────────────────┐
│     Cloudflare Tunnel (cloudflared)  │  ← 公网隧道，支持 WebSocket 透传
│     https://xxx.trycloudflare.com    │
└──────────────────┬──────────────────┘
                   │ http://localhost:80
                   ▼
┌─────────────────────────────────────┐
│  Node.js server/server.js           │
│  ├─ 静态文件托管 (demo/)             │
│  ├─ /api/* HTTP API (AI 代理等)      │
│  └─ /ws WebSocket 房间服务 (wsroom)  │
│     ├─ 房间管理 (创建/加入/离开)      │
│     ├─ 消息中继 (快照/意图/聊天)      │
│     ├─ 心跳探活 (30s 周期)           │
│     ├─ 房主断线宽限 + 迁移 (90s)     │
│     └─ 空房间自动回收 (60s)          │
└─────────────────────────────────────┘
```

### 通信协议

| 路径 | 协议 | 用途 |
|------|------|------|
| `/` | HTTP | 静态页面 / API |
| `/ws` | WebSocket | 联机对战实时通信 |

---

## 二、公网部署（cloudflared 隧道）

### 为什么需要 cloudflared

学术大道的联机对战使用 **WebSocket (wss://)** 在浏览器之间实时通信。局域网内可直接互联，但要让**外网好友**加入，需要一个公网隧道：
1. cloudflared 会自动获取 Cloudflare 的免费 HTTPS 域名（`*.trycloudflare.com`）
2. Cloudflare 原生支持 WebSocket 升级，无需额外配置
3. 客户端 `acadnet.js` 通过 `location.host` 自动构造 `wss://` 地址，透明接入

### 安装与启动

```bash
# 1. 下载 cloudflared
curl -L -o /tmp/cloudflared \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x /tmp/cloudflared

# 2. 启动 Node 服务（默认 80 端口）
PORT=80 node server/server.js &

# 3. 启动 cloudflared 隧道
/tmp/cloudflared tunnel --url http://localhost:80 --no-autoupdate
```

启动后日志会输出公网地址，例如：
```
https://reading-adjustable-film-gnome.trycloudflare.com
```

### 一键启动脚本

项目根目录提供了 `start.sh`，自动完成上述步骤：

```bash
./start.sh [端口号]    # 默认 80
```

### 多站点部署

同一台机器可部署多个站点，使用不同端口 + 不同 cloudflared 隧道：

| 站点 | 端口 | 静态根 (STATIC_ROOT) | 公网地址 |
|------|------|----------------------|----------|
| demo（九州主站） | 80 | `demo/` (默认) | `reading-adjustable-film-gnome.trycloudflare.com` |
| game_test（瓦肆） | 443 | `game_test/` | `scenarios-serum-norfolk-soma.trycloudflare.com` |

```bash
# 瓦肆部署示例
PORT=443 STATIC_ROOT=/root/workspace/game/game_test node server/server.js &
/tmp/cloudflared tunnel --url http://localhost:443 --no-autoupdate
```

### 分享联机地址

将以下地址发给好友：
```
https://你的域名.trycloudflare.com/xueshudadao/
```

好友进入后，房主创建房间，通过"📋 复制房间号/邀请链接"按钮分享，好友点击链接即可自动填入房间号。

---

## 三、重连机制详解

### 客户端 (acadnet.js)

| 场景 | 行为 |
|------|------|
| **刷新页面** | `tryResume()` 从 localStorage 读取上次房间号，发送 `hello` 握手恢复座位 |
| **WebSocket 断开** | 指数退避重连 (500ms → 8000ms，×1.7)；连接后自动发送 `hello` 恢复 |
| **对局中退出** | 调用 `quitGame()` 发送 `leave` 后断开，但**保留 session**。60 秒内刷新页面可自动恢复，60 秒后房间回收则收到 `no_room` 错误并**自动清除 session** |
| **从大厅退出** | 调用 `leave()` 完全清除 session，无法再自动恢复 |

### 服务端 (wsroom.js)

| 场景 | 行为 |
|------|------|
| **重连回座** | `hello` 消息匹配 `clientId` → 恢复原 seat、在线状态，断开旧连接 |
| **房主断线 (对局中)** | 90 秒宽限期，期间访客显示"房主掉线"横幅；超时后最长在线访客自动晋升为新房主 |
| **全员离线** | 60 秒后自动关闭房间 |
| **大厅离开** | 移除座位，剩余成员座位重排 |

### 心跳保活

```
客户端 ── ping (每 25s) ──→ 服务端
服务端 ── pong          ──→ 客户端
服务端 ── ping (每 30s) ──→ 客户端（服务端主动探活）
```

---

## 四、防幻影席位方案

### 问题：同一玩家多次加入房间产生同名幻影席位

**根因**：
1. `joinRoom()` 在 `connect()` 前设置了 `net.code`，导致 `onopen` 同时发送 `hello` + `join`，服务端收到两次新人请求
2. 服务端为每个"新人"生成新 `clientId`，忽略客户端的持久化 ID，导致同一个人被创建为两个不同 ID 的成员

### 修复方案 (2026-06-22 已实施)

**客户端修复 (acadnet.js)**：
- `joinRoom()` 不再预置 `net.code`，避免 `onopen` 误发 `hello`
- `createRoom()` 增加 `clientId` 字段发送给服务端
- `joinRoom` 的创建消息携带客户端 `clientId`

**服务端修复 (wsroom.js)**：
- `onCreate` 和 `onJoin` 优先使用客户端传来的 `clientId`
- 重连时 `hello` 的 `clientId` 与创建时的 `clientId` 一致 → 正确恢复座位
- 新增加入时检查 `clientId` 是否已存在于房间 → 防止重复

**效果**：
- 同一个人无论刷新、重连多少次，始终占据同 1 个席位
- 不再出现同名幻影

---

## 五、关键参数一览

| 参数 | 值 | 说明 |
|------|-----|------|
| `MAX_MEMBERS` | 4 | 房间最大人数 |
| `GRACE_MS` | 90s | 房主断线宽限 |
| `EMPTY_ROOM_TTL` | 60s | 全员离线后房间回收 |
| `HEARTBEAT_MS` | 30s | 服务端心跳间隔 |
| 客户端心跳 | 25s | 客户端 ping 间隔 |
| 客户端重连延迟 | 500ms–8000ms | 指数退避，×1.7 |
| AI 兜底超时 | 30s | 玩家超时未操作由 AI 托管 |
| 会话持久化 | localStorage | `acadNetClientId` + `acadNetSession` |

---

## 六、常见问题排查

### Q: 联机版一直显示"连接中/重连中"

| 排查步骤 | 操作 |
|---------|------|
| 1. 检查 Node 服务 | `curl http://localhost:80/api/health` 应返回 `{"ok":true}` |
| 2. 检查 cloudflared | `ps aux \| grep cloudflared` |
| 3. 检查 WebSocket | `curl -sI -H 'Upgrade: websocket' -H 'Connection: Upgrade' http://localhost:80/ws` |
| 4. 浏览器 F12 查看 Network → WS 连接状态 |

### Q: 服务端运行但好友连接不上

- 确认 cloudflared 隧道正在运行
- 确认使用的是公网域名（`*.trycloudflare.com`），而非 `localhost`
- 确认隧道指向正确端口（默认 80）
- Cloudflare 免费隧道有稳定性限制，生产环境建议使用 Named Tunnel

### Q: 出现多个同名玩家

- 已通过 2026-06-22 修复解决。如果仍出现，请确认 `index.html` 中 JS 版本号为最新（`acadnet.js?v=5`、`xueshudadao.js?v=15`），并清除浏览器缓存。

### Q: 重进游戏自动跳到联机模式，显示"房间不存在"

这是正常的重连机制：浏览器 localStorage 保留了你上次的昵称和房间号。
超出 60 秒房间已销毁后，客户端收到服务端 `no_room` 错误，会**自动清除本地会话**
——下次进入不会再尝试重连这个已销毁的房间。昵称仍会保留（方便建房时无需重填）。

---

## 七、文件清单

| 文件 | 职责 |
|------|------|
| `server/server.js` | Node HTTP + WebSocket 服务入口 |
| `server/wsroom.js` | WebSocket 房间/成员管理，RFC 6455 帧处理 |
| `demo/xueshudadao/acadnet.js` | 浏览器 WebSocket 客户端 |
| `demo/xueshudadao/xueshudadao.js` | 游戏引擎 + 联机集成 |
| `demo/xueshudadao/index.html` | 页面入口 + UI |
| `start.sh` | 一键启动脚本 |
| `/tmp/cloudflared` | cloudflared 二进制 |
| `game_test/xueshudadao/` | 瓦肆版学术大道（与 demo 代码同步） |

> `server/server.js` 支持 `STATIC_ROOT` 环境变量切换静态根目录，默认 `demo/`。