#!/bin/bash
# Script de diagnóstico simple para ejecutar en el servidor remoto

DOMAIN=${1:-"speedtestar.reduno.com.ar"}
PORT=${2:-"443"}

echo "--- DIAGNÓSTICO DE CONECTIVIDAD PARA $DOMAIN ---"

echo "[1] Verificando resolución DNS..."
nslookup $DOMAIN
echo ""

echo "[2] Verificando conexión al puerto $PORT..."
timeout 5 bash -c "</dev/tcp/$DOMAIN/$PORT" && echo "Conexión TCP OK" || echo "FALLO conexión TCP"
echo ""

echo "[3] Verificando certificado SSL..."
echo | openssl s_client -servername $DOMAIN -connect $DOMAIN:$PORT 2>/dev/null | openssl x509 -noout -dates -subject -issuer
echo ""

echo "[4] Probando endpoint /ip con curl..."
curl -v -k "https://$DOMAIN/ip"
echo ""

echo "--- FIN DEL DIAGNÓSTICO ---"
