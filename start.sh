#!/bin/bash

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}=== INICIANDO SPEEDTEST PROBE ===${NC}"

# 1. Verificar archivo .env
if [ ! -f .env ]; then
    echo -e "${RED}ERROR: No se encontró el archivo .env${NC}"
    echo "Por favor, crea el archivo .env con las variables DOMAIN y EMAIL."
    exit 1
fi

# 2. Cargar variables
export $(grep -v '^#' .env | xargs)

if [ -z "$DOMAIN" ]; then
    echo -e "${RED}ERROR: La variable DOMAIN no está definida en .env${NC}"
    exit 1
fi

if [ -z "$EMAIL" ]; then
    echo -e "${RED}ERROR: La variable EMAIL no está definida en .env${NC}"
    exit 1
fi

echo -e "Dominio configurado: ${YELLOW}$DOMAIN${NC}"
echo -e "Email de contacto: ${YELLOW}$EMAIL${NC}"

# 3. Verificar permisos de ejecución en scripts
chmod +x check_remote.sh
chmod +x start.sh

# 4. Verificar si docker-compose está instalado
if ! command -v docker-compose &> /dev/null; then
    echo -e "${RED}ERROR: docker-compose no está instalado.${NC}"
    exit 1
fi

# 5. Preguntar si se quiere reiniciar todo (limpieza profunda)
echo ""
echo -e "${YELLOW}¿Deseas realizar una limpieza profunda y regenerar certificados SSL?${NC}"
echo "Esto detendrá los contenedores, borrará los certificados actuales y los volverá a generar."
read -p "Escribe 'si' para confirmar, o presiona ENTER para inicio normal: " RESET_ALL

if [ "$RESET_ALL" = "si" ]; then
    echo -e "${YELLOW}Deteniendo contenedores...${NC}"
    docker-compose down
    
    echo -e "${YELLOW}Borrando certificados antiguos...${NC}"
    sudo rm -rf certs/*
    sudo rm -rf acme/*
    
    echo -e "${GREEN}Limpieza completada.${NC}"
fi

# 5.5 Configurar vhost para el dominio (FIX para SSL y CORS)
if [ -f "vhost.d/default.conf" ]; then
    echo -e "Configurando vhost.d para ${YELLOW}$DOMAIN${NC}..."
    # Copiamos default.conf a DOMAIN_location para que se incluya dentro del location /
    # Esto es necesario porque autoupdate.js fuerza este esquema.
    cp "vhost.d/default.conf" "vhost.d/${DOMAIN}_location"
    echo "Configuración de vhost copiada a vhost.d/${DOMAIN}_location"
fi

# 6. Iniciar Docker Compose
echo -e "${GREEN}Iniciando contenedores...${NC}"
docker-compose up -d

echo ""
echo -e "${GREEN}=== DESPLIEGUE COMPLETADO ===${NC}"
echo "Espera unos minutos para que se generen los certificados SSL."
echo "Luego puedes ejecutar ./check_remote.sh para verificar el estado."
