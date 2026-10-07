const crypto = require('crypto');

function getCookieValue(cookieString, name) {
  if (!cookieString) return '';
  const match = String(cookieString).match(
    new RegExp(`(?:^|;\\s*)${name}=([^;]*)`)
  );
  return match ? decodeURIComponent(match[1]) : '';
}

function normalizeChatUserId(value) {
  if (value === undefined || value === null || value === '') return '';
  const normalized = String(value).trim();
  if (!/^(?:\d+|ST\d+)$/i.test(normalized)) {
    throw new Error('DEAP 用户 ID 格式无效；应为纯数字或 ST+数字');
  }
  return normalized;
}

function parseChatUserIdFromHtml(html) {
  const text = String(html || '');
  const patterns = [
    /["']?userid["']?\s*[:=]\s*["']?((?:ST)?\d+)["']?/i,
    /["']?user_id["']?\s*[:=]\s*["']?((?:ST)?\d+)["']?/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return normalizeChatUserId(match[1]);
  }
  return '';
}

function buildCookieIdentityKey(cookieString) {
  const identity = [
    getCookieValue(cookieString, 'account'),
    getCookieValue(cookieString, 'corp_id'),
    getCookieValue(cookieString, 'pub_uid')
  ].join('|');
  if (identity === '||') return '';
  return crypto.createHash('sha256').update(identity).digest('hex');
}

module.exports = {
  buildCookieIdentityKey,
  getCookieValue,
  normalizeChatUserId,
  parseChatUserIdFromHtml
};
