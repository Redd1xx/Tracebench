import { defineAction, fail } from '@agent-native/core/action';
import { writeAppStateForCurrentTab } from '@agent-native/core/application-state';
import { z } from 'zod';

export default defineAction({
  description:
    'Move the operator\'s view: open the bench list (view "bench"), open a graph, select a node, jump the timeline to a frame, or open a rollout gate. Also accepts a raw path or chat thread.',
  schema: z.object({
    view: z.enum(['bench', 'chat', 'home', 'settings']).optional().describe('Named view'),
    path: z.string().optional().describe('Explicit in-app path, e.g. /bench/<graphId>?node=<nodeId>'),
    graphId: z.string().optional().describe('Graph to open'),
    nodeId: z.string().optional().describe('Node to select on the schematic'),
    frameSeq: z.number().int().min(0).optional().describe('Timeline frame to preview'),
    gateId: z.string().optional().describe('Rollout gate to open in the Shielded Gate panel'),
    threadId: z.string().optional().describe('Chat thread id when view is chat'),
  }),
  outputSchema: z.object({ path: z.string(), message: z.string() }),
  http: false,
  run: async (args): Promise<{ path: string; message: string }> => {
    let path = args.path ?? '';
    if (!path && args.graphId) {
      const q = new URLSearchParams();
      if (args.nodeId) q.set('node', args.nodeId);
      if (args.frameSeq !== undefined) q.set('frame', String(args.frameSeq));
      if (args.gateId) q.set('gate', args.gateId);
      const query = q.toString();
      path = `/bench/${encodeURIComponent(args.graphId)}${query ? `?${query}` : ''}`;
    }
    if (!path && args.view === 'bench') path = '/bench';
    if (!path && !args.view) fail('Pass a view, path, or graphId.', { errorCode: 'missing_target' });
    const nav: Record<string, string> = { _writeId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` };
    if (args.view) nav.view = args.view;
    if (path) nav.path = path;
    if (args.threadId) nav.threadId = args.threadId;
    await writeAppStateForCurrentTab('navigate', nav);
    return { path: path || `view:${args.view}`, message: `Navigating to ${path || args.view}` };
  },
});
