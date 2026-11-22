/**
 * 会话定位（装配机器）：sessionKey 是 `platform:kind:conversationId`（3 段，旧）
 * 或 `platform:consumerId:kind:conversationId`（4 段，多消费端收编——会话绑消费
 * 端，contracts.sessionKeyOf 的格式）。tool 调用的 ctx 没有 target——会话身份
 * 只能从这里派生，模型不需要（也不应该）复述会话标识（tool-host 的设计前提）。
 */

/** 解析 sessionKey；坏格式返回 null，由调用方决定失败语义（绝不猜）。 */
export function parseSessionKey(sessionKey) {
  const raw = String(sessionKey ?? '');
  const parts = raw.split(':');
  if (parts.length === 3 && parts.every((part) => part.length > 0)) {
    return { platform: parts[0], consumerId: null, kind: parts[1], conversationId: parts[2] };
  }
  if (parts.length === 4 && parts.every((part) => part.length > 0)) {
    return { platform: parts[0], consumerId: parts[1], kind: parts[2], conversationId: parts[3] };
  }
  return null;
}

/**
 * 调用时的信封 target 派生：payload.key（`group:456`，跨会话操作）优先；
 * 显式 key 写坏了直接失败，不许静默回退到当前会话（等于把消息发错群）；
 * 都拿不到返回 null——猜一个会话是 Never。
 */
export function resolveTarget({ platform, sessionKey, payload }) {
  const explicitKey = typeof payload?.key === 'string' ? payload.key.trim() : '';
  if (explicitKey) {
    const match = /^([a-z]+):(.+)$/.exec(explicitKey);
    if (match && match[2]) return { platform, conversationId: match[2], kind: match[1] };
    return null;
  }
  const parsed = parseSessionKey(sessionKey);
  if (parsed && parsed.platform === platform) {
    return { platform, conversationId: parsed.conversationId, kind: parsed.kind };
  }
  return null;
}
