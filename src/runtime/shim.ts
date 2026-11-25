import { SANDBOX_MAX_BRIDGE_BYTES, SANDBOX_MAX_READ_BYTES } from './limits.js';

/**
 * The VM-side source. It is a string, not a module: nothing here may import a
 * host module, and the only way out of the sandbox is `__z1_invoke`.
 *
 * Three scripts are evaluated once per call, after the host function and globals
 * are installed:
 *
 * - {@link SHIM_SOURCE} builds `globalThis.__z1_ctx`, a `ToolContext` over
 *   `__z1_invoke`, and maps `console.*` onto `log`.
 * - {@link ENTRY_SOURCE} builds `globalThis.__z1_run`, the async entry point the
 *   host calls with the arguments as a JSON string, and `globalThis.__z1_encode`.
 * - The host then calls `__z1_encode(offset, length)` repeatedly, after the entry
 *   promise settles, and reassembles the envelope from its chunks.
 *
 * Why chunks: a single value of a few megabytes crossing the bridge leaves one
 * internal object alive in quickjs-emscripten 0.32.0, and disposing the runtime
 * then throws a catchable abort (measured: 4 MB in, 3 MB clean; see
 * `SECURITY.md`). Every large string — a read, a write, the result envelope — is
 * therefore split at {@link SANDBOX_MAX_BRIDGE_BYTES} and reassembled on the
 * other side, so no single crossing goes near the trigger.
 */

/** Builds `globalThis.__z1_ctx`, a `ToolContext` over `__z1_invoke`. */
export const SHIM_SOURCE = String.raw`(function () {
  'use strict';

  var BRIDGE_LIMIT = ${SANDBOX_MAX_BRIDGE_BYTES};
  var READ_LIMIT = ${SANDBOX_MAX_READ_BYTES};
  // 128 KiB per read chunk. 1 MiB pieces of text outside Latin-1 still abort at
  // dispose; measured clean at 128 KiB for the same content, and ASCII is clean
  // at 1 MiB, so the smaller request buys the 16-bit path for a few crossings.
  var READ_CHUNK = BRIDGE_LIMIT / 8;

  var invoke = globalThis.__z1_invoke;
  if (typeof invoke !== 'function') {
    throw new Error('invalid_tool: the sandbox bridge is missing');
  }

  function describe(value) {
    if (typeof value === 'string') return value;
    try {
      var json = JSON.stringify(value);
      if (typeof json === 'string') return json;
    } catch (error) {
      // Fall through to String().
    }
    try {
      return String(value);
    } catch (error) {
      return '[unprintable]';
    }
  }

  function unwrap(reply) {
    var parsed;
    try {
      parsed = JSON.parse(reply);
    } catch (error) {
      throw new Error('tool_threw: the sandbox returned malformed JSON');
    }
    if (parsed !== null && typeof parsed === 'object' && parsed.ok === true) {
      return parsed.value === undefined ? null : parsed.value;
    }
    var code = 'tool_threw';
    var message = 'the sandbox refused the call';
    if (parsed !== null && typeof parsed === 'object') {
      if (typeof parsed.code === 'string') code = parsed.code;
      if (typeof parsed.message === 'string') message = parsed.message;
    }
    throw new Error(code + ': ' + message);
  }

  function call(kind, payload) {
    return unwrap(invoke(kind, JSON.stringify(payload === undefined ? {} : payload)));
  }

  /** UTF-8 byte length, so the cap is measured in the same unit as the host. */
  function utf8Length(text) {
    var bytes = 0;
    for (var index = 0; index < text.length; index += 1) {
      var code = text.charCodeAt(index);
      if (code < 0x80) {
        bytes += 1;
      } else if (code < 0x800) {
        bytes += 2;
      } else if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        index + 1 < text.length &&
        (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00
      ) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    }
    return bytes;
  }

  function log(level) {
    return function () {
      var parts = [];
      for (var index = 0; index < arguments.length; index += 1) {
        parts.push(describe(arguments[index]));
      }
      call('log', { level: level, message: parts.join(' ') });
    };
  }

  /**
   * Read a file as one string, one bridge crossing per chunk. next is opaque
   * here: the host decides how many code units fit in one reply.
   */
  function readFile(path) {
    // Built with += and 128 KiB pieces, never an array join or one big reply:
    // quickjs-emscripten 0.32.0 leaves objects on the runtime GC list when a
    // multi-megabyte string is joined or flattened, and dispose() then aborts
    // (measured: a 4 MB join aborts where += is clean; ASCII is clean to the
    // 8 MB cap, text outside Latin-1 to about 2.4M code units). SECURITY.md
    // carries the table; do not "simplify" this into parts.join('').
    var text = '';
    var bytes = 0;
    var offset = 0;
    for (var chunk = 0; chunk < 4096; chunk += 1) {
      var reply = call('fs.read', { path: path, offset: offset, length: READ_CHUNK });
      if (reply === null || typeof reply !== 'object' || typeof reply.data !== 'string') {
        throw new Error('tool_threw: the sandbox returned a malformed fs.read chunk');
      }
      text += reply.data;
      bytes += utf8Length(reply.data);
      if (bytes > READ_LIMIT) {
        throw new Error('output_too_large: fs.read is limited to ' + READ_LIMIT + ' bytes');
      }
      if (reply.next === null || reply.next === undefined) return text;
      if (typeof reply.next !== 'number' || reply.next <= offset) {
        throw new Error('tool_threw: the sandbox returned a non-advancing fs.read offset');
      }
      offset = reply.next;
    }
    throw new Error('tool_threw: fs.read did not finish');
  }

  /**
   * Write a string in chunks the host buffers and flushes once, at eof, so a
   * refused write never leaves a partial file. Each chunk shrinks until its JSON
   * payload (escaping included) fits the bridge cap.
   */
  function writeFile(path, data) {
    var offset = 0;
    for (var chunk = 0; chunk < 4096; chunk += 1) {
      var size = Math.max(0, Math.min(BRIDGE_LIMIT, data.length - offset));
      var payload = {
        path: path,
        data: data.slice(offset, offset + size),
        offset: offset,
        eof: offset + size >= data.length
      };
      for (var attempt = 0; attempt < 8; attempt += 1) {
        var bytes = utf8Length(JSON.stringify(payload));
        if (bytes <= BRIDGE_LIMIT || size <= 1) break;
        size = Math.max(1, Math.min(size - 1, Math.floor((size * BRIDGE_LIMIT) / bytes)));
        payload = {
          path: path,
          data: data.slice(offset, offset + size),
          offset: offset,
          eof: offset + size >= data.length
        };
      }
      var reply = call('fs.write', payload);
      offset += payload.data.length;
      if (payload.eof) return reply;
    }
    throw new Error('tool_threw: fs.write did not finish');
  }

  /**
   * Pull a response body, one bridge call per chunk.
   *
   * The host keeps the body between the calls and answers { data, next }; next
   * is the code-unit offset to continue from, or null at the end. Appended with
   * += and never joined, exactly like readFile and for the same measured reason
   * (SECURITY.md): a multi-megabyte string built any other way makes the
   * QuickJS teardown abort.
   */
  function readNetBody(head) {
    var text = typeof head.data === 'string' ? head.data : '';
    var next = head.next;
    for (var chunk = 0; chunk < 4096; chunk += 1) {
      if (next === null || next === undefined) return text;
      if (typeof next !== 'number' || next <= 0) {
        throw new Error('tool_threw: the sandbox returned a bad net.fetch offset');
      }
      var reply = call('net.fetch', { offset: next });
      if (reply === null || typeof reply !== 'object' || typeof reply.data !== 'string') {
        throw new Error('tool_threw: the sandbox returned a malformed net.fetch chunk');
      }
      text += reply.data;
      if (typeof reply.next !== 'number') return text;
      if (reply.next <= next) {
        throw new Error('tool_threw: the sandbox returned a non-advancing net.fetch offset');
      }
      next = reply.next;
    }
    throw new Error('tool_threw: net.fetch did not finish');
  }

  /**
   * ctx.net.fetch. Nothing is validated here: the host owns the scheme, the
   * host allow-list, the method, the headers and the body cap, and a second
   * opinion in the VM could only disagree with the boundary.
   */
  function netFetch(url, init) {
    var options = init === undefined || init === null ? {} : init;
    var value = call('net.fetch', {
      url: url,
      method: options.method,
      headers: options.headers,
      body: options.body
    });
    if (value === null || typeof value !== 'object') {
      throw new Error('tool_threw: the sandbox returned a malformed net.fetch reply');
    }
    var body = readNetBody(value);
    return {
      ok: value.ok,
      status: value.status,
      statusText: value.statusText,
      url: value.url,
      headers: value.headers,
      body: body,
      text: body,
      // Closes over body, never this: a destructured call must work, and the
      // body is already assembled by the time this returns.
      json: function () {
        try {
          return JSON.parse(body);
        } catch (error) {
          var detail = error && error.message ? String(error.message) : String(error);
          throw new Error('tool_threw: the response body is not valid JSON (' + detail + ')');
        }
      }
    };
  }

  /**
   * ctx.env: exactly the names the manifest declares, in one call.
   *
   * An undeclared name is simply absent, so ctx.env.X is undefined without a
   * second crossing. A refusal here (a hand-written tool.json asking for "*")
   * fails the call instead of silently granting nothing: a declaration the
   * runtime could not read must not look like one it honoured.
   */
  function readEnv() {
    var reply = call('env.read', {});
    var values = {};
    if (
      reply === null ||
      typeof reply !== 'object' ||
      reply.values === null ||
      typeof reply.values !== 'object'
    ) {
      return Object.freeze(values);
    }
    var names = Object.keys(reply.values);
    for (var index = 0; index < names.length; index += 1) {
      var name = names[index];
      if (typeof reply.values[name] !== 'string') continue;
      // defineProperty, not assignment: an environment variable is allowed to
      // be called "__proto__", and assigning that name would reach the
      // prototype instead of creating an entry.
      Object.defineProperty(values, name, {
        value: reply.values[name],
        enumerable: true,
        writable: false,
        configurable: false
      });
    }
    return Object.freeze(values);
  }

  globalThis.__z1_ctx = {
    workspace: globalThis.__z1_workspace,
    signal: Object.freeze({ aborted: false }),
    fs: {
      read: function (path) {
        try {
          return Promise.resolve(readFile(path));
        } catch (error) {
          return Promise.reject(error);
        }
      },
      write: async function (path, data) {
        return writeFile(path, data);
      },
      list: async function (path) {
        return call('fs.list', { path: path });
      },
      glob: async function (pattern) {
        return call('fs.glob', { pattern: pattern });
      },
      grep: async function (pattern, options) {
        return call('fs.grep', { pattern: pattern, options: options });
      }
    },
    process: {
      run: async function (options) {
        return call('process.run', options === undefined ? {} : options);
      }
    },
    net: {
      fetch: async function (url, init) {
        return netFetch(url, init);
      }
    },
    env: readEnv(),
    log: function (level, message) {
      call('log', { level: level, message: message });
    }
  };

  globalThis.console = {
    log: log('info'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    debug: log('debug')
  };
})();
`;

/**
 * Builds `globalThis.__z1_run` (import, validate, call, stash) and
 * `globalThis.__z1_encode`, the offset-addressed result encoder.
 */
export const ENTRY_SOURCE = String.raw`(function () {
  'use strict';

  globalThis.__z1_encode = function (offset, length) {
    var text = globalThis.__z1_text;
    if (text === undefined) {
      var value = globalThis.__z1_value;
      delete globalThis.__z1_value;
      if (value === undefined) {
        throw new Error('invalid_output: the tool returned undefined');
      }
      try {
        text = JSON.stringify({ __z1_ok: value }, function (key, item) {
          if (typeof item === 'function') {
            throw new Error('invalid_output: the result contains a function');
          }
          if (typeof item === 'bigint') {
            throw new Error('invalid_output: the result contains a BigInt');
          }
          if (typeof item === 'number' && !Number.isFinite(item)) {
            throw new Error('invalid_output: the result contains a non-finite number');
          }
          return item;
        });
      } catch (error) {
        var message = error && error.message ? String(error.message) : String(error);
        if (message.indexOf('invalid_output:') === 0) throw error;
        throw new Error('invalid_output: the result is not JSON-serializable (' + message + ')');
      }
      if (typeof text !== 'string') {
        throw new Error('invalid_output: the result is not JSON-serializable');
      }
      globalThis.__z1_text = text;
    }
    var start = typeof offset === 'number' && offset > 0 ? offset : 0;
    var size = typeof length === 'number' && length > 0 ? length : text.length;
    var end = Math.min(text.length, start + size);
    if (end < start) end = start;
    return JSON.stringify({
      data: text.slice(start, end),
      next: end < text.length ? end : null
    });
  };

  globalThis.__z1_run = async function (argsJson) {
    var mod;
    try {
      mod = await import('z1-tool-sdk');
    } catch (error) {
      var detail = error && error.message ? String(error.message) : String(error);
      if (detail.indexOf('invalid_tool:') === 0) throw error;
      throw new Error('invalid_tool: the tool bundle could not be loaded (' + detail + ')');
    }

    var tool = mod && mod.tool !== undefined
      ? mod.tool
      : mod && mod.default !== undefined && mod.default.tool !== undefined
        ? mod.default.tool
        : mod && mod.default;
    if (!tool || typeof tool.run !== 'function') {
      throw new Error('invalid_tool: the bundle must export a tool with a run function');
    }
    if (!tool.parameters || typeof tool.parameters.safeParse !== 'function') {
      throw new Error('invalid_tool: the tool has no zod parameters schema');
    }

    var parsed = tool.parameters.safeParse(JSON.parse(argsJson));
    if (!parsed.success) {
      var issues = [];
      var source = parsed.error && parsed.error.issues ? parsed.error.issues : [];
      for (var index = 0; index < source.length; index += 1) {
        var issue = source[index] || {};
        issues.push({
          path: issue.path === undefined ? [] : issue.path,
          message: issue.message === undefined ? 'invalid' : issue.message
        });
      }
      return JSON.stringify({ __z1_invalid: issues });
    }

    globalThis.__z1_value = await tool.run(globalThis.__z1_ctx, parsed.data);
    return JSON.stringify({ __z1_status: 'ready' });
  };
})();
`;
