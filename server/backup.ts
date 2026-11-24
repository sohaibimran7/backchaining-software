/**
 * Back up every workshop as a JSON file — the same format the Save tab downloads and the
 * start page imports. If the target folder is a git repository, the files are committed
 * and pushed as well.
 *
 *   npm run backup -- /path/to/folder
 *
 * The files contain every participant's answers. Keep the folder, and any repository it
 * is pushed to, private.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { WorkshopService } from './service';
import { SqliteStore, type Store } from './store';

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'workshop';
}

/** Write one file per workshop into `dir`. Returns the file names written. Existing files for other workshops are left alone. */
export function exportAll(store: Store, dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const service = new WorkshopService(store);
  const written: string[] = [];
  for (const row of store.listWorkshops()) {
    const data = service.exportData(row.id, { type: 'facilitator' });
    // The id keeps the name stable if a workshop is renamed; the title makes it readable.
    const stale = fs.readdirSync(dir).filter((f) => f.endsWith(`--${row.id}.json`));
    const name = `${slug(data.title)}--${row.id}.json`;
    for (const old of stale) if (old !== name) fs.renameSync(path.join(dir, old), path.join(dir, name));
    // A stable "exportedAt" would hide nothing useful; drop it so unchanged workshops produce no diff.
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ ...data, exportedAt: data.events[data.events.length - 1]?.at ?? data.exportedAt }, null, 1) + '\n');
    written.push(name);
  }
  return written;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const target = process.argv[2] ?? process.env.BACKUP_DIR;
  if (!target) {
    console.error('Say where to put the backup: npm run backup -- /path/to/folder   (or set BACKUP_DIR)');
    process.exit(1);
  }
  const dir = path.resolve(target);
  const store = new SqliteStore(path.join(path.resolve(process.env.DATA_DIR ?? './data'), 'workshops.sqlite'));
  const files = exportAll(store, dir);
  store.close();
  console.log(`Wrote ${files.length} workshop file${files.length === 1 ? '' : 's'} to ${dir}`);
  if (fs.existsSync(path.join(dir, '.git'))) {
    git(dir, 'add', '-A');
    if (git(dir, 'status', '--porcelain')) {
      git(dir, 'commit', '-q', '-m', `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')} (${files.length} workshops)`);
      console.log('Committed.');
    } else console.log('Nothing has changed since the last backup.');
    try {
      if (git(dir, 'remote')) {
        git(dir, 'push', '-q');
        console.log('Pushed.');
      }
    } catch (err) {
      console.error(`Could not push: ${(err as Error).message.split('\n')[0]}`);
      process.exit(1);
    }
  }
}
