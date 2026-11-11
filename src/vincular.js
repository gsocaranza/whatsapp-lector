// Vincula tu WhatsApp como un dispositivo más (igual que WhatsApp Web) y guarda los
// mensajes en datos/whatsapp.db.
//
// SOLO LECTURA: este archivo nunca llama a sendMessage, readMessages ni nada que mande
// algo a tus contactos. No marca mensajes como leídos ni te pone «en línea».
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  getContentType,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  useMultiFileAuthState,
} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import { appendFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { abrir, leerConfig, soloDigitos, DATOS } from './db.js';

const SESION = join(DATOS, 'sesion');
const ARCHIVO_QR = join(DATOS, 'qr.png');
const db = abrir();
let qrAbierto = false;
const config = leerConfig();

// ---------- utilidades ----------
const num = (x) => (x == null ? 0 : typeof x === 'object' ? x.toNumber() : Number(x));
const hora = () => new Date().toLocaleTimeString('es-MX', { timeZone: 'America/Mexico_City' });
// También a datos/lector.log, porque al arrancar con Windows corre sin ventana.
const ARCHIVO_LOG = join(DATOS, 'lector.log');
const log = (...a) => {
  const linea = `[${new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' })} ${hora()}] ${a.join(' ')}`;
  console.log(linea);
  try {
    appendFileSync(ARCHIVO_LOG, linea + '\n');
  } catch {
    /* sin registro en archivo no se detiene */
  }
};

const sqlLid = db.prepare('INSERT OR REPLACE INTO lids (lid, pn) VALUES (?, ?)');
const sql = {
  lid: { run: (lid, pn) => sqlLid.run(jidNormalizedUser(lid), jidNormalizedUser(pn)) },
  pnDeLid: db.prepare('SELECT pn FROM lids WHERE lid = ?'),
  chat: db.prepare(`
    INSERT INTO chats (jid, nombre, telefono, es_grupo, ultimo_ts) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (jid) DO UPDATE SET
      nombre    = COALESCE(excluded.nombre, chats.nombre),
      telefono  = COALESCE(excluded.telefono, chats.telefono),
      ultimo_ts = MAX(COALESCE(excluded.ultimo_ts, 0), COALESCE(chats.ultimo_ts, 0))`),
  contacto: db.prepare(`
    INSERT INTO contactos (jid, nombre, notify, telefono) VALUES (?, ?, ?, ?)
    ON CONFLICT (jid) DO UPDATE SET
      nombre   = COALESCE(excluded.nombre, contactos.nombre),
      notify   = COALESCE(excluded.notify, contactos.notify),
      telefono = COALESCE(excluded.telefono, contactos.telefono)`),
  mensaje: db.prepare(`
    INSERT INTO mensajes (chat_jid, id, de_mi, autor_jid, autor_nombre, ts, tipo, texto)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chat_jid, id) DO UPDATE SET
      texto = CASE WHEN mensajes.editado = 1 OR mensajes.borrado = 1 THEN mensajes.texto ELSE excluded.texto END,
      autor_nombre = COALESCE(excluded.autor_nombre, mensajes.autor_nombre)`),
  editar: db.prepare('UPDATE mensajes SET texto = ?, editado = 1 WHERE chat_jid = ? AND id = ?'),
  borrar: db.prepare('UPDATE mensajes SET texto = NULL, borrado = 1 WHERE chat_jid = ? AND id = ?'),
};

function transaccion(fn) {
  db.exec('BEGIN');
  try {
    fn();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function telefonoDe(jid, alterno) {
  if (!jid) return null;
  if (jid.endsWith('@s.whatsapp.net')) return soloDigitos(jid);
  if (alterno?.endsWith('@s.whatsapp.net')) return soloDigitos(alterno);
  const fila = sql.pnDeLid.get(jidNormalizedUser(jid));
  return fila ? soloDigitos(fila.pn) : null;
}

function ignorar(jid) {
  return !jid || jid === 'status@broadcast' || isJidBroadcast(jid) || isJidNewsletter(jid);
}

// ¿Este chat está en la lista de excluidos de config.json?
function excluido(jid, telefono, nombre) {
  if (!config.grupos && isJidGroup(jid)) return true;
  const digitos = soloDigitos(jid);
  const nom = (nombre ?? '').toLowerCase();
  return config.excluir.some((x) => {
    if (/^\d+$/.test(x)) return digitos.includes(x) || (telefono ?? '').includes(x);
    return jid.includes(x) || (nom && nom.includes(x.toLowerCase()));
  });
}

const ex = {
  marcar: db.prepare('INSERT OR IGNORE INTO excluidos (jid) VALUES (?)'),
  esta: db.prepare('SELECT 1 FROM excluidos WHERE jid = ?'),
  nombres: db.prepare(`
    SELECT nombre FROM contactos WHERE (jid = ?1 OR (?2 IS NOT NULL AND telefono = ?2)) AND nombre IS NOT NULL
    UNION SELECT notify FROM contactos WHERE (jid = ?1 OR (?2 IS NOT NULL AND telefono = ?2)) AND notify IS NOT NULL
    UNION SELECT nombre FROM chats WHERE jid = ?1 AND nombre IS NOT NULL
    UNION SELECT DISTINCT autor_nombre FROM mensajes
      WHERE chat_jid = ?1 AND ?1 NOT LIKE '%@g.us' AND de_mi = 0 AND autor_nombre IS NOT NULL`),
  borrarMensajes: db.prepare('DELETE FROM mensajes WHERE chat_jid = ?'),
  borrarChat: db.prepare('DELETE FROM chats WHERE jid = ?'),
};

// Marca el chat como excluido y borra lo que hubiera de él.
function sacar(jid) {
  if (!jid) return;
  const j = jidNormalizedUser(jid) || jid;
  ex.marcar.run(j);
  ex.borrarMensajes.run(j);
  ex.borrarChat.run(j);
}

// ¿Se excluye? Revisa la lista ya calculada y, si no está, el nombre del chat, el nombre
// que le pusiste en tus contactos y el que la persona usa en WhatsApp.
function esExcluido(jid, telefono, nombre) {
  const j = jidNormalizedUser(jid) || jid;
  if (ex.esta.get(j)) return true;
  if (telefono && ex.esta.get(`${telefono}@s.whatsapp.net`)) return true;
  const nombres = [nombre, ...ex.nombres.all(j, telefono).map((r) => r.nombre)].filter(Boolean);
  const fuera = nombres.length ? nombres.some((n) => excluido(j, telefono, n)) : excluido(j, telefono, null);
  if (fuera) {
    sacar(j);
    if (telefono) ex.marcar.run(`${telefono}@s.whatsapp.net`);
  }
  return fuera;
}

// Recalcula los excluidos desde config.json y borra lo que haya quedado de ellos
// (por ejemplo, si agregaste un chat a la lista después de vincular).
function purgarExcluidos() {
  const antes = db.prepare('SELECT COUNT(*) AS n FROM chats').get().n;
  transaccion(() => {
    db.exec('DELETE FROM excluidos');
    for (const c of db.prepare('SELECT jid, telefono FROM chats').all()) esExcluido(c.jid, c.telefono, null);
    for (const k of db.prepare('SELECT jid, telefono FROM contactos').all()) {
      if (esExcluido(k.jid, k.telefono, null)) {
        // el mismo contacto puede tener chat por teléfono y por LID
        for (const l of db.prepare('SELECT lid FROM lids WHERE pn = ?').all(`${k.telefono}@s.whatsapp.net`)) sacar(l.lid);
      }
    }
    // mensajes huérfanos de chats excluidos
    db.exec('DELETE FROM mensajes WHERE chat_jid IN (SELECT jid FROM excluidos)');
  });
  const n = antes - db.prepare('SELECT COUNT(*) AS n FROM chats').get().n;
  if (n) log(`Se borraron ${n} chats excluidos por config.json.`);
}

// ---------- texto de un mensaje ----------
function textoDe(contenido) {
  const c = normalizeMessageContent(contenido);
  if (!c) return null;
  const tipo = getContentType(c);
  const m = c[tipo];
  const pie = (x) => (x ? ` ${x}` : '');
  switch (tipo) {
    case 'conversation':
      return { tipo: 'texto', texto: c.conversation };
    case 'extendedTextMessage':
      return { tipo: 'texto', texto: m.text };
    case 'imageMessage':
      return { tipo: 'imagen', texto: `[imagen]${pie(m.caption)}` };
    case 'videoMessage':
    case 'ptvMessage':
      return { tipo: 'video', texto: `[video]${pie(m.caption)}` };
    case 'audioMessage':
      return { tipo: 'audio', texto: m.ptt ? '[nota de voz]' : '[audio]' };
    case 'documentMessage':
      return { tipo: 'documento', texto: `[documento: ${m.fileName ?? 'sin nombre'}]${pie(m.caption)}` };
    case 'stickerMessage':
      return { tipo: 'sticker', texto: '[sticker]' };
    case 'locationMessage':
    case 'liveLocationMessage':
      return {
        tipo: 'ubicacion',
        texto: `[ubicación${pie(m.name)}${pie(m.address)} ${m.degreesLatitude},${m.degreesLongitude}]`,
      };
    case 'contactMessage':
      return { tipo: 'contacto', texto: `[contacto: ${m.displayName}]` };
    case 'contactsArrayMessage':
      return { tipo: 'contacto', texto: `[contactos: ${(m.contacts ?? []).map((x) => x.displayName).join(', ')}]` };
    case 'pollCreationMessage':
    case 'pollCreationMessageV2':
    case 'pollCreationMessageV3':
      return { tipo: 'encuesta', texto: `[encuesta: ${m.name} — ${(m.options ?? []).map((o) => o.optionName).join(' / ')}]` };
    case 'buttonsResponseMessage':
      return { tipo: 'respuesta', texto: m.selectedDisplayText };
    case 'listResponseMessage':
      return { tipo: 'respuesta', texto: m.title };
    case 'templateButtonReplyMessage':
      return { tipo: 'respuesta', texto: m.selectedDisplayText };
    case 'reactionMessage':
    case 'pollUpdateMessage':
    case 'senderKeyDistributionMessage':
    case 'messageContextInfo':
    case 'keepInChatMessage':
    case undefined:
      return null;
    default:
      return { tipo, texto: `[${tipo}]` };
  }
}

// ---------- guardar ----------
function guardarMensaje(m) {
  const k = m.key;
  const chat = k?.remoteJid;
  if (!chat || ignorar(chat) || !m.message) return false;

  const grupo = isJidGroup(chat);
  const telefono = grupo ? null : telefonoDe(chat, k.remoteJidAlt);
  if (k.remoteJidAlt && chat.endsWith('@lid')) sql.lid.run(chat, k.remoteJidAlt);
  if (esExcluido(chat, telefono, grupo ? null : m.pushName)) return false;

  const c = normalizeMessageContent(m.message);
  const proto_ = c?.protocolMessage;
  if (proto_) {
    const T = proto.Message.ProtocolMessage.Type;
    if (proto_.type === T.MESSAGE_EDIT && proto_.key?.id) {
      const nuevo = textoDe(proto_.editedMessage);
      if (nuevo) sql.editar.run(nuevo.texto, chat, proto_.key.id);
    } else if (proto_.type === T.REVOKE && proto_.key?.id) {
      sql.borrar.run(chat, proto_.key.id);
    }
    return false;
  }

  const t = textoDe(m.message);
  if (!t) return false;

  const ts = num(m.messageTimestamp);
  const autor = k.fromMe ? null : grupo ? k.participant ?? null : chat;
  const autorNombre = k.fromMe ? null : m.pushName ?? null;
  sql.chat.run(chat, null, telefono, grupo ? 1 : 0, ts);
  sql.mensaje.run(chat, k.id, k.fromMe ? 1 : 0, autor, autorNombre, ts, t.tipo, t.texto ?? '');
  return true;
}

function guardarChat(ch) {
  const jid = ch.id;
  if (!jid || ignorar(jid)) return;
  const grupo = isJidGroup(jid);
  const telefono = grupo ? null : telefonoDe(jid, ch.pnJid);
  if (ch.pnJid && jid.endsWith('@lid')) sql.lid.run(jid, ch.pnJid);
  const nombre = ch.name ?? ch.displayName ?? null;
  if (esExcluido(jid, telefono, nombre)) return;
  const ts = ch.conversationTimestamp ? num(ch.conversationTimestamp) : null;
  sql.chat.run(jid, nombre, telefono, grupo ? 1 : 0, ts);
}

function guardarContacto(ct) {
  if (!ct.id) return;
  const telefono = ct.phoneNumber ? soloDigitos(ct.phoneNumber) : telefonoDe(ct.id);
  if (ct.lid && ct.phoneNumber) sql.lid.run(ct.lid, ct.phoneNumber);
  sql.contacto.run(ct.id, ct.name ?? null, ct.notify ?? ct.verifiedName ?? null, telefono);
  if (esExcluido(ct.id, telefono, ct.name ?? ct.notify)) {
    if (ct.lid) sacar(ct.lid);
    if (ct.phoneNumber) sacar(ct.phoneNumber);
  }
}

// ---------- conexión ----------
async function conectar() {
  const { state, saveCreds } = await useMultiFileAuthState(SESION);
  // La versión que trae Baileys envejece y WhatsApp corta la conexión (428). Se pide la
  // vigente de WhatsApp Web; si falla, la de Baileys.
  let version;
  for (const pedir of [fetchLatestWaWebVersion, fetchLatestBaileysVersion]) {
    try {
      ({ version } = await pedir());
      if (version) break;
    } catch {
      /* sigue con la siguiente */
    }
  }
  if (process.env.WA_LOG) log('Versión de WhatsApp Web:', version?.join('.'));

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: process.env.WA_LOG ?? 'silent' }),
    // Se presenta como navegador (sub-plataforma WEB_BROWSER). Desde ~2026-06-30 WhatsApp
    // corta con 428 a «Mac OS/Windows Desktop» en Baileys 7.0.0-rc14 (arreglado en master,
    // PR #2741, sin publicar). Como navegador llega el historial reciente, no el completo.
    browser: Browsers.windows('Chrome'),
    syncFullHistory: true,
    markOnlineOnConnect: false,
    shouldIgnoreJid: ignorar,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      await QRCode.toFile(ARCHIVO_QR, qr, { width: 420, margin: 2 });
      console.log(await QRCode.toString(qr, { type: 'terminal', small: true }));
      log(`Escanea el código: WhatsApp → Dispositivos vinculados → Vincular un dispositivo.`);
      log(`También está como imagen en ${ARCHIVO_QR} (se renueva cada ~20 s; si caduca, vuelve a abrirla).`);
      if (!qrAbierto) (process.env.WA_NO_ABRIR ? () => {} : exec)(`cmd /c start "" "${ARCHIVO_QR}"`);
      qrAbierto = true;
    }
    if (connection === 'open') {
      log('Conectado. Recibiendo historial y mensajes nuevos (déjalo corriendo).');
      purgarExcluidos();
      try {
        const grupos = await sock.groupFetchAllParticipating();
        transaccion(() => {
          for (const g of Object.values(grupos)) {
            if (!esExcluido(g.id, null, g.subject)) sql.chat.run(g.id, g.subject, null, 1, null);
          }
        });
      } catch {
        /* los nombres de grupo llegan después con el historial */
      }
    }
    if (connection === 'close') {
      const codigo = lastDisconnect?.error?.output?.statusCode;
      if (codigo === DisconnectReason.loggedOut) {
        rmSync(SESION, { recursive: true, force: true });
        log('La sesión se cerró desde el teléfono. Corre `npm run vincular` para volver a vincular.');
        process.exit(1);
      }
      if (codigo === DisconnectReason.connectionReplaced) {
        // Sale con 0 para que la tarea de Windows no lo reinicie y se peleen las dos copias.
        log('Otra copia de este lector tomó la sesión. Deja solo una corriendo.');
        process.exit(0);
      }
      log(`Conexión cerrada (${codigo ?? 'sin código'}). Reconectando…`);
      setTimeout(conectar, codigo === DisconnectReason.restartRequired ? 0 : 3000);
    }
  });

  sock.ev.on('lid-mapping.update', (m) => m?.lid && m?.pn && sql.lid.run(m.lid, m.pn));

  sock.ev.on('messaging-history.set', ({ chats, contacts, messages, lidPnMappings, progress }) => {
    let n = 0;
    transaccion(() => {
      for (const x of lidPnMappings ?? []) sql.lid.run(x.lid, x.pn);
      for (const ct of contacts ?? []) guardarContacto(ct);
      for (const ch of chats ?? []) guardarChat(ch);
      for (const m of messages ?? []) if (guardarMensaje(m)) n++;
    });
    log(`Historial: ${chats?.length ?? 0} chats, ${n} mensajes${progress != null ? ` (${progress}%)` : ''}.`);
  });

  sock.ev.on('chats.upsert', (chats) => transaccion(() => chats.forEach(guardarChat)));
  sock.ev.on('chats.update', (chats) => transaccion(() => chats.forEach((c) => c.id && guardarChat(c))));
  sock.ev.on('contacts.upsert', (cts) => transaccion(() => cts.forEach(guardarContacto)));
  sock.ev.on('contacts.update', (cts) => transaccion(() => cts.forEach((c) => c.id && guardarContacto(c))));

  sock.ev.on('messages.upsert', ({ messages }) => {
    let n = 0;
    transaccion(() => {
      for (const m of messages) if (guardarMensaje(m)) n++;
    });
    if (n) log(`${n} mensaje(s) nuevo(s).`);
  });
}

export { guardarMensaje, guardarChat, guardarContacto, purgarExcluidos };

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  conectar().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
