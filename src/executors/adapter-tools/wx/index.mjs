/**
 * WX 平台能力目录（骨架）。
 *
 * wx-adapter 侧的清单（actions-manifest）与能力宿主模块尚未落地；在此之前
 * 本注册表保持为空，adapter-tools 装配时对空注册表显式拒绝——宁可整个平台
 * 没有工具面，也不暴露半套目录（与「宁可缺工具不可静默串线」同一口径）。
 *
 * wx 清单落地后的接入步骤：wx-adapter 产出清单 → 本目录每条清单条目一个
 * 宿主模块（1:1）→ 这里汇聚 → adapter-tools/index.mjs 注册表已就位。
 */
export const CAPABILITIES = Object.freeze([]);
