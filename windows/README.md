# Windows 扫码页 + 实例 provisioning（old-home 实测）

`qr-server/` 那套是 Linux（systemd）版；这里是**同一件事的 Windows 版**，在 old-home
（`D:\dsh`，WinSW/计划任务，无 systemd）上实测跑通。

## 它做什么

```
浏览器打开 http://<公网IP>:8087/?k=<口令>
   → 出一个飞书扫码二维码（实例名可填，默认自动取下一个空闲 feishuN）
   → 用户用飞书扫码授权
   → 服务端拿回 app_id/app_secret，然后：
       1. 建一套**完全隔离**的实例   D:\dsh\home-<实例名>
       2. 建同名工作目录              D:\<实例名>
       3. 注册开机自启的服务         计划任务 dsh-<实例名>
       4. 启动它
   → 页面显示：实例 / 工作目录 / 家目录 / 服务 / appId / appSecret
```

## 文件

| 文件 | 作用 |
|---|---|
| `server.js` | HTTP 页面 + 扫码流程编排 + 实例名查重（重名 409 + 页面摇框提醒） |
| `provision.js` | 建/删隔离实例：插件树整树复制、链接改指副本、凭据补丁、启动脚本、计划任务 |
| `verify-iso.js` | 隔离审计（17 项，退出码 = 不合格项数） |
| `register-app.js` | 飞书设备码流程（零依赖，取自 `dsh-feishu-bind`，MIT） |
| `package.json` | 只需 `qrcode`（ESM） |
| `start.cmd` | 启动模板（内置崩溃重启循环） |

## 部署

```cmd
:: 1) 拷到 D:\dsh\qrcode-bind\，装依赖
cd /d D:\dsh\qrcode-bind && npm install
:: 2) 自启（改口令改 start.cmd）
schtasks /create /tn oldhome-bindpage /tr "D:\dsh\qrcode-bind\start.cmd" /sc onstart /ru SYSTEM /rl HIGHEST /f
schtasks /run  /tn oldhome-bindpage
:: 3) 公网入口：另起一个 frpc（独立进程，不动承载 ssh 的主进程）
::    frpc-qr.toml: localPort=3001 remotePort=8087；frpc verify -c frpc-qr.toml 先验证
```

## 隔离语义（与 `dsh-feishu-bind` v0.4.x 一致）

| 项目 | 共享还是隔离 |
|---|---|
| 插件树 / 补丁 / settings.yaml / memory / skills | **各持副本** |
| sessions / storages / feishu 映射 / 应用凭据 | 各自独立 |
| 只读框架依赖（dsh 安装包本身） | 共用（库，不是状态） |
| 父实例 | 全程不动 |

审计怎么跑：

```cmd
node verify-iso.js feishu2      :: 退出码 = 不合格项数；0 才算过
```

实测（2026-10-12，old-home）：**17/17 通过**；每实例约 **93 MB 磁盘 / 230 MB 内存**，创建约 **2 秒**。

## 两个 Windows 侧的坑（都实测过）

1. **`fs.cpSync(..., {dereference:false, verbatimSymlinks:true})` 不复制 junction** —— 55,727 文件的父树只拷出 4,969 个、0 链接（pnpm 的 `node_modules` 几乎全是 junction）。
   必须自己遍历：目录 `mkdir`、文件 `copyFile`、链接 `symlinkSync(target, dest, isDir?'junction':'file')`（junction 要绝对目标，失败退化成实体复制）。
2. `.cmd` / `.ps1` 传到 Windows **必须 CRLF**；`.ps1` 里别写中文（PowerShell 5.1 按 GBK 读 UTF-8 会解析失败）。

## 安全

页面是**公网可达的开通入口**（能创建飞书应用 + 在本机建实例），因此：

- 必须带口令访问（`?k=<token>`，默认空口令时页面顶部会警告）；
- 不用时停掉：`schtasks /end /tn oldhome-bindpage` + `/tn oldhome-frpc-qr`，要用再 `/run`；
- 每轮扫码都是 `createOnly`（新建应用），**不会覆盖已有机器人**。
