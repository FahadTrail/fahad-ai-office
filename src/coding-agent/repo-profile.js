// Repository onboarding for the Coding Agent: what kind of project this is,
// how its dependencies are installed, how it is tested and which quick checks
// it has. Read-only detection from files in the sandbox; nothing is executed
// here. The controller runs the setup command once per sandbox, through the
// audited shell tool, before the first test gate — and only when the project
// declares its dependencies (a lockfile or requirements file) and they are not
// installed yet. Projects without a recognised layout keep the previous
// behaviour (no setup; the model chooses its own checks).

const NODE_MANAGERS = [
  // [lockfile, manager, frozen install]
  ['pnpm-lock.yaml', 'pnpm', 'pnpm install --frozen-lockfile'],
  ['yarn.lock', 'yarn', 'yarn install --frozen-lockfile'],
  ['bun.lockb', 'bun', 'bun install --frozen-lockfile'],
  ['bun.lock', 'bun', 'bun install --frozen-lockfile'],
  ['package-lock.json', 'npm', 'npm ci'],
];
const CHECK_SCRIPTS = ['lint', 'typecheck', 'type-check', 'check', 'build'];

async function exists(sandbox, path) {
  try { await sandbox.resolveInside(path); return true; } catch { return false; }
}

// sandbox.readFile returns numbered lines ("12  text"); strip the numbers.
async function readJson(sandbox, path) {
  try {
    const file = await sandbox.readFile(path);
    return JSON.parse(file.content.split('\n').map((line) => line.replace(/^\s*\d+ {2}/, '')).join('\n'));
  } catch { return null; }
}

const run = (manager, script) => (manager === 'npm' ? (script === 'test' ? 'npm test' : `npm run ${script}`) : manager === 'bun' ? `bun run ${script}` : `${manager} ${script === 'test' ? 'test' : `run ${script}`}`);

export async function detectRepositoryProfile(sandbox) {
  const profile = { languages: [], packageManager: null, setupCommand: null, setupMarker: null, testCommand: null, checks: [] };

  const pkg = await readJson(sandbox, 'package.json');
  if (pkg) {
    profile.languages.push('javascript');
    let manager = 'npm';
    for (const [lockfile, name, install] of NODE_MANAGERS) {
      if (await exists(sandbox, lockfile)) { manager = name; profile.setupCommand = install; break; }
    }
    profile.packageManager = manager;
    const scripts = pkg.scripts || {};
    if (!profile.setupCommand && Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).length) profile.setupCommand = 'npm install --no-package-lock';
    if (profile.setupCommand) profile.setupMarker = 'node_modules';
    if (scripts.test && !/no test specified/.test(scripts.test)) profile.testCommand = run(manager, 'test');
    profile.checks = CHECK_SCRIPTS.filter((name) => typeof scripts[name] === 'string').map((name) => run(manager, name));
  }

  const python = await exists(sandbox, 'requirements.txt') || await exists(sandbox, 'pyproject.toml') || await exists(sandbox, 'pytest.ini');
  if (python) {
    profile.languages.push('python');
    if (!profile.setupCommand && await exists(sandbox, 'requirements.txt')) {
      profile.setupCommand = 'python -m pip install --user -r requirements.txt';
      profile.setupMarker = null; // no reliable marker: run once per sandbox
    }
    if (!profile.testCommand && (await exists(sandbox, 'pytest.ini') || await exists(sandbox, 'pyproject.toml') || await exists(sandbox, 'tests'))) profile.testCommand = 'python -m pytest -q';
  }

  if (await exists(sandbox, 'go.mod')) {
    profile.languages.push('go');
    if (!profile.setupCommand) profile.setupCommand = 'go mod download';
    if (!profile.testCommand) profile.testCommand = 'go test ./...';
    profile.checks.push('go vet ./...');
  }

  if (await exists(sandbox, 'Cargo.toml')) {
    profile.languages.push('rust');
    if (!profile.testCommand) profile.testCommand = 'cargo test';
    profile.checks.push('cargo check');
  }

  return profile;
}

// Whether the setup still has to run in this sandbox.
export async function setupNeeded(sandbox, profile, state = {}) {
  if (!profile?.setupCommand || state.setupDone) return false;
  if (profile.setupMarker && await exists(sandbox, profile.setupMarker)) return false;
  return true;
}

// One line for the system prompt.
export function profileSummary(profile) {
  if (!profile?.languages?.length) return 'Project type not recognised: inspect the repository and choose appropriate checks.';
  return [
    `Project: ${profile.languages.join(' + ')}${profile.packageManager ? ` (${profile.packageManager})` : ''}.`,
    profile.setupCommand ? `Dependencies: \`${profile.setupCommand}\` (the gate runs it once if they are missing).` : null,
    profile.checks.length ? `Quick checks available: ${profile.checks.map((check) => `\`${check}\``).join(', ')}.` : null,
  ].filter(Boolean).join(' ');
}
