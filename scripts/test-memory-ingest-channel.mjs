// 记忆服务选路与 save 通道契约（tool.call 统一改造）。
//
// 钉住三件事：
//   1. 目标服务按 memoryService:true 声明识别（selectMemoryService 三级：显式 env >
//      唯一声明 > 字典序首个 + 一次性告警），不再看 chat_memory_record 工具标记；
//   2. 网关投递的 save 请求形状（serviceToolCallSchema + context{senderId,text?}）能过严格契约；
//   3. decorator/filter 步骤结果的解析契约（decoratorResultSchema / filterResultSchema）。
import assert from 'node:assert/strict';
import test from 'node:test';

const { selectMemoryService, parsePipelineStepResult } = await import(new URL('../src/core/service-registry.mjs', import.meta.url).href);
const { parseServiceToolCall } = await import(new URL('../src/core/contracts.mjs', import.meta.url).href);

const MEMORY_SERVICE = {
  id: 'a'.repeat(32),
  enabled: true,
  memoryService: true,
  tools: ['chat_memory_get', 'chat_memory_save', 'chat_memory_recall'],
};
const ROLECARD_SERVICE = {
  id: 'b'.repeat(32),
  enabled: true,
  memoryService: false,
  tools: ['chat_role_list', 'chat_role_render'],
};

test('选择：唯一声明 memoryService 的服务被自动识别（对象权威 / 布尔兼容）', () => {
  // 权威形态 {saveTool}：saveTool 按声明动态返回（网关不再写死工具名）。
  const declared = { ...MEMORY_SERVICE, memoryService: { saveTool: 'chat_memory_save' } };
  assert.deepEqual(
    selectMemoryService([declared, ROLECARD_SERVICE]),
    { id: declared.id, saveTool: 'chat_memory_save' },
  );
  // 布尔旧形态：saveTool 退回 defaultSaveTool（组合根注入的存量缺省）+ 一次性迁移告警。
  const warnings = [];
  const legacyRoute = selectMemoryService(
    [MEMORY_SERVICE, ROLECARD_SERVICE],
    { defaultSaveTool: 'chat_memory_save', warn: (m) => warnings.push(m) },
  );
  assert.deepEqual(legacyRoute, { id: MEMORY_SERVICE.id, saveTool: 'chat_memory_save' });
  assert.match(warnings[0], /旧布尔形态/);
  // 布尔旧形态且无缺省：saveTool null（调用方按不可用处理）。
  assert.deepEqual(selectMemoryService([MEMORY_SERVICE, ROLECARD_SERVICE]), { id: MEMORY_SERVICE.id, saveTool: null });
});

test('选择：没有候选返回 null（服务未上线 → save 进退避重试，不是启动失败）', () => {
  assert.equal(selectMemoryService([ROLECARD_SERVICE]), null);
  assert.equal(selectMemoryService([]), null);
  assert.equal(selectMemoryService(undefined), null);
});

test('选择：多个候选 = 歧义，按 id 字典序取首个 + 一次性告警；显式 id 消歧', () => {
  const twin = { ...MEMORY_SERVICE, id: 'c'.repeat(32) };
  const warnings = [];
  const first = selectMemoryService([MEMORY_SERVICE, twin], { warn: (msg) => warnings.push(msg), defaultSaveTool: 'chat_memory_save' });
  assert.equal(first.id, MEMORY_SERVICE.id, 'a… < c… 字典序');
  assert.equal(warnings.length, 1, '一次性告警');
  assert.match(warnings[0], /memoryService/);
  // 同一候选集合第二次：不再告警（一次性）。
  selectMemoryService([MEMORY_SERVICE, twin], { warn: (msg) => warnings.push(msg), defaultSaveTool: 'chat_memory_save' });
  assert.equal(warnings.length, 1);

  // onAmbiguous='error'：宁报错也不猜。
  assert.throws(
    () => selectMemoryService([MEMORY_SERVICE, twin], { onAmbiguous: 'error', defaultSaveTool: 'chat_memory_save' }),
    /只保留一个服务的声明/,
  );
});

test('选择：禁用的登记服务不参与自动识别', () => {
  // 禁用的服务即使声明了 memoryService 也不参与自动识别。
  assert.equal(selectMemoryService([{ ...MEMORY_SERVICE, enabled: false }]), null);
});

test('选择：不再看 chat_memory_record 工具标记（旧口径退役）', () => {
  const legacy = { id: 'e'.repeat(32), enabled: true, tools: ['chat_memory_record', 'chat_memory_recall'] };
  assert.equal(selectMemoryService([legacy, ROLECARD_SERVICE]), null, '只看 memoryService 声明');
});

test('契约：session-save 的 save 请求合法（serviceToolCallSchema + context）', () => {
  const request = parseServiceToolCall({
    v: 1,
    callId: 'call-1',
    tool: 'chat_memory_save',
    args: {
      sessionKey: 'qq:group:123',
      messages: [{ msgId: 'in:01J', senderId: '10001', nickname: '小明', card: '小明哥', text: '今天聊了部署', createdAt: 1_700_000_000_000, kind: 'episodic' }],
      partial: false,
    },
    sessionKey: 'qq:group:123',
    context: { senderId: '10001' },
  });
  assert.equal(request.tool, 'chat_memory_save');
  assert.equal(request.args.messages[0].msgId, 'in:01J');
  assert.equal(request.context.senderId, '10001');
  assert.equal(request.context.text, undefined, 'context.text 仅 filter 下发（save/decorator 不带）');

  // 出站消息（assistant）无 senderId：context 可整体缺省。
  const minimal = parseServiceToolCall({
    v: 1,
    callId: 'call-2',
    tool: 'chat_memory_get',
    args: {},
    sessionKey: 'qq:private:1',
  });
  assert.equal(minimal.context, undefined);
});

test('契约：save 请求缺 sessionKey / 带未知键都拒绝（形状不许漂）', () => {
  assert.throws(() => parseServiceToolCall({
    v: 1, callId: 'c', tool: 'chat_memory_save', args: {}, sessionKey: 'qq:group:1', extra: 1,
  }), /Unrecognized key/);
});

test('契约：decorator/filter 步骤结果解析（改写与丢弃职责归 filter）', () => {
  const decorator = parsePipelineStepResult('decorator', {
    sections: [{ name: '画像', text: '【画像】' }], epoch: null,
  });
  assert.equal(decorator.epoch, null, 'null 是服务降级路径的既有表示，必须放行');
  assert.throws(
    () => parsePipelineStepResult('decorator', { verdict: 'pass', sections: [] }),
    /Unrecognized key/, 'decorator 无 verdict（改写/丢弃职责归 filter）',
  );

  const filter = parsePipelineStepResult('filter', { text: '***', reason: '敏感词' });
  assert.equal(filter.text, '***');
  assert.equal(filter.reason, '敏感词');
  assert.throws(
    () => parsePipelineStepResult('filter', { verdict: 'drop', reason: 'spam' }),
    /filterResult invalid/, 'filter 无 verdict 枚举：text 空串即丢弃（text 必填）',
  );
});
