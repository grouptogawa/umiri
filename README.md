# umiri

> 🚧 文档还在施工哦！

`Umiri` 是一个为 TypeScript 项目设计的轻量级事件总线实现，采用基于优先级的事件处理机制。

设计灵感源自 [Nonebot2](https://github.com/nonebot/nonebot2) 的事件总线架构，适用于像聊天机器人这样的需要处理大量异步事件的场景。

## 特性

- **零依赖**
- **基于优先级调度**
- **支持超时控制**
- **支持中间件机制**
- **类型友好**

---

## 安装

```bash
npm install @togawa-group/umiri
# or
bun add @togawa-group/umiri
```

## 快速开始

```typescript
import { UmiriEventBus, on } from "@togawa-group/umiri";

// 定义事件类型枚举
enum EventType {
    MESSAGE = 100,
    FRIEND_MESSAGE,
    GROUP_MESSAGE
}

// 定义事件结构
class FriendMessageEvent {
    static getType(): EventType[] {
        return [EventType.MESSAGE, EventType.FRIEND_MESSAGE];
    }
    getType(): EventType[] {
        return [EventType.MESSAGE, EventType.FRIEND_MESSAGE];
    }
}

class GroupMessageEvent {
    static getType(): EventType[] {
        return [EventType.MESSAGE, EventType.GROUP_MESSAGE];
    }
    getType(): EventType[] {
        return [EventType.MESSAGE, EventType.GROUP_MESSAGE];
    }
}

// 创建事件总线实例
const eb = new UmiriEventBus();

// 注册好友消息处理器
const friendHandler = on(FriendMessageEvent)
    .priority(10) // 优先级高的先执行
    .timeout(5000) // 超时控制（ms），默认不超时（0）
    .block(true) // 若处理成功则阻断后续低优先级处理器
    .handle(async (event) => {
        console.log("处理好友消息事件", event);
        return true; // 必须返回 boolean
    })
    .build();

eb.register(friendHandler);

// 注册群消息处理器
const groupHandler = on(GroupMessageEvent)
    .priority(5)
    .handle(async (event) => {
        console.log("处理群消息事件", event);
        return true;
    })
    .build();

eb.register(groupHandler);

// 发布事件（建议在 async 函数中执行）
(async () => {
    await eb.publish(new FriendMessageEvent());
    await eb.publish(new GroupMessageEvent());
})();
```

## 中间件支持

```typescript
eb.useBeforePublish((event) => {
    console.log("准备发布事件:", event);
    return { event, cancel: false };
}).useAfterPublish((event, executed) => {
    console.log(
        `事件 ${event.constructor.name} 已执行 ${executed.length} 个处理器`
    );
});
```
