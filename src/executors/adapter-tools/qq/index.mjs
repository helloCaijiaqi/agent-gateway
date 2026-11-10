/**
 * QQ 平台能力注册表：汇聚本平台全部能力宿主模块（与 actions-manifest.json 1:1）。
 *
 * 新增能力 = 桥接清单加条目 + 本目录加宿主模块（1:1）+ 这里 import 一行。
 * 覆盖完整性由 common/executor 装配时双向孤儿检测强制：清单有条目没模块、
 * 有模块没条目都直接拒绝装配。
 *
 * 目前全部能力都是声明式桩（默认透传）；复杂能力在对应宿主模块里写 handle。
 */
import { createAdapterToolsExecutor } from '../common/executor.mjs';

import sendText from './send-text.mjs';
import reply from './reply.mjs';
import markRead from './mark-read.mjs';
import sendMessage from './send-message.mjs';
import sendBurst from './send-burst.mjs';
import sendGroupMessage from './send-group-message.mjs';
import sendPrivateMessage from './send-private-message.mjs';
import poke from './poke.mjs';
import wait from './wait.mjs';
import setWake from './set-wake.mjs';
import socialState from './social-state.mjs';
import getPrompt from './get-prompt.mjs';
import getUnread from './get-unread.mjs';
import getRecent from './get-recent.mjs';
import getMyRecent from './get-my-recent.mjs';
import getMessageDetail from './get-message-detail.mjs';
import getMessageImages from './get-message-images.mjs';
import getForwardMsg from './get-forward-msg.mjs';
import getActiveMembers from './get-active-members.mjs';
import getGroupMembers from './get-group-members.mjs';
import listGroups from './list-groups.mjs';
import getHistory from './get-history.mjs';
import listStickers from './list-stickers.mjs';
import getStickerImage from './get-sticker-image.mjs';
import getSelfImage from './get-self-image.mjs';
import sendSticker from './send-sticker.mjs';
import collectSticker from './collect-sticker.mjs';
import stickerNote from './sticker-note.mjs';
import setStickerRemark from './set-sticker-remark.mjs';
import sendVoice from './send-voice.mjs';
import listVoices from './list-voices.mjs';
import memoryAppend from './memory-append.mjs';
import memoryQuery from './memory-query.mjs';
import memoryRemove from './memory-remove.mjs';
import memoryClear from './memory-clear.mjs';
import ask from './ask.mjs';
import approve from './approve.mjs';

export const CAPABILITIES = Object.freeze([
  sendText, reply, markRead, sendMessage, sendBurst, sendGroupMessage, sendPrivateMessage,
  poke, wait, setWake, socialState, getPrompt, getUnread, getRecent, getMyRecent,
  getMessageDetail, getMessageImages, getForwardMsg, getActiveMembers, getGroupMembers,
  listGroups, getHistory, listStickers, getStickerImage, getSelfImage, sendSticker,
  collectSticker, stickerNote, setStickerRemark, sendVoice, listVoices,
  memoryAppend, memoryQuery, memoryRemove, memoryClear,
  ask, approve,
]);

/** 便捷工厂：qq 能力注册表绑定到通用装配机器（测试与直调用）。 */
export function createQqToolsExecutor(options) {
  return createAdapterToolsExecutor({ ...options, capabilities: CAPABILITIES });
}
