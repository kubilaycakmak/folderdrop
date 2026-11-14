import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export function dataDirectory(value) {
  const base = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_DATA_HOME;
  return path.resolve(value || process.env.FOLDERDROP_DATA_DIR || (base ? path.join(base, 'FolderDrop') : path.join(homedir(), '.folderdrop')));
}

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path.join(directory, 'folderdrop.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id)) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS record_share ON records(kind, json_extract(data, '$.share'))
        WHERE kind IN ('recipient', 'snapshot', 'upload');
      CREATE INDEX IF NOT EXISTS grant_recipient ON records(json_extract(data, '$.recipient')) WHERE kind='grant';`);
    this.read = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?');
    this.select = this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY id');
    this.filtered = this.db.prepare("SELECT data FROM records WHERE kind=? AND kind IN ('recipient', 'snapshot', 'upload') AND json_extract(data, '$.share')=? ORDER BY id");
    this.grantRows = this.db.prepare("SELECT data FROM records WHERE kind='grant' AND json_extract(data, '$.recipient')=?");
    this.expired = this.db.prepare(`DELETE FROM records WHERE
      (kind='grant' AND json_extract(data, '$.until') <= ?) OR
      (kind='session' AND json_extract(data, '$.expires') <= ?)`);
    this.removeGrants = this.db.prepare("DELETE FROM records WHERE kind='grant' AND json_extract(data, '$.recipient')=?");
    this.project = this.db.prepare("SELECT json_remove(data, '$.items') AS data, json_array_length(data, '$.items') AS count FROM records WHERE kind='snapshot' AND json_extract(data, '$.share')=? ORDER BY id");
    this.storage = this.db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(json_extract(data, '$.bytes')),0) AS bytes FROM records WHERE kind='snapshot'");
    this.ids = this.db.prepare('SELECT id FROM records WHERE kind=?');
    this.write = this.db.prepare('INSERT INTO records(kind,id,data) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data');
    this.erase = this.db.prepare('DELETE FROM records WHERE kind=? AND id=?');
  }

  get(kind, id) { const row = this.read.get(kind, id); return row && JSON.parse(row.data); }
  all(kind) { return this.select.all(kind).map(row => JSON.parse(row.data)); }
  byShare(kind, id) { return this.filtered.all(kind, id).map(row => JSON.parse(row.data)); }
  grants(id) { return this.grantRows.all(id).map(row => JSON.parse(row.data)); }
  clearGrants(id) { this.removeGrants.run(id); }
  clearExpired(now) { this.expired.run(now, now); }
  snapshotCatalog(id) { return this.project.all(id).map(row => ({ ...JSON.parse(row.data), count: row.count })); }
  snapshotUsage() { return this.storage.get(); }
  keys(kind) { return this.ids.all(kind).map(row => row.id); }
  put(kind, value) { this.write.run(kind, value.id, JSON.stringify(value)); return value; }
  delete(kind, id) { this.erase.run(kind, id); }
  close() { this.db.close(); }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
