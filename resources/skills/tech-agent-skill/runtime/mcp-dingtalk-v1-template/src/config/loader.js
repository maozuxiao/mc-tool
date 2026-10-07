/**
 * ConfigLoader - 配置加载器
 * 负责读取和验证用户配置文件
 */

const fs = require('fs');
const path = require('path');
const { z } = require('zod');

/**
 * 若当前配置含 _merge_auth_from，则从该路径加载 JSON，与其合并后再校验。
 * - auth：以主文件为覆盖层（通常主文件不写 auth，则完全使用引用文件的登录态）
 * - agent / cache.features：主文件优先
 * - _drop_inherited_session 为 true 时：不继承引用文件中的 session（避免共用 default_dialog_id）
 */
function mergeAuthFromReference(rawConfig, configFilePath) {
  const ref = rawConfig._merge_auth_from;
  if (!ref || typeof ref !== 'string') {
    return rawConfig;
  }

  const basePath = path.isAbsolute(ref)
    ? ref
    : path.resolve(path.dirname(configFilePath), ref);

  if (!fs.existsSync(basePath)) {
    throw new ConfigError(
      `_merge_auth_from 指向的文件不存在: ${basePath}\n` +
        `当前配置: ${configFilePath}`
    );
  }

  let baseRaw;
  try {
    baseRaw = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  } catch (error) {
    throw new ConfigError(
      `_merge_auth_from 文件 JSON 解析失败: ${basePath}\n${error.message}`
    );
  }

  const dropSession = rawConfig._drop_inherited_session === true;
  const overlay = { ...rawConfig };
  delete overlay._merge_auth_from;
  delete overlay._drop_inherited_session;

  const merged = {
    ...baseRaw,
    ...overlay,
    auth: { ...(baseRaw.auth || {}), ...(overlay.auth || {}) },
    agent: overlay.agent !== undefined && overlay.agent !== null
      ? overlay.agent
      : baseRaw.agent,
    cache: { ...(baseRaw.cache || {}), ...(overlay.cache || {}) },
    features: { ...(baseRaw.features || {}), ...(overlay.features || {}) },
    mcp: overlay.mcp !== undefined && overlay.mcp !== null
      ? overlay.mcp
      : baseRaw.mcp
  };

  if (dropSession) {
    delete merged.session;
  }

  return merged;
}

// 配置Schema定义（使用Zod进行验证）
// 只支持Cookie方式（账号密码方案已废弃）
const ConfigSchema = z.object({
  auth: z.object({
    cookie_string: z.string().min(1, 'Cookie字符串不能为空').optional(),
    corp_id: z.string().optional(),
    chat_user_id: z.string().regex(/^(?:\d+|ST\d+)$/i, 'chat_user_id 必须为纯数字或 ST+数字').optional(),
    user_id: z.string().optional(),
    dialog_cid: z.string().optional()
  }),
  agent: z.object({
    uuid: z.string().min(1, 'Agent UUID不能为空'),
    name: z.string().optional().default('AI助手')
  }),
  cache: z.object({
    cookie_path: z.string().optional(),
    session_path: z.string().optional()
  }).optional().default({}),
  features: z.object({
    file_upload: z.boolean().optional().default(true),
    max_file_size_mb: z.number().min(1).max(500).optional().default(50),
    supported_formats: z.array(z.string()).optional().default(['txt', 'md', 'pdf', 'docx', 'png', 'jpg', 'jpeg'])
  }).optional().default({}),
  mcp: z.object({
    tool_id: z.string().min(1, 'mcp.tool_id 不能为空').optional()
  }).optional()
}).passthrough();  // 允许额外的字段

class ConfigLoader {
  constructor() {
    this.configPath = this.getConfigPath();
    this.config = null;
    this.lastConfigPath = null;  // 用于检测配置路径变化
  }

  /**
   * 获取配置文件路径
   * 优先级: 1. 环境变量 DINGDING_CONFIG_PATH > 2. 默认路径
   * 支持Windows和Mac
   */
  getConfigPath() {
    // 优先从环境变量读取
    if (process.env.DINGDING_CONFIG_PATH) {
      return process.env.DINGDING_CONFIG_PATH;
    }
    
    const homeDir = process.platform === 'win32' 
      ? process.env.USERPROFILE 
      : process.env.HOME;
    
    if (!homeDir) {
      throw new Error('无法获取用户目录，请检查环境变量');
    }
    
    return path.join(homeDir, '.dingding-mcp', 'config.json');
  }

  /**
   * 获取缓存目录路径
   */
  getCacheDir() {
    const homeDir = process.platform === 'win32'
      ? process.env.USERPROFILE
      : process.env.HOME;
    return path.join(homeDir, '.dingding-mcp', '.cache');
  }

  /**
   * 加载配置文件
   * @param {boolean} force - 强制重新加载
   * @returns {Object} 配置对象
   */
  load(force = false) {
    // 如果配置路径变化，强制重新加载
    if (this.lastConfigPath !== this.configPath) {
      force = true;
      this.lastConfigPath = this.configPath;
    }
    
    // 如果已有缓存且不是强制加载，直接返回
    if (this.config && !force) {
      return this.config;
    }
    
    // 检查配置文件是否存在
    if (!fs.existsSync(this.configPath)) {
      throw new ConfigError(
        `配置文件不存在: ${this.configPath}\n\n` +
        `请创建配置文件，步骤如下:\n` +
        `1. 创建目录: ${path.dirname(this.configPath)}\n` +
        `2. 创建文件 config.json，内容示例:\n` +
        this.getExampleConfig()
      );
    }

    // 读取文件内容
    let fileContent;
    try {
      fileContent = fs.readFileSync(this.configPath, 'utf8');
    } catch (error) {
      throw new ConfigError(`读取配置文件失败: ${error.message}`);
    }

    // 解析JSON
    let rawConfig;
    try {
      rawConfig = JSON.parse(fileContent);
    } catch (error) {
      throw new ConfigError(`配置文件JSON格式错误: ${error.message}`);
    }

    // 从另一文件合并 auth（及可选默认项），实现多 MCP 实例共用同一登录账号与 Cookie，无需复制 cookie_string
    rawConfig = mergeAuthFromReference(rawConfig, this.configPath);

    // 验证配置
    try {
      this.config = ConfigSchema.parse(rawConfig);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const issues = error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new ConfigError(`配置验证失败:\n${issues}`);
      }
      throw error;
    }

    // 处理默认路径
    this.applyDefaultPaths();

    return this.config;
  }

  /**
   * 应用默认路径
   */
  applyDefaultPaths() {
    const cacheDir = this.getCacheDir();
    
    if (!this.config.cache.cookie_path) {
      this.config.cache.cookie_path = path.join(cacheDir, 'cookies.json');
    }
    
    if (!this.config.cache.session_path) {
      this.config.cache.session_path = path.join(cacheDir, 'sessions.json');
    }

    // 确保缓存目录存在
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  }

  /**
   * 获取配置项
   * @param {string} key - 配置键，支持点号分隔如 'auth.username'
   * @returns {any} 配置值
   */
  get(key) {
    // 检测配置路径变化或缓存为空，需要重新加载
    if (this.lastConfigPath !== this.configPath || !this.config) {
      this.load();
    }
    
    const keys = key.split('.');
    let value = this.config;
    
    for (const k of keys) {
      value = value?.[k];
      if (value === undefined) return undefined;
    }
    
    return value;
  }

  /**
   * 获取完整配置
   * @returns {Object} 配置对象
   */
  getConfig() {
    if (!this.config) {
      this.load();
    }
    return this.config;
  }

  /**
   * 获取示例配置文本（Cookie方式）
   */
  getExampleConfig() {
    return `{
  "_comment": "DingDing MCP V2 配置文件 - 首次启动后调用 mcp_auth 扫码登录",
  "_how_to_login": "调用当前机器人实例的 mcp_auth，在弹出的钉钉页面完成登录；MCP 会自动保存登录态",
  
  "auth": {
    "corp_id": "ding6d9605c0b6ce935f",
    "chat_user_id": "100032289"
  },
  "agent": {
    "uuid": "f55812e8-67da-4d0f-97ff-079b069bae69",
    "name": "技术助手"
  }
}`;
  }

  /**
   * 创建示例配置文件
   */
  createExample() {
    const configDir = path.dirname(this.configPath);
    
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const examplePath = path.join(configDir, 'config.example.json');
    fs.writeFileSync(examplePath, this.getExampleConfig());
    
    return examplePath;
  }
}

/**
 * 配置错误类
 */
class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

module.exports = { ConfigLoader, ConfigError };

// 如果直接运行此文件，执行测试
if (require.main === module) {
  console.log('=== ConfigLoader 测试 ===\n');
  
  const loader = new ConfigLoader();
  
  console.log('配置文件路径:', loader.getConfigPath());
  console.log('缓存目录:', loader.getCacheDir());
  console.log('\n示例配置:\n', loader.getExampleConfig());
  
  try {
    const config = loader.load();
    console.log('\n✅ 配置加载成功');
    console.log('用户名:', config.auth.username);
    console.log('Agent UUID:', config.agent.uuid);
    console.log('Cookie缓存路径:', config.cache.cookie_path);
  } catch (error) {
    console.log('\n❌ 配置加载失败:', error.message);
  }
}
