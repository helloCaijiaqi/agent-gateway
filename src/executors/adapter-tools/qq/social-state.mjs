// qq 能力宿主：social_state（read）——声明式桩，schema/描述来自清单，调用走 common 默认透传。
// 决策 12：清单每个条目对应本目录一个宿主模块（1:1，无孤儿无例外）。
import { passthrough } from '../common/capability.mjs';

export default passthrough('social_state');
