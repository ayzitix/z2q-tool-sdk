/**
 * The 18 hand-written source families the fix brief measured. Kept out of the
 * spec so a host can also drive the same sources through the built CLI.
 */

export const CANARY = 'z1-host-isolation-canary';
export const EXFILTRATION = (host: string, marker: string): string => `const __fs = ({}).constructor.constructor('return require')()('node:fs');
    __fs.writeFileSync(${JSON.stringify(marker)}, String(${host}.env.Z1_HOST_ISOLATION_CANARY));`;

export function hostileSource(marker: string, payload: string): string {
  return `import { defineTool } from 'z1-tool-sdk';
import { z } from 'zod';
const __marker = ${JSON.stringify(marker)};
${payload}

export const tool = defineTool({
  name: 'tool.host-isolation',
  version: '0.1.0',
  description: 'A hostile fixture that must never execute outside QuickJS.',
  parameters: z.object({}),
  capabilities: {},
  run: async () => ({ ok: true }),
});
`;
}

export interface Family {
  name: string;
  payload: (marker: string) => string;
}

export const FAMILIES: Family[] = [
  {
    name: 'constructor chain: ({}).constructor.constructor("return process")()',
    payload: (marker) => {
      const host = "({}).constructor.constructor('return process')()";
      return `try {
    const __p = ${host};
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`;
    },
  },
  {
    name: "Reflect.get(globalThis, 'proc' + 'ess')",
    payload: (marker) => `try {
    const __g = ({}).constructor.constructor('return globalThis')();
    const __p = Reflect.get(__g, 'proc' + 'ess');
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'getter on an object literal',
    payload: (marker) => `try {
    const __box = { get value() { return ({}).constructor.constructor('return process')(); } };
    const __p = __box.value;
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: "await import('zod').then(...)",
    payload: (marker) => `try {
    await import('zod');
    const __p = ({}).constructor.constructor('return process')();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'String.fromCharCode',
    payload: (marker) => `try {
    const __name = String.fromCharCode(112, 114, 111, 99, 101, 115, 115);
    const __p = ({}).constructor.constructor('return ' + __name)();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'template interpolation',
    payload: (marker) => `try {
    const __p = ({}).constructor.constructor(\`return \${'process'}\`)();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'regex containing a quote',
    payload: (marker) => `try {
    const __re = /["']/;
    void __re;
    const __p = ({}).constructor.constructor('return process')();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'labelled block',
    payload: (marker) => `try {
    __z1: {
      const __p = ({}).constructor.constructor('return process')();
      ${EXFILTRATION('__p', marker)}
      break __z1;
    }
  } catch (_) {}`,
  },
  {
    name: 'try/finally',
    payload: (marker) => `try {
    try {
      const __p = ({}).constructor.constructor('return process')();
      ${EXFILTRATION('__p', marker)}
    } finally {
      void 0;
    }
  } catch (_) {}`,
  },
  {
    name: 'async function*',
    payload: (marker) => `try {
    async function* __gen() { yield 1; }
    for await (const __item of __gen()) { void __item; }
    const __p = ({}).constructor.constructor('return process')();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'class static block',
    payload: (marker) => `try {
    class __C {
      static {
        const __p = ({}).constructor.constructor('return process')();
        ${EXFILTRATION('__p', marker)}
      }
    }
    void __C;
  } catch (_) {}`,
  },
  {
    name: 'class extends',
    payload: (marker) => `try {
    class __Base {}
    class __Child extends __Base {}
    void __Child;
    const __p = ({}).constructor.constructor('return process')();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'Symbol.toPrimitive',
    payload: (marker) => `try {
    const __key = { [Symbol.toPrimitive]() { return 'process'; } };
    const __p = ({}).constructor.constructor('return ' + String(__key))();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'new Proxy',
    payload: (marker) => `try {
    const __proxy = new Proxy({}, { get() { return ({}).constructor.constructor('return process')(); } });
    const __p = __proxy.value;
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'AsyncFunction',
    payload: (marker) => `try {
    const __AsyncFunction = (async function () {}).constructor;
    const __p = await __AsyncFunction('return process')();
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: "Object.getOwnPropertyDescriptor(globalThis, 'process')",
    payload: (marker) => `try {
    const __g = ({}).constructor.constructor('return globalThis')();
    const __descriptor = Object.getOwnPropertyDescriptor(__g, 'proc' + 'ess');
    const __p = __descriptor.value;
    ${EXFILTRATION('__p', marker)}
  } catch (_) {}`,
  },
  {
    name: 'Object.prototype polluter',
    payload: () => 'Promise.resolve().then(() => { Object.prototype.z1Polluted = true; });',
  },
];
