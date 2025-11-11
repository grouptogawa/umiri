let _eventSeq = 0;

/**
 * 基本的事件接口定义，在umiri总线上发布的事件必须实现此接口
 *
 * getType() 返回的结果应该是一个整数数组，表示该事件所属的类型，这个类型推荐通过枚举来进行定义
 */
export interface IUmiriEvent {
    getType(): number[];
}

/**
 * 事件总线接口定义，描述事件总线的基本功能
 *
 * 因为跟Node风格的事件总线实现差别很大，就不用EventEmitter风格的方法命名了
 */
export interface IUmiriEventBus {
    register(handler: EventHandler): () => void;
    unregister(handler: EventHandler): void;
    publish(event: IUmiriEvent): Promise<void>;
}

// 事件类的类型定义，用于描述实现了IUmiriEvent接口的类的构造函数类型
type EventClass<T extends IUmiriEvent = IUmiriEvent> = new (
    ...args: any[]
) => T;

/**
 * 事件处理器的结构定义
 *
 * - targets: 该处理器订阅的事件类型标识数组
 * - priority: 该处理器的优先级，数值越大优先级越高
 * - block: 如果该处理器处理成功（返回true），是否阻断后续优先级的处理器执行
 * - timeout: 该处理器的超时时间，单位毫秒，超过该时间视为处理失败
 * - handle: 处理函数，接收一个事件对象，返回一个Promise，resolve为true表示处理成功，false表示处理失败
 */
export type EventHandler<T extends IUmiriEvent = IUmiriEvent> = {
    targets: number[];
    priority: number;
    block: boolean;
    timeout: number;
    handle: (event: T) => Promise<boolean>;
};

// 从一组事件类中提取所有唯一的事件类型（的数值标识）
function extractTypes(classes: EventClass[]): number[] {
    const all: number[] = [];
    for (const cls of classes) {
        let types: number[] = [];
        if (typeof (cls as any).getType === "function") {
            types = (cls as any).getType();
        } else {
            try {
                types = new cls().getType();
            } catch {}
        }
        all.push(...types);
    }
    return Array.from(new Set(all));
}

/**
 * 创建事件处理器的构建器
 *
 * 构建器通过链式调用的方法来传入参数，但是handle总是应该在最后被调用，只有handle返回的对象才包含build方法
 *
 * @param args 事件类数组
 * @returns 事件处理器构建器
 */
export function on<
    Classes extends EventClass<any>[],
    T extends IUmiriEvent = InstanceType<Classes[number]>
>(...classes: Classes) {
    const targets = extractTypes(classes);

    // 构造参数链式对象
    const builder = {
        _priority: 0,
        _block: false,
        _timeout: 0,
        priority(val: number) {
            this._priority = val;
            return this;
        },
        timeout(val: number) {
            this._timeout = val;
            return this;
        },
        block(val: boolean) {
            this._block = val;
            return this;
        },
        handle(fn: (event: T) => Promise<boolean>) {
            // 返回含 build 的对象
            const self = this;
            return {
                ...self,
                build(): EventHandler<T> {
                    return {
                        targets,
                        priority: self._priority,
                        block: self._block,
                        timeout: self._timeout,
                        handle: fn
                    };
                }
            };
        }
    };
    return builder;
}

type BeforeRegisterMiddleware = (handler: EventHandler) => {
    handler: EventHandler; // 可以是修改过的新 handler
    cancel: boolean; // true 表示不再继续注册
};

type AfterRegisterMiddleware = (handler: EventHandler) => void;

/**
 * Umiri 是一个简单、轻量且无依赖的基于优先级机制的事件总线。
 *
 * 事件总线内部通过优先级对事件处理器进行排序，优先级高的处理器会先于优先级低的处理器执行。
 * 每个处理器可以订阅多个事件类型，并且可以设置阻断标志和超时时间。
 * 当一个处理器成功处理了一个事件（返回 true）且其阻断标志为 true 时，后续优先级的处理器将不会被执行。
 *
 * 优先级以从大到小的顺序串行执行，在每一个优先级下的所有处理器并发执行。
 */
export class UmiriEventBus implements IUmiriEventBus {
    // private handlerMap: Map<number, EventHandler[]> = new Map(); // 事件类型到处理器集合的映射
    private handlerMap: Map<number, Map<number, EventHandler[]>> = new Map(); // 优先级到事件类型到处理器集合的映射
    private priorities: number[] = []; // 已注册的优先级列表

    private beforeRegisterMiddlewares: BeforeRegisterMiddleware[] = [];
    private afterRegisterMiddlewares: AfterRegisterMiddleware[] = [];

    register(handler: EventHandler): () => void {
        // 执行 beforeRegister 中间件
        const beforeResult = this.beforeRegisterMiddlewares.reduce(
            (acc, mw) => {
                if (acc.cancel) return acc;
                const res = mw(acc.handler);
                return res ? res : acc;
            },
            { handler, cancel: false }
        );
        if (beforeResult.cancel) {
            return () => {};
        }
        const currentHandler = beforeResult.handler;
        const { priority, targets } = currentHandler;

        // 找到该优先级下的类型映射
        let typeMap = this.handlerMap.get(priority);

        if (!typeMap) {
            typeMap = new Map<number, EventHandler[]>();
            this.handlerMap.set(priority, typeMap);
            this.priorities.push(priority);
            this.priorities.sort((a, b) => b - a); // 降序
        }

        // 将 handler 注册到它订阅的每一个事件类型上
        for (const t of targets) {
            const list = typeMap.get(t) ?? [];
            list.push(handler);
            typeMap.set(t, list);
        }

        // 执行 afterRegister 中间件
        this.afterRegisterMiddlewares.forEach((mw) => mw(currentHandler));

        // 返回注销函数
        return () => this.unregister(handler);
    }

    unregister(handler: EventHandler): void {
        const { priority, targets } = handler;
        const typeMap = this.handlerMap.get(priority);
        if (!typeMap) return;

        // 从该优先级下的每个目标事件类型里移除 handler
        for (const t of targets) {
            const list = typeMap.get(t);
            if (!list) continue;

            const index = list.indexOf(handler);
            if (index !== -1) list.splice(index, 1);

            // 该事件类型下已经没有 handler 了，删除这个事件类型
            if (list.length === 0) {
                typeMap.delete(t);
            }
        }

        // 如果该优先级下已经没有任何事件类型了，删除这个优先级
        if (typeMap.size === 0) {
            this.handlerMap.delete(priority);
            this.priorities = this.priorities.filter((p) => p !== priority);
        }
    }

    async publish(event: IUmiriEvent): Promise<void> {
        // 生成当前事件的唯一序列，用于标记去重避免重复分配数组，减少一点开支
        const currentEventSeq = ++_eventSeq;

        // 获取当前事件的类型标识数组
        const eventTypes = event.getType();

        // 遍历所有优先级
        for (const priority of this.priorities) {
            const typeMap = this.handlerMap.get(priority);
            if (!typeMap) {
                // 没有这个优先级的映射了，清理一下 priorities
                this.priorities = this.priorities.filter((p) => p !== priority);
                continue;
            }

            // 收集本优先级下，与当前事件类型匹配的所有 handler
            const validHandlers: EventHandler[] = [];
            for (const t of eventTypes) {
                const list = typeMap.get(t);
                if (!list) continue;
                for (const h of list) {
                    if ((h as any)._lastEventId === currentEventSeq) continue; // 已经处理过了，跳过
                    (h as any)._lastEventId = currentEventSeq;
                    validHandlers.push(h);
                }
            }

            if (validHandlers.length === 0) continue; // 本优先级下没有有效 handler，继续下一个优先级

            // 并发执行当前优先级下的所有有效 handler
            const results = await Promise.all(
                validHandlers.map((h) => {
                    try {
                        const timeoutPromise =
                            h.timeout > 0
                                ? new Promise<boolean>((resolve) =>
                                      setTimeout(
                                          () => resolve(false),
                                          h.timeout
                                      )
                                  )
                                : Promise.resolve(false); // 超时为0时不使用空Promise

                        // handler 执行与超时 Promise 竞速
                        return Promise.race([h.handle(event), timeoutPromise]);
                    } catch {
                        // handler 抛异常则视为未处理成功
                        return Promise.resolve(false);
                    }
                })
            );

            // 检查阻塞逻辑：block === true 且结果为 true 时阻断后续优先级
            for (let i = 0; i < validHandlers.length; i++) {
                if (validHandlers[i]?.block && results[i] === true) {
                    return;
                }
            }
        }
    }
}
