import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') throw new Error('Build the Windows ZIP with tar.exe on Windows.');

const root = resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
const { name, version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (manifest.name !== name || manifest.version !== version || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || !/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error('The plugin and package manifests must have the same valid name and version.');
}

const output = resolve(process.argv[2] ?? join(root, 'dist'));
mkdirSync(output, { recursive: true });
const files = ['README.md', 'README.zh-CN.md', 'docs', 'hooks.json', 'mcp_config.json', 'package.json', 'plugin.json', 'rules', 'sidecars', 'src'];
if (existsSync(join(root, 'LICENSE'))) files.push('LICENSE');

const filename = `${name}-${version}-preview-windows.zip`;
const archive = join(output, filename);
const result = spawnSync('tar.exe', ['-a', '-cf', archive, '-C', root, ...files], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
if (result.error || result.status !== 0) throw new Error('Could not create the Windows ZIP.', { cause: result.error });

const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
const checksum = `${archive}.sha256`;
writeFileSync(checksum, `${sha256}  ${filename}\n`);
console.log(JSON.stringify({ version, archive, checksum, sha256 }, null, 2));
