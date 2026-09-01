#!/usr/bin/env node
/**
 * mc_query.js - 锐明 OA MC 物料系统统一查询 CLI
 *
 * 鉴权策略（免常驻浏览器）：
 *   1. 优先使用本地缓存的 Cookie（~/.cache/oa-mc-cookies.json）直连 OA 接口，无需 Chrome；
 *   2. 无缓存或会话失效时，自动以独立数据目录启动 Chrome 并等待用户扫码登录，
 *      登录成功后通过 CDP 导出全部 Cookie（含 httpOnly）写入缓存，随后自动关闭浏览器；
 *   3. 之后的所有查询均为纯 HTTP 直连，毫秒级响应。
 *
 * 用法：
 *   node mc_query.js search <关键词>          按物料描述搜索，支持 && 多条件，如 "X3N&&0404&&不带logo"
 *   node mc_query.js item <料号>              按单个料号精确查询（无结果时自动回退 ITEM_DESC 模糊匹配）
 *   node mc_query.js batch <料号1> <料号2>... 批量料号查询（ITEM_NUMBER 精确 + ITEM_DESC 回退）
 *   node mc_query.js bom <父项料号>           查询 BOM：父项物料信息 + 子项明细
 *   node mc_query.js spec <料号>              查询规格文件列表（文件名 + 下载链接）
 *
 * 可选参数：
 *   --out <目录>    输出目录，默认当前工作目录
 *   --org <ID>      组织 ID，默认 102
 *   --download      spec 子命令专用：同时把规格文件下载到输出目录 spec_files/
 *   --json          结果以 JSON 输出到 stdout（===JSON_BEGIN===/===JSON_END=== 标记之间），不生成 HTML 报告
 *
 * 输出：
 *   默认生成 HTML 报告（--out 目录下）：
 *     search/item  → material_query_result.html
 *     batch        → material_batch_result.html
 *     bom          → bom_result.html
 *     spec         → spec_file_result.html
 *   加 --json 时改为 stdout 输出 JSON，不写任何报告文件
 */

'use strict';
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const CDP_PORT = 9222;
const OA_BASE = 'http://oa.streamax.com:8080';
const API_PATH = '/ruiming/mc/materiel_ui/materielSearch.do';
const CHROME_EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE_DIR = path.join(os.homedir(), '.cache', 'chrome-oa-mc');
const COOKIE_JAR = path.join(os.homedir(), '.cache', 'oa-mc-cookies.json');
const IMX307_DATA_PATH = path.join(__dirname, '..', 'data', 'imx307_replacement.json');

// ── IMX307 替代料号（本地静态数据）────────────────────────────
// 描述含 IMX307 的物料行自动附加替代料号信息（F355 等方案），
// 供 agent 提示用户并告知客户。生命周期/库存仍以服务器查询为准。
let _imx307Cache = null;
function loadImx307() {
  if (_imx307Cache) return _imx307Cache;
  try {
    const raw = JSON.parse(fs.readFileSync(IMX307_DATA_PATH, 'utf8'));
    _imx307Cache = Array.isArray(raw.mapping) ? raw.mapping : [];
  } catch (e) {
    _imx307Cache = [];
  }
  return _imx307Cache;
}

function normStr(v) {
  return String(v == null ? '' : v).replace(/[\t ]/g, '');
}

// 对物料行数组附加 imx307_replacement 字段
function attachImx307(rows) {
  const imx = loadImx307();
  if (!imx.length) return rows;
  return rows.map(r => {
    const desc = String(r.ITEM_DESC || '');
    if (!/IMX307/i.test(desc)) return r;
    const code = normStr(r.ITEM_NUMBER);
    const repls = imx.filter(m => normStr(m.original) === code);
    if (repls.length) r.imx307_replacement = repls;
    return r;
  });
}

// ── 参数解析 ─────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  let outDir = process.cwd();
  let orgId = '102';
  let download = false;
  let json = false;
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') { outDir = path.resolve(args[++i] || process.cwd()); }
    else if (args[i] === '--org') { orgId = args[++i] || '102'; }
    else if (args[i] === '--download') { download = true; }
    else if (args[i] === '--json') { json = true; }
    else rest.push(args[i]);
  }
  const cmd = rest[0];
  const params = rest.slice(1);
  if (!cmd) { printUsage(); process.exit(1); }
  if (!['search', 'item', 'batch', 'bom', 'spec'].includes(cmd)) {
    console.error(`[ERROR] 未知子命令: ${cmd}`);
    printUsage();
    process.exit(1);
  }
  if (params.length === 0) {
    console.error(`[ERROR] 子命令 ${cmd} 需要参数`);
    printUsage();
    process.exit(1);
  }
  return { cmd, params, outDir, orgId, download, json };
}

function printUsage() {
  console.log(`用法:
  node mc_query.js search <关键词>          物料描述搜索（支持 && 多条件）
  node mc_query.js item <料号>              单料号查询（精确 + 模糊回退）
  node mc_query.js batch <料号1> <料号2>... 批量料号查询（精确 + 模糊回退）
  node mc_query.js bom <父项料号>           BOM 查询（父项信息 + 子项明细）
  node mc_query.js spec <料号>              规格文件查询（文件列表 + 下载链接）

可选参数:
  --out <目录>   输出目录，默认当前工作目录
  --org <ID>     组织 ID，默认 102
  --download     spec 专用：同时下载规格文件到 输出目录/spec_files/
  --json         结果以 JSON 输出到 stdout，不生成 HTML 报告`);
}

// JSON 输出：用标记包裹，便于调用方从 stdout 中可靠提取
function printJson(obj) {
  console.log('===JSON_BEGIN===');
  console.log(JSON.stringify(obj));
  console.log('===JSON_END===');
}

// ── Cookie 缓存 ──────────────────────────────────────────────
function loadCookieJar() {
  try { return JSON.parse(fs.readFileSync(COOKIE_JAR, 'utf8')); } catch (e) { return []; }
}

function saveCookieJar(cookies) {
  fs.mkdirSync(path.dirname(COOKIE_JAR), { recursive: true });
  fs.writeFileSync(COOKIE_JAR, JSON.stringify(cookies));
  console.log(`[OK] 已缓存 ${cookies.length} 条 Cookie -> ${COOKIE_JAR}`);
}

function cookieHeaderOf(jar) {
  return jar.map(c => `${c.name}=${c.value}`).join('; ');
}

// ── 直连 HTTP（免浏览器查询）─────────────────────────────────
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

function rawRequest(urlStr, headers, binary = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: binary ? buf : buf.toString('utf8') });
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('请求超时(60s)')));
    req.on('error', reject);
    req.end();
  });
}

// 直连 GET：自动跟随同域重定向；重定向到 IAM 登录页视为会话失效
async function directGet(urlStr, jar, binary = false) {
  let url = urlStr;
  for (let i = 0; i < 6; i++) {
    const res = await rawRequest(url, {
      'User-Agent': UA,
      'Accept': binary ? '*/*' : 'application/json, text/plain, */*',
      'Referer': OA_BASE + '/',
      'Cookie': cookieHeaderOf(jar)
    }, binary);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      const next = new URL(res.headers.location, url).toString();
      if (/iam\.streamax\.com/i.test(next)) {
        const e = new Error('会话失效(重定向到 IAM 登录页)');
        e.sessionInvalid = true;
        throw e;
      }
      url = next;
      continue;
    }
    return res;
  }
  const e = new Error('重定向次数过多');
  e.sessionInvalid = true;
  throw e;
}

async function directApi(method, queryParams, jar) {
  const apiUrl = `${OA_BASE}${API_PATH}?method=${method}&${queryParams}&__seq=${Date.now()}`;
  const res = await directGet(apiUrl, jar);
  if (res.status !== 200 || /<html|<!DOCTYPE/i.test(res.body)) {
    const e = new Error(`响应异常 (status ${res.status})，session 可能已失效`);
    e.sessionInvalid = true;
    throw e;
  }
  try { return JSON.parse(res.body); }
  catch (e) { throw new Error('JSON 解析失败: ' + String(res.body).substring(0, 200)); }
}

// 统一 API 入口：先直连，失败则浏览器登录并重新缓存 Cookie 后再试一次
async function callApi(method, queryParams) {
  const jar = loadCookieJar();
  if (jar.length > 0) {
    try {
      return await directApi(method, queryParams, jar);
    } catch (e) {
      if (!e.sessionInvalid) throw e;
      console.log('[WARN] 缓存会话已失效，需要重新扫码登录...');
    }
  } else {
    console.log('[INFO] 无缓存会话，需要登录...');
  }
  // MC Tool 集成模式：OA 登录由 Electron App 扫码完成，脚本不得拉起 Chrome。
  if (process.env.MC_TOOL_AUTH_MODE === 'app') {
    console.log('===JSON_BEGIN===');
    console.log(JSON.stringify({ error: 'NEED_OA_LOGIN', message: 'OA 会话失效，请在 MC Tool 中重新扫码登录' }));
    console.log('===JSON_END===');
    process.exit(2);
  }
  return await directApi(method, queryParams, loadCookieJar());
}

// 直连下载二进制文件（规格文件等）
async function downloadFile(url, jar) {
  const res = await directGet(url, jar, true);
  if (res.status !== 200) throw new Error('HTTP ' + res.status);
  return res.body;
}

// ── CDP 辅助（仅在登录/导出 Cookie 时使用）───────────────────
function getVersion() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json/version`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function getTargets() {
  return new Promise((resolve, reject) => {
    http.get(`http://localhost:${CDP_PORT}/json/list`, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function cdpSend(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1000000);
    const timeout = setTimeout(() => reject(new Error(`CDP timeout: ${method}`)), 30000);
    ws.addEventListener('message', function handler(event) {
      try {
        const resp = JSON.parse(event.data);
        if (resp.id === id) {
          clearTimeout(timeout);
          ws.removeEventListener('message', handler);
          resp.error ? reject(new Error(JSON.stringify(resp.error))) : resolve(resp.result);
        }
      } catch (e) {}
    });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

function wsConnect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });
}

async function getCurrentUrl(ws) {
  const result = await cdpSend(ws, 'Runtime.evaluate', {
    expression: 'window.location.href',
    returnByValue: true
  });
  return result.result.value;
}

async function cdpAlive() {
  try { await getVersion(); return true; } catch (e) { return false; }
}

async function waitForCdp(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive()) return true;
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function launchChrome() {
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    '--no-proxy-server',
    `--user-data-dir=${PROFILE_DIR}`,
    OA_BASE + '/'
  ];
  const child = spawn(CHROME_EXE, args, { detached: true, stdio: 'ignore' });
  child.unref();
}

// 在浏览器页面里等待用户完成扫码登录（最长 180 秒）
async function waitLoginViaPage() {
  const targets = await getTargets();
  const pageTarget = targets.find(t => t.type === 'page');
  if (!pageTarget) { console.error('[FATAL] Chrome 中没有可用的页面标签页'); return false; }
  const ws = await wsConnect(pageTarget.webSocketDebuggerUrl);
  await cdpSend(ws, 'Page.enable');
  await cdpSend(ws, 'Runtime.enable');
  try {
    let url = await getCurrentUrl(ws);
    if (!url.includes('oa.streamax.com')) {
      console.log('[INFO] 正在打开 OA ...');
      await cdpSend(ws, 'Page.navigate', { url: OA_BASE + '/' });
    }
    let prompted = false;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000));
      url = await getCurrentUrl(ws);
      if (url.includes('oa.streamax.com')) {
        console.log('[INFO] 登录成功！');
        await new Promise(r => setTimeout(r, 1500)); // 等会话 Cookie 写入稳定
        return true;
      }
      if (!prompted && url.includes('iam.streamax.com')) {
        console.log('[WARN] 请在弹出的 Chrome 窗口中完成 OA 扫码登录（最长等待 180 秒）...');
        prompted = true;
      }
    }
    console.error('[ERROR] 登录等待超时（180 秒）');
    return false;
  } finally {
    ws.close();
  }
}

// 通过 CDP 导出全部 streamax.com 域的 Cookie（含 httpOnly）
async function captureCookies() {
  const ver = await getVersion();
  const ws = await wsConnect(ver.webSocketDebuggerUrl);
  try {
    const result = await cdpSend(ws, 'Storage.getCookies', {});
    return (result.cookies || []).filter(c => /streamax\.com$/i.test(c.domain));
  } finally {
    ws.close();
  }
}

async function closeBrowser() {
  try {
    const ver = await getVersion();
    const ws = await wsConnect(ver.webSocketDebuggerUrl);
    await cdpSend(ws, 'Browser.close', {});
    ws.close();
  } catch (e) { /* 忽略关闭失败 */ }
}

// 登录流程：拉起浏览器 → 等待扫码 → 导出 Cookie → 关闭浏览器（若为本脚本启动）
async function loginAndCaptureCookies() {
  const wasRunning = await cdpAlive();
  if (!wasRunning) {
    console.log('[INFO] 启动 Chrome 进行登录...');
    launchChrome();
    if (!(await waitForCdp())) {
      console.error('[FATAL] Chrome CDP 启动失败，请检查 Chrome 是否可用');
      process.exit(1);
    }
  }
  if (!(await waitLoginViaPage())) process.exit(1);

  const cookies = await captureCookies();
  if (cookies.length === 0) {
    console.error('[FATAL] 未捕获到任何 streamax.com Cookie');
    process.exit(1);
  }
  saveCookieJar(cookies);

  if (!wasRunning) {
    console.log('[INFO] 正在关闭登录用的 Chrome 窗口...');
    await closeBrowser();
  }
}

function rowsFromData(data) {
  if (!data || !Array.isArray(data.datas)) return [];
  return data.datas.map(row => {
    const obj = {};
    row.forEach(cell => { obj[cell.col] = cell.value; });
    return obj;
  });
}

function saveHtml(outDir, name, html) {
  const p = path.join(outDir, name);
  fs.writeFileSync(p, html);
  console.log('[INFO] HTML saved:', p);
  return p;
}

// ── 查询逻辑 ─────────────────────────────────────────────────

// 物料描述搜索 / 单料号（带回退）
async function queryMaterial(orgId, paramName, paramValue) {
  const data = await callApi('wuliao', `q.ORGANIZATION_ID=${orgId}&${paramName}=${encodeURIComponent(paramValue)}`);
  return { data, rows: rowsFromData(data) };
}

async function queryOneItem(orgId, itemNumber) {
  const clean = normStr(itemNumber);
  if (!clean) return { itemNumber, rows: [], error: '未找到' };
  let result = await queryMaterial(orgId, 'q.ITEM_NUMBER', clean);
  if (result.rows.length > 0) return { itemNumber, rows: result.rows, method: 'ITEM_NUMBER' };

  console.log(`  [INFO] ITEM_NUMBER 无结果，回退 ITEM_DESC 模糊匹配...`);
  result = await queryMaterial(orgId, 'q.ITEM_DESC', clean);
  if (result.rows.length > 0) return { itemNumber, rows: result.rows, method: 'ITEM_DESC' };
  return { itemNumber, rows: [], error: '未找到' };
}

// BOM 查询：父项信息 + 子项明细
async function queryBom(orgId, itemNumber) {
  const parentData = await callApi('wuliao', `q.ORGANIZATION_ID=${orgId}&q.ITEM_NUMBER=${encodeURIComponent(itemNumber)}`);
  const bomData = await callApi('bom', `q.ORGANIZATION_ID=${orgId}&q.ASSEMBLY_ITEM_NUMBER=${encodeURIComponent(itemNumber)}`);
  return { parentData, parentRows: rowsFromData(parentData), bomData, bomRows: rowsFromData(bomData) };
}

// 规格文件查询（官方接口：method=specificationFile&q.itemNumber=<料号>，驼峰参数，无需组织ID）
// fileName 字段为 HTML 锚点，内含 specificationFileDownload 下载链接，需解析提取
async function querySpec(itemNumber) {
  const data = await callApi('specificationFile', `q.itemNumber=${encodeURIComponent(itemNumber)}`);
  const rows = rowsFromData(data);
  const files = rows.map(r => {
    const raw = String(r.fileName || '');
    const hrefMatch = raw.match(/href="([^"]+)"/);
    const nameMatch = (hrefMatch && hrefMatch[1].match(/[?&]fileName=([^"&]+)/)) || raw.match(/>([^<>]+)</);
    let href = hrefMatch ? hrefMatch[1] : '';
    let fileName = '';
    if (nameMatch) {
      try { fileName = decodeURIComponent(nameMatch[1].trim()); } catch (e) { fileName = nameMatch[1].trim(); }
    }
    const url = href ? (href.startsWith('http') ? href : OA_BASE + href) : '';
    const ext = (fileName.match(/\.([a-zA-Z0-9]+)$/) || [])[1] || '';
    return { itemNumber: r.itemNumber, itemDes: r.itemDes, fileName, url, ext: ext.toLowerCase() };
  });
  return { data, files };
}

// ── HTML 公共样式 ────────────────────────────────────────────
function baseCss() {
  return `
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Microsoft YaHei', sans-serif; background: #f5f7fa; color: #333; padding: 20px; }
h1 { color: #1745A5; margin-bottom: 5px; font-size: 24px; }
h2 { color: #1745A5; font-size: 18px; margin: 25px 0 12px; }
.meta { color: #666; margin-bottom: 20px; font-size: 14px; }
.summary { background: #fff; border-radius: 8px; padding: 15px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); display: flex; gap: 30px; flex-wrap: wrap; }
.summary-item { text-align: center; min-width: 80px; }
.summary-item .num { font-size: 28px; font-weight: bold; color: #25A1FD; }
.summary-item .label { font-size: 13px; color: #888; margin-top: 2px; }
.summary-item .num.warn { color: #e65100; }
.summary-item .num.ok { color: #2e7d32; }
.summary-item .num.info { color: #7c4dff; }
.card { background: #fff; border-radius: 8px; padding: 15px 20px; margin-bottom: 10px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 8px 20px; }
.kv .item { font-size: 13px; padding: 4px 0; border-bottom: 1px dashed #eee; }
.kv .item .k { color: #888; display: inline-block; min-width: 72px; }
.kv .item .v { font-weight: 600; color: #333; }
.table-wrap { background: #fff; border-radius: 8px; overflow: auto; box-shadow: 0 1px 3px rgba(0,0,0,0.08); max-height: 700px; }
table { width: 100%; border-collapse: collapse; }
th { background: #1745A5; color: #fff; padding: 10px 8px; text-align: left; font-size: 13px; white-space: nowrap; position: sticky; top: 0; z-index: 1; }
td { padding: 8px; border-bottom: 1px solid #eee; font-size: 12px; vertical-align: top; }
tr:hover { background: #f0f7ff; }
.item-no { font-weight: bold; color: #1745A5; white-space: nowrap; }
.status-badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; white-space: nowrap; }
.status-active { background: #e8f5e9; color: #2e7d32; }
.status-pending { background: #fff3e0; color: #e65100; }
.status-retired { background: #ffebee; color: #c62828; }
.status-dev { background: #e3f2fd; color: #1565c0; }
.status-disabled { background: #f5f5f5; color: #999; }
.qty-positive { font-weight: bold; color: #e65100; }
.qty-zero { color: #ccc; }
.error-row td { color: #c62828; font-style: italic; }
.search-terms code { background: #eef2ff; color: #1745A5; padding: 2px 8px; border-radius: 4px; margin: 2px; display: inline-block; font-size: 12px; }
.search-terms { background: #fff; border-radius: 8px; padding: 15px 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); }
.fallback-tag { display: inline-block; padding: 1px 6px; border-radius: 8px; font-size: 10px; background: #f3e5f5; color: #7c4dff; margin-left: 4px; }
.imx307-tip { margin-top: 4px; padding: 4px 8px; border-radius: 6px; font-size: 11px; background: #fff8e1; color: #e65100; border: 1px solid #ffe0b2; }
.imx307-tip .repl { color: #1745A5; font-weight: 600; }
.empty { color: #999; padding: 20px; text-align: center; }`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function statusClass(statusName) {
  if (statusName === '量产' || statusName === '批量-推荐') return 'status-active';
  if (statusName === '预退市' || statusName === '逐步淘汰') return 'status-pending';
  if (statusName === '退市' || statusName === '禁用' || statusName === '禁购') return 'status-retired';
  if (statusName === '研发样品' || statusName === '未承样' || statusName === '试产样品') return 'status-dev';
  return 'status-disabled';
}

// ── HTML 报告生成 ────────────────────────────────────────────

function materialRowsTable(rows, opts = {}) {
  return `<div class="table-wrap">
<table>
<thead>
<tr>
  <th>序号</th><th>料号</th><th>物料描述</th><th>类型</th><th>生命周期</th>
  <th>库存量</th><th>研发仓</th><th>跟踪品仓</th><th>产成品</th><th>整改仓</th>
</tr>
</thead>
<tbody>
${rows.map((r, i) => {
    const isError = r._error;
    const qty = parseInt(r.ON_HAND_QTY) || 0;
    return `<tr class="${isError ? 'error-row' : ''}">
    <td>${i + 1}</td>
    <td class="item-no">${esc(r.ITEM_NUMBER)}</td>
    <td>${esc(r.ITEM_DESC)}${r._fallback ? '<span class="fallback-tag">模糊匹配</span>' : ''}${r.imx307_replacement ? '<div class="imx307-tip">⚠ IMX307 方案，替代料号: ' + r.imx307_replacement.map(m => `<span class="repl">${esc(m.replacement)}</span>`).join('、') + '</div>' : ''}</td>
    <td>${esc(r.ITEM_TYPE)}</td>
    <td><span class="status-badge ${statusClass(r.INV_STATUS_NAME)}">${esc(r.INV_STATUS_NAME)}</span></td>
    <td class="${qty > 0 ? 'qty-positive' : 'qty-zero'}">${esc(r.ON_HAND_QTY)}</td>
    <td>${esc(r.DEVELOPMENT_SUB || '-')}</td>
    <td>${esc(r.TRACK_SUB || '-')}</td>
    <td>${esc(r.PRODUCT_ORDER_SUB || '-')}</td>
    <td>${esc(r.UPDATE_ORDER_SUB || '-')}</td>
  </tr>`;
  }).join('\n')}
</tbody>
</table>
</div>`;
}

// search / item 报告
function materialReportHtml(rows, queryLabel, labelType) {
  const inStock = rows.filter(r => parseInt(r.ON_HAND_QTY) > 0);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>物料查询结果 - ${esc(queryLabel)}</title>
<style>${baseCss()}</style>
</head>
<body>
<h1>物料查询结果</h1>
<div class="meta">${labelType}: <code>${esc(queryLabel)}</code> | 组织ID: 102 | 查询时间: ${new Date().toLocaleString('zh-CN')}</div>
<div class="summary">
  <div class="summary-item"><div class="num">${rows.length}</div><div class="label">总记录数</div></div>
  <div class="summary-item"><div class="num">${inStock.length}</div><div class="label">有库存</div></div>
  <div class="summary-item"><div class="num">${rows.filter(r => r.ITEM_TYPE === '制造').length}</div><div class="label">制造件</div></div>
  <div class="summary-item"><div class="num">${rows.filter(r => r.ITEM_TYPE === '采购').length}</div><div class="label">采购件</div></div>
</div>
${rows.length ? materialRowsTable(rows) : '<div class="card"><div class="empty">未查询到匹配记录</div></div>'}
</body>
</html>`;
}

// batch 报告
function batchReportHtml(allRows, itemNumbers, results) {
  const successCount = results.filter(r => r.rows && r.rows.length > 0).length;
  const failCount = results.length - successCount;
  const fallbackCount = results.filter(r => r.method === 'ITEM_DESC').length;
  const inStock = allRows.filter(r => parseInt(r.ON_HAND_QTY) > 0);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>批量物料查询结果 - ${itemNumbers.length}个料号</title>
<style>${baseCss()}</style>
</head>
<body>
<h1>批量物料查询结果</h1>
<div class="meta">查询料号数: ${itemNumbers.length} | 组织ID: 102 | 查询时间: ${new Date().toLocaleString('zh-CN')}</div>
<div class="search-terms">
  <strong>查询料号列表:</strong><br>
  ${itemNumbers.map(n => `<code>${esc(n)}</code>`).join('')}
</div>
<div class="summary">
  <div class="summary-item"><div class="num">${allRows.length}</div><div class="label">总记录数</div></div>
  <div class="summary-item"><div class="num ok">${successCount}</div><div class="label">查询成功</div></div>
  <div class="summary-item"><div class="num warn">${failCount}</div><div class="label">查询失败</div></div>
  <div class="summary-item"><div class="num info">${fallbackCount}</div><div class="label">模糊匹配</div></div>
  <div class="summary-item"><div class="num">${inStock.length}</div><div class="label">有库存</div></div>
</div>
${materialRowsTable(allRows)}
</body>
</html>`;
}

// BOM 报告
function bomReportHtml(parent, bomRows, columns, itemNo) {
  const parentFields = [
    ['料号', 'ITEM_NUMBER'], ['物料描述', 'ITEM_DESC'], ['物料类型', 'ITEM_TYPE'],
    ['生命周期', 'INV_STATUS_NAME'], ['库存现有量', 'ON_HAND_QTY'],
    ['研发仓', 'DEVELOPMENT_SUB'], ['跟踪品仓', 'TRACK_SUB'], ['产成品', 'PRODUCT_ORDER_SUB'], ['整改仓', 'UPDATE_ORDER_SUB']
  ].filter(([_, p]) => parent[p] !== undefined);

  const usedCols = columns.length
    ? columns.filter(c => bomRows.some(r => r[c.property] !== undefined && r[c.property] !== ''))
    : [];
  const finalCols = usedCols.length ? usedCols
    : (bomRows.length ? Object.keys(bomRows[0]).map(k => ({ title: k, property: k })) : []);

  // 层级分布统计
  const levelDist = {};
  bomRows.forEach(r => {
    const lvl = r.BOM_LEVEL || r.LEVEL || '-';
    levelDist[lvl] = (levelDist[lvl] || 0) + 1;
  });

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>BOM 查询结果 - ${esc(itemNo)}</title>
<style>${baseCss()}</style>
</head>
<body>
<h1>BOM 查询结果</h1>
<div class="meta">父项料号: <code>${esc(itemNo)}</code> | 组织ID: 102 | 查询时间: ${new Date().toLocaleString('zh-CN')}</div>

<div class="summary">
  <div class="summary-item"><div class="num">${bomRows.length}</div><div class="label">BOM 子项数</div></div>
  ${Object.keys(levelDist).sort().map(lvl =>
    `<div class="summary-item"><div class="num">${levelDist[lvl]}</div><div class="label">层级 ${esc(lvl)}</div></div>`).join('')}
</div>

<h2>父项物料信息</h2>
<div class="card">
${parentFields.length ? `<div class="kv">${parentFields.map(([label, p]) => {
    let val = esc(parent[p]);
    if (p === 'INV_STATUS_NAME') val = `<span class="status-badge ${statusClass(parent[p])}">${val}</span>`;
    return `<div class="item"><span class="k">${label}</span><span class="v">${val}</span></div>`;
  }).join('')}</div>` : '<div class="empty">未查询到父项物料信息</div>'}
</div>

<h2>BOM 子项明细</h2>
${bomRows.length ? `<div class="table-wrap">
<table>
<thead>
<tr><th>序号</th>${finalCols.map(c => `<th>${esc(c.title)}</th>`).join('')}</tr>
</thead>
<tbody>
${bomRows.map((r, i) => `<tr><td>${i + 1}</td>${finalCols.map(c => {
    const v = r[c.property];
    if (c.property === 'ITEM_NUMBER' || c.property === 'COMPONENT_ITEM' || c.property === 'COMPONENT_ITEM_NUMBER') return `<td class="item-no">${esc(v)}</td>`;
    return `<td>${esc(v)}</td>`;
  }).join('')}</tr>`).join('\n')}
</tbody>
</table>
</div>` : '<div class="card"><div class="empty">未查询到 BOM 子项（该料号可能不是父项 / BOM 未维护）</div></div>'}
</body>
</html>`;
}

// 规格文件报告
function specReportHtml(files, itemNo, downloadDir) {
  const extDist = {};
  files.forEach(f => { extDist[f.ext || '-'] = (extDist[f.ext || '-'] || 0) + 1; });
  const itemDes = files.length ? files[0].itemDes : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>规格文件查询结果 - ${esc(itemNo)}</title>
<style>${baseCss()}</style>
</head>
<body>
<h1>规格文件查询结果</h1>
<div class="meta">料号: <code>${esc(itemNo)}</code> | 查询时间: ${new Date().toLocaleString('zh-CN')}</div>

<div class="summary">
  <div class="summary-item"><div class="num">${files.length}</div><div class="label">文件数</div></div>
  ${Object.keys(extDist).map(ext =>
    `<div class="summary-item"><div class="num">${extDist[ext]}</div><div class="label">${esc(ext.toUpperCase())}</div></div>`).join('')}
</div>

${itemDes ? `<div class="card"><div class="kv"><div class="item"><span class="k">物料描述</span><span class="v">${esc(itemDes)}</span></div></div></div>` : ''}

${files.length ? `<div class="table-wrap">
<table>
<thead>
<tr><th>序号</th><th>文件名</th><th>类型</th><th>下载</th></tr>
</thead>
<tbody>
${files.map((f, i) => `<tr>
  <td>${i + 1}</td>
  <td>${esc(f.fileName)}</td>
  <td><span class="status-badge status-dev">${esc(f.ext ? f.ext.toUpperCase() : '-')}</span></td>
  <td>${f.url ? `<a href="${esc(f.url)}" target="_blank" style="color:#25A1FD">下载</a>` : '-'}</td>
</tr>`).join('\n')}
</tbody>
</table>
</div>` : '<div class="card"><div class="empty">该料号未关联规格文件</div></div>'}
${downloadDir ? `<div class="meta" style="margin-top:15px">文件已下载至: ${esc(downloadDir)}</div>` : ''}
</body>
</html>`;
}

// ── 主流程 ───────────────────────────────────────────────────
async function main() {
  const { cmd, params, outDir, orgId, download, json } = parseArgs(process.argv);
  if (!json) {
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  }

  try {
    if (cmd === 'search') {
      const keyword = params.join(' ');
      console.log(`[INFO] 物料描述搜索: ${keyword}`);
      const { rows } = await queryMaterial(orgId, 'q.ITEM_DESC', keyword);
      console.log(`[INFO] 共 ${rows.length} 条记录`);
      const rows2 = attachImx307(rows);
      const imxCount = rows2.filter(r => r.imx307_replacement).length;
      if (imxCount > 0) console.log(`[IMX307] ${imxCount} 条记录含 IMX307 方案，已附加替代料号信息`);
      if (json) printJson({ query: keyword, rows: rows2 });
      else saveHtml(outDir, 'material_query_result.html', materialReportHtml(rows2, keyword, '查询条件'));
    }

    else if (cmd === 'item') {
      const itemNo = params[0];
      console.log(`[INFO] 单料号查询: ${itemNo}`);
      const result = await queryOneItem(orgId, itemNo);
      if (result.rows.length === 0) console.log(`[WARN] ${itemNo}: 未找到`);
      else console.log(`[OK] ${itemNo}: ${result.rows.length} 条记录 (via ${result.method})`);
      const rows2 = attachImx307(result.rows);
      if (rows2.some(r => r.imx307_replacement)) console.log(`[IMX307] ${itemNo} 为 IMX307 方案，已附加替代料号信息`);
      if (json) {
        printJson({ itemNumber: itemNo, method: result.method || null, error: result.error || null, rows: rows2 });
      } else {
        const rows = rows2.map(r => ({ ...r, _fallback: result.method === 'ITEM_DESC' }));
        if (rows.length === 0) rows.push({ ITEM_NUMBER: itemNo, ITEM_DESC: '未找到', _error: true });
        saveHtml(outDir, 'material_query_result.html', materialReportHtml(rows, itemNo, '查询料号'));
      }
    }

    else if (cmd === 'batch') {
      const itemNumbers = params;
      console.log(`[INFO] 批量查询 ${itemNumbers.length} 个料号`);
      const results = [];
      for (let i = 0; i < itemNumbers.length; i++) {
        console.log(`[${i + 1}/${itemNumbers.length}] ${itemNumbers[i]}`);
        try {
          const r = await queryOneItem(orgId, itemNumbers[i]);
          results.push(r);
          console.log(`  ${r.rows.length > 0 ? `[OK] ${r.rows.length} 条 (via ${r.method})` : '[WARN] 未找到'}`);
        } catch (e) {
          if (e.sessionInvalid) throw e;
          console.error(`  [ERROR] ${e.message}`);
          results.push({ itemNumber: itemNumbers[i], rows: [], error: e.message });
        }
        await new Promise(r => setTimeout(r, 300));
      }
      const itemsOut = results.map(r => {
        const rows2 = attachImx307(r.rows || []);
        if (rows2.some(x => x.imx307_replacement)) console.log(`[IMX307] ${r.itemNumber} 为 IMX307 方案，已附加替代料号信息`);
        return { itemNumber: r.itemNumber, found: rows2.length > 0, method: r.method || null, error: r.error || null, rows: rows2 };
      });
      if (json) {
        printJson({ items: itemsOut });
      } else {
        const allRows = [];
        results.forEach(r => {
          if (r.rows && r.rows.length > 0) {
            r.rows.forEach(row => allRows.push({ ...row, _fallback: r.method === 'ITEM_DESC' }));
          } else {
            allRows.push({ ITEM_NUMBER: r.itemNumber, ITEM_DESC: r.error || '未找到', _error: true });
          }
        });
        saveHtml(outDir, 'material_batch_result.html', batchReportHtml(allRows, itemNumbers, results));
        console.log(`[INFO] 总计 ${allRows.length} 条记录`);
      }
    }

    else if (cmd === 'bom') {
      const itemNo = params[0];
      console.log(`[INFO] BOM 查询: ${itemNo}`);
      const { parentData, parentRows, bomData, bomRows } = await queryBom(orgId, itemNo);
      console.log(`[INFO] 父项记录: ${parentRows.length}，BOM 子项: ${bomRows.length}`);
      const columns = (bomData.columns || []).map(c => ({ title: c.title, property: c.property }));
      if (json) printJson({ itemNumber: itemNo, parent: parentRows[0] || {}, columns, bomRows });
      else saveHtml(outDir, 'bom_result.html', bomReportHtml(parentRows[0] || {}, bomRows, columns, itemNo));
    }

    else if (cmd === 'spec') {
      const itemNo = params[0];
      console.log(`[INFO] 规格文件查询: ${itemNo}`);
      const { data, files } = await querySpec(itemNo);
      console.log(`[INFO] 文件数: ${files.length}`);

      // 可选下载
      let downloadDir = '';
      if (download && files.length > 0) {
        downloadDir = path.join(outDir, 'spec_files');
        if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
        const jar = loadCookieJar();
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          console.log(`[DOWNLOAD ${i + 1}/${files.length}] ${f.fileName}`);
          try {
            const buf = await downloadFile(f.url, jar);
            const safeName = f.fileName.replace(/[\\/:*?"<>|]/g, '_');
            const fp = path.join(downloadDir, safeName);
            fs.writeFileSync(fp, buf);
            f.localPath = fp;
            console.log(`  [OK] ${buf.length} bytes -> ${fp}`);
          } catch (e) {
            console.error(`  [ERROR] ${e.message}`);
            f.downloadError = e.message;
          }
        }
      }

      if (json) printJson({ itemNumber: itemNo, files });
      else saveHtml(outDir, 'spec_file_result.html', specReportHtml(files, itemNo, downloadDir));
    }

    console.log('[DONE]');
  } catch (e) {
    if (e.sessionInvalid) {
      console.error('[FATAL] 登录后会话仍无效，请检查内网网络，或手动在浏览器打开 OA 登录后重试');
      process.exit(1);
    }
    throw e;
  }
}

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
