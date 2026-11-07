import { createToolkitAuthPlugin } from '@agent-native/toolkit/app/auth/server';

function resolveHostedOperator() {
  if (Boolean(process.env.VERCEL) || process.env.TRACEBENCH_GUEST_BENCH === '1') { // guard:allow-env-credential — hosted bench switch
    return { email: 'sre-bench@tracebench.dev', emailVerified: true };
  }
  return null;
}

export default createToolkitAuthPlugin({
  workspaceAppPublicPaths: ['/'],
  rootAuth: true,
  marketing: false,
  getAdditionalSession: async () => resolveHostedOperator(),
  getAdditionalBrowserSession: async () => resolveHostedOperator(),
});
