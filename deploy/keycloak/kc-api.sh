# Keycloak's admin REST API from the server (sourced by configure-realm.sh and bootstrap-company.sh; run as root). Talks to Keycloak
# directly on 127.0.0.1:8080 as its super-administrator from /etc/hrms/keycloak.env, with a fresh access token for every call:
# master-realm tokens live 60 seconds, and on a small server a series of calls can outlast one. (Keycloak's own admin CLI starts a
# Java program per call, which is slow there and does not renew its token reliably.)
#   kc_api GET /realms/hrms/clients?clientId=hrms-web          -> JSON on stdout; fails (non-zero) on an HTTP error
#   kc_api PUT /realms/hrms '{"browserFlow":"hrms-browser"}'
KC_URL="${KC_URL:-http://127.0.0.1:8080/kc}"

kc_env() { sed -n "s/^$1=//p" /etc/hrms/keycloak.env | head -1; }

kc_token() {   # the password is read from a file descriptor, never put on curl's command line (ps would show it)
  curl -fsS "$KC_URL/realms/master/protocol/openid-connect/token" \
    --data-urlencode grant_type=password --data-urlencode client_id=admin-cli \
    --data-urlencode "username=$(kc_env KC_BOOTSTRAP_ADMIN_USERNAME)" \
    --data-urlencode "password@"<(printf '%s' "$(kc_env KC_BOOTSTRAP_ADMIN_PASSWORD)") | jq -er .access_token
}

kc_api() {   # METHOD PATH [JSON-BODY]   (the token and the body, which may hold a password, go in on file descriptors)
  local method="$1" path="$2" token
  token="$(kc_token)" || { echo "Keycloak administrator sign-in failed" >&2; return 1; }
  if [ $# -ge 3 ]; then
    printf '%s' "$3" | curl -fsS -X "$method" -H @<(printf 'Authorization: Bearer %s\n' "$token") -H 'Content-Type: application/json' \
      --data-binary @- "$KC_URL/admin$path"
  else
    curl -fsS -X "$method" -H @<(printf 'Authorization: Bearer %s\n' "$token") "$KC_URL/admin$path"
  fi
}
