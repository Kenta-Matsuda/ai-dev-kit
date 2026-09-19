'use strict';
/**
 * `aidev mcp <name>` — launch an MCP server with runtime-resolved settings.
 *
 * This subcommand exists so that `.mcp.json` can be byte-identical across every
 * PKG applying the same central-kit commit. The static file names only the
 * launcher; organization/project come from `aidev.yaml` and the PAT from the
 * environment variable named by `azure_devops.auth_env`, both resolved here at
 * spawn time.
 *
 * Three rules are load-bearing:
 *
 *   1. The PAT is never placed on a command line. Argv is world-readable via
 *      the process table, so the credential is passed through the child's
 *      environment only, and never logged or echoed. This includes the base64
 *      form, which is encoding, not encryption, and leaks the PAT if exposed.
 *   2. The server version is pinned. `@latest` would mean a PKG's toolchain
 *      changes without a reviewed kit commit — the exact thing central
 *      management exists to prevent.
 *   3. stdio is inherited untouched. MCP speaks JSON-RPC over stdin/stdout, so
 *      anything this command printed to stdout would corrupt the stream; all
 *      diagnostics go to stderr.
 */

const { spawn } = require('child_process');
const { EXIT, AidevError } = require('../lib/errors');
const cfgMod = require('../lib/config');
const ui = require('../lib/ui');

const FLAGS = { 'dry-run': 'boolean', json: 'boolean' };

/**
 * Pinned server definitions. Changing a version is a central-kit PR, which is
 * what makes the toolchain reviewable rather than ambient.
 *
 * The launch contract below matches microsoft/azure-devops-mcp as published:
 * the organization is POSITIONAL (there is no --organization flag), the default
 * project travels in ADO_MCP_DEFAULT_PROJECT, and non-interactive auth needs an
 * explicit `--authentication pat`. Without that flag the server defaults to
 * interactive browser sign-in, which in a headless session fails as an opaque
 * "fetch failed" at the first tool call rather than at startup.
 */
const SERVERS = Object.freeze({
  'azure-devops': {
    package: '@azure-devops/mcp',
    version: '2.10.0',
    /**
     * The server reads a PAT from PERSONAL_ACCESS_TOKEN as the base64 of
     * "<email>:<pat>" (any non-empty email), which it hands to
     * azure-devops-node-api for Basic auth. We hold the raw PAT in the variable
     * named by azure_devops.auth_env and encode it here, at spawn time, so the
     * encoded form never lands in a config file, a shell history or a log.
     */
    credentialEnv: 'PERSONAL_ACCESS_TOKEN',
    encodeCredential(pat) {
      return Buffer.from(`aidev:${pat}`, 'utf8').toString('base64');
    },
    /** Build argv and the child environment from validated config. */
    build(config) {
      const ado = config.azure_devops;
      return {
        args: [`${this.package}@${this.version}`, ado.organization, '--authentication', 'pat'],
        env: {
          ADO_MCP_DEFAULT_PROJECT: ado.project,
        },
        authEnv: ado.auth_env,
      };
    },
  },
});

function run(ctx) {
  const { repoRoot, flags } = ctx;
  const name = ctx.positionals[0];

  if (!name) {
    throw new AidevError(`mcp server name required (one of: ${Object.keys(SERVERS).join(', ')})`);
  }
  const server = SERVERS[name];
  if (!server) {
    throw new AidevError(
      `unknown mcp server: ${name} (expected one of: ${Object.keys(SERVERS).join(', ')})`);
  }

  // A missing config is a setup error, not a silent no-op: Claude Code would
  // otherwise show an MCP server that connects and then fails every call.
  const config = cfgMod.loadConfig(repoRoot);
  const spec = server.build(config);

  // Resolve the credential without ever reading it into a log line. Its absence
  // is fatal here rather than at first tool call, so the failure names a cause.
  const pat = process.env[spec.authEnv];
  if (!pat) {
    throw new AidevError(
      `${spec.authEnv} is not set, so the ${name} MCP server cannot authenticate.\n` +
      `    Set it in the shell that launches Claude Code; it is never stored in aidev.yaml\n` +
      '    or passed on a command line.');
  }

  // One source of truth for the launch: what --json reports is character for
  // character what gets spawned, so a dry run cannot describe a command that
  // differs from the real one.
  const argv = ['-y', ...spec.args];

  if (flags['dry-run'] || flags.json) {
    // Report the resolved launch without the credential — useful for `doctor`
    // and for debugging a PKG's configuration.
    const described = {
      ok: true,
      server: name,
      package: `${server.package}@${server.version}`,
      command: 'npx',
      args: argv,
      organization: config.azure_devops.organization,
      project: config.azure_devops.project,
      authEnv: spec.authEnv,
      // Names only: which variable is read here, and which one the child gets.
      // Neither value — raw or base64 — is ever included.
      credentialEnv: server.credentialEnv,
      authResolved: true,
    };
    if (flags.json) ui.json(described);
    else {
      ui.heading(`aidev mcp ${name} (dry run)`);
      ui.table([
        ['package', described.package],
        ['organization', described.organization],
        ['project', described.project],
        ['auth env', `${spec.authEnv} (set; value not read)`],
        ['passed to server as', `${server.credentialEnv} (base64 of "<user>:<pat>")`],
      ]);
    }
    return EXIT.OK;
  }

  // stdout belongs to the JSON-RPC stream from here on.
  const child = spawn('npx', argv, {
    cwd: repoRoot,
    stdio: 'inherit',
    // `shell: true` is required on Windows, where npx is a .cmd shim that
    // CreateProcess cannot execute directly. Nothing here is attacker-supplied:
    // every argument comes from the pinned table above or from validated config.
    shell: process.platform === 'win32',
    // The credential is encoded into the child's environment only. The raw PAT
    // variable is passed through untouched because it is already in this
    // process's environment; neither form ever reaches argv.
    env: {
      ...process.env,
      ...spec.env,
      [server.credentialEnv]: server.encodeCredential(pat),
    },
  });

  return new Promise((resolve) => {
    child.on('error', (e) => {
      ui.fail(`could not start the ${name} MCP server: ${e.message}`);
      ui.err('    Is npx on PATH? The kit pins the server version and installs it on demand.');
      resolve(EXIT.GENERAL);
    });
    // The MCP server runs for the lifetime of the session; its exit code is
    // this command's exit code so a crash is visible rather than swallowed.
    child.on('exit', (code, signal) => {
      if (signal) { ui.err(`[ai-dev-kit] ${name} MCP server terminated by ${signal}`); resolve(EXIT.GENERAL); return; }
      resolve(typeof code === 'number' ? code : EXIT.GENERAL);
    });
  });
}

module.exports = { run, FLAGS, SERVERS, summary: '.mcp.jsonから起動される内部サブコマンド' };
