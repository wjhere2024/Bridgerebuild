import type { Readable, Writable } from 'node:stream';
import { createInterface } from 'node:readline';
import { mergeProcessEnv, spawnProcess, type SpawnedProcessByStdio } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import { prefixBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentRun,
  AgentRunOptions,
} from '../types';

export interface AntigravityAdapterOptions {
  binary: string;
  project?: string;
  model?: string;
  printTimeout?: string;
  dangerouslySkipPermissions?: boolean;
  sandbox?: boolean;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
}

export const DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT = '60m';

type AntigravityChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export class AntigravityAdapter implements AgentAdapter {
  readonly id = 'antigravity';
  readonly displayName: string;

  private readonly binary: string;
  private readonly project: string | undefined;
  private readonly model: string | undefined;
  private readonly printTimeout: string;
  private readonly dangerouslySkipPermissions: boolean;
  private readonly sandbox: boolean;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: AntigravityAdapterOptions) {
    this.binary = opts.binary;
    this.project = opts.project;
    this.model = opts.model;
    this.printTimeout = opts.printTimeout ?? DEFAULT_ANTIGRAVITY_PRINT_TIMEOUT;
    this.dangerouslySkipPermissions = opts.dangerouslySkipPermissions === true;
    this.sandbox = opts.sandbox === true;
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5000;
    this.larkChannel = opts.larkChannel;
    this.displayName = 'Antigravity CLI';
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'antigravity',
      agentName: this.displayName,
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        `${this.displayName} binary check failed`,
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) {
      throw new Error('cwd is required for AntigravityAdapter.run');
    }

    const prompt = prefixBridgeSystemPrompt(opts.prompt, this.botIdentity);
    const args = [
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--print-timeout',
      this.printTimeout,
      ...(this.project ? ['--project', this.project] : []),
      ...(opts.model ?? this.model ? ['--model', opts.model ?? this.model!] : []),
      ...(this.dangerouslySkipPermissions ? ['--dangerously-skip-permissions'] : []),
      ...(this.sandbox ? ['--sandbox'] : []),
      '--add-dir',
      opts.cwd,
    ];

    const child = spawnProcess(this.binary, args, {
      cwd: opts.cwd,
      env: mergeProcessEnv(process.env, {
        ...buildLarkChannelEnv(this.larkChannel),
        LARK_CHANNEL_ANTIGRAVITY_BRIDGE: '1',
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as AntigravityChild;

    child.stdin.end(`${JSON.stringify({
      event: 'user',
      message: { role: 'user', content: prompt },
    })}\n`);

    const stderrChunks: Buffer[] = [];
    let runtimeError: Error | null = null;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
    child.on('error', (err) => {
      runtimeError = err;
    });

    const stopGraceMs = opts.stopGraceMs ?? this.defaultStopGraceMs;

    return {
      runId: opts.runId,
      events: createEventStream(child, stderrChunks, () => runtimeError),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: AntigravityChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn Antigravity CLI: ${err.message}` : 'spawn returned no pid',
      terminationReason: 'failed',
    };
    return;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let text = '';
  let resultError: string | undefined;
  try {
    for await (const line of rl) {
      const parsed = parseStreamJsonLine(line);
      if (parsed?.error) resultError ??= parsed.error;
      const delta = parsed?.delta ?? '';
      if (!delta) continue;
      text += delta;
      yield { type: 'text', delta };
    }
  } finally {
    rl.close();
  }

  const exitCode = await waitForExitCode(child);
  const runtimeError = getError();
  const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
  if (resultError) {
    yield { type: 'error', message: resultError, terminationReason: 'failed' };
    return;
  }
  if (exitCode !== 0 && exitCode !== null) {
    const detail = stderr ? `: ${truncateForReply(stderr)}` : '';
    yield {
      type: 'error',
      message: `Antigravity CLI exited with code ${exitCode}${detail}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (runtimeError) {
    yield {
      type: 'error',
      message: `Antigravity CLI runtime error: ${runtimeError.message}`,
      terminationReason: 'failed',
    };
    return;
  }
  if (text.trim().length === 0 && stderr.length > 0) {
    yield {
      type: 'error',
      message: `Antigravity CLI produced no reply. stderr: ${truncateForReply(stderr)}`,
      terminationReason: 'failed',
    };
    return;
  }
  yield { type: 'done', terminationReason: 'normal' };
}

function parseStreamJsonLine(line: string): { delta?: string; error?: string } | undefined {
  try {
    const value = JSON.parse(line) as {
      event?: string;
      step_update?: { step_type?: string; text_delta?: string };
      result?: { status?: string; error?: string; response?: string };
    };
    if (value.event === 'step_update' && value.step_update?.step_type === 'agent_response') {
      return value.step_update.text_delta ? { delta: value.step_update.text_delta } : {};
    }
    if (value.event === 'step_update' && value.step_update?.step_type === 'error_message') {
      return value.step_update.text_delta ? { error: value.step_update.text_delta } : {};
    }
    if (value.event === 'result' && value.result?.status && value.result.status !== 'SUCCESS') {
      return {
        error: value.result.error || value.result.response || `Antigravity CLI returned ${value.result.status}`,
      };
    }
    return {};
  } catch {
    return {};
  }
}

async function waitForExitCode(child: AntigravityChild): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });
}

function truncateForReply(value: string): string {
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}
