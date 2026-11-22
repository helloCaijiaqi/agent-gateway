// session-save 运行时专项（tool.call 统一改造：会话缓冲上移网关）。
//
// 取代旧 memory-ingest 调度器测试（service.call step=ingest + 窗口批量语义已删）。
// 覆盖：观察归一（入站 sender.names / 出站 assistant 无 senderId）、缺 msgId 跳过、
// 缓冲内去重、触顶分段（maxMessages/maxChars → partial save）、closeSession 收尾、
// flushAll 关停补发、崩溃恢复（撕裂行跳过 + 定时器恢复）、失败退避重试缓冲保留。
// 全离线：deliver 用假实现（等价于 tool.call chat_memory_save 的网关侧桩）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { createSessionSave, encodeSessionKey } = await import(new URL('../src/runtime/memory-ingest.mjs', import.meta.url).href);

const SESSION = 'qq:group:123';
const INBOUND = (msgId, text, extra = {}) => ({
  sessionKey: SESSION,
  envelope: { message: { id: msgId, text, sender: { id: '10001', name: 'Card', names: { nickname: '小明', card: '小明哥' }, ...extra.sender } }, receivedAt: 1_700_000_000_000, ...extra.envelope },
});

test('ingest: 入站/出站观察归一为 save 记录（sender.names 拆分；出站 assistant 无 senderId）；无文本跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => delivered.push(payload),
    bufferDir: dir, idleMs: 60_000, maxMessages: 500, maxChars: 100_000,
  });
  try {
    ss.start();
    ss.observeInbound(INBOUND('in:1', '今天部署了网关'));
    ss.observeInbound({ sessionKey: SESSION, envelope: { message: { id: 'in:2', text: '   ' } } }); // 空白跳过
    ss.observeInbound({ sessionKey: SESSION, envelope: { message: { id: 'in:3' } } }); // 无文本跳过
    ss.observeOutbound({ sessionKey: SESSION, tool: 'send_text', args: { content: '收到，已部署' }, msgId: 'out:t1:c1' });
    await ss.closeSession(SESSION);
    assert.equal(delivered.length, 1);
    const { messages, partial } = delivered[0];
    assert.equal(partial, false, 'closeSession = 会话收尾 save');
    assert.equal(messages.length, 2);
    const inbound = messages[0];
    assert.equal(inbound.msgId, 'in:1');
    assert.equal(inbound.senderId, '10001');
    assert.equal(inbound.nickname, '小明');
    assert.equal(inbound.card, '小明哥');
    assert.equal(inbound.text, '今天部署了网关');
    assert.equal(inbound.createdAt, 1_700_000_000_000);
    const outbound = messages[1];
    assert.equal(outbound.msgId, 'out:t1:c1');
    assert.equal(outbound.senderId, undefined, '出站是机器人自己发的：无 senderId');
    assert.equal(outbound.name, 'assistant');
    assert.equal(outbound.kind, 'assistant');
  } finally {
    ss.stop();
  }
});

test('ingest: 缺 msgId 跳过；同 msgId 重复观察去重（重放/多拦截点）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => delivered.push(payload),
    bufferDir: dir, idleMs: 60_000, maxMessages: 500, maxChars: 100_000,
  });
  try {
    ss.start();
    ss.observeInbound({ sessionKey: SESSION, envelope: { message: { text: 'no msgId' } } });
    ss.observeInbound(INBOUND('in:1', '第一条'));
    ss.observeInbound(INBOUND('in:1', '第二条不同内容')); // 同 msgId → 去重命中
    await ss.closeSession(SESSION);
    assert.equal(delivered[0].messages.length, 1, '去重按 (sessionKey, msgId)');
    assert.equal(delivered[0].messages[0].text, '第一条');
  } finally {
    ss.stop();
  }
});

test('ingest: 触顶分段（maxMessages / maxChars）→ partial save，缓冲清空继续累积', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => delivered.push(payload),
    bufferDir: dir, idleMs: 60_000, maxMessages: 3, maxChars: 100_000,
  });
  try {
    ss.start();
    for (let i = 1; i <= 4; i += 1) ss.observeInbound(INBOUND(`in:${i}`, `消息${i}`));
    await ss.flushAll();
    assert.equal(delivered.length, 2, '第 3 条触发分段 save（partial），第 4 条随 flushAll 落地');
    assert.equal(delivered[0].partial, true, '触顶分段标记 partial');
    assert.equal(delivered[0].messages.length, 3);
    assert.equal(delivered[1].messages.length, 1);
  } finally {
    ss.stop();
  }
});

test('ingest: save 成功后缓冲文件清理；save 失败缓冲保留（内存 + 磁盘）并退避重试', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const file = path.join(dir, `${encodeSessionKey(SESSION)}.jsonl`);
  let failFirst = true;
  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => {
      if (failFirst) throw new Error('memory service unavailable');
      delivered.push(payload);
    },
    bufferDir: dir, idleMs: 60_000, maxMessages: 500, maxChars: 100_000,
  });
  try {
    ss.start();
    ss.observeInbound(INBOUND('in:1', '第一条'));
    await ss.closeSession(SESSION);
    assert.equal(delivered.length, 0, '失败不产生成功计数');
    assert.ok(fs.existsSync(file), '失败后缓冲文件保留');

    failFirst = false;
    ss.retryDue(); // 手动触发重试兜底（运行时由 30s 轮询）
    await ss.flushAll();
    assert.equal(delivered.length, 1, '缓冲保留 → 重试成功');
    assert.equal(fs.existsSync(file), false, '成功后文件清理');
  } finally {
    ss.stop();
  }
});

test('ingest: 崩溃恢复——残留缓冲（含撕裂行）加载进内存并按空闲定时器补发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const file = path.join(dir, `${encodeSessionKey('qq:group:777')}.jsonl`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'meta', v: 1, sessionKey: 'qq:group:777' }),
    JSON.stringify({ msgId: 'in:1', senderId: '10001', text: '崩溃前第一条', createdAt: 1_700_000_000_000, kind: 'episodic' }),
    '{"msgId":"in:2","text":"撕裂行', // 进程崩溃的半行：跳过并计数
    '',
  ].join('\n'));

  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => delivered.push(payload),
    bufferDir: dir, idleMs: 300, maxMessages: 500, maxChars: 100_000,
  });
  try {
    ss.start();
    await new Promise((r) => setTimeout(r, 500)); // 恢复定时器到期 → 自动 save
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].sessionKey, 'qq:group:777');
    assert.equal(delivered[0].messages.length, 1, '撕裂行跳过，有效行全部恢复');
    assert.equal(delivered[0].messages[0].msgId, 'in:1');
    assert.ok(fs.existsSync(file) === false, '恢复后 save 成功 → 文件清理');
  } finally {
    ss.stop();
  }
});

test('ingest: 超长文本截断（maxChars/条）；observe 永不抛错、flushAll 等待在途 save', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => delivered.push(payload),
    bufferDir: dir, idleMs: 60_000, maxMessages: 500, maxChars: 200, maxMessageChars: 50,
  });
  try {
    ss.start();
    ss.observeInbound(INBOUND('in:1', 'x'.repeat(120)));
    await ss.closeSession(SESSION);
    const record = delivered[0].messages[0];
    assert.equal(record.text.length, 51, '单条截断到 maxMessageChars + 省略号');
    assert.ok(record.text.endsWith('…'));
  } finally {
    ss.stop();
  }
});

test('ingest: wake synthetic envelope - placeholder skipped, snapshot messages recorded (isSelf skipped / messageId dedupe / hash fallback)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-run-'));
  const delivered = [];
  const ss = createSessionSave({
    deliver: async (payload) => delivered.push(payload),
    bufferDir: dir, idleMs: 60_000, maxMessages: 500, maxChars: 100_000,
  });
  try {
    ss.start();
    const wakeEnvelope = {
      sessionKey: SESSION,
      envelope: {
        message: { id: 'wake-1700000000-1', text: '(placeholder)', sender: { id: '0', name: 'wake-scheduler' } },
        wake: { kind: 'new-message' },
        receivedAt: 1_700_000_010_000,
        snapshot: [
          { messageId: 'msg-100', userId: '398102999', sender: 'xiaofeiyu', text: 'call me xiaofeiyu', at: '2026-11-18 23:48' },
          { messageId: null, sender: 'xiaofeiyu', text: 'poke (no message id fallback entry)', userId: '398102999', at: '2026-11-18 23:49' },
          { messageId: 'msg-102', userId: '398102999', sender: 'xiaofeiyu', text: '(sent by myself)', at: '2026-11-18 23:49', isSelf: true },
        ],
      },
    };
    ss.observeInbound(wakeEnvelope);
    ss.observeInbound(wakeEnvelope);
    await ss.closeSession(SESSION);
    assert.equal(delivered.length, 1);
    const { messages } = delivered[0];
    assert.equal(messages.length, 2, 'placeholder skipped + isSelf skipped + duplicate snapshot deduped -> 2 user messages');
    assert.equal(messages.every((m) => m.senderId === '398102999'), true, 'senderId is the real QQ id');
    assert.equal(messages.every((m) => !String(m.msgId).startsWith('wake-')), true, 'placeholder id never recorded');
    assert.equal(messages[0].msgId, 'qq:msg-100', 'native messageId preferred');
    assert.equal(messages[1].msgId.startsWith('snap:'), true, 'entries without messageId fall back to content hash');
    assert.equal(messages[1].msgId.length, 'snap:'.length + 16, 'hash truncated to 16 hex chars');
    assert.equal(messages[0].name, 'xiaofeiyu', 'snapshot display name becomes name (alias source)');
  } finally {
    ss.stop();
  }
});
