/**
 * 多 MCP 实例：为每个 stdio 进程生成全局唯一的工具名 / 服务名，避免模型在相同 tool 名之间误路由。
 */

/**
 * @param {object} config 已 merge 后的配置
 * @returns {string} 仅含 [a-z0-9_]，用作工具名后缀
 */
function resolveMcpToolId(config) {
  const raw = config.mcp?.tool_id;
  if (raw && String(raw).trim()) {
    return (
      String(raw)
        .trim()
        .replace(/[^a-z0-9_]/gi, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
        .toLowerCase() || 'agent'
    );
  }
  const uuid = config.agent?.uuid || 'default';
  return String(uuid.split('-')[0] || 'default').toLowerCase();
}

/**
 * @param {object} config
 * @returns {{ toolId: string, serverName: string, chat: string, status: string, reset: string, mcp_auth: string }}
 */
function buildToolNames(config) {
  const toolId = resolveMcpToolId(config);
  return {
    toolId,
    serverName: `dingding-mcp-v2-${toolId}`,
    chat: `chat_${toolId}`,
    status: `status_${toolId}`,
    reset: `reset_${toolId}`,
    mcp_auth: `mcp_auth_${toolId}`
  };
}

module.exports = { resolveMcpToolId, buildToolNames };
