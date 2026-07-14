#!/bin/bash
set -euo pipefail

psql "postgresql://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_DB" -c 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp"'

npx postgrator-cli migrate -r pg -h $DB_HOST -o $DB_PORT -d $DB_DB -u $DB_USER -p $DB_PASS -m "./migrations/*"
