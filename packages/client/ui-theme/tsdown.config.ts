import { clientBundle } from '../tsdown.client.ts'

export default clientBundle(
  '@deepseek-ai/dsh-client-ui-theme',
<<<<<<< HEAD
  ['lib/types/index.js', 'lib/types/invariant.js', 'lib/types/sidebar-glass.js'],
  {
    lib: {
      copy: [{ from: 'src/styles/*', to: 'lib/styles' }],
    },
  },
=======
  ['lib/types/index.js', 'lib/types/invariant.js'],
>>>>>>> upstream/master
)
