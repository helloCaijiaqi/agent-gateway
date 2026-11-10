/**
 * adapter-tools 装配入口（包级 glue，非 common——本文件允许出现平台名）。
 *
 * 平台 → 能力注册表的分发表在这里：新适配器 = 新平台子文件夹 + 平台能力注册表
 * + 本文件一行；common/ 永不为单个平台改动（决策 11/12）。
 */
import { createAdapterToolsExecutor as assemble } from './common/executor.mjs';
import { CAPABILITIES as QQ_CAPABILITIES } from './qq/index.mjs';
import { CAPABILITIES as WX_CAPABILITIES } from './wx/index.mjs';

const PLATFORM_REGISTRIES = { qq: QQ_CAPABILITIES, wx: WX_CAPABILITIES };

export { fetchAdapterManifest } from './common/manifest.mjs';

/**
 * @param {Array<{adapter: object, manifest: object, capabilities?: object[]}>} fetched
 *   每个适配器一份清单（main.mjs 逐个 fetch 后传入；失败的适配器不应出现在这里）。
 *   capabilities 可选覆盖：缺省按 adapter.platform 查平台注册表（测试/预接场景用）。
 */
export function createAdapterToolsExecutor({ adapters, ...rest }) {
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new TypeError('createAdapterToolsExecutor: at least one fetched {adapter, manifest} is required');
  }
  const assembled = adapters.map(({ adapter, manifest, capabilities }) => {
    const resolved = capabilities ?? PLATFORM_REGISTRIES[adapter?.platform];
    if (!resolved || resolved.length === 0) {
      throw new TypeError(`adapter-tools: platform "${adapter?.platform}" has no capability registry yet (modules not landed)`);
    }
    return { adapter, manifest, capabilities: resolved };
  });
  return assemble({ adapters: assembled, ...rest });
}
