import { describe, expect, it } from 'vitest';
import { prefixIds, rewriteFrame } from '../src/hub/hub.service.js';

/**
 * The hub forwards a spoke's event frames with the project and agent ids
 * prefixed by the spoke's name, so the hub's clients see one id space. A
 * new frame type works only if its ids are shaped the way `prefixIds`
 * recognises: `agentId`/`projectId` keys anywhere, and the `id` of an
 * object that looks like an agent (`profile` + `projectId` + `id`). The
 * `agent.created` frame carries the whole agent record, so this is where
 * that shape is pinned down.
 */
describe('hub id prefixing for the agent lifecycle frames', () => {
  it('prefixes the agent record and its refs in an agent.created frame', () => {
    const frame = {
      type: 'agent.created',
      agent: {
        id: 'a1',
        projectId: 'p1',
        name: 'scout',
        profile: 'fake',
        cwd: '/repo',
      },
      status: { state: 'idle', background: 0 },
    };
    const out = rewriteFrame('mac', frame) as typeof frame;
    expect(out.type).toBe('agent.created');
    expect(out.agent.id).toBe('mac:a1');
    expect(out.agent.projectId).toBe('mac:p1');
    // the record's own descriptive fields are untouched
    expect(out.agent.name).toBe('scout');
    expect(out.agent.profile).toBe('fake');
    // the status object has no ids to prefix and is carried through
    expect(out.status).toEqual({ state: 'idle', background: 0 });
  });

  it('prefixes the ids in an agent.archived frame', () => {
    const out = rewriteFrame('mac', {
      type: 'agent.archived',
      agentId: 'a1',
      projectId: 'p1',
    }) as { type: string; agentId: string; projectId: string };
    expect(out).toEqual({
      type: 'agent.archived',
      agentId: 'mac:a1',
      projectId: 'mac:p1',
    });
  });

  it('leaves a record without the agent shape alone (no false id prefixing)', () => {
    // an object with an `id` but no `profile`/`projectId` is not an agent
    const out = prefixIds('mac', { id: 'x', label: 'not an agent' }) as {
      id: string;
    };
    expect(out.id).toBe('x');
  });
});
