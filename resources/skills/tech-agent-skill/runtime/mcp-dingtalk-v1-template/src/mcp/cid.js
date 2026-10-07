/**
 * DEAP createDialog 的 cid 构造
 * 标准格式：{userId}:{agentUuid}
 */

function getCookieValue(cookieString, name) {
  if (!cookieString) return '';
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

function normalizeDeapUserId(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  const normalized = String(value).trim();
  if (!/^(?:\d+|ST\d+)$/i.test(normalized)) {
    throw new Error('DEAP 用户 ID 格式无效；应为纯数字或 ST+数字');
  }
  return normalized;
}

function resolveDeapUserId(_cookieString, authConfig = {}) {
  if (authConfig.chat_user_id !== undefined) {
    return normalizeDeapUserId(authConfig.chat_user_id);
  }
  if (authConfig.user_id !== undefined) {
    return normalizeDeapUserId(authConfig.user_id);
  }
  return '';
}

function buildDialogCid({ cookieString, authConfig = {}, agentUuid, chatUserId }) {
  if (authConfig.dialog_cid) {
    const explicitCid = String(authConfig.dialog_cid).trim();
    if (!/^(?:\d+|ST\d+):[^:]+$/i.test(explicitCid)) {
      throw new Error('dialog_cid 必须使用 {DEAP userId}:{agentUuid} 格式');
    }
    return explicitCid;
  }

  const userId = chatUserId !== undefined
    ? normalizeDeapUserId(chatUserId)
    : resolveDeapUserId(cookieString, authConfig);
  if (!userId) {
    throw new Error(
      '无法取得 DEAP 用户 ID；请配置 auth.chat_user_id，或重新执行 mcp_auth 自动获取'
    );
  }
  if (!agentUuid) {
    throw new Error('Agent UUID不能为空');
  }
  return `${userId}:${agentUuid}`;
}

function formatPermissionHint(errorMessage) {
  const text = String(errorMessage || '');
  if (
    text.includes('无此智能体使用权限') ||
    text.includes('使用权限') ||
    text.includes('请联系管理员')
  ) {
    return `${text}。请确认当前扫码账号已在 DEAP 智能体「使用范围」中。`;
  }
  return text;
}

module.exports = {
  getCookieValue,
  normalizeDeapUserId,
  resolveDeapUserId,
  buildDialogCid,
  formatPermissionHint
};
