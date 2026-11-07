import { actionErrorMessage, useActionMutation } from '@agent-native/core/client/hooks';
import { IconRestore } from '@tabler/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';

export function ReinitializeBenchDialog(props: { className?: string }) {
  const [showingPrompt, setShowingPrompt] = useState(false);
  const cache = useQueryClient();

  useEffect(() => {
    if (!showingPrompt) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setShowingPrompt(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showingPrompt]);

  const { mutate, isPending } = useActionMutation('reinit-benches', {
    onSuccess: async (_data, params) => {
      setShowingPrompt(false);
      await cache.invalidateQueries();
      const msg = params?.retainRunbook
        ? 'Topologies reinitialized at frame 0 with runbook rules retained.'
        : 'Incident benches reinitialized to frame 0.';
      toast.success(msg);
    },
    onError: (failure) => {
      toast.error(actionErrorMessage(failure) ?? 'Could not reinitialize benches.');
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => setShowingPrompt(true)}
        disabled={isPending}
        className={['inline-flex items-center gap-1.5', props.className ?? ''].join(' ').trim()}
      >
        <IconRestore className="size-4" />
        {isPending ? 'Resetting…' : 'Reset demo'}
      </button>
      {showingPrompt ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="reinit-bench-heading"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowingPrompt(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg border border-border bg-background p-6 text-foreground shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="reinit-bench-heading" className="text-lg font-semibold">
              Reinitialize incident benches?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Rewinds the Checkout Mesh and Embedded Power Board back to frame 0, clearing logged probes, staged patches, and rollout gates. Choose whether to retain metabolized runbook rules.
            </p>
            <div className="mt-6 flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowingPrompt(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={isPending}
                onClick={() => mutate({ retainRunbook: true })}
              >
                Reset, keep learned rules
              </Button>
              <Button
                type="button"
                disabled={isPending}
                onClick={() => mutate({})}
              >
                Reset everything
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
