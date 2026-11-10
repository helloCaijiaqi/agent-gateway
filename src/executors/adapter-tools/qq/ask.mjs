// qq 能力宿主：ask（write）——声明式桩，schema/描述来自清单，调用走 common 默认透传。
// pending 平台转发（docs/console/dsh-pending/PLAN.md）：把 DSH 会话的提问转达给
// 本会话（通知性质）；网关的 pending-forwarder 在 GATEWAY_PENDING_FORWARD=on 时
// 自动调用，模型也可经 chat_qq_ask 主动提问。
import { passthrough } from '../common/capability.mjs';

export default passthrough('ask');
