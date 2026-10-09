import { runEmbeddedCliproxyLogin } from './lib/embedded-cliproxy.mjs';

const loginProvider = process.argv[2]?.trim() || process.env.CLIPROXY_LOGIN_PROVIDER?.trim() || 'codex';

async function main() {
  if (!['codex', 'codex-device', 'claude', 'gemini'].includes(loginProvider)) {
    throw new Error(`Unsupported cliproxy login provider: ${loginProvider}`);
  }

  const options = await runEmbeddedCliproxyLogin(loginProvider, process.env);
  console.log('');
  console.log('CLIPROXY AUTH READY');
  console.log(`Provider:          ${loginProvider}`);
  console.log(`Source dir:        ${options.sourceDir}`);
  console.log(`Config path:       ${options.configPath}`);
  console.log(`Auth dir:          ${options.authDir}`);
}

main().catch((error) => {
  console.error('CLIPROXY AUTH FAILED');
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
