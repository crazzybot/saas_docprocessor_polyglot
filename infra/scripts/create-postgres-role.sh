#!/usr/bin/env bash
# Creates the PostgreSQL role for the services' managed identity and lets it
# create tables in the schema it migrates. Run once per environment, after
# `terraform apply`, as a member of the server's Entra admin group
# (postgres_admin_group_name), with kubectl pointed at the environment's
# cluster: the server has no public endpoint, so psql runs in a short-lived
# pod inside the VNet.
#
#   infra/scripts/create-postgres-role.sh <server-fqdn> <identity-name> <admin-group-name>
#
# `terraform output postgres_role_command` prints the first two arguments.
# Safe to re-run.
set -euo pipefail

if [ $# -ne 3 ]; then
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 64
fi
server=$1
identity=$2
admin_group=$3

# An Entra access token for Azure Database for PostgreSQL is the password.
token=$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)

sql=$(cat <<SQL
\set ON_ERROR_STOP on
\connect postgres
SELECT CASE
    WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${identity}')
    THEN 'role ${identity} already exists'
    ELSE (SELECT 'created ' || pgaadauth_create_principal('${identity}', false, false))
END AS result;
\connect docprocessor
-- Its migrations (DB_RUN_MIGRATIONS) create the tables in public.
GRANT USAGE, CREATE ON SCHEMA public TO "${identity}";
SQL
)

# The token travels on stdin, not in the pod spec.
printf '%s\n%s\n' "$token" "$sql" | kubectl run "psql-bootstrap-$$" \
    --namespace default --rm -i --quiet --restart=Never \
    --image=postgres:16-alpine \
    --env="PGHOST=${server}" --env="PGUSER=${admin_group}" --env="PGSSLMODE=require" \
    --command -- sh -c 'read -r PGPASSWORD && export PGPASSWORD && psql -X -v ON_ERROR_STOP=1'
