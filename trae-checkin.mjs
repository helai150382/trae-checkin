#!/usr/bin/env node
/**
 * Trae CN 每日签到脚本（Windows 计划任务版）
 *
 * 用法：
 *   node trae-checkin.mjs login     首次浏览器授权，生成 credentials.json
 *   node trae-checkin.mjs run       每日签到（计划任务调用）
 *   node trae-checkin.mjs status    查看当前签到/凭据状态
 *   node trae-checkin.mjs logout    删除本地凭据
 *   node trae-checkin.mjs install   注册每天 07:00 的 Windows 计划任务
 *   node trae-checkin.mjs uninstall 删除计划任务
 *   node trae-checkin.mjs --self-test  离线自测（不消耗真实配额）
 *
 * 凭据与日志保存在 %USERPROFILE%\.trae-checkin\ ，仅当前用户可读。
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:tls';
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { URL } from 'node:url';

// ---------- 常量（与官方插件 channel-pack 保持一致） ----------
const UG_HOST = 'https://api.trae.cn';
const OAUTH_HOST = 'https://api.trae.com.cn';
const CONSOLE_HOST = 'https://www.trae.cn';
const CHECKIN_STATUS_PATH = '/trae/api/v2/ug/checkin_credits/status';
const CHECKIN_CLAIM_PATH = '/trae/api/v2/ug/checkin_credits/claim';
const EXCHANGE_PATH = '/cloudide/api/v3/trae/oauth/ExchangeToken';
const CLIENT_ID = 'en1oxy7wnw8j9n';
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8';
const IDE_VERSION = '0.1.52';
const IDE_VERSION_CODE = '20260811';
const PLUGIN_VERSION = '2.3.62834';
const REQUEST_TIMEOUT_MS = 30000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

const STORE_DIR = join(homedir(), '.trae-checkin');
const CRED_PATH = join(STORE_DIR, 'credentials.json');
const EMAIL_CFG_PATH = join(STORE_DIR, 'email.json');
const LOG_DIR = join(STORE_DIR, 'logs');

// ---------- 工具 ----------
function ensureDir(p) { if (!existsSync(p)) mkdirSync(p, { recursive: true }); }
ensureDir(STORE_DIR); ensureDir(LOG_DIR);

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  const file = join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
  writeFileSync(file, line + '\n', { flag: 'a', mode: 0o600 });
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 与插件相同的派生规则：15 位设备号 / market user id / session id
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`;
  const result = [];
  let counter = 0;
  while (result.length < nbytes) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(counter, 0);
    const h = createHash('sha256').update(prefix, 'utf8').update(buf).digest();
    for (const b of h) { result.push(b); if (result.length >= nbytes) break; }
    counter++;
  }
  return result.slice(0, nbytes);
}
function seededDigits(n, seed, salt) {
  return seededStream(seed, salt, n).map(b => String(b % 10)).join('');
}
function deriveDeviceId15(uid) { return seededDigits(15, uid, 'devid'); }
function deriveMarketUserId(uid) {
  const bs = seededStream(uid, 'market', 16);
  bs[6] = (bs[6] & 0x0f) | 0x40; bs[8] = (bs[8] & 0x3f) | 0x80;
  const hex = bs.map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}
function deriveSessionId(uid) {
  return seededStream(uid, 'sess', 32).map(b => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(n) {
  const buf = Buffer.alloc(Math.ceil(n / 2));
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  return buf.toString('hex').slice(0, n);
}

function machineTraceId(machineId, deviceId) {
  return createHash('sha256').update(`${machineId}:${deviceId}`).digest('hex');
}

// ---------- 凭据 ----------
function loadCred() {
  if (!existsSync(CRED_PATH)) return null;
  try { return JSON.parse(readFileSync(CRED_PATH, 'utf8')); }
  catch { return null; }
}
function saveCred(c) {
  writeFileSync(CRED_PATH, JSON.stringify(c, null, 2), { mode: 0o600 });
}

function jwtExpiresAtMs(token) {
  try {
    const part = token.split('.')[1];
    if (!part) return undefined;
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch { return undefined; }
}

function credExpiresAtMs(c) {
  if (c.expires_at) {
    const v = String(c.expires_at);
    if (/^\d+$/.test(v)) { const n = Number(v); return n > 1e12 ? n : n * 1000; }
    const p = Date.parse(v); if (!Number.isNaN(p)) return p;
  }
  return jwtExpiresAtMs(c.access_token);
}
function isExpired(c, skewMs = 5 * 60 * 1000) {
  const t = credExpiresAtMs(c);
  return t === undefined ? false : Date.now() >= t - skewMs;
}

// ---------- 邮件推送 ----------
function loadEmailConfig() {
  if (!existsSync(EMAIL_CFG_PATH)) return null;
  try { return JSON.parse(readFileSync(EMAIL_CFG_PATH, 'utf8')); } catch { return null; }
}
function saveEmailConfig(cfg) {
  writeFileSync(EMAIL_CFG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

// 零依赖 SMTP（隐式 TLS，端口 465）
function smtpSend({ host, port, user, pass, from, to, subject, body }) {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port, servername: host });
    let buf = '';
    let stage = 0;
    let done = false;
    const b64 = s => Buffer.from(s, 'utf8').toString('base64');
    const send = (line) => socket.write(line + '\r\n');
    const fail = (msg) => { if (!done) { done = true; socket.destroy(); reject(new Error(msg)); } };
    const onLine = (line) => {
      const code = line.slice(0, 3);
      if (line[3] === '-') return; // 多行响应，等最后一行
      // 2xx 成功、3xx 中间响应（如 334 用户名/密码提示、354 开始 DATA）都继续
      if (code[0] !== '2' && code[0] !== '3') return fail('SMTP ' + line);
      switch (stage) {
        case 0: send('EHLO trae-checkin'); stage = 1; break;
        case 1: send('AUTH LOGIN'); stage = 2; break;
        case 2: send(b64(user)); stage = 3; break;
        case 3: send(b64(pass)); stage = 4; break;
        case 4: send(`MAIL FROM:<${from}>`); stage = 5; break;
        case 5: send(`RCPT TO:<${to}>`); stage = 6; break;
        case 6: send('DATA'); stage = 7; break;
        case 7: {
          const msg = [
            `From: <${from}>`,
            `To: <${to}>`,
            `Subject: ${subject}`,
            `MIME-Version: 1.0`,
            `Content-Type: text/plain; charset=utf-8`,
            `Content-Transfer-Encoding: base64`,
            '',
            b64(body),
            '.',
          ].join('\r\n');
          send(msg); stage = 8; break;
        }
        case 8: send('QUIT'); stage = 9; break;
        case 9: done = true; socket.end(); resolve(true); break;
      }
    };
    socket.on('data', d => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        onLine(line);
        if (done) return;
      }
    });
    socket.on('error', e => fail(String(e)));
    socket.on('close', () => { if (!done) fail('SMTP 连接提前关闭'); });
    setTimeout(() => fail('SMTP 超时'), 30000).unref();
  });
}

async function sendResultEmail(result, status) {
  const cfg = loadEmailConfig();
  if (!cfg) return false;
  const date = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const statusLine = status
    ? `签到状态：${status.checkedIn ? '已签' : '未签'} | 连续签到：${status.streakDays} 天 | 总积分：${status.totalCredits}`
    : '（状态查询不可用）';
  const body =
    `Trae 每日签到结果\n` +
    `时间：${date}\n` +
    `账号：${status?.nickname || '—'}\n` +
    `结果：${result.message}\n` +
    `${statusLine}\n` +
    `\n——由 trae-checkin 自动发送`;
  try {
    await smtpSend({
      host: cfg.host, port: cfg.port, user: cfg.user, pass: cfg.pass,
      from: cfg.from, to: cfg.to,
      subject: `[Trae 签到] ${result.code === 0 ? '成功' : '失败'} - ${date.slice(0, 10)}`,
      body,
    });
    return true;
  } catch (e) {
    log('邮件发送失败: ' + e.message);
    return false;
  }
}

// ---------- HTTP ----------
// 关闭 undici 全局连接池后再退出，避免 UV_HANDLE_CLOSING 断言
let shutdownPending = false;
function shutdown(code) {
  if (shutdownPending) return;
  shutdownPending = true;
  process.exitCode = code;
  const dispatcher = globalThis[Symbol.for('undici.globalDispatcher.1')];
  if (dispatcher?.close) dispatcher.close().catch(() => {});
  // 兜底：若事件循环因句柄未释放而挂住，5 秒后强制退出
  setTimeout(() => process.exit(code), 5000).unref();
}

async function postJson(url, headers, bodyObj) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connection': 'close', ...headers },
      body: JSON.stringify(bodyObj ?? {}),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep raw */ }
    return { ok: res.ok, status: res.status, text, json };
  } catch (err) {
    return { ok: false, status: 0, text: String(err), json: null };
  } finally { clearTimeout(t); }
}

// 插件里 checkin 用的那一组请求头
function checkinHeaders(cred, uid) {
  const deviceId = deriveDeviceId15(uid);
  return {
    Accept: '*/*',
    'Accept-Encoding': 'gzip, deflate',
    'Accept-Language': 'zh-CN',
    'User-Agent': 'VSCode 1.107.1 (TRAE SOLO CN)',
    Authorization: `Cloud-IDE-JWT ${cred.access_token}`,
    'X-Market-Client-Id': 'VSCode 1.107.1',
    'X-Market-User-Id': deriveMarketUserId(uid),
    'X-User-Region': 'CN',
    'X-Device-Id': deviceId,
    'X-Lgw-Req-Sdk-Type': '3',
    'Package-Type': 'stable_cn',
    'X-Lscbd-Aid': '787976',
    'X-Lscbd-Platform': 'windows',
    'App-Version': IDE_VERSION,
    'X-Tt-Trace-Id': `00-${randomHex(16)}-01`,
    'Vscode-Sessionid': deriveSessionId(uid),
    'X-Request-Id': randomUUID(),
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': 'none',
  };
}

function oauthHeaders() {
  return {
    Accept: 'application/json',
    'User-Agent': `Trae/${IDE_VERSION}`,
  };
}

// ---------- 业务接口 ----------
async function fetchStatus(cred, uid) {
  const r = await postJson(`${UG_HOST}${CHECKIN_STATUS_PATH}`, checkinHeaders(cred, uid), {});
  if (!r.ok || !r.json) return null;
  const j = r.json;
  const code = Number(j.code ?? j.Code ?? -1);
  if (code !== 0) return { code, message: j.message || j.msg || '' };
  const data = (j.data && typeof j.data === 'object') ? j.data : j;
  const checkedRaw = data.checked_in ?? data.checkedIn ?? data.checked;
  return {
    code: 0,
    enable: data.enable === true,
    checkedIn: checkedRaw === true,
    credits: Number(data.credits) || 0,
    totalCredits: Number(data.total_credits) || 0,
    streakDays: Number(data.streak_days) || 0,
  };
}

// 供调试使用
if (process.env.TRAECHECKIN_DEBUG === '1') {
  globalThis.__fetchStatus = fetchStatus;
}

async function claimOnce(cred, uid) {
  const r = await postJson(`${UG_HOST}${CHECKIN_CLAIM_PATH}`, checkinHeaders(cred, uid), {});
  if (!r.ok) return { ok: false, httpStatus: r.status, message: `HTTP ${r.status}: ${r.text.slice(0, 80)}` };
  if (!r.json) return { ok: false, httpStatus: r.status, message: `非 JSON 响应: ${r.text.slice(0, 80)}` };
  return { ok: true, body: r.json, httpStatus: r.status };
}

function readCode(body) {
  return Number(body?.code ?? body?.Code ?? -1);
}

// ---------- Token 刷新 ----------
async function refreshCred(cred) {
  if (!cred.refresh_token) return null;
  const r = await postJson(`${OAUTH_HOST}${EXCHANGE_PATH}`, oauthHeaders(), {
    ClientID: CLIENT_ID,
    RefreshToken: cred.refresh_token,
    ClientSecret: '-',
    UserID: '',
  });
  if (!r.ok || !r.json) return null;
  const res = r.json.Result ?? r.json.result;
  if (!res) return null;
  const accessToken = res.Token ?? res.token ?? res.accessToken;
  if (!accessToken) return null;
  const next = { ...cred, access_token: accessToken };
  if (res.RefreshToken) next.refresh_token = res.RefreshToken;
  if (res.TokenExpireAt) next.expires_at = String(res.TokenExpireAt > 1e12 ? res.TokenExpireAt : res.TokenExpireAt * 1000);
  else if (res.TokenExpireDuration) next.expires_at = String(Date.now() + res.TokenExpireDuration * 1000);
  saveCred(next);
  return next;
}

// ---------- 登录 ----------
function buildLoginUrl(machineId, deviceId, callbackUrl) {
  const p = new URLSearchParams({
    login_version: '1', auth_from: 'solo', login_channel: 'native_ide',
    plugin_version: PLUGIN_VERSION, auth_type: 'local', client_id: CLIENT_ID,
    redirect: '0', login_trace_id: machineTraceId(machineId, deviceId),
    auth_callback_url: callbackUrl, machine_id: machineId, device_id: deviceId,
    x_device_id: deviceId, x_machine_id: machineId,
    x_device_brand: 'PC', x_device_type: 'PC', x_os_version: '1.0',
    x_app_version: IDE_VERSION, x_app_type: 'stable',
  });
  return `${CONSOLE_HOST}/authorization?${p.toString()}`;
}

function parseCallback(url) {
  const q = new URL(url.startsWith('http') ? url : `http://127.0.0.1${url}`).searchParams;
  const parseJson = raw => { try { return JSON.parse(raw); } catch { return null; } };
  const userInfo = parseJson(q.get('userInfo'));
  const userJwt = parseJson(q.get('userJwt'));
  const refreshToken = q.get('refreshToken') || userJwt?.RefreshToken || '';
  const uid = userInfo?.UserID || '';
  const nickname = userInfo?.ScreenName || '';
  const enterpriseId = userInfo?.TenantID || '';
  const jwtToken = userJwt?.Token || '';
  if (!refreshToken && !jwtToken) return null;
  return { refreshToken, uid, nickname, enterpriseId, accessToken: refreshToken ? '' : jwtToken };
}

async function cmdLogin() {
  const machineId = randomHex(32);
  const deviceId = randomHex(32);
  let resolveCb; const cbPromise = new Promise(r => { resolveCb = r; });

  const server = createServer((req, res) => {
    if (!req.url?.startsWith('/authorize')) { res.writeHead(404); res.end(); return; }
    const info = parseCallback(req.url);
    if (!info) { res.writeHead(400); res.end('missing token'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h3>授权成功，可以关闭此页面了。</h3>');
    resolveCb(info);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const callbackUrl = `http://127.0.0.1:${port}/authorize`;
  const url = buildLoginUrl(machineId, deviceId, callbackUrl);
  log(`已打开浏览器授权页，若未自动打开请手动访问：${url}`);
  execSync(`start "" "${url}"`, { shell: 'cmd.exe' });

  const timeout = setTimeout(() => { server.close(); console.error('登录超时'); shutdown(2); }, LOGIN_TIMEOUT_MS);
  const info = await cbPromise;
  clearTimeout(timeout); server.close();

  // 用 refreshToken 换正式 accessToken
  const r = await postJson(`${OAUTH_HOST}${EXCHANGE_PATH}`, oauthHeaders(), {
    ClientID: CLIENT_ID, RefreshToken: info.refreshToken, ClientSecret: '-', UserID: '',
  });
  if (!r.ok || !r.json) { log('ExchangeToken 失败: ' + r.text.slice(0, 120)); shutdown(3); return; }
  const res = r.json.Result ?? r.json.result;
  if (!res?.Token) { log('ExchangeToken 响应缺少 Token'); shutdown(3); return; }

  const cred = {
    uid: info.uid,
    nickname: info.nickname,
    enterprise_id: info.enterpriseId,
    access_token: res.Token,
    refresh_token: res.RefreshToken || info.refreshToken,
    expires_at: res.TokenExpireAt ? String(res.TokenExpireAt > 1e12 ? res.TokenExpireAt : res.TokenExpireAt * 1000) : '',
    machine_id: machineId,
    device_id: deviceId,
    created_at: new Date().toISOString(),
  };
  saveCred(cred);
  log(`登录成功，账号：${cred.nickname || cred.uid}，凭据已保存到 ${CRED_PATH}`);
}

// ---------- 每日运行 ----------
async function cmdRun() {
  let cred = loadCred();
  if (!cred) return { code: 3, message: '未登录，请先运行: node trae-checkin.mjs login', status: null };
  if (isExpired(cred)) {
    log('token 临近过期，正在刷新...');
    const next = await refreshCred(cred);
    if (!next) return { code: 3, message: '刷新失败，请重新运行 login', status: null };
    cred = next;
  }
  const uid = cred.uid;
  if (!uid) return { code: 3, message: '凭据缺少 uid，请重新 login', status: null };

  const status = await fetchStatus(cred, uid);
  const baseStatus = status;
  if (status === null) return { code: 4, message: '查询签到状态失败（网络/格式异常）', status: null };
  if (status.code !== 0) {
    if (status.code === 1001 || status.code === 401) return { code: 3, message: '登录态失效，请重新 login', status: null };
    return { code: 4, message: `查询状态返回 code=${status.code} ${status.message}`, status: null };
  }
  if (!status.enable) return { code: 0, message: '今日签到活动未开启', status };
  if (status.checkedIn) return { code: 0, message: '今日已签到，无需重复领取', status };

  // 领取
  let lastMsg = '';
  for (let i = 0; i < 4; i++) {
    const r = await claimOnce(cred, uid);
    if (!r.ok) { lastMsg = r.message; await new Promise(r => setTimeout(r, 1000)); continue; }
    const code = readCode(r.body);
    if (code === 9074) return { code: 5, message: '领取被拒 9074（当前参与用户太多/设备限制），今天不再重试', status };
    if (code === 9095) return { code: 0, message: '本设备今日已签到', status };
    if (code === 0) {
      const after = await fetchStatus(cred, uid);
      if (after?.checkedIn) return { code: 0, message: `签到成功，本次获得 ${status.credits || '?'} 积分`, status: after };
      return { code: 5, message: 'claim 返回 code=0 但回读仍未签到，记为 ineligible', status };
    }
    return { code: 5, message: `领取失败 code=${code} ${r.body.message || r.body.msg || ''}`, status };
  }
  return { code: 4, message: `领取请求失败：${lastMsg}`, status: baseStatus };
}

async function cmdStatus() {
  const cred = loadCred();
  if (!cred) { console.log('未登录'); return; }
  console.log(`账号: ${cred.nickname || cred.uid}`);
  console.log(`uid: ${cred.uid}`);
  console.log(`token 过期时间: ${cred.expires_at ? new Date(Number(cred.expires_at)).toLocaleString() : '未知'}`);
  const s = await fetchStatus(cred, cred.uid);
  if (s && s.code === 0) {
    console.log(`今日签到: ${s.checkedIn ? '已签' : '未签'}`);
    console.log(`连续签到: ${s.streakDays} 天`);
    console.log(`总积分: ${s.totalCredits}`);
  } else {
    console.log('状态查询失败: ' + JSON.stringify(s));
  }
}

function cmdLogout() {
  if (existsSync(CRED_PATH)) unlinkSync(CRED_PATH);
  console.log('已删除本地凭据');
}

// ---------- 计划任务 ----------
const TASK_NAME = 'TraeCheckin';
function psPath() { return join(STORE_DIR, 'TraeCheckin.ps1'); }

function writePs1() {
  const node = execSync('where.exe node').toString().split('\n')[0].trim();
  const script = `
$Node = '${node.replace(/'/g, "''")}'
$Script = '${join(STORE_DIR, 'trae-checkin.mjs').replace(/'/g, "''")}'
& $Node $Script run >> "${join(LOG_DIR, 'task.log').replace(/\\/g, '\\')}" 2>&1
`;
  writeFileSync(psPath(), script, 'utf8');
  // 同时把 mjs 复制到 STORE_DIR，避免源目录被移动
  const src = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const dst = join(STORE_DIR, 'trae-checkin.mjs');
  if (src !== dst) writeFileSync(dst, readFileSync(src));
  return { node, ps1: psPath() };
}

function cmdInstall() {
  const { ps1 } = writePs1();
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Trae CN daily check-in</Description></RegistrationInfo>
  <Triggers><CalendarTrigger><StartBoundary>2026-01-01T07:00:00</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${userInfo().username}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable><IdleSettings><StopOnIdleEnd>true</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><RunOnlyIfIdle>false</RunOnlyIfIdle><WakeToRun>false</WakeToRun><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><Priority>7</Priority></Settings>
  <Actions Context="Author"><Exec><Command>powershell.exe</Command><Arguments>-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${ps1}"</Arguments></Exec></Actions>
</Task>`;
  const xmlPath = join(STORE_DIR, 'task.xml');
  writeFileSync(xmlPath, xml, 'utf16le');
  // schtasks /xml 需要 UTF-16 LE 带 BOM
  const buf = readFileSync(xmlPath);
  writeFileSync(xmlPath, Buffer.concat([Buffer.from([0xff, 0xfe]), buf]));
  try { execSync(`schtasks /delete /tn "${TASK_NAME}" /f 2>nul`, { stdio: 'ignore' }); } catch {}
  execSync(`schtasks /create /tn "${TASK_NAME}" /xml "${xmlPath}" /f`);
  console.log(`计划任务已创建：每天 07:00 运行，错过时开机补跑。`);
  console.log(`手动测试一次：schtasks /run /tn "${TASK_NAME}"`);
}

function cmdUninstall() {
  try { execSync(`schtasks /delete /tn "${TASK_NAME}" /f`); console.log('计划任务已删除'); }
  catch { console.log('任务不存在或删除失败'); }
}

// ---------- 自测 ----------
async function selfTest() {
  console.log('开始离线自测（不访问真实接口）...');
  const uid = 'test-uid-123';
  const device = deriveDeviceId15(uid);
  if (!/^\d{15}$/.test(device)) throw new Error('设备号不是 15 位');
  const market = deriveMarketUserId(uid);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(market)) throw new Error('market id 格式错误');

  const scenarios = [
    { name: '未签到->领取->回读成功', status: [{ enable: true, checked_in: false, credits: 100 }], claim: [{ code: 0, message: 'success' }], statusAfter: { enable: true, checked_in: true, credits: 100 }, expect: 0 },
    { name: '已签到', status: [{ enable: true, checked_in: true, credits: 100 }], claim: [], expect: 0 },
    { name: '9074 拒绝', status: [{ enable: true, checked_in: false, credits: 100 }], claim: [{ code: 9074, message: '当前参与用户太多' }], expect: 5 },
    { name: 'HTTP 500', status: null, claim: [], expect: 4 },
  ];

  for (const s of scenarios) {
    let statusCalls = 0, claimCalls = 0;
    const server = createServer((req, res) => {
      if (req.url === CHECKIN_STATUS_PATH) {
        const body = statusCalls === 0 ? s.status?.[0] : s.statusAfter;
        statusCalls++;
        const wrapped = body && body.code === undefined ? { code: 0, ...body } : body;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(wrapped ?? { code: 500 }));
      } else if (req.url === CHECKIN_CLAIM_PATH) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(s.claim[0] ?? { code: 500 }));
      } else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    const oldFetch = globalThis.fetch;
    globalThis.fetch = (url, opts) => oldFetch(String(url).replace(UG_HOST, `http://127.0.0.1:${port}`), opts);
    // monkey patch log to keep test output clean
    globalThis.__testSilent = true;

    let code;
    let debugInfo = '';
    try {
      code = await runOnce({ access_token: 'fake', uid });
    } catch (e) {
      debugInfo = String(e);
      code = -1;
    } finally {
      globalThis.fetch = oldFetch;
      server.close();
    }
    if (code !== s.expect) throw new Error(`${s.name} 期望退出码 ${s.expect} 得到 ${code} ${debugInfo}`);
    console.log(`  PASS ${s.name}`);
  }
  console.log('自测全部通过');
}

async function runOnce(cred) {
  const uid = cred.uid;
  const status = await fetchStatus(cred, uid);
  if (status === null) return 4;
  if (status.code !== 0) return 4;
  if (!status.enable) return 0;
  if (status.checkedIn) return 0;
  for (let i = 0; i < 4; i++) {
    const r = await claimOnce(cred, uid);
    if (!r.ok) { await new Promise(r => setTimeout(r, 1000)); continue; }
    const code = readCode(r.body);
    if (code === 9074) return 5;
    if (code === 9095) return 0;
    if (code === 0) {
      const after = await fetchStatus(cred, uid);
      return after?.checkedIn ? 0 : 5;
    }
    return 5;
  }
  return 4;
}

// ---------- 入口 ----------
const arg = process.argv[2];
(async () => {
  switch (arg) {
    case 'login': await cmdLogin(); break;
    case 'run': {
      const result = await cmdRun();
      log(result.message);
      if (loadEmailConfig()) {
        const ok = await sendResultEmail(result, result.status);
        if (ok) log('结果邮件已发送');
      }
      shutdown(result.code);
      break;
    }
    case 'notify': {
      // 立即查询状态并发送测试邮件，不执行签到
      const cred = loadCred();
      let status = null;
      if (cred?.uid) status = await fetchStatus(cred, cred.uid);
      const message = status?.checkedIn ? '今日已签到' : (status ? '今日未签到' : '状态查询失败');
      const result = { code: status ? 0 : 4, message, status };
      const ok = await sendResultEmail(result, status);
      console.log(ok ? '测试邮件已发送，请查收' : '邮件发送失败，见日志');
      shutdown(ok ? 0 : 1);
      break;
    }
    case 'status': await cmdStatus(); break;
    case 'logout': cmdLogout(); break;
    case 'install': cmdInstall(); break;
    case 'uninstall': cmdUninstall(); break;
    case '--self-test': await selfTest(); break;
    default:
      console.log('用法: node trae-checkin.mjs [login|run|status|notify|logout|install|uninstall|--self-test]');
      shutdown(1);
  }
})().catch(e => { console.error(e); shutdown(1); });
