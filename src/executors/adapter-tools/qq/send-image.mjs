// qq 能力宿主：send_image（write）——声明式桩，schema/描述来自清单，调用走 common 默认透传。
// 多媒体记忆层发送适配（2026-11-24）：chat_media_send 转换后的图片发送落点。
// 决策 12：清单每个条目对应本目录一个宿主模块（1:1，无孤儿无例外）。
import { passthrough } from '../common/capability.mjs';

export default passthrough('send_image');
