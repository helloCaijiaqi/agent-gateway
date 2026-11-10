/**
 * 服务注册台账（V2 P3）：append-only JSONL，一行一个登记事件。
 *
 * 为什么独立一个模块而不塞进 service-registry：
 *   注册/卸载的「历史」与「当前状态」是两回事。装载器只回答「现在登记了谁」；
 *   台账回答「谁在什么时候注册/卸载/被拒过、当时的登记内容长什么样」。P4 UI
 *   的注册审计页、排障时的「这个服务为什么没了」，都只读台账、不碰装载器。
 *
 * 设计选择：
 *  - **append-only**：事件不删不改。错误操作靠追加 unregister/reject 事件纠正，
 *    而不是回写历史——审计记录被静默篡改比缺一条记录严重得多。
 *  - **同步追加**：登记是低频控制面操作（人工放文件/热加载扫描），单次
 *    appendFileSync 的代价可忽略，换来进程崩溃时不丢事件。
 *  - **脱敏在写入侧强制**：snapshot 由 redactRegistration 产出，密钥三字段
 *    （secret/secretFile/secretEnv）一律剔除——台账可能被控制台与运维直接读，
 *    不给「顺手把密钥落进日志」留口子。
 *  - **读侧容错**：手工编辑或磁盘截断产生的坏行跳过并计数，绝不让一条坏行
 *    报废整份台账（与 usage-ledger 同哲学）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseRegistrationLedgerEvent } from './contracts.mjs';

/** 登记内容的脱敏快照：剔除密钥字段，保留其余登记语义。 */
export function redactRegistration(registration) {
  if (!registration || typeof registration !== 'object') return undefined;
  const { secret, secretFile, secretEnv, ...rest } = registration;
  void secret;
  void secretFile;
  void secretEnv;
  return rest;
}

/**
 * @param {object} options
 * @param {string} options.file   台账 JSONL 路径
 * @param {() => number} [options.now]
 */
export function createRegistrationLedger({ file, now = Date.now } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  /** @returns {{events: object[], corrupt: number}} */
  function readAll() {
    if (!fs.existsSync(file)) return { events: [], corrupt: 0 };
    const raw = fs.readFileSync(file, 'utf8');
    const events = [];
    let corrupt = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(parseRegistrationLedgerEvent(JSON.parse(trimmed)));
      } catch {
        corrupt += 1;
      }
    }
    return { events, corrupt };
  }

  /**
   * 追加一条事件。at 缺省取 now()；snapshot 若未显式提供且是 register 动作，
   * 由调用方传入脱敏后的登记内容（本层不做自动推导——调用方才知道装没装载成功）。
   */
  function append(event) {
    const record = parseRegistrationLedgerEvent({ at: now(), ...event });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  }

  /** 磁盘上的台账规模（排障用：行数 + 坏行数），不做全量解析。 */
  function stats() {
    if (!fs.existsSync(file)) return { events: 0, bytes: 0 };
    const raw = fs.readFileSync(file);
    return { events: raw.toString('utf8').split('\n').filter((l) => l.trim()).length, bytes: raw.length };
  }

  return { append, readAll, stats };
}
