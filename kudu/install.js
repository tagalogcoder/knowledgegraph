#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.dirname(fileURLToPath(import.meta.url));

async function rejectSymlinks(target, destination) {
  let current = target;
  for (const part of ['', ...path.relative(target, destination).split(path.sep)]) {
    if (part) current = path.join(current, part);
    const entry = await lstat(current).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (entry?.isSymbolicLink()) throw new Error(`Symlinked installation path is not allowed: ${current}`);
    if (!entry) break;
  }
}

async function prepareCli() {
  const cli = path.join(packageRoot, 'dist', 'cli.js');
  if ((await stat(cli).catch(() => null))?.isFile()) return cli;
  const run = args => new Promise((resolve, reject) => {
    const child = spawn('npm', args, { cwd: packageRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} failed with exit code ${code}`)));
  });
  if (!(await stat(path.join(packageRoot, 'node_modules', 'typescript')).catch(() => null))?.isDirectory()) {
    await run(['ci', '--ignore-scripts']);
  }
  await run(['run', 'build']);
  return cli;
}

export async function install(targetPath) {
  if (!targetPath) throw new Error('Usage: node kudu/install.js <existing-target-project>');
  const target = path.resolve(targetPath);
  if (!(await stat(target).catch(() => null))?.isDirectory()) {
    throw new Error(`Target project is not an existing directory: ${target}`);
  }

  const cli = path.join(packageRoot, 'dist', 'cli.js').replaceAll('\\', '/');
  const skills = ['kudu', 'codemap', 'codesimplify', 'codememorize'];
  const files = [];
  for (const skill of skills) {
    const template = await readFile(path.join(packageRoot, 'skills', skill, 'SKILL.md'), 'utf8');
    const content = Buffer.from(template.replaceAll('{{KUDU_CLI}}', cli));
    for (const agent of ['.claude', '.github']) {
      files.push({ destination: path.join(target, agent, 'skills', skill, 'SKILL.md'), content });
    }
  }
  const pending = [];
  for (const { destination, content } of files) {
    await rejectSymlinks(target, destination);
    const existing = await readFile(destination).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (existing && !existing.equals(content)) throw new Error(`Existing customization differs; installation stopped: ${destination}`);
    if (!existing) pending.push({ destination, content });
  }

  await prepareCli();
  for (const { destination, content } of pending) {
    await rejectSymlinks(target, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    await rejectSymlinks(target, destination);
    await writeFile(destination, content, { flag: 'wx' });
  }
  return { target, installed: pending.length, unchanged: files.length - pending.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install(process.argv[2]).then(result => {
    console.log(`Installed Kudu in ${result.target}: ${result.installed} new, ${result.unchanged} already current.`);
    console.log('Start a fresh Claude Code or Copilot session and use /kudu, /codemap, /codesimplify, or /codememorize.');
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
