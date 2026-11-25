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
 *  - **写侧快照去重（2026-11-26）**：热加载扫描/重连会高频重复追加内容完全
 *    相同的 register 事件（单条内嵌全量工具 schema 4KB+，曾 12 天堆到 63MB）。
 *    同服务 snapshot 摘要与上一条相同时只落 snapshotHash 引用行（contracts
 *    schema 可选字段），快照内容变化才落全量。去重索引是进程内存侧车——重启
 *    后首条 register 必落全量（不为去重读整份台账），重启频率远低于扫描频率，
 *    增量仍砍 >95%。unregister/reject 永远落全量（纠正性事件，保持自含）。
 *  - **大小轮转（2026-11-26）**：追加前检查体积，超 rotateBytes 把现行文件
 *    gzip 成 `<file>.<时间戳>.gz` 归档后重新开始，最多留 keepArchives 份。
 *    readAll 只读现行文件——控制台审计页展示「最近的注册活动」，更早的历史
 *    在归档里人可读（gunzip 即看），不做透明回读（避免审计页随历史无限变慢）。
 *    轮转失败（磁盘满等）记日志不阻断追加。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
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

/** 快照内容摘要（写侧去重的比对键）：无快照返回 null。 */
function snapshotDigest(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

/**
 * @param {object} options
 * @param {string} options.file   台账 JSONL 路径
 * @param {() => number} [options.now]
 * @param {number} [options.rotateBytes]   现行文件轮转阈值（默认 8MB）
 * @param {number} [options.keepArchives]  归档保留份数（默认 5，超出删最旧）
 * @param {object} [options.logger]
 */
export function createRegistrationLedger({
  file,
  now = Date.now,
  rotateBytes = 8 * 1024 * 1024,
  keepArchives = 5,
  logger = console,
} = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });

  /** 进程生命周期内的「serviceId → 最近一次落盘快照摘要」侧车索引。 */
  const lastSnapshotHash = new Map();

  /** 超阈值则 gzip 归档现行文件并删除原文件（下一次追加自然开新卷）。 */
  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      return; // 文件还不存在（首条追加前），无需轮转
    }
    if (size < rotateBytes) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = `${file}.${stamp}.gz`;
    try {
      const raw = fs.readFileSync(file);
      fs.writeFileSync(archive, zlib.gzipSync(raw));
      fs.unlinkSync(file);
      const dir = path.dirname(file);
      const base = path.basename(file);
      const archives = fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.`) && f.endsWith('.gz'))
        .sort();
      while (archives.length > keepArchives) {
        fs.unlinkSync(path.join(dir, archives.shift()));
      }
      logger?.info?.(`[ledger] rotated: ${base} (${Math.round(size / 1024 / 1024)}MB) -> ${path.basename(archive)}`);
    } catch (error) {
      // 轮转失败绝不阻断追加（审计完整性优先于体积治理），下条事件再试。
      logger?.error?.(`[ledger] rotate failed: ${error?.message ?? error}`);
    }
  }

  /**
   * 追加一条事件。at 缺省取 now()；snapshot 若未显式提供且是 register 动作，
   * 由调用方传入脱敏后的登记内容（本层不做自动推导——调用方才知道装没装载成功）。
   * register 的 snapshot 与该服务上一条完全相同时，省略 snapshot 只落 snapshotHash。
   */
  function append(event) {
    rotateIfNeeded();
    let record = { at: now(), ...event };
    const digest = snapshotDigest(record.snapshot);
    if (digest) {
      const known = lastSnapshotHash.get(record.serviceId);
      if (record.action === 'register' && known === digest) {
        const { snapshot, ...rest } = record;
        void snapshot;
        record = { ...rest, snapshotHash: digest };
      } else {
        record = { ...record, snapshotHash: digest };
        lastSnapshotHash.set(record.serviceId, digest);
      }
    }
    const parsed = parseRegistrationLedgerEvent(record);
    fs.appendFileSync(file, `${JSON.stringify(parsed)}\n`, 'utf8');
    return parsed;
  }

  /** 磁盘上的台账规模（排障用：行数 + 坏行数），不做全量解析。 */
  function stats() {
    if (!fs.existsSync(file)) return { events: 0, bytes: 0 };
    const raw = fs.readFileSync(file);
    return { events: raw.toString('utf8').split('\n').filter((l) => l.trim()).length, bytes: raw.length };
  }

  /** 读侧：只读现行文件（历史在 .gz 归档里），坏行跳过并计数。 */
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

  return { append, readAll, stats };
}
