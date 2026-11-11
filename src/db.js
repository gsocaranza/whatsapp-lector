// Base de datos local (SQLite integrado en Node). La comparten el vinculador, que escribe,
// y el MCP, que solo lee.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DATOS = process.env.WA_LECTOR_DATOS ?? join(RAIZ, 'datos');
export const ARCHIVO_DB = join(DATOS, 'whatsapp.db');

export function abrir({ soloLectura = false } = {}) {
  if (soloLectura) {
    if (!existsSync(ARCHIVO_DB)) throw new Error('Aún no hay base: corre primero `npm run vincular`.');
    const db = new DatabaseSync(ARCHIVO_DB, { readOnly: true });
    db.exec('PRAGMA busy_timeout = 5000;');
    return db;
  }
  mkdirSync(DATOS, { recursive: true });
  const db = new DatabaseSync(ARCHIVO_DB);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS chats (
      jid       TEXT PRIMARY KEY,
      nombre    TEXT,
      telefono  TEXT,
      es_grupo  INTEGER NOT NULL DEFAULT 0,
      ultimo_ts INTEGER
    );
    CREATE TABLE IF NOT EXISTS contactos (
      jid      TEXT PRIMARY KEY,
      nombre   TEXT,   -- como lo tienes guardado
      notify   TEXT,   -- como se llama él en WhatsApp
      telefono TEXT
    );
    CREATE TABLE IF NOT EXISTS lids (
      lid TEXT PRIMARY KEY,
      pn  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mensajes (
      chat_jid     TEXT NOT NULL,
      id           TEXT NOT NULL,
      de_mi        INTEGER NOT NULL,
      autor_jid    TEXT,
      autor_nombre TEXT,
      ts           INTEGER NOT NULL,
      tipo         TEXT,
      texto        TEXT,
      editado      INTEGER NOT NULL DEFAULT 0,
      borrado      INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chat_jid, id)
    );
    CREATE TABLE IF NOT EXISTS excluidos (
      jid TEXT PRIMARY KEY   -- chats que nunca se guardan (se recalcula al arrancar)
    );
    CREATE INDEX IF NOT EXISTS mensajes_chat_ts ON mensajes (chat_jid, ts);
    CREATE INDEX IF NOT EXISTS mensajes_ts ON mensajes (ts);
  `);
  return db;
}

// config.json: { "excluir": ["5215512345678", "Consultorio"] }
// Un chat queda fuera si su id o su teléfono contienen alguno de esos textos,
// o si su nombre lo contiene (sin distinguir mayúsculas).
export function leerConfig() {
  const archivo = process.env.WA_LECTOR_CONFIG ?? join(RAIZ, 'config.json');
  if (!existsSync(archivo)) return { excluir: [], grupos: true };
  const c = JSON.parse(readFileSync(archivo, 'utf8'));
  return {
    excluir: (c.excluir ?? []).map((x) => String(x).trim()).filter(Boolean),
    grupos: c.grupos !== false,
  };
}

export function soloDigitos(jid) {
  return (jid ?? '').split('@')[0].split(':')[0].replace(/\D/g, '');
}
