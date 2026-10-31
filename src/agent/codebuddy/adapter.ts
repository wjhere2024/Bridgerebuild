import { existsSync } from 'node:fs';
import { ClaudeAdapter, type ClaudeAdapterOptions } from '../claude/adapter';

export const WORKBUDDY_CLI = '/opt/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy';

export function defaultCodeBuddyBinary(): string {
  return process.env.LARK_CHANNEL_CODEBUDDY_BIN || (existsSync(WORKBUDDY_CLI) ? WORKBUDDY_CLI : 'codebuddy');
}

export class CodeBuddyAdapter extends ClaudeAdapter {
  constructor(options: Omit<ClaudeAdapterOptions, 'protocol'> = {}) {
    super({ ...options, binary: options.binary ?? defaultCodeBuddyBinary(), protocol: 'codebuddy' });
  }
}
