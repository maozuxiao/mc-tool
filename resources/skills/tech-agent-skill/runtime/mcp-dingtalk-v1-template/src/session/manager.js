/**
 * SessionManager - 会话管理器
 * 负责管理各窗口的独立会话（Dialog）
 */

const fs = require('fs');
const path = require('path');
const { buildDialogCid, formatPermissionHint } = require('../mcp/cid');

function getDialogIdFromCreateResponse(data) {
  return data?.content?.dialogId || data?.data?.dialogId || '';
}

class SessionManager {
  constructor(config) {
    this.config = config;
    this.sessionPath = config.cache?.session_path || this.getDefaultSessionPath();
    this.sessions = {};
    
    // 生成本次进程的窗口ID
    this.currentWindowId = this.generateWindowId();
    
    // 加载已有会话
    this.loadSessions();
  }

  /**
   * 获取默认会话文件路径
   */
  getDefaultSessionPath() {
    const homeDir = process.platform === 'win32'
      ? process.env.USERPROFILE
      : process.env.HOME;
    return path.join(homeDir, '.dingding-mcp', '.cache', 'sessions.json');
  }

  /**
   * 生成窗口ID（如果环境变量未设置）
   */
  generateWindowId() {
    // 使用时间戳+随机数生成临时ID
    return `window-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * 从文件加载会话
   */
  loadSessions() {
    try {
      if (fs.existsSync(this.sessionPath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
        this.sessions = data.sessions || {};
        console.error(
          `[Session] 已加载 ${Object.keys(this.sessions).length} 个窗口会话`
        );
      }
    } catch (error) {
      console.error('[Session] 加载会话缓存失败:', error.message);
      this.sessions = {};
    }
  }

  /**
   * 保存会话到文件
   */
  saveSessions() {
    try {
      fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
      fs.writeFileSync(this.sessionPath, JSON.stringify({
        sessions: this.sessions,
        updated_at: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      console.error('[Session] 保存会话失败:', error.message);
    }
  }

  /**
   * 获取或创建当前窗口的Dialog
   * @param {AuthManager} authManager - 认证管理器
   * @returns {Promise<string>} dialogId
   */
  async getOrCreateDialog(authManager) {
    // 检查当前窗口是否有有效会话
    const existing = this.sessions[this.currentWindowId];
    
    if (existing && existing.dialogId) {
      // 验证会话是否仍然有效
      const isValid = await this.isDialogValid(existing.dialogId, authManager);
      
      if (isValid) {
        console.error(
          `[Session] 复用窗口 ${this.currentWindowId} 的会话: ${existing.dialogId}`
        );
        existing.last_used = new Date().toISOString();
        this.saveSessions();
        return existing.dialogId;
      }
      
      console.error(`[Session] 窗口 ${this.currentWindowId} 的会话已过期`);
    }

    // 优先使用配置文件中的默认 dialogId
    const defaultDialogId = this.config.session?.default_dialog_id;
    if (defaultDialogId) {
      console.error(`[Session] 使用配置文件中的默认 dialogId: ${defaultDialogId}`);
      
      // 验证默认 dialogId 是否有效
      const isValid = await this.isDialogValid(defaultDialogId, authManager);
      
      if (isValid) {
        this.sessions[this.currentWindowId] = {
          dialogId: defaultDialogId,
          agentUuid: this.config.agent?.uuid,
          created_at: new Date().toISOString(),
          last_used: new Date().toISOString()
        };
        this.saveSessions();
        return defaultDialogId;
      }
      
      console.error('[Session] 默认 dialogId 已失效，尝试创建新会话');
    }

    // 创建新会话
    const newDialogId = await this.createNewDialog(authManager);
    
    // 保存会话信息
    this.sessions[this.currentWindowId] = {
      dialogId: newDialogId,
      agentUuid: this.config.agent?.uuid,
      created_at: new Date().toISOString(),
      last_used: new Date().toISOString()
    };
    
    this.saveSessions();
    console.error(`[Session] 窗口 ${this.currentWindowId} 创建新会话: ${newDialogId}`);
    
    return newDialogId;
  }

  /**
   * 创建新Dialog（调用钉钉API）
   */
  async createNewDialog(authManager) {
    const cookies = await authManager.getValidCookies();
    const endpoint = 'https://deap.dingtalk.com/deapHttpProxy/chat/h5/runtime/api/createDialog.json';

    const agentUuid = this.config.agent?.uuid;
    const chatUserId = await authManager.getChatUserId(cookies);
    const dialogCid = buildDialogCid({
      cookieString: cookies,
      authConfig: this.config.auth || {},
      agentUuid,
      chatUserId
    });

    if (dialogCid) {
      console.error('[Session] createDialog 已使用 DEAP userId 与 Agent UUID 构造 cid');
    }

    const basePayload = { prompt: '', welcomeMsg: false };
    const candidateBodies = [
      { label: 'agentUuid', body: { agentUuid, ...basePayload, cid: dialogCid } },
      { label: 'agentCode', body: { agentCode: agentUuid, ...basePayload, cid: dialogCid } }
    ];

    const errors = [];
    for (const candidate of candidateBodies) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookies,
          'Accept': 'application/json'
        },
        body: JSON.stringify(candidate.body)
      });

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        errors.push(`[${candidate.label}] HTTP ${response.status}: 返回非 JSON`);
        continue;
      }

      const dialogId = getDialogIdFromCreateResponse(data);
      if (data?.success && dialogId) {
        return dialogId;
      }

      const errorMessage = data?.errorMsg || data?.message || `HTTP ${response.status}`;
      errors.push(`[${candidate.label}] ${errorMessage}`);
    }

    const errorSummary = errors.length > 0 ? errors.join('；') : '未知错误';
    throw new SessionError(`创建会话失败: ${formatPermissionHint(errorSummary)}`);
  }

  /**
   * 验证Dialog是否有效
   * 注意：不再通过向 chat.json 发送空消息来探测（那会在 DEAP 后台产生“空请求”）。
   * 这里只做轻量判断：dialogId 非空 + 能取到有效 Cookie 即认为缓存会话可复用。
   * 若复用的会话实际已失效，由 handleChat 的“会话失效自动重建”分支兜底。
   */
  async isDialogValid(dialogId, authManager) {
    if (!dialogId) return false;

    try {
      const cookies = await authManager.getValidCookies();
      return !!cookies;
    } catch (error) {
      console.error('[Session] Dialog验证失败:', error.message);
      return false;
    }
  }

  /**
   * 重置当前窗口会话
   */
  resetCurrentWindow() {
    if (this.sessions[this.currentWindowId]) {
      const oldDialogId = this.sessions[this.currentWindowId].dialogId;
      delete this.sessions[this.currentWindowId];
      this.saveSessions();
      console.error(
        `[Session] 已重置窗口 ${this.currentWindowId} 的会话 (原会话: ${oldDialogId})`
      );
      return oldDialogId;
    }
    return null;
  }

  /**
   * 获取当前窗口状态
   */
  getCurrentWindowStatus() {
    const session = this.sessions[this.currentWindowId];
    return {
      windowId: this.currentWindowId,
      hasSession: !!session,
      dialogId: session?.dialogId || null,
      createdAt: session?.created_at || null,
      lastUsed: session?.last_used || null
    };
  }

  /**
   * 清理过期会话（可选功能）
   */
  cleanupExpiredSessions(maxAgeHours = 168) {  // 默认7天
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [windowId, session] of Object.entries(this.sessions)) {
      const lastUsed = new Date(session.last_used).getTime();
      if (now - lastUsed > maxAgeMs) {
        delete this.sessions[windowId];
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.saveSessions();
      console.error(`[Session] 清理了 ${cleaned} 个过期会话`);
    }

    return cleaned;
  }

  /**
   * 获取所有窗口状态（用于调试）
   */
  getAllSessions() {
    return {
      currentWindow: this.currentWindowId,
      totalWindows: Object.keys(this.sessions).length,
      sessions: this.sessions
    };
  }
}

/**
 * 会话错误类
 */
class SessionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionError';
  }
}

module.exports = { SessionManager, SessionError, getDialogIdFromCreateResponse };

// 如果直接运行此文件，执行测试
if (require.main === module) {
  console.log('=== SessionManager 测试 ===\n');
  
  const { ConfigLoader } = require('../config/loader');
  const { AuthManager } = require('../auth/manager');
  
  try {
    const configLoader = new ConfigLoader();
    const config = configLoader.load();
    
    const sessionManager = new SessionManager(config);
    const authManager = new AuthManager(config);
    
    console.log('当前窗口ID:', sessionManager.currentWindowId);
    console.log('会话文件路径:', sessionManager.sessionPath);
    console.log('现有会话数:', Object.keys(sessionManager.sessions).length);
    
    // 测试获取或创建dialog
    sessionManager.getOrCreateDialog(authManager)
      .then(dialogId => {
        console.log('\n✅ Dialog获取成功:', dialogId);
        console.log('窗口状态:', sessionManager.getCurrentWindowStatus());
      })
      .catch(error => {
        console.log('\n❌ Dialog获取失败:', error.message);
        process.exit(1);
      });
      
  } catch (error) {
    console.log('\n❌ 配置加载失败:', error.message);
    process.exit(1);
  }
}
