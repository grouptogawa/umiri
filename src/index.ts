/**
 * 基本的事件接口定义，在umiri总线上发布的事件必须实现此接口
 *
 * 除了这个最基本的 `getType()` 方法外，强烈建议事件类实现一个静态的 `getType()` 方法
 *
 * 总线上有对静态方法的优先调用，这样可以很大程度上减少事件实例化的开销
 *
 * `getType()` 返回的结果应该是一个整数数组，表示该事件所属的类型，这个类型推荐通过枚举来进行定义
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

// 事件类的类型定义，用于描述事件类的构造函数签名
type EventClass<T extends IUmiriEvent = IUmiriEvent> = new (
    ...args: any[]
) => T;

/**
 * 事件处理器的结构定义
 *
 * 建议通过 `on()` 函数来创建事件处理器实例
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
        // 优先用静态方法，减少实例化开销
        if (
            Object.prototype.hasOwnProperty.call(cls, "getType") &&
            typeof (cls as any).getType === "function"
        ) {
            types = (cls as any).getType();
        } else {
            // 用实例方法
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
/*
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
 */

/**
 * 创建事件处理器的构建器
 *
 * 构建器通过链式调用的方法来传入参数，但是handle总是应该在最后被调用，只有handle返回的对象才包含build方法
 *
 * 示例：
 * ```ts
 * const handler = on(EventA, EventB)
 *   .priority(10)
 *   .timeout(5000)
 *   .block(true)
 *   .handle(async (e) => {
 * 	  // 处理事件的逻辑
 * 	  return true; // 返回是否处理成功
 *   })
 *   .build();
 * ```
 *
 * @param args 事件类数组
 * @returns 事件处理器构建器
 */
export function on<
    Classes extends EventClass<any>[],
    T extends IUmiriEvent = InstanceType<Classes[number]>
>(...classes: Classes) {
    const targets = extractTypes(classes);
    let _priority = 0,
        _block = false,
        _timeout = 0;
    return {
        priority(val: number) {
            _priority = val;
            return this;
        },
        timeout(val: number) {
            _timeout = val;
            return this;
        },
        block(val: boolean) {
            _block = val;
            return this;
        },
        handle(fn: (e: T) => Promise<boolean>) {
            return {
                build(): EventHandler<T> {
                    return Object.freeze({
                        // 冻结以防止被修改
                        targets,
                        priority: _priority,
                        block: _block,
                        timeout: _timeout,
                        handle: fn
                    });
                }
            };
        }
    };
}

// 中间件类型定义

// 在注册处理器之前执行的中间件
type BeforeRegisterMiddleware = (handler: EventHandler) => {
    handler: EventHandler;
    cancel: boolean; // true 表示不再继续注册
};

// 在注册处理器之后执行的中间件
type AfterRegisterMiddleware = (handler: EventHandler) => void;

// 在注销处理器之前执行的中间件
type BeforeUnregisterMiddleware = (handler: EventHandler) => {
    handler: EventHandler;
    cancel: boolean;
};

// 在注销处理器之后执行的中间件
type AfterUnregisterMiddleware = (handler: EventHandler) => void;

// 在发布事件之前执行的中间件
type BeforePublishMiddleware = (event: IUmiriEvent) => {
    event: IUmiriEvent;
    cancel: boolean;
};

// 在优先级检查之前执行的中间件
type BeforePriorityCheckMiddleware = (
    priority: number,
    handlers: EventHandler[]
) => {
    handlers: EventHandler[];
    cancel: boolean;
};

// 在阻断检查之前执行的中间件
type BeforeBlockCheckMiddleware = (handler: EventHandler) => {
    handler: EventHandler;
    cancel: boolean;
};

// 在发布事件之后执行的中间件
type AfterPublishMiddleware = (
    event: IUmiriEvent,
    executedHandlers: EventHandler[]
) => void;

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
    // 之前用的都是数组而不是Set，换用Set会比较方便
    private handlerMap: Map<number, Map<number, Set<EventHandler>>> = new Map(); // 优先级到事件类型到处理器集合的映射
    private priorities: number[] = []; // 已注册的优先级列表

    private beforeRegisterMiddlewares: BeforeRegisterMiddleware[] = [];
    private afterRegisterMiddlewares: AfterRegisterMiddleware[] = [];
    private beforeUnregisterMiddlewares: BeforeUnregisterMiddleware[] = [];
    private afterUnregisterMiddlewares: AfterUnregisterMiddleware[] = [];
    private beforePublishMiddlewares: BeforePublishMiddleware[] = [];
    private beforePriorityCheckMiddlewares: BeforePriorityCheckMiddleware[] =
        [];
    private beforeBlockCheckMiddlewares: BeforeBlockCheckMiddleware[] = [];
    private afterPublishMiddlewares: AfterPublishMiddleware[] = [];

    /**
     * 注册一个事件处理器到事件总线
     *
     * 事件处理器可以通过 `on()` 函数来创建
     *
     * 被注册的处理器会根据其优先级和订阅的事件类型被存储起来，以便在发布事件时进行调用
     *
     * @param handler 事件处理器
     * @return 注销函数
     */
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
            typeMap = new Map<number, Set<EventHandler>>();
            this.handlerMap.set(priority, typeMap);
            this.priorities.push(priority);
            this.priorities.sort((a, b) => b - a);
        }

        // 将 handler 注册到它订阅的每一个事件类型上
        for (const t of new Set(targets)) {
            let bucket = typeMap.get(t);
            if (!bucket) typeMap.set(t, (bucket = new Set<EventHandler>()));
            bucket.add(handler);
        }

        // 执行 afterRegister 中间件
        this.afterRegisterMiddlewares.forEach((mw) => mw(currentHandler));

        // 返回注销函数
        return () => this.unregister(handler);
    }

    /**
     * 注销一个事件处理器
     *
     * 显然这个函数用起来不是很爽，所以其实 `register()` 就会返回一个对应的注销函数，这个用起来更舒服
     * @param handler 事件处理器
     */
    unregister(handler: EventHandler): void {
        // 执行 beforeUnregister 中间件
        const beforeResult = this.beforeUnregisterMiddlewares.reduce(
            (acc, mw) => {
                if (acc.cancel) return acc;
                const res = mw(acc.handler);
                return res ? res : acc;
            },
            { handler, cancel: false }
        );
        if (beforeResult.cancel) {
            return;
        }
        const currentHandler = beforeResult.handler;

        const { priority, targets } = currentHandler;
        const typeMap = this.handlerMap.get(priority);
        if (!typeMap) return;

        // 从该优先级下的每个目标事件类型里移除 handler
        for (const t of new Set(targets)) {
            const bucket = typeMap.get(t);
            if (!bucket) continue;
            bucket.delete(handler);
            if (bucket.size === 0) typeMap.delete(t);
        }

        // 如果该优先级下已经没有任何事件类型了，删除这个优先级
        if (typeMap.size === 0) {
            this.handlerMap.delete(priority);
            this.priorities = this.priorities.filter((p) => p !== priority);
        }

        // 执行 afterUnregister 中间件
        this.afterUnregisterMiddlewares.forEach((mw) => mw(currentHandler));
    }

    /**
     * 发布一个事件到事件总线
     * @param event 事件对象
     */
    async publish(event: IUmiriEvent): Promise<void> {
        // 初始化一个用于记录处理情况的数组
        const executedHandlers: EventHandler[] = [];

        // 执行 beforePublish 中间件
        const beforeResult = this.beforePublishMiddlewares.reduce(
            (acc, mw) => {
                if (acc.cancel) return acc;
                const res = mw(acc.event);
                return res ? res : acc;
            },
            { event, cancel: false }
        );
        if (beforeResult.cancel) {
            return;
        }
        event = beforeResult.event; // 替换事件

        // 获取当前事件的类型标识数组
        const eventTypes = event.getType();

        let blocked = false;
        const stalePriorities: number[] = []; // 记录需要清理的优先级
        const prioritiesSnapshot = [...this.priorities]; // 对当前的优先级列表做一个快照，避免在遍历过程中被修改

        try {
            // 遍历所有优先级
            for (let priority of prioritiesSnapshot) {
                const typeMap = this.handlerMap.get(priority);
                if (!typeMap) {
                    // 没有这个优先级的映射了，把它记为过期优先级
                    stalePriorities.push(priority);
                    continue;
                }

                // 收集本优先级下，与当前事件类型匹配的所有 handler
                const bag = new Set<EventHandler>();
                for (const t of eventTypes) {
                    const bucket = typeMap.get(t);
                    if (bucket) bucket.forEach((h) => bag.add(h));
                }
                let validHandlers = Array.from(bag);

                // 执行 onPrioritieCheck 中间件
                const priorityCheckResult =
                    this.beforePriorityCheckMiddlewares.reduce(
                        (acc, mw) => {
                            if (acc.cancel) return acc;
                            const res = mw(priority, acc.handlers);
                            return res ? res : acc;
                        },
                        { handlers: validHandlers, cancel: false }
                    );
                if (priorityCheckResult.cancel) {
                    continue; // 跳过本优先级的处理
                }

                // 更新可用的handler的列表
                validHandlers = priorityCheckResult.handlers;

                if (validHandlers.length === 0) continue; // 本优先级下没有有效 handler，继续下一个优先级

                // 并发执行当前优先级下的所有有效 handler
                //
                // 本来是这么写的，但是被GPT桑狠狠的挑刺了，sad
                //
                // const results = await Promise.all(
                //     validHandlers.map((h) => {
                //         try {
                //             const timeoutPromise =
                //                 h.timeout > 0
                //                     ? new Promise<boolean>((resolve) =>
                //                           setTimeout(
                //                               () => resolve(false),
                //                               h.timeout
                //                           )
                //                       )
                //                     : Promise.resolve(false); // 超时为0时不启用超时
                //                                               // ⬆️ 并非不启用，会导致不设置超时的时候直接不执行这个处理器，我草我能写出来这玩意纯属神人
                //             // Promise 竞速
                //             return Promise.race([h.handle(event), timeoutPromise]);
                //         } catch {
                //             // handler 抛异常则视为未处理成功
                //             return Promise.resolve(false);
                //         }
                //     })
                // );
                //
                // 这下真不如vibe了（

                const results = await Promise.all(
                    validHandlers.map((h) => {
                        // 包一层，确保任何异常/拒绝都变成 false
                        const run = () =>
                            Promise.resolve(h.handle(event))
                                .then((v) => v === true) // 规范化为 boolean
                                .catch(() => false); // 避免运行处理器时抛异常导致外层的 all 整个拒绝

                        // timeout=0 时不启用超时竞速，直接执行
                        if (!h.timeout || h.timeout <= 0) {
                            return run();
                        }

                        return new Promise<boolean>((resolve) => {
                            const timer = setTimeout(
                                () => resolve(false),
                                h.timeout
                            );
                            run().then((v) => {
                                clearTimeout(timer);
                                resolve(v);
                            });
                        });
                    })
                );

                // 检查阻断逻辑：block === true 且结果为 true 时阻断后续优先级
                for (let i = 0; i < validHandlers.length; i++) {
                    if (validHandlers[i] && results[i] === true) {
                        if (results[i] === true) {
                            executedHandlers.push(validHandlers[i]!); // 记录已执行成功的处理器
                        }
                        if (validHandlers[i]!.block) {
                            // 执行 onBlockCheck 中间件
                            const blockCheckResult =
                                this.beforeBlockCheckMiddlewares.reduce(
                                    (acc, mw) => {
                                        if (acc.cancel) return acc;
                                        if (!acc.handler) return acc; // 照理来讲，因为上面取处理器的时候用了可选操作，这里其实是安全的，但是加个保护以防万一
                                        const res = mw(acc.handler);
                                        return res ? res : acc;
                                    },
                                    { handler: validHandlers[i], cancel: false }
                                );
                            if (!blockCheckResult.cancel) {
                                // 如果中间件没有取消阻断
                                blocked = true;
                                break; // 跳出当前优先级
                            }
                        }
                    }
                }

                // 如果被阻断，跳出优先级循环
                if (blocked) break;
            }
        } finally {
            // 执行 afterPublish
            this.afterPublishMiddlewares.forEach((mw) =>
                mw(event, executedHandlers)
            );
            // 统一清理失效优先级
            if (stalePriorities.length > 0) {
                const stale = new Set(stalePriorities);
                this.priorities = this.priorities.filter((p) => !stale.has(p));
            }
        }
    }

    /**
     * 添加一个在注册处理器之前执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useBeforeRegister((handler) => {
     *    // 可以拦截、修改 handler 或者取消注册
     *    return { handler, cancel: false };
     * });
     * ```
     *
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useBeforeRegister(mw: BeforeRegisterMiddleware) {
        this.beforeRegisterMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在注册处理器之后执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useAfterRegister((handler) => {
     *    // 可以在这里执行一些日志记录等操作
     * });
     * ```
     *
     * @param mw
     * @returns
     */
    useAfterRegister(mw: AfterRegisterMiddleware) {
        this.afterRegisterMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在注销处理器之前执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useBeforeUnregister((handler) => {
     *    // 可以拦截、修改 handler 或者取消注销
     *   return { handler, cancel: false };
     * });
     * ```
     *
     * 这个中间件其实有点意味不明，但是还是放这里，我也不知道会不会有用
     *
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useBeforeUnregister(mw: BeforeUnregisterMiddleware) {
        this.beforeUnregisterMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在注销处理器之后执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useAfterUnregister((handler) => {
     *    // 可以在这里执行一些日志记录等操作
     * });
     * ```
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useAfterUnregister(mw: AfterUnregisterMiddleware) {
        this.afterUnregisterMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在发布事件之前执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useBeforePublish((event) => {
     *    // 可以拦截、修改 event 或者取消发布
     *    return { event, cancel: false };
     * });
     * ```
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useBeforePublish(mw: BeforePublishMiddleware) {
        this.beforePublishMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在优先级检查之前执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useBeforePriorityCheck((priority, handlers) => {
     *    // 可以拦截、修改 handlers 或者取消本优先级的处理
     *    return { handlers, cancel: false };
     * });
     * ```
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useBeforePriorityCheck(mw: BeforePriorityCheckMiddleware) {
        this.beforePriorityCheckMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在阻断检查之前执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useBeforeBlockCheck((handler) => {
     *    // 可以拦截、修改 handler 或者取消阻断
     *    return { handler, cancel: false };
     * });
     * ```
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useBeforeBlockCheck(mw: BeforeBlockCheckMiddleware) {
        this.beforeBlockCheckMiddlewares.push(mw);
        return this;
    }

    /**
     * 添加一个在发布事件之后执行的中间件
     *
     * 中间件示例：
     * ```ts
     * bus.useAfterPublish((event, executedHandlers) => {
     *    // 可以在这里执行一些日志记录等操作
     * });
     * ```
     * @param mw 中间件函数
     * @returns 事件总线实例，以支持链式调用
     */
    useAfterPublish(mw: AfterPublishMiddleware) {
        this.afterPublishMiddlewares.push(mw);
        return this;
    }
}
