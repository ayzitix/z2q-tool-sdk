/**
 * The Node modules the sandbox needs, loaded lazily and by structural types.
 *
 * `src/runtime/*` keeps `node:` imports dynamic (AGENTS.md rule 2): nothing here
 * is imported at module load, and no `node:` type is referenced statically. Call
 * {@link runtimeHost} once from an async entry point — `createToolRuntime`,
 * `loadToolPackage`, the CLI — and the synchronous policy helpers can then read
 * the filesystem without importing anything themselves.
 */

export interface HostStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly size: number;
}

export interface HostDirent {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface HostFs {
  readFileSync(path: string): string;
  writeFileSync(path: string, data: string): void;
  appendFileSync(path: string, data: string): void;
  readdirSync(path: string): HostDirent[];
  statSync(path: string): HostStat;
  lstatSync(path: string): HostStat;
  existsSync(path: string): boolean;
  realpathSync(path: string): string;
}

export interface HostPath {
  readonly sep: string;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  dirname(path: string): string;
  basename(path: string): string;
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
}

export interface HostExecOptions {
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxBuffer: number;
  stdin?: string;
}

export interface HostExecError {
  readonly code?: string;
  readonly status?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
  readonly message: string;
}

export interface HostSpawnOptions {
  /** Written to the child's stdin, then the pipe is closed. */
  input: string;
  encoding: 'utf8';
  /** Wall-clock budget; Node kills the child with SIGTERM when it runs out. */
  timeout: number;
  maxBuffer: number;
  windowsHide: boolean;
  /** The child's whole environment, passed as given: nothing is inherited. */
  env: Record<string, string>;
}

export interface HostSpawnResult {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Spawn failure, non-zero exit or timeout, exactly as Node reports it. */
  readonly error?: HostExecError;
}

export interface HostChildProcess {
  /** `execFileSync` in argv form, never a shell string. */
  execFileSync(file: string, args: readonly string[], options: HostExecOptions): string;
  /**
   * `spawnSync` in argv form: it blocks the host thread until the child exits,
   * which is the whole point of the network relay (the VM bridge is
   * synchronous, so a fetch has to block too).
   */
  spawnSync(file: string, args: readonly string[], options: HostSpawnOptions): HostSpawnResult;
}

export interface HostCrypto {
  sha256Hex(value: string): string;
}

export interface RuntimeHost {
  readonly fs: HostFs;
  readonly path: HostPath;
  readonly childProcess: HostChildProcess;
  readonly crypto: HostCrypto;
  /** The Node binary running the host: the network relay spawns exactly this. */
  readonly execPath: string;
  /** `win32` compares paths and executable names case-insensitively. */
  readonly caseInsensitive: boolean;
}

let cached: Promise<RuntimeHost> | undefined;
let loaded: RuntimeHost | undefined;

/** Load (once) and return the host modules. Safe to call from many places. */
export function runtimeHost(): Promise<RuntimeHost> {
  cached ??= load();
  return cached;
}

/** Synchronous access for the policy helpers; requires a prior `runtimeHost()`. */
export function hostNow(): RuntimeHost {
  if (loaded === undefined) {
    throw new Error(
      'the sandbox host modules are not loaded yet; await runtimeHost() (createToolRuntime does it for you)',
    );
  }
  return loaded;
}

async function load(): Promise<RuntimeHost> {
  const [fsModule, pathModule, childProcessModule, cryptoModule] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:child_process'),
    import('node:crypto'),
  ]);

  const fs: HostFs = {
    readFileSync: (path) => fsModule.readFileSync(path, 'utf8'),
    writeFileSync: (path, data) => fsModule.writeFileSync(path, data, 'utf8'),
    appendFileSync: (path, data) => fsModule.appendFileSync(path, data, 'utf8'),
    readdirSync: (path) =>
      fsModule.readdirSync(path, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        isFile: () => entry.isFile(),
        isDirectory: () => entry.isDirectory(),
        isSymbolicLink: () => entry.isSymbolicLink(),
      })),
    statSync: (path) => fsModule.statSync(path),
    lstatSync: (path) => fsModule.lstatSync(path),
    existsSync: (path) => fsModule.existsSync(path),
    realpathSync: (path) => fsModule.realpathSync(path),
  };

  const path: HostPath = {
    sep: pathModule.sep,
    resolve: (...parts) => pathModule.resolve(...parts),
    join: (...parts) => pathModule.join(...parts),
    dirname: (value) => pathModule.dirname(value),
    basename: (value) => pathModule.basename(value),
    isAbsolute: (value) => pathModule.isAbsolute(value),
    relative: (from, to) => pathModule.relative(from, to),
  };

  const childProcess: HostChildProcess = {
    execFileSync: (file, args, options) =>
      childProcessModule.execFileSync(file, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        ...(options.stdin === undefined ? {} : { input: options.stdin }),
      }),
    spawnSync: (file, args, options) => {
      const result = childProcessModule.spawnSync(file, [...args], {
        input: options.input,
        encoding: options.encoding,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: options.windowsHide,
        // The helper gets this object and nothing else: no PATH, no HOME, no
        // NODE_OPTIONS and no secret the host holds. `env: {}` is the point.
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return {
        status: result.status,
        signal: result.signal,
        stdout: typeof result.stdout === 'string' ? result.stdout : '',
        stderr: typeof result.stderr === 'string' ? result.stderr : '',
        ...(result.error === undefined ? {} : { error: result.error }),
      };
    },
  };

  const crypto: HostCrypto = {
    sha256Hex: (value) => cryptoModule.createHash('sha256').update(value, 'utf8').digest('hex'),
  };

  const host: RuntimeHost = {
    fs,
    path,
    childProcess,
    crypto,
    execPath: process.execPath,
    caseInsensitive: process.platform === 'win32',
  };
  loaded = host;
  return host;
}
