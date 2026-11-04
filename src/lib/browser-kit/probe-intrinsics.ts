import { randomUUID } from 'node:crypto';
import type { BrowserContext, CDPSession, Page } from 'playwright';

// Keep source scripts and page-owned state in the main world. Only probe code
// gets lexical bindings to the browser intrinsics saved before source scripts.
const key = '__dlaProbeIntrinsics';
const names = ['Number', 'Math', 'JSON', 'Array', 'Object', 'String', 'Boolean', 'RegExp', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Reflect', 'Error', 'TypeError', 'RangeError', 'parseFloat', 'parseInt', 'isFinite', 'isNaN', 'Function', 'eval', 'BigInt', 'Intl', 'ArrayBuffer', 'DataView', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'encodeURI', 'decodeURI', 'encodeURIComponent', 'decodeURIComponent'];
const installed = new WeakSet<BrowserContext>();

function source(callback: unknown): string {
  const text = typeof callback === 'function' ? `(${callback.toString()})` : String(callback);
  return `(({${names.join(',')}}) => eval(${JSON.stringify(text)}))(globalThis.${key} || globalThis)`;
}

/** CDP bypasses Playwright's main-world serializer, which itself uses Object and
 * Array. Native protocol serialization does not consult page-owned globals. */
class ProbeRealm {
  private session: Promise<CDPSession>;
  private decorated = new WeakSet<object>();
  constructor(private page: Page) {
    this.session = page.context().newCDPSession(page);
    const addInitScript = page.addInitScript.bind(page);
    page.addInitScript = async (script, arg) => {
      if (typeof script === 'function') return addInitScript({ content: `(${source(script)})(${JSON.stringify(arg) ?? 'undefined'})` });
      return addInitScript(script, arg);
    };
    this.decorate(page);
  }

  private async run(callback: unknown, args: unknown[], handle = false): Promise<unknown> {
    const session = await this.session;
    const argument = (value: unknown) => value instanceof ProbeHandle ? { objectId: value.id } : value === undefined ? {} : { value };
    // Runtime.evaluate selects the current main-world context after navigation.
    const receiver = await session.send('Runtime.evaluate', { expression: 'globalThis', returnByValue: false });
    try {
      const result = await session.send('Runtime.callFunctionOn', {
        objectId: receiver.result.objectId!,
        functionDeclaration: `function(...args) { const probe = ${source(callback)}; return ${typeof callback === 'function' ? 'probe(...args)' : 'probe'}; }`,
        arguments: args.map(argument), awaitPromise: true, returnByValue: !handle,
      });
      if (result.exceptionDetails) {
        // failure-class: operational
        throw new Error(`Capture probe evaluation: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
      }
      if (handle && result.result.objectId) return new ProbeHandle(this, session, result.result.objectId);
      if (result.result.unserializableValue) {
        const values: Record<string, number> = { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 };
        return values[result.result.unserializableValue];
      }
      return result.result.value;
    } finally {
      if (receiver.result.objectId) await session.send('Runtime.releaseObject', { objectId: receiver.result.objectId }).catch(() => {});
    }
  }

  evaluate(callback: unknown, args: unknown[], handle = false): Promise<unknown> { return this.run(callback, args, handle); }

  private decorate(value: unknown): unknown {
    if (!value || typeof value !== 'object' || this.decorated.has(value)) return value;
    this.decorated.add(value);
    const target = value as Record<string, unknown>;
    const realm = this;
    if (value === this.page) {
      target.evaluate = (callback: unknown, arg: unknown) => realm.run(callback, [arg]);
      target.evaluateHandle = (callback: unknown, arg: unknown) => realm.run(callback, [arg], true);
    } else if (typeof target.getAttribute === 'function' && typeof target.evaluate === 'function') {
      // Resolve selectors with Playwright's pristine utility world, including its
      // role/text engines. A temporary DOM marker bridges the exact selected node
      // to the main-world probe without depending on page globals for serialization.
      for (const method of ['evaluate', 'evaluateHandle']) target[method] = async (callback: unknown, arg: unknown, options?: { timeout?: number }) => {
        const attribute = `data-blocks-engine-capture-probe-${randomUUID()}`;
        await realm.run((attribute: string) => {
          let index = 0;
          for (const node of document.querySelectorAll('*')) node.setAttribute(attribute, String(index++));
        }, [attribute]);
        try {
          const id = await (target.getAttribute as (name: string, options?: { timeout?: number }) => Promise<string>)(attribute, options);
          const node = await realm.run((selector: string) => document.querySelector(selector), [`[${attribute}="${id}"]`], true);
          await realm.run((attribute: string) => {
            for (const node of document.querySelectorAll(`[${attribute}]`)) node.removeAttribute(attribute);
          }, [attribute]);
          try { return await realm.run(callback, [node, arg], method === 'evaluateHandle'); }
          finally { if (node instanceof ProbeHandle) await node.dispose(); }
        } finally {
          await realm.run((attribute: string) => {
            for (const node of document.querySelectorAll(`[${attribute}]`)) node.removeAttribute(attribute);
          }, [attribute]).catch(() => {});
        }
      };
      if (typeof target.evaluateAll === 'function') target.evaluateAll = async (callback: unknown, arg: unknown) => {
        const nodes = await (target.all as () => Promise<unknown[]>)();
        const handles = await Promise.all(nodes.map(node => (node as { evaluateHandle: (fn: (node: Element) => Element) => Promise<ProbeHandle> }).evaluateHandle(node => node)));
        try {
          const array = await realm.run((...nodes: unknown[]) => nodes, handles, true) as ProbeHandle;
          try { return await realm.run(callback, [array, arg]); } finally { await array.dispose(); }
        } finally { await Promise.all(handles.map(handle => handle.dispose())); }
      };
    }
    for (const method of ['locator', 'getByRole', 'getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle', 'getByTestId', 'first', 'last', 'nth', 'filter', 'and', 'or', 'all', '$', '$$', 'waitForSelector', 'elementHandle', 'elementHandles']) {
      const original = target[method];
      if (typeof original !== 'function') continue;
      target[method] = function (...args: unknown[]) {
        const result = original.apply(this, args);
        const decorate = (result: unknown): unknown => Array.isArray(result) ? result.map(item => realm.decorate(item)) : realm.decorate(result);
        return result instanceof Promise ? result.then(decorate) : decorate(result);
      };
    }
    return value;
  }
}

class ProbeHandle {
  constructor(private realm: ProbeRealm, private session: CDPSession, readonly id: string) {}
  evaluate(callback: unknown, arg?: unknown): Promise<unknown> { return this.realm.evaluate(callback, [this, arg]); }
  evaluateHandle(callback: unknown, arg?: unknown): Promise<unknown> { return this.realm.evaluate(callback, [this, arg], true); }
  async dispose(): Promise<void> { await this.session.send('Runtime.releaseObject', { objectId: this.id }).catch(() => {}); }
}

/** Install before navigation. Does not replace or freeze any source global. */
export async function installProbeIntrinsics(context: BrowserContext): Promise<void> {
  if (installed.has(context)) return;
  installed.add(context);
  await context.addInitScript(({ key, names }) => {
    const snapshot: Record<string, unknown> = {};
    for (const name of names) snapshot[name] = (globalThis as unknown as Record<string, unknown>)[name];
    const NativeFunction = Function;
    snapshot.Function = function (...parts: string[]) {
      const body = parts.pop() ?? '';
      return NativeFunction(...names, `return function(${parts.join(',')}) {${body}\n}`)(...names.map(name => snapshot[name]));
    };
    Object.defineProperty(globalThis, key, { value: Object.freeze(snapshot) });
  }, { key, names });
  const addInitScript = context.addInitScript.bind(context);
  context.addInitScript = async (script, arg) => {
    if (typeof script === 'function') {
      return addInitScript({ content: `(${source(script)})(${JSON.stringify(arg) ?? 'undefined'})` });
    }
    return addInitScript(script, arg);
  };
  context.on('page', page => { new ProbeRealm(page); });
  context.pages().forEach(page => { new ProbeRealm(page); });
}
