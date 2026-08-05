#!/bin/sh
# Generates a self-signed cert on first boot if none exists yet (persisted via the
# tls-certs volume, so it survives container recreation — only deleting the volume
# forces a new one). No cert can validly cover "every IP" (SAN is an explicit list, not
# a wildcard) so this deliberately only covers localhost; every other IP still works
# over HTTPS, browsers just show a self-signed warning to click through.
set -eu

CERT_DIR=/etc/nginx/tls
CERT=$CERT_DIR/cert.pem
KEY=$CERT_DIR/key.pem

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
  echo "tls-proxy: no certificate found, generating a self-signed one..."
  mkdir -p "$CERT_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=model-trainer" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
  chmod 600 "$KEY"
  echo "tls-proxy: certificate generated at $CERT (valid 10 years)"
fi

exec nginx -g 'daemon off;'
