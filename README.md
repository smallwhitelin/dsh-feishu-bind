# dsh-feishu-bind

[![CI](https://github.com/smallwhitelin/dsh-feishu-bind/actions/workflows/ci.yml/badge.svg)](https://github.com/smallwhitelin/dsh-feishu-bind/actions/workflows/ci.yml)

**浏览器扫码绑定飞书机器人** —— 给 [DeepSeek Harness](https://github.com/deepseek-ai)（dsh）用的一个小插件。

不用 SSH 进终端跑向导、不用 dsh 的 web 界面：插件自带一个极小的 HTTP 服务，浏览器打开就是一张二维码，
用飞书 App 扫码授权后，凭据自动写进你指定的 env 文件并重启你的桥。
**刷新页面即生成新二维码，扫码替换原绑定**；绑定完成后页面显示**绿勾**，点绿勾也能生成新码重绑。

```
浏览器 ──GET /──► 插件自带 HTTP 服务（默认 127.0.0.1:3001）
                        │
                        ├─ registerApp ──► 飞书授权页（扫码 → 新建应用 / 更新既有应用）
                        │
                        └─ 授权成功 → 写 env 文件 → 重启桥 → 页面绿勾（已接线）
```

## 特性

| 能力 | 说明 |
|---|---|
| 网页扫码 | 打开页面即出二维码，手机/电脑都能开 |
| 绿勾状态 | 扫完自动写凭据 + 重启桥；只有日志里出现**比绑定更新的** `long connection ready` 才显示绿勾（真接线，不是"我以为接上了"） |
| 刷新换码 | 每次刷新页面 = 新一轮授权流程，生成全新二维码（旧码作废） |
| 点绿勾换码 | 绑定后点绿勾同样生成新码，扫码即改绑定 |
| 复用既有应用 | env / 配置里已有 `FEISHU_APP_ID` 时走"**更新该应用并重新授权**"，机器人身份不变；没有则新建（`forceCreate: true` 可强制每次新建） |
| 预置权限 | 授权页已勾好 `im:message` / `im:message:send_as_bot` / `im:resource` 权限、`im.message.receive_v1` 事件、`card.action.trigger` 回调 |
| 零 web 依赖 | 插件自带 `node:http`，`inject: []`，没有 dsh web 表面的 profile 也能跑 |
| 不拖垮 profile | 缺依赖、端口占用、写文件失败都只记日志 + 页面报错，绝不 throw 到插件树 |
| **零重依赖** | 飞书设备码（扫码注册）流程自带实现（`lib/register-app.js`），不拉 `@larksuiteoapi/node-sdk` 那套重依赖——安装时不会被 pnpm 的构建脚本拦截 |
| 可测试 | 纯逻辑与外部副作用全部可注入，`npm test` 无需网络和真实 SDK |

## 安装

```bash
git clone https://github.com/smallwhitelin/dsh-feishu-bind.git
cd dsh-feishu-bind
npm pack                                    # 会先跑一遍测试

dsh plugin --profile <你的 profile> add ./dsh-feishu-bind-<版本>.tgz
systemctl --user restart dsh-<你的桥>.service   # 或你启动 dsh 的其它方式
```

> 也可以直接从仓库装：`dsh plugin --profile <profile> add github:smallwhitelin/dsh-feishu-bind`

启动后日志里会出现：

```
[feishu-bind] 绑定页已就绪：http://127.0.0.1:3001/
```

## 配置

所有配置都有默认值；要改就在 profile 的 `cordis.patch.yml` 里按 id 覆盖（不改插件自带的 patch）：

```yaml
- id: feishu-bind
  config:
    host: '127.0.0.1'        # 只监听本机
    port: 3001               # 本机端口
    token: ''                # 非空 → 访问需带 ?k=<token>
    envFile: '~/.config/dsh-feishu.env'        # 凭据写这里（你的桥读的 EnvironmentFile）
    stateFile: '~/.dsh/feishu-bind-state.json' # 绑定记录（重启后绿勾仍在）
    serviceUnit: 'dsh-feishu.service'          # 绑定成功后重启的 systemd user 单元
    logFile: ''              # 桥日志路径；留空 = 按服务状态判断是否已接线
    appId: ''                # 指定 cli_xxx → 更新该应用；留空 = 用 env 里的；都没有 = 新建
    appName: 'DSH Agent'     # 授权页预填的应用名
    appDesc: 'DeepSeek Harness 飞书机器人'
    autoRestart: true        # 授权后自动重启桥
    forceCreate: false       # true = 每次扫码都新建应用
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `3001` | 监听地址与端口。**默认只监听本机** |
| `token` | 空 | 访问口令。页面可被本机以外访问时**强烈建议设置** |
| `envFile` | `~/.config/dsh-feishu.env` | 凭据写入位置（按行更新，只动 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_TENANT`，其它键与注释原样保留，文件权限 `600`）。留空 = 不写文件，凭据显示在页面上供手动配置 |
| `stateFile` | `~/.dsh/feishu-bind-state.json` | 绑定记录，重启后绿勾仍在 |
| `serviceUnit` | `dsh-feishu.service` | 绑定成功后重启的 systemd user 单元；留空 = 不自动重启 |
| `logFile` | 空 | 桥日志路径，用于判断"已接线"；留空则按 `serviceUnit` 的运行状态判断 |
| `appId` | 空 | 指定既有应用（更新+重新授权）；留空取 env 里的 |
| `forceCreate` | `false` | 强制每次扫码新建应用 |

### 从别的设备访问

插件默认只听本机。要让手机/其它电脑打开这个页面，把它接到你能访问的地址上（**端口转发**或**反向代理**，规则自定），
然后在浏览器打开那个地址即可。若该地址可能被他人访问，请务必设置 `token`，访问时带上 `?k=<token>`。

## 使用流程

1. 浏览器打开 `http://127.0.0.1:3001/` → 自动出现二维码；
2. 飞书 App 扫码 →（首次）确认应用名称 → 授权；**已有应用**会显示更新内容并重新授权；
3. 页面转圈"已授权，正在写入凭据并重启桥…"，随后变成 **✓ 已绑定，桥已接线**；
4. 之后在飞书里私聊机器人即可，消息自动进入 dsh；
5. **换绑**：刷新页面（或点绿勾）→ 新二维码 → 再扫一次即可。

## HTTP 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 绑定页 |
| GET | `/api/state` | 状态 JSON：`phase` / `qrPng` / `expiresAt` / `appId` / `wired` / `lastReadyAt` / `serviceState` / `log` |
| POST | `/api/qr` | 开新一轮扫码（作废当前二维码） |
| POST | `/api/apply` | 手动重写凭据 + 重启桥 |
| GET | `/healthz` | 存活探针 |

`phase`：`idle` → `waiting`（出码等待）→ `authorized` → `applying` → `bound` / `error`。

## 安全

这个页面**能新建飞书应用并把凭据写进本机**，等价于一个开通入口：

- 插件默认只监听 `127.0.0.1`，本机之外访问不到；
- 一旦把它暴露到别的设备/网络，请设置 `token`（例如 32 位随机串），访问地址变成 `http://<你的地址>/?k=<token>`；
- 不设 `token` 时页面顶部会显示醒目警告，此时**任何能访问该地址的人都能扫码绑定**（扫码者需是其飞书租户的管理员，但绑上的应用会归其控制）。

## 排查

| 现象 | 处理 |
|---|---|
| 页面打不开 | 看 dsh 日志里 `[feishu-bind]` 行；确认端口没被占用（`ss -ltnp \| grep <port>`） |
| 一直"等待扫码" | 二维码约 10 分钟过期，点「换一张二维码」；确认机器能出网访问飞书 |
| 一直"等待桥重启接线" | `systemctl --user status <serviceUnit>`；日志里要有 `long connection ready`。服务没起来时页面会一直显示"等待"，不会假装成功 |
| 写凭据失败 | 检查 `envFile` 所在目录权限；插件只动 `FEISHU_APP_ID/SECRET/TENANT` 三行 |
| 想解除绑定 | 删掉 `stateFile` 与 `envFile` 里的 `FEISHU_*`，或重新扫一次覆盖 |

## 开发与测试

```bash
node --import ./test/loader-hook.mjs test/run.mjs
```

测试自带宿主包桩（`@deepseek-ai/schemastery` 等缺失时自动回落），不需要网络、不需要真实飞书 SDK：

- **纯逻辑**：env 行合并/解析、接线判断、应用 ID 掩码；
- **扫码协议**：`addons` 的 gzip+base64url 编码往返、二维码 URL 组装、轮询（pending → 成功）、
  用户拒绝/主动中止、`tenant_brand=lark` 时切国际站域名；
- **端到端**：起真 HTTP 服务 + 注入桩 → 出码 → 授权 → 写凭据 → 触发重启 → 换码重绑，以及 token 口令、`forceCreate` 分支；
- **卫生检查**：发布文件里不许出现主机痕迹（IP、绝对家目录、端口映射键、真应用 ID…）。

## License

MIT
