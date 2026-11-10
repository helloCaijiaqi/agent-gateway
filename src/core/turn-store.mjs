/**
 * Turn 的持久化索引（append-only JSONL）。
 *
 * 为什么不用「一个 turn 一个文件」：
 *   入站频率高时会产生大量小文件，Windows 上目录遍历与杀毒扫描都会被拖慢。
 *   JSONL 追加一次写、顺序读，代价可预测；同 id 的后续状态就是再追加一行，
 *   读取时后写覆盖先写（last-write-wins）。
 *
 * 为什么要轮转：
 *   这是运行日志性质的索引，不是审计账本。超过上限时保留最近 N 条重写，
 *   避免一个长期运行的网关把磁盘写满。
 */
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_KEEP = 2000;

export function createTurnStore({
  file,
  maxBytes = DEFAULT_MAX_BYTES,
  keep = DEFAULT_KEEP,
  logger = () => {},
} = {}) {
  /** @type {Map<string, object>} */
  const records = new Map();

  if (file) load();

  function load() {
    try {
      if (!fs.existsSync(file)) return;
      const stat = fs.statSync(file);
      if (stat.size > maxBytes) {
        rotateOnLoad();
        return;
      }
      const raw = fs.readFileSync(file, 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        ingestLine(line);
      }
    } catch (error) {
      logger(`turn-store: failed to load ${file}: ${error?.message ?? error}`);
    }
  }

  /**
   * 超大文件只保留尾部：先整体读入再取最后 keep 行。
   * 8MB 的读取在启动时是可接受的；真正的目的是不让「上次运行写了 2 个月」
   * 变成「这次启动要解析 50 万行」。
   */
  function rotateOnLoad() {
    const raw = fs.readFileSync(file, 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim());
    const tail = lines.slice(-keep);
    for (const line of tail) ingestLine(line);
    rewrite(tail);
    logger(`turn-store: rotated ${file} to ${tail.length} records`);
  }

  function ingestLine(line) {
    try {
      const row = JSON.parse(line);
      if (!row || typeof row.turnId !== 'string') return;
      records.delete(row.turnId);
      records.set(row.turnId, row.record);
    } catch {
      // 半行（进程在写一半时被杀）忽略即可；下一行仍然是完整记录。
    }
  }

  function rewrite(lines) {
    if (!file) return;
    const tmp = `${file}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      logger(`turn-store: failed to rewrite ${file}: ${error?.message ?? error}`);
    }
  }

  function trimMemory() {
    while (records.size > keep) {
      const oldest = records.keys().next().value;
      records.delete(oldest);
    }
  }

  return {
    put(turnId, record) {
      records.delete(turnId);
      records.set(turnId, record);
      trimMemory();
      if (!file) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${JSON.stringify({ turnId, at: Date.now(), record })}\n`, 'utf8');
      } catch (error) {
        // 写失败不能假装成功：调用方会据此决定是否 ack 适配器。
        throw new Error(`turn-store: append failed: ${error?.message ?? error}`);
      }
    },

    get(turnId) {
      return records.get(turnId) ?? null;
    },

    recent(limit = 50) {
      return [...records.entries()].slice(-limit).map(([turnId, record]) => ({ turnId, record }));
    },

    get size() { return records.size; },
  };
}
