#!/usr/bin/env node
/**
 * dela-mcp: сервер MCP для Dela на компьютере пользователя.
 *   dela-mcp          — сервер MCP на stdio (его запускает Claude Desktop или другой клиент)
 *   dela-mcp login    — войти на свой сервер Dela
 *   dela-mcp logout   — выйти, отозвать устройство и стереть файл сессии
 *   dela-mcp status   — кто вошёл и есть ли связь
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient, ApiError, NetworkError } from '../../core/src/index.ts';
import { Dela, NotLoggedInError, deviceName, login, logout, normalizeServer } from './dela.ts';
import { ask, askHidden, closePrompts } from './prompt.ts';
import { VERSION, createServer } from './tools.ts';
import { Vault } from './vault.ts';

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

function option(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

const LOGIN_ERRORS: Record<string, string> = {
  invalid_credentials: 'Wrong email or password.',
  invalid_totp: 'Wrong two-factor code.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
};

async function cmdLogin(args: readonly string[]): Promise<number> {
  const vault = new Vault();
  err('Sign in to your Dela server. This computer becomes a new device of your account;');
  err('you can revoke it in Dela under Settings → Devices. Passkeys are not supported here: use your password.');
  const server = normalizeServer(option(args, 'server') ?? (await ask('Server address (e.g. https://dela.example.com): ')));
  try {
    const health = await new ApiClient(server).health();
    if (!health.ok) throw new Error('not ok');
  } catch (e) {
    err(e instanceof NetworkError ? `Cannot reach ${server}.` : `${server} does not look like a Dela server.`);
    return 1;
  }
  const email = option(args, 'email') ?? (await ask('Email: '));
  const password = await askHidden('Password: ');
  let totp: string | undefined;
  for (;;) {
    try {
      err('Signing in…');
      await login(vault, { server, email, password, ...(totp ? { totp } : {}) });
      break;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'totp_required' && !totp) {
        totp = await ask('Two-factor code: ');
        continue;
      }
      if (e instanceof ApiError) err(LOGIN_ERRORS[e.code] ?? `Sign-in failed: ${e.code}`);
      else if (e instanceof NetworkError) err(`Cannot reach ${server}.`);
      else err(`Sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }
  const dela = await Dela.open(vault);
  const report = await dela.sync();
  out(`Signed in as ${dela.email} on ${dela.server} as device "${deviceName()}".`);
  out(`${dela.ws.openTasks().length} open tasks${report.offline ? ' (offline)' : ''}.`);
  out(`Session saved in ${vault.path} (key in: ${keystoreName(vault.keystore)}).`);
  out('');
  out('Add to claude_desktop_config.json:');
  out(JSON.stringify({ mcpServers: { dela: { command: 'npx', args: ['-y', 'dela-mcp'] } } }, null, 2));
  return 0;
}

function keystoreName(k: string | null): string {
  switch (k) {
    case 'dpapi':
      return 'Windows DPAPI';
    case 'keychain':
      return 'macOS Keychain';
    case 'secret-service':
      return 'Secret Service keyring';
    default:
      return 'a file readable only by you';
  }
}

async function cmdLogout(): Promise<number> {
  const { hadSession, revoked } = await logout(new Vault());
  if (!hadSession) out('Not signed in.');
  else if (revoked) out('Signed out. The device is revoked and the local session file is deleted.');
  else out('Local session file deleted. The server could not be reached: revoke the device in Dela under Settings → Devices.');
  return 0;
}

async function cmdStatus(): Promise<number> {
  const vault = new Vault();
  try {
    const dela = await Dela.open(vault);
    const report = await dela.sync();
    out(`Signed in as ${dela.email} on ${dela.server}.`);
    out(report.offline ? `Server unreachable; ${report.pending} change(s) waiting.` : 'Connected.');
    out(`Session: ${vault.path} (key in: ${keystoreName(vault.keystore)}).`);
    return 0;
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

async function cmdServe(): Promise<number> {
  // stdout принадлежит протоколу MCP: любой случайный вывод уходит в stderr.
  console.log = console.info = console.debug = console.warn = (...a: unknown[]) => err(a.map(String).join(' '));
  const vault = new Vault();
  let dela: Dela | null = null;
  const server = createServer(async () => {
    try {
      // Новый вход, выход или другой процесс dela-mcp переписал файл: сессия открывается заново из файла.
      if (!dela || dela.stale) dela = await Dela.open(vault);
      return dela;
    } catch (e) {
      dela = null;
      if (e instanceof NotLoggedInError) throw e;
      throw new Error(`Cannot open the Dela session: ${e instanceof Error ? e.message : String(e)}. Run \`npx dela-mcp login\` again.`);
    }
  });
  await server.connect(new StdioServerTransport());
  err(`dela-mcp ${VERSION} ready${vault.exists() ? '' : ' (not signed in: run `npx dela-mcp login`)'}`);
  return new Promise(() => undefined);
}

async function main(argv: readonly string[]): Promise<number> {
  const [cmd = 'serve', ...rest] = argv;
  switch (cmd) {
    case 'serve':
      return cmdServe();
    case 'login':
      return cmdLogin(rest);
    case 'logout':
      return cmdLogout();
    case 'status':
      return cmdStatus();
    case '--version':
    case '-v':
      out(VERSION);
      return 0;
    default:
      out(`dela-mcp ${VERSION}: MCP server for the Dela task manager

  dela-mcp login [--server URL] [--email EMAIL]   sign in (asks for the password)
  dela-mcp logout                                 sign out and revoke this device
  dela-mcp status                                 show the signed-in account
  dela-mcp                                        run the MCP server on stdio`);
      return cmd === 'help' || cmd === '--help' || cmd === '-h' ? 0 : 1;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    closePrompts();
    process.exitCode = code;
  },
  (e: unknown) => {
    closePrompts();
    err(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
