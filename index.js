import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import pino from "pino";
import express from "express";
import cors from "cors";
import QRCode from "qrcode";
import axios from "axios";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUTH_DIR = path.join(__dirname, "session_auth");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3005;

let sock = null;
let currentQr = null;
let isConnected = false;
let connectedPhone = null;
let connecting = false;

async function iniciarBaileys() {
  if (connecting) return;
  connecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      browser: ["GROUP CEA Backoffice", "Chrome", "1.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          currentQr = await QRCode.toDataURL(qr, {
            width: 320,
            margin: 2,
            color: { dark: "#0f172a", light: "#ffffff" },
          });
          isConnected = false;
          console.log("[BAILEYS] 📱 Nuevo código QR generado para vinculación.");
        } catch (err) {
          console.error("[BAILEYS ERROR QR]", err);
        }
      }

      if (connection === "open") {
        isConnected = true;
        currentQr = null;
        const jid = sock?.user?.id || "";
        connectedPhone = jid.split(":")[0].replace(/\D/g, "");
        console.log(`[BAILEYS] 🟢 ¡WhatsApp Vinculado con éxito! Número: +${connectedPhone}`);
      }

      if (connection === "close") {
        isConnected = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[BAILEYS] 🔴 Conexión cerrada. Razón: ${statusCode}. Reconectar: ${shouldReconnect}`);

        if (statusCode === DisconnectReason.loggedOut) {
          try {
            fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          } catch (e) {}
          connectedPhone = null;
          currentQr = null;
        }

        if (shouldReconnect) {
          setTimeout(() => {
            connecting = false;
            iniciarBaileys();
          }, 3000);
        } else {
          connecting = false;
          setTimeout(() => iniciarBaileys(), 2000);
        }
      }
    });
  } catch (error) {
    console.error("[BAILEYS FATAL INIT]", error);
  } finally {
    connecting = false;
  }
}

// -------------------------------------------------------------
// Endpoints del Microservicio de WhatsApp Web
// -------------------------------------------------------------

// Estado de la conexión
app.get("/status", (req, res) => {
  res.json({
    connected: isConnected,
    phone: connectedPhone,
    qr: isConnected ? null : currentQr,
  });
});

// Enviar Certificado en PDF
app.post("/send-certificate", async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(400).json({
        ok: false,
        error: "WhatsApp no está vinculado. Por favor escanea el código QR en el Backoffice primero.",
      });
    }

    const { phone, pdfUrl, caption, filename, nombre, message } = req.body;
    if (!phone) {
      return res.status(400).json({ ok: false, error: "Falta el parámetro 'phone'." });
    }

    let digitos = phone.replace(/\D/g, "");
    if (digitos.length === 9) {
      digitos = `51${digitos}`;
    }
    const jid = `${digitos}@s.whatsapp.net`;

    const textoFinal =
      caption ||
      message ||
      `¡Hola ${nombre || ""}! 🎉\n\nTe hacemos entrega de tu Certificado de Asistencia a la Capacitación: *"Convierte las Oportunidades en Más Clientes y Ventas"*.\n\n¡Muchas gracias por tu participación! — GROUP CEA`;

    let result;
    if (pdfUrl) {
      console.log(`[BAILEYS ENVIO] Enviando PDF a ${jid}...`);
      result = await sock.sendMessage(jid, {
        document: { url: pdfUrl },
        mimetype: "application/pdf",
        fileName: filename || `Documento.pdf`,
        caption: textoFinal,
      });
    } else {
      console.log(`[BAILEYS ENVIO] Enviando texto directo a ${jid}...`);
      result = await sock.sendMessage(jid, {
        text: textoFinal,
      });
    }

    console.log(`[BAILEYS ENVIO OK] Mensaje entregado a ${jid}, ID: ${result?.key?.id}`);

    return res.json({
      ok: true,
      messageId: result?.key?.id,
      phone: digitos,
    });
  } catch (error) {
    console.error("[BAILEYS ENVIO ERROR]", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Error al enviar mensaje por Baileys",
    });
  }
});

// Enviar Mensajes con soporte para Múltiples PDFs e Imágenes
app.post("/send-message", async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(400).json({
        ok: false,
        error: "WhatsApp no está vinculado. Por favor escanea el código QR en el Backoffice primero.",
      });
    }

    const { phone, message, caption, attachments } = req.body;
    if (!phone) {
      return res.status(400).json({ ok: false, error: "Falta el parámetro 'phone'." });
    }

    let digitos = phone.replace(/\D/g, "");
    if (digitos.length === 9) {
      digitos = `51${digitos}`;
    }
    const jid = `${digitos}@s.whatsapp.net`;
    const textoPrincipal = caption || message || "";

    const listaAdjuntos = Array.isArray(attachments) ? attachments : [];

    let lastResult = null;

    if (listaAdjuntos.length === 0) {
      // Envío de solo texto
      if (!textoPrincipal) {
        return res.status(400).json({ ok: false, error: "No se proporcionó texto ni archivos para enviar." });
      }
      console.log(`[BAILEYS ENVIO] Enviando texto directo a ${jid}...`);
      lastResult = await sock.sendMessage(jid, { text: textoPrincipal });
    } else {
      // Envío con uno o más archivos (PDFs o Imágenes)
      for (let i = 0; i < listaAdjuntos.length; i++) {
        const item = listaAdjuntos[i];
        const esImagen = item.tipo === "image" || /\.(jpe?g|png|webp)$/i.test(item.filename || item.url || "");
        const pieDeFoto = i === 0 ? textoPrincipal : undefined;

        if (esImagen) {
          console.log(`[BAILEYS ENVIO] Enviando imagen (${item.filename || "foto"}) a ${jid}...`);
          lastResult = await sock.sendMessage(jid, {
            image: { url: item.url },
            caption: pieDeFoto,
          });
        } else {
          console.log(`[BAILEYS ENVIO] Enviando documento (${item.filename || "documento.pdf"}) a ${jid}...`);
          lastResult = await sock.sendMessage(jid, {
            document: { url: item.url },
            mimetype: item.mimetype || "application/pdf",
            fileName: item.filename || `Archivo_${i + 1}.pdf`,
            caption: pieDeFoto,
          });
        }

        // Breve pausa entre archivos del mismo envío
        if (listaAdjuntos.length > 1 && i < listaAdjuntos.length - 1) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }

    console.log(`[BAILEYS ENVIO OK] Entregado con éxito a ${jid}, ID: ${lastResult?.key?.id}`);
    return res.json({
      ok: true,
      messageId: lastResult?.key?.id,
      phone: digitos,
    });
  } catch (error) {
    console.error("[BAILEYS ENVIO ERROR]", error);
    return res.status(500).json({
      ok: false,
      error: error?.message || "Error al enviar mensaje por WhatsApp Web (Baileys)",
    });
  }
});

// Desconectar y borrar sesión
app.post("/disconnect", async (req, res) => {
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (e) {}
    }
    try {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    } catch (e) {}
    isConnected = false;
    connectedPhone = null;
    currentQr = null;
    setTimeout(() => iniciarBaileys(), 1500);
    return res.json({ ok: true, message: "Sesión cerrada correctamente." });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[WHATSAPP SERVICE] 🚀 Servidor de WhatsApp Web activo en el puerto ${PORT}`);
  console.log(`[WHATSAPP SERVICE] 📱 Listo para recibir peticiones del Backoffice (sin reverse-polling)`);
  iniciarBaileys();
});

