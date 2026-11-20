import { FollowStore } from '../../src/follow-store.ts';
import { FollowOutbox } from '../../src/follow-outbox.ts';
import type { FollowEvent } from './activity-stream.ts';

/** 将单向关注加入现有 Outbox；待批准和不确定状态不能重复请求。 */
export function queueInboundFollow(event: FollowEvent, path = '.data/following.sqlite') {
  const store = new FollowStore(path);
  try {
    const outcome = store.recordInboundFollow(event.eventId, event.accountId, event.followerId, event.occurredAt);
    const status = store.status(event.accountId, event.followerId);
    if (!status && event.accountId !== event.followerId) {
      const box = new FollowOutbox(path);
      let queued = false;
      try { queued = box.enqueue(event.accountId, [{ id: event.followerId, username: event.followerUsername || event.followerId, source: 'inbound-follow' }]) > 0; }
      finally { box.close(); }
      return { outcome, status, queued };
    }
    return { outcome, status, queued: false };
  } finally { store.close(); }
}

/** 只取出已确认完成的回关，欢迎的持久去重由客服模块负责。 */
export function completedInboundFollows(path = '.data/following.sqlite') {
  const store = new FollowStore(path);
  store.close();
  const box = new FollowOutbox(path);
  try { return box.completedInbound(); } finally { box.close(); }
}
