import { resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';

await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  extensionDevelopmentPath: resolve('.'),
  extensionTestsPath: resolve(process.env.AUTOLSP_HOST_SUITE ?? 'dist/host-suite.cjs'),
  extensionTestsEnv: { TYPESAFE_API_KEY: 'autolsp-host-test-not-a-real-key' },
  launchArgs: ['--disable-extensions', '--disable-gpu', '--no-sandbox', '--skip-welcome', '--skip-release-notes',
    '--user-data-dir', resolve('.vscode-test/user-data'), '--extensions-dir', resolve('.vscode-test/extensions')],
});
