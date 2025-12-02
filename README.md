# Speedtest.net.ar – Probe Kit (ISP)

## Requisitos
- Docker y Docker Compose instalados (v2 o superior)
- DNS del dominio apuntando a la IP pública del servidor
- Puertos `80` y `443` abiertos hacia Internet

## Variables necesarias
Crea un archivo `.env` junto a `docker-compose.yml` con:

```
DOMAIN=tu-dominio.ejemplo.com
EMAIL=admin@ejemplo.com
```

## Instalación rápida
1) Entra a la carpeta `probe-kit` del proyecto
2) Opcional: crea directorios locales para certificados y vhosts

```
mkdir -p certs vhost.d html
```

3) Levanta el stack con SSL automático (Let's Encrypt):

```
docker compose --env-file .env up -d
```

Esto despliega:
- `nginx-proxy` escuchando en `80/443` y gestionando hosts virtuales
- `acme-companion` que solicita y renueva certificados automáticamente
- `speedtest-probe` (Node) escuchando internamente en `8080`

Los certificados quedan guardados en el host en `./certs`.

## Verificación
- `https://$DOMAIN/ip` debe responder JSON con `ip`, `isp`, `city`, `country`
- `https://$DOMAIN/empty` responde `200` (GET/HEAD/OPTIONS)
- `https://$DOMAIN/garbage` entrega datos en streaming

## Resolver 413 (Request Entity Too Large)
Si ves 413 durante la medición de Carga (upload), agrega un archivo en `vhost.d/$DOMAIN` con:

```
client_max_body_size 0;
proxy_request_buffering off;
proxy_buffering off;
```

Luego reinicia el proxy:

```
docker compose restart nginx-proxy
```

## Actualización
Para actualizar el probe:

```
docker compose build probe
docker compose up -d
```

## Uso con proxy propio del ISP
Si el ISP prefiere usar su Nginx/Traefik en el host:
- En `docker-compose.yml`, elimina `nginx-proxy` y `acme-companion`
- Expone el `probe` en `8080` y crea un reverse proxy:

Nginx (ejemplo):
```
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    client_max_body_size 0;
    proxy_request_buffering off;
    proxy_buffering off;
}
```

## Solución de problemas
- DNS no apunta a la IP: corrige el registro A/AAAA y espera propagación
- Puertos 80/443 cerrados: abre en firewall/seguridad cloud
- Certificado no emite: revisa logs de `speedtest-acme` y que `DOMAIN` resuelva al servidor
- 413 persistente: valida que el archivo `vhost.d/$DOMAIN` exista en el host y que el contenedor lo monte; reinicia proxy

## Soporte
Si necesitas ayuda, contacta al equipo de Speedtest.net.ar con el dominio del probe y los logs de `nginx-proxy`.
## 🚀 Instalación

Este kit está diseñado para que los ISPs puedan hostear un nodo de speedtest en **minutos** usando Docker.

### Requisitos previos
- Un servidor VPS/Dedicado con Ubuntu 20.04+, Debian, CentOS, etc.
- **Docker** y **Docker Compose** instalados.
- Un dominio apuntando a la IP del servidor (ej: `speedtest.mi-isp.com`)
- Puertos 80 y 443 abiertos

### Pasos

1. **Clonar el repositorio**
   ```bash
   git clone https://github.com/leatfre/probe-speedtest.net.ar.git
   cd probe-speedtest.net.ar
   ```

2. **Configurar Variables**
   Copia el archivo de ejemplo y edítalo con tus datos:
   ```bash
   cp .env.example .env
   nano .env
   ```
   
   Debes configurar:
   - `DOMAIN`: Tu dominio (ej: `speedtest.mi-isp.com`)
   - `EMAIL`: Tu email para el certificado SSL (ej: `admin@mi-isp.com`)
   - `PUBLIC_KEY_BASE64`: (Opcional) Déjalo vacío, se descarga automáticamente.

3. **Iniciar el Servidor**
   ```bash
   docker compose up -d
   ```
   
   Esto descargará las imágenes, generará los certificados SSL automáticamente y levantará el servicio.

4. **Verificar que funcione**
   ```bash
   curl https://tu-dominio.com/ip
   # Deberías ver: {"ip":"1.2.3.4", ...}
   ```

## 🔐 Seguridad & CORS

**CORS está preconfigurado** para aceptar peticiones desde cualquier origen (`*`), lo cual es necesario para que el test de velocidad funcione desde el navegador del usuario. No se requiere configuración adicional.

## 📊 Endpoints del Probe

| Endpoint    | Método | Propósito                          |
|-------------|--------|------------------------------------|
| `/ip`       | GET    | Detectar IP del usuario            |
| `/empty`    | GET/HEAD/POST | Medir latencia, jitter y upload |
| `/garbage`  | GET    | Descargar datos (test de bajada)  |
| `/`         | GET    | Health check ("Probe Online")      |

## 🔄 Mantenimiento

### Ver logs
```bash
docker compose logs -f
```

### Reiniciar el probe
```bash
docker compose restart
```

### Detener el probe
```bash
docker compose down
```

### Actualizar el probe
Si actualizamos el código del probe, ejecuta:
```bash
git pull  # o descarga el nuevo probe-kit
docker compose down
docker compose build --no-cache
docker compose up -d
```

## 📝 Registro en Speedtest.net.ar

Una vez que tu probe esté online:

1. Ve a [https://speedtest.net.ar/host](https://speedtest.net.ar/host)
2. Completa el formulario con:
   - Nombre de la ciudad
   - Nombre del ISP
   - URL de tu probe (`https://speedtest.tu-empresa.com`)
3. Espera la aprobación del equipo de Speedtest.net.ar

## ❓ Problemas Comunes

### El certificado SSL falla
- Verifica que el dominio apunte a la IP correcta (`nslookup tu-dominio.com`)
- Asegúrate de que los puertos 80 y 443 estén abiertos en el firewall

### El endpoint `/ip` no responde
- Verifica que Docker esté corriendo: `docker ps`
- Revisa los logs: `docker compose logs probe`

### CORS Error en el navegador
- Esto **NO debería pasar** con este setup. Si ocurre, contacta al equipo de Speedtest.net.ar

## 🆘 Soporte

Si tenés problemas con la instalación, contactanos en `lfredes@speedtest.net.ar`
