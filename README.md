# WhatsApp Service (Baileys HTTP Microservice)

Microservicio ligero para WhatsApp Web basado en Baileys y Express.
Permite vincular una sesión de WhatsApp mediante código QR y enviar mensajes directos con múltiples archivos adjuntos (PDFs e Imágenes).

## Instalación y Ejecución

```bash
# 1. Instalar dependencias
npm install

# 2. Iniciar con PM2 (24/7)
pm2 start index.js --name "whatsapp-web"
pm2 startup
pm2 save
```

## Endpoints

- `GET /status`: Consulta el estado de conexión y el código QR en base64.
- `POST /send-message`: Envío de mensaje directo con texto y múltiples adjuntos.
- `POST /send-certificate`: Envío de certificados en PDF.
- `POST /disconnect`: Cierra la sesión activa de WhatsApp.
