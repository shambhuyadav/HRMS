#!/usr/bin/env bash
# Settings of the hrms realm that a realm import cannot express portably across Keycloak versions, applied through Keycloak's admin
# REST API on the server (run as root; called by setup-server.sh; safe to run again):
#   1. every sign-in asks for the second factor: the browser flow is a copy of Keycloak's ("hrms-browser") whose OTP step is REQUIRED
#      for everyone (a user without an authenticator app is made to set one up at the first sign-in);
#   2. the ID token says how the user signed in (amr: "pwd", "otp"), which the HRMS API checks (OIDC_REQUIRE_MFA, OIDC_MFA_AMR=otp);
#   3. no client of the realm hands out tokens for a password alone (direct access grants off);
#   4. the master realm (Keycloak's own administrators) is protected against password guessing as the hrms realm is.
set -euo pipefail
# shellcheck source=kc-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/kc-api.sh"
R=/realms/hrms
FLOW=hrms-browser

echo "-- master realm: brute-force protection"
kc_api PUT /realms/master '{"bruteForceProtected":true,"failureFactor":5,"waitIncrementSeconds":60,"maxFailureWaitSeconds":900}'

echo "-- hrms realm: OTP set-up for new users, and a browser flow that always asks for OTP"
action="$(kc_api GET "$R/authentication/required-actions/CONFIGURE_TOTP")"
kc_api PUT "$R/authentication/required-actions/CONFIGURE_TOTP" "$(jq -c '.enabled = true | .defaultAction = true' <<<"$action")"

if ! kc_api GET "$R/authentication/flows" | jq -e --arg f "$FLOW" 'any(.[]; .alias == $f)' >/dev/null; then
  kc_api POST "$R/authentication/flows/browser/copy" "{\"newName\":\"$FLOW\"}"
fi
EXEC="$(kc_api GET "$R/authentication/flows/$FLOW/executions")"

# The OTP form, its enclosing sub-flow (the nearest flow entry one level up before it) and that sub-flow's other steps.
otp_index="$(jq '[.[] | .providerId] | index("auth-otp-form")' <<<"$EXEC")"
[ "$otp_index" != "null" ] || { echo "No OTP form in the browser flow; check Keycloak's flow layout" >&2; jq -r '.[] | "\(.level) \(.requirement) \(.displayName)"' <<<"$EXEC" >&2; exit 1; }
LAYOUT="$(jq -c --argjson i "$otp_index" '
  . as $all | $all[$i] as $otp |
  ([range(0; $i) | select($all[.].level == ($otp.level - 1) and ($all[.].authenticationFlow // false))] | last) as $p |
  ([range($p + 1; $all | length) | select($all[.].level < $otp.level)] | first // ($all | length)) as $end |
  { parent: $all[$p], otp: $otp,
    siblings: [range($p + 1; $end) | $all[.] | select(.level == $otp.level and .id != $otp.id)] }
' <<<"$EXEC")"
set_req() {   # execution-json requirement
  kc_api PUT "$R/authentication/flows/$FLOW/executions" "$(jq -c --arg r "$2" '.requirement = $r' <<<"$1")"
}
set_req "$(jq -c .parent <<<"$LAYOUT")" REQUIRED
set_req "$(jq -c .otp <<<"$LAYOUT")" REQUIRED
# Conditions are meaningless in a required sub-flow, and other second factors stay off (one factor for everyone: the authenticator app).
jq -c '.siblings[] | select(.requirement != "DISABLED")' <<<"$LAYOUT" | while read -r sibling; do set_req "$sibling" DISABLED; done
kc_api PUT "$R" "{\"browserFlow\":\"$FLOW\"}"

echo "-- hrms realm: amr in the ID token (pwd, otp)"
# Each step's reference counts for maxAge seconds after it was completed (none set: never). 43200 s = the 12-hour session limit.
EXEC="$(kc_api GET "$R/authentication/flows/$FLOW/executions")"
reference() {   # providerId amr-value
  local id cfg
  id="$(jq -r --arg p "$1" '[.[] | select(.providerId == $p)][0].id // empty' <<<"$EXEC")"
  cfg="$(jq -r --arg p "$1" '[.[] | select(.providerId == $p)][0].authenticationConfig // empty' <<<"$EXEC")"
  [ -n "$id" ] || { echo "   (no $1 step)"; return; }
  if [ -z "$cfg" ]; then
    kc_api POST "$R/authentication/executions/$id/config" \
      "{\"alias\":\"hrms-amr-$2\",\"config\":{\"default.reference.value\":\"$2\",\"default.reference.maxAge\":\"43200\"}}"
  else
    kc_api PUT "$R/authentication/config/$cfg" "$(kc_api GET "$R/authentication/config/$cfg" \
      | jq -c --arg v "$2" '.config["default.reference.value"] = $v | .config["default.reference.maxAge"] = "43200"')"
  fi
}
reference auth-username-password-form pwd
reference auth-otp-form otp
CID="$(kc_api GET "$R/clients?clientId=hrms-web" | jq -er '.[0].id')"
if ! kc_api GET "$R/clients/$CID/protocol-mappers/models" | jq -e 'any(.[]; .protocolMapper == "oidc-amr-mapper")' >/dev/null; then
  kc_api POST "$R/clients/$CID/protocol-mappers/models" '{
    "name": "amr", "protocol": "openid-connect", "protocolMapper": "oidc-amr-mapper",
    "config": { "id.token.claim": "true", "access.token.claim": "false", "introspection.token.claim": "true" } }'
fi

echo "-- hrms realm: the HRMS look on its sign-in pages (themes/hrms, built into the Keycloak image)"
kc_api PUT "$R" '{"loginTheme":"hrms"}'

echo "-- hrms realm: the web app's addresses (the realm file is imported only once; the public address may change since)"
ORIGIN="${PUBLIC_ORIGIN:-$(sed -n 's#^OIDC_ISSUER=\(https\?://[^/]*\)/.*#\1#p' /etc/hrms/hrms.env)}"
[ -n "$ORIGIN" ] || { echo "No public address (PUBLIC_ORIGIN, or OIDC_ISSUER in /etc/hrms/hrms.env)" >&2; exit 1; }
CLIENT="$(kc_api GET "$R/clients/$CID")"
kc_api PUT "$R/clients/$CID" "$(jq -c --arg o "$ORIGIN" '.rootUrl = $o | .baseUrl = "/" | .redirectUris = [$o + "/signed-in"]
  | .webOrigins = [$o] | .attributes["post.logout.redirect.uris"] = ($o + "/")' <<<"$CLIENT")"
echo "   hrms-web: $ORIGIN/signed-in"

echo "-- hrms realm: no password-only token grants (every token comes through the browser flow, with the authenticator code)"
kc_api GET "$R/clients" | jq -c '.[] | select(.directAccessGrantsEnabled == true)' | while read -r client; do
  kc_api PUT "$R/clients/$(jq -r .id <<<"$client")" "$(jq -c '.directAccessGrantsEnabled = false' <<<"$client")"
  echo "   direct grants off: $(jq -r .clientId <<<"$client")"
done

echo "-- the browser flow now:"
kc_api GET "$R/authentication/flows/$FLOW/executions" | jq -r '.[] | "   \("  " * .level)\(.requirement) \(.displayName)\(if .authenticationConfig then " [amr]" else "" end)"'
