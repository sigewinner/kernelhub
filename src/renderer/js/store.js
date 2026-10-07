/**
 * store.js —— 轻量订阅式状态仓库（零依赖）
 *
 * 为什么不用 Proxy / 响应式框架：
 *   本项目的状态规模很小（一份全局启动状态 + 几份视图局部状态），
 *   显式 set/patch 比自动追踪更可预测，也更容易在视图卸载时彻底退订。
 *
 * 用法：
 *   const store = createStore({ a: 1 });
 *   const off = store.subscribe((state, changed) => { ... });   // 全量订阅
 *   const off2 = store.select((s) => s.queue.counts, (counts) => { ... }); // 选择器订阅
 *   store.set({ a: 2 });        // 浅合并
 *   store.update((s) => ({ a: s.a + 1 }));  // 函数式更新
 */

/** 浅比较：判断 patch 是否真的改变了值（避免无意义的重渲染） */
function shallowEqualPatch(current, patch) {
  const keys = Object.keys(patch);
  for (const key of keys) {
    if (!Object.is(current[key], patch[key])) return false;
  }
  return true;
}

/**
 * 创建一个仓库。
 * @param {object} initial 初始状态
 * @param {object} [options]
 * @param {(msg: string) => void} [options.onWarn] 订阅者抛异常时的报告钩子
 */
export function createStore(initial = {}, options = {}) {
  let state = { ...initial };
  const listeners = new Set();
  const onWarn = typeof options.onWarn === 'function' ? options.onWarn : null;

  /** 通知所有订阅者；单个订阅者抛异常不影响其它订阅者 */
  function emit(changedKeys, prev) {
    for (const entry of Array.from(listeners)) {
      try {
        entry(state, changedKeys, prev);
      } catch (err) {
        if (onWarn) onWarn(`状态订阅者异常：${err && err.message ? err.message : String(err)}`);
        else console.error('[store] 订阅者异常', err);
      }
    }
  }

  function commit(next, changedKeys, prev) {
    if (!changedKeys.length) return state;
    state = next;
    emit(changedKeys, prev);
    return state;
  }

  return {
    /** 读取整个状态（只读快照，勿直接改） */
    get() {
      return state;
    },

    /** 读取单个键 */
    pick(key) {
      return state[key];
    },

    /** 浅合并写入；返回变更的键数组 */
    set(patch) {
      if (!patch || typeof patch !== 'object') return [];
      if (shallowEqualPatch(state, patch)) return [];
      const prev = state;
      const next = { ...state, ...patch };
      const changed = Object.keys(patch).filter((k) => !Object.is(prev[k], patch[k]));
      commit(next, changed, prev);
      return changed;
    },

    /** 函数式更新：fn 返回要合并的补丁 */
    update(fn) {
      const patch = fn(state);
      return this.set(patch);
    },

    /**
     * 全量订阅。
     * @param {(state: object, changed: string[], prev: object) => void} fn
     * @returns {() => void} 退订函数
     */
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    /**
     * 选择器订阅：只有 selector 结果变化时才回调。
     * @param {(state: object) => any} selector
     * @param {(value: any, state: object) => void} fn
     * @param {(a: any, b: any) => boolean} [equals] 默认 Object.is
     */
    select(selector, fn, equals = Object.is) {
      let last = selector(state);
      return this.subscribe((next) => {
        const value = selector(next);
        if (equals(value, last)) return;
        const prev = last;
        last = value;
        fn(value, next, prev);
      });
    },

    /** 批量订阅，返回一个统一的退订函数（视图卸载时最常用） */
    subscribeAll(...fns) {
      const offs = fns.map((fn) => this.subscribe(fn));
      return () => offs.forEach((off) => off());
    },
  };
}

/**
 * 视图局部状态：与全局 store 分开，避免视图私有 UI 状态污染全局。
 * 语义与 createStore 相同，只是多了一个 dispose() 便于一次性清理。
 */
export function createViewState(initial = {}, options = {}) {
  const store = createStore(initial, options);
  const offs = [];
  return {
    ...store,
    /** 记录一个退订函数，dispose 时统一释放 */
    track(off) {
      if (typeof off === 'function') offs.push(off);
      return off;
    },
    dispose() {
      while (offs.length) {
        const off = offs.pop();
        try {
          off();
        } catch {
          /* 退订失败不影响其它清理 */
        }
      }
    },
  };
}
