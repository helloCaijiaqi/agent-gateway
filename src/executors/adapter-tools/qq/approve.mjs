// qq 能力宿主：approve（write）——声明式桩，schema/描述来自清单，调用走 common 默认透传。
// pending 平台转发（docs/console/dsh-pending/PLAN.md）：把 DSH 会话的工具审批请求
// 转达给本会话（通知性质、不自动应答）；网关的 pending-forwarder 自动调用。
import { passthrough } from '../common/capability.mjs';

export default passthrough('approve');
