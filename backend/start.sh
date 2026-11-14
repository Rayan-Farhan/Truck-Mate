#!/bin/sh
set -eu

if [ "$1" = gunicorn ]; then
    python backend/manage.py migrate --noinput
fi

exec "$@"
