import { describe, expect, it } from 'vitest';
import { initialState, reduce } from '../../../src/card/run-state';

describe('run state terminal event schema', () => {
  it('maps done termination reasons onto visible terminal states', () => {
    expect(reduce(initialState, { type: 'done', terminationReason: 'normal' }).terminal).toBe(
      'done',
    );
    expect(
      reduce(initialState, { type: 'done', terminationReason: 'interrupted' }).terminal,
    ).toBe('interrupted');
    expect(reduce(initialState, { type: 'done', terminationReason: 'timeout' }).terminal).toBe(
      'idle_timeout',
    );
  });

  it('maps error termination reasons onto visible terminal states', () => {
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'failed',
        terminationReason: 'failed',
      }).terminal,
    ).toBe('error');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'stopped',
        terminationReason: 'interrupted',
      }).terminal,
    ).toBe('interrupted');
    expect(
      reduce(initialState, {
        type: 'error',
        message: 'timeout',
        terminationReason: 'timeout',
      }).terminal,
    ).toBe('idle_timeout');
  });

  it('shows a notice as a reconnecting footer and clears it on real progress', () => {
    const noticed = reduce(initialState, { type: 'notice', message: 'Reconnecting... waiting for network' });
    expect(noticed.terminal).toBe('running');
    expect(noticed.footer).toBe('reconnecting');
    expect(noticed.notice).toBe('Reconnecting... waiting for network');

    const recovered = reduce(noticed, { type: 'text', delta: 'back online' });
    expect(recovered.notice).toBeUndefined();
    expect(recovered.footer).toBe('streaming');

    const idle = reduce(noticed, {
      type: 'tool_result',
      id: 'missing',
      output: '',
      isError: false,
    });
    expect(idle.notice).toBeUndefined();
    expect(idle.footer).toBe('thinking');
  });
});
