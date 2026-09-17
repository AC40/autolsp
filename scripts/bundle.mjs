import { build } from 'esbuild';
await build({ entryPoints: ['extension/extension.ts'], outfile: 'dist/extension.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20', sourcemap: true });
await build({ entryPoints: ['test/host/suite.ts'], outfile: 'dist/host-suite.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], target: 'node20', sourcemap: true });
