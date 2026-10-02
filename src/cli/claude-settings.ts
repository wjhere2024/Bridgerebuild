import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ClaudeModelStore, claudeHomeDir } from '../model/claude-registry';
import { ModelError } from '../model/discovery';
import { optionalFile } from '../model/registry';

process.umask(0o077);
try {
  const args = process.argv.slice(2);
  const index = args.indexOf('--scope');
  const scope = index < 0 ? 'user' : args.splice(index, 2)[1];
  if (!['user', 'project'].includes(scope ?? '')) throw new ModelError('--scope 必须为 user 或 project。');
  const home = claudeHomeDir();
  const dir = scope === 'project' ? join(process.cwd(), '.claude') : home;
  const store = new ClaudeModelStore(dir);
  const [command = 'current', name] = args;
  if (command === 'list') {
    const files = await readdir(join(dir, 'settings-profiles')).catch(() => scope === 'project' ? readdir(join(home, 'settings-profiles')) : []);
    console.log(files.filter((file) => file.endsWith('.json')).map((file) => file.slice(0, -5)).sort().join('\n'));
  } else if (['current', 'status'].includes(command)) {
    console.log((await optionalFile(join(dir, '.settings-profile')))?.trim() || '未选择配置档');
    const current = await store.current();
    if (current) console.log(`${current.key}/${current.model}`);
  } else if (command === 'use' && name) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(name) || name.includes('..')) throw new ModelError('配置档名称不正确。');
    const local = await optionalFile(join(dir, 'settings-profiles', `${name}.json`));
    await store.useSettingsProfile(name, local === undefined && scope === 'project' ? home : dir);
    console.log(`已启用 Claude 配置档：${name}；下一次 Claude 会话生效。`);
  } else {
    console.log('claude-settings [--scope user|project] list|current|use <profile>');
    if (!['--help', '-h', 'help'].includes(command)) process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof ModelError ? error.message : '无法访问 Claude 配置，请检查路径和文件权限。');
  process.exitCode = 1;
}
