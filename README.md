# WhatsApp lector

Lee tus conversaciones de WhatsApp y las guarda **en este equipo** (`datos/whatsapp.db`), para que Claude Code las consulte con un MCP. **Solo lectura:** no envía mensajes, no marca nada como leído y no te pone «en línea».

> **Riesgo:** usa la librería no oficial Baileys (se vincula como WhatsApp Web). Va contra los términos de WhatsApp y Meta puede bloquear el número. Leer sin enviar es el uso de menor riesgo, pero el riesgo existe.

> **`datos/sesion/` es la llave de tu WhatsApp.** Quien tenga esa carpeta entra a tu cuenta. No la subas a Drive, a git ni a ningún lado.

## Uso

1. **Excluir chats** en `config.json` antes de vincular. Cada texto de `excluir` es un teléfono (solo dígitos, p. ej. `5215512345678`) o parte de un nombre (`"Consultorio"`). Un chat queda fuera si su número, el nombre del chat, el nombre que le pusiste en tus contactos o el que usa la persona en WhatsApp coinciden. Esos mensajes nunca se guardan. Si agregas uno después, se borra al volver a arrancar. `"grupos": false` deja fuera todos los grupos.
2. **Vincular:** `npm run vincular`. Se abre un QR (también en `datos/qr.png`): en el teléfono, WhatsApp → Dispositivos vinculados → Vincular un dispositivo. Llega el historial reciente que el teléfono decida mandar (no todo) y después los mensajes nuevos.
3. **Dejarlo corriendo.** Solo guarda mensajes mientras esté abierto. Al reabrirlo recibe lo que llegó mientras estuvo cerrado. Solo una copia a la vez.
4. **Conectar el MCP a Claude Code** (una vez):
   ```
   claude mcp add whatsapp-lector --scope user -- node C:/dev/wip/whatsapp-lector/src/mcp.js
   ```
   Herramientas: `listar_chats`, `leer_chat`, `buscar_mensajes` y `pendientes` (chats cuyo último mensaje no es tuyo).

## Desvincular

En el teléfono, WhatsApp → Dispositivos vinculados → «Chrome (Windows)» → Cerrar sesión. Después borra `datos/`.

## Archivos

- `src/vincular.js`: la conexión a WhatsApp y el guardado.
- `src/mcp.js`: el MCP; abre la base en modo lectura.
- `src/db.js`: el esquema y `config.json`.

## Arranque automático (sin ventana)

Una vez, en PowerShell (cierra antes el lector de la terminal con Ctrl+C):

```
pwsh -File C:\dev\wip\whatsapp-lector\scripts\instalar-tarea.ps1
Start-ScheduledTask -TaskName 'WhatsApp lector'
```

Desde entonces arranca solo al iniciar sesión en Windows, sin ventana, y se reinicia si se cae. Lo que pasa queda en `datos/lector.log`. Si la sesión se cierra desde el teléfono, se abre un QR nuevo para volver a vincular.

- Detener: `Stop-ScheduledTask -TaskName 'WhatsApp lector'`
- Quitar el arranque automático: `Unregister-ScheduledTask -TaskName 'WhatsApp lector' -Confirm:$false`
