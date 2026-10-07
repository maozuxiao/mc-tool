/**
 * AuthManager - 认证管理器
 * 支持自动拉起浏览器登录并回填Cookie
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const {
  buildCookieIdentityKey,
  normalizeChatUserId,
  parseChatUserIdFromHtml
} = require('./chatUserId');

const LOGIN_URL = 'https://deap.dingtalk.com/';
const REQUIRED_COOKIE_FIELDS = ['corp_id', 'account', 'isg'];
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const LOGIN_POLL_INTERVAL_MS = 2000;

class AuthManager {
  constructor(config) {
    this.config = config;
    this.cookiePath = config.cache?.cookie_path || this.getDefaultCookiePath();
    this.cookies = null;
    this.cookieString = null;
    this.cookieCacheData = null;
    this.chatUserId = null;
    this.chatUserIdSource = 'none';
    this.loginPromise = null;
  }

  /**
   * 获取默认Cookie路径
   */
  getDefaultCookiePath() {
    const homeDir = process.platform === 'win32'
      ? process.env.USERPROFILE
      : process.env.HOME;
    return path.join(homeDir, '.dingding-mcp', '.cache', 'cookies.json');
  }

  getConfigPath() {
    if (process.env.DINGDING_CONFIG_PATH) {
      return process.env.DINGDING_CONFIG_PATH;
    }

    const homeDir = process.platform === 'win32'
      ? process.env.USERPROFILE
      : process.env.HOME;
    return path.join(homeDir, '.dingding-mcp', 'config.json');
  }

  /**
   * 获取有效的Cookie
   * @returns {Promise<string>} Cookie字符串
   */
  async getValidCookies() {
    // 1) 优先使用缓存Cookie
    if (await this.loadCachedCookies()) {
      if (await this.verifyCookies()) {
        return this.cookieString;
      }
      this.clearCache();
    }

    // 2) 尝试使用配置文件中的Cookie
    const configCookie = this.config.auth?.cookie_string;
    if (configCookie) {
      console.error('[Auth] 使用配置文件中的Cookie进行校验');
      this.cookieString = configCookie;
      this.cookies = this.parseCookieString(configCookie);

      if (await this.verifyCookies()) {
        console.error('[Auth] 配置Cookie验证通过');
        await this.saveCookies();
        return this.cookieString;
      }

      console.error('[Auth] 配置Cookie已失效，进入浏览器登录流程');
    }

    // 3) 自动拉起本机 Chrome，等待用户手动扫码并自动保存 Cookie
    return this.loginWithBrowserAndCaptureCookie(LOGIN_TIMEOUT_MS);
  }

  /**
   * 解析Cookie字符串为数组格式
   */
  parseCookieString(cookieString) {
    if (!cookieString) return [];

    return cookieString.split(';').map(pair => {
      const [name, ...valueParts] = pair.trim().split('=');
      return {
        name: name.trim(),
        value: valueParts.join('=').trim(),
        domain: '.dingtalk.com'
      };
    }).filter(c => c.name);
  }

  async verifyCookies() {
    if (!this.cookieString) return false;
    return this.verifyCookieString(this.cookieString);
  }

  async verifyCookieString(cookieString) {
    if (!cookieString) return false;
    const hasRequiredFields = REQUIRED_COOKIE_FIELDS.every((field) =>
      cookieString.includes(`${field}=`)
    );

    if (!hasRequiredFields) {
      console.error('[Auth] Cookie缺少必要字段');
      return false;
    }

    try {
      return new Promise((resolve) => {
        const options = {
          hostname: 'deap.dingtalk.com',
          path: '/',
          method: 'HEAD',
          headers: {
            'Cookie': cookieString,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36'
          },
          timeout: 5000
        };

        const req = https.request(options, (res) => {
          // 只要不是401/403，就认为是有效的
          resolve(res.statusCode !== 401 && res.statusCode !== 403);
        });

        req.on('error', () => resolve(false));
        req.on('timeout', () => {
          req.destroy();
          resolve(false);
        });

        req.end();
      });
    } catch (error) {
      console.error('[Auth] Cookie验证请求失败:', error.message);
      return hasRequiredFields;
    }
  }

  /**
   * 从缓存加载Cookie
   */
  async loadCachedCookies() {
    try {
      if (!fs.existsSync(this.cookiePath)) {
        return false;
      }

      const data = JSON.parse(fs.readFileSync(this.cookiePath, 'utf-8'));
      
      // 检查是否过期
      if (data.expires && new Date(data.expires) < new Date()) {
        console.error('[Auth] 缓存的Cookie已过期');
        return false;
      }

      this.cookies = data.cookies;
      this.cookieString = data.cookieString;
      this.cookieCacheData = data;
      
      console.error('[Auth] 已加载缓存的Cookie');
      return true;
    } catch (error) {
      console.error('[Auth] 加载缓存Cookie失败:', error.message);
      return false;
    }
  }

  async getCookieHealth() {
    if (await this.loadCachedCookies()) {
      if (await this.verifyCookies()) {
        return { valid: true, source: 'cache' };
      }
    }

    const configCookie = this.config.auth?.cookie_string;
    if (configCookie) {
      if (await this.verifyCookieString(configCookie)) {
        return { valid: true, source: 'config' };
      }
    }

    return { valid: false, source: 'none' };
  }

  /**
   * 保存Cookie到缓存
   */
  async saveCookies() {
    try {
      const dir = path.dirname(this.cookiePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let existing = {};
      if (fs.existsSync(this.cookiePath)) {
        try {
          existing = JSON.parse(fs.readFileSync(this.cookiePath, 'utf-8'));
        } catch (_) {
          existing = {};
        }
      }

      const identityKey = buildCookieIdentityKey(this.cookieString);
      const keepCachedUserId = identityKey &&
        existing.chat_user_identity_key === identityKey &&
        existing.chat_user_id;
      const data = {
        cookies: this.cookies,
        cookieString: this.cookieString,
        saved: new Date().toISOString(),
        source: 'auto_login'
      };
      if (keepCachedUserId) {
        data.chat_user_id = existing.chat_user_id;
        data.chat_user_identity_key = identityKey;
      }
      if (this.chatUserId && this.chatUserIdIdentityKey === identityKey) {
        data.chat_user_id = this.chatUserId;
        data.chat_user_identity_key = identityKey;
      }

      fs.writeFileSync(this.cookiePath, JSON.stringify(data, null, 2));
      this.cookieCacheData = data;
      console.error('[Auth] Cookie已保存到缓存');
    } catch (error) {
      console.error('[Auth] 保存Cookie失败:', error.message);
    }
  }

  /**
   * 格式化Cookie为字符串
   */
  formatCookies(cookies) {
    if (!cookies || !Array.isArray(cookies)) return '';
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  }

  /**
   * 清除缓存
   */
  clearCache() {
    this.cookies = null;
    this.cookieString = null;
    this.cookieCacheData = null;
    this.chatUserId = null;
    this.chatUserIdSource = 'none';
    if (fs.existsSync(this.cookiePath)) {
      fs.unlinkSync(this.cookiePath);
      console.error('[Auth] Cookie缓存已清除');
    }
  }

  /**
   * 获取当前Cookie字符串
   */
  getCookieString() {
    return this.cookieString;
  }

  /**
   * 获取解析后的Cookie数组
   */
  getCookies() {
    return this.cookies;
  }

  readCookieCacheData() {
    if (this.cookieCacheData) return this.cookieCacheData;
    if (!fs.existsSync(this.cookiePath)) return {};
    try {
      this.cookieCacheData = JSON.parse(fs.readFileSync(this.cookiePath, 'utf-8'));
      return this.cookieCacheData;
    } catch (_) {
      return {};
    }
  }

  persistChatUserIdToCache(chatUserId, cookieString) {
    const normalized = normalizeChatUserId(chatUserId);
    const identityKey = buildCookieIdentityKey(cookieString);
    if (!identityKey) {
      throw new AuthError('无法识别当前登录身份，不能安全缓存 DEAP 用户 ID');
    }

    const dir = path.dirname(this.cookiePath);
    fs.mkdirSync(dir, { recursive: true });
    const existing = this.readCookieCacheData();
    const data = {
      ...existing,
      chat_user_id: normalized,
      chat_user_identity_key: identityKey,
      chat_user_id_updated_at: new Date().toISOString()
    };
    fs.writeFileSync(this.cookiePath, JSON.stringify(data, null, 2));
    this.cookieCacheData = data;
    this.chatUserId = normalized;
    this.chatUserIdIdentityKey = identityKey;
  }

  async fetchDeapHomeHtml(cookieString) {
    const response = await fetch(LOGIN_URL, {
      method: 'GET',
      headers: {
        'Cookie': cookieString,
        'Accept': 'text/html,application/xhtml+xml',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    if (!response.ok) {
      throw new AuthError(`读取 DEAP 登录页失败: HTTP ${response.status}`);
    }
    return response.text();
  }

  async getChatUserId(cookieString = '') {
    const activeCookieString = cookieString || this.cookieString || await this.getValidCookies();
    const configured = this.config.auth?.chat_user_id ?? this.config.auth?.user_id;
    if (configured !== undefined && configured !== '') {
      const chatUserId = normalizeChatUserId(configured);
      this.persistChatUserIdToCache(chatUserId, activeCookieString);
      this.chatUserIdSource = this.config.auth?.chat_user_id !== undefined
        ? 'config.chat_user_id'
        : 'config.user_id';
      return chatUserId;
    }

    const identityKey = buildCookieIdentityKey(activeCookieString);
    const cache = this.readCookieCacheData();
    if (
      identityKey &&
      cache.chat_user_identity_key === identityKey &&
      cache.chat_user_id
    ) {
      const chatUserId = normalizeChatUserId(cache.chat_user_id);
      this.chatUserId = chatUserId;
      this.chatUserIdIdentityKey = identityKey;
      this.chatUserIdSource = 'cache';
      return chatUserId;
    }

    const html = await this.fetchDeapHomeHtml(activeCookieString);
    const chatUserId = parseChatUserIdFromHtml(html);
    if (!chatUserId) {
      throw new AuthError(
        '无法从 DEAP 登录态获取用户 ID；请重新执行 mcp_auth，或配置 auth.chat_user_id'
      );
    }
    this.persistChatUserIdToCache(chatUserId, activeCookieString);
    this.chatUserIdSource = 'deap_home';
    return chatUserId;
  }

  resolvePersistConfigPath(configPath, configJson) {
    const ref = configJson?._merge_auth_from;
    if (!ref || typeof ref !== 'string') {
      return configPath;
    }

    return path.isAbsolute(ref)
      ? ref
      : path.resolve(path.dirname(configPath), ref);
  }

  async persistCookieToConfig(cookieString) {
    const configPath = this.getConfigPath();
    let configJson = this.config;
    if (fs.existsSync(configPath)) {
      configJson = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    const persistPath = this.resolvePersistConfigPath(configPath, configJson);
    let persistJson = {};
    if (fs.existsSync(persistPath)) {
      persistJson = JSON.parse(fs.readFileSync(persistPath, 'utf-8'));
    }

    if (!persistJson.auth) {
      persistJson.auth = {};
    }

    persistJson.auth.cookie_string = cookieString;
    const corpMatch = cookieString.match(/(?:^|;\s*)corp_id=([^;]+)/);
    if (corpMatch) {
      persistJson.auth.corp_id = decodeURIComponent(corpMatch[1]);
    }

    fs.writeFileSync(persistPath, `${JSON.stringify(persistJson, null, 2)}\n`, 'utf-8');
    this.config.auth = persistJson.auth;
  }

  formatCookieListToString(cookieList) {
    if (!Array.isArray(cookieList) || cookieList.length === 0) {
      return '';
    }
    return cookieList.map((item) => `${item.name}=${item.value}`).join('; ');
  }

  async loginWithBrowserAndCaptureCookie(timeoutMs = LOGIN_TIMEOUT_MS) {
    if (this.loginPromise) {
      return this.loginPromise;
    }

    this.loginPromise = this.performBrowserLogin(timeoutMs)
      .finally(() => {
        this.loginPromise = null;
      });
    return this.loginPromise;
  }

  async performBrowserLogin(timeoutMs) {
    let playwright;
    try {
      playwright = require('playwright');
    } catch (error) {
      throw new AuthError(
        '缺少 playwright 依赖，无法自动拉起并监控浏览器登录。'
      );
    }

    let browser;
    let channelUsed = null;
    const launchErrors = [];
    for (const channel of ['chrome', 'msedge']) {
      try {
        browser = await playwright.chromium.launch({
          channel,
          headless: false,
        });
        channelUsed = channel;
        break;
      } catch (error) {
        launchErrors.push(`${channel}: ${error.message}`);
      }
    }
    if (!browser) {
      throw new AuthError(
        '无法启动本机浏览器登录窗口。已尝试 Google Chrome 与 Microsoft Edge，均未找到。' +
        '请确认已安装 Chrome 或 Edge 浏览器，然后重试 mcp_auth。' +
        ` 原因: ${launchErrors.join('；')}`
      );
    }
    const context = await browser.newContext();
    const page = await context.newPage();

    const channelLabel = channelUsed === 'msedge' ? 'Microsoft Edge' : 'Google Chrome';
    console.error(`[Auth] 已拉起本机 ${channelLabel}（channel=${channelUsed}）登录页面，请用户手动完成钉钉登录；MCP 将自动保存 Cookie...`);
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    const startTime = Date.now();
    let lastError = '';
    while (Date.now() - startTime < timeoutMs) {
      try {
        const cookies = await context.cookies([LOGIN_URL]);
        const cookieString = this.formatCookieListToString(cookies);
        if (await this.verifyCookieString(cookieString)) {
          this.cookieString = cookieString;
          this.cookies = this.parseCookieString(cookieString);
          await this.persistCookieToConfig(cookieString);
          await this.saveCookies();
          await browser.close();
          console.error('[Auth] 登录成功，已自动更新Cookie');
          return cookieString;
        }
      } catch (error) {
        lastError = error.message;
      }

      await new Promise((resolve) => {
        setTimeout(resolve, LOGIN_POLL_INTERVAL_MS);
      });
    }

    await browser.close();
    throw new AuthError(
      `登录等待超时（${Math.floor(timeoutMs / 1000)}秒），未获取到有效Cookie。` +
      (lastError ? ` 最后错误: ${lastError}` : '')
    );
  }

  async handleInvalidCookieAndPromptLogin() {
    this.clearCache();
    try {
      await this.loginWithBrowserAndCaptureCookie(LOGIN_TIMEOUT_MS);
      return (
        '检测到Cookie已失效，已自动拉起浏览器并完成Cookie刷新。\n' +
        '请重试原请求。'
      );
    } catch (error) {
      return `检测到Cookie已失效：${error.message}`;
    }
  }
}

/**
 * 认证错误类
 */
class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

module.exports = { AuthManager, AuthError };
