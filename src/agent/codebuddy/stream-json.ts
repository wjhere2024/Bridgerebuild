import { ClaudeStreamJsonTranslator } from '../claude/stream-json';
import type { AgentEvent } from '../types';

export class CodeBuddyStreamJsonTranslator {
  private readonly translator = new ClaudeStreamJsonTranslator();
  private hasText = false;

  terminalEmitted(): boolean {
    return this.translator.terminalEmitted();
  }

  translate(raw: unknown): AgentEvent[] {
    if (this.terminalEmitted() || !raw || typeof raw !== 'object') return [];
    const event = raw as Record<string, unknown>;
    const errors = Array.isArray(event.errors)
      ? event.errors.filter((error): error is string => typeof error === 'string').join('; ')
      : '';
    const events = this.translator.translate({
      ...event,
      ...(event.is_error && errors ? { result: errors } : {}),
    }).map((translated): AgentEvent => translated.type === 'error'
      ? { ...translated, message: translated.message.replace(/Claude/g, 'CodeBuddy') }
      : translated);
    if (events.some((translated) => translated.type === 'text')) this.hasText = true;
    if (events.some((translated) => translated.type === 'done') && !this.hasText && typeof event.result === 'string' && event.result) {
      events.unshift({ type: 'text', delta: event.result });
    }
    return events;
  }
}
