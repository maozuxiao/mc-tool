#!/usr/bin/env node
/**
 * DingDing MCP V2 - 主程序入口
 * 
 * 集成模块：
 * - ConfigLoader: 配置加载
 * - AuthManager: 自动登录/Cookie管理
 * - SessionManager: 窗口级会话管理
 * 
 * 提供MCP Tools：
 * - chat: 与钉钉AI对话
 * - status: 查看当前状态
 * - reset: 重置当前窗口会话
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} = require('@modelcontextprotocol/sdk/types.js');

const { ConfigLoader, ConfigError } = require('./config/loader');
const { AuthManager, AuthError } = require('./auth/manager');
const { SessionManager, SessionError } = require('./session/manager');
const { buildToolNames } = require('./mcp/toolNames');

class DingDingMCPServer {
  constructor() {
    this.config = null;
    this.authManager = null;
    this.sessionManager = null;
    this.server = null;
    this.initialized = false;
  }

  /**
   * 初始化服务器
   */
  async initialize() {
    try {
      console.error('[DingDing MCP] 正在初始化...');

      // 1. 加载配置
      const configLoader = new ConfigLoader();
      this.config = configLoader.load();
      this.toolNames = buildToolNames(this.config);
      console.error(
        '[DingDing MCP] Config loaded, mcp tool_id=' + this.toolNames.toolId
      );

      // 2. 初始化认证管理器
      this.authManager = new AuthManager(this.config);
      console.error('[DingDing MCP] 认证管理器初始化完成');

      // 3. 初始化会话管理器
      this.sessionManager = new SessionManager(this.config);
      console.error('[DingDing MCP] 会话管理器初始化完成');
      console.error(`[DingDing MCP] 当前窗口: ${this.sessionManager.currentWindowId}`);

      // 4. 创建MCP服务器
      this.server = new Server(
        {
          name: this.toolNames.serverName,
          version: '2.0.0'
        },
        {
          capabilities: {
            tools: {}
          }
        }
      );

      // 5. 设置请求处理器
      this.setupHandlers();

      this.initialized = true;
      console.error('[DingDing MCP] 初始化完成，等待连接...\n');

    } catch (error) {
      console.error('[DingDing MCP] 初始化失败:', error.message);
      throw error;
    }
  }

  /**
   * 设置MCP请求处理器
   */
  setupHandlers() {
    const agentLabel = this.config.agent?.name || 'DingTalk agent';
    const t = this.toolNames;

    // 列出可用工具（工具名带实例后缀，与其它 stdio 实例区分，避免误路由）
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          {
            name: t.chat,
            description:
              `【${agentLabel}】在 DEAP 中与此钉钉智能体对话；支持 @文件路径 上传。` +
              ` 实例: ${t.toolId}。不要与其它 MCP 的 chat_* 混用。`,
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: '消息内容，可包含@文件路径自动上传文件分析'
                }
              },
              required: ['message']
            }
          },
          {
            name: t.status,
            description: `【${agentLabel}】当前实例认证与会话（instance ${t.toolId}）`,
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: t.reset,
            description: `【${agentLabel}】仅重置本实例（${t.toolId}）的窗口会话`,
            inputSchema: {
              type: 'object',
              properties: {}
            }
          },
          {
            name: t.mcp_auth,
            description: `【${agentLabel}】本实例（${t.toolId}）浏览器登录；与其它实例的登录态可能共享同一 Cookie 文件。`,
            inputSchema: {
              type: 'object',
              properties: {}
            }
          }
        ]
      };
    });

    // 处理工具调用
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const t = this.toolNames;

      try {
        if (name === t.chat) {
          return await this.handleChat(args);
        }
        if (name === t.status) {
          return await this.handleStatus();
        }
        if (name === t.reset) {
          return await this.handleReset();
        }
        if (name === t.mcp_auth) {
          return await this.handleAuth();
        }
        throw new McpError(
          ErrorCode.MethodNotFound,
          `Unknown tool: ${name} (this instance: ${t.toolId})`
        );
      } catch (error) {
        if (this.isAuthFailureError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `❌ 认证失败: ${error.message}`
              }
            ],
            isError: true
          };
        }

        console.error(`[DingDing MCP] 工具调用失败 [${name}]:`, error.message);
        
        // 返回友好的错误信息
        return {
          content: [
            {
              type: 'text',
              text: `❌ 操作失败: ${error.message}\n\n` +
                    (error instanceof ConfigError ? 
                      '请检查配置文件: ~/.dingding-mcp/config.json' : '') +
                    (error instanceof AuthError ? 
                      '请重新执行 mcp_auth；若仍失败，请检查 auth.chat_user_id 是否为有效 DEAP userId' : '') +
                    (error instanceof SessionError ? 
                      '会话创建失败，请尝试 reset 重置会话' : '')
            }
          ],
          isError: true
        };
      }
    });
  }

  /**
   * 判断错误是否属于登录态失效
   */
  isAuthFailureError(error) {
    if (error instanceof AuthError) {
      return true;
    }

    const text = `${error?.message || ''}`.toLowerCase();
    return text.includes('loginurl') ||
      text.includes('sso_need_login') ||
      text.includes('challenge.htm') ||
      text.includes('oauth2/auth') ||
      text.includes('未登录') ||
      text.includes('登录失效') ||
      text.includes('登录态失效');
  }

  /**
   * 判断错误是否属于会话（dialog）失效/不存在，需要重建会话后重试
   */
  isDialogInvalidError(error) {
    const text = `${error?.message || ''}`.toLowerCase();
    return text.includes('dialog不存在') ||
      text.includes('dialog已过期') ||
      text.includes('无效dialog') ||
      text.includes('会话不存在') ||
      text.includes('conversation not found') ||
      text.includes('invalid dialog') ||
      text.includes('无此智能体使用权限') ||
      text.includes('使用权限');
  }

  /**
   * 处理 chat 工具调用
   */
  async handleChat(args) {
    const { message } = args;

    if (!message || message.trim() === '') {
      return {
        content: [{ type: 'text', text: '❌ 消息不能为空' }],
        isError: true
      };
    }

    console.error(`[DingDing MCP] 发送消息: ${message.substring(0, 50)}...`);

    // 1. 获取有效Cookie（自动登录）
    let cookies = await this.authManager.getValidCookies();
    let dialogId;
    let response;
    let attemptedRecovery = false;

    try {
      // 2. 获取或创建会话
      dialogId = await this.sessionManager.getOrCreateDialog(this.authManager);

      // 3. 调用钉钉API发送消息
      response = await this.sendChatRequest(dialogId, message, cookies);
    } catch (error) {
      const authFailed = this.isAuthFailureError(error);
      const dialogInvalid = this.isDialogInvalidError(error);

      if (!authFailed && !dialogInvalid) {
        throw error;
      }

      if (authFailed) {
        console.error('[DingDing MCP] 检测到登录失效，触发自动登录重试');
        cookies = await this.authManager.loginWithBrowserAndCaptureCookie();
      }

      // 会话失效或登录后需重建会话（isDialogValid 不再探测，缓存会话可能已过期）
      if (dialogInvalid || authFailed || !attemptedRecovery) {
        attemptedRecovery = true;
        if (dialogInvalid) {
          this.sessionManager.resetCurrentWindow();
        }
        dialogId = await this.sessionManager.getOrCreateDialog(this.authManager);
        response = await this.sendChatRequest(dialogId, message, cookies);
      } else {
        throw error;
      }
    }

    return {
      content: [
        {
          type: 'text',
          text: response
        }
      ]
    };
  }

  /**
   * 处理 status 工具调用
   */
  async handleStatus() {
    const status = this.sessionManager.getCurrentWindowStatus();
    const cookieHealth = await this.authManager.getCookieHealth();

    const statusText = `📊 **DingDing MCP V2 状态报告**

**窗口信息:**
- 窗口ID: ${status.windowId}
- 会话状态: ${status.hasSession ? '✅ 已建立' : '❌ 未建立'}
${status.dialogId ? `- 会话ID: ${status.dialogId}` : ''}
${status.createdAt ? `- 创建时间: ${status.createdAt}` : ''}
${status.lastUsed ? `- 最后使用: ${status.lastUsed}` : ''}

**认证状态:**
- Cookie状态: ${cookieHealth.valid ? '✅ 有效' : '❌ 无效'}
- 当前来源: ${cookieHealth.source}
- 自动登录: ${this.config.cache?.auto_login !== false ? '✅ 启用' : '❌ 禁用'}

**配置信息:**
- 用户名: ${this.config.auth?.username}
- Agent名称: ${this.config.agent?.name || 'AI助手'}
- MCP 实例 tool_id: ${this.toolNames.toolId}
- Cookie有效期: ${this.config.cache?.cookie_ttl_hours || 24}小时

**使用提示:**
- 发送消息: 直接输入内容
- 重置会话: 使用 reset 工具
- 文件上传: 在消息中使用 @文件路径`;

    return {
      content: [
        {
          type: 'text',
          text: statusText
        }
      ]
    };
  }

  /**
   * 处理 reset 工具调用
   */
  async handleReset() {
    const oldDialogId = this.sessionManager.resetCurrentWindow();

    if (oldDialogId) {
      return {
        content: [
          {
            type: 'text',
            text: `✅ 当前窗口会话已重置\n\n` +
                  `原会话ID: ${oldDialogId}\n` +
                  `下次使用 chat 时将自动创建新会话。`
          }
        ]
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: `ℹ️ 当前窗口没有活跃会话\n\n` +
                  `下次使用 chat 时将自动创建新会话。`
          }
        ]
      };
    }
  }

  /**
   * 处理 mcp_auth 工具调用
   */
  async handleAuth() {
    const cookie = await this.authManager.loginWithBrowserAndCaptureCookie();
    if (cookie) {
      await this.authManager.getChatUserId(cookie);
    }
    const text = cookie
      ? `✅ 浏览器登录成功，已自动刷新Cookie并缓存 DEAP userId（来源: ${this.authManager.chatUserIdSource}）。`
      : '❌ 登录流程未完成，未获取到有效Cookie。';

    return {
      content: [
        {
          type: 'text',
          text
        }
      ]
    };
  }

  /**
   * 调用钉钉 chat.json API
   */
  async sendChatRequest(dialogId, message, cookies) {
    const runId = `local-${Date.now()}`;

    const response = await fetch(
      'https://deap.dingtalk.com/deapHttpProxy/chat/h5/runtime/api/chat.json',
      {
        method: 'POST',
        headers: {
          'accept': 'text/event-stream',
          'content-type': 'application/json',
          'cookie': cookies,
          'origin': 'https://deap.dingtalk.com',
          'referer': 'https://deap.dingtalk.com/',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
          'x-albert-chat-req': '1'
        },
        body: JSON.stringify({
          thread_id: '',
          message: message,
          run_id: runId,
          require_auth: false,
          dialogId: dialogId,
          agentCode: this.config.agent?.uuid,
          attachmentIds: [],
          customAttachments: [],
          localUserMessageId: runId,
          query: message
        })
      }
    );

    const responseText = await response.text();

    // 钉钉未登录/登录失效时会返回包含 loginUrl 的JSON，而不是SSE流
    if (responseText.includes('"loginUrl"') || responseText.includes('oauth2/auth')) {
      throw new AuthError('登录态失效，请重新登录');
    }

    // 解析SSE响应
    let content = '';
    const lines = responseText.split('\n');

    for (const line of lines) {
      if (line.startsWith('data:')) {
        const dataStr = line.substring(5).trim();
        if (!dataStr) continue;

        try {
          const data = JSON.parse(dataStr);

          // 提取delta字段
          if (data.delta && typeof data.delta === 'string') {
            content += data.delta;
          }

          // 检查错误
          if (data.success === false) {
            throw new Error(data.errorMsg || data.message || '请求失败');
          }
        } catch (e) {
          // JSON解析失败，忽略
        }
      }
    }

    if (!content) {
      // 如果没有解析到内容，返回原始响应供调试
      throw new Error(`无法解析响应，原始内容: ${responseText.substring(0, 200)}`);
    }

    return content;
  }

  /**
   * 启动服务器
   */
  async start() {
    if (!this.initialized) {
      await this.initialize();
    }

    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('[DingDing MCP] 已启动，等待请求...');
  }
}

// 主入口
async function main() {
  try {
    const server = new DingDingMCPServer();
    await server.start();
  } catch (error) {
    console.error('[DingDing MCP] 致命错误:', error);
    process.exit(1);
  }
}

// 启动
main();
