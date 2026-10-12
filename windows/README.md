# 扫码建飞书机器人（Windows / Linux 同一套代码）

同一份代码跑两个平台：**功能一样**（扫码 → 建**完全隔离**的实例 → 起服务 → 建同名工作目录），
差别只在**路径**和**怎么拉起服务**——全部集中在 `platform.js`，没有写死的 `D:\` 或 `/home`。

```
浏览器打开  http://<公网IP>:8087/?k=<口令>
   ↓ 点「重新出码」（名字重了会摇框拦下）
   手机飞书扫码 → 授权 → 页面拿到新应用的 appId/appSecret
   ↓
provision.js:  建实例家目录 → 复制插件树 → 复制 settings/memory/skills
               → 写只属于它自己的凭据补丁 → 建同名工作目录 → 注册服务并启动
   ↓
verify-iso.js: 隔离审计（退出码 = 不合格项数）
```

## 一、Windows 与 Linux 的差异（都在 platform.js 里）

| 项目 | Windows | Linux |
|---|---|---|
| 实例家目录 | `D:\dsh\home-<名>` | `~/.dsh-<名>` |
| 工作目录（与实例同名） | `D:\<名>` | `~/<名>` |
| 服务机制 | 计划任务 `dsh-<名>` + `start-<名>.cmd`（.cmd 里带崩溃重启循环） | systemd user 单元 `dsh-<名>.service`（`Restart=always`） |
| 自启 | `schtasks /sc onstart /ru SYSTEM` | `systemctl --user enable --now` |
| 启停命令 | `schtasks /run\|/end /tn dsh-<名>` | `systemctl --user restart\|disable --now dsh-<名>` |
| 实例的 env | 写在启动脚本里（`set K=V`），凭据从父实例 `winsw-dsh.xml` 的 `<env>` 抄 | 写在 `~/.config/dsh-<名>.env`，由单元 `EnvironmentFile=` 加载；env 从父实例的 EnvironmentFile 整份继承 |
| 应用凭据落点 | profile 补丁 `cordis.patch.yml` | 同上（补丁 + env 双写，两种读法都覆盖） |
| 日志 | `D:\dsh\logs\dsh-<名>.log`（启动脚本）+ `<家目录>\feishu\logs\dsh-feishu.log`（桥） | `~/logs/dsh-<名>.log` + `<家目录>/feishu/logs/dsh-feishu.log` |
| 删实例 | `schtasks /delete` + `taskkill` + 删目录 | `systemctl --user disable --now` + 删单元 + `daemon-reload` + 删目录 |

### 想改成别的路径：全都能用环境变量覆盖

```bash
DSH_INSTANCE_ROOT   实例家目录的根      (Win D:\dsh        / Linux ~ )
DSH_INSTANCE_DIRNAME 家目录命名模板      (Win home-{name}   / Linux .dsh-{name})
DSH_WORKSPACE_ROOT  工作目录的根        (Win D:\           / Linux ~ )
DSH_PARENT_HOME     父实例的家          (Win D:\dsh\home   / Linux ~/.dsh)
DSH_PROFILE         父/子共用的 profile 名（默认 feishu）
DSH_NODE / DSH_BIN  用哪个 node、哪个 dsh 入口
DSH_LOG_DIR         启动脚本的日志目录
DSH_UNIT_DIR        Linux systemd user 单元目录
```

例：Linux 上想让工作目录落在 `/srv/dsh-workspace/<名>`：
`DSH_WORKSPACE_ROOT=/srv/dsh-workspace node provision.js create feishu3 --appId ... --appSecret ...`

## 二、用法

```bash
node provision.js plan   feishu3                       # 只看要建什么（不落盘）
node provision.js create feishu3 --appId cli_x --appSecret y
node provision.js start  feishu3
node provision.js remove feishu3                       # 服务 + 家目录 + 工作目录一起清
node verify-iso.js feishu3                             # 隔离审计，退出码=不合格项数
```

扫码页面会自动跑 `create`（`server.js` 里 `onAuthorized()`），所以正常不需要手敲。

**实例名规则**（与插件 v0.4.x 完全一致）：`trim → 小写 → 非 [a-z0-9-] 换 - → 去首尾 - → 截 20 字符 → 空则 feishu2`；
页面会先查重（同名实例 / `home-<名>` / `D:\<名>` 任一存在即占用）——重名**摇框拦下**并返回 409，服务端也会再拦一次。

## 三、新建出来的实例，第一句话就能干活

新实例的会话一开始**没有绑定工作目录**，桥默认会拒绝干活并回一句
“No working directory chosen yet … Send /repo to choose”。所以 `provision.js` 写补丁时会带两条：

```yaml
- id: feishu
  config:
    appId: '...'
    appSecret: '...'
    requireWorkingDir: false      # 关掉门禁
    defaultCwd: 'D:\feishu3'      # 默认工作目录 = 它自己的 workspace
```

父实例**不开**这两条（保留“先选目录再干活”的门禁），只有派生实例开。
（这两条是 profile 启动时校验的，写错会让实例起不来；已在 Windows 上实测通过。）

## 四、隔离语义（与插件 v0.4.x 一致）

- 插件树**整棵复制**成副本，树内指向父实例的链接**改指副本**（含 `.dsh-module-fallback` 这类绝对链接）；
- `settings.yaml` / `memory` / `skills` 逐项复制；
- `sessions` / `feishu` / `storages` / `attachments` 状态目录**新建空目录**，不继承；
- 只读框架依赖（dsh 安装闭包、`node_modules` 依赖镜像）保持原样——那是库不是状态；
- 派生实例的凭据只写进**它自己**的文件，父实例一个字节都不动。

实测：审计 17/17 通过；每实例约 93 MB 磁盘 / 230 MB 内存，创建约 2 秒。

## 五、两个 Windows 侧的坑（Linux 上不存在）

1. **`fs.cpSync({recursive:true, dereference:false})` 在 Windows 上会跳过 junction**——
   55,727 个文件的父树只拷出 4,969 个、0 个链接。必须自己遍历复制（目录 mkdir、文件 copy、链接重建），
   否则“隔离”是假的：子实例的依赖其实还指向父实例。
2. **`.cmd` / `.ps1` 传过去必须 CRLF**；`.ps1` 里别写中文（PS 5.1 按 GBK 读 UTF-8 会乱码）。
