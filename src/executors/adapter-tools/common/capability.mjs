/**
 * 平台能力模块契约（决策 11/12）：
 *
 *   - 清单（actions-manifest.json）管 what：有什么能力；
 *   - common（本目录）管 how：装配机器 + 共享机制 + 默认透传，禁止任何平台业务字样；
 *   - 平台子目录（各平台的文件夹）管能力本体：每条清单条目一个宿主模块，1:1，无孤儿无例外。
 *
 * 宿主模块 default export 的形状：
 *   {
 *     type: string      线缆动作名，与清单条目一一对应（装配时双向孤儿检测）；
 *     describe?: fn     可选 (entry) => string，覆盖工具描述（缺省 = 清单 summary + kind 前缀）；
 *     schema?:   fn     可选 (entry) => object，覆盖 inputSchema（缺省 = 透传 payloadSchema）；
 *     handle?:   fn     可选 ({ action, entry, ctx, adapter }) => result，复杂能力的
 *                       完整平台逻辑；缺省走默认透传（信封组装 + 签名投递 + 回执校验）。
 *   }
 */

/** 声明式桩：简单能力的全部代码——只声明自己是谁，其余交给默认透传。 */
export function passthrough(type) {
  if (typeof type !== 'string' || !type) throw new TypeError('passthrough: type is required');
  return Object.freeze({ type });
}
