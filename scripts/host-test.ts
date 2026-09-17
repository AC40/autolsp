import { resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

await runTests({
  extensionDevelopmentPath: resolve('.'),
  extensionTestsPath: resolve('dist/host-suite.cjs'),
  extensionTestsEnv: { TYPESAFE_API_KEY: 'autolsp-host-test-not-a-real-key' },
  launchArgs: ['--disable-extensions', '--disable-gpu', '--no-sandbox', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', resolve('.vscode-test/user-data'), '--extensions-dir', resolve('.vscode-test/extensions')],
});
