// Real-git test fixtures: one bare "GitHub" remote plus two clones that play
// two teammates (alice and bob). Each test gets a fresh temp directory.
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { git } from '../src/git/exec';

// Isolate from the developer's ~/.gitconfig (templates, hooks, pull.rebase…).
const isolatedHome = mkdtempSync(join(tmpdir(), 'pushpug-home-'));
writeFileSync(join(isolatedHome, '.gitconfig'), '');
process.env.GIT_CONFIG_GLOBAL = join(isolatedHome, '.gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;

export interface Team {
  dir: string;
  remote: string;
  alice: string;
  bob: string;
  cleanup(): void;
}

export async function makeTeam(): Promise<Team> {
  const dir = mkdtempSync(join(tmpdir(), 'pushpug-team-'));
  const remote = join(dir, 'remote.git');
  const alice = join(dir, 'alice');
  const bob = join(dir, 'bob');
  await git(dir, ['init', '-q', '--bare', '-b', 'main', remote]);
  await git(dir, ['clone', '-q', remote, alice]);
  await setIdentity(alice, 'Alice Lee', 'alice@example.com');
  write(alice, 'app.txt', 'line 1\nline 2\nline 3\nline 4\nline 5\n');
  write(alice, 'readme.md', '# Team project\n');
  await git(alice, ['add', '-A']);
  await git(alice, ['commit', '-q', '-m', 'Initial commit']);
  await git(alice, ['push', '-q', '-u', 'origin', 'main']);
  await git(dir, ['clone', '-q', remote, bob]);
  await setIdentity(bob, 'Bob Tan', 'bob@example.com');
  return { dir, remote, alice, bob, // Windows: a git that was just killed can hold the folder for a moment (EBUSY); retry for a few seconds.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }),
  };
}

async function setIdentity(repo: string, name: string, email: string) {
  await git(repo, ['config', 'user.name', name]);
  await git(repo, ['config', 'user.email', email]);
  await git(repo, ['config', 'pull.rebase', 'false']);
}

export function write(repo: string, file: string, content: string): void {
  const p = join(repo, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function read(repo: string, file: string): string {
  return readFileSync(join(repo, file), 'utf8');
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, ['add', '-A']);
  await git(repo, ['commit', '-q', '-m', message]);
}

export async function commitAndPush(repo: string, message: string): Promise<void> {
  await commitAll(repo, message);
  await git(repo, ['push', '-q']);
}

/** Replace one line (1-based) of a file. */
export function editLine(repo: string, file: string, lineNo: number, text: string): void {
  const lines = read(repo, file).split('\n');
  lines[lineNo - 1] = text;
  write(repo, file, lines.join('\n'));
}
