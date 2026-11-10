/**
 * V2 P2 管线引擎（core）：纯通用编排器——通路（forward）步骤的确定性执行。
 *
 * 职责边界（docs/design/GATEWAY_V2_REFACTOR.md §1/§3，读它再读这里）：
 *  - 步骤两类：**内置**（main.mjs 注入的步骤对象；P3 转正后仅剩强制殿后的
 *    protocol）与**外部**（登记的 decorator/filter/shadow，经 service-registry
 *    调用；装饰器能力由登记工具声明 roles 承载）。本文件不认识任何具体步骤名，
 *    core 无平台/服务名（test-layering 钉住）。
 *  - 只作用于「网关 ↔ DSH」之间的消息：入口 text 是入站 prompt（适配器终稿 /
 *    合成事件文案 / 兜底文案，由调用方先解析好），出口 text 交给 dsh.prompt。
 *    消费者入站信封与 DSH 事件流协议不变。
 *  - 每个外部步骤一个入口一个出口：verdict=drop 短路（turn 按「无消息」处理，
 *    幂等键不变）；decorator 的 message 改写当前 text、sections 追加具名文本块。
 *  - fail-safe：外部步骤超时/非法响应/抛错一律记 degraded **继续**——宁放行
 *    不误杀；内置步骤 build 抛错同口径（与 context-assembler 语义一致）。
 *
 * 组装规则（确定性，测试钉住）：
 *  1. 步骤按编排顺序串行执行（顺序敏感，不做 priority 重排——重排是 assembler
 *     的旧语义；管线的表达力就是顺序本身）；
 *  2. protocol 步骤强制最后执行且不可被配置移除（安全凭据，不变量 §5.2）；
 *  3. 最终 prompt = 管线 text（消息本体）+ sections（按 priority 降序、name 升序），
 *     `\n\n` 分隔；预算超限**整段丢弃**最低优先级 section（半段人格比没人格糟），
 *     消息本体永不参与裁剪，丢弃记入 result.dropped。
 *
 * 注入规则引擎（P4.x，编排条目双形态中的对象条目）：
 *  - 本地静态步骤（条目带 text）：内容直接来自编排配置，零服务调用——
 *    供料语义，join 缺省 'suffix'（与 sections 追加同向）。
 *  - 外部步骤配置 join：装饰器产出（message ?? sections 文本）视为 extra，
 *    引擎接管拼接（prefix/suffix 加 `\n\n` 分隔、regex 以 {extra} 占位替换、
 *    function 调用 (message, extra) => string）——「供料型装饰器 + 编排规则」。
 *  - once：仅会话首轮执行（isFirstTurnOfSession 由调用方传入，判定数据源是
 *    turn store 会话历史，归网关不归服务）。非首轮整个步骤跳过（不调服务）。
 *  - ctx 透传：首轮时 serviceCallRequest 带 firstTurn:true——加工型装饰器
 *    可据此自治实现 once（契约不降级：消息进消息出仍是装饰器定义）。
 *  - 规则编译随条目对象缓存（WeakMap，热加载换装后自然失效）；函数/正则
 *    运行期异常 fail-safe：记 degraded 保留当前文本，不中断管线。
 *
 * runForward/runReturn 永不抛错：失败返回 { ok:false, ... }，调用方回退原文。
 * 回路（return：DSH 产出 → 消费者）与通路共用同一套步骤循环（P5 抽取的
 * runChain），差异面只有三处：编排来源（pipelineForReturn）、protocol 只在
 * forward 强制殿后（令牌只在入站有意义）、serviceCallRequest 带 direction。
 * 回路的调用方是 deliverAction（发送动作外发文本过链）：verdict=drop = 拦截
 * 投递；text = 改写后的外发文本。
 */
import { randomUUID } from 'node:crypto';

const PROTOCOL_STEP = 'protocol';
const JOIN_SEPARATOR = '\n\n';

/** 会话令牌行：管线 protocol 内置步骤的唯一文案来源（安全凭据注入，永不外委）。 */
export function protocolTokenLine(turnToken) {
  return `【会话令牌】${turnToken}（调用 chat_* 工具时请在 turnToken 参数中带上）`;
}

// ── 注入规则（P4.x）──────────────────────────────────────────────────────────
// 编排条目双形态：字符串（纯步骤名）或规则对象。registry 侧已做 fail-closed
// 校验（normalizePipelineStepEntry）；引擎侧只做防御性归一 + 编译缓存——
// 按原始条目对象为键（热加载换装后对象身份更替，缓存自然失效）。

function entryShape(entry) {
  if (typeof entry === 'string') return { name: entry, once: false, join: undefined, text: undefined };
  const isStatic = entry?.text !== undefined;
  return {
    name: typeof entry?.step === 'string' ? entry.step : undefined,
    once: entry?.once === true,
    // 静态供料条目的 join 缺省 'suffix'（与 sections 追加同向，registry 校验同口径）。
    join: entry?.join ?? (isStatic ? 'suffix' : undefined),
    text: isStatic ? entry.text : undefined,
  };
}

/** 把 extra 拼进当前消息（供料语义；extra 为空 = 无操作，避免孤分隔符）。
 *  rule = compiledRule 产物：join/text 在 shape 里，re/fn/replacement 在顶层。 */
function applyJoin(rule, current, extra) {
  const { join, re, replacement, fn } = {
    join: rule.shape.join,
    re: rule.re,
    replacement: rule.replacement,
    fn: rule.fn,
  };
  const fill = String(extra ?? '');
  if (join === 'prefix') return fill ? `${fill}${JOIN_SEPARATOR}${current}` : current;
  if (join === 'suffix') return fill ? `${current}${JOIN_SEPARATOR}${fill}` : current;
  if (join === 'regex') {
    // 函数形式替换：replacement 里的 {extra} 先行填充，$ 序列不二次解释。
    return current.replace(re, () => String(replacement).split('{extra}').join(fill));
  }
  if (join === 'function') {
    const out = fn(current, fill);
    if (typeof out !== 'string') throw new Error('join function must return a string');
    return out;
  }
  return current;
}

export function createPipeline({
  registry = null,
  /** name → { name, priority?, build(ctx) }（内置步骤，main.mjs 注入） */
  builtinSteps = {},
  budgetChars = 6000,
  logger = () => {},
  metrics = null,
  now = Date.now,
  newCallId = randomUUID,
} = {}) {
  /**
   * 步骤名解析（三级）：内置优先；其次已登记外部服务 id；最后装饰器/过滤器
   * 角色的登记工具名（工具即步骤——recall 既是模型可调的工具，也是可编排的
   * 装饰器，见 contracts.mjs SERVICE_TOOL_ROLES）。未知 = 配置错误。
   */
  function resolveStep(name) {
    const builtin = builtinSteps[name];
    if (builtin) return { type: 'builtin', name, step: builtin };
    const service = registry?.resolveService?.(name) ?? null;
    if (service) return { type: 'external', name, service };
    const toolStep = registry?.resolveToolStep?.(name) ?? null;
    if (toolStep) return { type: 'external', name, service: toolStep.service };
    throw new Error(`unknown pipeline step "${name}" (not a builtin step, registered service, or decorator/filter tool)`);
  }

  /** 规则编译缓存：原始条目对象 → { shape, re?, fn? }（WeakMap，换装自然失效）。
   *  字符串条目无规则可编译，直接归一（WeakMap 键必须是对象）。 */
  const ruleCache = new WeakMap();
  function compiledRule(entry) {
    if (typeof entry === 'string') return { shape: entryShape(entry), re: null, fn: null };
    let compiled = ruleCache.get(entry);
    if (!compiled) {
      const shape = entryShape(entry);
      compiled = { shape, re: null, fn: null, replacement: undefined };
      if (shape.join === 'regex') {
        compiled.re = new RegExp(entry.pattern, typeof entry.flags === 'string' ? entry.flags : 'g');
        compiled.replacement = entry.replacement;
      }
      if (shape.join === 'function') compiled.fn = new Function('message', 'extra', entry.fn);
      ruleCache.set(entry, compiled);
    }
    return compiled;
  }

  // ── 会话纪元 block 缓存（§6.4：召回只在会话首轮注入一次）──────────────────
  // 键 (sessionKey, subjectId) → { epoch, sent:Set<kind:name> }。同 epoch 已
  // 注入过的 block 不重发；epoch 变了（服务端判定静默失活 → 新会话）全量重发。
  // LRU 有界（256 会话）：淘汰后重发幂等无害——服务端始终返回，多注入一次不丢数据。
  const identityCache = new Map();
  const IDENTITY_CACHE_MAX = 256;
  function identitySendBlocks(sessionKey, subjectId, epoch, blocks) {
    const key = `${sessionKey}\u0000${subjectId}`;
    const cached = identityCache.get(key);
    const sent = cached && cached.epoch === epoch ? cached.sent : new Set();
    const pending = blocks.filter((block) => typeof block?.text === 'string'
      && block.text.length > 0
      && !sent.has(`${block.kind ?? ''}:${block.name}`));
    for (const block of pending) sent.add(`${block.kind ?? ''}:${block.name}`);
    // 触底刷新（命中即最新）；超限淘汰最旧（Map 迭代序 = 插入序）。
    identityCache.delete(key);
    identityCache.set(key, { epoch, sent });
    while (identityCache.size > IDENTITY_CACHE_MAX) {
      identityCache.delete(identityCache.keys().next().value);
    }
    return pending;
  }

  /** 装配期校验（main.mjs 启动时调用）：把 pipelines.json 的编排错误挡在启动阶段。
   *  P5：回路编排同口径校验（步骤三级解析 + 拒内置步骤——protocol 已在 registry
   *  层拒，这里兜底其余内置名）。 */  function validate(consumerIds = []) {
    const keys = new Set([...(registry?.pipelineKeys?.() ?? []), ...consumerIds]);
    for (const key of keys) {
      for (const entry of registry?.pipelineFor?.(key) ?? []) {
        const shape = entryShape(entry); // 抛错 = 启动失败（fail-closed，与 adapters.json 同口径）
        if (typeof entry !== 'string' && shape.text !== undefined) continue; // 本地静态步骤不做三级解析
        resolveStep(shape.name);
      }
    }
    const returnKeys = new Set([...(registry?.returnPipelineKeys?.() ?? []), ...consumerIds]);
    for (const key of returnKeys) {
      for (const entry of registry?.pipelineForReturn?.(key) ?? []) {
        const shape = entryShape(entry);
        if (typeof entry !== 'string' && shape.text !== undefined) continue;
        const resolved = resolveStep(shape.name);
        if (resolved.type === 'builtin') {
          throw new Error(`builtin step "${shape.name}" is forward-only and must not appear in a return pipeline`);
        }
      }
    }
  }

  /**
   * 共享链执行器（P5 抽取）：forward（consumer → DSH）与 return（DSH → consumer）
   * 两方向共用的步骤循环——once 跳过 / 本地静态供料 / join 规则接管 / 预算裁剪 /
   * fail-safe degraded 全套语义一致。差异面（测试钉住）：
   *  - 编排来源：pipelineFor vs pipelineForReturn（registry 校验层已拒回路配 protocol）；
   *  - protocol 内置步骤只在 forward 强制殿后（安全凭据，不变量 §5.2）；return
   *    方向防御性拒绝任何内置步骤（回路链只有外部服务/静态供料步骤）；
   *  - serviceCallRequest 带 direction（服务可感知方向；缺省 forward，既有服务无感）。
   *
   * @param {object} input
   * @param {'forward'|'return'} input.direction 管线方向
   * @param {string} input.consumerId  消费者 id（管线编排键；未编排 = 透传）
   * @param {string} input.sessionKey
   * @param {string} [input.turnId]
   * @param {string} [input.turnToken] protocol 步骤注入（仅 forward；安全凭据，永不外委）
   * @param {object} [input.envelope]  入站信封（内置步骤的数据源，仅 forward）
   * @param {string} [input.text]      管线消息本体的初始值（forward=入站 prompt；
   *   return=发送动作外发文本）
   * @param {boolean} [input.isFirstTurnOfSession] 会话首轮判定（调用方经 turn store
   *   得出——首轮判定归网关）。once 规则与外部步骤 ctx.firstTurn 的数据源。
   * @param {number} [input.budgetChars]
   * @returns {Promise<object>} { ok, verdict, text, chars, sections, steps, degraded, dropped, reason? }
   */
  async function runChain({
    direction = 'forward',
    consumerId,
    sessionKey,
    turnId,
    turnToken,
    envelope = {},
    text = '',
    isFirstTurnOfSession = false,
    budgetChars: budgetOverride,
    now: at = now(),
  } = {}) {
    const budget = Number.isSafeInteger(budgetOverride) && budgetOverride >= 0
      ? budgetOverride : budgetChars;
    const base = { ok: true, verdict: 'pass', sections: [], steps: [], degraded: false, dropped: [] };

    // 「在和谁对话」：subject = 入站消息发送者（§6.4 按对象召回）。群聊里每个
    // 新 subject 各有自己的 identity 缓存键；单聊无 sender.id 时退化为会话级。
    const senderId = direction === 'forward'
      ? String(envelope?.message?.sender?.id ?? '')
      : '';

    if (!consumerId) return { ...base, ok: false, text: String(text ?? ''), error: 'consumerId required' };

    const configured = direction === 'return'
      ? (registry?.pipelineForReturn?.(consumerId) ?? [])
      : (registry?.pipelineFor?.(consumerId) ?? []);
    const firstTurn = isFirstTurnOfSession === true;
    // 编排为空 = prompt 透传（与旧 GATEWAY_CONTEXT=off 行为等价）——但 protocol
    // 令牌仍然强制注入：turnToken 是工具调用的凭据，不属于「装饰」。
    let steps;
    try {
      steps = configured
        .filter((entry) => (typeof entry === 'string' ? entry : entry?.step) !== PROTOCOL_STEP)
        .map((entry) => {
          const rule = compiledRule(entry);
          if (rule.shape.text !== undefined) {
            return { type: 'static', name: rule.shape.name, rule }; // 本地静态供料步骤
          }
          const resolved = resolveStep(rule.shape.name);
          if (direction === 'return' && resolved.type === 'builtin') {
            // 防御性拒绝：内置步骤是入站概念（protocol 令牌/信封数据源），
            // registry 校验层已拒 protocol——这里是兜底（fail-closed → 透传）。
            throw new Error(`builtin step "${rule.shape.name}" is forward-only and must not appear in a return pipeline`);
          }
          return { ...resolved, rule };
        });
      if (direction === 'forward' && builtinSteps[PROTOCOL_STEP]) steps.push({ type: 'builtin', name: PROTOCOL_STEP, step: builtinSteps[PROTOCOL_STEP], rule: null });
    } catch (error) {
      // 配置错误到不了这里（validate 在启动时挡了）；防御性兜底：透传 + degraded。
      logger(`pipeline config error (${consumerId}): ${error?.message ?? error}`);
      return { ...base, ok: false, text: String(text ?? ''), degraded: true, error: String(error?.message ?? error) };
    }

    let current = String(text ?? '');
    const collected = []; // { name, text, priority, from }
    const summaries = [];
    let degraded = false;
    let dropReason = null;

    for (const resolved of steps) {
      const summary = { name: resolved.name, type: resolved.type };
      summaries.push(summary);

      // once 规则：非首轮整个步骤跳过（供料型不调服务；protocol 内置不带规则）。
      if (resolved.rule?.shape.once === true && !firstTurn) {
        summary.outcome = 'skipped-once';
        continue;
      }

      if (resolved.type === 'static') {
        // 本地静态供料步骤：extra = 编排配置文本（join 缺省 'suffix'，registry
        // 校验已保证非空）。函数 join 抛错同外部步骤口径：degraded 保留原文。
        try {
          const before = current;
          current = applyJoin(resolved.rule, current, resolved.rule.shape.text);
          summary.outcome = current === before ? 'absent' : 'injected';
        } catch (error) {
          logger(`pipeline static step ${resolved.name} failed: ${error?.message ?? error}`);
          summary.outcome = 'degraded';
          degraded = true;
        }
        continue;
      }

      if (resolved.type === 'builtin') {
        let outcome = null;
        try {
          outcome = await resolved.step.build({ sessionKey, envelope, now: at, deps: { turnToken } });
        } catch (error) {
          logger(`pipeline builtin step ${resolved.name} failed: ${error?.message ?? error}`);
          outcome = { text: '', degraded: true };
        }
        const stepText = typeof outcome?.text === 'string' ? outcome.text : '';
        summary.outcome = outcome?.degraded === true ? 'degraded' : (stepText ? 'included' : 'absent');
        if (outcome?.degraded === true) degraded = true;
        if (stepText) {
          collected.push({
            name: resolved.name,
            text: stepText,
            priority: outcome.priority ?? resolved.step.priority ?? 0,
            from: resolved.name,
          });
        }
        continue;
      }

      // ── 外部步骤：service.call（契约与 fail-safe 语义见文件头）────────────
      const { service } = resolved;
      const request = {
        v: 1,
        callId: newCallId(),
        service: service.id,
        step: resolved.name,
        kind: service.kind,
        sessionKey,
        turnId,
        senderId, // §6.4 按对象召回：记忆服务以它识别 identity（画像/关系）的 subject
        text: current,
        direction, // P5：服务可感知方向（forward/return），既有服务无感（schema 缺省 forward）
      };
      if (firstTurn) request.firstTurn = true; // 加工型装饰器的自治 once 依据（契约不降级）
      let result;
      try {
        result = await registry.callService(service.id, request);
      } catch (error) {
        logger(`pipeline service "${service.id}" call failed: ${error?.message ?? error}`);
        summary.outcome = 'degraded';
        degraded = true;
        metrics?.inc('gateway_pipeline_step_total', { outcome: 'degraded' });
        continue; // 宁放行不误杀
      }
      metrics?.inc('gateway_pipeline_step_total', { outcome: 'ok' });

      if (result.verdict === 'drop') {
        summary.outcome = 'drop';
        dropReason = result.reason ?? '';
        logger(`pipeline step "${resolved.name}" dropped the message${result.reason ? `: ${result.reason}` : ''}`);
        return {
          ...base,
          verdict: 'drop',
          reason: dropReason,
          steps: summaries,
          degraded,
          text: current,
        };
      }

      if (service.kind === 'shadow') {
        // shadow 步骤：只记录 diff，不应用（灰度验收期语义，§3）。
        const same = (result.message ?? current) === current;
        metrics?.inc('gateway_pipeline_shadow_total', { diff: same ? 'same' : 'diff' });
        if (!same) logger(`pipeline shadow "${service.id}" diff: proposed=${(result.message ?? '').length}c current=${current.length}c`);
        summary.outcome = same ? 'shadow-same' : 'shadow-diff';
        continue;
      }

      if (service.kind === 'filter' && (result.message !== undefined || (result.sections ?? []).length > 0)) {
        // filter 只表达放行/丢弃；带内容属于契约误用，忽略并提醒（不放行内容等于放行）。
        logger(`pipeline filter "${service.id}" returned content but kind=filter, ignored`);
      }
      if (service.kind === 'decorator') {
        // 会话纪元契约（§6.4）：响应带 epoch = 记忆服务的多 block 注入。服务端
        // 每次都幂等返回全部 block + epoch；网关按 (sessionKey, subjectId, epoch)
        // 去重——同 epoch 已注入过的 block 不重发，实现「会话首轮注入一次」。
        // 缓存 LRU 淘汰 / 网关重启后重发是幂等无害的（at-least-once 接收 +
        // 去重 = exactly-once 注入；多注入一次也不丢数据）。
        const epochBlocks = Number.isSafeInteger(result.epoch)
          ? identitySendBlocks(sessionKey, senderId, result.epoch, result.sections ?? [])
          : null;
        if (resolved.rule?.shape.join) {
          // 供料型 + 编排规则（P4.x）：装饰器产出（message 优先，缺省取
          // sections 文本）视为 extra，引擎接管拼接——sections 不再单独收集。
          const extra = typeof result.message === 'string' && result.message.length > 0
            ? result.message
            : (epochBlocks ?? result.sections ?? []).map((section) => section.text).filter(Boolean).join(JOIN_SEPARATOR);
          try {
            current = applyJoin(resolved.rule, current, extra);
            summary.outcome = 'injected';
          } catch (error) {
            logger(`pipeline step "${resolved.name}" join rule failed: ${error?.message ?? error}`);
            summary.outcome = 'degraded';
            degraded = true;
          }
        } else if (typeof result.message === 'string') {
          current = result.message;
          summary.outcome = 'rewritten';
        } else {
          summary.outcome = 'pass';
        }
        // join 规则接管时 sections 已并入 extra（经 applyJoin 进消息本体），
        // 不再重复收集——否则同一内容注入两遍。
        if (!resolved.rule?.shape.join) {
          for (const section of epochBlocks ?? result.sections ?? []) {
            collected.push({
              name: section.name,
              text: section.text,
              priority: section.priority ?? 0,
              from: service.id,
            });
          }
        }
      }
    }

    // ── 组装：消息本体 + sections（priority 降序、name 升序）＋ 预算裁剪 ──────
    collected.sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0)
      || String(a.name).localeCompare(String(b.name)));
    let total = current.length + collected.reduce((sum, item) => sum + item.text.length + 2, 0);
    for (let i = collected.length - 1; i >= 0 && total > budget; i -= 1) {
      total -= collected[i].text.length + 2;
      if (!base.dropped.includes(collected[i].name)) base.dropped.push(collected[i].name);
      collected.splice(i, 1);
    }
    if (base.dropped.length) {
      logger(`pipeline budget ${budget} exceeded, dropped: ${base.dropped.join(', ')}`);
    }

    const finalText = [current, ...collected.map((item) => item.text)]
      .filter((part) => part.length > 0)
      .join('\n\n');
    for (const item of collected) {
      base.sections.push({ name: item.name, chars: item.text.length, from: item.from, included: true });
    }
    for (const summary of summaries) {
      if (summary.outcome === 'degraded') degraded = true;
    }

    return {
      ...base,
      text: finalText,
      chars: finalText.length,
      steps: summaries,
      degraded,
    };
  }

  /** 通路执行（consumer → DSH）：共享链执行器的 forward 面。 */
  function runForward(input = {}) {
    return runChain({ ...input, direction: 'forward' });
  }

  /**
   * 回路执行（P5，DSH 产出 → 消费者）：共享链执行器的 return 面。
   * 调用方 = deliverAction（发送动作到达适配器前）：
   *  - text 入参 = 动作外发文本（payload.text）；
   *  - verdict='drop' = 拦截该动作的投递（调用方不发、回执按成功处理）；
   *  - text 出参 = 改写后的外发文本（调用方替换 payload.text）；
   *  - degraded = 步骤失败但保留原文（宁放行不误杀，照常投递原文）。
   * 形状与 runForward 一致；无 protocol 注入。
   */
  function runReturn(input = {}) {
    return runChain({ ...input, direction: 'return' });
  }

  /** 健康视图（/v1/health 经 main.mjs 的 runtime.pipelineStatus 暴露）。 */
  function status() {
    return {
      budgetChars,
      pipelines: registry?.pipelineKeys?.() ?? [],
      returnPipelines: registry?.returnPipelineKeys?.() ?? [],
      services: registry?.services?.() ?? [],
      builtinSteps: Object.keys(builtinSteps),
      // P5：回路引擎已接通（runReturn 真执行；off 回滚开关仍是 GATEWAY_PIPELINE）。
      returnEffective: true,
    };
  }

  return { runForward, runReturn, validate, status, budgetChars: () => budgetChars };
}
