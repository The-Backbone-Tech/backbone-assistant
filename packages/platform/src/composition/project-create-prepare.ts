// Prepare only a freshly reserved project directory. An interrupted preparation is not retried.
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectIntent } from './project-create-intent.ts';
import { assertHomeWriteAdmission } from './home-lock.ts';

function createFile(home: string, path: string, text: string) {
  assertHomeWriteAdmission(home, dirname(path));
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { assertHomeWriteAdmission(home, dirname(path)); writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Caller has already durably recorded `started`. Throws on any occupied or uncertain path. */
// A stuck git must not hold the app or the service for ever; a cold or busy Mac can still take seconds to start it.
export function prepareReservedProject(home: string, intent: ProjectIntent, createdDirectory: () => void = () => {}, gitTimeoutMs = 20_000): void {
  if (!/^[a-z0-9-]+$/.test(intent.project.dir) || !intent.project.id || intent.phase !== 'started') throw new Error('The project reservation is invalid.');
  const root = join(home, 'projects');
  assertHomeWriteAdmission(home, root);
  mkdirSync(root, {recursive:true});
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('The projects directory is not a safe directory.');
  const dir = join(root, intent.project.dir);
  assertHomeWriteAdmission(home, root);
  mkdirSync(dir); // exclusive; never adopt an existing directory or symlink
  createdDirectory();
  const created = lstatSync(dir);
  const unchanged = () => {
    const currentRoot=lstatSync(root), current=lstatSync(dir);
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev!==rootStat.dev || currentRoot.ino!==rootStat.ino || !current.isDirectory() || current.isSymbolicLink() || current.dev!==created.dev || current.ino!==created.ino || realpathSync(dir)!==join(realpathSync(home),'projects',intent.project.dir)) throw new Error('The project directory changed during setup.');
  };
  unchanged();
  const rootFd = openSync(root, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(rootFd); } finally { closeSync(rootFd); }
  const dirFd = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  if (intent.kind !== 'git') return;
  unchanged();
  const readme = `# ${intent.project.name}\n`;
  createFile(home, join(dir, 'README.md'), readme);
  assertHomeWriteAdmission(home, dir);
  mkdirSync(join(dir, '.git')); // exclusive: never initialize an existing repository
  const ownGit = lstatSync(join(dir, '.git'));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, {HOME:join(dir,'.git'), XDG_CONFIG_HOME:join(dir,'.git','empty-xdg'), GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null', GIT_CONFIG_SYSTEM:'/dev/null', GIT_TERMINAL_PROMPT:'0'});
  const git = (args: string[], input?: string) => { unchanged(); const current=lstatSync(join(dir,'.git')); if (!current.isDirectory() || current.isSymbolicLink() || current.dev!==ownGit.dev || current.ino!==ownGit.ino) throw new Error('The repository directory changed during setup.'); assertHomeWriteAdmission(home, dir, join(dir,'.git')); return execFileSync('git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgsign=false', ...args], {cwd:dir, env, input, encoding:'utf8', stdio:'pipe', timeout:gitTimeoutMs, killSignal:'SIGKILL'}); };
  git(['init','-q','-b','main','--template=']);
  // Stage the bytes we created, not a file that another actor could replace while setup runs.
  const blob = git(['hash-object','-w','--stdin'], readme).trim();
  if (!/^[a-f0-9]{40,64}$/.test(blob)) throw new Error('Git did not return a valid blob identity.');
  git(['update-index','--add','--cacheinfo',`100644,${blob},README.md`]);
  git(['-c','user.name=Project setup','-c','user.email=setup@localhost','commit','-q','--allow-empty','-m','Start project']);
}
