/* agent-gateway operator 控制台（原生 JS + Bootstrap 5.3 组件，无构建）
 * 视图：登录 / 服务注册 / 通路·回路编排 / 注册台账 / DSH 预设提示词 /
 *       DSH 模型与会话 / DSH 未决提问（只读）/ 用量计费 / 消费端总览。
 * 认证：POST /v1/console/session 换发 HttpOnly Cookie，之后 fetch 同源携带；
 *       写操作 Content-Type: application/json（CSRF 约定的服务端半边）。
 * 组件：布局与控件用 Bootstrap 类，二次确认走 confirmDialog()（Modal），
 *       提示走 Bootstrap Toast；vendor 文件见 public/console/vendor/。
 */
'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  view: 'services',
  services: null,   // GET /v1/console/services 响应
  pipelines: null,  // GET /v1/console/pipelines 响应
  ledger: null,     // GET /v1/console/services/ledger 响应
};

/* ── 基础设施 ─────────────────────────────────────────────────────────── */

async function api(path, { method = 'GET', body } = {}) {
  // 写方法（POST/PUT/DELETE）一律显式 content-type: application/json——服务端
  // CSRF 守卫要求 console 写请求必须声明 JSON（无 body 的 POST 也发 '{}'），
  // 否则 403「console writes require content-type application/json」。
  const isWrite = method.toUpperCase() !== 'GET';
  const hasBody = body !== undefined;
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: isWrite || hasBody ? { 'content-type': 'application/json' } : {},
    body: hasBody ? JSON.stringify(body) : (isWrite ? '{}' : undefined),
  });
  let payload = null;
  try { payload = await res.json(); } catch { /* 非 JSON（如 503 空体） */ }
  if (!res.ok) {
    const error = new Error(payload?.error?.message ?? `HTTP ${res.status}`);
    error.code = payload?.error?.code ?? `HTTP_${res.status}`;
    error.auth = res.status === 401;
    throw error;
  }
  return payload;
}

/** Bootstrap Toast 提示（kind: ok | bad | warn）。 */
function toast(message, kind = 'ok') {
  const el = $('#toast');
  const body = $('#toast-body');
  body.textContent = message;
  el.className = `toast align-items-center border-0 text-bg-${kind === 'bad' ? 'danger' : kind === 'warn' ? 'warning' : 'success'}`;
  if (!toast.instance) toast.instance = new bootstrap.Toast(el, { delay: 4000 });
  toast.instance.show();
}

/** Bootstrap Modal 二次确认；返回 Promise<boolean>（替换原生 confirm）。 */
function confirmDialog(text, { okText = '确认', danger = true } = {}) {
  const modalEl = $('#confirm-modal');
  const okBtn = $('#confirm-ok');
  $('#confirm-text').textContent = text;
  okBtn.textContent = okText;
  okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      modalEl.removeEventListener('hidden.bs.modal', onHide);
      resolve(value);
    };
    const onOk = () => { settle(true); modal.hide(); };
    const onHide = () => settle(false);
    okBtn.addEventListener('click', onOk);
    modalEl.addEventListener('hidden.bs.modal', onHide, { once: true });
    modal.show();
  });
}

/** 长内容截断通则（2026-11-25）：列表/卡片里的超长说明只钳到 3 行（.cell-clamp），
 *  完整内容经「详情」按钮在此弹窗展示——以后所有内容过多的场景一律走这个模式。 */
function showDetailDialog(title, bodyHtml) {
  $('#detail-title').textContent = title;
  $('#detail-body').innerHTML = bodyHtml;
  bootstrap.Modal.getOrCreateInstance($('#detail-modal')).show();
}

/**
 * 工具清单编辑模态（Bootstrap Modal）：每行 name 只读 + role 三选一下拉 +
 * isAgentTool 复选框（DSH 可见白名单）+ description 可编辑；
 * 返回 Promise<tools|null>（确认=编辑后的数组，取消=null）。
 * 行值以服务清单+登记声明合并预填（服务端 manifest 端点已做权威合并）；
 * role 非法/缺省落 tool（与服务端 schema 缺省一致）。
 * name 由服务定义只读——改名等于指向不存在的工具，服务端会拒绝。
 */
function manifestEditorDialog(tools) {
  const modalEl = $('#manifest-modal');
  const rowsEl = $('#manifest-rows');
  const okBtn = $('#manifest-ok');
  const ROLES = ['tool', 'decorator', 'filter'];
  rowsEl.innerHTML = '';
  (tools ?? []).forEach((tool, index) => {
    const role = ROLES.includes(tool.role) ? tool.role : 'tool';
    const row = document.createElement('div');
    row.className = 'd-flex align-items-start gap-2 mb-2 manifest-row';
    row.innerHTML = `
      <code class="flex-shrink-0 pt-1" style="min-width:150px" title="name 由服务定义，不可改">${escapeHtml(tool.name)}</code>
      <select class="form-select form-select-sm manifest-role" style="max-width:130px" aria-label="role">
        ${ROLES.map((r) => `<option value="${r}"${r === role ? ' selected' : ''}>${r}</option>`).join('')}
      </select>
      <label class="form-check form-check-inline flex-shrink-0 pt-1 mb-0" title="勾选后经 mcp-bus 暴露给 DSH 模型面；不勾 = 仅网关本地可用">
        <input class="form-check-input manifest-agent" type="checkbox" ${tool.isAgentTool ? 'checked' : ''}>
        <span class="form-check-label">DSH 可见</span>
      </label>
      <input class="form-control form-control-sm manifest-desc" maxlength="500"
             value="${escapeHtml(tool.description ?? '')}" placeholder="工具描述（1-500 字）" aria-label="description">`;
    rowsEl.append(row);
  });
  const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      okBtn.removeEventListener('click', onOk);
      modalEl.removeEventListener('hidden.bs.modal', onHide);
      resolve(value);
    };
    const onOk = () => {
      const edited = [...rowsEl.querySelectorAll('.manifest-row')].map((row, i) => {
        const source = tools[i] ?? {};
        const desc = row.querySelector('.manifest-desc').value.trim();
        return {
          name: source.name,
          // 服务清单带过来的 inputSchema 透传不动（网关只挡「不是对象」）。
          inputSchema: source.inputSchema ?? {},
          role: row.querySelector('.manifest-role').value,
          // isAgentTool 白名单（2026-11-25）：显式写回布尔——漏掉等于把已暴露
          // 的工具悄悄从 DSH 面下架（schema 缺省 false）。
          isAgentTool: row.querySelector('.manifest-agent').checked,
          description: desc || '（无描述）',
        };
      });
      settle(edited);
      modal.hide();
    };
    const onHide = () => settle(null);
    okBtn.addEventListener('click', onOk);
    modalEl.addEventListener('hidden.bs.modal', onHide, { once: true });
    modal.show();
  });
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function show(el, on = true) { el.classList.toggle('hidden', !on); }

/** 时长口语化（pending 等待时长、会话活跃度）。 */
function fmtAge(ms) {
  const sec = Math.max(0, Math.round(Number(ms) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时`;
  return `${Math.floor(hour / 24)} 天`;
}

/** 转义插值（会话 key / 提示词问题文本来自平台，必须按文本渲染）。 */
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ── 视图切换与会话 ───────────────────────────────────────────────────── */

function switchView(name) {
  state.view = name;
  // pending 视图的 age 秒级刷新只在页面可见时运行（离开即停，不空转）。
  if (name !== 'pending') stopPendingTicker();
  $$('.view').forEach((v) => show(v, v.id === `view-${name}`));
  $$('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
}

function setLoggedIn(on) {
  show($('#nav-items'), on);
  show($('#view-login'), !on);
  $('#session-dot').className = `dot ${on ? 'on' : 'off'}`;
  $('#session-hint').textContent = on ? '已登录' : '未登录';
  // 模式开关只对已登录 operator 有意义（端点有 operator 鉴权）。
  show($('.mode-switch'), on);
  if (on) { switchView(state.view); refreshModeSwitch(); }
}

/**
 * GATEWAY_DATA_PLANE 滑动开关（常驻装配 + 请求期门禁）：拨动即时生效、零重启，
 * 服务端同时写回启动时装载的 env 文件保持重启后不变。off = 消息面门禁关闭
 * （入站 503 / WS 帧 E_DISABLED），off 语义是操作员的显式意图，绝不自动翻转。
 * 状态映射：on=勾选可拨；off=未勾选可拨；shadow=禁用（灰度只认 env，改后重启）；
 * health 不可达=禁用 + 「—」。
 */
async function refreshModeSwitch() {
  const input = $('#mode-switch');
  const label = $('#mode-switch-label');
  try {
    const health = await fetch('/v1/health').then((r) => r.json());
    const mode = health?.mode;
    input.checked = mode === 'on';
    input.setAttribute('aria-checked', String(input.checked));
    input.disabled = mode === 'shadow';
    input.title = mode === 'shadow'
      ? 'GATEWAY_DATA_PLANE=shadow（灰度）：不支持在线切换，改 .env 后重启'
      : 'GATEWAY_DATA_PLANE：off = 消息面关闭（入站 503 / WS 帧 E_DISABLED）；on = 消息面放行。拨动即时生效、零重启，并写回启动时装载的 env 文件。';
    label.textContent = mode === 'shadow' ? '消息面 shadow（改 env 重启）' : `消息面 ${mode ?? '—'}`;
  } catch {
    input.checked = false;
    input.setAttribute('aria-checked', 'false');
    input.disabled = true;
    label.textContent = '消息面 —';
  }
}

$('#mode-switch').addEventListener('change', async () => {
  const input = $('#mode-switch');
  const target = input.checked ? 'on' : 'off';
  const verb = target === 'on' ? '启用' : '停用';
  // on/off 都二次确认：这是操作员显式意图的翻转，不因误点改变消息面状态。
  const ok = await confirmDialog(`${verb}消息面（GATEWAY_DATA_PLANE=${target}）？切换即时生效并写回 env 文件。`, {
    okText: verb, danger: target === 'off',
  });
  if (!ok) {
    // 取消：把滑块拨回真实位置（本地不保留未确认的状态）。
    input.checked = !input.checked;
    input.setAttribute('aria-checked', String(input.checked));
    return;
  }
  input.disabled = true;
  try {
    const result = await api('/v1/console/mode', { method: 'POST', body: { mode: target } });
    toast(`GATEWAY_DATA_PLANE=${result.mode} 已生效${result.persisted ? '（已写回 env 文件，重启后保持）' : '（未持久化：重启后回退 env 值）'}`,
      result.persisted ? 'ok' : 'warn');
    await refreshModeSwitch();
  } catch (error) {
    // 400 = 校验拒绝（典型：切 on 但还没有消费端登记）；失败回弹到真实状态。
    toast(`切换失败：${error?.message ?? error}`, 'bad');
    await refreshModeSwitch();
  }
  // disabled 状态由 refreshModeSwitch 按真实 mode 重绘（shadow/不可达保持禁用），
  // 这里不额外兜底，避免把禁用态错误地重新打开。
});

async function checkSession() {
  try {
    await api('/v1/console/session');
    setLoggedIn(true);
  } catch {
    setLoggedIn(false);
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errEl = $('#login-error');
  show(errEl, false);
  try {
    await api('/v1/console/session', { method: 'POST', body: { token: $('#login-token').value } });
    $('#login-token').value = '';
    setLoggedIn(true);
    toast('登录成功');
  } catch (error) {
    errEl.textContent = error.message;
    show(errEl, true);
  }
});

bindRolecardEvents();
$('#btn-logout').addEventListener('click', async () => {
  try { await api('/v1/console/session', { method: 'DELETE' }); } catch { /* 会话可能已过期 */ }
  setLoggedIn(false);
  toast('已登出');
});

$$('.nav-item[data-view]').forEach((btn) => btn.addEventListener('click', () => {
  switchView(btn.dataset.view);
  if (btn.dataset.view === 'services') loadServices();
  if (btn.dataset.view === 'rolecards') loadRolecards();
  if (btn.dataset.view === 'pipelines') loadPipelines();
  if (btn.dataset.view === 'ledger') loadLedger();
  if (btn.dataset.view === 'presets') loadPresets();
  if (btn.dataset.view === 'sessions') { loadModel(); loadSessions(); }
  if (btn.dataset.view === 'pending') loadPending();
  if (btn.dataset.view === 'usage') loadUsage();
  if (btn.dataset.view === 'adapters') loadAdapters();
}));

/* ── 服务注册视图 ─────────────────────────────────────────────────────── */

// 工具角色单值三选一（tool.call 统一改造）：role 是单选，不再是 roles 数组。
const TOOL_ROLES = ['tool', 'decorator', 'filter'];

function addToolRow(tool = {}) {
  const row = document.createElement('div');
  row.className = 'tool-row border rounded p-2';
  row.innerHTML = `
    <div class="row g-2">
      <div class="col-12 col-md-6">
        <label class="form-label small mb-1">工具名（chat_*）</label>
        <input class="form-control form-control-sm tool-name" placeholder="chat_memory_recall">
      </div>
      <div class="col-12 col-md-6">
        <label class="form-label small mb-1">描述（1–500）</label>
        <input class="form-control form-control-sm tool-desc" placeholder="检索记忆片段并拼入上下文">
      </div>
    </div>
    <div class="d-flex align-items-center gap-3 flex-wrap mt-2">
      ${TOOL_ROLES.map((role) => `
        <label class="form-check form-check-inline muted mb-0">
          <input class="form-check-input tool-role" type="radio" name="tool-role-${Math.random().toString(36).slice(2)}" value="${role}" ${role === 'tool' ? 'checked' : ''}>
          <span class="form-check-label">${role}</span>
        </label>`).join('')}
      <label class="form-check form-check-inline muted mb-0" title="勾选后经 mcp-bus 暴露给 DSH 模型面；不勾 = 仅网关本地可用（sessionSave/旁路等内部通道照常）">
        <input class="form-check-input tool-isAgent" type="checkbox" ${tool.isAgentTool ? 'checked' : ''}>
        <span class="form-check-label">DSH 可见（isAgentTool）</span>
      </label>
      <button type="button" class="btn btn-outline-danger btn-sm ms-auto">移除</button>
    </div>`;
  row.querySelector('button').addEventListener('click', () => row.remove());
  if (tool.name) row.querySelector('.tool-name').value = tool.name;
  if (tool.description) row.querySelector('.tool-desc').value = tool.description;
  const selectedRole = tool.role ?? 'tool';
  $$('.tool-role', row).forEach((box) => { box.checked = box.value === selectedRole; });
  $('#tools-editor').appendChild(row);
}

function collectTools() {
  const tools = [];
  for (const row of $$('#tools-editor .tool-row')) {
    const name = row.querySelector('.tool-name').value.trim();
    if (!name) continue;
    tools.push({
      name,
      description: row.querySelector('.tool-desc').value.trim() || name,
      role: row.querySelector('.tool-role:checked')?.value ?? 'tool',
      isAgentTool: row.querySelector('.tool-isAgent')?.checked ?? false,
    });
  }
  return tools;
}

/**
 * 登记 kind 只有两种（consumer / resource）：装饰/过滤职责由工具 role 承担。
 * UI 与契约同口径，避免提交注定被 parseServiceRegistration 拒载的登记：
 *   - resource 纯被动，transport 只能是 http 且 url 必填；
 *   - consumer 的 transport 三态（ws/http/auto）合法，工具 role 只允许 tool。
 */
function syncRegistrationForm() {
  const isResource = $('#reg-kind').value === 'resource';
  const transport = $('#reg-transport');
  for (const option of transport.options) {
    const legal = !isResource || option.value === 'http';
    option.disabled = !legal;
    option.hidden = !legal;
  }
  if (isResource) transport.value = 'http';
  // 必填项随 kind 迁移：resource → url；consumer → platform（契约同口径）。
  $('#reg-url').required = isResource;
  $('#reg-platform').required = !isResource;
  $('#reg-url-label').textContent = isResource
    ? 'url *（resource 走 http tool.call，必填、仅回环）'
    : 'url（http/auto 必填，仅回环；WS-only 消费者可空）';
  $('#tools-hint').textContent = isResource
    ? 'resource 可声明 tool / decorator / filter（装饰/过滤步骤只认 resource 工具）。'
    : 'consumer 能力走 manifest 现拉清单（此声明通常留空）；如声明，role 只能是 tool。';
  for (const row of $$('#tools-editor .tool-row')) {
    let hasChecked = false;
    for (const box of $$('.tool-role', row)) {
      const legal = isResource || box.value === 'tool';
      box.disabled = !legal;
      if (box.checked && legal) hasChecked = true;
    }
    if (!hasChecked) row.querySelector('.tool-role[value="tool"]').checked = true;
  }
  // 记忆服务声明联动（2026-11-22）：仅 resource 显示；切 kind 复位勾选。
  const memoryBlock = $('#memory-service-block');
  const memoryRow = $('#memory-save-tool-row');
  if (memoryBlock) memoryBlock.classList.toggle('hidden', !isResource);
  if (memoryRow) memoryRow.classList.toggle('hidden', !(isResource && $('#reg-memory-service').checked));
  if (!isResource && $('#reg-memory-service')) $('#reg-memory-service').checked = false;
}

// checkbox 勾选 → saveTool 行显隐（与 syncRegistrationForm 解耦的轻量联动）。
$('#reg-memory-service').addEventListener('change', () => {
  $('#memory-save-tool-row').classList.toggle('hidden', !$('#reg-memory-service').checked);
});

// ── 角色卡视图（2026-11-20）：人格唯一来源的管理面 ─────────────────────────
// 数据面：GET /v1/console/rolecards（列表+当前）、GET/PUT …/:name（读/写）、
// POST …/apply（切卡 + 会话退役 + 渲染预览）。改卡保存即生效（DSH 插件每
// step 实时拉渲染）；切卡必须退役会话（system 突变防精神分裂）。

async function loadRolecards() {
  try {
    const data = await api('/v1/console/rolecards');
    renderRolecards(data);
  } catch (error) { toast(`加载角色卡失败：${error.message}`, 'bad'); }
}

function renderRolecards(data) {
  const roles = data.roles ?? [];
  const current = data.current ?? '';
  const select = $('#rolecard-select');
  select.innerHTML = '';
  for (const name of roles) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name + (name === current ? '（当前）' : '');
    select.append(option);
  }
  if (current && roles.includes(current)) select.value = current;
  $('#rolecard-current').textContent = `当前：${current || '（未设置）'}`;
}

function bindRolecardEvents() {
  $('#btn-rolecard-refresh').addEventListener('click', loadRolecards);
  // 编辑已迁至 rolecard 服务管理页（/admin，服务分离时随服务走）；本视图只管切换。
  // 编辑已迁至 rolecard 服务管理页（/admin，服务分离时随服务走）；本视图只管切换。
  // 2026-11-21 审计修复：地址不再硬编码——从服务登记的 url 动态取（声明
  // chat_role_switch 的 enabled resource 服务），取不到才回退本机默认。
  $('#btn-rolecard-edit').addEventListener('click', async () => {
    let target = 'http://127.0.0.1:7182/admin';
    try {
      const services = await api('/v1/console/services');
      const owner = (services.registrations ?? []).find((r) => r.kind === 'resource'
        && r.enabled !== false && Array.isArray(r.tools) && r.tools.includes('chat_role_switch'));
      if (owner?.url) target = `${String(owner.url).replace(/\/+$/, '')}/admin`;
    } catch { /* 登记拉取失败 → 用默认地址兜底 */ }
    window.open(target, '_blank', 'noopener');
  });
  $('#btn-rolecard-apply').addEventListener('click', async () => {
    const name = $('#rolecard-select').value;
    if (!name) return toast('先选择角色卡', 'bad');
    const confirmed = await confirmDialog(
      `把当前角色切换为「${name}」？\n\n这会退役全部存量 DSH 会话：下一条消息将以全新会话开始，\n机器人不记得刚才的对话（长期记忆保留）。确认应用？`,
      { okText: '应用并退役会话' },
    );
    if (!confirmed) return;
    try {
      const result = await api('/v1/console/rolecards/apply', { method: 'POST', body: { name } });
      $('#rolecard-current').textContent = `当前：${result.current}`;
      const previewText = (result.preview ?? []).map((sec) => sec.text ?? '').join('\n\n');
      $('#rolecard-preview').innerHTML = previewText
        ? `<div class="card"><div class="card-body"><h6 class="card-subtitle mb-2 text-muted">渲染预览（当前注入 system 的内容）</h6><pre class="mb-0 small" style="white-space:pre-wrap">${escapeHtml(previewText.slice(0, 2000))}</pre></div></div>`
        : '';
      toast(`已应用「${result.current}」，退役 ${result.retiredSessions} 个会话——下一条消息从全新会话开始`);
    } catch (error) { toast(`应用失败：${error.message}`, 'bad'); }
  });
}

async function loadServices() {
  try {
    state.services = await api('/v1/console/services');
    renderServices();
  } catch (error) { toast(`加载失败：${error.message}`, 'bad'); }
}

function svcCard({ id, name, kind, transport, url, enabled, memoryService, connected, file, tools, handoff, presets }, removable) {
  const card = document.createElement('div');
  card.className = 'card svc-card';
  const presetLabel = presets
    ? Object.entries(presets).map(([p, v]) => `${p}=${v}`).join(', ')
    : (kind === 'consumer' ? '未声明（会话用内置 minimal）' : '');
  const badges = [
    `<span class="badge text-bg-${enabled === false ? 'danger' : 'success'}">${enabled === false ? '停用' : '启用'}</span>`,
    `<span class="badge text-bg-secondary">${kind}</span>`,
    `<span class="badge text-bg-secondary">${transport ?? '—'}</span>`,
    // 记忆服务徽标（2026-11-22）：支持布尔旧形态与 {saveTool} 对象形态——
    // 对象形态展示实际 saveTool 值（session-save 缓冲批量落地的目标工具）。
    memoryService === true
      ? '<span class="badge text-bg-primary" title="声明 memoryService（旧布尔形态，saveTool 走网关缺省）">记忆服务</span>'
      : (memoryService && typeof memoryService === 'object' && memoryService.saveTool
        ? `<span class="badge text-bg-primary" title="会话缓冲经该工具批量落地">${escapeHtml(memoryService.saveTool)}</span>`
        : ''),
    // 预设声明徽标（consumer）：只是名字，内容在 qq-bridge 编辑安装。
    presetLabel && kind === 'consumer'
      ? `<span class="badge text-bg-info" title="DSH 预设声明（仅名字；内容编辑/安装在 qq-bridge）">预设 ${presetLabel}</span>`
      : '',
    connected ? '<span class="badge text-bg-success">已连接</span>' : '',
    url ? `<span class="badge text-bg-secondary">${url}</span>` : '',
    // 交接文件是「对端能不能连上」的前置条件：生成了不代表复制过去了，
    // 所以这里只陈述事实（已生成/未生成），不冒充「已接入」。
    handoff?.exists
      ? '<span class="badge text-bg-info" title="复制到目标仓库根目录并保持文件名 gateway.json">交接文件已生成</span>'
      : '<span class="badge text-bg-secondary">交接文件未生成</span>',
  ].join(' ');
  // 控制台专用工具（chat_role_admin_*）不在卡片徽章逐个铺开——它们不在模型/适配器
  // 工具面（ToolHost 过滤），只在控制台签名代理通道使用；汇总一个徽章保持登记事实可见。
  const visibleTools = (tools ?? []).filter((t) => !/^chat_role_admin_/.test(String(t)));
  const consoleOnlyCount = (tools ?? []).length - visibleTools.length;
  const chips = visibleTools.map((t) => `<span class="badge text-bg-dark border fw-normal">${t}</span>`).join('')
    + (consoleOnlyCount > 0 ? `<span class="badge text-bg-light border fw-normal" title="控制台专用（角色卡管理面），不进入模型/适配器工具面">另有 ${consoleOnlyCount} 个控制台专用工具</span>` : '');
  // 记忆服务声明行内编辑（2026-11-22，resource 卡）：checkbox + saveTool。
  // 注册时服务未接入（manifest 拉不到）→ 预置选项 + 可手输；此处编辑时
  // 工具清单已可得，datalist 额外并入登记声明的工具名。
  //（注意：以上是 JS 注释——曾误写进下方模板字符串里，`//` 行被当纯文本
  // 渲染进 UI（2026-11-25 修复）；模板内禁放 `//` 注释。）
  card.innerHTML = `<div class="card-body p-3">
    <div class="d-flex align-items-center gap-2 flex-wrap"><strong>${name ?? id}</strong>${badges}</div>
    <div class="muted small d-flex gap-2 flex-wrap mt-1"><span>${id}</span>${file ? `<span>${file}</span>` : ''}</div>
    ${chips ? `<div class="d-flex flex-wrap gap-1 mt-2">${chips}</div>` : ''}
    ${kind === 'consumer' && removable ? `<div class="mt-2 d-flex gap-2 align-items-center flex-wrap">
      <input class="form-control form-control-sm preset-input" style="max-width:220px"
             placeholder="DSH 预设名（清空保存=清除声明）" pattern="[a-z][a-z0-9-]{0,63}">
      <button class="btn btn-outline-primary btn-sm preset-save">保存声明</button>
      <span class="muted small">当前：${presetLabel}</span>
    </div>` : ''}
    ${kind !== 'consumer' && removable ? `<div class="mt-2 d-flex gap-2 align-items-center flex-wrap">
      <button class="btn btn-outline-secondary btn-sm manifest-fetch">从服务拉取工具清单</button>
      <span class="muted small">凭据用登记自身（url+secret）；写回后热生效，role 可在登记文件微调</span>
    </div>` : ''}
    ${kind !== 'consumer' && removable ? `<div class="mt-2 d-flex gap-2 align-items-center flex-wrap">
      <label class="d-flex align-items-center gap-1"><input type="checkbox" class="form-check-input svc-mem-check"> 声明为记忆服务</label>
      <input class="form-control form-control-sm svc-mem-tool" list="svc-mem-options-${id}" style="max-width:220px" placeholder="chat_memory_save" title="saveTool：会话缓冲批量落地的工具">
      <datalist id="svc-mem-options-${id}"><option value="chat_memory_save"></option>${(tools ?? []).map((t) => `<option value="${t}"></option>`).join('')}</datalist>
      <button class="btn btn-outline-primary btn-sm svc-mem-save">保存声明</button>
      <span class="muted small">当前：${memoryService === true ? 'true（旧形态，saveTool 走网关缺省）' : (memoryService?.saveTool ?? '未声明')}</span>
    </div>` : ''}
    ${removable ? '<div class="mt-2"><button class="btn btn-outline-danger btn-sm">卸载</button></div>' : ''}
  </div>`;
  if (removable) {
    card.querySelector('button.btn-outline-danger').addEventListener('click', async () => {
      if (!await confirmDialog(`卸载服务 ${name ?? id}（${id}）？登记文件将被删除，编排立即撤销。`, { okText: '卸载' })) return;
      try {
        await api(`/v1/console/services/${id}`, { method: 'DELETE' });
        toast(`已卸载 ${id}`);
        loadServices();
      } catch (error) { toast(`卸载失败：${error.message}`, 'bad'); }
    });
    // 预设声明行内编辑：保存即写登记文件并热生效（下一回合按新声明退役重建）。
    const presetSave = card.querySelector('.preset-save');
    if (presetSave) {
      presetSave.addEventListener('click', async () => {
        const value = card.querySelector('.preset-input').value.trim();
        try {
          const result = await api(`/v1/console/services/${id}/presets`, {
            method: 'PUT',
            body: value ? { preset: value } : { clear: true },
          });
          toast(result.presets
            ? `预设声明已更新：${Object.entries(result.presets).map(([p, v]) => `${p}=${v}`).join(', ')}（下一回合生效；会话人设变化时会自动退役重建）`
            : '已清除预设声明（会话将改用内置 minimal）');
          loadServices();
        } catch (error) { toast(`保存声明失败：${error.message}`, 'bad'); }
      });
    }
    // 记忆服务声明保存（2026-11-22）：PUT tools 端点顺带接受 memoryService
    //（三态：勾选={saveTool}；取消=null 移除）。tools 原样回传（该端点要求
    // tools 数组同场校验，避免单独调用被 400 拒绝）。
    const memSave = card.querySelector('.svc-mem-save');
    if (memSave) {
      const memCheck = card.querySelector('.svc-mem-check');
      const memTool = card.querySelector('.svc-mem-tool');
      if (memoryService === true) memCheck.checked = true;
      else if (memoryService && typeof memoryService === 'object' && memoryService.saveTool) { memCheck.checked = true; memTool.value = memoryService.saveTool; }
      memTool.disabled = !memCheck.checked;
      memCheck.addEventListener('change', () => { memTool.disabled = !memCheck.checked; });
      memSave.addEventListener('click', async () => {
        const memoryServiceDecl = memCheck.checked ? { saveTool: memTool.value.trim() || 'chat_memory_save' } : null;
        try {
          await api(`/v1/console/services/${id}/tools`, { method: 'PUT', body: { tools: tools ?? [], memoryService: memoryServiceDecl } });
          toast('记忆服务声明已保存（热生效）');
          loadServices();
        } catch (error) { toast(`保存声明失败：${error.message}`, 'bad'); }
      });
    }
    // 工具清单拉取 + 写回（resource 卡）：凭据用登记自身，role 缺省 tool（网关侧
    // schema 兜底），覆盖前确认防误覆盖手工声明。
    const manifestBtn = card.querySelector('.manifest-fetch');
    if (manifestBtn) {
      manifestBtn.addEventListener('click', async () => {
        manifestBtn.disabled = true;
        try {
          const fetched = await api(`/v1/console/services/${id}/manifest`, { method: 'POST' });
          const edited = await manifestEditorDialog(fetched.tools ?? []);
          if (!edited) return;
          const saved = await api(`/v1/console/services/${id}/tools`, { method: 'PUT', body: { tools: edited } });
          toast(`已写回 ${(saved.tools ?? []).length} 条工具声明（热生效，编排词典下一拍可用）`);
          loadServices();
        } catch (error) { toast(`拉取清单失败：${error.message}`, 'bad'); }
        finally { manifestBtn.disabled = false; }
      });
    }
  }
  return card;
}

function renderServices() {
  const { services = [], registrations = [], tools = [] } = state.services ?? {};
  const list = $('#services-list');
  list.innerHTML = '';
  const registeredIds = new Set(registrations.map((r) => r.id));
  for (const reg of registrations) list.appendChild(svcCard(reg, true));
  for (const svc of services.filter((s) => !registeredIds.has(s.id))) list.appendChild(svcCard(svc, false));
  if (list.children.length === 0) list.innerHTML = '<div class="text-secondary small py-2">还没有任何服务</div>';
  const toolCount = $('#services-list').parentElement.querySelector('h2');
  void toolCount; void tools; // 工具面随服务卡片呈现
}

/**
 * 登记成功面板：自动生成的 secret 只在此一次性展示（服务端不会再次返回），
 * 连同 handoff 文件路径一起给出「复制」按钮——复制交接文件到对端仓根目录
 * 改名 gateway.json 即完成凭据交接，无需手抄随机串。
 */
function renderRegisterResult(result) {
  const panel = $('#register-result');
  panel.innerHTML = '';
  const title = document.createElement('div');
  title.textContent = `已注册 ${result.name}（${result.id}，${result.kind}${result.active ? '' : '，装载未生效——见服务端日志'}）`;
  panel.appendChild(title);
  const addCopyRow = (label, value) => {
    const row = document.createElement('div');
    row.className = 'd-flex align-items-center gap-2 mt-1';
    const text = document.createElement('span');
    text.className = 'small text-break';
    text.textContent = `${label}：${value}`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-sm btn-outline-secondary flex-shrink-0';
    btn.textContent = '复制';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        btn.textContent = '已复制';
        setTimeout(() => { btn.textContent = '复制'; }, 1500);
      } catch { /* 剪贴板不可用（如非安全上下文）：静默，值仍在面板上可手动选 */ }
    });
    row.append(text, btn);
    panel.appendChild(row);
  };
  if (result.secretGenerated && result.secret) {
    addCopyRow('secret（仅此一次显示）', result.secret);
  }
  if (result.handoffFile) {
    addCopyRow('交接文件', result.handoffFile);
  }
  show(panel, true);
  // 自举提示：off 模式下登记已落盘并热加载，消息面用侧边栏开关一键启用（即时生效）。
  fetch('/v1/health').then((r) => r.json()).then((health) => {
    if (health?.mode === 'off') {
      const note = document.createElement('div');
      note.className = 'small text-warning mt-1';
      note.textContent = '当前 GATEWAY_DATA_PLANE=off：登记已生效（可继续注册），消息面用侧边栏「启用消息面」开关开启（即时生效、零重启）。';
      panel.appendChild(note);
    }
  }).catch(() => { /* 健康检查不可达时不提示 */ });
}

$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errEl = $('#register-error');
  show(errEl, false);
  show($('#register-result'), false);
  const secret = $('#reg-secret').value.trim();
  const secretEnv = $('#reg-secret-env').value.trim();
  const body = {
    name: $('#reg-name').value.trim(),
    kind: $('#reg-kind').value,
    transport: $('#reg-transport').value,
    tools: collectTools(),
  };
  const url = $('#reg-url').value.trim();
  if (url) body.url = url;
  // consumer 平台声明（动作会话定位 + 入站验签 expectedPlatform；新契约必填）。
  const platform = $('#reg-platform').value.trim();
  if (platform) body.platform = platform;
  // 预设声明（非必填）：只是名字，内容在 qq-bridge 编辑安装（dsh/qq/** + install:preset）。
  const preset = $('#reg-preset').value.trim();
  if (preset && platform) body.preset = preset;
  const timeoutMs = Number($('#reg-timeout').value);
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) body.timeoutMs = timeoutMs;
  if (secret) body.secret = secret;
  if (secretEnv) body.secretEnv = secretEnv;
  // 记忆服务声明（2026-11-22）：勾选才提交；saveTool 空值回退预置 chat_memory_save。
  // 注册时服务尚未接入（manifest 拉不到），选项靠预置 datalist + 手输。
  if ($('#reg-memory-service').checked) {
    const saveTool = $('#reg-memory-save-tool').value.trim() || 'chat_memory_save';
    body.memoryService = { saveTool };
  }
  try {
    const result = await api('/v1/console/services', { method: 'POST', body });
    renderRegisterResult(result);
    // 交接文件是这一步真正的交付物：不给路径，运维就只能去猜密钥怎么抄到对端。
    toast(result.handoffFile
      ? `已注册 ${result.name}（${result.id}）；交接文件：${result.handoffFile} — 复制到目标仓根目录并命名 gateway.json`
      : `已注册 ${result.name}（${result.id}）（交接文件生成失败，见服务端日志）`,
    result.handoffFile ? 'ok' : 'warn');
    event.target.reset();
    $('#tools-editor').innerHTML = '';
    loadServices();
  } catch (error) {
    errEl.textContent = error.message;
    show(errEl, true);
  }
});

$('#btn-add-tool').addEventListener('click', () => { addToolRow(); syncRegistrationForm(); });
$('#btn-refresh-services').addEventListener('click', loadServices);
// kind 切换即收敛 transport / url / 工具 role 的合法取值（与契约同口径）。
$('#reg-kind').addEventListener('change', syncRegistrationForm);
$('#register-form').addEventListener('reset', () => {
  // reset 先把控件还原到 HTML 默认值，推迟到事件循环末尾再同步派生约束。
  setTimeout(() => { $('#tools-editor').innerHTML = ''; syncRegistrationForm(); }, 0);
});
syncRegistrationForm();

/* ── 通路/回路编排视图 ────────────────────────────────────────────────── */

async function loadPipelines() {
  try {
    state.pipelines = await api('/v1/console/pipelines');
    renderPipelines();
  } catch (error) { toast(`加载失败：${error.message}`, 'bad'); }
}

/** 可用步骤清单：内置 → 登记服务 id → 装饰器/过滤器工具名（带来源标注）。 */
function availableSteps() {
  const { available = {} } = state.pipelines ?? {};
  // 可编排步骤只有 decorator/filter 角色的登记工具（服务 id 自 V2 起不再是
  // 合法步骤、builtin protocol 已退役——两者都不再作为选项暴露）。
  // 选项按「服务 => 工具」展示，value 仍是工具名（服务端按名解析）。
  const registrations = state.services?.registrations ?? [];
  const serviceNameOf = (id) => registrations.find((r) => r.id === id)?.name ?? id;
  return [
    ['工具', (available.tools ?? []).map((t) => ({
      name: t.name,
      label: `${serviceNameOf(t.serviceId)} => ${t.name}`,
      role: t.role,
    }))],
  ];
}

/* ── P4.x 注入规则（once / 前缀·后缀·正则·函数 / 本地静态文本）────────── */

const JOIN_MODES = [
  ['', '默认（服务契约）'],
  ['prefix', '前缀'],
  ['suffix', '后缀'],
  ['regex', '正则'],
  ['function', '函数'],
];

const FN_TEMPLATE = `// message = 进入装饰器的当前消息；extra = 装饰器/静态文本提供的内容
// 必须有 return，返回拼接后的完整消息（string）
return extra ? extra + '\\n\\n' + message : message;`;

const stepNameOf = (entry) => (typeof entry === 'string' ? entry : entry?.step);
const isStaticEntry = (entry) => typeof entry !== 'string' && entry?.text !== undefined;

/** 步骤徽标摘要：规则配置状态一目了然（本地文本 / 仅首轮 / 注入模式）。 */
function entryBadges(entry) {
  if (typeof entry === 'string') return '';
  const out = [];
  if (isStaticEntry(entry)) out.push('<span class="badge text-bg-secondary">本地文本</span>');
  if (entry.once) out.push('<span class="badge text-bg-success">仅首轮</span>');
  if (entry.join) out.push(`<span class="badge text-bg-warning">${entry.join}</span>`);
  return out.length ? ` ${out.join(' ')}` : '';
}

/** 正则/函数的本地校验（服务端保存校验的镜像，返回错误文案或 null）。 */
function validateRule(entry) {
  if (typeof entry === 'string') return null;
  if (entry.join === 'regex') {
    if (!entry.pattern) return 'pattern 不能为空';
    if (entry.replacement === undefined) return 'replacement 不能为空';
    try { new RegExp(entry.pattern, entry.flags ?? 'g'); } catch (error) { return `正则编译失败：${error.message}`; }
  }
  if (entry.join === 'function') {
    if (!/\breturn\b/.test(entry.fn ?? '')) return '函数体必须包含 return';
    try {
      const out = new Function('message', 'extra', entry.fn ?? '')('__check__', '__check__');
      if (typeof out !== 'string') return '函数必须返回 string';
    } catch (error) { return `函数执行失败：${error.message}`; }
  }
  return null;
}

/** 前端本地预览：与引擎 applyJoin 同构（函数经浏览器端 new Function 执行）。 */
function previewRule(entry, message, extra) {
  const join = (typeof entry === 'string' ? undefined : entry.join)
    ?? (isStaticEntry(entry) ? 'suffix' : undefined);
  if (!join) return { skip: '默认服务契约（message 改写 / sections 追加），无本地拼接可预览' };
  const fill = isStaticEntry(entry) ? String(entry.text ?? '') : String(extra ?? '');
  try {
    let out;
    if (join === 'prefix') out = fill ? `${fill}\n\n${message}` : message;
    else if (join === 'suffix') out = fill ? `${message}\n\n${fill}` : message;
    else if (join === 'regex') {
      out = message.replace(new RegExp(entry.pattern, entry.flags ?? 'g'),
        () => String(entry.replacement ?? '').split('{extra}').join(fill));
    } else if (join === 'function') {
      out = new Function('message', 'extra', entry.fn ?? '')(message, fill);
    } else out = message;
    return { out };
  } catch (error) {
    return { err: String(error.message ?? error) };
  }
}

function chainEditor({ label, steps, effective = true }) {
  const wrap = document.createElement('div');
  wrap.className = 'chain';
  const groups = availableSteps();
  const options = groups
    .filter(([, items]) => items.length > 0)
    .map(([group, items]) => `<optgroup label="${group}">${items
      .map((item) => `<option value="${item.name}">${item.label}（${item.role ?? "tool"}）</option>`).join('')}</optgroup>`)
    .join('');
  wrap.innerHTML = `
    <div class="chain-title d-flex align-items-center gap-2 flex-wrap">${label}
      ${effective ? '' : '<span class="badge text-bg-warning">已配置未生效（GATEWAY_PIPELINE=off）</span>'}
    </div>
    <div class="steps d-flex flex-column gap-2 my-2"></div>
    <div class="chain-add d-flex align-items-center gap-2 flex-wrap">
      <select class="chain-select form-select form-select-sm w-auto"><option value="">选择要追加的步骤…</option>${options}</select>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-act="add">追加</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-act="add-local" title="本地静态供料步骤：文本直接落编排配置，零服务调用；配 once 即「首轮注入」">+ 本地文本</button>
    </div>`;
  const stepsEl = $('.steps', wrap);
  let openIndex = null;

  /** 结构性变更（增删/移位）后整链重渲染，折叠态复位。 */
  const structural = () => { openIndex = null; render(); };

  /** 规则面板：once / 注入模式 / 正则 / 函数 / 静态文本 / 本地预览。
   *  字符串条目在首次改动规则时升级为规则对象（steps 原地替换，PUT 直接收）。
   *  输入事件只改条目对象并刷新徽标/预览，不整链重渲染（保住输入焦点）。 */
  function attachRulePanel(panel, index, badgesEl) {
    const ensureObject = () => {
      if (typeof steps[index] === 'string') steps[index] = { step: steps[index] };
      return steps[index];
    };
    const entry = steps[index];
    const isStatic = isStaticEntry(entry);
    const effJoin = (typeof entry === 'string' ? undefined : entry.join) ?? (isStatic ? 'suffix' : undefined);
    const showFor = (mode) => (effJoin === mode && !(isStatic && mode === '') ? '' : 'hidden');
    panel.innerHTML = `
      <label class="rule-toggle form-check mb-2"><input type="checkbox" class="rule-once form-check-input" ${entry.once ? 'checked' : ''}>
        <span class="form-check-label">仅会话首轮注入（once：非首轮整个步骤跳过，不调服务；首轮注入进会话历史缓存前缀，成本≈预设）</span></label>
      <div class="rule-row d-flex align-items-center gap-2 mb-2">
        <label class="small text-secondary mb-0">注入模式</label>
        <div class="seg btn-group btn-group-sm">${JOIN_MODES.map(([value, text]) => `
          <button type="button" class="seg-item btn btn-outline-secondary ${effJoin === value ? 'active' : ''}" data-join="${value}">${text}</button>`).join('')}
        </div>
      </div>
      <div class="rule-body ${isStatic ? '' : 'hidden'}" data-for="static">
        <label class="form-label small mb-1">静态文本（直接落编排配置，零服务调用）</label>
        <textarea class="rule-text form-control form-control-sm" rows="4" placeholder="角色卡文本、固定提示词…">${isStatic ? entry.text : ''}</textarea>
      </div>
      <div class="rule-body ${showFor('regex')}" data-for="regex">
        <div class="row g-2">
          <div class="col-12 col-md-6"><label class="form-label small mb-1">pattern（匹配当前消息）</label><input class="rule-pattern form-control form-control-sm" value="${entry.pattern ?? ''}" placeholder="\\[角色\\]"></div>
          <div class="col-12 col-md-6"><label class="form-label small mb-1">flags（缺省 g）</label><input class="rule-flags form-control form-control-sm" value="${entry.flags ?? 'g'}" placeholder="g"></div>
          <div class="col-12"><label class="form-label small mb-1">replacement（{extra} = 装饰器产出/静态文本占位）</label><input class="rule-replacement form-control form-control-sm" value="${entry.replacement ?? ''}" placeholder="【{extra}】$&"></div>
        </div>
      </div>
      <div class="rule-body ${showFor('function')}" data-for="function">
        <label class="form-label small mb-1">函数体 function(message, extra)（强制 return，operator 可信前提）</label>
        <textarea class="rule-fn-body form-control form-control-sm font-monospace" rows="5">${entry.fn ?? FN_TEMPLATE}</textarea>
      </div>
      <div class="rule-status small text-secondary"></div>
      <div class="rule-preview mt-2">
        <div class="row g-2">
          <div class="col-12 col-md-6"><label class="form-label small mb-1">预览：测试消息</label><input class="pv-msg form-control form-control-sm" value="今天的会议改到下午三点"></div>
          <div class="col-12 col-md-6 ${isStatic ? 'hidden' : ''}"><label class="form-label small mb-1">预览：extra（模拟装饰器产出）</label><input class="pv-extra form-control form-control-sm" placeholder="（装饰器返回的内容）"></div>
        </div>
        <div class="pv-out small text-secondary mt-1">（输入后即时预览）</div>
      </div>`;

    // badges 元素由调用方传入（buildRow 持有 row 引用）——本函数执行时 panel
    // 尚未挂入 DOM，panel.parentElement 为 null，不可反向从父节点查找。
    const rowBadges = badgesEl;
    const statusEl = $('.rule-status', panel);
    const pvMsg = $('.pv-msg', panel);
    const pvExtra = $('.pv-extra', panel);
    const pvOut = $('.pv-out', panel);

    const refresh = () => {
      rowBadges.innerHTML = entryBadges(steps[index]);
      const err = validateRule(steps[index]);
      statusEl.textContent = err ? `✗ ${err}` : (steps[index].join ? '✓ 规则有效' : '');
      statusEl.className = `rule-status small ${err ? 'text-danger' : 'text-secondary'}`;
      const res = previewRule(steps[index], pvMsg.value, pvExtra.value);
      if (res.skip) { pvOut.textContent = res.skip; pvOut.className = 'pv-out small text-secondary mt-1'; }
      else if (res.err) { pvOut.textContent = `错误：${res.err}`; pvOut.className = 'pv-out small text-danger mt-1'; }
      else { pvOut.textContent = `→ ${res.out}`; pvOut.className = 'pv-out small mt-1'; }
    };

    $('.rule-once', panel).addEventListener('change', (event) => {
      ensureObject().once = event.target.checked;
      refresh();
    });
    $$('.seg-item', panel).forEach((btn) => btn.addEventListener('click', () => {
      const value = btn.dataset.join;
      const entryObj = ensureObject();
      if (value) entryObj.join = value; else delete entryObj.join;
      $$('.seg-item', panel).forEach((other) => other.classList.toggle('active', other === btn));
      $('[data-for="regex"]', panel).classList.toggle('hidden', value !== 'regex');
      $('[data-for="function"]', panel).classList.toggle('hidden', value !== 'function');
      refresh();
    }));
    const bind = (sel, field) => {
      $(sel, panel).addEventListener('input', (event) => {
        ensureObject()[field] = event.target.value;
        refresh();
      });
    };
    bind('.rule-text', 'text');
    bind('.rule-pattern', 'pattern');
    bind('.rule-replacement', 'replacement');
    bind('.rule-flags', 'flags');
    bind('.rule-fn-body', 'fn');
    pvMsg.addEventListener('input', refresh);
    pvExtra.addEventListener('input', refresh);
    refresh();
  }

  /** 单条步骤行 + 可折叠规则面板（protocol 是安全凭据注入，不带规则）。 */
  function buildRow(entry, index) {
    const el = document.createElement('div');
    el.className = 'step-wrap';
    const row = document.createElement('div');
    row.className = 'step';
    const isProtocol = stepNameOf(entry) === 'protocol';
    row.innerHTML = `
      ${index === 0 ? '' : '<span class="arrow text-secondary">→</span>'}
      <span class="grow">${stepNameOf(entry) ?? '(未命名)'}</span>
      <span class="rule-badges">${entryBadges(entry)}</span>
      ${isProtocol ? '' : '<button type="button" class="btn btn-outline-secondary btn-sm" data-act="rule">规则</button>'}
      <button type="button" class="btn btn-outline-secondary btn-sm" data-act="up" ${index === 0 ? 'disabled' : ''}>↑</button>
      <button type="button" class="btn btn-outline-secondary btn-sm" data-act="down" ${index === steps.length - 1 ? 'disabled' : ''}>↓</button>
      <button type="button" class="btn btn-outline-danger btn-sm" data-act="del">×</button>`;
    const panel = document.createElement('div');
    panel.className = 'rule-panel';
    if (openIndex !== index) panel.classList.add('hidden');
    row.addEventListener('click', (event) => {
      const act = event.target?.dataset?.act;
      if (!act) return;
      if (act === 'del') { steps.splice(index, 1); structural(); return; }
      if (act === 'up') { [steps[index - 1], steps[index]] = [steps[index], steps[index - 1]]; structural(); return; }
      if (act === 'down') { [steps[index + 1], steps[index]] = [steps[index], steps[index + 1]]; structural(); return; }
      if (act === 'rule') {
        openIndex = openIndex === index ? null : index;
        panel.classList.toggle('hidden', openIndex !== index);
      }
    });
    if (!isProtocol) attachRulePanel(panel, index, row.querySelector('.rule-badges'));
    el.append(row, panel);
    return el;
  }

  const render = () => {
    stepsEl.innerHTML = '';
    if (steps.length === 0) {
      stepsEl.innerHTML = '<div class="text-secondary small py-1">空编排 = 透传</div>';
      return;
    }
    steps.forEach((entry, index) => stepsEl.appendChild(buildRow(entry, index)));
  };
  render();

  $('.chain-add', wrap).addEventListener('click', (event) => {
    const act = event.target?.dataset?.act;
    if (!act) return;
    if (steps.length >= 16) { toast('每条链最多 16 步', 'bad'); return; }
    if (act === 'add') {
      const value = $('.chain-select', wrap).value;
      if (!value) return;
      steps.push(value);
      $('.chain-select', wrap).value = '';
      structural();
    }
    if (act === 'add-local') {
      const n = steps.filter((s) => isStaticEntry(s)).length + 1;
      steps.push({ step: `local.text.${n}`, text: '', join: 'suffix' });
      openIndex = steps.length - 1; // 新建即展开规则面板，直接填文本
      render();
    }
  });
  return { el: wrap, steps };
}

function renderPipelines() {
  const data = state.pipelines;
  if (!data) return;
  const modeBadge = $('#pipeline-mode');
  modeBadge.textContent = `GATEWAY_PIPELINE=${data.pipelineMode}`;
  modeBadge.className = `badge text-bg-${data.pipelineMode === 'on' ? 'success' : 'warning'}`;
  const list = $('#pipelines-list');
  list.innerHTML = '';
  const entries = [...(data.consumers ?? []).map((c) => ({ ...c, key: c.id }))];
  if (data.default) entries.push({ key: 'default', kind: 'default', forward: data.default.forward, return: data.default.return });

  for (const entry of entries) {
    const card = document.createElement('div');
    card.className = 'pipe-consumer card mb-3';
    const forward = [...(entry.forward ?? [])];
    const returnSteps = [...(entry.return ?? [])];
    const title = document.createElement('div');
    title.className = 'card-header d-flex align-items-center gap-2 flex-wrap';
    title.innerHTML = `<strong>${entry.key}</strong>
      <span class="badge text-bg-secondary">${entry.kind ?? ''}</span>
      ${entry.platform ? `<span class="muted small">${entry.platform}</span>` : ''}
      <span class="ms-auto"><button class="btn btn-primary btn-sm">保存</button></span>`;
    card.appendChild(title);

    const chains = document.createElement('div');
    chains.className = 'pipe-chains card-body d-flex flex-column gap-3';
    const fwd = chainEditor({
      label: '通路（consumer → DSH prompt）', steps: forward, effective: true,
    });
    // P5：回路引擎已接通——生效态读 API 字段（GATEWAY_PIPELINE=off 回滚时为
    // false，徽标回「已配置未生效」）。
    const ret = chainEditor({
      label: '回路（DSH 产出 → consumer 发送动作）',
      steps: returnSteps,
      effective: entry.returnEffective === true,
    });
    chains.append(fwd.el, ret.el);
    card.appendChild(chains);

    $('button', title).addEventListener('click', async () => {
      try {
        const result = await api(`/v1/console/pipelines/${encodeURIComponent(entry.key)}`, {
          method: 'PUT',
          body: { forward, return: returnSteps },
        });
        toast(`已保存 ${result.consumerId} 的编排（即时生效）`);
      } catch (error) { toast(`保存失败：${error.message}`, 'bad'); }
    });
    list.appendChild(card);
  }
  if (list.children.length === 0) list.innerHTML = '<div class="text-secondary small py-2">没有可编排的消费端</div>';
}

$('#btn-refresh-pipelines').addEventListener('click', loadPipelines);

/* ── 台账视图 ─────────────────────────────────────────────────────────── */

const ACTION_BADGE = { register: 'success', unregister: 'warning', reject: 'danger' };

async function loadLedger() {
  const limit = Number($('#ledger-limit').value) || 100;
  try {
    state.ledger = await api(`/v1/console/services/ledger?limit=${limit}`);
    renderLedger();
  } catch (error) { toast(`加载失败：${error.message}`, 'bad'); }
}

function renderLedger() {
  const { events = [], corrupt = 0, total = 0 } = state.ledger ?? {};
  $('#ledger-summary').textContent = `共 ${total} 条${corrupt ? `，${corrupt} 条坏行已跳过` : ''}（显示最近 ${events.length} 条，新在前）`;
  const tbody = $('#ledger-table tbody');
  tbody.innerHTML = '';
  for (const event of events) {
    const tr = document.createElement('tr');
    // 说明/快照钳 3 行省略（cell-clamp），完整内容走「详情」弹窗（长内容通则）。
    const hasDetail = Boolean(event.reason || event.snapshot);
    const detailBody = `${event.reason ? `<p class="mb-2">${escapeHtml(event.reason)}</p>` : ''}${event.snapshot ? `<pre class="mb-0"><code>${escapeHtml(JSON.stringify(event.snapshot, null, 2))}</code></pre>` : ''}`;
    tr.innerHTML = `
      <td>${fmtTime(event.at)}</td>
      <td><code>${event.serviceId ?? '—'}</code></td>
      <td><span class="badge text-bg-${ACTION_BADGE[event.action] ?? 'secondary'}">${event.action}</span></td>
      <td>${event.source ?? '—'}</td>
      <td class="text-break">${hasDetail ? `
        <div class="cell-clamp">${event.reason ? `⚠ ${escapeHtml(event.reason)}` : ''}${event.snapshot ? `<code class="d-block">${escapeHtml(JSON.stringify(event.snapshot))}</code>` : ''}</div>
        <button type="button" class="btn btn-outline-secondary btn-sm mt-1 detail-btn">详情</button>` : '—'}</td>`;
    if (hasDetail) {
      tr.querySelector('.detail-btn').addEventListener('click', () => {
        showDetailDialog(`台账详情 · ${event.serviceId ?? ''} · ${event.action}`, detailBody);
      });
    }
    tbody.appendChild(tr);
  }
  if (tbody.children.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">台账为空</td></tr>';
  }
}

$('#btn-refresh-ledger').addEventListener('click', loadLedger);
$('#ledger-limit').addEventListener('change', loadLedger);

/* ── DSH 预设视图（只读清单）──────────────────────────────────────────────
 * 预设内容/安装归消费端（qq-bridge 的 dsh/qq/** + npm run install:preset），
 * 网关只回显活 DSH 清单；消费端「用哪个预设」在服务页的登记声明里编辑。 */

const presetState = { list: null };

async function loadPresets() {
  const badge = $('#presets-source');
  try {
    const result = await api('/v1/console/dsh/presets');
    presetState.list = result.presets ?? [];
    badge.textContent = '来源：活 DSH';
    badge.className = 'badge text-bg-success';
    renderPresets();
  } catch (error) {
    presetState.list = null;
    badge.textContent = `不可用：${error.code}`;
    badge.className = 'badge text-bg-danger';
    $('#presets-list').innerHTML = `<div class="text-secondary small py-2">${escapeHtml(error.message)}</div>`;
    toast(`预设清单加载失败：${error.message}`, 'bad');
  }
}

function renderPresets() {
  const list = $('#presets-list');
  list.innerHTML = '';
  for (const preset of presetState.list ?? []) {
    const row = document.createElement('div');
    row.className = 'card svc-card';
    row.innerHTML = `<div class="card-body p-3">
      <div class="d-flex align-items-center gap-2 flex-wrap"><strong>${escapeHtml(preset.id)}</strong></div>
      <div class="muted small mt-1">内容与安装：消费端（qq-bridge / npm run install:preset）</div>
    </div>`;
    list.appendChild(row);
  }
  if (list.children.length === 0) list.innerHTML = '<div class="text-secondary small py-2">DSH 未返回任何预设</div>';
}

$('#btn-refresh-presets').addEventListener('click', loadPresets);

/* ── DSH 模型与会话视图（docs/console/dsh-sessions/PLAN.md）────────────── */

const modelState = { data: null };

/** 目录归一化：活 DSH 的 groups[].models[] 或内置兜底的 efforts[]。 */
function modelEntries(data) {
  const groups = data?.catalog?.groups;
  if (Array.isArray(groups) && groups.length > 0) {
    return groups.flatMap((group) => (group?.models ?? []).map((m) => ({
      id: m.id ?? m.model,
      label: m.label ?? m.id ?? m.model,
      efforts: (m?.reasoning?.efforts ?? []).map((e) => e?.id ?? e?.name).filter(Boolean),
    }))).filter((m) => m.id);
  }
  // 兜底目录没有模型清单：模型锁当前值，思考强度用网关内置白名单。
  return [{
    id: data?.chat?.model ?? '',
    label: data?.chat?.model ?? '(当前模型)',
    efforts: (data?.catalog?.efforts ?? []).slice(),
  }];
}

async function loadModel() {
  const badge = $('#model-source');
  try {
    const data = await api('/v1/console/dsh/model');
    modelState.data = data;
    badge.textContent = data.source === 'dsh' ? '目录：活 DSH' : '目录：内置兜底';
    badge.className = `badge text-bg-${data.source === 'dsh' ? 'success' : 'warning'}`;
    const side = $('#model-sideeffects');
    side.textContent = `⚠ ${data.sideEffects}`;
    show(side, true);
    $('#model-current').textContent = `当前：${data.chat.provider}/${data.chat.model} · ${data.chat.reasoningEffort}`;
    renderModelOptions();
  } catch (error) {
    badge.textContent = `不可用：${error.code}`;
    badge.className = 'badge text-bg-danger';
    toast(`模型信息加载失败：${error.message}`, 'bad');
  }
}

function renderModelOptions() {
  const data = modelState.data;
  if (!data) return;
  const entries = modelEntries(data);
  const select = $('#model-select');
  select.innerHTML = entries
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`).join('');
  if (entries.some((entry) => entry.id === data.chat.model)) select.value = data.chat.model;
  syncEffortOptions(data.chat.reasoningEffort);
  select.onchange = () => syncEffortOptions();
}

function syncEffortOptions(preferred) {
  const data = modelState.data;
  const select = $('#effort-select');
  const model = $('#model-select').value;
  const entry = modelEntries(data).find((item) => item.id === model);
  const efforts = (entry?.efforts?.length ? entry.efforts : (data?.catalog?.efforts ?? [])).slice();
  select.innerHTML = efforts
    .map((effort) => `<option value="${escapeHtml(effort)}">${escapeHtml(effort)}</option>`).join('');
  const want = preferred ?? data?.chat?.reasoningEffort;
  if (want && efforts.includes(want)) select.value = want;
}

async function saveModel() {
  const model = $('#model-select').value;
  const reasoningEffort = $('#effort-select').value;
  if (!model) { toast('没有可选的模型（DSH 目录不可用）', 'bad'); return; }
  if (!await confirmDialog(`保存模型设置：${model} / ${reasoningEffort}？\n`
    + '注意：session.selectModel 会同步改写 DSH 全局默认模型（agent-default-model），影响所有新会话。',
  { okText: '保存', danger: false })) return;
  try {
    const result = await api('/v1/console/dsh/model', { method: 'PUT', body: { model, reasoningEffort } });
    toast(`已更新：${result.chat.model} / ${result.chat.reasoningEffort}（所有会话下一轮生效）`);
    await loadModel();
  } catch (error) {
    toast(`保存失败：${error.message}`, 'bad');
  }
}

$('#btn-refresh-model').addEventListener('click', loadModel);
$('#btn-save-model').addEventListener('click', saveModel);

async function loadSessions() {
  try {
    const data = await api('/v1/console/dsh/sessions');
    const sessions = data.sessions ?? [];
    const tbody = $('#sessions-table tbody');
    tbody.innerHTML = '';
    const now = Date.now();
    for (const session of sessions) {
      const tr = document.createElement('tr');
      const active = session.lastTurnAt
        ? `${fmtTime(session.lastTurnAt)}<span class="muted">（${fmtAge(now - session.lastTurnAt)}前）</span>`
        : '<span class="muted">未唤醒</span>';
      tr.innerHTML = `
        <td><code>${escapeHtml(session.sessionKey)}</code></td>
        <td><code>${escapeHtml(session.sessionId)}</code></td>
        <td>${escapeHtml(session.preset ?? '—')}</td>
        <td>${fmtTime(session.createdAt)}</td>
        <td>${active}</td>`;
      tbody.appendChild(tr);
    }
    if (tbody.children.length === 0) tbody.innerHTML = '<tr><td colspan="5" class="muted">还没有会话</td></tr>';
    $('#sessions-summary').textContent = `共 ${sessions.length} 个会话`;
  } catch (error) {
    toast(`会话加载失败：${error.message}`, 'bad');
  }
}

$('#btn-refresh-sessions').addEventListener('click', loadSessions);

/* ── DSH 未决提问 / 审批视图（只读，docs/console/dsh-pending/PLAN.md）──── */

const pendingState = { data: null, timer: null };

function stopPendingTicker() {
  if (pendingState.timer) {
    clearInterval(pendingState.timer);
    pendingState.timer = null;
  }
}

function startPendingTicker() {
  stopPendingTicker();
  pendingState.timer = setInterval(() => {
    const now = Date.now();
    $$('#pending-table td[data-at]').forEach((cell) => {
      cell.textContent = fmtAge(now - Number(cell.dataset.at));
    });
  }, 1000);
}

async function loadPending() {
  const kind = $('#pending-kind').value;
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  try {
    pendingState.data = await api(`/v1/console/pending${query}`);
    renderPending();
    startPendingTicker();
  } catch (error) {
    stopPendingTicker();
    pendingState.data = null;
    $('#pending-table tbody').innerHTML = `<tr><td colspan="5" class="muted">加载失败：${escapeHtml(error.message)}</td></tr>`;
    $('#pending-summary').textContent = '';
    toast(`未决列表加载失败：${error.message}`, 'bad');
  }
}

function renderPending() {
  const data = pendingState.data;
  if (!data) return;
  const rows = data.pending ?? [];
  const capacity = Number(data.capacity) || 100;
  const total = Number(data.total) || 0;

  const forward = $('#pending-forward');
  if (data.forward?.mode === 'on') {
    forward.textContent = '平台转发：on（仅通知）';
    forward.className = 'badge text-bg-success';
  } else {
    forward.textContent = '平台转发：off';
    forward.className = 'badge text-bg-secondary';
  }

  const warn = $('#pending-capacity');
  if (total >= capacity) {
    warn.textContent = `已占满 ${total}/${capacity} 条：继续入列会立即淘汰最旧的未决条目（暂存不持久化）。`;
    warn.className = 'warn-strip bad';
    show(warn, true);
  } else if (total >= Math.floor(capacity * 0.8)) {
    warn.textContent = `已占用 ${total}/${capacity} 条：接近容量上限，最旧条目将被淘汰。`;
    warn.className = 'warn-strip';
    show(warn, true);
  } else {
    show(warn, false);
  }

  const tbody = $('#pending-table tbody');
  tbody.innerHTML = '';
  const now = Date.now();
  for (const row of rows) {
    const tr = document.createElement('tr');
    tr.dataset.eventId = row.eventId;
    const kindBadge = row.kind === 'approval'
      ? '<span class="badge text-bg-warning">审批</span>'
      : '<span class="badge text-bg-success">提问</span>';
    const sessionCell = row.mapped
      ? `<code>${escapeHtml(row.sessionKey)}</code>`
      : `<code>${escapeHtml(row.sessionId)}</code> <span class="badge text-bg-danger">unmapped</span>`;
    let content = '';
    if (row.kind === 'approval') {
      content = `<code>${escapeHtml(row.toolName ?? '(未知工具)')}</code>`
        + (row.reason ? `<div class="muted">${escapeHtml(row.reason)}</div>` : '')
        + `<div class="d-flex gap-2 mt-2">
             <button type="button" class="btn btn-success btn-sm pending-approve">通过（allowed-once）</button>
             <button type="button" class="btn btn-outline-danger btn-sm pending-deny">拒绝</button>
           </div>`;
    } else {
      const questions = row.questions ?? [];
      content = questions.length
        ? questions.map((q, i) => {
          // 真实形状是对象 { id, question, options?: [{ label }] }（快照仓
          // bridge.js 11318-11333 实证）；字符串形态（老 mock）只展示不可答。
          const isObj = q && typeof q === 'object';
          const text = isObj ? String(q.question ?? '') : String(q ?? '');
          const qid = isObj && typeof q.id === 'string' ? q.id : null;
          const options = isObj && Array.isArray(q.options)
            ? q.options.map((o) => String(o?.label ?? '')).filter(Boolean) : [];
          if (!qid) {
            return `<div class="q-block mb-2"><div>${escapeHtml(text || '（未知问题）')}</div>
              <div class="muted small">缺少问题 id，无法作答</div></div>`;
          }
          if (options.length) {
            return `<div class="q-block mb-2" data-qid="${escapeHtml(qid)}">
              <div>${i + 1}. ${escapeHtml(text)}</div>
              <div class="d-flex gap-2 mt-1 flex-wrap">
                <select class="form-select form-select-sm q-select w-auto">
                  <option value="">请选择…</option>
                  ${options.map((o) => `<option>${escapeHtml(o)}</option>`).join('')}
                </select>
                <input class="form-control form-control-sm q-input w-auto flex-grow-1" placeholder="或输入自定义回答">
              </div></div>`;
          }
          return `<div class="q-block mb-2" data-qid="${escapeHtml(qid)}">
            <div>${i + 1}. ${escapeHtml(text)}</div>
            <input class="form-control form-control-sm q-input mt-1" placeholder="输入回答"></div>`;
        }).join('')
        + `<button type="button" class="btn btn-primary btn-sm pending-answer">提交回答</button>`
        : '<span class="muted">（无问题文本）</span>';
    }
    tr.innerHTML = `
      <td>${kindBadge}</td>
      <td>${sessionCell}</td>
      <td class="text-break">${content}</td>
      <td data-at="${row.at}">${fmtAge(now - row.at)}</td>
      <td><code>${escapeHtml(row.eventId)}</code></td>`;
    tbody.appendChild(tr);
  }
  if (tbody.children.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="muted">当前没有未决的提问或审批</td></tr>';
  }
  $('#pending-summary').textContent = `共 ${total} 条未决（显示 ${rows.length} 条，容量 ${capacity}，重启即清空）`;

  // 应答动作（operator 显式处置 → POST /respond；成功后刷新列表）。
  $$('#pending-table tr[data-event-id]').forEach((tr) => {
    const eventId = tr.dataset.eventId;
    const approve = $('.pending-approve', tr);
    if (approve) approve.addEventListener('click', () => respondApproval(eventId, 'approve'));
    const deny = $('.pending-deny', tr);
    if (deny) deny.addEventListener('click', () => respondApproval(eventId, 'deny'));
    const answer = $('.pending-answer', tr);
    if (answer) answer.addEventListener('click', () => submitPendingAnswers(tr, eventId));
  });
}

/** 审批应答：approve → allowed-once（放行一次）/ deny → rejected。 */
async function respondApproval(eventId, decision) {
  const label = decision === 'approve' ? '通过（allowed-once：放行本次工具调用）' : '拒绝（rejected）';
  if (!await confirmDialog(`确认对未决审批 ${eventId} 执行「${label}」？这是对 agent 的显式授权。`)) return;
  try {
    await api(`/v1/console/pending/${encodeURIComponent(eventId)}/respond`, {
      method: 'POST', body: { decision },
    });
    toast(`已应答审批 ${eventId}：${decision}`);
    loadPending();
  } catch (error) {
    toast(`应答失败：${error.message}`, 'bad');
  }
}

/** 提问应答：逐题收集（选项选择或自定义文本），形状 { id, selected, custom? }。 */
async function submitPendingAnswers(tr, eventId) {
  const answers = [];
  for (const block of $$('.q-block[data-qid]', tr)) {
    const qid = block.dataset.qid;
    const select = $('.q-select', block);
    const input = $('.q-input', block);
    const custom = input ? input.value.trim() : '';
    if (select) {
      const picked = select.value;
      if (!picked && !custom) {
        toast('还有问题未回答（选择选项或输入自定义回答）', 'warn');
        return;
      }
      answers.push(custom ? { id: qid, selected: [], custom } : { id: qid, selected: [picked] });
    } else if (input) {
      if (!custom) {
        toast('还有问题未回答', 'warn');
        return;
      }
      answers.push({ id: qid, selected: [], custom });
    }
  }
  if (!answers.length) {
    toast('该条目没有可作答的问题', 'warn');
    return;
  }
  try {
    await api(`/v1/console/pending/${encodeURIComponent(eventId)}/respond`, {
      method: 'POST', body: { answers },
    });
    toast(`已提交 ${answers.length} 个答案（${eventId}）`);
    loadPending();
  } catch (error) {
    toast(`应答失败：${error.message}`, 'bad');
  }
}

$('#btn-refresh-pending').addEventListener('click', loadPending);
$('#pending-kind').addEventListener('change', loadPending);

/* ── 用量与计费视图（docs/console/usage-billing/PLAN.md）───────────────── */

const usageState = { data: null, convKey: null };

function fmtTokens(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

function fmtCost(cost, symbol = '') {
  const n = Number(cost) || 0;
  return `${symbol}${n.toFixed(n >= 100 ? 2 : 4)}`;
}

function tokensOf(buckets) {
  return ['cacheMiss', 'cacheHit', 'cacheWrite', 'output']
    .reduce((sum, key) => sum + (Number(buckets?.[key]) || 0), 0);
}

/** 内联 SVG 柱状走势（峰时琥珀色 / 平时品牌蓝；不引入 chart 库）。 */
function svgChart(buckets, { symbol = '', height = 140 } = {}) {
  const rows = Array.isArray(buckets) ? buckets : [];
  const width = 720;
  const n = rows.length || 1;
  const max = Math.max(...rows.map((b) => Number(b.cost) || 0), 0);
  const scale = max > 0 ? (height - 4) / max : 0;
  const bars = rows.map((b, i) => {
    const v = Number(b.cost) || 0;
    const h = v > 0 ? Math.max(1, v * scale) : 0;
    const w = Math.max(1, width / n - 2);
    const fill = b.tier === 'peak' ? '#F59E0B' : 'var(--bs-primary)';
    return `<rect x="${(i * width / n).toFixed(1)}" y="${(height - h).toFixed(1)}"
      width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="${fill}"><title>${fmtCost(v, symbol)}</title></rect>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" role="img" aria-label="消费走势">${bars}</svg>`;
}

async function loadUsage() {
  const hours = Number($('#usage-hours').value) || 24;
  try {
    const [summary, series, prices] = await Promise.all([
      api('/v1/console/usage/summary'),
      api(`/v1/console/usage/series?hours=${hours}`),
      api('/v1/console/usage/prices'),
    ]);
    usageState.data = { summary, series, prices };
    renderUsage();
  } catch (error) {
    usageState.data = null;
    $('#usage-stats').innerHTML = `<div class="col-12 muted">加载失败：${escapeHtml(error.message)}</div>`;
    $('#usage-chart').innerHTML = '';
    $('#usage-chart-note').textContent = '';
    toast(`用量加载失败：${error.message}`, 'bad');
  }
}

function renderUsage() {
  const { summary, series, prices } = usageState.data;
  const symbol = summary.symbol ?? '';
  const t = summary.totals ?? {};
  const stats = [
    ['总花费', fmtCost(t.cost, symbol)],
    ['总 tokens', fmtTokens(t.totalTokens)],
    ['轮次 / 步骤', `${t.turns ?? 0} / ${t.steps ?? 0}`],
    ['会话数', String(t.conversations ?? 0)],
    ['缓存命中率', `${Math.round((t.cacheHitRate ?? 0) * 100)}%`],
    ['单轮均价', fmtCost(t.avgCostPerTurn, symbol)],
  ];
  $('#usage-stats').innerHTML = stats.map(([label, value]) => `
    <div class="col-6 col-md-4 col-xl-2"><div class="stat-card">
      <div class="stat-value">${escapeHtml(value)}</div>
      <div class="stat-label muted">${label}</div>
    </div></div>`).join('');
  $('#usage-price-version').textContent = `价目 ${prices.version ?? summary.priceVersion ?? '—'}`;
  $('#usage-chart').innerHTML = svgChart(series.buckets, { symbol });
  const offChart = Number(series.offChartCost) || 0;
  $('#usage-chart-note').textContent = maxCost(series.buckets) > 0
    ? `窗口 ${fmtTime(series.from)} – ${fmtTime(series.to)}；琥珀色柱 = 峰时计价；图外累计（窗口外历史）${fmtCost(offChart, symbol)}。`
    : `窗口 ${fmtTime(series.from)} – ${fmtTime(series.to)} 内无入账；历史总花费 ${fmtCost(t.cost, symbol)}（图外 ${fmtCost(offChart, symbol)}）。`;
  renderUsageConversations();
  renderUsagePrices(prices);
}

function maxCost(buckets) {
  return (Array.isArray(buckets) ? buckets : []).reduce((m, b) => Math.max(m, Number(b.cost) || 0), 0);
}

function renderUsageConversations() {
  const symbol = usageState.data.summary.symbol ?? '';
  const rows = usageState.data.summary.conversations ?? [];
  const tbody = $('#usage-conv-table tbody');
  const now = Date.now();
  tbody.innerHTML = rows.map((c) => `
    <tr data-conv-key="${escapeHtml(c.key)}" class="conv-row">
      <td><code>${escapeHtml(c.key)}</code>${c.sessions > 1 ? ` <span class="badge text-bg-secondary">${c.sessions} 个内部会话</span>` : ''}</td>
      <td>${fmtCost(c.cost, symbol)}</td>
      <td>${fmtTokens(tokensOf(c.buckets))}</td>
      <td>${c.turns ?? 0} / ${c.steps ?? 0}</td>
      <td>${tokensOf(c.buckets) > 0 ? `${Math.round((c.buckets.cacheHit / tokensOf(c.buckets)) * 100)}%` : '—'}</td>
      <td>${c.lastAt ? fmtAge(now - c.lastAt) : '—'}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted">还没有任何入账</td></tr>';
  $('#usage-conv-summary').textContent = rows.length ? `按花费降序，共 ${rows.length} 个会话` : '';
  $$('#usage-conv-table .conv-row').forEach((tr) => {
    tr.addEventListener('click', () => loadUsageConversation(tr.dataset.convKey));
  });
}

async function loadUsageConversation(key) {
  usageState.convKey = key;
  $('#usage-conv-key').textContent = key;
  const tbody = $('#usage-turns-table tbody');
  try {
    const view = await api(`/v1/console/usage/conversations/${encodeURIComponent(key)}`);
    if (usageState.convKey !== key) return; // 快速切行时丢弃过期响应
    const symbol = view.symbol ?? '';
    const turns = view.turns ?? [];
    tbody.innerHTML = turns.map((row) => `
      <tr>
        <td>${fmtTime(row.endedAt || row.startedAt)}</td>
        <td><code>${escapeHtml(row.model ?? '—')}</code></td>
        <td>${fmtTokens(tokensOf(row.buckets))}</td>
        <td>${fmtCost(row.cost, symbol)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="muted">该会话没有逐轮明细（全部被投影基线覆盖）</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">加载失败：${escapeHtml(error.message)}</td></tr>`;
  }
}

function renderUsagePrices(prices) {
  const symbol = prices.symbol ?? '';
  const models = Object.entries(prices.models ?? {}).map(([name, m]) => {
    const off = m.off ?? {};
    const parts = [
      `输入 ${fmtCost(off.input ?? 0, symbol)}/M`,
      off.cacheHit !== undefined ? `缓存读 ${fmtCost(off.cacheHit, symbol)}/M` : null,
      off.output !== undefined ? `输出 ${fmtCost(off.output, symbol)}/M` : null,
    ].filter(Boolean).join(' · ');
    return `<li><code>${escapeHtml(name)}</code>（${escapeHtml(m.label ?? name)}）：${parts}</li>`;
  }).join('') || '<li>价目表为空</li>';
  $('#usage-prices').innerHTML = `<ul class="q-list mb-0">${models}</ul>`
    + `<div class="mt-1">峰时系数 ${prices.peakWindows ?? '—'}；节假日 ${prices.holidayCount ?? 0} 天</div>`;
}

$('#btn-refresh-usage').addEventListener('click', loadUsage);
$('#usage-hours').addEventListener('change', loadUsage);

// reset 双确认（服务端还要求 { confirm: 'reset' }，前端二次确认 + 服务端幂等字段）。
$('#btn-usage-reset').addEventListener('click', async () => {
  if (!await confirmDialog('重置用量账本：清空全部历史消费与流量统计，不可恢复。确定继续？', { okText: '第一步确认' })) return;
  if (!await confirmDialog('再次确认：账本将永久清空（审计日志会记录本次操作）。', { okText: '确认重置' })) return;
  try {
    await api('/v1/console/usage/reset', { method: 'POST', body: { confirm: 'reset' } });
    toast('账本已重置');
    loadUsage();
  } catch (error) {
    toast(`重置失败：${error.message}`, 'bad');
  }
});

/* ── 消费端总览视图（docs/console/adapters-overview/PLAN.md）──────────── */

const adaptersState = { data: null, seriesId: null };

async function loadAdapters() {
  const win = $('#adapters-window').value;
  try {
    adaptersState.data = await api(`/v1/console/adapters?window=${encodeURIComponent(win)}`);
    renderAdapters();
  } catch (error) {
    adaptersState.data = null;
    $('#adapters-table tbody').innerHTML = `<tr><td colspan="8" class="muted">加载失败：${escapeHtml(error.message)}</td></tr>`;
    $('#adapters-summary').textContent = '';
    $('#adapters-platforms').innerHTML = '';
    toast(`消费端总览加载失败：${error.message}`, 'bad');
  }
}

function renderAdapters() {
  const { adapters, platforms } = adaptersState.data;
  const symbol = usageState.data?.summary?.symbol ?? '';
  $('#adapters-platforms').innerHTML = (platforms ?? []).map((p) => `
    <span class="badge text-bg-secondary">platform ${escapeHtml(p.platform)}：${fmtCost(p.cost, symbol)} · ${fmtTokens(tokensOf(p.buckets))} tokens</span>`
  ).join('') || '<span class="muted small">平台维度暂无数据</span>';

  const tbody = $('#adapters-table tbody');
  const now = Date.now();
  tbody.innerHTML = adapters.map((a) => {
    const statusBadge = a.unregistered
      ? '<span class="badge text-bg-danger">unregistered</span>'
      : a.enabled === false ? '<span class="badge text-bg-warning">disabled</span>'
        : '<span class="badge text-bg-success">enabled</span>';
    // 消费端唯一来源 = 登记目录：registry（已登记）/ unregistered（只在 turn 记录里出现）。
    const sourceBadge = a.source === 'registry' ? 'registry' : 'unregistered';
    const errorDetail = Object.entries(a.errorCodes ?? {}).map(([code, n]) => `${code}×${n}`).join(', ');
    return `
      <tr data-adapter-id="${escapeHtml(a.id)}" class="adapter-row">
        <td><code>${escapeHtml(a.id)}</code>${a.name && a.name !== a.id ? ` <span class="muted">${escapeHtml(a.name)}</span>` : ''}</td>
        <td>${a.platform ? escapeHtml(a.platform) : '<span class="muted">—</span>'}</td>
        <td><span class="badge text-bg-secondary">${sourceBadge}</span></td>
        <td>${statusBadge}</td>
        <td>${a.turns} / ${a.errors ? `<span class="text-danger" title="${escapeHtml(errorDetail)}">${a.errors}</span>` : '0'}</td>
        <td>${fmtTokens(a.tokens)}</td>
        <td>${fmtCost(a.cost, symbol)}</td>
        <td>${a.lastTurnAt ? fmtAge(now - a.lastTurnAt) : '<span class="muted">从未</span>'}</td>
      </tr>`;
  }).join('') || '<tr><td colspan="8" class="muted">窗口内没有任何消费端流量</td></tr>';
  $('#adapters-summary').textContent = `窗口 ${adaptersState.data.windowHours}h，共 ${adapters.length} 个消费端`;
  $$('#adapters-table .adapter-row').forEach((tr) => {
    tr.addEventListener('click', () => loadAdapterUsage(tr.dataset.adapterId));
  });
}

async function loadAdapterUsage(id) {
  const hours = Number(String($('#adapters-window').value).replace(/h$/, '')) || 24;
  try {
    const series = await api(`/v1/console/adapters/${encodeURIComponent(id)}/usage?hours=${hours}`);
    $('#adapter-chart-id').textContent = id;
    $('#adapter-chart').innerHTML = svgChart(series.buckets, { symbol: series.symbol ?? '' });
    $('#adapter-chart-meta').textContent = maxCost(series.buckets) > 0
      ? `最近 ${series.hours} 小时，峰值 ${fmtCost(maxCost(series.buckets), series.symbol ?? '')}`
      : `最近 ${series.hours} 小时内该消费端没有消费记录`;
    adaptersState.seriesId = id;
  } catch (error) {
    $('#adapter-chart-id').textContent = id;
    $('#adapter-chart').innerHTML = '';
    $('#adapter-chart-meta').textContent = `走势加载失败：${error.message}`;
  }
}

$('#btn-refresh-adapters').addEventListener('click', loadAdapters);
$('#adapters-window').addEventListener('change', loadAdapters);

/* ── 启动 ─────────────────────────────────────────────────────────────── */
checkSession();
