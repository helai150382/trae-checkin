# trae-checkin

Trae CN（国内版）每日自动签到脚本，适用于 Windows。零第三方依赖，不需要 `npm install`。

脚本通过 Trae 官方客户端使用的接口领取每日签到积分，并可注册 Windows 计划任务，每天固定时间自动执行。

> **免责声明**：本项目使用的是未公开的内部接口，并非 Trae 官方提供的 API。接口随时可能变更导致脚本失效。使用本脚本可能触犯服务条款或触发账号风控，请自行评估风险，后果自负。本项目与 Trae 官方无关。

## 环境要求

| 项目 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11 |
| Node.js | **18 或更高**（使用了内置 `fetch`） |
| 账号 | Trae CN（`trae.cn`）账号，国际版 `trae.ai` 没有签到功能 |

检查 Node 版本：

```powershell
node -v
```

## 快速开始

```powershell
# 1. 下载
git clone https://github.com/helai150382/trae-checkin.git
cd trae-checkin

# 2. 登录（会打开浏览器，登录后凭据自动保存）
node trae-checkin.mjs login

# 3. 立即签到一次，验证是否正常
node trae-checkin.mjs run

# 4. 注册计划任务，每天 07:00 自动签到
node trae-checkin.mjs install
```

## 命令

| 命令 | 说明 |
|---|---|
| `login` | 打开浏览器授权，保存凭据到 `%USERPROFILE%\.trae-checkin\credentials.json` |
| `run` | 执行一次签到（计划任务调用的就是这个） |
| `status` | 查看当前账号、token 有效期、今日签到状态、连续天数、总积分 |
| `install` | 注册每天 07:00 的 Windows 计划任务 |
| `uninstall` | 删除计划任务（不会删除凭据和日志） |
| `logout` | 删除本地凭据 |
| `--self-test` | 离线自测，用本地假服务验证四条分支，不消耗真实配额 |

## 计划任务

`install` 会创建名为 `TraeCheckin` 的任务，配置如下：

- 每天 **07:00** 触发
- 错过时间（如关机）后开机自动补跑
- 隐藏窗口运行，超时限制 10 分钟
- 需要网络可用

手动触发一次用于验证：

```powershell
schtasks /run /tn "TraeCheckin"
```

查看任务状态：

```powershell
schtasks /query /tn "TraeCheckin" /v /fo list
```

## 文件位置

所有数据都在 `%USERPROFILE%\.trae-checkin\`：

| 文件 | 内容 |
|---|---|
| `credentials.json` | 登录凭据（仅当前用户可读） |
| `logs\YYYY-MM-DD.log` | 每日运行日志，保留 30 天 |
| `logs\task.log` | 计划任务输出，超过 1 MB 自动轮转 |

日志中不记录 token 和密码。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功（含"今日已签到"） |
| 1 | 参数错误或未找到 Node |
| 2 | 登录超时 |
| 3 | 未登录 / 登录态失效，需要重新 `login` |
| 4 | 网络异常或接口返回异常 |
| 5 | 领取被拒（如设备限制） |

## 常见问题

**提示 9074 / 当前参与用户太多**

签到按设备计数。同一台机器多开账号时，只有第一个账号能领取成功。次日会重置。脚本遇到该错误当天不再重试。

**token 过期了怎么办**

脚本会在过期前自动用 refresh token 续期。只有 refresh token 也失效时才需要重新执行 `login`。

**换电脑后要做什么**

重新执行 `login` 和 `install` 即可，凭据不跨设备复制。

**如何确认明天会自动跑**

```powershell
schtasks /query /tn "TraeCheckin" /v /fo list | Select-String "Next Run Time"
```

## 许可

MIT
