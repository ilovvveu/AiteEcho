import { lstat, readdir, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

/** Only remove exact IDs created by bounded turns, never sweep unrelated sessions. */
export async function removeOwnedSessionFiles(codexHome: string | undefined, id: string): Promise<boolean> {
  if (!codexHome || !UUID.test(id)) return false;
  try {
    const root = path.join(await realpath(codexHome), 'sessions');
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) return false;
    const visit = async (dir: string, depth: number): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const filename = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3 && (depth === 0 ? /^\d{4}$/u : /^\d{2}$/u).test(entry.name)) {
          await visit(filename, depth + 1);
        } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${id}.jsonl`)) {
          await unlink(filename);
        }
      }
    };
    await visit(root, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
